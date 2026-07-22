import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Inventario } from '../../models/DBModel/inventario.entity';
import { Producto } from '../../models/DBModel/producto.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

@Injectable()
export class InventarioRepository extends CrudRepository<Inventario> {

  constructor(
    @InjectRepository(Inventario, 'pgConnection')
    private readonly inventarioRepo: Repository<Inventario>,
  ) {
    super(inventarioRepo);
  }

  async buscarPorProducto(id_producto: number): Promise<Inventario | null> {
    return this.inventarioRepo.findOne({ where: { producto: { id_producto } as any }, relations: ['producto'] });
  }

  async guardarOActualizar(inventario: Partial<Inventario>): Promise<Inventario> {
    const productoId = inventario.producto?.id_producto;
    const existe = productoId ? await this.buscarPorProducto(productoId) : null;

    if (existe && productoId !== undefined) {
      await this.inventarioRepo.update(existe.id_inventario, inventario as any);
      return this.buscarPorProducto(productoId) as Promise<Inventario>;
    }

    const nuevo = this.inventarioRepo.create(inventario);
    return this.inventarioRepo.save(nuevo);
  }

  async listarTodos(): Promise<Inventario[]> {
    return this.inventarioRepo.find({ relations: ['producto'], order: { id_inventario: 'ASC' } });
  }
}
