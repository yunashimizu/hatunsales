import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EsquemaCajaService, SnapshotEsquema } from '../../caja/esquema/esquema-caja.service';
import { sqlFinExclusivoDiaLima, sqlInicioDiaLima, ZONA_LIMA } from '../../util/fecha-lima';
import { TIPO_BOLETA, TIPO_FACTURA, TIPO_NOTA_CREDITO } from '../../util/fiscal/tipos-comprobante';
import type { CabeceraComprobante } from './nota-credito.repository';

/** Tope de filas por página de los listados de ventas (D13). */
export const MAXIMO_VENTAS_POR_PAGINA = 100;

const CLIENTE_VARIOS = 'CLIENTES VARIOS';

/**
 * D10: la factura o boleta que cuenta como EL comprobante de la venta: no anulada ni en error (la que
 * está en envío también cuenta, para no emitir otra encima). Mismo criterio que el índice único
 * uq_comprobantes_venta_principal de fase12 y que la emisión del comprobante de una venta.
 */
export function sqlPrincipalVigente(alias: string): string {
  return `${alias}.id_tipo IN (${TIPO_FACTURA}, ${TIPO_BOLETA}) AND COALESCE(${alias}.anulado, FALSE) = FALSE AND COALESCE(${alias}.estado, '') <> 'error'`;
}

/**
 * Hora de Lima en ISO 8601 de una columna `timestamp without time zone` que guarda la hora UTC (la BD está en
 * Etc/UTC). Se arma en SQL para no depender de la zona del proceso; Perú no tiene horario de verano: -05:00 fijo.
 */
export function sqlIsoLima(columna: string): string {
  return `to_char((${columna} AT TIME ZONE 'UTC') AT TIME ZONE '${ZONA_LIMA}', 'YYYY-MM-DD"T"HH24:MI:SS"-05:00"')`;
}

/** Nombre y documento de quien compró (alias c = clientes, e = empresas); los arma `clienteDe`. */
const SQL_PARTES_CLIENTE = `NULLIF(TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno)), '') AS cliente_nombre,
              c.dni::text AS cliente_dni,
              NULLIF(TRIM(COALESCE(e.razon_social, e.nombre_comercial, e.ruc)), '') AS empresa_nombre,
              NULLIF(TRIM(e.ruc), '') AS empresa_ruc`;

/** Venta con lo que muestra el panel «Documentos de la venta». */
export interface VentaDeDocumentos {
  id_venta: number;
  /** ISO 8601 con -05:00. */
  fecha: string;
  total: number;
  estado: string;
  cliente: { nombre: string; documento: string | null };
  pagos: { metodo: string; monto: number }[];
  a_credito: boolean;
  saldo_cxc: number;
  /** Líneas de producto guardadas: sin ellas no se le puede emitir el comprobante. */
  cantidad_lineas: number;
}

/**
 * Factura, boleta o nota de crédito de la venta. Es también una CabeceraComprobante, así las reglas
 * de anulación de D9 (clasificarParaAnular) se aplican sobre la misma fila sin volver a leerla.
 */
export interface ComprobanteDeLaVenta extends CabeceraComprobante {
  error_mensaje: string | null;
  sunat_description: string | null;
  motivo_anulacion: string | null;
  /** Mensaje del último envío a SUNAT. */
  mensaje_envio: string | null;
  /** Solo notas (fase9): el comprobante que modifican y el motivo (catálogo 09). */
  id_comprobante_modificado: number | null;
  doc_modificado_serie: string | null;
  doc_modificado_numero: number | null;
  nota_motivo: string | null;
  /** Solo notas (fase14): null si la columna no existe o la nota es histórica. */
  efecto_nota: string | null;
  /** fase14: null si la columna no existe. */
  efectos_aplicados: boolean | null;
}

export interface GuiaDeLaVenta {
  id_guia: number;
  serie: string | null;
  numero: number | null;
  estado: string;
  /** aaaa-mm-dd. */
  fecha_emision: string | null;
  /** Catálogo 20 de la GRE directa. */
  motivo_codigo: string | null;
  /** Texto libre de las guías anteriores a la GRE directa. */
  motivo_texto: string | null;
}

/** Ya validado por el DTO: desde/hasta son días de Lima (aaaa-mm-dd). */
export interface FiltroVentasSinComprobante {
  desde?: string;
  hasta?: string;
  pagina?: number;
  por_pagina?: number;
}

export interface VentaSinComprobanteGuardada {
  id_venta: number;
  fecha: string;
  total: number;
  cliente: { nombre: string; documento: string | null };
  /** La última factura o boleta que tuvo (anulada o con error), si tuvo alguna. */
  ultimo: { serie: string; numero: number; anulado: boolean; mensaje: string | null } | null;
}

