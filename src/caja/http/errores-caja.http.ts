import { BadRequestException, HttpException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { FechaLimaInvalidaError } from '../../util/fecha-lima';
import { DineroInvalidoError } from '../dominio/dinero';
import { CodigoErrorCaja, cuerpoErrorCaja, ErrorCaja, mensajeScriptPendiente } from '../dominio/errores-caja';

const log = new Logger('ErroresCaja');

/** Códigos de PostgreSQL que significan "reintente": deadlock, serialización, candado, timeout. */
const PG_REINTENTAR = new Set(['40P01', '40001', '55P03', '57014']);
/** Tabla o columna inexistente: falta correr un script. */
const PG_ESQUEMA = new Set(['42P01', '42703']);

export function codigoPg(error: unknown): string {
  const e = error as { code?: unknown; driverError?: { code?: unknown } } | null;
  return String(e?.code ?? e?.driverError?.code ?? '');
}

/**
 * Traduce errores de dominio (y algunos de PostgreSQL) a HttpException con cuerpo
 * { message, codigo }. Devuelve null si no sabe traducirlo (el llamador decide).
 */
export function aHttpException(error: unknown): HttpException | null {
  if (error instanceof HttpException) return error;
  if (error instanceof ErrorCaja) {
    return new HttpException(cuerpoErrorCaja(error.codigo, error.message), error.estadoHttp);
  }
  if (error instanceof FechaLimaInvalidaError) {
    return new BadRequestException(cuerpoErrorCaja(CodigoErrorCaja.FECHA_INVALIDA, error.message));
  }
  if (error instanceof DineroInvalidoError) {
    return new BadRequestException(cuerpoErrorCaja(CodigoErrorCaja.ARQUEO_DATO_INVALIDO, error.message));
  }
  const codigo = codigoPg(error);
  if (PG_REINTENTAR.has(codigo)) {
    log.warn(`Operación de caja a reintentar (${codigo}): ${(error as Error)?.message ?? error}`);
    return new ServiceUnavailableException(
      cuerpoErrorCaja(CodigoErrorCaja.CAJA_REINTENTAR, 'La base de datos está ocupada. Intente de nuevo en unos segundos.'),
    );
  }
  if (PG_ESQUEMA.has(codigo)) {
    log.error(`Esquema incompleto (${codigo}): ${(error as Error)?.message ?? error}`);
    return new ServiceUnavailableException(
      cuerpoErrorCaja(CodigoErrorCaja.CAJA_ESQUEMA_PENDIENTE, `${mensajeScriptPendiente()}.`),
    );
  }
  return null;
}

/** Relanza el error ya traducido; si no es traducible, lo relanza tal cual (lo ve el filtro global). */
export function relanzarHttp(error: unknown): never {
  throw aHttpException(error) ?? error;
}
