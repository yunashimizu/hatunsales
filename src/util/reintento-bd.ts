import { Logger } from '@nestjs/common';
import { sqlStateDeError } from './http/errores/traductor-errores-bd';

/** Interbloqueo (40P01) y fallo de serialización (40001): PostgreSQL ya revirtió todo y repetir es seguro. */
const SQLSTATE_REINTENTABLES = new Set(['40P01', '40001']);

const log = new Logger('ReintentoBd');

export interface OpcionesReintentoBd {
  /** Intentos en total, contando el primero. */
  intentos?: number;
  /** Base de la espera entre intentos, en milisegundos. */
  esperaBaseMs?: number;
  /** Nombre de la operación para el registro. */
  operacion?: string;
}

const dormir = (ms: number) => new Promise<void>((resolver) => setTimeout(resolver, ms));

/**
 * Ejecuta `fn` (una transacción completa) y, si la base la abortó por interbloqueo o por
 * serialización, la repite: la otra transacción ya terminó o va a terminar, y la segunda vuelta
 * casi siempre pasa. Solo para transacciones que se abren DENTRO de `fn`: repetir una sentencia
 * suelta dentro de una transacción abortada no sirve. Espera `esperaBaseMs × intento` más un azar
 * de hasta `esperaBaseMs` para que las dos no vuelvan a chocar al mismo tiempo. Cualquier otro
 * error, o el último conflicto, se relanza tal cual.
 */
export async function reintentarSiHuboConflicto<T>(
  fn: () => Promise<T>,
  { intentos = 3, esperaBaseMs = 40, operacion = 'transacción' }: OpcionesReintentoBd = {},
): Promise<T> {
  const total = Math.max(1, Math.trunc(intentos) || 1);
  for (let intento = 1; ; intento++) {
    try {
      return await fn();
    } catch (error) {
      const sqlState = sqlStateDeError(error);
      if (!sqlState || !SQLSTATE_REINTENTABLES.has(sqlState) || intento >= total) throw error;
      const espera = esperaBaseMs * intento + Math.floor(Math.random() * esperaBaseMs);
      log.warn(`${operacion}: conflicto con otra operación (SQLSTATE ${sqlState}); intento ${intento + 1} de ${total} en ${espera} ms`);
      await dormir(espera);
    }
  }
}
