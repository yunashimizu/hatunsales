import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ProductoImagenRepository } from '../../repository/Repository/producto-imagen.repository';
import { ProductoRepository } from '../../repository/Repository/producto.repository';
import { ALMACEN_ARCHIVOS } from '../../util/storage/almacen.interface';
import type { AlmacenArchivos, ArchivoGuardado } from '../../util/storage/almacen.interface';
import { almacenamientoConfig } from '../../config/almacenamiento.config';
import { ProductoImagen } from '../../models/DBModel/producto-imagen.entity';
import { enParalelo } from '../../util/concurrencia.util';

export interface ArchivoSubido {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

/** Cuántas fotos de un mismo lote se mandan al almacén a la vez. */
const SUBIDAS_SIMULTANEAS = 3;

@Injectable()
export class ProductoImagenBussnies {

  private readonly logger = new Logger(ProductoImagenBussnies.name);

  constructor(
    private readonly repo: ProductoImagenRepository,
    private readonly productoRepo: ProductoRepository,
    @Inject(ALMACEN_ARCHIVOS) private readonly almacen: AlmacenArchivos,
  ) {}

  listByProduct(id_producto: number) {
    return this.repo.findByProducto(id_producto);
  }

  /** Sube varias imágenes de una vez y las deja en el orden en que llegaron. */
  async subirVarias(id_producto: number, archivos: ArchivoSubido[]): Promise<ProductoImagen[]> {
    if (!archivos?.length) throw new BadRequestException('No se recibió ninguna imagen');

    const producto = await this.productoRepo.getById(id_producto);
    if (!producto) throw new NotFoundException('Producto no encontrado');

    archivos.forEach((archivo) => this.validar(archivo));

    // Un solo viaje para saber cuántas fotos hay y qué orden toca (antes eran dos).
    const { total: yaTiene, siguienteOrden } = await this.repo.resumenGaleria(id_producto);

    // Archivos ya enviados al almacén en este lote, con o sin fila creada todavía. Cada
    // clave se anota apenas el almacén la devuelve, para poder borrarla si algo falla después.
    const clavesSubidas: string[] = [];

    let subidas: ArchivoGuardado[];
    try {
      // De a SUBIDAS_SIMULTANEAS: Cloudinary tarda 0,5–2 s por foto y en fila se sumaban.
      subidas = await enParalelo(archivos, SUBIDAS_SIMULTANEAS, async (archivo) => {
        const subida = await this.almacen.guardar({
          buffer: archivo.buffer,
          nombre_original: archivo.originalname,
          mime: archivo.mimetype,
          carpeta: String(id_producto),
        });
        clavesSubidas.push(subida.clave);
        return subida;
      });
    } catch (error) {
      // Todo o nada: `enParalelo` ya esperó a las subidas en vuelo, así que `clavesSubidas`
      // tiene todo lo que llegó al almacén. Sin esto quedarían archivos huérfanos y el
      // reintento del usuario los duplicaría. Aún no hay filas.
      await this.deshacerLote([], clavesSubidas);
      throw error;
    }

    // Las filas se arman en el orden recibido, sin importar qué subida terminó antes.
    const imagenes = subidas.map((subida, indice) => {
      const imagen = new ProductoImagen();
      imagen.producto = producto as any;
      imagen.url = subida.url;
      imagen.thumb_url = subida.thumb_url;
      imagen.mime = subida.mime;
      imagen.size = subida.size;
      imagen.width = subida.width as number;
      imagen.height = subida.height as number;
      imagen.clave_almacen = subida.clave;
      imagen.proveedor = subida.proveedor;
      imagen.orden = siguienteOrden + indice;
      // La primera imagen que tenga el producto queda como principal (el índice único
      // parcial solo admite una principal por producto).
      imagen.is_primary = yaTiene === 0 && indice === 0;
      return imagen;
    });

    try {
      // Una sola transacción para todas las filas: o entran todas o ninguna.
      return await this.repo.crearVarias(imagenes);
    } catch (error) {
      await this.deshacerLote([], clavesSubidas);
      throw error;
    }
  }

