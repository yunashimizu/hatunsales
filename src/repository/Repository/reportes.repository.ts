import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Comprobante } from '../../models/DBModel/c-electronico/comprobante.entity';
import { aTimestampUtc } from '../../util/fecha-lima';
import { TIPO_BOLETA, TIPO_FACTURA, TIPO_NOTA_CREDITO, TIPO_NOTA_DEBITO } from '../../util/fiscal/tipos-comprobante';

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

/** Producto vendido con su costo (Fase F1). Numéricos tal como los devuelve Postgres. */
export interface FilaRentabilidadProducto {
  id_producto: number | null;
  codigo: string | null;
  producto: string | null;
  categoria: string | null;
  cantidad: string | number | null;
  /** Importe con IGV (lo que se cobró por el producto). */
  ingreso: string | number | null;
  /** Importe sin IGV: el importe del ítem × (total − IGV) / total de su comprobante. */
  ingreso_sin_igv: string | number | null;
  costo: string | number | null;
  ultima_venta: Date | string | null;
  sin_costo: boolean | null;
}

/** Producto activo con existencias y sin ventas recientes (Fase F1). */
export interface FilaProductoEstancado {
  id_producto: number;
  codigo: string | null;
  producto: string | null;
  categoria: string | null;
  stock: string | number | null;
  precio_compra: string | number | null;
  ultima_venta: Date | string | null;
  total_filas: string | number | null;
}

