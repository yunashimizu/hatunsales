import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Proforma } from '../../models/DBModel/proforma.entity';
import { CrudRepository } from '../Irepository/GenericIRepository/crud.Irepository';

@Injectable()
export class ProformaRepository extends CrudRepository<Proforma> {

  constructor(
    @InjectRepository(Proforma, 'pgConnection')
    private readonly proformaRepo: Repository<Proforma>,
  ) {
    super(proformaRepo);
  }

  async getAll(): Promise<Proforma[]> {
    return this.proformaRepo.find({ relations: ['cliente', 'empresa', 'items', 'items.producto'], order: { id_proforma: 'DESC' } });
  }

  async guardarConItems(data: Partial<Proforma>): Promise<Proforma> {
    const nueva = this.proformaRepo.create(data);
    return this.proformaRepo.save(nueva);
  }
}