  /**
   * Cambia el archivo de una foto sin mover su lugar: conserva `orden` e `is_primary`.
   * El archivo nuevo se guarda primero; si algo falla antes de actualizar la fila, la foto
   * vieja queda intacta. El archivo viejo se borra del almacén al final.
   */
  async reemplazar(id_producto: number, id_imagen: number, archivo: ArchivoSubido): Promise<ProductoImagen[]> {
    const imagen = await this.repo.findOneById(id_imagen);
    if (!imagen || imagen.producto?.id_producto !== id_producto) {
      throw new NotFoundException('Imagen no encontrada');
    }
    if (!archivo?.buffer?.length) throw new BadRequestException('No se seleccionó ninguna imagen');
    this.validar(archivo);

    const claveVieja = imagen.clave_almacen;

    const subida = await this.almacen.guardar({
      buffer: archivo.buffer,
      nombre_original: archivo.originalname,
      mime: archivo.mimetype,
      carpeta: String(id_producto),
    });

    try {
      await this.repo.actualizarArchivo(id_imagen, {
        url: subida.url,
        thumb_url: subida.thumb_url,
        mime: subida.mime,
        size: subida.size,
        width: subida.width as number,
        height: subida.height as number,
        clave_almacen: subida.clave,
        proveedor: subida.proveedor,
      });
    } catch (error) {
      // La fila sigue apuntando al archivo viejo: se descarta el nuevo.
      await this.borrarDelAlmacen(subida.clave);
      throw error;
    }

    // Si la foto es idéntica, el almacén reutiliza el mismo archivo: no hay nada que borrar.
    // Sin `await`: la fila ya apunta al archivo nuevo y el usuario no tiene por qué esperar
    // el `destroy` del almacén. `borrarDelAlmacen` captura y registra sus propios errores.
    if (claveVieja && claveVieja !== subida.clave) {
      void this.borrarDelAlmacen(claveVieja);
    }

    return this.repo.findByProducto(id_producto);
  }

  /** Quita las filas ya creadas del lote y los archivos que subió; nunca oculta el error original. */
  private async deshacerLote(guardadas: ProductoImagen[], claves: string[]): Promise<void> {
    for (const imagen of guardadas) {
      try {
        await this.repo.eliminar(imagen.id_imagen);
      } catch (error: any) {
        this.logger.warn(`No se pudo deshacer la imagen ${imagen.id_imagen} del lote: ${error?.message ?? error}`);
      }
    }
    // Primero las filas y después los archivos: el almacén solo borra lo que nadie referencia.
    for (const clave of claves) await this.borrarDelAlmacen(clave);
  }

  private async borrarDelAlmacen(clave: string): Promise<void> {
    try {
      await this.almacen.eliminar(clave);
    } catch (error: any) {
      this.logger.warn(`No se pudo borrar el archivo ${clave} del almacén: ${error?.message ?? error}`);
    }
  }

  /** Compatibilidad con la subida de una sola imagen. */
  async uploadBuffer(id_producto: number, filename: string, buffer: Buffer, mime: string) {
    const [imagen] = await this.subirVarias(id_producto, [
      { originalname: filename, mimetype: mime, buffer, size: buffer.length },
    ]);
    return imagen;
  }

  async setPrimary(id_producto: number, id_imagen: number) {
    const imagen = await this.repo.findOneById(id_imagen);
    if (!imagen || imagen.producto?.id_producto !== id_producto) {
      throw new NotFoundException('Imagen no encontrada');
    }

    await this.repo.marcarPrincipal(id_producto, id_imagen);
    return this.repo.findByProducto(id_producto);
  }

  async reordenar(id_producto: number, ids: number[]) {
    if (!Array.isArray(ids) || !ids.length) {
      throw new BadRequestException('Envíe el nuevo orden de las imágenes');
    }

    await this.repo.reordenar(id_producto, ids.map(Number));
    return this.repo.findByProducto(id_producto);
  }

  async remove(id_producto: number, id_imagen: number) {
    const imagen = await this.repo.findOneById(id_imagen);
    if (!imagen || imagen.producto?.id_producto !== id_producto) {
      throw new NotFoundException('Imagen no encontrada');
    }

    await this.repo.eliminar(id_imagen);
    await this.repo.asegurarPrincipal(id_producto);

    // Después de quitar la fila: el archivo puede estar compartido (misma foto en otro
    // producto o en una recepción) y el almacén solo lo borra si ya nadie lo usa.
    // Sin `await`: el orden fila → archivo se mantiene (la fila ya se quitó), pero la
    // respuesta no espera al almacén; un fallo se registra y ya no rompe la respuesta.
    if (imagen.clave_almacen) {
      void this.borrarDelAlmacen(imagen.clave_almacen);
    }

    return this.repo.findByProducto(id_producto);
  }

  private validar(archivo: ArchivoSubido): void {
    if (!almacenamientoConfig.tiposPermitidos.includes(archivo.mimetype)) {
      throw new BadRequestException(
        `"${archivo.originalname}" no es una imagen válida. Use JPG, PNG, WebP o AVIF.`,
      );
    }

    if (archivo.buffer.length > almacenamientoConfig.tamanioMaximoBytes) {
      const maximoMb = Math.round(almacenamientoConfig.tamanioMaximoBytes / 1024 / 1024);
      throw new BadRequestException(`"${archivo.originalname}" supera los ${maximoMb} MB permitidos`);
    }
  }
}
