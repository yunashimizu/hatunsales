/** Entorno de producción (Railway o NODE_ENV=production). */
export function esProduccion(): boolean {
  return (
    (process.env.NODE_ENV ?? '').toLowerCase() === 'production' ||
    !!process.env.RAILWAY_ENVIRONMENT ||
    !!process.env.RAILWAY_ENVIRONMENT_NAME
  );
}

export interface LimitesNumericos {
  readonly min?: number;
  readonly max?: number;
}

/**
 * Número de una variable de entorno. Si falta o no es un número finito devuelve
 * `porDefecto`; si se sale de [min, max] lo ajusta al límite más cercano.
 */
export function numeroEntorno(nombre: string, porDefecto: number, limites: LimitesNumericos = {}): number {
  const crudo = process.env[nombre]?.trim();
  if (!crudo) return porDefecto;
  const valor = Number(crudo);
  if (!Number.isFinite(valor)) return porDefecto;
  const min = limites.min ?? Number.NEGATIVE_INFINITY;
  const max = limites.max ?? Number.POSITIVE_INFINITY;
  return Math.min(max, Math.max(min, valor));
}

const VERDADEROS = new Set(['1', 'true', 'si', 'sí', 'yes', 'on']);
const FALSOS = new Set(['0', 'false', 'no', 'off']);

/** Booleano de una variable de entorno (true/false, 1/0, si/no, on/off). */
export function booleanoEntorno(nombre: string, porDefecto: boolean): boolean {
  const crudo = process.env[nombre]?.trim().toLowerCase();
  if (!crudo) return porDefecto;
  if (VERDADEROS.has(crudo)) return true;
  if (FALSOS.has(crudo)) return false;
  return porDefecto;
}

/** Commit desplegado (7 caracteres) o 'local' fuera de Railway. */
export function versionDespliegue(): string {
  const sha = (process.env.RAILWAY_GIT_COMMIT_SHA ?? '').trim();
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7).toLowerCase() : 'local';
}
