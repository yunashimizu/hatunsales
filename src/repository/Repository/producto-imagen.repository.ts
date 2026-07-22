import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

  async findByProducto(id_producto: number): Promise<ProductoImagen[]> {
    return this.imagenRepo.find({ where: { producto: { id_producto } } });
  }

  async findOneById(id_imagen: number): Promise<ProductoImagen | null> {
    return this.imagenRepo.findOne({ where: { id_imagen } });
  }
}
