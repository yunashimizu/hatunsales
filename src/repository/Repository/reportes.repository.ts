import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Comprobante } from '../../models/DBModel/c-electronico/comprobante.entity';
import { aTimestampUtc } from '../../util/fecha-lima';
import { TIPO_NOTA_CREDITO } from '../../util/fiscal/tipos-comprobante';

type ReportesQueryFilters = {
  id_cliente?: number;
  id_tipo?: number;
  id_moneda?: number;
};

/** Producto agregado de un conjunto de comprobantes (numéricos tal como los devuelve Postgres: texto). */
export interface FilaProductoVendido {
  id_producto: number | null;
  codigo: string | null;
  descripcion: string | null;
  cantidad: string | number | null;
  total: string | number | null;
  comprobantes: string | number | null;
}

/** Producto agregado de las cotizaciones (proformas) de un periodo. */
export interface FilaProductoCotizado {
  id_producto: number | null;
  sku: string | null;
  descripcion: string | null;
  cotizaciones: string | number | null;
  cantidad: string | number | null;
  total: string | number | null;
  convertidas: string | number | null;
}

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

  /**
   * Lo vendido por producto en los comprobantes indicados (ya clasificados como venta por
   * ReportesBussnies). Una nota de crédito resta: devuelve producto, así que su cantidad y
   * su importe entran en negativo y el ranking es NETO, igual que el total del reporte.
   * El producto es su id; si un ítem antiguo no lo trae, se agrupa por código y, si tampoco,
   * por descripción. Ordenado por importe y limitado a `limite` filas. Con `invertirSigno`
   * (reporte solo de notas de crédito) los números salen positivos: son lo devuelto. Solo lectura.
   */
  async obtenerProductosVendidos(
    idsComprobante: number[],
    limite: number,
    invertirSigno = false,
  ): Promise<FilaProductoVendido[]> {
    if (!idsComprobante.length) return [];
    return this.comprobanteRepo.manager.query(
      `SELECT MAX(ci.id_producto) AS id_producto,
              MAX(ci.codigo) AS codigo,
              MAX(ci.descripcion) AS descripcion,
              SUM((CASE WHEN c.id_tipo = $3 THEN -1 ELSE 1 END) * $4::int * COALESCE(ci.cantidad, 0)) AS cantidad,
              SUM((CASE WHEN c.id_tipo = $3 THEN -1 ELSE 1 END) * $4::int * COALESCE(ci.total, 0)) AS total,
              COUNT(DISTINCT ci.id_comprobante) AS comprobantes
         FROM comprobante_items ci
         JOIN comprobantes c ON c.id_comprobante = ci.id_comprobante
        WHERE ci.id_comprobante = ANY($1::int[])
        GROUP BY COALESCE(ci.id_producto::text, NULLIF(ci.codigo, ''), ci.descripcion)
        ORDER BY total DESC, cantidad DESC
        LIMIT $2`,
      [idsComprobante, limite, TIPO_NOTA_CREDITO, invertirSigno ? -1 : 1],
    );
  }

  /**
   * Productos más cotizados: cuántas cotizaciones (proformas) creadas en [desde, hasta) los
   * incluyen, con la cantidad y el importe cotizados y cuántas de esas cotizaciones llegaron
   * a ser una venta. No cuentan las anuladas. `creado_en` es timestamp sin zona en UTC, igual
   * que en los comprobantes. Solo lectura.
   */
  async obtenerProductosCotizados(
    desde: Date,
    hasta: Date,
    limite: number,
    idCliente?: number,
  ): Promise<FilaProductoCotizado[]> {
    return this.comprobanteRepo.manager.query(
      `SELECT MAX(pi.id_producto) AS id_producto,
              MAX(COALESCE(NULLIF(pi.sku_snapshot, ''), NULLIF(pr.sku, ''), NULLIF(pr.codigo_barras, ''))) AS sku,
              MAX(COALESCE(NULLIF(pi.descripcion_snapshot, ''), pr.nombre)) AS descripcion,
              COUNT(DISTINCT p.id_proforma) AS cotizaciones,
              SUM(COALESCE(pi.cantidad, 0)) AS cantidad,
              SUM(COALESCE(pi.subtotal, 0)) AS total,
              COUNT(DISTINCT p.id_proforma) FILTER (WHERE LOWER(p.estado) = 'convertida') AS convertidas
         FROM proformas_items pi
         JOIN proformas p ON p.id_proforma = pi.id_proforma
         LEFT JOIN productos pr ON pr.id_producto = pi.id_producto
        WHERE p.creado_en >= $1 AND p.creado_en < $2
          AND LOWER(COALESCE(p.estado, '')) <> 'anulada'
          AND ($4::int IS NULL OR p.id_cliente = $4::int)
        GROUP BY COALESCE(pi.id_producto::text, NULLIF(pi.sku_snapshot, ''), pi.descripcion_snapshot)
        ORDER BY cotizaciones DESC, cantidad DESC, total DESC
        LIMIT $3`,
      [aTimestampUtc(desde), aTimestampUtc(hasta), limite, idCliente ?? null],
    );
  }
}
