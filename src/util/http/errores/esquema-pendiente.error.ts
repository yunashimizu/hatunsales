import { ErrorDominio } from './error-dominio';

/**
 * Falta un script SQL en la base de datos: la función se degrada con un 503 y
 * un mensaje claro en vez de crear tablas en caliente (cero DDL en ejecución).
 */
export class EsquemaPendienteError extends ErrorDominio {
  readonly codigo = 'ESQUEMA_PENDIENTE';
  readonly estadoHttp = 503;

  constructor(script: string, motivo?: string) {
    super(`Falta ejecutar ${script} en Railway${motivo ? ` (${motivo})` : ''}.`, { script });
  }
}
