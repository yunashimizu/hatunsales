import { PLAZOS_ENVIO_DIAS } from '../catalogos/sunat.catalogos';
import { sumarDias } from './fechas-fiscales';

/**
 * Reglas de envío que comparten la emisión, el reintento, la recuperación de CDR y la tarea
 * programada. Puras: sin red ni base de datos.
 */

/**
 * getStatusCdr (billConsultService) solo responde por facturas y sus notas: tipo 01, 07 u 08 con
 * serie que empieza con F. Para boletas y notas de boleta SUNAT contesta 0009/0010, así que esos
 * documentos nunca se consultan por ese servicio.
 */
export function admiteGetStatusCdr(tipo: string, serie: string): boolean {
  return (tipo === '01' || tipo === '07' || tipo === '08') && /^F/i.test(serie ?? '');
}

/** Una nota sigue el régimen del comprobante que modifica, que se reconoce por la primera letra de su serie (F o B). */
export function esDocumentoDeFactura(tipo: string, serie: string): boolean {
  if (tipo === '01') return true;
  if (tipo === '03') return false;
  return /^F/i.test(serie ?? '');
}

/**
 * Último día (yyyy-mm-dd, calendario de Lima) para enviar el comprobante por sendBill, contado desde
 * el día siguiente a la emisión: facturas y sus notas 3 días (RS 000003-2023); boletas y sus notas
 * 5 días (RS 114-2019, art. 12). Pasado ese día una boleta solo puede informarse por resumen diario.
 */
export function fechaLimiteEnvioIndividual(tipo: string, serie: string, fechaEmision: string): string {
  const dias = esDocumentoDeFactura(tipo, serie) ? PLAZOS_ENVIO_DIAS.facturaYNotas : PLAZOS_ENVIO_DIAS.boletaIndividual;
  return sumarDias(fechaEmision, dias);
}

/** El usuario del WS-Security es el RUC (11 dígitos) seguido del usuario SOL secundario. */
export function rucDeUsuarioSol(usuario: string): string | null {
  const coincidencia = /^(\d{11})[A-Za-z0-9]+$/.exec((usuario ?? '').trim());
  return coincidencia ? coincidencia[1] : null;
}

/** SUNAT rechaza el envío (0154/2107) si el RUC del usuario SOL no es el del emisor del comprobante. */
export function usuarioSolCorrespondeAlEmisor(usuario: string, rucEmisor: string): boolean {
  const ruc = rucDeUsuarioSol(usuario);
  return ruc !== null && ruc === (rucEmisor ?? '').trim();
}
