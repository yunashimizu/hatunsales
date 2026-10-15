import type { Server } from 'node:http';
import { booleanoEntorno, numeroEntorno } from '../../config/runtime.config';

/** Opciones del servidor HTTP leídas del entorno (todas opcionales). */
export interface ConfigServidorHttp {
  /** Valor de `trust proxy` de Express: saltos de proxy (1 = el edge de Railway) o lista de redes. */
  readonly confiarEnProxy: number | boolean | string;
  /** Mayor que el tiempo ocioso del proxy de Railway para evitar 502 intermitentes. */
  readonly keepAliveMs: number;
  /** Límite del cuerpo JSON / urlencoded (no afecta a las subidas multipart, que limita multer). */
  readonly limiteCuerpo: string;
  readonly umbralPeticionLentaMs: number;
  readonly swagger: boolean;
}

/** TRUST_PROXY: número de saltos, true/false, o lista de redes de Express (p. ej. "loopback, uniquelocal"). */
export function confiarEnProxyDesdeEntorno(valor: string | undefined): number | boolean | string {
  const texto = (valor ?? '').trim();
  if (!texto) return 1;
  if (/^\d+$/.test(texto)) return Number(texto);
  if (/^(true|false)$/i.test(texto)) return texto.toLowerCase() === 'true';
  return texto;
}

const LIMITE_CUERPO = /^\d+(\.\d+)?\s*(b|kb|mb)$/i;

export function configServidorDesdeEntorno(produccion: boolean): ConfigServidorHttp {
  const limite = (process.env.LIMITE_CUERPO ?? '').trim();
  return {
    confiarEnProxy: confiarEnProxyDesdeEntorno(process.env.TRUST_PROXY),
    // Tope de 120 s: headersTimeout (keepAlive + 1 s) debe quedar bajo requestTimeout (300 s en Node).
    keepAliveMs: numeroEntorno('HTTP_KEEPALIVE_MS', 65_000, { min: 5_000, max: 120_000 }),
    limiteCuerpo: LIMITE_CUERPO.test(limite) ? limite.toLowerCase() : '1mb',
    umbralPeticionLentaMs: numeroEntorno('LOG_PETICIONES_LENTAS_MS', 1_500, { min: 100, max: 600_000 }),
    swagger: booleanoEntorno('SWAGGER_ENABLED', !produccion),
  };
}

/**
 * keepAliveTimeout por encima del ocioso del proxy (si Node cierra primero, el
 * proxy reusa un socket muerto y responde 502) y headersTimeout un poco mayor,
 * como exige Node.
 */
export function configurarTiemposServidor(servidor: Pick<Server, 'keepAliveTimeout' | 'headersTimeout'>, keepAliveMs: number): void {
  servidor.keepAliveTimeout = keepAliveMs;
  servidor.headersTimeout = keepAliveMs + 1_000;
}
