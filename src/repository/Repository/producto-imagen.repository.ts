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

  async contarPorProducto(id_producto: number): Promise<number> {
    return this.imagenRepo.count({ where: { producto: { id_producto } } });
  }

  async siguienteOrden(id_producto: number): Promise<number> {
    const fila = await this.imagenRepo
      .createQueryBuilder('i')
      .select('COALESCE(MAX(i.orden), -1)', 'ultimo')
      .where('i.id_producto = :id_producto', { id_producto })
      .getRawOne();
    return Number(fila?.ultimo ?? -1) + 1;
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
