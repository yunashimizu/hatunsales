import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { FiscalConfigError } from '../config/fiscal-errores';
import type { AmbienteFiscal } from '../config/fiscal-config.tipos';
import { filasDe, TransaccionesFiscales } from '../config/transacciones-fiscales';
import { ArchivoEnvio, ConsultorTx, TIPOS_ARCHIVO_ENVIO, TipoArchivoEnvio } from '../emision/emision.contrato';
import { CierreEnvio, SEGUNDOS_RECLAMO } from '../emision/emision.tipos';
import { ArchivoNuevo, EnvioFiscalRepository } from '../emision/envio-fiscal.repository';
import type { LotePreparado } from '../nucleo/preparador-envio-cpe';
import { tipoComprobanteSunat } from '../../util/fiscal/tipos-comprobante';
import {
  FiltroLotes,
  LineaAceptadaSinAnular,
  LineaLoteVista,
  LoteDeComprobante,
  LoteVista,
  MAXIMO_LOTES_POR_PAGINA,
  OperacionLote,
} from './lotes.contrato';

/** Prefijo del identificador y tipo_documento de fiscal_envios según el lote. */
export type PrefijoLote = 'RA' | 'RC';

/** Un comprobante que entra al lote (la baja de una factura y el resumen de una boleta llevan una línea). */
export interface LineaLoteNueva {
  id_comprobante: number;
  serie: string;
  numero: number;
  /** Catálogo 01: '01' | '03'. */
  tipo_documento: string;
  /** Catálogo 19; la anulación usa 3. */
  condicion: 1 | 2 | 3;
}

export interface RegistroLoteNuevo {
  ambiente: AmbienteFiscal;
  operacion: OperacionLote;
  lote: LotePreparado;
  /** yyyy-mm-dd: día de emisión de los documentos (cbc:ReferenceDate). */
  fechaReferencia: string;
  idUsuario: number | null;
  motivo: string;
  lineas: LineaLoteNueva[];
}

/** Un lote leído (o reclamado) de fiscal_envios, con sus líneas. */
export interface LoteRegistrado {
  id_envio: number;
  ambiente: AmbienteFiscal;
  operacion: OperacionLote;
  /** 'RA' | 'RC'. */
  tipo_documento: string;
  estado: string;
  intento: number;
  nombre_archivo: string;
  /** RUC-RA-YYYYMMDD-NNNNN (nombre del XML y del ZIP sin extensión). */
  nombre_base: string;
  identificador: string;
  sunat_ticket: string | null;
  codigo_sunat: string | null;
  accion: string | null;
  /** Sin reclamo vigente (bloqueado_hasta vacío o vencido). */
  libre: boolean;
  fecha_referencia: string | null;
  /** Cuándo se registró el lote: desde ahí se cuentan los 7 días de consultas del ticket (S4). */
  creado_en: string | null;
  zip: Buffer | null;
  lineas: LineaLoteVista[];
}

/** Lo que devuelve «Liberar» (null si el lote ya no estaba en EXCEPCION con el ticket sin resolver). */
export interface LoteLiberado {
  identificador: string;
  tipo_documento: string;
  operacion: OperacionLote;
  /** Comprobantes que volvieron a su estado anterior. */
  ids_comprobantes: number[];
}

/** Lo que devuelve el guardado del cierre (null si otro proceso ya había cerrado el lote). */
export interface LoteCerrado {
  /** Primera línea del lote (el evento a los oyentes lleva ese comprobante). */
  id_comprobante: number | null;
  ids_comprobantes: number[];
  tipo_documento: string;
  operacion: OperacionLote;
  identificador: string;
}

/** Cabecera de un comprobante, lo justo para decidir si admite la baja. */
export interface CabeceraBaja {
  id_comprobante: number;
  id_tipo: number;
  serie: string;
  numero: number;
  fecha_de_emision: string;
  estado_sunat: string | null;
  aceptada_sunat: boolean;
  anulado: boolean;
  ambiente_fiscal: string | null;
  proveedor_fiscal: string | null;
  id_envio_ultimo: number | null;
}

/** Un comprobante que puede entrar a un resumen diario de adición (condición 1). */
export interface CandidatoResumen {
  id_comprobante: number;
  id_tipo: number;
  serie: string;
  numero: number;
  estado_sunat: string;
  id_envio_ultimo: number;
  /** yyyy-mm-dd. */
  fecha_de_emision: string;
}

/** Cuántos comprobantes esperan resumen en una fecha de emisión. */
export interface FechaConResumenPendiente {
  fecha: string;
  cantidad: number;
}

/** Estados de un lote que todavía pueden cambiar con una respuesta o consulta de SUNAT. */
export const ESTADOS_LOTE_ABIERTOS: readonly string[] = ['ENVIANDO', 'PENDIENTE_REENVIO', 'TICKET_PENDIENTE', 'EXCEPCION'];

const OPERACIONES_LOTE = `('resumen', 'baja')`;
const ESTADOS_COMPROBANTE_ACEPTADO: readonly string[] = ['ACEPTADO', 'ACEPTADO_OBS'];
/** Estados de un comprobante que pueden pasar a un resumen diario de adición (según el estado, además, rige el plazo). */
export const ESTADOS_ADICION: readonly string[] = ['NO_ENVIADO', 'POR_RESUMIR', 'PENDIENTE_REENVIO', 'EXCEPCION'];

/**
 * Quién puede entrar a un resumen diario de adición ($1 ambiente, $2 hoy en Lima): boletas y notas de serie B de
 * SUNAT directo, sin aceptar ni anular, dentro de los 7 días de la emisión. Las que esperan el resumen (POR_RESUMIR)
 * entran siempre; las que fallaron en el envío individual solo cuando ese plazo (5 días) ya venció, porque antes se
 * reintentan por su camino. Nunca una que SUNAT ya aceptó (lo rechazaría como duplicada) ni una que se está enviando.
 */
const ELEGIBLE_ADICION = `
  c.proveedor_fiscal = 'sunat_directo' AND c.ambiente_fiscal = $1
  AND c.id_tipo IN (2, 7, 8) AND c.serie ~ '^B'
  AND c.id_envio_ultimo IS NOT NULL
  AND COALESCE(c.anulado, FALSE) = FALSE AND COALESCE(c.aceptada_sunat, FALSE) = FALSE
  AND c.fecha_de_emision BETWEEN ($2::date - 7) AND $2::date
  AND (c.estado_sunat = 'POR_RESUMIR'
       OR (c.estado_sunat IN ('NO_ENVIADO', 'PENDIENTE_REENVIO', 'EXCEPCION') AND c.fecha_de_emision < ($2::date - 5)))
  AND NOT EXISTS (SELECT 1 FROM fiscal_envios e
                   WHERE e.id_envio = c.id_envio_ultimo AND e.estado = 'ENVIANDO' AND e.bloqueado_hasta > NOW())`;

/** Una vez que SUNAT rechazó el resumen de un comprobante, la tarea no lo vuelve a intentar sola (lo decide una persona). */
const SIN_RESUMEN_RECHAZADO = `
  NOT EXISTS (SELECT 1 FROM fiscal_resumen_lineas l
               WHERE l.id_comprobante = c.id_comprobante AND l.condicion = 1 AND l.estado = 'RECHAZADO')`;

