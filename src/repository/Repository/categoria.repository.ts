import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Categoria } from '../../models/DBModel/categoria.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

@Injectable()
export class CategoriaRepository extends CrudRepository<Categoria> {
  constructor(
    @InjectRepository(Categoria, 'pgConnection')
    private readonly categoriaRepo: Repository<Categoria>,
  ) {
    super(categoriaRepo);
  }
}
