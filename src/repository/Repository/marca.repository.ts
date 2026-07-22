import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Marca } from '../../models/DBModel/marca.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

@Injectable()
export class MarcaRepository extends CrudRepository<Marca> {
  constructor(
    @InjectRepository(Marca, 'pgConnection')
    private readonly marcaRepo: Repository<Marca>,
  ) {
    super(marcaRepo);
  }
}
