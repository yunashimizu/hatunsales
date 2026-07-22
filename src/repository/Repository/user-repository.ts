import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Usuario } from '../../models/DBModel/user.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

@Injectable()
export class HatunsalesRepository extends CrudRepository<Usuario> {

  constructor(
    @InjectRepository(Usuario, 'pgConnection')
    private readonly userRepo: Repository<Usuario>,
  ) {
    super(userRepo);
  }
}