/** Columnas de un lote para operarlo (t = fiscal_envios o el resultado de un UPDATE). */
const COLUMNAS_LOTE = `
  t.id_envio, t.ambiente, t.operacion, t.tipo_documento, t.estado, t.intento, t.nombre_archivo, t.identificador,
  t.sunat_ticket, t.codigo_sunat, t.fecha_referencia::text AS fecha_referencia, t.creado_en,
  t.respuesta_json #>> '{clasificacion,accion}' AS accion,
  (t.bloqueado_hasta IS NULL OR t.bloqueado_hasta < NOW()) AS libre`;

const COLUMNA_ZIP = `
  (SELECT a.contenido FROM fiscal_artifacts a
    WHERE a.id_envio = t.id_envio AND a.tipo_artifacto = 'zip' AND a.contenido IS NOT NULL
    ORDER BY a.id_artifact DESC LIMIT 1) AS zip`;

const COLUMNAS_VISTA = `
  t.id_envio, t.ambiente, t.operacion, t.identificador, t.estado, t.sunat_ticket, t.codigo_sunat,
  COALESCE(t.ultimo_error, t.mensaje_sunat) AS mensaje_sunat,
  t.respuesta_json #>> '{clasificacion,accion}' AS accion_sunat,
  t.fecha_referencia::text AS fecha_referencia, t.intento, t.proximo_intento_en, t.creado_en, t.actualizado_en,
  ARRAY(SELECT DISTINCT a.tipo_artifacto FROM fiscal_artifacts a
         WHERE a.id_envio = t.id_envio AND a.contenido IS NOT NULL) AS archivos`;

function sha256(contenido: string): string {
  return createHash('sha256').update(contenido).digest('hex');
}

/** timestamptz de node-postgres (Date) o ya texto → ISO 8601. */
function iso(valor: unknown): string | null {
  if (valor instanceof Date) return valor.toISOString();
  return typeof valor === 'string' ? valor : null;
}

function operacionDe(valor: unknown): OperacionLote {
  return valor === 'baja' ? 'baja' : 'resumen';
}

function ambienteDe(valor: unknown): AmbienteFiscal {
  return valor === 'produccion' ? 'produccion' : 'beta';
}

function ordenarArchivos(lista: unknown): TipoArchivoEnvio[] {
  const presentes = new Set(Array.isArray(lista) ? lista.map(String) : []);
  return TIPOS_ARCHIVO_ENVIO.filter((tipo) => presentes.has(tipo));
}

function aLinea(fila: Record<string, any>): LineaLoteVista {
  return {
    id_comprobante: Number(fila.id_comprobante),
    serie: fila.serie ?? null,
    numero: fila.numero === null || fila.numero === undefined ? null : Number(fila.numero),
    tipo_documento: tipoComprobanteSunat(fila.id_tipo === null || fila.id_tipo === undefined ? null : Number(fila.id_tipo)),
    condicion: Number(fila.condicion),
    estado: fila.estado ?? null,
  };
}

function aVista(fila: Record<string, any>, lineas: LineaLoteVista[]): LoteVista {
  return {
    id_envio: Number(fila.id_envio),
    ambiente: ambienteDe(fila.ambiente),
    operacion: operacionDe(fila.operacion),
    identificador: String(fila.identificador ?? ''),
    estado: String(fila.estado ?? ''),
    sunat_ticket: fila.sunat_ticket ?? null,
    codigo_sunat: fila.codigo_sunat ?? null,
    mensaje_sunat: fila.mensaje_sunat ?? null,
    accion_sunat: fila.accion_sunat ?? null,
    fecha_referencia: fila.fecha_referencia ?? null,
    intento: Number(fila.intento ?? 0),
    proximo_intento_en: iso(fila.proximo_intento_en),
    creado_en: iso(fila.creado_en) ?? '',
    actualizado_en: iso(fila.actualizado_en),
    archivos: ordenarArchivos(fila.archivos),
    lineas,
  };
}

function aLote(fila: Record<string, any>, lineas: LineaLoteVista[]): LoteRegistrado {
  const nombreArchivo = String(fila.nombre_archivo ?? '');
  return {
    id_envio: Number(fila.id_envio),
    ambiente: ambienteDe(fila.ambiente),
    operacion: operacionDe(fila.operacion),
    tipo_documento: String(fila.tipo_documento ?? ''),
    estado: String(fila.estado ?? ''),
    intento: Number(fila.intento ?? 0),
    nombre_archivo: nombreArchivo,
    nombre_base: nombreArchivo.replace(/\.zip$/i, ''),
    identificador: String(fila.identificador ?? ''),
    sunat_ticket: fila.sunat_ticket ?? null,
    codigo_sunat: fila.codigo_sunat ?? null,
    accion: fila.accion ?? null,
    libre: fila.libre === true,
    fecha_referencia: fila.fecha_referencia ?? null,
    creado_en: iso(fila.creado_en),
    zip: Buffer.isBuffer(fila.zip) ? fila.zip : null,
    lineas,
  };
}

/** Índice o restricción de un error de unicidad de PostgreSQL (QueryFailedError copia los campos del driver). */
function restriccionUnica(error: unknown): string | null {
  const e = error as { code?: string; constraint?: string; driverError?: { code?: string; constraint?: string } };
  const codigo = e?.driverError?.code ?? e?.code;
  return codigo === '23505' ? String(e?.driverError?.constraint ?? e?.constraint ?? '') : null;
}

/**
 * Qué pasa con los comprobantes de un lote cuando se guarda su cierre:
 *  - 'anular': SUNAT aceptó el lote → ANULADO.
 *  - 'informar': SUNAT aceptó un resumen de adición (condición 1) → los comprobantes quedan ACEPTADO.
 *  - 'ninguno': sigue en curso (ticket, reenvío) o su resultado es incierto (se agotaron las consultas del
 *    ticket: SUNAT pudo haberlo procesado) → el comprobante se queda en BAJA_PENDIENTE para que nadie lo
 *    anule otra vez mientras no se sepa.
 *  - 'restaurar': SUNAT no lo tomó (rechazo, excepción, configuración) → vuelve a su estado anterior.
 */
export function efectoDelCierre(
  cierre: Pick<CierreEnvio, 'estado' | 'accion'>,
  adicion = false,
): 'anular' | 'informar' | 'ninguno' | 'restaurar' {
  // En un resumen de adición (condición 1) aceptar significa «SUNAT ya tiene la boleta»: el comprobante queda ACEPTADO.
  if (cierre.estado === 'ACEPTADO' || cierre.estado === 'ACEPTADO_OBS') return adicion ? 'informar' : 'anular';
  if (cierre.estado === 'ENVIANDO' || cierre.estado === 'PENDIENTE_REENVIO' || cierre.estado === 'TICKET_PENDIENTE') return 'ninguno';
  if (cierre.accion === 'CONSULTAR_TICKET' || cierre.accion === 'LIBERAR') return 'ninguno';
  return 'restaurar';
}

