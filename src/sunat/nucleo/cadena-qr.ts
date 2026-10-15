import { esConsumidorFinal } from '../catalogos/sunat.catalogos';
import { DecimalExacto, Dinero } from './decimal';
import type { DatosCadenaQr } from './documento-fiscal.types';
import { CadenaQrError } from './errores-nucleo';
import { esFechaIso } from './fechas-fiscales';
import { correlativoCpe, NUMERO_MAXIMO_CPE, PATRON_SERIE_NOTA } from './identificadores-cpe';

const TIPOS_QR = new Set(['01', '03', '07', '08']);

/**
 * Contenido del código QR de la representación impresa (Anexo A de la RS
 * 113-2018): RUC|TIPO|SERIE|NUMERO|MTO IGV|MTO TOTAL|FECHA|TIPO DOC ADQ|NUM DOC ADQ|VALOR RESUMEN|
 * El número va con 8 dígitos (igual que en cbc:ID), los montos con 2
 * decimales y la fecha en yyyy-mm-dd. Sin documento del adquirente esos dos
 * campos quedan vacíos; el valor resumen es el DigestValue (base64).
 */
export function construirCadenaQr(datos: DatosCadenaQr): string {
  if (!datos || typeof datos !== 'object') throw new CadenaQrError('Faltan los datos del comprobante para el código QR.');
  const ruc = String(datos.ruc ?? '').trim();
  if (!/^\d{11}$/.test(ruc)) throw new CadenaQrError(`RUC inválido para el código QR: "${ruc}".`);
  if (!TIPOS_QR.has(datos.tipo)) throw new CadenaQrError(`Tipo de comprobante inválido para el código QR: "${String(datos.tipo)}".`);
  const serie = String(datos.serie ?? '').trim();
  if (!PATRON_SERIE_NOTA.test(serie)) throw new CadenaQrError(`Serie inválida para el código QR: "${serie}".`);
  if (!Number.isInteger(datos.numero) || datos.numero < 1 || datos.numero > NUMERO_MAXIMO_CPE) {
    throw new CadenaQrError(`Número inválido para el código QR: ${String(datos.numero)}.`);
  }
  if (!esFechaIso(datos.fechaEmision)) throw new CadenaQrError(`Fecha de emisión inválida para el código QR: "${String(datos.fechaEmision)}".`);
  for (const [campo, valor] of [['IGV', datos.igv], ['total', datos.total]] as const) {
    if (!DecimalExacto.esValido(valor) || DecimalExacto.de(valor).esNegativo()) {
      throw new CadenaQrError(`Monto ${campo} inválido para el código QR: ${String(valor)}.`);
    }
  }

  const tipoAdquirente = String(datos.tipoDocAdq ?? '').trim();
  const numeroAdquirente = String(datos.numDocAdq ?? '').trim();
  const sinDocumento = !tipoAdquirente || esConsumidorFinal(tipoAdquirente, numeroAdquirente);

  const campos = [
    ruc,
    datos.tipo,
    serie,
    correlativoCpe(datos.numero),
    Dinero.de(datos.igv).toString(),
    Dinero.de(datos.total).toString(),
    datos.fechaEmision,
    sinDocumento ? '' : tipoAdquirente,
    sinDocumento ? '' : numeroAdquirente,
    String(datos.digest ?? '').trim(),
  ];
  return `${campos.join('|')}|`;
}
