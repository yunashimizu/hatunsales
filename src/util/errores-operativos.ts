/**
 * Errores operativos estables para POS / crédito / caja.
 * El front puede leer `codigo` además de `message` (Alert2).
 */
export const CodigoError = {
  CREDITO_INACTIVO: 'CREDITO_INACTIVO',
  CREDITO_INSUFICIENTE: 'CREDITO_INSUFICIENTE',
  CREDITO_SIN_CLIENTE: 'CREDITO_SIN_CLIENTE',
  CREDITO_SIN_PERMISO: 'CREDITO_SIN_PERMISO',
  PAGOS_NO_CUADRAN: 'PAGOS_NO_CUADRAN',
  STOCK_INSUFICIENTE: 'STOCK_INSUFICIENTE',
  CULQI_NO_CONFIRMADO: 'CULQI_NO_CONFIRMADO',
  CULQI_NO_CONFIG: 'CULQI_NO_CONFIG',
  ENTIDAD_NO_ENCONTRADA: 'ENTIDAD_NO_ENCONTRADA',
  VENTA_SIN_ITEMS: 'VENTA_SIN_ITEMS',
  CAJA_YA_ABIERTA_USUARIO: 'CAJA_YA_ABIERTA_USUARIO',
  CAJA_OCUPADA: 'CAJA_OCUPADA',
  CAJA_APERTURA_NO_ENCONTRADA: 'CAJA_APERTURA_NO_ENCONTRADA',
  CAJA_YA_CERRADA: 'CAJA_YA_CERRADA',
  CAJA_CIERRE_NO_PERMITIDO: 'CAJA_CIERRE_NO_PERMITIDO',
  CAJA_NO_ABIERTA: 'CAJA_NO_ABIERTA',
} as const;

export type CodigoErrorTipo = (typeof CodigoError)[keyof typeof CodigoError];

/** Cuerpo JSON que Nest serializa en 400/403/404. */
export function cuerpoError(codigo: CodigoErrorTipo, message: string) {
  return { message, codigo };
}