/** Comprobante que pide atención (pendiente, con error, rechazado o con excepción): para el resumen diario. */
export interface FilaComprobanteProblema {
  id_comprobante: number;
  id_tipo: number | string | null;
  serie: string | null;
  numero: number | string | null;
  estado: string | null;
  estado_sunat: string | null;
  total: number | string | null;
  creado_en: Date | string | null;
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

/** Comprobante tal como lo necesita el Registro de Ventas (SIRE). Los numéricos llegan como los entrega Postgres. */
export interface FilaComprobanteRvie {
  id_comprobante: number;
  id_tipo: number;
  serie: string | null;
  numero: number | string | null;
  fecha_de_emision: string | null;
  fecha_de_vencimiento: string | null;
  creado_en: Date | string | null;
  cliente_tipo_doc: number | string | null;
  cliente_numero_doc: string | null;
  cliente_denominacion: string | null;
  total_gravada: number | string | null;
  total_exonerada: number | string | null;
  total_inafecta: number | string | null;
  total_igv: number | string | null;
  total: number | string | null;
  id_moneda: number | string | null;
  anulado: boolean | null;
  estado: string | null;
  estado_sunat: string | null;
  aceptada_sunat: boolean | null;
  ambiente_fiscal: string | null;
  doc_modificado_tipo: string | null;
  doc_modificado_serie: string | null;
  doc_modificado_numero: number | string | null;
  fecha_doc_modificado: string | null;
}

/**
 * Espejo en SQL de clasificarComprobanteReporte (reportes.bussnies.ts) para `comprobantes c`: cuenta como venta lo que
 * no está anulado, no es de prueba BETA, no quedó en error, no fue rechazado por SUNAT y no es una nota de crédito.
 */
export const SQL_COMPROBANTE_CUENTA = `COALESCE(c.anulado, FALSE) = FALSE
                   AND LOWER(COALESCE(c.estado, '')) NOT IN ('anulado', 'error')
                   AND UPPER(COALESCE(c.estado_sunat, '')) NOT IN ('ANULADO', 'RECHAZADO')
                   AND LOWER(COALESCE(c.ambiente_fiscal, '')) <> 'beta'
                   AND c.id_tipo <> ${TIPO_NOTA_CREDITO}`;

/**
 * Columnas de `comprobantes c` que carga obtenerVentasPorPeriodo (más tipo.id_tipo y tipo.nombre). `id_venta` y
 * `cliente_tipo_doc` no se leen hoy en ReportesBussnies; se dejan por ser enteros baratos y de uso probable.
 */
export const COLUMNAS_VENTAS_POR_PERIODO = [
  'c.id_comprobante',
  'c.id_venta',
  'c.serie',
  'c.numero',
  'c.total',
  'c.estado',
  'c.estado_sunat',
  'c.anulado',
  'c.ambiente_fiscal',
  'c.creado_en',
  'c.fecha_de_emision',
  'c.cliente_denominacion',
  'c.cliente_numero_doc',
  'c.cliente_tipo_doc',
];

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
    // Solo las columnas que leen ReportesBussnies (reporteVentas, horasDelDia, rentabilidadProductos,
    // ventasMapaCalor y clasificarComprobanteReporte / idTipoDe / diaLimaComprobante): las de texto
    // largo de SUNAT (importe_en_letras, sunat_soap_error, sunat_observaciones…) no viajan.
    // Devuelve entidades parciales; si un consumidor lee otra propiedad, añadirla aquí.
    const query = this.comprobanteRepo.createQueryBuilder('c')
      .leftJoin('c.tipo', 'tipo')
      .select(COLUMNAS_VENTAS_POR_PERIODO)
      .addSelect(['tipo.id_tipo', 'tipo.nombre'])
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
   * Facturas, boletas y notas cuya FECHA DE EMISIÓN cae en el mes `periodo` (AAAAMM): los de la emisión directa la guardan
   * como AAAA-MM-DD y los históricos de Nubefact pudieron guardarla como DD-MM-AAAA. Trae también anulados, rechazados,
   * con error y de prueba: qué entra en el registro lo decide ReportesBussnies. Solo lectura.
   */
  async obtenerComprobantesRvie(periodo: string): Promise<FilaComprobanteRvie[]> {
    const anio = periodo.slice(0, 4);
    const mes = periodo.slice(4, 6);
    return this.comprobanteRepo.manager.query(
      `SELECT c.id_comprobante, c.id_tipo, c.serie, c.numero, c.fecha_de_emision, c.fecha_de_vencimiento, c.creado_en,
              c.cliente_tipo_doc, c.cliente_numero_doc, c.cliente_denominacion,
              c.total_gravada, c.total_exonerada, c.total_inafecta, c.total_igv, c.total, c.id_moneda,
              c.anulado, c.estado, c.estado_sunat, c.aceptada_sunat, c.ambiente_fiscal,
              c.doc_modificado_tipo, c.doc_modificado_serie, c.doc_modificado_numero,
              m.fecha_de_emision AS fecha_doc_modificado
         FROM comprobantes c
         LEFT JOIN comprobantes m ON m.id_comprobante = c.id_comprobante_modificado
        WHERE (c.fecha_de_emision LIKE $1 OR c.fecha_de_emision LIKE $2)
          AND c.id_tipo = ANY($3::int[])
        ORDER BY c.serie, c.numero, c.id_comprobante`,
      [`${anio}-${mes}-%`, `__-${mes}-${anio}%`, [TIPO_FACTURA, TIPO_BOLETA, TIPO_NOTA_CREDITO, TIPO_NOTA_DEBITO]],
    );
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
  /**
   * Rentabilidad por producto de los comprobantes indicados (ya clasificados como venta por ReportesBussnies).
   * Una nota de crédito resta cantidad, ingreso y costo. El costo es cantidad × `productos.precio_compra` VIGENTE
   * (ni el kardex ni el detalle de la venta guardan el costo de aquel momento, ver venta.repository.ts); si el
   * producto no tiene precio de compra queda en 0 y `sin_costo` avisa. `ingreso_sin_igv` reparte el IGV del comprobante en proporción (sirve con gravadas, exoneradas e inafectas mezcladas) y es la base del margen. `ultima_venta` es el último comprobante
   * de venta (no nota de crédito) del conjunto. Ordenado por ingreso. Solo lectura.
   */
  async obtenerRentabilidadProductos(idsComprobante: number[], limite: number): Promise<FilaRentabilidadProducto[]> {
    if (!idsComprobante.length) return [];
    return this.comprobanteRepo.manager.query(
      `SELECT MAX(ci.id_producto) AS id_producto,
              COALESCE(MAX(NULLIF(pr.sku, '')), MAX(NULLIF(pr.codigo_barras, '')), MAX(NULLIF(ci.codigo, '')), '') AS codigo,
              COALESCE(MAX(pr.nombre), MAX(ci.descripcion)) AS producto,
              COALESCE(MAX(cat.nombre), 'Sin categoría') AS categoria,
              SUM((CASE WHEN c.id_tipo = $2 THEN -1 ELSE 1 END) * COALESCE(ci.cantidad, 0)) AS cantidad,
              SUM((CASE WHEN c.id_tipo = $2 THEN -1 ELSE 1 END) * COALESCE(ci.total, 0)) AS ingreso,
              SUM((CASE WHEN c.id_tipo = $2 THEN -1 ELSE 1 END) * COALESCE(ci.total, 0)
                  * COALESCE((c.total - COALESCE(c.total_igv, 0)) / NULLIF(c.total, 0), 1)) AS ingreso_sin_igv,
              SUM((CASE WHEN c.id_tipo = $2 THEN -1 ELSE 1 END) * COALESCE(ci.cantidad, 0) * COALESCE(pr.precio_compra, 0)) AS costo,
              MAX(c.creado_en) FILTER (WHERE c.id_tipo <> $2) AS ultima_venta,
              BOOL_OR(COALESCE(pr.precio_compra, 0) = 0) AS sin_costo
         FROM comprobante_items ci
         JOIN comprobantes c ON c.id_comprobante = ci.id_comprobante
         LEFT JOIN productos pr ON pr.id_producto = ci.id_producto
         LEFT JOIN categorias cat ON cat.id_categoria = pr.id_categoria
        WHERE ci.id_comprobante = ANY($1::int[])
        GROUP BY COALESCE(ci.id_producto::text, NULLIF(ci.codigo, ''), ci.descripcion)
        ORDER BY ingreso_sin_igv DESC, cantidad DESC
        LIMIT $3`,
      [idsComprobante, TIPO_NOTA_CREDITO, limite],
    );
  }

  /**
   * Productos activos, creados antes de `corte`, con existencias (suma de todos los almacenes > 0) y sin ventas desde
   * `corte` (instante UTC). Cuenta como venta lo mismo que en ReportesBussnies.clasificarComprobanteReporte (ver
   * SQL_COMPROBANTE_CUENTA). Ordenado por lo que tienen inmovilizado (stock × precio de compra). `total_filas` es el total
   * sin recortar. Solo lectura.
   */
  async obtenerProductosEstancados(corte: Date, limite: number): Promise<FilaProductoEstancado[]> {
    return this.comprobanteRepo.manager.query(
      `SELECT p.id_producto,
              COALESCE(NULLIF(p.sku, ''), NULLIF(p.codigo_barras, ''), '') AS codigo,
              p.nombre AS producto,
              COALESCE(cat.nombre, 'Sin categoría') AS categoria,
              st.stock,
              COALESCE(p.precio_compra, 0) AS precio_compra,
              ult.ultima_venta,
              COUNT(*) OVER() AS total_filas
         FROM productos p
         JOIN (SELECT i.id_producto, SUM(COALESCE(i.stock, 0)) AS stock
                 FROM inventario i
                GROUP BY i.id_producto
               HAVING SUM(COALESCE(i.stock, 0)) > 0) st ON st.id_producto = p.id_producto
         LEFT JOIN categorias cat ON cat.id_categoria = p.id_categoria
         LEFT JOIN LATERAL (
                SELECT MAX(c.creado_en) AS ultima_venta
                  FROM comprobante_items ci
                  JOIN comprobantes c ON c.id_comprobante = ci.id_comprobante
                 WHERE ci.id_producto = p.id_producto
                   AND ${SQL_COMPROBANTE_CUENTA}
              ) ult ON TRUE
        WHERE COALESCE(p.estado, TRUE) = TRUE
          AND p.creado_en < $1
          AND (ult.ultima_venta IS NULL OR ult.ultima_venta < $1)
        ORDER BY st.stock * COALESCE(p.precio_compra, 0) DESC, p.nombre ASC
        LIMIT $2`,
      [aTimestampUtc(corte), limite],
    );
  }

  /** Los últimos comprobantes (30 días) que piden atención: pendientes, con error, rechazados o con excepción. Solo lectura. */
  async obtenerComprobantesConProblema(limite: number): Promise<FilaComprobanteProblema[]> {
    return this.comprobanteRepo.manager.query(
      `SELECT c.id_comprobante, c.id_tipo, c.serie, c.numero, c.estado, c.estado_sunat, c.total, c.creado_en
         FROM comprobantes c
        WHERE COALESCE(c.anulado, FALSE) = FALSE
          AND LOWER(COALESCE(c.ambiente_fiscal, '')) <> 'beta'
          AND c.creado_en >= NOW() - INTERVAL '30 days'
          AND COALESCE(c.estado_sunat, '') <> 'POR_RESUMIR'
          AND (c.estado IN ('pendiente', 'error') OR UPPER(COALESCE(c.estado_sunat, '')) IN ('RECHAZADO', 'EXCEPCION'))
        ORDER BY c.creado_en DESC, c.id_comprobante DESC
        LIMIT $1`,
      [limite],
    );
  }

  /**
   * Pedidos de la tienda web que esperan al negocio: pendientes de pago y pagados por preparar. Solo lectura.
   * La misma consulta vive en `PedidoRepository.contarPorPreparar` (resumen del panel); duplicada a propósito.
   */
  async contarPedidosWeb(): Promise<{ pendientes: number; pagados: number }> {
    const filas: Array<{ estado: string; total: number | string }> = await this.comprobanteRepo.manager.query(
      `SELECT estado, COUNT(*)::int AS total
         FROM pedidos
        WHERE estado IN ('pendiente', 'pagado')
        GROUP BY estado`,
    );
    const de = (estado: string) => Number(filas.find((f) => f.estado === estado)?.total ?? 0);
    return { pendientes: de('pendiente'), pagados: de('pagado') };
  }
}
