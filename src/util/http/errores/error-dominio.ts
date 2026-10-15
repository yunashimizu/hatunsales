/**
 * Errores de dominio: llevan un `codigo` estable en MAYÚSCULAS y un mensaje en
 * español apto para mostrar. El filtro global los traduce solo con mirar su
 * forma, así que sirven tal cual ErrorCaja (src/caja), FiscalConfigError y
 * ErrorNucleoFiscal (src/sunat) o cualquier clase que extienda ErrorDominio.
 */

const CODIGO_DOMINIO = /^[A-Z][A-Z0-9_]{2,63}$/;

/** Campos del cuerpo HTTP que ningún detalle de dominio puede pisar. */
export const CAMPOS_RESERVADOS: ReadonlySet<string> = new Set([
  'statusCode',
  'message',
  'error',
  'codigo',
  'ruta',
  'idPeticion',
  'reintentarEnSeg',
]);

/** Base recomendada para errores de dominio nuevos. */
export abstract class ErrorDominio extends Error {
  abstract readonly codigo: string;
  abstract readonly estadoHttp: number;

  protected constructor(
    mensaje: string,
    readonly detalle: Readonly<Record<string, unknown>> = {},
  ) {
    super(mensaje);
    this.name = new.target.name;
  }
}

/** Forma mínima que reconoce el filtro global. */
export interface ErrorConCodigo {
  readonly codigo: string;
  readonly message: string;
  readonly estadoHttp?: unknown;
  readonly status?: unknown;
  readonly statusCode?: unknown;
  readonly reintentarEnSeg?: unknown;
  readonly detalle?: unknown;
  readonly cuerpo?: unknown;
}

export function esErrorConCodigo(error: unknown): error is ErrorConCodigo {
  if (!error || typeof error !== 'object') return false;
  const { codigo, message } = error as { codigo?: unknown; message?: unknown };
  if (typeof codigo !== 'string' || !CODIGO_DOMINIO.test(codigo)) return false;
  return error instanceof Error || typeof message === 'string';
}

/** Primer estado HTTP de error (400-599) que declare el error, o null. */
export function estadoDeclarado(error: ErrorConCodigo): number | null {
  for (const valor of [error.estadoHttp, error.status, error.statusCode]) {
    if (typeof valor === 'number' && Number.isInteger(valor) && valor >= 400 && valor <= 599) return valor;
  }
  return null;
}

export function esObjetoPlano(valor: unknown): valor is Record<string, unknown> {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return false;
  const proto = Object.getPrototypeOf(valor);
  return proto === Object.prototype || proto === null;
}

/** Copia del objeto sin los campos reservados del cuerpo HTTP. */
export function sinCamposReservados(valor: unknown): Record<string, unknown> {
  if (!esObjetoPlano(valor)) return {};
  return Object.fromEntries(Object.entries(valor).filter(([clave]) => !CAMPOS_RESERVADOS.has(clave)));
}
