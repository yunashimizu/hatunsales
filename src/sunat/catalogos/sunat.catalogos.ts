/**
 * Catalogos oficiales de SUNAT usados por el pipeline "sunat-direct" (envio
 * propio, sin OSE) al construir los XML UBL 2.1 de Factura, Boleta, Nota de
 * Credito y Guia de Remision Remitente.
 *
 * Fuentes: Anexo N.8 de la RS 193-2020/SUNAT (catalogo 09 - motivos de nota
 * de credito) y guias oficiales de elaboracion de documentos XML UBL 2.1
 * publicadas en cpe.sunat.gob.pe. No confundir con los catalogos propios de
 * NUBEFACT (ver ../../util/fiscal/nubefact.catalogo.ts) — SUNAT y NUBEFACT
 * numeran distinto.
 */

/** Catalogo 01: tipo de documento (el mismo que ya usa nubefact.catalogo.ts, repetido aqui para no acoplar los dos modulos). */
export const CATALOGO_01_FACTURA = '01';
export const CATALOGO_01_BOLETA = '03';
export const CATALOGO_01_NOTA_CREDITO = '07';
export const CATALOGO_01_NOTA_DEBITO = '08';
export const CATALOGO_01_GUIA_REMISION_REMITENTE = '09';

/** Catalogo 06: tipo de documento de identidad del cliente. */
export const CATALOGO_06_DNI = '1';
export const CATALOGO_06_CARNET_EXTRANJERIA = '4';
export const CATALOGO_06_RUC = '6';
export const CATALOGO_06_PASAPORTE = '7';
export const CATALOGO_06_SIN_DOCUMENTO = '0';

export type AfectacionIgv = '10' | '20' | '30' | '40';

/**
 * Catalogo 05 (UNECE 5305 "Duty/tax/fee category"): identificador corto que
 * exige SUNAT dentro de cac:TaxCategory/cbc:ID, ademas del
 * cbc:TaxExemptionReasonCode (catalogo 07) que ya se usaba. Sin este ID
 * corto, SUNAT acepta el XML pero lo observa (codigo 4xxx).
 */
export const CATALOGO_05_POR_AFECTACION: Record<AfectacionIgv, 'S' | 'E' | 'O' | 'Z'> = {
  '10': 'S', // Gravado - Operacion Onerosa
  '20': 'E', // Exonerado - Operacion Onerosa
  '30': 'O', // Inafecto - Operacion Onerosa
  '40': 'Z', // Exportacion
};

/** Catalogo 07: tipo de afectacion del IGV (ya usado antes de esta extension). */
export function nombreTaxScheme(afectacion: AfectacionIgv): { id: string; nombre: string; codigo: string } {
  if (afectacion === '10') return { id: '1000', nombre: 'IGV', codigo: 'VAT' };
  if (afectacion === '20') return { id: '9997', nombre: 'EXO', codigo: 'VAT' };
  if (afectacion === '40') return { id: '9995', nombre: 'EXP', codigo: 'FRE' };
  return { id: '9998', nombre: 'INA', codigo: 'FRE' };
}

/**
 * Catalogo 09: motivos de Nota de Credito electronica.
 * Fuente: Anexo N.8 de la Resolucion de Superintendencia N.193-2020/SUNAT.
 * Los motivos 04, 05 y 08 NO se pueden usar cuando el documento que se
 * modifica es una Boleta de venta (solo aplican a Factura).
 */
export const CATALOGO_09_MOTIVO_NOTA_CREDITO = {
  ANULACION_DE_LA_OPERACION: '01',
  ANULACION_POR_ERROR_EN_EL_RUC: '02',
  CORRECCION_POR_ERROR_EN_LA_DESCRIPCION: '03',
  DESCUENTO_GLOBAL: '04',
  DESCUENTO_POR_ITEM: '05',
  DEVOLUCION_TOTAL: '06',
  DEVOLUCION_POR_ITEM: '07',
  BONIFICACION: '08',
  DISMINUCION_EN_EL_VALOR: '09',
  OTROS_CONCEPTOS: '10',
  AJUSTES_DE_OPERACIONES_DE_EXPORTACION: '11',
  AJUSTES_AFECTOS_AL_IVAP: '12',
  CORRECCION_MONTO_O_FECHAS_DE_PAGO: '13',
} as const;

export type MotivoNotaCredito = typeof CATALOGO_09_MOTIVO_NOTA_CREDITO[keyof typeof CATALOGO_09_MOTIVO_NOTA_CREDITO];

/** Motivos del catalogo 09 exclusivos de Factura: SUNAT los rechaza si el documento modificado es una Boleta. */
const MOTIVOS_SOLO_FACTURA: MotivoNotaCredito[] = [
  CATALOGO_09_MOTIVO_NOTA_CREDITO.DESCUENTO_GLOBAL,
  CATALOGO_09_MOTIVO_NOTA_CREDITO.DESCUENTO_POR_ITEM,
  CATALOGO_09_MOTIVO_NOTA_CREDITO.BONIFICACION,
];

export function motivoNotaCreditoValidoParaTipo(motivo: string, tipoDocumentoModificado: '01' | '03'): boolean {
  if (tipoDocumentoModificado === '01') return true;
  return !MOTIVOS_SOLO_FACTURA.includes(motivo as MotivoNotaCredito);
}

/** Catalogo 20 (Motivo de traslado) usado por la Guia de Remision Remitente. Lista abreviada con los motivos mas comunes. */
export const CATALOGO_20_MOTIVO_TRASLADO = {
  VENTA: '01',
  TRASLADO_ENTRE_ESTABLECIMIENTOS_DE_LA_MISMA_EMPRESA: '04',
  COMPRA: '08',
  OTROS: '13',
} as const;

/** Catalogo 21 (Modalidad de traslado) de la Guia de Remision Remitente. */
export const CATALOGO_21_MODALIDAD_TRASLADO = {
  TRANSPORTE_PUBLICO: '01',
  TRANSPORTE_PRIVADO: '02',
} as const;
