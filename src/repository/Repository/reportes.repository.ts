import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Comprobante } from '../../models/DBModel/c-electronico/comprobante.entity';

type ReportesQueryFilters = {
  id_cliente?: number;
  id_tipo?: number;
  id_moneda?: number;
};

@Injectable()
export class ReportesRepository {
  constructor(
    @InjectRepository(Comprobante, 'pgConnection')
    private readonly comprobanteRepo: Repository<Comprobante>,
  ) {}

  async obtenerVentasPorPeriodo(
    fechaInicio: Date,
    fechaFin: Date,
    filters: ReportesQueryFilters,
  ): Promise<Comprobante[]> {
    const query = this.comprobanteRepo.createQueryBuilder('c')
      .where('c.creado_en BETWEEN :fechaInicio AND :fechaFin', {
        fechaInicio: fechaInicio.toISOString(),
        fechaFin: fechaFin.toISOString(),
      })
      .andWhere('c.anulado = false');

    if (filters.id_cliente) {
      query.andWhere('c.id_cliente = :id_cliente', { id_cliente: filters.id_cliente });
    }
    if (filters.id_tipo) {
      query.andWhere('c.id_tipo = :id_tipo', { id_tipo: filters.id_tipo });
    }
    if (filters.id_moneda) {
      query.andWhere('c.id_moneda = :id_moneda', { id_moneda: filters.id_moneda });
    }

    return query.orderBy('c.creado_en', 'ASC').getMany();
  }
}
