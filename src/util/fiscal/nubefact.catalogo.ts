/**
 * Traducción entre los identificadores internos del sistema y los catálogos
 * que espera NUBEFACT.
 *
 * Es importante no confundirlos: NUBEFACT no usa los códigos del catálogo 01
 * de SUNAT ('01' factura, '03' boleta) sino una numeración propia y entera.
 * Enviar '01' en vez de 1 hace que el comprobante sea rechazado.
 */

/** Identificadores de `tipos_comprobante` en nuestra base de datos. */
export const TIPO_FACTURA = 1;
export const TIPO_BOLETA = 2;
export const TIPO_NOTA_CREDITO = 7;
export const TIPO_NOTA_DEBITO = 8;

/** Códigos que espera NUBEFACT en `tipo_de_comprobante`. */
const TIPO_NUBEFACT: Record<number, number> = {
  [TIPO_FACTURA]: 1,
  [TIPO_BOLETA]: 2,
  [TIPO_NOTA_CREDITO]: 3,
  [TIPO_NOTA_DEBITO]: 4,
};

/** Códigos del catálogo 01 de SUNAT, usados al referenciar el documento que se modifica. */
const TIPO_SUNAT: Record<number, string> = {
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

export const TIPO_DOC_DNI = 1;
export const TIPO_DOC_RUC = 6;
export const TIPO_DOC_CARNET = 4;
export const TIPO_DOC_PASAPORTE = 7;
export const TIPO_DOC_OTROS = 0;

export function esNota(idTipo?: number): boolean {
  return idTipo === TIPO_NOTA_CREDITO || idTipo === TIPO_NOTA_DEBITO;
}

export function tipoComprobanteNubefact(idTipo?: number): number {
  return TIPO_NUBEFACT[idTipo as number] ?? TIPO_NUBEFACT[TIPO_BOLETA];
}

export function tipoComprobanteSunat(idTipo?: number): string {
  return TIPO_SUNAT[idTipo as number] ?? TIPO_SUNAT[TIPO_BOLETA];
}

export function nombreTipoComprobante(idTipo?: number): string {
  return NOMBRE_TIPO[idTipo as number] ?? NOMBRE_TIPO[TIPO_BOLETA];
}

export function tipoDocumentoNubefact(tipoDoc?: number): number {
  const validos = [TIPO_DOC_OTROS, TIPO_DOC_DNI, TIPO_DOC_CARNET, TIPO_DOC_RUC, TIPO_DOC_PASAPORTE];
  return validos.includes(tipoDoc as number) ? (tipoDoc as number) : TIPO_DOC_DNI;
}

export function monedaNubefact(idMoneda?: number): number {
  return [1, 2, 3, 4].includes(idMoneda as number) ? (idMoneda as number) : 1;
}

/**
 * La serie de una nota debe compartir el prefijo del documento que corrige:
 * si se modifica una factura la serie empieza con F, y con B si es una boleta.
 * Una serie propia tipo "FC01" para notas de boleta es rechazada por SUNAT.
 */
export function prefijoSerie(idTipo: number, serieModificada?: string): 'F' | 'B' {
  if (idTipo === TIPO_FACTURA) return 'F';
  if (idTipo === TIPO_BOLETA) return 'B';
  return serieModificada?.trim().toUpperCase().startsWith('B') ? 'B' : 'F';
}

export function seriePorDefecto(idTipo: number, serieModificada?: string): string {
  return prefijoSerie(idTipo, serieModificada) === 'F' ? 'FFF1' : 'BBB1';
}

/**
 * Normaliza la serie a cuatro caracteres alfanuméricos en mayúsculas y
 * garantiza que el prefijo sea el correcto para el tipo de documento.
 */
export function normalizarSerie(
  serie: string | undefined,
  idTipo: number,
  serieModificada?: string,
): string {
  const limpia = (serie ?? '').toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const esperado = prefijoSerie(idTipo, serieModificada);

  if (limpia.length !== 4 || limpia[0] !== esperado) {
    return serieModificada && esNota(idTipo)
      ? serieModificada.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
      : seriePorDefectoValidada(limpia, idTipo, serieModificada);
  }

  return limpia;
}

function seriePorDefectoValidada(limpia: string, idTipo: number, serieModificada?: string): string {
  const esperado = prefijoSerie(idTipo, serieModificada);
  // Si la serie tiene largo válido pero prefijo equivocado, se corrige el prefijo
  // en vez de descartar la numeración que el usuario eligió.
  if (limpia.length === 4) return `${esperado}${limpia.slice(1)}`;
  return seriePorDefecto(idTipo, serieModificada);
}

/** Motivos del catálogo 09: por qué se emite una nota de crédito. */
export const MOTIVOS_NOTA_CREDITO: Record<string, string> = {
  '01': 'ANULACION DE LA OPERACION',
  '02': 'ANULACION POR ERROR EN EL RUC',
  '03': 'CORRECCION POR ERROR EN LA DESCRIPCION',
  '04': 'DESCUENTO GLOBAL',
  '05': 'DESCUENTO POR ITEM',
  '06': 'DEVOLUCION TOTAL',
  '07': 'DEVOLUCION POR ITEM',
  '08': 'BONIFICACION',
  '09': 'DISMINUCION EN EL VALOR',
  '10': 'OTROS CONCEPTOS',
};

/** Motivos del catálogo 10: por qué se emite una nota de débito. */
export const MOTIVOS_NOTA_DEBITO: Record<string, string> = {
  '01': 'INTERES POR MORA',
  '02': 'AUMENTO EN EL VALOR',
  '03': 'PENALIDADES / OTROS CONCEPTOS',
};
