import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { EsquemaCajaService } from '../../caja/esquema/esquema-caja.service';
import { filasDe } from '../../caja/bd/resultado-consulta';
import { TIPO_BOLETA, TIPO_FACTURA, TIPO_NOTA_CREDITO } from '../../util/fiscal/tipos-comprobante';

/** Conexión de una transacción abierta (EntityManager o QueryRunner): solo query() con parámetros $n. */
type Consultor = Pick<EntityManager, 'query'>;

/** Envío a SUNAT del comprobante tal como lo necesita la anulación (D9) para clasificarlo. */
export interface EnvioDelComprobante {
  estado: string | null;
  codigo: string | null;
  /** Acción que indicó el clasificador (REINTENTAR, RECUPERAR_CDR…). */
  accion: string | null;
  /** Nadie lo está enviando ahora (sin plazo de bloqueo vigente). */
  libre: boolean;
}

export interface CabeceraComprobante {
  id_comprobante: number;
  id_tipo: number;
  serie: string;
  numero: number;
  fecha_de_emision: string;
  cliente_tipo_doc: number;
  cliente_numero_doc: string;
  cliente_denominacion: string;
  id_moneda: number;
  total: number;
  porcentaje_igv: number;
  anulado: boolean;
  estado: string | null;
  estado_sunat: string | null;
  aceptada_sunat: boolean;
  ambiente_fiscal: string | null;
  proveedor_fiscal: string | null;
  id_venta: number | null;
  id_envio_ultimo: number | null;
  envio: EnvioDelComprobante | null;
}

export interface ItemOrigen {
  id_item: number;
  id_producto: number | null;
  codigo: string | null;
  codigo_producto_sunat: string | null;
  unidad_de_medida: string;
  descripcion: string;
  cantidad: number;
  /** Con IGV, como se cobró. */
  precio_unitario: number;
  /** Descuento de la línea, con IGV. */
  descuento: number;
  total: number;
  tipo_de_igv: number;
}

export interface OrigenNota extends CabeceraComprobante {
  items: ItemOrigen[];
}

/** Nota de crédito ya registrada sobre un comprobante (vigente o no). */
export interface NotaDeOrigen {
  id_comprobante: number;
  serie: string;
  numero: number;
  motivo: string | null;
  total: number;
  estado: string | null;
  estado_sunat: string | null;
  anulado: boolean;
  aceptada_sunat: boolean;
  /** Columnas de fase14 (null sin la migración o en notas históricas). */
  efecto: string | null;
  efectos_aplicados: boolean;
  id_envio_ultimo: number | null;
  /** Mensaje de SUNAT o del envío, para explicar un rechazo. */
  mensaje: string | null;
}

/** Línea de una nota de crédito VIGENTE del origen (para lo ya acreditado por ítem y por tramo). */
export interface LineaNotaVigente {
  id_nota: number;
  motivo: string | null;
  id_item_origen: number | null;
  cantidad: number;
  total: number;
  tipo_de_igv: number;
}

/** Venta del comprobante: cómo se cobró y cuánto debe todavía. */
export interface VentaDeNota {
  id_venta: number;
  estado: string;
  a_credito: boolean;
  saldo_cxc: number;
  /** Cobrado con medios distintos del crédito (efectivo, tarjeta, Yape…). */
  contado: number;
}

/** Nota de crédito cuyos efectos se acaban de reclamar (efectos_aplicados pasó a true en esta transacción). */
export interface NotaReclamada {
  id_comprobante: number;
  serie: string;
  numero: number;
  motivo: string | null;
  total: number;
  efecto: string;
  reingresar_stock: boolean;
  id_venta: number | null;
  id_origen: number | null;
}

export interface LineaDeNota {
  id_producto: number | null;
  codigo: string | null;
  cantidad: number;
  id_item_origen: number | null;
}

/** Datos del descarte de un envío que SUNAT no tiene y que no debe volver a enviarse (D9). */
export interface DescarteEnvio {
  id_envio: number;
  id_comprobante: number;
  mensaje: string;
  detalle: Record<string, unknown>;
}

const SQL_VIGENTE = `COALESCE(n.anulado, FALSE) = FALSE AND COALESCE(n.estado, '') <> 'error' AND COALESCE(n.estado_sunat, '') <> 'RECHAZADO'`;
/** Envío de la nota todavía sin respuesta definitiva de SUNAT: otra nota del mismo origen debe esperar. */
const SQL_EN_CURSO = `${SQL_VIGENTE} AND COALESCE(n.estado_sunat, 'NO_ENVIADO') IN ('NO_ENVIADO', 'ENVIANDO', 'PENDIENTE_REENVIO')`;
const MOTIVOS_TOTALES_SQL = `('01', '02', '06')`;

