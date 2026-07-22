import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Sucursal } from '../../models/DBModel/sucursal.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

@Injectable()
export class SucursalRepository extends CrudRepository<Sucursal> {
  constructor(
    @InjectRepository(Sucursal, 'pgConnection')
    private readonly sucursalRepo: Repository<Sucursal>,
  ) {
    super(sucursalRepo);
  }

  override async getAll(): Promise<Sucursal[]> {
    return this.sucursalRepo.find({ order: { id_sucursal: 'ASC' } });
  }

  override async getById(id: number): Promise<Sucursal | null> {
    return this.sucursalRepo.findOne({ where: { id_sucursal: id } });
  }
}
