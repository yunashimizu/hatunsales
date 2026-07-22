import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GuiaRemision } from '../../models/DBModel/guia-remision.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

@Injectable()
export class GuiaRemisionRepository extends CrudRepository<GuiaRemision> {

  constructor(
    @InjectRepository(GuiaRemision, 'pgConnection')
    private readonly guiaRepo: Repository<GuiaRemision>,
  ) {
    super(guiaRepo);
  }

  async getAll(): Promise<GuiaRemision[]> {
    return this.guiaRepo.find({ relations: ['cliente', 'empresa', 'items', 'items.producto'], order: { id_guia: 'DESC' } });
  }

  async guardarConItems(data: Partial<GuiaRemision>): Promise<GuiaRemision> {
    const nueva = this.guiaRepo.create(data);
    return this.guiaRepo.save(nueva);
  }
}
