import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/** Frontends oficiales: siempre permitidos en producción, aunque falten en CORS_ORIGIN. */
export const ORIGENES_OFICIALES: readonly string[] = [
  'https://hatunsales-sa.vercel.app',
  'https://www.hatunsales.pe',
  'https://hatunsales.pe',
];

/** Angular en desarrollo (`ng serve`). Fuera de producción siempre se permite. */
export const ORIGEN_DESARROLLO = 'http://localhost:4200';

/** Cabeceras que el JavaScript del front puede leer en respuestas de otro origen. */
export const CABECERAS_EXPUESTAS: readonly string[] = ['Retry-After', 'X-Request-Id', 'Content-Disposition'];

/** El navegador recuerda el preflight 24 h (Chrome lo limita a 2 h). */
export const CORS_MAX_AGE_SEG = 86_400;

/** `https://Sitio.com/` → `https://sitio.com` (sin barra final ni mayúsculas). */
export function normalizarOrigen(origen: string): string {
  return String(origen ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

export interface EntornoCors {
  /** Valor de CORS_ORIGIN: orígenes separados por coma. */
  readonly corsOrigin?: string;
  readonly produccion: boolean;
}

/** Orígenes de CORS_ORIGIN más los oficiales (producción) o localhost:4200 (desarrollo). */
export function origenesPermitidos(entorno: EntornoCors): string[] {
  const configurados = (entorno.corsOrigin ?? '').split(',').map(normalizarOrigen).filter(Boolean);
  const base = entorno.produccion ? ORIGENES_OFICIALES : [ORIGEN_DESARROLLO];
  return Array.from(new Set([...configurados, ...base.map(normalizarOrigen)]));
}

/**
 * Opciones de CORS con credenciales. Compara orígenes normalizados para que
 * una barra final o una mayúscula en CORS_ORIGIN no bloqueen al front. Las
 * peticiones sin cabecera Origin (curl, monitores, servidor a servidor) pasan
 * sin cabeceras CORS, como hasta ahora.
 */
export function opcionesCors(origenes: readonly string[]): CorsOptions {
  const permitidos = new Set(origenes.map(normalizarOrigen));
  return {
    origin: (origen, callback) => callback(null, !origen || permitidos.has(normalizarOrigen(origen))),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: [...CABECERAS_EXPUESTAS],
    maxAge: CORS_MAX_AGE_SEG,
    optionsSuccessStatus: 204,
  };
}
