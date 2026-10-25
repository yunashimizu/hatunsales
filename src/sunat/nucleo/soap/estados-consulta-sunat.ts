import type { EstadoComprobanteSunat } from '../documento-fiscal.types';

/**
 * statusCode de billConsultService (getStatus y getStatusCdr) cuando no viene la
 * constancia: tabla del Manual del Programador, anexo 2 («Servicio web consulta de
 * facturas y notas»). Solo están los códigos documentados; si SUNAT agrega otro, se
 * agrega aquí con su texto oficial.
 */
export const ESTADOS_CONSULTA_SUNAT: Readonly<Record<string, EstadoComprobanteSunat>> = Object.freeze({
  '0001': 'ACEPTADO',
  '0002': 'RECHAZADO',
  '0003': 'DE_BAJA',
  '0004': 'CONSULTA_INVALIDA',
  '0005': 'CONSULTA_INVALIDA',
  '0006': 'CONSULTA_INVALIDA',
  '0007': 'CONSULTA_INVALIDA',
  '0008': 'NO_AUTORIZADO',
  '0009': 'CONSULTA_INVALIDA',
  '0010': 'CONSULTA_INVALIDA',
  '0011': 'NO_EXISTE',
  '0012': 'NO_AUTORIZADO',
});

/** Texto oficial de cada statusCode: se usa cuando SUNAT no manda statusMessage. */
export const DESCRIPCIONES_CONSULTA_SUNAT: Readonly<Record<string, string>> = Object.freeze({
  '0001': 'El comprobante existe y está aceptado.',
  '0002': 'El comprobante existe pero está rechazado.',
  '0003': 'El comprobante existe pero está de baja.',
  '0004': 'Formato de RUC no es válido (debe de contener 11 caracteres numéricos).',
  '0005': 'Formato del tipo de comprobante no es válido (debe de contener 2 caracteres).',
  '0006': 'Formato de serie inválido (debe de contener 4 caracteres).',
  '0007': 'El numero de comprobante debe de ser mayor que cero.',
  '0008': 'El número de RUC no está inscrito en los registros de la SUNAT.',
  '0009': 'El tipo de comprobante debe de ser (01, 07 o 08).',
  '0010': 'Sólo se puede consultar facturas, notas de crédito y debito electrónicas, cuya serie empieza con "F".',
  '0011': 'El comprobante de pago electrónico no existe.',
  '0012': 'El comprobante de pago electrónico no le pertenece.',
});

/** statusCode normalizado a 4 dígitos ('11' → '0011'); otro texto queda igual. */
export function normalizarCodigoConsulta(statusCode: string): string {
  const codigo = String(statusCode ?? '').trim();
  return /^\d{1,4}$/.test(codigo) ? codigo.padStart(4, '0') : codigo;
}

/** Significado de un statusCode de la consulta; DESCONOCIDO si no está documentado. */
export function estadoDeConsulta(statusCode: string): EstadoComprobanteSunat {
  return ESTADOS_CONSULTA_SUNAT[normalizarCodigoConsulta(statusCode)] ?? 'DESCONOCIDO';
}