function numero(valor: unknown, respaldo = 0): number {
  if (valor === null || valor === undefined || valor === '') return respaldo;
  const n = Number(valor);
  return Number.isFinite(n) ? n : respaldo;
}

function numeroONulo(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

function textoONulo(valor: unknown): string | null {
  return valor === null || valor === undefined ? null : String(valor);
}

function booleano(valor: unknown): boolean {
  return valor === true || valor === 't' || valor === 'true';
}

/** El cliente si la venta tiene uno con nombre; si no, la empresa; si no, clientes varios (como en el resto del sistema). */
function clienteDe(f: Record<string, unknown>): { nombre: string; documento: string | null } {
  if (f.cliente_nombre) {
    // dni es numérico en la BD: un DNI que empieza con 0 se guardó sin él.
    const dni = String(f.cliente_dni ?? '').replace(/\D/g, '');
    return { nombre: String(f.cliente_nombre), documento: dni ? dni.padStart(8, '0') : null };
  }
  if (f.empresa_nombre) return { nombre: String(f.empresa_nombre), documento: textoONulo(f.empresa_ruc) };
  return { nombre: CLIENTE_VARIOS, documento: null };
}

/**
 * Lectura de los documentos de una venta (PLAN V3, D10): la venta, sus comprobantes (factura, boleta y
 * notas de crédito) y sus guías, una consulta por tipo de documento; y las ventas que se quedaron sin
 * comprobante. Solo lectura. Las columnas de fase12/13/14 se leen como JSON (to_jsonb): sin la migración
 * llegan null y nada falla; las opcionales de ventas y del crédito se usan solo si el esquema las reporta.
 */
@Injectable()
export class VentaDocumentosRepository {

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
    private readonly esquema: EsquemaCajaService,
  ) {}

  /** La venta con su cliente, pagos y cuenta por cobrar. null si no existe. */
  async venta(idVenta: number): Promise<VentaDeDocumentos | null> {
    const snapshot = await this.esquema.snapshot();
    const filas: any[] = await this.dataSource.query(
      `SELECT v.id_venta,
              ${sqlIsoLima('v.fecha')} AS fecha,
              COALESCE(v.total, 0)::text AS total,
              ${this.estadoVenta(snapshot)} AS estado,
              ${SQL_PARTES_CLIENTE},
              (SELECT COUNT(*)::int FROM detalle_venta d WHERE d.id_venta = v.id_venta) AS cantidad_lineas,
              COALESCE((
                SELECT json_agg(json_build_object(
                         'metodo', COALESCE(NULLIF(TRIM(mp.nombre), ''), 'Pago'),
                         'monto', p.monto::text
                       ) ORDER BY p.id_metodo)
                  FROM venta_pago p
                  LEFT JOIN metodos_pago mp ON mp.id_metodo = p.id_metodo
                 WHERE p.id_venta = v.id_venta
              ), '[]'::json) AS pagos,
              ${snapshot.tiene('credito')
                ? `EXISTS (SELECT 1 FROM cuentas_por_cobrar x
                            WHERE x.id_venta = v.id_venta AND COALESCE(x.estado, '') <> 'anulado') AS a_credito,
                   (SELECT COALESCE(SUM(x.saldo), 0) FROM cuentas_por_cobrar x
                     WHERE x.id_venta = v.id_venta AND x.estado IN ('pendiente', 'parcial', 'vencido'))::text AS saldo_cxc`
                : `FALSE AS a_credito, '0' AS saldo_cxc`}
         FROM ventas v
         LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
         ${this.joinEmpresa(snapshot)}
        WHERE v.id_venta = $1`,
      [idVenta],
    );
    const f = filas[0];
    if (!f) return null;
    const pagos: any[] = Array.isArray(f.pagos) ? f.pagos : [];
    return {
      id_venta: Number(f.id_venta),
      fecha: String(f.fecha),
      total: numero(f.total),
      estado: String(f.estado ?? 'activa'),
      cliente: clienteDe(f),
      pagos: pagos.map((p) => ({ metodo: String(p?.metodo ?? 'Pago'), monto: numero(p?.monto) })),
      a_credito: booleano(f.a_credito),
      saldo_cxc: numero(f.saldo_cxc),
      cantidad_lineas: numero(f.cantidad_lineas),
    };
  }

  /** Facturas, boletas y notas de crédito de la venta con su último envío, de la más reciente a la más antigua. */
  async comprobantes(idVenta: number): Promise<ComprobanteDeLaVenta[]> {
    const filas: any[] = await this.dataSource.query(
      `SELECT c.id_comprobante, c.id_tipo, c.serie, c.numero, c.fecha_de_emision, c.cliente_tipo_doc,
              c.cliente_numero_doc, c.cliente_denominacion, c.id_moneda, COALESCE(c.total, 0)::text AS total,
              c.porcentaje_igv, COALESCE(c.anulado, FALSE) AS anulado, c.estado, c.estado_sunat,
              COALESCE(c.aceptada_sunat, FALSE) AS aceptada_sunat, c.ambiente_fiscal, c.proveedor_fiscal,
              c.id_venta, c.id_envio_ultimo, c.error_mensaje, c.sunat_description, c.motivo_anulacion,
              x.j ->> 'id_comprobante_modificado' AS id_comprobante_modificado,
              x.j ->> 'doc_modificado_serie'      AS doc_modificado_serie,
              x.j ->> 'doc_modificado_numero'     AS doc_modificado_numero,
              x.j ->> 'nota_motivo'               AS nota_motivo,
              x.j ->> 'efecto_nota'               AS efecto_nota,
              x.j ->> 'efectos_aplicados'         AS efectos_aplicados,
              e.id_envio AS envio_id, e.estado AS envio_estado, e.codigo_sunat AS envio_codigo,
              e.mensaje_sunat AS envio_mensaje,
              e.respuesta_json #>> '{clasificacion,accion}' AS envio_accion,
              (e.bloqueado_hasta IS NULL OR e.bloqueado_hasta < NOW()) AS envio_libre
         FROM comprobantes c
        CROSS JOIN LATERAL (SELECT to_jsonb(c) AS j) x
         LEFT JOIN fiscal_envios e ON e.id_envio = c.id_envio_ultimo
        WHERE c.id_venta = $1
          AND c.id_tipo = ANY($2::int[])
        ORDER BY c.creado_en DESC, c.id_comprobante DESC`,
      [idVenta, [TIPO_FACTURA, TIPO_BOLETA, TIPO_NOTA_CREDITO]],
    );
    return filas.map((f) => ({
      id_comprobante: Number(f.id_comprobante),
      id_tipo: Number(f.id_tipo),
      serie: String(f.serie ?? ''),
      numero: Number(f.numero),
      fecha_de_emision: String(f.fecha_de_emision ?? ''),
      cliente_tipo_doc: numero(f.cliente_tipo_doc),
      cliente_numero_doc: String(f.cliente_numero_doc ?? ''),
      cliente_denominacion: String(f.cliente_denominacion ?? ''),
      id_moneda: numero(f.id_moneda, 1),
      total: numero(f.total),
      porcentaje_igv: numero(f.porcentaje_igv, 18),
      anulado: booleano(f.anulado),
      estado: textoONulo(f.estado),
      estado_sunat: textoONulo(f.estado_sunat),
      aceptada_sunat: booleano(f.aceptada_sunat),
      ambiente_fiscal: textoONulo(f.ambiente_fiscal),
      proveedor_fiscal: textoONulo(f.proveedor_fiscal),
      id_venta: numeroONulo(f.id_venta),
      id_envio_ultimo: numeroONulo(f.id_envio_ultimo),
      envio: f.envio_id === null || f.envio_id === undefined
        ? null
        : {
            estado: textoONulo(f.envio_estado),
            codigo: textoONulo(f.envio_codigo),
            accion: textoONulo(f.envio_accion),
            libre: booleano(f.envio_libre),
          },
      error_mensaje: textoONulo(f.error_mensaje),
      sunat_description: textoONulo(f.sunat_description),
      motivo_anulacion: textoONulo(f.motivo_anulacion),
      mensaje_envio: textoONulo(f.envio_mensaje),
      id_comprobante_modificado: numeroONulo(f.id_comprobante_modificado),
      doc_modificado_serie: textoONulo(f.doc_modificado_serie),
      doc_modificado_numero: numeroONulo(f.doc_modificado_numero),
      nota_motivo: textoONulo(f.nota_motivo),
      efecto_nota: textoONulo(f.efecto_nota),
      efectos_aplicados: f.efectos_aplicados === null || f.efectos_aplicados === undefined ? null : booleano(f.efectos_aplicados),
    }));
  }

  /** Guías de remisión de la venta, en el orden en que se crearon (solo columnas de guia_remision_directa_v1). */
  async guias(idVenta: number): Promise<GuiaDeLaVenta[]> {
    const filas: any[] = await this.dataSource.query(
      `SELECT g.id_guia, g.serie, g.numero, COALESCE(g.estado, 'legacy') AS estado,
              to_char(g.fecha_emision, 'YYYY-MM-DD') AS fecha_emision,
              NULLIF(TRIM(g.motivo_traslado_codigo), '') AS motivo_codigo,
              NULLIF(TRIM(g.motivo_traslado), '') AS motivo_texto
         FROM guias_remision g
        WHERE g.id_venta = $1
        ORDER BY g.id_guia`,
      [idVenta],
    );
    return filas.map((f) => ({
      id_guia: Number(f.id_guia),
      serie: textoONulo(f.serie),
      numero: numeroONulo(f.numero),
      estado: String(f.estado),
      fecha_emision: textoONulo(f.fecha_emision),
      motivo_codigo: textoONulo(f.motivo_codigo),
      motivo_texto: textoONulo(f.motivo_texto),
    }));
  }

  /**
   * Ventas activas sin factura ni boleta vigente (las que solo tienen comprobantes anulados o con error
   * también cuentan), de la más reciente a la más antigua, con su último comprobante si tuvo alguno.
   */
  async sinComprobante(
    filtro: FiltroVentasSinComprobante,
  ): Promise<{ filas: VentaSinComprobanteGuardada[]; total: number; pagina: number; por_pagina: number }> {
    const pagina = Math.max(1, Number(filtro.pagina) || 1);
    const porPagina = Math.min(MAXIMO_VENTAS_POR_PAGINA, Math.max(1, Number(filtro.por_pagina) || 20));
    const snapshot = await this.esquema.snapshot();

    const condiciones = [`NOT EXISTS (SELECT 1 FROM comprobantes p WHERE p.id_venta = v.id_venta AND ${sqlPrincipalVigente('p')})`];
    if (snapshot.tieneColumna('ventas', 'estado')) condiciones.push(`COALESCE(v.estado, 'activa') = 'activa'`);
    const parametros: unknown[] = [];
    // Días de Lima: ventas.fecha guarda la hora UTC.
    if (filtro.desde) {
      parametros.push(filtro.desde);
      condiciones.push(`v.fecha >= ${sqlInicioDiaLima(`$${parametros.length}`)}`);
    }
    if (filtro.hasta) {
      parametros.push(filtro.hasta);
      condiciones.push(`v.fecha < ${sqlFinExclusivoDiaLima(`$${parametros.length}`)}`);
    }
    const donde = condiciones.join(' AND ');
    const paramsDatos = [...parametros, porPagina, (pagina - 1) * porPagina];

    const [totales, filas] = await Promise.all([
      this.dataSource.query(`SELECT COUNT(*)::int AS total FROM ventas v WHERE ${donde}`, parametros),
      this.dataSource.query(
        `SELECT v.id_venta,
                ${sqlIsoLima('v.fecha')} AS fecha,
                COALESCE(v.total, 0)::text AS total,
                ${SQL_PARTES_CLIENTE},
                u.serie AS ultimo_serie, u.numero AS ultimo_numero, u.anulado AS ultimo_anulado, u.mensaje AS ultimo_mensaje
           FROM ventas v
           LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
           ${this.joinEmpresa(snapshot)}
           LEFT JOIN LATERAL (
                  SELECT p.serie, p.numero, COALESCE(p.anulado, FALSE) AS anulado,
                         CASE WHEN COALESCE(p.anulado, FALSE) THEN NULLIF(TRIM(p.motivo_anulacion), '')
                              ELSE COALESCE(NULLIF(TRIM(p.error_mensaje), ''), NULLIF(TRIM(p.sunat_description), ''))
                         END AS mensaje
                    FROM comprobantes p
                   WHERE p.id_venta = v.id_venta AND p.id_tipo IN (${TIPO_FACTURA}, ${TIPO_BOLETA})
                   ORDER BY p.creado_en DESC, p.id_comprobante DESC
                   LIMIT 1
                ) u ON TRUE
          WHERE ${donde}
          ORDER BY v.fecha DESC, v.id_venta DESC
          LIMIT $${paramsDatos.length - 1} OFFSET $${paramsDatos.length}`,
        paramsDatos,
      ),
    ]);

    return {
      filas: (filas as any[]).map((f) => ({
        id_venta: Number(f.id_venta),
        fecha: String(f.fecha),
        total: numero(f.total),
        cliente: clienteDe(f),
        ultimo: f.ultimo_serie === null || f.ultimo_serie === undefined
          ? null
          : { serie: String(f.ultimo_serie), numero: Number(f.ultimo_numero), anulado: booleano(f.ultimo_anulado), mensaje: textoONulo(f.ultimo_mensaje) },
      })),
      total: Number((totales as any[])[0]?.total ?? 0),
      pagina,
      por_pagina: porPagina,
    };
  }

  private estadoVenta(snapshot: SnapshotEsquema): string {
    return snapshot.tieneColumna('ventas', 'estado') ? "COALESCE(v.estado, 'activa')" : "'activa'";
  }

  /** Sin la columna ventas.id_empresa la venta no tiene empresa: el JOIN no la referencia. */
  private joinEmpresa(snapshot: SnapshotEsquema): string {
    return snapshot.tieneColumna('ventas', 'id_empresa')
      ? 'LEFT JOIN empresas e ON e.id_empresa = v.id_empresa'
      : 'LEFT JOIN empresas e ON FALSE';
  }
}
