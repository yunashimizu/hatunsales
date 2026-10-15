import { HttpException } from '@nestjs/common';
import { rutaSegura } from '../enmascarar';
import { CODIGO_VALIDACION, traducirMensajeSuelto } from '../validacion/mensajes-validacion';
import { esObjetoPlano, sinCamposReservados } from './error-dominio';
import type { ErrorTraducido, TraductorError } from './error-traducido';
import { codigoPorEstado, esFraseInglesaDeNest, estadoDeError, mensajePorEstado } from './estado-http';

interface Traduccion {
  readonly mensaje: string;
  readonly codigo?: string;
}

/** Textos por defecto de Nest, Express y Multer (en inglés) → español. */
const TEXTOS_NEST: ReadonlyArray<readonly [RegExp, (m: RegExpMatchArray, estado: number) => Traduccion]> = [
  [
    /^cannot (get|post|put|patch|delete|head|options|search) (\S+)$/i,
    (m) => ({ mensaje: `No existe la ruta ${m[1].toUpperCase()} ${rutaSegura(m[2])} en el servidor.`, codigo: 'RUTA_NO_ENCONTRADA' }),
  ],
  [/^forbidden resource$/i, () => ({ mensaje: mensajePorEstado(403) })],
  [/^internal server error$/i, () => ({ mensaje: mensajePorEstado(500) })],
  [/^http exception$/i, (_m, estado) => ({ mensaje: mensajePorEstado(estado) })],
  [
    /^validation failed \(numeric string is expected\)$/i,
    () => ({ mensaje: 'El identificador debe ser un número entero.', codigo: 'ID_INVALIDO' }),
  ],
  [/^validation failed \(uuid.*is expected\)$/i, () => ({ mensaje: 'El identificador no es válido.', codigo: 'ID_INVALIDO' })],
  [/^validation failed(?: \(.+\))?$/i, () => ({ mensaje: 'Un parámetro de la solicitud no tiene el formato esperado.' })],
  [/^file too large$/i, () => ({ mensaje: 'El archivo supera el tamaño máximo permitido.', codigo: 'ARCHIVO_MUY_GRANDE' })],
  [/^too many files$/i, () => ({ mensaje: 'Se enviaron demasiados archivos a la vez.' })],
  [
    /^unexpected field$/i,
    () => ({ mensaje: 'El archivo se envió en un campo no esperado. Actualice la página e intente de nuevo.' }),
  ],
  [/^too many (parts|fields)$/i, () => ({ mensaje: 'El formulario tiene demasiados campos.' })],
  [/^field (name|value) too long$/i, () => ({ mensaje: 'Un campo del formulario es demasiado largo.' })],
  [
    /^(multipart: boundary not found|unexpected end of form|malformed part header)$/i,
    () => ({ mensaje: 'El formulario enviado está incompleto o mal formado.' }),
  ],
  [
    /(in JSON at position|JSON input|is not valid JSON|Bad control character|Expected property name|Unterminated string in JSON|Bad escaped character)/,
    () => ({ mensaje: 'El cuerpo de la solicitud no es un JSON válido.', codigo: 'JSON_INVALIDO' }),
  ],
  [/^(URI malformed|Failed to decode param)/i, () => ({ mensaje: 'La dirección contiene caracteres no válidos.' })],
  [/^ThrottlerException: Too Many Requests$/i, () => ({ mensaje: mensajePorEstado(429) })],
];

function traducirTexto(texto: string, estado: number): Traduccion {
  const limpio = texto.trim();
  if (!limpio || esFraseInglesaDeNest(limpio)) return { mensaje: mensajePorEstado(estado) };
  for (const [patron, traducir] of TEXTOS_NEST) {
    const m = limpio.match(patron);
    if (m) return traducir(m, estado);
  }
  return { mensaje: traducirMensajeSuelto(limpio) };
}

function comoTexto(valor: unknown): string {
  if (typeof valor === 'string') return valor;
  if (esObjetoPlano(valor) && typeof valor.message === 'string') return valor.message;
  try {
    return JSON.stringify(valor) ?? '';
  } catch {
    return '';
  }
}

/** Respeta la forma original: texto → texto, arreglo (validaciones) → arreglo. */
function mensajeDe(cuerpo: Record<string, unknown>, respuesta: unknown, respaldo: string, estado: number): Traduccion & {
  readonly lista?: string[];
} {
  const original = typeof respuesta === 'string' ? respuesta : cuerpo.message;
  if (Array.isArray(original)) {
    const lista = original.map((m) => traducirTexto(comoTexto(m), estado).mensaje).filter(Boolean);
    if (lista.length) return { mensaje: lista[0], lista };
  }
  if (typeof original === 'string' && original.trim()) return traducirTexto(original, estado);
  return traducirTexto(respaldo, estado);
}

function segundosPositivos(valor: unknown): number | undefined {
  return typeof valor === 'number' && Number.isFinite(valor) && valor > 0 ? Math.ceil(valor) : undefined;
}

function detalleDeCausa(error: HttpException): string {
  const causa = (error as { cause?: unknown }).cause;
  const texto = causa instanceof Error ? ` · causa: ${causa.name}: ${causa.message}` : '';
  return `${error.name}: ${error.message}${texto}`;
}

/**
 * HttpException (las de Nest y las que lanzan los bussnies): mantiene estado,
 * `message` (texto o arreglo), `codigo` y los campos extra del cuerpo; solo
 * traduce los textos por defecto en inglés y completa `codigo` si falta.
 */
export class TraductorHttpException implements TraductorError {
  traducir(error: unknown): ErrorTraducido | null {
    if (!(error instanceof HttpException)) return null;

    const estado = estadoDeError(error.getStatus());
    const respuesta = error.getResponse();
    const cuerpo = esObjetoPlano(respuesta) ? respuesta : {};
    const { mensaje, codigo: codigoTraduccion, lista } = mensajeDe(cuerpo, respuesta, error.message, estado);

    const codigoPropio = typeof cuerpo.codigo === 'string' && cuerpo.codigo.trim() ? cuerpo.codigo.trim() : undefined;
    const codigo = codigoPropio ?? codigoTraduccion ?? (lista ? CODIGO_VALIDACION : codigoPorEstado(estado));
    const errorPropio =
      typeof cuerpo.error === 'string' && cuerpo.error.trim() && !esFraseInglesaDeNest(cuerpo.error)
        ? cuerpo.error.trim()
        : undefined;

    return {
      estado,
      codigo,
      mensaje: lista ?? mensaje,
      error: errorPropio,
      extra: sinCamposReservados(cuerpo),
      reintentarEnSeg: segundosPositivos(cuerpo.reintentarEnSeg),
      registro: estado >= 500 ? 'error' : 'ninguno',
      detalleLog: estado >= 500 ? detalleDeCausa(error) : undefined,
    };
  }
}
