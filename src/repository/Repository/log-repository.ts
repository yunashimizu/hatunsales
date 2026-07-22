import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Log } from '../../models/DBModel/log.entity';

@Injectable()
export class LogRepository {

  constructor(
    @InjectRepository(Log, 'sqliteConnection')
    private readonly logRepo: Repository<Log>,
  ) {}

  async registrar(accion: string, entidad: string): Promise<Log> {
    const log = this.logRepo.create({ accion, entidad });
    return this.logRepo.save(log);
  }

  async getAll(): Promise<Log[]> {
    return this.logRepo.find({ order: { fecha: 'DESC' } });
  }
}