/**
 * Persistencia de los lotes fiscales (comunicación de baja RA y resumen diario RC) sobre fiscal_envios con
 * operacion 'baja' | 'resumen', sus líneas en fiscal_resumen_lineas y sus artefactos en fiscal_artifacts.
 *
 * Mientras un lote está en curso, sus comprobantes quedan en estado_sunat BAJA_PENDIENTE y la línea guarda
 * el estado que tenían (ACEPTADO o ACEPTADO_OBS): si SUNAT rechaza el lote se les devuelve ese estado. Cada
 * operación «reclama» el lote con un UPDATE condicionado (bloqueado_hasta = ahora + 60 s) antes de hablar
 * con SUNAT, igual que los envíos de comprobantes, y quien cierra solo puede pisar estados abiertos.
 */
@Injectable()
export class LoteFiscalRepository {
  constructor(
    @InjectDataSource('pgConnection') private readonly bd: DataSource,
    private readonly transacciones: TransaccionesFiscales,
    private readonly envios: EnvioFiscalRepository,
  ) {}

  /** Cabecera del comprobante que se quiere dar de baja. null si no existe. */
  async cabeceraComprobante(idComprobante: number): Promise<CabeceraBaja | null> {
    const filas = filasDe<Record<string, any>>(
      await this.bd.query(
        `SELECT c.id_comprobante, c.id_tipo, c.serie, c.numero, c.fecha_de_emision::text AS fecha_de_emision, c.estado_sunat,
                COALESCE(c.aceptada_sunat, FALSE) AS aceptada_sunat, COALESCE(c.anulado, FALSE) AS anulado,
                c.ambiente_fiscal, c.proveedor_fiscal, c.id_envio_ultimo
           FROM comprobantes c WHERE c.id_comprobante = $1`,
        [idComprobante],
      ),
    );
    const f = filas[0];
    if (!f) return null;
    return {
      id_comprobante: Number(f.id_comprobante),
      id_tipo: Number(f.id_tipo),
      serie: String(f.serie ?? ''),
      numero: Number(f.numero),
      fecha_de_emision: String(f.fecha_de_emision ?? ''),
      estado_sunat: f.estado_sunat ?? null,
      aceptada_sunat: f.aceptada_sunat === true,
      anulado: f.anulado === true,
      ambiente_fiscal: f.ambiente_fiscal ?? null,
      proveedor_fiscal: f.proveedor_fiscal ?? null,
      id_envio_ultimo: f.id_envio_ultimo === null || f.id_envio_ultimo === undefined ? null : Number(f.id_envio_ultimo),
    };
  }

  /**
   * Siguiente correlativo del día y el ambiente: el mayor ya usado (en CUALQUIER estado: un número que
   * SUNAT pudo ver no se reutiliza) más uno. Dentro de la transacción del registro.
   */
  async siguienteCorrelativo(consultor: ConsultorTx, ambiente: AmbienteFiscal, prefijo: PrefijoLote, fechaGeneracion: string): Promise<number> {
    const compacta = fechaGeneracion.replace(/-/g, '');
    const filas = filasDe<{ siguiente: string | number }>(
      await consultor.query(
        `SELECT COALESCE(MAX(split_part(t.identificador, '-', 3)::int), 0) + 1 AS siguiente
           FROM fiscal_envios t
          WHERE t.ambiente = $1 AND t.operacion IN ${OPERACIONES_LOTE} AND t.identificador ~ $2`,
        [ambiente, `^${prefijo}-${compacta}-[0-9]{1,5}$`],
      ),
    );
    return Number(filas[0]?.siguiente ?? 1);
  }

