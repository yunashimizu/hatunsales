import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Producto } from '../../models/DBModel/producto.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

@Injectable()
export class ProductoRepository extends CrudRepository<Producto> {

  constructor(
    @InjectRepository(Producto, 'pgConnection')
    private readonly productoRepo: Repository<Producto>,
  ) {
    super(productoRepo);
  }

  override async getAll(): Promise<Producto[]> {
    return this.productoRepo.find({ order: { id_producto: 'ASC' } });
  }

  override async getById(id: number): Promise<Producto | null> {
    return this.productoRepo.findOne({ where: { id_producto: id } });
  }

  async buscarPorCodigoBarras(codigo_barras: string): Promise<Producto | null> {
    return this.productoRepo.findOne({ where: { codigo_barras } });
  }

  async actualizar(id: number, data: Partial<Producto>): Promise<Producto> {
    await this.productoRepo.update(id, data as any);
    return this.getById(id) as Promise<Producto>;
  }
}
