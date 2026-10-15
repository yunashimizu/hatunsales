/**
 * Errores de dominio de caja, ventas y crédito. Llevan un código estable (el frontend lo lee
 * en `codigo`) y el estado HTTP; la capa bussnies los traduce con aHttpException
 * (src/caja/http/errores-caja.http.ts). El mensaje siempre es apto para mostrar al cajero.
 */
export const CodigoErrorCaja = {
  /** 503: falta ejecutar un script SQL en Railway. */
  CAJA_ESQUEMA_PENDIENTE: 'CAJA_ESQUEMA_PENDIENTE',
  /** 400: datos del arqueo inválidos (denominación, cantidad, medio de pago…). */
  ARQUEO_DATO_INVALIDO: 'ARQUEO_DATO_INVALIDO',
  /** 400: hay diferencia y no se explicó en la observación. */
  ARQUEO_OBSERVACION_REQUERIDA: 'ARQUEO_OBSERVACION_REQUERIDA',
  ARQUEO_NO_ENCONTRADO: 'ARQUEO_NO_ENCONTRADO',
  /** 409: el turno ya está cerrado. */
  ARQUEO_TURNO_CERRADO: 'ARQUEO_TURNO_CERRADO',
  /** 409: el arqueo indicado no sirve para cerrar este turno. */
  ARQUEO_NO_APLICA_CIERRE: 'ARQUEO_NO_APLICA_CIERRE',
  /** 403: solo el dueño del turno (o un admin). */
  CAJA_TURNO_AJENO: 'CAJA_TURNO_AJENO',
  /** 404: no hay turno abierto para el usuario. */
  CAJA_NO_ABIERTA: 'CAJA_NO_ABIERTA',
  CAJA_APERTURA_NO_ENCONTRADA: 'CAJA_APERTURA_NO_ENCONTRADA',
  /** 400: ingreso/egreso mal formado. */
  CAJA_MOVIMIENTO_INVALIDO: 'CAJA_MOVIMIENTO_INVALIDO',
  /** 409: el egreso supera el efectivo que debería haber en caja. */
  CAJA_EGRESO_EXCEDE_EFECTIVO: 'CAJA_EGRESO_EXCEDE_EFECTIVO',
  /** 400: la clave del encabezado Idempotency-Key no coincide con la del cuerpo. */
  VENTA_IDEMPOTENCIA_INVALIDA: 'VENTA_IDEMPOTENCIA_INVALIDA',
  /** 400: medio de pago repetido, inexistente o inactivo. */
  VENTA_PAGO_INVALIDO: 'VENTA_PAGO_INVALIDO',
  /** 400: filtro de fecha mal escrito. */
  FECHA_INVALIDA: 'FECHA_INVALIDA',
  /** 503: la BD no respondió a tiempo o hubo un conflicto de concurrencia; reintentar. */
  CAJA_REINTENTAR: 'CAJA_REINTENTAR',
} as const;

export type CodigoErrorCajaTipo = (typeof CodigoErrorCaja)[keyof typeof CodigoErrorCaja];

/** Script que crea lo que necesita el arqueo, las cuentas y el crédito sin DDL en caliente. */
export const SCRIPT_FASE11 = 'sql/fase11_caja_arqueo_ventas.sql';

export function mensajeScriptPendiente(script = SCRIPT_FASE11): string {
  return `Falta ejecutar ${script} en Railway`;
}

export class ErrorCaja extends Error {
  constructor(
    readonly codigo: CodigoErrorCajaTipo,
    mensaje: string,
    readonly estadoHttp: number,
  ) {
    super(mensaje);
    this.name = 'ErrorCaja';
  }

  static datoInvalido(mensaje: string, codigo: CodigoErrorCajaTipo = CodigoErrorCaja.ARQUEO_DATO_INVALIDO) {
    return new ErrorCaja(codigo, mensaje, 400);
  }

  static noEncontrado(codigo: CodigoErrorCajaTipo, mensaje: string) {
    return new ErrorCaja(codigo, mensaje, 404);
  }

  static conflicto(codigo: CodigoErrorCajaTipo, mensaje: string) {
    return new ErrorCaja(codigo, mensaje, 409);
  }

  static prohibido(codigo: CodigoErrorCajaTipo, mensaje: string) {
    return new ErrorCaja(codigo, mensaje, 403);
  }

  static esquemaPendiente(detalle?: string, script = SCRIPT_FASE11) {
    const base = mensajeScriptPendiente(script);
    return new ErrorCaja(CodigoErrorCaja.CAJA_ESQUEMA_PENDIENTE, detalle ? `${base} (${detalle}).` : `${base}.`, 503);
  }

  static reintentar(mensaje = 'La base de datos está ocupada. Intente de nuevo en unos segundos.') {
    return new ErrorCaja(CodigoErrorCaja.CAJA_REINTENTAR, mensaje, 503);
  }
}

export function cuerpoErrorCaja(codigo: CodigoErrorCajaTipo, message: string) {
  return { message, codigo };
}
