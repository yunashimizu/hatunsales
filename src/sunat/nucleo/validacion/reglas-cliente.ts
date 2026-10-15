import { CATALOGO_06_RUC, esConsumidorFinal, TOPE_BOLETA_SIN_DOCUMENTO_SUNAT } from '../../catalogos/sunat.catalogos';
import { Dinero } from '../decimal';
import { errorDocumentoIdentidad } from '../documentos-identidad';
import { AcumuladorValidacion, ContextoValidacionCpe, esNumeroFinito, ReglaValidacionCpe, textoLimpio } from './base-validacion';

/**
 * Adquirente: documento según el catálogo 06; la factura (y sus notas) exige
 * RUC; la boleta admite consumidor final hasta S/ 700 y, si lo supera, exige
 * identificar al comprador.
 */
export class ReglaAdquirente implements ReglaValidacionCpe {
  readonly nombre = 'adquirente';

  validar(contexto: ContextoValidacionCpe, acumulador: AcumuladorValidacion): void {
    const { doc } = contexto;
    const cliente = doc.cliente;
    if (!cliente) {
      acumulador.error('Faltan los datos del adquirente.');
      return;
    }
    const tipo = textoLimpio(cliente.tipoDoc);
    const numero = textoLimpio(cliente.numDoc);
    const consumidorFinal = esConsumidorFinal(tipo, numero);

    if (!consumidorFinal || tipo !== '0') {
      const motivo = errorDocumentoIdentidad(tipo, numero);
      if (motivo) acumulador.error(`Adquirente: ${motivo}.`);
    } else if (numero.length > 15) {
      acumulador.error('Adquirente sin documento: el número debe ser "-" o tener como máximo 15 caracteres.');
    }

    const nombre = textoLimpio(cliente.nombre);
    if (!nombre) acumulador.error('Falta el nombre o la razón social del adquirente.');
    else if (nombre.length > 1500) acumulador.error('El nombre del adquirente supera los 1500 caracteres.');

    if (contexto.tipoBase === '01' && tipo !== CATALOGO_06_RUC) {
      acumulador.error(
        `${contexto.esNota ? 'Una nota de una factura' : 'La factura'} exige un adquirente con RUC (tipo de documento 6); para personas sin RUC emita boleta.`,
      );
    }

    if (contexto.tipoBase === '03' && consumidorFinal) {
      const total = doc.totales?.total;
      if (doc.moneda === 'PEN' && esNumeroFinito(total) && Dinero.de(total).mayorQue(TOPE_BOLETA_SIN_DOCUMENTO_SUNAT)) {
        acumulador.error(
          `El importe (S/ ${Dinero.de(total).toString()}) supera S/ ${TOPE_BOLETA_SIN_DOCUMENTO_SUNAT}.00: SUNAT exige identificar al adquirente con DNI, carné de extranjería, pasaporte o RUC.`,
        );
      } else if (doc.moneda !== 'PEN') {
        acumulador.advertencia(
          `Boleta en ${textoLimpio(doc.moneda)} sin identificar al adquirente: verifique que no supere el equivalente a S/ ${TOPE_BOLETA_SIN_DOCUMENTO_SUNAT}.00.`,
        );
      }
    }
  }
}