  /**
   * Dentro de la transacción del llamador: el lote en ENVIANDO con sus artefactos (XML firmado y ZIP), sus
   * líneas y los comprobantes en BAJA_PENDIENTE. Si algún comprobante ya no está aceptado y libre (otro lote
   * en curso, ya anulado) lanza FISCAL_ENVIO_EN_CURSO y la transacción se revierte entera.
   */
  async registrar(consultor: ConsultorTx, r: RegistroLoteNuevo): Promise<number> {
    const { lote } = r;
    const tipoDocumento: PrefijoLote = r.operacion === 'baja' ? 'RA' : 'RC';
    const datos = {
      motivo: r.motivo,
      digest: lote.digestValue,
      lineas: r.lineas.map((l) => ({ id_comprobante: l.id_comprobante, tipo_documento: l.tipo_documento, serie: l.serie, numero: l.numero, condicion: l.condicion })),
    };
    let filas: Array<{ id_envio: number }>;
    try {
      filas = filasDe<{ id_envio: number }>(
        await consultor.query(
          `INSERT INTO fiscal_envios
             (tipo_documento, ambiente, proveedor, operacion, intento, estado, nombre_archivo, identificador,
              fecha_referencia, id_usuario, id_comprobante, fecha_envio, bloqueado_hasta, hash_xml, respuesta_json)
           VALUES ($1, $2, 'sunat_directo', $3, 1, 'ENVIANDO', $4, $5, $6::date, $7, NULL, NOW(),
                   NOW() + $8::int * INTERVAL '1 second', $9, $10::jsonb)
           RETURNING id_envio`,
          [
            tipoDocumento,
            r.ambiente,
            r.operacion,
            lote.zip.nombreZip,
            lote.identificador,
            r.fechaReferencia,
            r.idUsuario,
            SEGUNDOS_RECLAMO,
            sha256(lote.xmlFirmado),
            JSON.stringify(datos),
          ],
        ),
      );
    } catch (error) {
      if (restriccionUnica(error) === 'uq_fiscal_envio_identificador') {
        throw new FiscalConfigError('FISCAL_NUMERO_OCUPADO', `El identificador ${lote.identificador} ya se usó en este ambiente: se debe usar el siguiente.`, {
          identificador: lote.identificador,
        });
      }
      throw error;
    }
    const idEnvio = Number(filas[0]?.id_envio);
    if (!Number.isSafeInteger(idEnvio) || idEnvio <= 0) throw new Error('No se pudo registrar el lote fiscal.');

    const artefactos: ArchivoNuevo[] = [
      { tipo: 'xml_firmado', nombre: `${lote.nombreBase}.xml`, mime: 'application/xml', contenido: Buffer.from(lote.xmlFirmado, 'utf8') },
      { tipo: 'zip', nombre: lote.zip.nombreZip, mime: 'application/zip', contenido: lote.zip.zip },
    ];
    await this.envios.insertarArchivos(consultor, idEnvio, null, r.ambiente, artefactos);

    const adicion = r.lineas.length > 0 && r.lineas.every((l) => l.condicion === 1);
    const ids = r.lineas.map((l) => l.id_comprobante);
    const previos = adicion
      ? await this.apartarParaAdicion(consultor, idEnvio, lote.identificador, ids)
      : filasDe<{ id_comprobante: number; previo: string }>(
          // Una sola sentencia: bloquea las filas, las pasa a BAJA_PENDIENTE y devuelve el estado que tenían.
          await consultor.query(
            `WITH previo AS (
               SELECT c.id_comprobante, c.estado_sunat
                 FROM comprobantes c
                WHERE c.id_comprobante = ANY($1::int[]) AND c.estado_sunat = ANY($2::text[]) AND COALESCE(c.anulado, FALSE) = FALSE
                FOR UPDATE
             )
             UPDATE comprobantes c SET estado_sunat = 'BAJA_PENDIENTE'
               FROM previo p WHERE c.id_comprobante = p.id_comprobante
             RETURNING c.id_comprobante, p.estado_sunat AS previo`,
            [ids, ESTADOS_COMPROBANTE_ACEPTADO],
          ),
        );
    if (previos.length !== ids.length) {
      throw new FiscalConfigError(
        'FISCAL_ENVIO_EN_CURSO',
        adicion
          ? 'Alguna boleta ya está en otro resumen, ya la aceptó SUNAT o se anuló: actualice la pantalla y vuelva a intentarlo.'
          : 'El comprobante ya tiene una baja en curso, ya está anulado o dejó de estar aceptado: actualice la pantalla y revíselo.',
      );
    }
    const estadoPrevio = new Map(previos.map((p) => [Number(p.id_comprobante), String(p.previo)]));

    const parametros: unknown[] = [idEnvio];
    const valores = r.lineas.map((linea, indice) => {
      const base = parametros.length;
      parametros.push(linea.id_comprobante, indice + 1, linea.condicion, estadoPrevio.get(linea.id_comprobante) ?? (adicion ? 'POR_RESUMIR' : 'ACEPTADO'));
      return `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    });
    await consultor.query(
      `INSERT INTO fiscal_resumen_lineas (id_envio, id_comprobante, linea, condicion, estado) VALUES ${valores.join(', ')}`,
      parametros,
    );
    return idEnvio;
  }

  /**
   * Resumen de adición: bloquea los comprobantes que sigan elegibles, los pasa a TICKET_PENDIENTE (en un resumen en
   * curso) y devuelve el estado que tenían. Su envío individual deja de reintentarse solo mientras dure el resumen.
   */
  private async apartarParaAdicion(
    consultor: ConsultorTx,
    idEnvio: number,
    identificador: string,
    ids: number[],
  ): Promise<Array<{ id_comprobante: number; previo: string }>> {
    const filas = filasDe<{ id_comprobante: number; previo: string; id_envio_individual: number | null }>(
      await consultor.query(
        `WITH previo AS (
           SELECT c.id_comprobante, c.estado_sunat, c.id_envio_ultimo
             FROM comprobantes c
            WHERE c.id_comprobante = ANY($1::int[]) AND c.estado_sunat = ANY($2::text[])
              AND COALESCE(c.anulado, FALSE) = FALSE AND COALESCE(c.aceptada_sunat, FALSE) = FALSE
            FOR UPDATE
         )
         UPDATE comprobantes c SET estado_sunat = 'TICKET_PENDIENTE', estado = 'pendiente'
           FROM previo p WHERE c.id_comprobante = p.id_comprobante
         RETURNING c.id_comprobante, p.estado_sunat AS previo, p.id_envio_ultimo AS id_envio_individual`,
        [ids, ESTADOS_ADICION],
      ),
    );
    const mensaje = `Incluida en el resumen diario ${identificador}: SUNAT lo está procesando.`;
    const individuales = filas.map((f) => Number(f.id_envio_individual)).filter((id) => Number.isSafeInteger(id) && id > 0);
    if (individuales.length) {
      await consultor.query(
        `UPDATE fiscal_envios e
            SET estado = 'TICKET_PENDIENTE', proximo_intento_en = NULL, bloqueado_hasta = NULL, ultimo_error = $2::text,
                respuesta_json = COALESCE(e.respuesta_json, '{}'::jsonb)
                  || jsonb_build_object(
                       'clasificacion', jsonb_build_object('estado', 'TICKET_PENDIENTE', 'accion', 'NINGUNA', 'mensajeUsuario', $2::text),
                       'resumen', jsonb_build_object('id_envio', $3::int, 'identificador', $4::text)),
                actualizado_en = NOW()
          WHERE e.id_envio = ANY($1::int[]) AND e.operacion = 'emitir' AND e.estado IN ('POR_RESUMIR', 'PENDIENTE_REENVIO', 'EXCEPCION')`,
        [individuales, mensaje, idEnvio, identificador],
      );
    }
    return filas.map((f) => ({ id_comprobante: Number(f.id_comprobante), previo: String(f.previo) }));
  }

  /**
   * Comprobantes elegibles para un resumen de adición de la fecha de emisión `fecha` (ver ELEGIBLE_ADICION), en orden de
   * serie y número. `ids` limita la búsqueda; `soloSinRechazo` deja fuera los que SUNAT ya rechazó en un resumen anterior.
   */
  async candidatosResumen(p: {
    ambiente: AmbienteFiscal;
    hoy: string;
    fecha: string;
    ids?: number[];
    soloSinRechazo?: boolean;
    limite: number;
  }): Promise<CandidatoResumen[]> {
    const filas = filasDe<Record<string, any>>(
      await this.bd.query(
        `SELECT c.id_comprobante, c.id_tipo, c.serie, c.numero, c.estado_sunat, c.id_envio_ultimo, c.fecha_de_emision::text AS fecha_de_emision
           FROM comprobantes c
          WHERE ${ELEGIBLE_ADICION}
            AND c.fecha_de_emision = $3::date
            AND ($4::int[] IS NULL OR c.id_comprobante = ANY($4::int[]))
            AND ($5::boolean = FALSE OR ${SIN_RESUMEN_RECHAZADO})
          ORDER BY c.serie, c.numero
          LIMIT $6`,
        [p.ambiente, p.hoy, p.fecha, p.ids?.length ? p.ids : null, p.soloSinRechazo === true, Math.max(1, Math.trunc(p.limite))],
      ),
    );
    return filas.map((f) => ({
      id_comprobante: Number(f.id_comprobante),
      id_tipo: Number(f.id_tipo),
      serie: String(f.serie ?? ''),
      numero: Number(f.numero),
      estado_sunat: String(f.estado_sunat ?? ''),
      id_envio_ultimo: Number(f.id_envio_ultimo),
      fecha_de_emision: String(f.fecha_de_emision ?? ''),
    }));
  }

  /**
   * Fechas de emisión con comprobantes esperando resumen (sin los que SUNAT ya rechazó): 'por_resumir' = las boletas
   * del modo resumen; 'atrasadas' = las que fallaron en el envío individual y ya pasaron los 5 días. Las más antiguas primero.
   */
  async fechasConResumenPendiente(p: { ambiente: AmbienteFiscal; hoy: string; grupo: 'por_resumir' | 'atrasadas'; limite: number }): Promise<FechaConResumenPendiente[]> {
    const grupo = p.grupo === 'por_resumir' ? `c.estado_sunat = 'POR_RESUMIR'` : `c.estado_sunat <> 'POR_RESUMIR'`;
    const filas = filasDe<{ fecha: string; cantidad: number }>(
      await this.bd.query(
        `SELECT c.fecha_de_emision::text AS fecha, COUNT(*)::int AS cantidad
           FROM comprobantes c
          WHERE ${ELEGIBLE_ADICION} AND ${grupo} AND ${SIN_RESUMEN_RECHAZADO}
          GROUP BY c.fecha_de_emision
          ORDER BY c.fecha_de_emision
          LIMIT $3`,
        [p.ambiente, p.hoy, Math.max(1, Math.trunc(p.limite))],
      ),
    );
    return filas.map((f) => ({ fecha: String(f.fecha), cantidad: Number(f.cantidad) }));
  }

  /**
   * Primer envío (después del COMMIT del registro): solo si sigue como se registró (intento 1, sin
   * respuesta). Si la tarea ya lo tomó porque el proceso tardó, aquí no se vuelve a enviar.
   */
  async reclamarPrimerEnvio(idEnvio: number): Promise<LoteRegistrado | null> {
    return this.reclamarCon(
      `UPDATE fiscal_envios e
          SET bloqueado_hasta = NOW() + $2::int * INTERVAL '1 second', fecha_envio = NOW(), actualizado_en = NOW()
        WHERE e.id_envio = $1 AND e.operacion IN ${OPERACIONES_LOTE} AND e.estado = 'ENVIANDO'
          AND e.intento = 1 AND e.fecha_respuesta IS NULL AND e.sunat_ticket IS NULL`,
      idEnvio,
    );
  }

  /** Reenvío: PENDIENTE_REENVIO, o ENVIANDO con el reclamo vencido (resultado incierto). Cuenta un intento. */
  async reclamarEnvio(idEnvio: number): Promise<LoteRegistrado | null> {
    return this.reclamarCon(
      `UPDATE fiscal_envios e
          SET estado = 'ENVIANDO', intento = e.intento + 1, proximo_intento_en = NULL,
              bloqueado_hasta = NOW() + $2::int * INTERVAL '1 second', fecha_envio = NOW(), actualizado_en = NOW()
        WHERE e.id_envio = $1 AND e.operacion IN ${OPERACIONES_LOTE} AND e.estado IN ('PENDIENTE_REENVIO', 'ENVIANDO')
          AND e.sunat_ticket IS NULL AND (e.bloqueado_hasta IS NULL OR e.bloqueado_hasta < NOW())`,
      idEnvio,
    );
  }

  /** Consulta del ticket: TICKET_PENDIENTE, o EXCEPCION por consultas agotadas o plazo de 7 días cumplido (consulta manual). No cambia el estado ni el intento. */
  async reclamarConsulta(idEnvio: number): Promise<LoteRegistrado | null> {
    return this.reclamarCon(
      `UPDATE fiscal_envios e
          SET bloqueado_hasta = NOW() + $2::int * INTERVAL '1 second', actualizado_en = NOW()
        WHERE e.id_envio = $1 AND e.operacion IN ${OPERACIONES_LOTE} AND e.sunat_ticket IS NOT NULL
          AND (e.estado = 'TICKET_PENDIENTE'
               OR (e.estado = 'EXCEPCION' AND e.respuesta_json #>> '{clasificacion,accion}' IN ('CONSULTAR_TICKET', 'LIBERAR')))
          AND (e.bloqueado_hasta IS NULL OR e.bloqueado_hasta < NOW())`,
      idEnvio,
    );
  }

  /** Lectura sin reclamar (para validar y para explicar por qué no se puede operar). */
  async leer(idEnvio: number): Promise<LoteRegistrado | null> {
    const filas = filasDe<Record<string, any>>(
      await this.bd.query(
        `SELECT ${COLUMNAS_LOTE} FROM fiscal_envios t WHERE t.id_envio = $1 AND t.operacion IN ${OPERACIONES_LOTE}`,
        [idEnvio],
      ),
    );
    if (!filas[0]) return null;
    return aLote(filas[0], (await this.lineasDe([idEnvio])).get(idEnvio) ?? []);
  }

  /**
   * El ticket que SUNAT dio al recibir el lote: queda TICKET_PENDIENTE y se consulta dentro de
   * `proximoIntentoMin`. Cuenta un intento (el primero fue el envío; cada consulta suma otro).
   */
  async guardarTicket(idEnvio: number, ticket: string, mensaje: string, proximoIntentoMin: number): Promise<boolean> {
    const json = { clasificacion: { estado: 'TICKET_PENDIENTE', accion: 'CONSULTAR_TICKET', mensajeUsuario: mensaje } };
    const filas = filasDe<{ id_envio: number }>(
      await this.bd.query(
        `UPDATE fiscal_envios e
            SET estado = 'TICKET_PENDIENTE', sunat_ticket = $2, intento = e.intento + 1,
                proximo_intento_en = NOW() + $4::int * INTERVAL '1 minute', bloqueado_hasta = NULL, ultimo_error = NULL,
                mensaje_sunat = $3::text, respuesta_json = COALESCE(e.respuesta_json, '{}'::jsonb) || $5::jsonb,
                actualizado_en = NOW()
          WHERE e.id_envio = $1 AND e.operacion IN ${OPERACIONES_LOTE} AND e.estado IN ('ENVIANDO', 'TICKET_PENDIENTE', 'EXCEPCION')
          RETURNING e.id_envio`,
        [idEnvio, ticket, mensaje, Math.max(0, Math.trunc(proximoIntentoMin)), JSON.stringify(json)],
      ),
    );
    return filas.length > 0;
  }

  /**
   * Guarda el resultado y sus efectos sobre los comprobantes, todo en una transacción (el que llama
   * reintenta si la BD falla, con la respuesta en memoria). Solo pisa estados abiertos: si otro proceso ya
   * lo dejó ACEPTADO o RECHAZADO devuelve null y no toca los comprobantes.
   */
  async completar(idEnvio: number, ambiente: AmbienteFiscal, nombreBase: string, cierre: CierreEnvio): Promise<LoteCerrado | null> {
    const aceptado = cierre.estado === 'ACEPTADO' || cierre.estado === 'ACEPTADO_OBS';
    const sunat = cierre.sunat;
    return this.transacciones.ejecutar(async (tx) => {
      const filas = filasDe<{ tipo_documento: string; operacion: string; identificador: string }>(
        await tx.query(
          `UPDATE fiscal_envios e
              SET estado = $3::varchar,
                  codigo_sunat = COALESCE($4::varchar, e.codigo_sunat),
                  mensaje_sunat = COALESCE($5::text, e.mensaje_sunat),
                  observaciones = COALESCE($6::text, e.observaciones),
                  tiempo_ms = COALESCE($7::int, e.tiempo_ms),
                  fecha_respuesta = CASE WHEN $4::varchar IS NULL THEN e.fecha_respuesta ELSE NOW() END,
                  respuesta_json = COALESCE(e.respuesta_json, '{}'::jsonb) || $8::jsonb,
                  ultimo_error = CASE WHEN $9::boolean THEN NULL ELSE $10::text END,
                  proximo_intento_en = CASE WHEN $11::int IS NULL THEN NULL ELSE NOW() + $11::int * INTERVAL '1 minute' END,
                  bloqueado_hasta = NULL, actualizado_en = NOW()
            WHERE e.id_envio = $1 AND e.ambiente = $2 AND e.operacion IN ${OPERACIONES_LOTE} AND e.estado = ANY($12::text[])
            RETURNING e.tipo_documento, e.operacion, e.identificador`,
          [
            idEnvio,
            ambiente,
            cierre.estado,
            sunat?.codigo ?? null,
            sunat?.descripcion ?? null,
            sunat ? JSON.stringify(sunat.observaciones) : null,
            sunat ? Math.round(sunat.tiempoMs) : null,
            JSON.stringify(cierre.json),
            aceptado,
            cierre.mensaje,
            cierre.proximoIntentoMin,
            ESTADOS_LOTE_ABIERTOS,
          ],
        ),
      );
      const fila = filas[0];
      if (!fila) return null;

      const cdr: ArchivoNuevo[] = [];
      if (cierre.cdr?.xml) {
        cdr.push({ tipo: 'cdr_xml', nombre: `R-${nombreBase}.xml`, mime: 'application/xml', contenido: Buffer.from(cierre.cdr.xml, 'utf8') });
      }
      if (cierre.cdr?.zip?.length) {
        cdr.push({ tipo: 'cdr_zip', nombre: `R-${nombreBase}.zip`, mime: 'application/zip', contenido: cierre.cdr.zip });
      }
      await this.envios.insertarArchivos(tx, idEnvio, null, ambiente, cdr);

      const adicion = await this.esAdicion(tx, idEnvio);
      const efecto = efectoDelCierre(cierre, adicion);
      if (efecto === 'anular') {
        await tx.query(`UPDATE fiscal_resumen_lineas SET estado = 'ACEPTADO' WHERE id_envio = $1`, [idEnvio]);
        await tx.query(
          `UPDATE comprobantes c
              SET estado_sunat = 'ANULADO', sunat_description = LEFT('Dado de baja en SUNAT: ' || $2::text, 250)
            WHERE c.estado_sunat = 'BAJA_PENDIENTE'
              AND c.id_comprobante IN (SELECT l.id_comprobante FROM fiscal_resumen_lineas l WHERE l.id_envio = $1)`,
          [idEnvio, fila.identificador],
        );
      } else if (efecto === 'informar') {
        await this.aceptarAdicion(tx, idEnvio, ambiente, String(fila.identificador), cierre, cdr);
      } else if (efecto === 'restaurar') {
        if (adicion) {
          await this.restaurarAdicion(tx, idEnvio, String(fila.identificador), cierre.mensaje);
        } else {
          // Primero se devuelve el estado que guardó cada línea y recién después se marca la línea como rechazada.
          await tx.query(
            `UPDATE comprobantes c SET estado_sunat = l.estado
               FROM fiscal_resumen_lineas l
              WHERE l.id_envio = $1 AND l.id_comprobante = c.id_comprobante
                AND c.estado_sunat = 'BAJA_PENDIENTE' AND l.estado = ANY($2::text[])`,
            [idEnvio, ESTADOS_COMPROBANTE_ACEPTADO],
          );
        }
        await tx.query(`UPDATE fiscal_resumen_lineas SET estado = 'RECHAZADO' WHERE id_envio = $1`, [idEnvio]);
      }

      const ids = filasDe<{ id_comprobante: number }>(
        await tx.query(`SELECT l.id_comprobante FROM fiscal_resumen_lineas l WHERE l.id_envio = $1 ORDER BY l.linea`, [idEnvio]),
      ).map((l) => Number(l.id_comprobante));
      return {
        id_comprobante: ids[0] ?? null,
        ids_comprobantes: ids,
        tipo_documento: String(fila.tipo_documento),
        operacion: operacionDe(fila.operacion),
        identificador: String(fila.identificador),
      };
    });
  }

  /**
   * «Liberar» (S4): SUNAT no resolvió el ticket de un lote y el administrador decide soltarlo. El lote queda
   * EXCEPCION/LIBERADO, cada comprobante vuelve al estado que guardó su línea (para poder pedir la baja de
   * nuevo con otro identificador) y la línea se marca RECHAZADA. Todo en UNA transacción junto con la
   * auditoría (`auditar` recibe el ejecutor de esa transacción). null si el lote ya no estaba en
   * EXCEPCION con el ticket sin resolver o alguien lo está consultando ahora mismo.
   */
  async liberar(
    idEnvio: number,
    mensaje: string,
    json: Record<string, unknown>,
    auditar: (tx: ConsultorTx, liberado: LoteLiberado) => Promise<void>,
  ): Promise<LoteLiberado | null> {
    return this.transacciones.ejecutar(async (tx) => {
      const filas = filasDe<{ tipo_documento: string; operacion: string; identificador: string }>(
        await tx.query(
          `UPDATE fiscal_envios e
              SET estado = 'EXCEPCION', respuesta_json = COALESCE(e.respuesta_json, '{}'::jsonb) || $2::jsonb,
                  ultimo_error = $3::text, proximo_intento_en = NULL, bloqueado_hasta = NULL, actualizado_en = NOW()
            WHERE e.id_envio = $1 AND e.operacion IN ${OPERACIONES_LOTE} AND e.estado = 'EXCEPCION'
              AND e.respuesta_json #>> '{clasificacion,accion}' IN ('CONSULTAR_TICKET', 'LIBERAR')
              AND (e.bloqueado_hasta IS NULL OR e.bloqueado_hasta < NOW())
            RETURNING e.tipo_documento, e.operacion, e.identificador`,
          [idEnvio, JSON.stringify(json), mensaje],
        ),
      );
      const fila = filas[0];
      if (!fila) return null;
      // Primero se devuelve el estado que guardó cada línea y recién después se marca la línea como rechazada.
      const restaurados = (await this.esAdicion(tx, idEnvio))
        ? await this.restaurarAdicion(tx, idEnvio, String(fila.identificador), mensaje)
        : filasDe<{ id_comprobante: number }>(
            await tx.query(
              `UPDATE comprobantes c SET estado_sunat = l.estado
                 FROM fiscal_resumen_lineas l
                WHERE l.id_envio = $1 AND l.id_comprobante = c.id_comprobante
                  AND c.estado_sunat = 'BAJA_PENDIENTE' AND l.estado = ANY($2::text[])
                RETURNING c.id_comprobante`,
              [idEnvio, ESTADOS_COMPROBANTE_ACEPTADO],
            ),
          );
      await tx.query(`UPDATE fiscal_resumen_lineas SET estado = 'RECHAZADO' WHERE id_envio = $1`, [idEnvio]);
      const liberado: LoteLiberado = {
        identificador: String(fila.identificador),
        tipo_documento: String(fila.tipo_documento),
        operacion: operacionDe(fila.operacion),
        ids_comprobantes: restaurados.map((r) => Number(r.id_comprobante)),
      };
      await auditar(tx, liberado);
      return liberado;
    });
  }

  /**
   * Candidatos de la tarea del ambiente vigente: pendientes de reenvío y de consulta cuyo turno llegó, y
   * lotes ENVIANDO con el reclamo vencido (el proceso cayó tras el COMMIT). Cada uno se reclama después
   * por separado con su propio UPDATE.
   */
  async candidatosTarea(ambiente: AmbienteFiscal, limite: number): Promise<number[]> {
    const filas = filasDe<{ id_envio: number }>(
      await this.bd.query(
        `SELECT t.id_envio
           FROM fiscal_envios t
          WHERE t.ambiente = $1 AND t.proveedor = 'sunat_directo' AND t.operacion IN ${OPERACIONES_LOTE}
            AND ((t.estado IN ('PENDIENTE_REENVIO', 'TICKET_PENDIENTE')
                  AND (t.proximo_intento_en IS NULL OR t.proximo_intento_en <= NOW()))
                 OR t.estado = 'ENVIANDO')
            AND (t.bloqueado_hasta IS NULL OR t.bloqueado_hasta < NOW())
          ORDER BY COALESCE(t.proximo_intento_en, t.actualizado_en), t.id_envio
          LIMIT $2`,
        [ambiente, Math.max(1, Math.trunc(limite))],
      ),
    );
    return filas.map((f) => Number(f.id_envio));
  }

  async listar(filtro: FiltroLotes): Promise<{ datos: LoteVista[]; total: number; pagina: number; por_pagina: number }> {
    const pagina = Math.max(1, Math.trunc(Number(filtro.pagina) || 1));
    const porPagina = Math.min(MAXIMO_LOTES_POR_PAGINA, Math.max(1, Math.trunc(Number(filtro.por_pagina) || 20)));
    const condiciones = `t.proveedor = 'sunat_directo' AND t.operacion IN ${OPERACIONES_LOTE}
      AND ($1::text IS NULL OR t.ambiente = $1::text)
      AND ($2::text IS NULL OR t.operacion = $2::text)
      AND ($3::text IS NULL OR t.estado = $3::text)`;
    const parametros = [filtro.ambiente ?? null, filtro.operacion ?? null, filtro.estado ?? null];
    const [filas, conteo] = await Promise.all([
      this.bd.query(
        `SELECT ${COLUMNAS_VISTA} FROM fiscal_envios t WHERE ${condiciones}
          ORDER BY t.id_envio DESC LIMIT $4 OFFSET $5`,
        [...parametros, porPagina, (pagina - 1) * porPagina],
      ),
      this.bd.query(`SELECT COUNT(*)::int AS total FROM fiscal_envios t WHERE ${condiciones}`, parametros),
    ]);
    const lotes = filasDe<Record<string, any>>(filas);
    const lineas = await this.lineasDe(lotes.map((f) => Number(f.id_envio)));
    return {
      datos: lotes.map((f) => aVista(f, lineas.get(Number(f.id_envio)) ?? [])),
      total: Number(filasDe<{ total: number }>(conteo)[0]?.total ?? 0),
      pagina,
      por_pagina: porPagina,
    };
  }

  async obtener(idEnvio: number): Promise<LoteVista | null> {
    const filas = filasDe<Record<string, any>>(
      await this.bd.query(`SELECT ${COLUMNAS_VISTA} FROM fiscal_envios t WHERE t.id_envio = $1 AND t.operacion IN ${OPERACIONES_LOTE}`, [idEnvio]),
    );
    if (!filas[0]) return null;
    return aVista(filas[0], (await this.lineasDe([idEnvio])).get(idEnvio) ?? []);
  }

  /** Último lote de BAJA o anulación del comprobante cuya línea no fue rechazada (en curso o aceptado); los resúmenes de adición no cuentan. */
  async loteDeComprobante(idComprobante: number): Promise<LoteDeComprobante | null> {
    const filas = filasDe<Record<string, any>>(
      await this.bd.query(
        `SELECT e.id_envio, e.operacion, e.identificador, e.estado, e.sunat_ticket,
                COALESCE(e.ultimo_error, e.mensaje_sunat) AS mensaje
           FROM fiscal_resumen_lineas l
           JOIN fiscal_envios e ON e.id_envio = l.id_envio AND e.operacion IN ${OPERACIONES_LOTE}
          WHERE l.id_comprobante = $1 AND l.condicion = 3 AND COALESCE(l.estado, '') <> 'RECHAZADO'
          ORDER BY e.id_envio DESC LIMIT 1`,
        [idComprobante],
      ),
    );
    const f = filas[0];
    if (!f) return null;
    return {
      id_envio: Number(f.id_envio),
      operacion: operacionDe(f.operacion),
      identificador: String(f.identificador ?? ''),
      estado: String(f.estado ?? ''),
      sunat_ticket: f.sunat_ticket ?? null,
      mensaje: f.mensaje ?? null,
    };
  }

  /** Líneas de lotes ACEPTADOS cuyo comprobante sigue sin anular (efectos pendientes del barrido). */
  async lineasAceptadasSinAnular(limite: number): Promise<LineaAceptadaSinAnular[]> {
    const filas = filasDe<{ id_envio: number; id_comprobante: number }>(
      await this.bd.query(
        `SELECT l.id_envio, l.id_comprobante
           FROM fiscal_resumen_lineas l
           JOIN fiscal_envios e ON e.id_envio = l.id_envio AND e.operacion IN ${OPERACIONES_LOTE}
                               AND e.estado IN ('ACEPTADO', 'ACEPTADO_OBS')
           JOIN comprobantes c ON c.id_comprobante = l.id_comprobante
          WHERE l.estado = 'ACEPTADO' AND l.condicion = 3 AND COALESCE(c.anulado, FALSE) = FALSE
          ORDER BY l.id_envio, l.linea
          LIMIT $1`,
        [Math.max(1, Math.trunc(limite))],
      ),
    );
    return filas.map((f) => ({ id_envio: Number(f.id_envio), id_comprobante: Number(f.id_comprobante) }));
  }

  /** Artefacto del lote: lo resuelve el repositorio de envíos (no filtra por operación). */
  archivo(idEnvio: number, tipo: TipoArchivoEnvio): Promise<ArchivoEnvio | null> {
    return this.envios.archivo(idEnvio, tipo);
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  /** ¿El lote es un resumen diario de adición (todas sus líneas con la condición 1)? */
  private async esAdicion(consultor: ConsultorTx, idEnvio: number): Promise<boolean> {
    const filas = filasDe<{ adicion: boolean | null }>(
      await consultor.query(`SELECT BOOL_AND(l.condicion = 1) AS adicion FROM fiscal_resumen_lineas l WHERE l.id_envio = $1`, [idEnvio]),
    );
    return filas[0]?.adicion === true;
  }

  /**
   * SUNAT aceptó el resumen de adición: sus boletas quedan ACEPTADO (con el mensaje del resumen) y el envío individual de
   * cada una también. La constancia del resumen se copia al envío de cada boleta para que se pueda descargar desde ella.
   * El comprobante conserva su envío (id_envio_ultimo) para no perder su XML, su documento ni la posibilidad de anularlo.
   */
  private async aceptarAdicion(
    tx: ConsultorTx,
    idEnvio: number,
    ambiente: AmbienteFiscal,
    identificador: string,
    cierre: CierreEnvio,
    cdr: ArchivoNuevo[],
  ): Promise<void> {
    await tx.query(`UPDATE fiscal_resumen_lineas SET estado = 'ACEPTADO' WHERE id_envio = $1`, [idEnvio]);
    const mensaje = `Informada en el resumen diario ${identificador}: ${cierre.mensaje}`;
    const filas = filasDe<{ id_comprobante: number; id_envio_individual: number | null }>(
      await tx.query(
        `UPDATE comprobantes c
            SET estado = 'emitido', estado_sunat = $2::varchar, aceptada_sunat = TRUE,
                sunat_description = LEFT($3::text, 250), sunat_responsecode = COALESCE($4::text, c.sunat_responsecode),
                emitido_en = COALESCE(c.emitido_en, NOW()), error_mensaje = NULL, sunat_soap_error = NULL
          WHERE c.estado_sunat = 'TICKET_PENDIENTE'
            AND c.id_comprobante IN (SELECT l.id_comprobante FROM fiscal_resumen_lineas l WHERE l.id_envio = $1)
          RETURNING c.id_comprobante, c.id_envio_ultimo AS id_envio_individual`,
        [idEnvio, cierre.estado, mensaje, cierre.sunat?.codigo ?? null],
      ),
    );
    const individuales = filas.map((f) => ({ idComprobante: Number(f.id_comprobante), idEnvio: Number(f.id_envio_individual) }))
      .filter((f) => Number.isSafeInteger(f.idEnvio) && f.idEnvio > 0);
    if (!individuales.length) return;
    await tx.query(
      `UPDATE fiscal_envios e
          SET estado = $2::varchar, fecha_respuesta = NOW(), ultimo_error = NULL, mensaje_sunat = LEFT($3::text, 1000),
              codigo_sunat = COALESCE($4::varchar, e.codigo_sunat), proximo_intento_en = NULL, bloqueado_hasta = NULL,
              respuesta_json = COALESCE(e.respuesta_json, '{}'::jsonb)
                || jsonb_build_object(
                     'clasificacion', jsonb_build_object('estado', $2::text, 'accion', 'NINGUNA', 'mensajeUsuario', $3::text),
                     'resumen', jsonb_build_object('id_envio', $5::int, 'identificador', $6::text)),
              actualizado_en = NOW()
        WHERE e.id_envio = ANY($1::int[]) AND e.operacion = 'emitir' AND e.estado = 'TICKET_PENDIENTE'`,
      [individuales.map((f) => f.idEnvio), cierre.estado, mensaje, cierre.sunat?.codigo ?? null, idEnvio, identificador],
    );
    if (cdr.length) {
      for (const f of individuales) {
        const propios = filasDe<{ n: number }>(
          await tx.query(`SELECT COUNT(*)::int AS n FROM fiscal_artifacts a WHERE a.id_envio = $1 AND a.tipo_artifacto IN ('cdr_xml', 'cdr_zip')`, [f.idEnvio]),
        );
        if (Number(propios[0]?.n ?? 0) === 0) await this.envios.insertarArchivos(tx, f.idEnvio, f.idComprobante, ambiente, cdr);
      }
    }
  }

  /**
   * El resumen de adición no tuvo efecto (rechazado, descartado o liberado): las boletas vuelven al estado que tenían y su
   * envío individual también, con el motivo. Devuelve los comprobantes restaurados.
   */
  private async restaurarAdicion(tx: ConsultorTx, idEnvio: number, identificador: string, mensaje: string): Promise<Array<{ id_comprobante: number }>> {
    const motivo = `El resumen diario ${identificador} no se aceptó: ${mensaje}`;
    const restaurados = filasDe<{ id_comprobante: number; id_envio_individual: number | null; estado_sunat: string }>(
      await tx.query(
        `UPDATE comprobantes c
            SET estado_sunat = l.estado, estado = CASE WHEN l.estado = 'EXCEPCION' THEN 'error' ELSE 'pendiente' END,
                sunat_description = LEFT($3::text, 250)
           FROM fiscal_resumen_lineas l
          WHERE l.id_envio = $1 AND l.id_comprobante = c.id_comprobante
            AND c.estado_sunat = 'TICKET_PENDIENTE' AND l.estado = ANY($2::text[])
          RETURNING c.id_comprobante, c.id_envio_ultimo AS id_envio_individual, c.estado_sunat`,
        [idEnvio, ESTADOS_ADICION, motivo],
      ),
    );
    const individuales = restaurados.filter((r) => r.id_envio_individual !== null && Number(r.id_envio_individual) > 0);
    if (individuales.length) {
      await tx.query(
        `UPDATE fiscal_envios e
            SET estado = c.estado_sunat, ultimo_error = LEFT($3::text, 1000), proximo_intento_en = NULL, bloqueado_hasta = NULL,
                respuesta_json = COALESCE(e.respuesta_json, '{}'::jsonb)
                  || jsonb_build_object(
                       'clasificacion', jsonb_build_object(
                         'estado', c.estado_sunat,
                         'accion', CASE WHEN c.estado_sunat IN ('POR_RESUMIR', 'EXCEPCION') THEN 'RESUMIR'
                                        WHEN c.estado_sunat = 'PENDIENTE_REENVIO' THEN 'REINTENTAR' ELSE 'NINGUNA' END,
                         'mensajeUsuario', $3::text)),
                actualizado_en = NOW()
           FROM comprobantes c
          WHERE c.id_envio_ultimo = e.id_envio AND e.id_envio = ANY($1::int[]) AND e.operacion = 'emitir'
            AND e.estado = 'TICKET_PENDIENTE' AND c.id_comprobante = ANY($2::int[])`,
        [individuales.map((r) => Number(r.id_envio_individual)), individuales.map((r) => Number(r.id_comprobante)), motivo],
      );
    }
    return restaurados.map((r) => ({ id_comprobante: Number(r.id_comprobante) }));
  }

  /** Ejecuta el UPDATE de reclamo ($1 = id, $2 = segundos de reclamo) y devuelve el lote tomado con su ZIP. */
  private async reclamarCon(update: string, idEnvio: number): Promise<LoteRegistrado | null> {
    const filas = filasDe<Record<string, any>>(
      await this.bd.query(
        `WITH tomado AS (${update} RETURNING e.*)
         SELECT ${COLUMNAS_LOTE}, ${COLUMNA_ZIP} FROM tomado t`,
        [idEnvio, SEGUNDOS_RECLAMO],
      ),
    );
    if (!filas[0]) return null;
    return aLote(filas[0], (await this.lineasDe([idEnvio])).get(idEnvio) ?? []);
  }

  private async lineasDe(idsEnvio: number[]): Promise<Map<number, LineaLoteVista[]>> {
    const mapa = new Map<number, LineaLoteVista[]>();
    if (!idsEnvio.length) return mapa;
    const filas = filasDe<Record<string, any>>(
      await this.bd.query(
        `SELECT l.id_envio, l.id_comprobante, l.linea, l.condicion, l.estado, c.serie, c.numero, c.id_tipo
           FROM fiscal_resumen_lineas l LEFT JOIN comprobantes c ON c.id_comprobante = l.id_comprobante
          WHERE l.id_envio = ANY($1::int[]) ORDER BY l.id_envio, l.linea`,
        [idsEnvio],
      ),
    );
    for (const fila of filas) {
      const id = Number(fila.id_envio);
      const lista = mapa.get(id) ?? [];
      lista.push(aLinea(fila));
      mapa.set(id, lista);
    }
    return mapa;
  }
}
