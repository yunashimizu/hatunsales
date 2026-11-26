import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Permiso de autorización de una rebaja (Fase 6.4, R5).
 *
 * NO es un JWT, a propósito: la sesión es un JWT firmado con el secreto de JWT y `JwtStrategy` acepta
 * cualquier token con `sub` firmado así. Un permiso con el id del administrador firmado igual serviría
 * para entrar como administrador desde la caja. Por eso:
 *  - formato propio de dos partes: `base64url(datos) + '.' + base64url(HMAC-SHA256(base64url(datos), clave))`
 *    (un JWT tiene tres partes y `passport-jwt` lo rechaza como mal formado);
 *  - `clave = SHA-256(secreto de JWT + ':autorizacion-venta')`: ni siquiera con otro formato la firma
 *    de un permiso vale como firma de sesión, ni al revés;
 *  - los datos no llevan `sub`, `exp` ni nada que `JwtStrategy` reconozca;
 *  - la huella ata el permiso a las líneas exactas (producto, cantidad y precio final), al solicitante
 *    y a 5 minutos. La firma se compara en tiempo constante.
 */

export const VERSION_PERMISO = 1;
export const VIGENCIA_PERMISO_MS = 5 * 60_000;
const SUFIJO_CLAVE = ':autorizacion-venta';
/** Un permiso real mide ~250 caracteres; esto solo evita trabajar con basura enorme. */
const LARGO_MAXIMO = 1_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface DatosPermiso {
  /** Versión del formato. */
  v: number;
  /** id_usuario de quien vende (el que pidió la autorización). */
  sol: number;
  /** id_usuario del administrador que autorizó. */
  aut: number;
  /** Huella de las líneas (`huellaLineas`). */
  h: string;
  /** Vencimiento, en ms desde 1970. */
  vence: number;
  /** Aleatorio: dos permisos para el mismo carrito son distintos (uso único). */
  n: string;
}

export type MotivoPermisoInvalido =
  | 'ausente'
  | 'mal_formado'
  | 'firma'
  | 'version'
  | 'vencido'
  | 'otro_solicitante'
  | 'otras_lineas';

export type ResultadoPermiso =
  | { valido: true; datos: DatosPermiso; firma: string }
  | { valido: false; motivo: MotivoPermisoInvalido };

export interface LineaHuella {
  id_producto: number;
  cantidad: number;
  /** Precio unitario final (con IGV, después de descuentos). */
  precio_final: number;
}

/** Clave del HMAC, derivada del secreto de JWT (nunca el secreto tal cual). */
export function claveDePermiso(secretoJwt: string): Buffer {
  return createHash('sha256').update(`${String(secretoJwt ?? '')}${SUFIJO_CLAVE}`).digest();
}

/**
 * Huella de las líneas: producto, cantidad (4 decimales) y precio final en céntimos de cada una,
 * ordenadas (el orden del carrito no importa; cambiar una cantidad o un precio sí).
 */
export function huellaLineas(lineas: readonly LineaHuella[]): string {
  const filas = (lineas ?? [])
    .map((l) => `${Math.trunc(Number(l.id_producto) || 0)}|${(Number(l.cantidad) || 0).toFixed(4)}|${Math.round((Number(l.precio_final) || 0) * 100)}`)
    .sort();
  return createHash('sha256').update(filas.join('\n')).digest('base64url');
}

function firmar(parteDatos: string, clave: Buffer): Buffer {
  return createHmac('sha256', clave).update(parteDatos).digest();
}

export function crearDatosPermiso(
  solicitante: number,
  autorizador: number,
  huella: string,
  ahora: number,
): DatosPermiso {
  return {
    v: VERSION_PERMISO,
    sol: solicitante,
    aut: autorizador,
    h: huella,
    vence: ahora + VIGENCIA_PERMISO_MS,
    n: randomBytes(9).toString('base64url'),
  };
}

export function firmarPermiso(datos: DatosPermiso, clave: Buffer): string {
  const parteDatos = Buffer.from(JSON.stringify(datos), 'utf8').toString('base64url');
  return `${parteDatos}.${firmar(parteDatos, clave).toString('base64url')}`;
}

const enteroPositivo = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** Verifica firma, formato, vencimiento, solicitante y huella. Nunca lanza. */
export function verificarPermiso(
  permiso: unknown,
  esperado: { solicitante: number; huella: string; ahora: number },
  clave: Buffer,
): ResultadoPermiso {
  if (typeof permiso !== 'string' || !permiso.trim()) return { valido: false, motivo: 'ausente' };
  const texto = permiso.trim();
  if (texto.length > LARGO_MAXIMO) return { valido: false, motivo: 'mal_formado' };
  const partes = texto.split('.');
  if (partes.length !== 2 || !partes.every((p) => BASE64URL.test(p))) return { valido: false, motivo: 'mal_formado' };
  const [parteDatos, parteFirma] = partes;

  const esperada = firmar(parteDatos, clave);
  const recibida = Buffer.from(parteFirma, 'base64url');
  if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) {
    return { valido: false, motivo: 'firma' };
  }

  let datos: DatosPermiso;
  try {
    datos = JSON.parse(Buffer.from(parteDatos, 'base64url').toString('utf8'));
  } catch {
    return { valido: false, motivo: 'mal_formado' };
  }
  if (!datos || typeof datos !== 'object') return { valido: false, motivo: 'mal_formado' };
  if (datos.v !== VERSION_PERMISO) return { valido: false, motivo: 'version' };
  if (!enteroPositivo(datos.sol) || !enteroPositivo(datos.aut) || typeof datos.h !== 'string' || typeof datos.vence !== 'number') {
    return { valido: false, motivo: 'mal_formado' };
  }
  if (!(datos.vence > esperado.ahora)) return { valido: false, motivo: 'vencido' };
  if (datos.sol !== esperado.solicitante) return { valido: false, motivo: 'otro_solicitante' };
  const h1 = Buffer.from(datos.h);
  const h2 = Buffer.from(String(esperado.huella ?? ''));
  if (h1.length !== h2.length || !timingSafeEqual(h1, h2)) return { valido: false, motivo: 'otras_lineas' };
  return { valido: true, datos, firma: parteFirma };
}