const ESTADOS_ACEPTADO_SQL = `('ACEPTADO', 'ACEPTADO_OBS')`;

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

/**
 * Acceso SQL de las notas de crédito (PLAN V3, D8 y D9): el comprobante origen con sus ítems, lo ya
 * acreditado por las notas vigentes, la venta enlazada y los efectos que se aplican cuando SUNAT
 * acepta la nota. Las columnas de fase14 se usan solo si el esquema las reporta (EsquemaCajaService);
 * las de fase9 (enlace de la nota) se leen con to_jsonb para no romper sin la migración.
 */
@Injectable()
export class NotaCreditoRepository {

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
    private readonly esquema: EsquemaCajaService,
  ) {}

  /** ¿Están las columnas de sql/fase14_notas_credito_enlace.sql? Sin ellas las notas responden 503. */
  esquemaListo(): Promise<boolean> {
    return this.esquema.tiene('notasCredito');
  }

  transaccion<T>(trabajo: (consultor: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(trabajo);
  }

  // ── Comprobante origen ───────────────────────────────────────

  /** Cabecera con su último envío y los ítems en el orden del comprobante. null si no existe. */
  async origen(idComprobante: number, consultor: Consultor = this.dataSource): Promise<OrigenNota | null> {
    const cabeceras = await this.cabeceras('c.id_comprobante = $1', [idComprobante], consultor);
    const cabecera = cabeceras[0];
    if (!cabecera) return null;
    const items: any[] = await consultor.query(
      `SELECT id_item, id_producto, codigo, codigo_producto_sunat, unidad_de_medida, descripcion,
              cantidad, precio_unitario, descuento, total, tipo_de_igv
         FROM comprobante_items
        WHERE id_comprobante = $1
        ORDER BY id_item`,
      [idComprobante],
    );
    return {
      ...cabecera,
      items: items.map((i) => ({
        id_item: Number(i.id_item),
        id_producto: numeroONulo(i.id_producto),
        codigo: textoONulo(i.codigo),
        codigo_producto_sunat: textoONulo(i.codigo_producto_sunat),
        unidad_de_medida: String(i.unidad_de_medida ?? 'NIU') || 'NIU',
        descripcion: String(i.descripcion ?? ''),
        cantidad: numero(i.cantidad),
        precio_unitario: numero(i.precio_unitario),
        descuento: numero(i.descuento),
        total: numero(i.total),
        tipo_de_igv: numero(i.tipo_de_igv, 1),
      })),
    };
  }

  /** id del comprobante por serie y número (y tipo, si se indica). */
  async idPorSerieNumero(serie: string, numeroComprobante: number, idTipo?: number): Promise<number | null> {
    const filas: any[] = await this.dataSource.query(
      `SELECT id_comprobante FROM comprobantes
        WHERE serie = $1 AND numero = $2 AND ($3::int IS NULL OR id_tipo = $3::int)
        LIMIT 1`,
      [serie, numeroComprobante, idTipo ?? null],
    );
    return filas[0] ? Number(filas[0].id_comprobante) : null;
  }

  /** Facturas y boletas de la venta (todas, anuladas incluidas), con su último envío. */
  principalesDeVenta(idVenta: number, consultor: Consultor = this.dataSource): Promise<CabeceraComprobante[]> {
    return this.cabeceras('c.id_venta = $1 AND c.id_tipo = ANY($2::int[])', [idVenta, [TIPO_FACTURA, TIPO_BOLETA]], consultor);
  }

  // ── Notas del origen ─────────────────────────────────────────

  /**
   * Notas de crédito del comprobante, de la más antigua a la más reciente. Sin las columnas de enlace
   * de fase9 no puede haber ninguna; las de fase14 (efecto) se leen como JSON.
   */
  async notasDeOrigen(idOrigen: number, consultor: Consultor = this.dataSource): Promise<NotaDeOrigen[]> {
    const snapshot = await this.esquema.snapshot();
    if (!snapshot.tieneColumna('comprobantes', 'id_comprobante_modificado')) return [];
    const filas: any[] = await consultor.query(
      `SELECT n.id_comprobante, n.serie, n.numero, n.total, n.estado, n.estado_sunat, n.id_envio_ultimo,
              COALESCE(n.anulado, FALSE) AS anulado, COALESCE(n.aceptada_sunat, FALSE) AS aceptada_sunat,
              COALESCE(n.error_mensaje, n.sunat_description) AS mensaje,
              x.j ->> 'nota_motivo' AS motivo,
              x.j ->> 'efecto_nota' AS efecto,
              COALESCE((x.j ->> 'efectos_aplicados')::boolean, FALSE) AS efectos_aplicados
         FROM comprobantes n
        CROSS JOIN LATERAL (SELECT to_jsonb(n) AS j) x
        WHERE n.id_comprobante_modificado = $1
          AND n.id_tipo = $2
        ORDER BY n.id_comprobante`,
      [idOrigen, TIPO_NOTA_CREDITO],
    );
    return filas.map((f) => ({
      id_comprobante: Number(f.id_comprobante),
      serie: String(f.serie ?? ''),
      numero: Number(f.numero),
      motivo: textoONulo(f.motivo),
      total: numero(f.total),
      estado: textoONulo(f.estado),
      estado_sunat: textoONulo(f.estado_sunat),
      anulado: booleano(f.anulado),
      aceptada_sunat: booleano(f.aceptada_sunat),
      efecto: textoONulo(f.efecto),
      efectos_aplicados: booleano(f.efectos_aplicados),
      id_envio_ultimo: numeroONulo(f.id_envio_ultimo),
      mensaje: textoONulo(f.mensaje),
    }));
  }

  /** Líneas de las notas VIGENTES del origen (requiere fase14: id_item_origen). */
  async lineasVigentes(idOrigen: number, consultor: Consultor = this.dataSource): Promise<LineaNotaVigente[]> {
    const filas: any[] = await consultor.query(
      `SELECT n.id_comprobante AS id_nota, n.nota_motivo AS motivo, i.id_item_origen, i.cantidad, i.total, i.tipo_de_igv
         FROM comprobantes n
         JOIN comprobante_items i ON i.id_comprobante = n.id_comprobante
        WHERE n.id_comprobante_modificado = $1
          AND n.id_tipo = $2
          AND ${SQL_VIGENTE}
        ORDER BY n.id_comprobante, i.id_item`,
      [idOrigen, TIPO_NOTA_CREDITO],
    );
    return filas.map((f) => ({
      id_nota: Number(f.id_nota),
      motivo: textoONulo(f.motivo),
      id_item_origen: numeroONulo(f.id_item_origen),
      cantidad: numero(f.cantidad),
      total: numero(f.total),
      tipo_de_igv: numero(f.tipo_de_igv, 1),
    }));
  }

  /**
   * Saldo acreditable y notas en curso de varios comprobantes en una consulta (acciones del listado y
   * del detalle). Funciona sin fase14; sin las columnas de enlace de fase9 devuelve un mapa vacío.
   */
  async resumenes(ids: number[]): Promise<Map<number, { saldo: number; nota_en_curso: boolean; anulacion_en_curso: boolean }>> {
    const unicos = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
    if (!unicos.length) return new Map();
    const snapshot = await this.esquema.snapshot();
    if (!snapshot.tieneColumna('comprobantes', 'id_comprobante_modificado') || !snapshot.tieneColumna('comprobantes', 'nota_motivo')) {
      return new Map();
    }
    const filas: any[] = await this.dataSource.query(
      `SELECT o.id_comprobante,
              (COALESCE(o.total, 0) - COALESCE(SUM(n.total) FILTER (WHERE ${SQL_VIGENTE}), 0))::text AS saldo,
              COALESCE(BOOL_OR(${SQL_EN_CURSO}), FALSE) AS nota_en_curso,
              COALESCE(BOOL_OR(${SQL_EN_CURSO}
                AND (n.nota_motivo IN ${MOTIVOS_TOTALES_SQL} OR to_jsonb(n) ->> 'efecto_nota' = 'anular_venta')), FALSE) AS anulacion_en_curso
         FROM comprobantes o
         LEFT JOIN comprobantes n ON n.id_comprobante_modificado = o.id_comprobante AND n.id_tipo = $2
        WHERE o.id_comprobante = ANY($1::int[])
        GROUP BY o.id_comprobante, o.total`,
      [unicos, TIPO_NOTA_CREDITO],
    );
    return new Map(
      filas.map((f) => [
        Number(f.id_comprobante),
        { saldo: Math.max(0, numero(f.saldo)), nota_en_curso: booleano(f.nota_en_curso), anulacion_en_curso: booleano(f.anulacion_en_curso) },
      ]),
    );
  }

  // ── Venta enlazada ───────────────────────────────────────────

  /** Estado de la venta, su deuda viva y lo cobrado al contado. null si la venta no existe. */
  async ventaDeNota(idVenta: number, consultor: Consultor = this.dataSource): Promise<VentaDeNota | null> {
    const snapshot = await this.esquema.snapshot();
    const conEstado = snapshot.tieneColumna('ventas', 'estado');
    const conCredito = snapshot.tiene('credito');
    const filas: any[] = await consultor.query(
      `SELECT v.id_venta,
              ${conEstado ? "COALESCE(v.estado, 'activa')" : "'activa'"} AS estado,
              ${conCredito
                ? `EXISTS (SELECT 1 FROM cuentas_por_cobrar c WHERE c.id_venta = v.id_venta AND COALESCE(c.estado, '') <> 'anulado') AS a_credito,
                   (SELECT COALESCE(SUM(c.saldo), 0) FROM cuentas_por_cobrar c
                     WHERE c.id_venta = v.id_venta AND c.estado IN ('pendiente', 'parcial', 'vencido'))::text AS saldo_cxc`
                : `FALSE AS a_credito, '0' AS saldo_cxc`},
              (SELECT COALESCE(SUM(p.monto), 0)
                 FROM venta_pago p
                 LEFT JOIN metodos_pago m ON m.id_metodo = p.id_metodo
                WHERE p.id_venta = v.id_venta AND LOWER(COALESCE(m.tipo, '')) <> 'credito')::text AS contado
         FROM ventas v
        WHERE v.id_venta = $1`,
      [idVenta],
    );
    const f = filas[0];
    if (!f) return null;
    return {
      id_venta: Number(f.id_venta),
      estado: String(f.estado ?? 'activa'),
      a_credito: booleano(f.a_credito),
      saldo_cxc: numero(f.saldo_cxc),
      contado: numero(f.contado),
    };
  }

  // ── Efectos al aceptarse (D8) ────────────────────────────────

  /** Notas aceptadas con efectos todavía sin aplicar (barrido de cada 5 minutos). */
  async notasConEfectosPendientes(limite: number): Promise<number[]> {
    const filas: any[] = await this.dataSource.query(
      `SELECT id_comprobante
         FROM comprobantes
        WHERE id_tipo = $1
          AND efectos_aplicados = FALSE
          AND efecto_nota IS NOT NULL
          AND COALESCE(aceptada_sunat, FALSE) = TRUE
          AND estado_sunat IN ${ESTADOS_ACEPTADO_SQL}
        ORDER BY id_comprobante
        LIMIT $2`,
      [TIPO_NOTA_CREDITO, Math.max(1, Math.trunc(limite))],
    );
    return filas.map((f) => Number(f.id_comprobante));
  }

  /**
   * Reclama los efectos de la nota dentro de la transacción que los aplica: solo una vez, solo si SUNAT
   * la aceptó y solo notas de este flujo (con efecto_nota). La fila queda bloqueada hasta el COMMIT, así
   * un segundo proceso espera y luego no encuentra nada que reclamar. null si no corresponde aplicar.
   */
  async reclamarEfectos(consultor: Consultor, idNota: number): Promise<NotaReclamada | null> {
    const filas = filasDe<any>(
      await consultor.query(
        `UPDATE comprobantes
            SET efectos_aplicados = TRUE, efectos_aplicados_en = NOW()
          WHERE id_comprobante = $1
            AND id_tipo = $2
            AND efectos_aplicados = FALSE
            AND efecto_nota IS NOT NULL
            AND COALESCE(aceptada_sunat, FALSE) = TRUE
            AND estado_sunat IN ${ESTADOS_ACEPTADO_SQL}
          RETURNING id_comprobante, serie, numero, nota_motivo, total, efecto_nota, reingresar_stock, id_venta,
                    id_comprobante_modificado`,
        [idNota, TIPO_NOTA_CREDITO],
      ),
    );
    const f = filas[0];
    if (!f) return null;
    return {
      id_comprobante: Number(f.id_comprobante),
      serie: String(f.serie),
      numero: Number(f.numero),
      motivo: textoONulo(f.nota_motivo),
      total: numero(f.total),
      efecto: String(f.efecto_nota),
      reingresar_stock: booleano(f.reingresar_stock),
      id_venta: numeroONulo(f.id_venta),
      id_origen: numeroONulo(f.id_comprobante_modificado),
    };
  }

  async lineasDeNota(consultor: Consultor, idNota: number): Promise<LineaDeNota[]> {
    const filas: any[] = await consultor.query(
      `SELECT id_producto, codigo, cantidad, id_item_origen
         FROM comprobante_items
        WHERE id_comprobante = $1
        ORDER BY id_item`,
      [idNota],
    );
    return filas.map((f) => ({
      id_producto: numeroONulo(f.id_producto),
      codigo: textoONulo(f.codigo),
      cantidad: numero(f.cantidad),
      id_item_origen: numeroONulo(f.id_item_origen),
    }));
  }

  /** Marca anulados (nunca DELETE) los comprobantes que aún no lo están. Devuelve los que cambió. */
  async marcarAnulados(
    consultor: Consultor,
    ids: number[],
    motivo: string,
  ): Promise<{ id_comprobante: number; serie: string; numero: number }[]> {
    if (!ids.length) return [];
    const filas = filasDe<any>(
      await consultor.query(
        `UPDATE comprobantes
            SET anulado = TRUE, motivo_anulacion = LEFT($2, 300)
          WHERE id_comprobante = ANY($1::int[]) AND COALESCE(anulado, FALSE) = FALSE
          RETURNING id_comprobante, serie, numero`,
        [ids, motivo],
      ),
    );
    return filas.map((f) => ({ id_comprobante: Number(f.id_comprobante), serie: String(f.serie), numero: Number(f.numero) }));
  }

  /**
   * Cierra un envío que SUNAT no tiene (lo confirmó getStatusCdr o el administrador en SUNAT Operaciones
   * en Línea) para que ni la tarea ni un reintento lo manden después de anular la venta: queda EXCEPCION
   * sin acción, con el descarte en respuesta_json. Solo si nadie lo está enviando ahora (plazo de bloqueo
   * vencido). false si no se pudo reclamar.
   */
  async descartarEnvio(consultor: Consultor, descarte: DescarteEnvio): Promise<boolean> {
    const json = {
      clasificacion: { estado: 'EXCEPCION', accion: 'NINGUNA', mensajeUsuario: descarte.mensaje },
      descarte: descarte.detalle,
    };
    const filas = filasDe<any>(
      await consultor.query(
        `UPDATE fiscal_envios
            SET estado = 'EXCEPCION',
                respuesta_json = COALESCE(respuesta_json, '{}'::jsonb) || $2::jsonb,
                ultimo_error = $3, bloqueado_hasta = NULL, proximo_intento_en = NULL, actualizado_en = NOW()
          WHERE id_envio = $1
            AND estado IN ('ENVIANDO', 'PENDIENTE_REENVIO', 'EXCEPCION')
            AND (bloqueado_hasta IS NULL OR bloqueado_hasta < NOW())
          RETURNING id_envio`,
        [descarte.id_envio, JSON.stringify(json), descarte.mensaje],
      ),
    );
    if (!filas[0]) return false;
    await consultor.query(
      `UPDATE comprobantes
          SET estado = 'error', estado_sunat = 'EXCEPCION', error_mensaje = $2
        WHERE id_comprobante = $1`,
      [descarte.id_comprobante, descarte.mensaje],
    );
    return true;
  }

  // ── Interno ──────────────────────────────────────────────────

  private async cabeceras(condicion: string, parametros: unknown[], consultor: Consultor): Promise<CabeceraComprobante[]> {
    const filas: any[] = await consultor.query(
      `SELECT c.id_comprobante, c.id_tipo, c.serie, c.numero, c.fecha_de_emision, c.cliente_tipo_doc,
              c.cliente_numero_doc, c.cliente_denominacion, c.id_moneda, c.total, c.porcentaje_igv,
              COALESCE(c.anulado, FALSE) AS anulado, c.estado, c.estado_sunat,
              COALESCE(c.aceptada_sunat, FALSE) AS aceptada_sunat, c.ambiente_fiscal, c.proveedor_fiscal,
              c.id_venta, c.id_envio_ultimo,
              e.id_envio AS envio_id, e.estado AS envio_estado, e.codigo_sunat AS envio_codigo,
              e.respuesta_json #>> '{clasificacion,accion}' AS envio_accion,
              (e.bloqueado_hasta IS NULL OR e.bloqueado_hasta < NOW()) AS envio_libre
         FROM comprobantes c
         LEFT JOIN fiscal_envios e ON e.id_envio = c.id_envio_ultimo
        WHERE ${condicion}
        ORDER BY c.id_comprobante`,
      parametros,
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
    }));
  }
}
