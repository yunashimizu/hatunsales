import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StockSucursal } from '../../models/DBModel/stock-sucursal.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

@Injectable()
export class StockSucursalRepository extends CrudRepository<StockSucursal> {
  constructor(
    @InjectRepository(StockSucursal, 'pgConnection')
    private readonly stockRepo: Repository<StockSucursal>,
  ) {
    super(stockRepo);
  }

  async buscarPorProductoYSucursal(id_producto: number, id_sucursal: number): Promise<StockSucursal | null> {
    return this.stockRepo.findOne({
      where: { producto: { id_producto } as any, sucursal: { id_sucursal } as any },
      relations: ['producto', 'sucursal'],
    });
  }

  async listarPorFiltro(id_producto?: number, id_sucursal?: number): Promise<StockSucursal[]> {
    const where: any = {};
    if (id_producto) where.producto = { id_producto } as any;
    if (id_sucursal) where.sucursal = { id_sucursal } as any;

    return this.stockRepo.find({
      where,
      relations: ['producto', 'sucursal'],
      order: { actualizado_en: 'DESC' },
    });
  }
}
