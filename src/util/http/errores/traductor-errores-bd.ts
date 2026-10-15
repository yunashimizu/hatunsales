import { EntityNotFoundError, QueryFailedError } from 'typeorm';
import { mensajePgSeguro, sqlSeguro } from '../enmascarar';
import type { ErrorTraducido, TraductorError } from './error-traducido';
import { mensajePorEstado } from './estado-http';
import { type InfoErrorPg, reglaParaErrorPg } from './reglas-postgres';

/** Mensajes de pg / pg-pool / TypeORM cuando no hay conexión utilizable. */
const FALLA_DE_CONEXION =
  /timeout exceeded when trying to connect|connection terminated|connection timeout|client has encountered a connection error|cannot use a pool after calling end|terminating connection due to administrator command|the database system is (starting up|shutting down|in recovery mode|not yet accepting connections)/i;

const CODIGOS_DE_RED = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);

const SIN_CONEXION_TYPEORM = new Set(['CannotExecuteNotConnectedError', 'ConnectionIsNotSetError', 'ConnectionNotFoundError']);

const BD_NO_DISPONIBLE: Omit<ErrorTraducido, 'detalleLog'> = {
  estado: 503,
  codigo: 'BD_NO_DISPONIBLE',
  mensaje: 'La base de datos no está disponible en este momento. Intente de nuevo en unos segundos.',
  reintentarEnSeg: 5,
  registro: 'error',
};

interface ErrorPgCrudo {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly detail?: unknown;
  readonly table?: unknown;
  readonly column?: unknown;
  readonly constraint?: unknown;
  readonly severity?: unknown;
  readonly routine?: unknown;
}

const texto = (valor: unknown): string | undefined => (typeof valor === 'string' && valor ? valor : undefined);

/** SQLSTATE de PostgreSQL (y no un código de red de Node como EPIPE). */
function sqlStateDe(error: ErrorPgCrudo): string | undefined {
  const codigo = texto(error.code);
  if (!codigo || !/^[0-9A-Z]{5}$/.test(codigo)) return undefined;
  const pareceDePg = Boolean(error.severity) || Boolean(error.routine) || /^\d/.test(codigo) || /^(XX|HV|F0|P0)/.test(codigo);
  return pareceDePg ? codigo : undefined;
}

/** INSERT / UPDATE / DELETE / SELECT de la sentencia (también detrás de un WITH). */
export function sentenciaDe(sql: string | undefined): string | undefined {
  const limpio = String(sql ?? '').trim();
  const primera = /^([a-z]+)/i.exec(limpio)?.[1]?.toUpperCase();
  if (primera !== 'WITH') return primera;
  return /\)\s*(INSERT|UPDATE|DELETE|SELECT)\b/i.exec(limpio)?.[1]?.toUpperCase();
}

function esFallaDeConexion(error: ErrorPgCrudo): boolean {
  const codigo = texto(error.code);
  return (codigo !== undefined && CODIGOS_DE_RED.has(codigo)) || FALLA_DE_CONEXION.test(String(error.message ?? ''));
}

function desdeSqlState(codigo: string, error: ErrorPgCrudo, sql: string | undefined): ErrorTraducido {
  const info: InfoErrorPg = {
    codigo,
    mensaje: String(error.message ?? ''),
    detalle: texto(error.detail),
    tabla: texto(error.table),
    columna: texto(error.column),
    restriccion: texto(error.constraint),
    sentencia: sentenciaDe(sql),
  };
  const donde = [info.tabla && `tabla ${info.tabla}`, info.restriccion && `restricción ${info.restriccion}`]
    .filter(Boolean)
    .join(', ');
  const detalleLog =
    `PostgreSQL ${codigo}${donde ? ` (${donde})` : ''}: ${mensajePgSeguro(info.mensaje)}`
    + (sql ? ` · SQL: ${sqlSeguro(sql)}` : '');

  const regla = reglaParaErrorPg(info);
  if (!regla) {
    return { estado: 500, codigo: 'ERROR_SERVIDOR', mensaje: mensajePorEstado(500), registro: 'error', detalleLog };
  }
  return {
    estado: regla.estado,
    codigo: regla.codigo,
    mensaje: regla.mensaje,
    extra: regla.extra,
    reintentarEnSeg: regla.reintentarEnSeg,
    registro: regla.estado >= 500 ? 'error' : 'advertencia',
    detalleLog,
  };
}

/**
 * Errores de base de datos (TypeORM / node-postgres): códigos SQLSTATE,
 * conexiones caídas o agotadas, entidades no encontradas.
 */
export class TraductorErroresBaseDatos implements TraductorError {
  traducir(error: unknown): ErrorTraducido | null {
    if (!error || typeof error !== 'object') return null;
    const nombre = String((error as { name?: unknown }).name ?? '');

    if (error instanceof QueryFailedError || nombre === 'QueryFailedError') {
      const fallida = error as QueryFailedError & { driverError?: ErrorPgCrudo };
      return this.desdeConsulta(fallida.driverError ?? (fallida as ErrorPgCrudo), texto(fallida.query));
    }
    if (error instanceof EntityNotFoundError || nombre === 'EntityNotFoundError') {
      return { estado: 404, codigo: 'NO_ENCONTRADO', mensaje: 'No se encontró el registro solicitado.', registro: 'ninguno' };
    }
    if (nombre === 'UpdateValuesMissingError') {
      return { estado: 400, codigo: 'SIN_CAMBIOS', mensaje: 'No se envió ningún dato para actualizar.', registro: 'ninguno' };
    }
    if (SIN_CONEXION_TYPEORM.has(nombre)) {
      return { ...BD_NO_DISPONIBLE, detalleLog: `${nombre}: la conexión 'pgConnection' no está lista` };
    }

    const crudo = error as ErrorPgCrudo;
    const sqlState = sqlStateDe(crudo);
    if (sqlState) return desdeSqlState(sqlState, crudo, undefined);
    if (FALLA_DE_CONEXION.test(String(crudo.message ?? ''))) {
      return { ...BD_NO_DISPONIBLE, detalleLog: mensajePgSeguro(String(crudo.message ?? '')) };
    }
    return null;
  }

  private desdeConsulta(driver: ErrorPgCrudo, sql: string | undefined): ErrorTraducido {
    const sqlState = sqlStateDe(driver);
    if (sqlState) return desdeSqlState(sqlState, driver, sql);

    const mensaje = String(driver.message ?? '');
    const detalleLog = `${mensajePgSeguro(mensaje)}${sql ? ` · SQL: ${sqlSeguro(sql)}` : ''}`;
    if (/query read timeout/i.test(mensaje)) {
      return {
        estado: 503,
        codigo: 'TIEMPO_AGOTADO',
        mensaje: 'La base de datos tardó demasiado en responder. Intente de nuevo en unos segundos.',
        reintentarEnSeg: 5,
        registro: 'error',
        detalleLog,
      };
    }
    if (esFallaDeConexion(driver)) return { ...BD_NO_DISPONIBLE, detalleLog };
    return { estado: 500, codigo: 'ERROR_SERVIDOR', mensaje: mensajePorEstado(500), registro: 'error', detalleLog };
  }
}
