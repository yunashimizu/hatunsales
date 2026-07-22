import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MovimientoInventario } from '../../models/DBModel/movimiento-inventario.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

@Injectable()
export class MovimientoInventarioRepository extends CrudRepository<MovimientoInventario> {
  constructor(
    @InjectRepository(MovimientoInventario, 'pgConnection')
    private readonly movimientoRepo: Repository<MovimientoInventario>,
  ) {
    super(movimientoRepo);
  }
}
