import type { AmbienteFiscal } from '../config/fiscal-config.tipos';
import type {
  AccionSunat,
  DocumentoCpe,
  EstadoSunat,
  ObservacionSunat,
} from '../nucleo/documento-fiscal.types';
import type { SeriesEmision } from './emision.contrato';

/**
 * Tipos y constantes internos de la emisión directa (el contrato público está en emision.contrato.ts).
 */

/** Series de las pruebas en SUNAT BETA: nunca chocan con las reales (uq_comprobantes_serie_numero es global). */
export const SERIES_BETA: Readonly<SeriesEmision> = Object.freeze({
  factura: 'FB01',
  boleta: 'BB01',
  nc_factura: 'FBC1',
  nc_boleta: 'BBC1',
  nd_factura: 'FBD1',
  nd_boleta: 'BBD1',
});

export const AVISO_BETA = 'Prueba SUNAT BETA: sin validez tributaria';

export const NOMBRE_AMBIENTE: Readonly<Record<AmbienteFiscal, string>> = { beta: 'SUNAT BETA', produccion: 'PRODUCCIÓN' };

/** Comprobantes que maneja esta emisión (la guía de remisión va por su propio módulo). */
export const TIPOS_CPE_EMISION = ['01', '03', '07', '08'] as const;

export const ESTADOS_SUNAT: readonly EstadoSunat[] = [
  'NO_ENVIADO',
  'POR_RESUMIR',
  'ENVIANDO',
  'PENDIENTE_REENVIO',
  'TICKET_PENDIENTE',
  'ACEPTADO',
  'ACEPTADO_OBS',
  'RECHAZADO',
  'EXCEPCION',
  'ERROR_CONFIG',
  'BAJA_PENDIENTE',
  'ANULADO',
];

/** Envíos que todavía pueden cambiar con una respuesta o consulta de SUNAT (un aceptado o rechazado ya no). */
export const ESTADOS_ENVIO_ABIERTOS: readonly EstadoSunat[] = ['ENVIANDO', 'PENDIENTE_REENVIO', 'EXCEPCION'];

/** Reclamo de un envío mientras se habla con SUNAT: cubre el timeout (15 o 30 s) y el guardado de la respuesta. */
export const SEGUNDOS_RECLAMO = 60;

/** Espera hasta el siguiente reintento automático según los intentos ya hechos (D7): 2, 5, 15, 30 y 60 minutos. */
export const ESPERA_REINTENTO_MINUTOS: readonly number[] = [2, 5, 15, 30, 60];

/** Tras estos intentos sin una respuesta válida el envío queda en EXCEPCION para revisarlo a mano. */
export const MAXIMO_INTENTOS_AUTOMATICOS = 6;

/** Respuestas que dicen que SUNAT ya tenía el número con OTROS datos: su CDR no se acepta solo (D4). */
export const CODIGOS_REGISTRADO_CON_OTROS_DATOS: ReadonlySet<string> = new Set(['1033', '2109']);

/** Quién cerró el envío (EventoEnvioCompletado.origen). */
export type OrigenEnvio = 'envio' | 'reintento' | 'recuperacion' | 'tarea' | 'manual';

/** Lo que fiscal_envios.respuesta_json guarda al registrar (sin secretos): basta para reenviar o reimprimir. */
export interface DatosRegistroEnvio {
  documento: DocumentoCpe;
  digest: string;
  cadena_qr: string;
  advertencias?: string[];
}

/** Un envío de comprobante leído (o reclamado) de fiscal_envios. */
export interface EnvioRegistrado {
  id_envio: number;
  ambiente: AmbienteFiscal;
  tipo_documento: string;
  estado: string;
  /** Solo al reclamar un reintento: el estado que tenía antes (ENVIANDO = resultado incierto). */
  estado_anterior: string | null;
  intento: number;
  nombre_archivo: string;
  /** RUC-TT-SERIE-NNNNNNNN (nombre del XML y del ZIP sin extensión). */
  nombre_base: string;
  id_comprobante: number | null;
  codigo_sunat: string | null;
  accion: string | null;
  /** Sin reclamo vigente (bloqueado_hasta vacío o vencido). */
  libre: boolean;
  /** yyyy-mm-dd: del comprobante o, si no lo tiene, calculada del documento. */
  fecha_limite_envio: string | null;
  datos: DatosRegistroEnvio | null;
  /** Alguna respuesta fue 1033/2109: el número ya estaba en SUNAT con otros datos. */
  registrado_con_otros_datos: boolean;
  zip: Buffer | null;
}

/** Cómo queda un envío tras una respuesta (o falta de ella) de SUNAT. */
export interface CierreEnvio {
  estado: EstadoSunat;
  accion: AccionSunat;
  /** Texto para el usuario: queda en ultimo_error (si no se aceptó) y en el comprobante. */
  mensaje: string;
  /** Respuesta que decide el estado; null conserva el código y el texto anteriores (consulta sin resultado). */
  sunat: { codigo: string; descripcion: string; observaciones: ObservacionSunat[]; tiempoMs: number } | null;
  /** Se fusiona en respuesta_json (respuesta, clasificacion, verificacion_cdr, consulta…). */
  json: Record<string, unknown>;
  cdr?: { xml?: string; zip?: Buffer } | null;
  /** Minutos hasta el próximo reintento automático; null = no se reintenta solo. */
  proximoIntentoMin: number | null;
}

/** Lo que devuelve el guardado del cierre (null si otro proceso ya había cerrado el envío). */
export interface EnvioCerrado {
  id_comprobante: number | null;
  tipo_documento: string;
  /** Archivos que el envío tenía guardados antes de este cierre. */
  archivos: string[];
}
