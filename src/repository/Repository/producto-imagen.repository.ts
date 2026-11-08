import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ProductoImagen } from '../../models/DBModel/producto-imagen.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

@Injectable()
export class ProductoImagenRepository extends CrudRepository<ProductoImagen> {

  constructor(
    @InjectRepository(ProductoImagen, 'pgConnection')
    private readonly imagenRepo: Repository<ProductoImagen>,
  ) {
    super(imagenRepo);
  }

  /** La principal siempre primero, el resto según el orden que fijó el usuario. */
  findByProducto(id_producto: number): Promise<ProductoImagen[]> {
    return this.imagenRepo.find({
      where: { producto: { id_producto } },
      order: { is_primary: 'DESC', orden: 'ASC', id_imagen: 'ASC' },
    });
  }

  findOneById(id_imagen: number): Promise<ProductoImagen | null> {
    return this.imagenRepo.findOne({
      where: { id_imagen },
      relations: ['producto'],
    });
  }

  /**
   * Cuántas fotos tiene el producto y qué `orden` toca a la siguiente, en UN solo viaje
   * (antes eran dos consultas seguidas: un conteo y un MAX).
   */
  async resumenGaleria(id_producto: number): Promise<{ total: number; siguienteOrden: number }> {
    const filas: Array<{ total: number | string; siguiente: number | string }> = await this.imagenRepo.query(
      `SELECT COUNT(*)::int AS total, COALESCE(MAX(orden), -1) + 1 AS siguiente
         FROM productos_imagenes
        WHERE id_producto = $1`,
      [id_producto],
    );
    return {
      total: Number(filas?.[0]?.total ?? 0),
      siguienteOrden: Number(filas?.[0]?.siguiente ?? 0),
    };
  }

  /**
   * Guarda varias fotos con una sola llamada: TypeORM las inserta en una transacción y con
   * un INSERT de varias filas, en lugar de BEGIN/INSERT/COMMIT por cada foto. Devuelve las
   * entidades con su `id_imagen`, en el mismo orden recibido.
   */
  crearVarias(imagenes: ProductoImagen[]): Promise<ProductoImagen[]> {
    return this.imagenRepo.save(imagenes);
  }

  async marcarPrincipal(id_producto: number, id_imagen: number): Promise<void> {
    await this.imagenRepo
      .createQueryBuilder()
      .update(ProductoImagen)
      .set({ is_primary: false })
      .where('id_producto = :id_producto', { id_producto })
      .execute();

    await this.imagenRepo.update(id_imagen, { is_primary: true, orden: 0 });
  }

  /** Aplica el orden que dejó el usuario al arrastrar las miniaturas. */
  async reordenar(id_producto: number, ids: number[]): Promise<void> {
    const imagenes = await this.imagenRepo.find({
      where: { id_imagen: In(ids), producto: { id_producto } },
    });

    const validos = new Set(imagenes.map((i) => i.id_imagen));

    await Promise.all(
      ids
        .filter((id) => validos.has(id))
        .map((id, posicion) => this.imagenRepo.update(id, { orden: posicion })),
    );
  }

  /**
   * Cambia solo el archivo de una foto (url, miniatura, tipo, peso, medidas y clave del
   * almacén). `orden` e `is_primary` no se tocan: la foto conserva su lugar en la galería.
   */
  async actualizarArchivo(
    id_imagen: number,
    datos: Pick<ProductoImagen, 'url' | 'thumb_url' | 'mime' | 'size' | 'width' | 'height' | 'clave_almacen' | 'proveedor'>,
  ): Promise<void> {
    await this.imagenRepo.update(id_imagen, {
      url: datos.url,
      thumb_url: datos.thumb_url,
      mime: datos.mime,
      size: datos.size,
      width: datos.width,
      height: datos.height,
      clave_almacen: datos.clave_almacen,
      proveedor: datos.proveedor,
    });
  }

  async eliminar(id_imagen: number): Promise<void> {
    await this.imagenRepo.delete(id_imagen);
  }

  /** Deja como principal a la primera que quede, si se borró la que lo era. */
  async asegurarPrincipal(id_producto: number): Promise<void> {
    const existentes = await this.findByProducto(id_producto);
    if (!existentes.length || existentes.some((i) => i.is_primary)) return;

    await this.imagenRepo.update(existentes[0].id_imagen, { is_primary: true });
  }
}
