import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Comprobante } from '../../models/DBModel/c-electronico/comprobante.entity';
import { aTimestampUtc } from '../../util/fecha-lima';

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

  /**
   * Comprobantes creados en [desde, hasta) con su tipo. `desde`/`hasta` son los instantes
   * UTC de los días de Lima del periodo (creado_en es timestamp sin zona en UTC), así el
   * día no se corta a las 19:00 de Lima.
   *
   * Trae también anulados, rechazados, con error y de prueba: qué cuenta como venta lo
   * decide ReportesBussnies (clasificarComprobanteReporte) y los excluidos se informan
   * aparte en las estadísticas.
   */
  async obtenerVentasPorPeriodo(
    desde: Date,
    hasta: Date,
    filters: ReportesQueryFilters,
  ): Promise<Comprobante[]> {
    const query = this.comprobanteRepo.createQueryBuilder('c')
      .leftJoinAndSelect('c.tipo', 'tipo')
      .where('c.creado_en >= :desde AND c.creado_en < :hasta', {
        desde: aTimestampUtc(desde),
        hasta: aTimestampUtc(hasta),
      });

    if (filters.id_cliente) {
      query.andWhere('c.id_cliente = :id_cliente', { id_cliente: filters.id_cliente });
    }
    if (filters.id_tipo) {
      query.andWhere('c.id_tipo = :id_tipo', { id_tipo: filters.id_tipo });
    }
    if (filters.id_moneda) {
      query.andWhere('c.id_moneda = :id_moneda', { id_moneda: filters.id_moneda });
    }

    return query.orderBy('c.creado_en', 'ASC').addOrderBy('c.id_comprobante', 'ASC').getMany();
  }
}
