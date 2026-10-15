import {
  CATALOGO_10_MOTIVO_NOTA_DEBITO,
  esMotivoNotaCredito,
  esMotivoNotaDebito,
  motivoNotaCreditoValidoParaTipo,
} from '../../catalogos/sunat.catalogos';
import { Dinero } from '../decimal';
import { NUMERO_MAXIMO_CPE, PATRON_SERIE_BOLETA, PATRON_SERIE_FACTURA } from '../identificadores-cpe';
import {
  AcumuladorValidacion,
  ContextoValidacionCpe,
  esNumeroFinito,
  formatoMonto,
  PATRON_CARACTERES_CONTROL,
  ReglaValidacionCpe,
  textoLimpio,
} from './base-validacion';

const LONGITUD_MAXIMA_SUSTENTO = 500;

/**
 * Notas de crédito y débito: un único comprobante modificado (RS
 * 000048-2026), motivo válido para su tipo, sustento y, desde 2027, la ND
 * por penalidades (13) solo inafecta o exonerada.
 */
export class ReglaNota implements ReglaValidacionCpe {
  readonly nombre = 'nota';

  validar(contexto: ContextoValidacionCpe, acumulador: AcumuladorValidacion): void {
    const { doc } = contexto;
    if (!contexto.esNota) {
      if (doc.referencia) acumulador.advertencia('La referencia a otro comprobante solo aplica a notas: se omitirá del XML.');
      return;
    }
    const referencia = doc.referencia;
    if (!referencia) {
      acumulador.error(`Falta el comprobante que modifica ${contexto.nombreDocumento} (tipo, serie y número).`);
      return;
    }

    if (referencia.tipoDoc !== '01' && referencia.tipoDoc !== '03') {
      acumulador.error(`El comprobante modificado debe ser una factura (01) o una boleta (03): "${textoLimpio(referencia.tipoDoc)}".`);
    } else {
      const patron = referencia.tipoDoc === '01' ? PATRON_SERIE_FACTURA : PATRON_SERIE_BOLETA;
      if (!patron.test(textoLimpio(referencia.serie))) {
        acumulador.error(`La serie del comprobante modificado "${textoLimpio(referencia.serie)}" no corresponde a una ${referencia.tipoDoc === '01' ? 'factura' : 'boleta'}.`);
      }
    }
    if (!Number.isInteger(referencia.numero) || referencia.numero < 1 || referencia.numero > NUMERO_MAXIMO_CPE) {
      acumulador.error(`El número del comprobante modificado debe ser un entero entre 1 y ${NUMERO_MAXIMO_CPE}.`);
    }

    const sustento = textoLimpio(referencia.sustento);
    if (!sustento) acumulador.error('Falta el sustento (motivo en texto) de la nota.');
    else if (sustento.length > LONGITUD_MAXIMA_SUSTENTO) acumulador.error(`El sustento de la nota supera los ${LONGITUD_MAXIMA_SUSTENTO} caracteres.`);
    if (PATRON_CARACTERES_CONTROL.test(String(referencia.sustento ?? ''))) {
      acumulador.error('El sustento de la nota contiene caracteres de control no permitidos.');
    }

    if (doc.tipo === '07') this.validarCredito(contexto, acumulador);
    else this.validarDebito(contexto, acumulador);
  }

  private validarCredito(contexto: ContextoValidacionCpe, acumulador: AcumuladorValidacion): void {
    const { doc } = contexto;
    const referencia = doc.referencia!;
    const motivo = textoLimpio(referencia.motivo);
    if (!esMotivoNotaCredito(motivo)) {
      acumulador.error(`El motivo "${motivo}" no existe en el catálogo 09 de notas de crédito.`);
    } else if ((referencia.tipoDoc === '01' || referencia.tipoDoc === '03') && !motivoNotaCreditoValidoParaTipo(motivo, referencia.tipoDoc)) {
      acumulador.error(`El motivo ${motivo} de nota de crédito no se puede usar sobre una boleta (04, 05, 08 y 13 solo aplican a facturas).`);
    }

    const maximo = contexto.montoMaximoNota;
    if (esNumeroFinito(maximo) && esNumeroFinito(doc.totales?.total) && Dinero.de(doc.totales.total).mayorQue(maximo)) {
      acumulador.error(
        `El total de la nota de crédito (${formatoMonto(doc.totales.total)}) supera el saldo del comprobante modificado (${formatoMonto(maximo)}).`,
      );
    }
  }

  private validarDebito(contexto: ContextoValidacionCpe, acumulador: AcumuladorValidacion): void {
    const { doc } = contexto;
    const motivo = textoLimpio(doc.referencia!.motivo);
    if (!esMotivoNotaDebito(motivo)) {
      acumulador.error(`El motivo "${motivo}" no existe en el catálogo 10 de notas de débito.`);
      return;
    }
    if (motivo !== CATALOGO_10_MOTIVO_NOTA_DEBITO.PENALIDADES) return;

    if (!contexto.aplicarReglas2027) {
      acumulador.error('El motivo 13 (penalidades) de nota de débito rige desde el 01/01/2027 (RS 000048-2026); hasta entonces use el 03.');
      return;
    }
    const lineas = Array.isArray(doc.lineas) ? doc.lineas : [];
    lineas.forEach((linea, indice) => {
      if (linea?.afectacion !== '30' && linea?.afectacion !== '20') {
        acumulador.error(`Línea ${indice + 1}: la nota de débito por penalidades (motivo 13) debe ser inafecta o exonerada (RS 000048-2026).`);
      }
    });
  }
}
