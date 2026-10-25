/**
 * Identificadores internos de los comprobantes (tabla `tipos_comprobante`) y su
 * equivalencia con el catálogo 01 de SUNAT, que es el que viaja en el XML.
 */

/** Identificadores de `tipos_comprobante` en nuestra base de datos. */
export const TIPO_FACTURA = 1;
export const TIPO_BOLETA = 2;
export const TIPO_NOTA_CREDITO = 7;
export const TIPO_NOTA_DEBITO = 8;

export type TipoCatalogo01 = '01' | '03' | '07' | '08';

const TIPO_SUNAT: Record<number, TipoCatalogo01> = {
  [TIPO_FACTURA]: '01',
  [TIPO_BOLETA]: '03',
  [TIPO_NOTA_CREDITO]: '07',
  [TIPO_NOTA_DEBITO]: '08',
};

const NOMBRE_TIPO: Record<number, string> = {
  [TIPO_FACTURA]: 'FACTURA ELECTRONICA',
  [TIPO_BOLETA]: 'BOLETA DE VENTA ELECTRONICA',
  [TIPO_NOTA_CREDITO]: 'NOTA DE CREDITO ELECTRONICA',
  [TIPO_NOTA_DEBITO]: 'NOTA DE DEBITO ELECTRONICA',
};

/** Catálogo 06 (documento de identidad) en la codificación numérica que guarda `comprobantes.cliente_tipo_doc`. */
export const TIPO_DOC_DNI = 1;
export const TIPO_DOC_RUC = 6;

/** Catálogo 01 del tipo interno; null si el tipo no es un comprobante electrónico. */
export function tipoComprobanteSunat(idTipo?: number | null): TipoCatalogo01 | null {
  return TIPO_SUNAT[Number(idTipo)] ?? null;
}

export function nombreTipoComprobante(idTipo?: number | null): string {
  return NOMBRE_TIPO[Number(idTipo)] ?? NOMBRE_TIPO[TIPO_BOLETA];
}

/** Factura o boleta: el comprobante principal de una venta (las notas lo modifican). */
export function esComprobantePrincipal(idTipo?: number | null): boolean {
  return Number(idTipo) === TIPO_FACTURA || Number(idTipo) === TIPO_BOLETA;
}
