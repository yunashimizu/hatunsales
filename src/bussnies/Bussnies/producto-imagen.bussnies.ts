import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ProductoImagenRepository } from '../../repository/Repository/producto-imagen.repository';
import { ProductoRepository } from '../../repository/Repository/producto.repository';
import { ALMACEN_ARCHIVOS } from '../../util/storage/almacen.interface';
import type { AlmacenArchivos } from '../../util/storage/almacen.interface';
import { almacenamientoConfig } from '../../config/almacenamiento.config';
import { ProductoImagen } from '../../models/DBModel/producto-imagen.entity';

export interface ArchivoSubido {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

@Injectable()
export class ProductoImagenBussnies {

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

    const yaTiene = await this.repo.contarPorProducto(id_producto);
    let orden = await this.repo.siguienteOrden(id_producto);

    const guardadas: ProductoImagen[] = [];

    for (const [indice, archivo] of archivos.entries()) {
      const subida = await this.almacen.guardar({
        buffer: archivo.buffer,
        nombre_original: archivo.originalname,
        mime: archivo.mimetype,
        carpeta: String(id_producto),
      });

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
      imagen.orden = orden++;
      // La primera imagen que tenga el producto queda como principal.
      imagen.is_primary = yaTiene === 0 && indice === 0;

      guardadas.push(await this.repo.create(imagen));
    }

    return guardadas;
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

    if (imagen.clave_almacen) {
      await this.almacen.eliminar(imagen.clave_almacen);
    }

    await this.repo.eliminar(id_imagen);
    await this.repo.asegurarPrincipal(id_producto);

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
