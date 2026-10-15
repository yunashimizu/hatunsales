import { compactarFecha, esFechaIso } from './fechas-fiscales';
import { ErrorNucleoFiscal } from './errores-nucleo';
import type { TipoCpe } from './documento-fiscal.types';

/**
 * Identificadores y nombres de archivo de SUNAT (Manual del Programador §1.2).
 * Una sola fuente para el cbc:ID, el nombre del .xml/.zip y el QR: si no
 * coinciden entre sí, SUNAT rechaza el envío.
 */

export const NUMERO_MAXIMO_CPE = 99_999_999;
export const CORRELATIVO_MAXIMO_RESUMEN = 99_999;

export const PATRON_SERIE_FACTURA = /^F[A-Z0-9]{3}$/;
export const PATRON_SERIE_BOLETA = /^B[A-Z0-9]{3}$/;
export const PATRON_SERIE_NOTA = /^[FB][A-Z0-9]{3}$/;
export const PATRON_SERIE_GUIA = /^T[A-Z0-9]{3}$/;

/** RUC-TT-SERIE-NUMERO de un comprobante (01, 03, 07, 08) o de una guía (09). */
export const PATRON_NOMBRE_BASE_CPE = /^\d{11}-(01|03|07|08|09)-[A-Z0-9]{4}-\d{1,8}$/;
/** RUC-RC-YYYYMMDD-N (resumen diario) o RUC-RA-YYYYMMDD-N (comunicación de baja). */
export const PATRON_NOMBRE_RESUMEN = /^\d{11}-(RC|RA)-\d{8}-\d{1,5}$/;
export const PATRON_IDENTIFICADOR_RESUMEN = /^(RC|RA)-(\d{8})-(\d{1,5})$/;

export type PrefijoResumen = 'RC' | 'RA';

function esEnteroEnRango(valor: unknown, minimo: number, maximo: number): valor is number {
  return typeof valor === 'number' && Number.isInteger(valor) && valor >= minimo && valor <= maximo;
}

/** Correlativo de 8 dígitos (00000001), igual en cbc:ID, en el nombre del archivo y en el QR. */
export function correlativoCpe(numero: number): string {
  if (!esEnteroEnRango(numero, 1, NUMERO_MAXIMO_CPE)) {
    throw new ErrorNucleoFiscal('FISCAL_DOCUMENTO_INVALIDO', `El número del comprobante debe ser un entero entre 1 y ${NUMERO_MAXIMO_CPE}: ${numero}`);
  }
  return String(numero).padStart(8, '0');
}

/** cbc:ID del comprobante: SERIE-NNNNNNNN. */
export function identificadorCpe(serie: string, numero: number): string {
  return `${serie}-${correlativoCpe(numero)}`;
}

/** Nombre base (sin extensión) del .xml y del .zip: RUC-TT-SERIE-NNNNNNNN. */
export function nombreBaseCpe(ruc: string, tipo: TipoCpe | '09', serie: string, numero: number): string {
  return `${ruc}-${tipo}-${serie}-${correlativoCpe(numero)}`;
}

/**
 * Identificador del resumen diario (RC) o de la comunicación de baja (RA):
 * PREFIJO-YYYYMMDD-NNNNN con la fecha de GENERACIÓN (no la de emisión de los
 * documentos, que va en cbc:ReferenceDate). El correlativo se rellena a 5
 * dígitos: SUNAT admite de 1 a 5 y así el ID y el nombre del archivo siempre
 * salen iguales.
 */
export function identificadorResumen(prefijo: PrefijoResumen, fechaGeneracion: string, correlativo: number): string {
  if (!esFechaIso(fechaGeneracion)) {
    throw new ErrorNucleoFiscal('FISCAL_RESUMEN_INVALIDO', `Fecha de generación inválida (se espera yyyy-mm-dd): ${fechaGeneracion}`);
  }
  if (!esEnteroEnRango(correlativo, 1, CORRELATIVO_MAXIMO_RESUMEN)) {
    throw new ErrorNucleoFiscal('FISCAL_RESUMEN_INVALIDO', `El correlativo del ${prefijo} debe ser un entero entre 1 y ${CORRELATIVO_MAXIMO_RESUMEN}: ${correlativo}`);
  }
  return `${prefijo}-${compactarFecha(fechaGeneracion)}-${String(correlativo).padStart(5, '0')}`;
}

/** Nombre base del archivo de un RC o RA: RUC-IDENTIFICADOR (idéntico al cbc:ID, como exige SUNAT). */
export function nombreArchivoResumen(ruc: string, identificador: string): string {
  return `${ruc}-${identificador}`;
}

/** Descompone RC-YYYYMMDD-N en sus partes, o null si no tiene ese formato. */
export function leerIdentificadorResumen(identificador: string): { prefijo: PrefijoResumen; fecha: string; correlativo: number } | null {
  const m = PATRON_IDENTIFICADOR_RESUMEN.exec(identificador ?? '');
  if (!m) return null;
  const compacta = m[2];
  return {
    prefijo: m[1] as PrefijoResumen,
    fecha: `${compacta.slice(0, 4)}-${compacta.slice(4, 6)}-${compacta.slice(6, 8)}`,
    correlativo: Number(m[3]),
  };
}
