import { PLAZOS_ENVIO_DIAS } from '../../catalogos/sunat.catalogos';
import { esRucValido } from '../documentos-identidad';
import { diasEntre, esFechaIso, esHoraValida } from '../fechas-fiscales';
import { NUMERO_MAXIMO_CPE, PATRON_SERIE_BOLETA, PATRON_SERIE_FACTURA, PATRON_SERIE_NOTA } from '../identificadores-cpe';
import { AcumuladorValidacion, ContextoValidacionCpe, ReglaValidacionCpe, textoLimpio } from './base-validacion';

const TIPOS_SOPORTADOS = new Set(['01', '03', '07', '08']);
const MONEDAS_SOPORTADAS = new Set(['PEN', 'USD']);

/** Datos del emisor: RUC con dígito verificador y domicilio fiscal completo. */
export class ReglaEmisor implements ReglaValidacionCpe {
  readonly nombre = 'emisor';

  validar({ doc }: ContextoValidacionCpe, acumulador: AcumuladorValidacion): void {
    const emisor = doc.emisor;
    if (!emisor) {
      acumulador.error('Faltan los datos del emisor.');
      return;
    }
    if (!esRucValido(emisor.ruc)) {
      acumulador.error(`El RUC del emisor "${textoLimpio(emisor.ruc)}" no es válido (11 dígitos con dígito verificador correcto).`);
    }
    const razonSocial = textoLimpio(emisor.razonSocial);
    if (!razonSocial) acumulador.error('Falta la razón social del emisor.');
    else if (razonSocial.length > 1500) acumulador.error('La razón social del emisor supera los 1500 caracteres.');

    if (!/^\d{6}$/.test(textoLimpio(emisor.ubigeo))) {
      acumulador.error('El ubigeo del emisor debe tener 6 dígitos (código INEI del distrito); configúrelo en Panel → Facturación SUNAT.');
    }
    if (!textoLimpio(emisor.direccion)) acumulador.error('Falta la dirección del domicilio fiscal del emisor.');

    const partes: Array<[string, unknown]> = [
      ['distrito', emisor.distrito],
      ['provincia', emisor.provincia],
      ['departamento', emisor.departamento],
    ];
    for (const [campo, valor] of partes) {
      if (!textoLimpio(valor)) acumulador.advertencia(`Falta el ${campo} del emisor: SUNAT observará la dirección del domicilio fiscal.`);
    }

    const establecimiento = textoLimpio(emisor.codigoEstablecimiento);
    if (!establecimiento) {
      acumulador.advertencia('Sin código de establecimiento anexo: se informará 0000 (domicilio fiscal).');
    } else if (!/^\d{4}$/.test(establecimiento)) {
      acumulador.error(`El código de establecimiento "${establecimiento}" debe tener 4 dígitos (0000 = domicilio fiscal).`);
    }
  }
}

/**
 * Serie y número (Manual del Programador §1.2): F + 3 alfanuméricos para
 * facturas y sus notas (F001, FFF1, FC01), B + 3 para boletas y sus notas.
 */
export class ReglaSerieNumero implements ReglaValidacionCpe {
  readonly nombre = 'serie-numero';

  validar(contexto: ContextoValidacionCpe, acumulador: AcumuladorValidacion): void {
    const { doc } = contexto;
    if (!TIPOS_SOPORTADOS.has(doc.tipo)) {
      acumulador.error(`El tipo de comprobante "${textoLimpio(doc.tipo)}" no es soportado (01 factura, 03 boleta, 07 nota de crédito, 08 nota de débito).`);
      return;
    }

    const serie = typeof doc.serie === 'string' ? doc.serie : '';
    const base = contexto.tipoBase;
    if (base === '01' && !PATRON_SERIE_FACTURA.test(serie)) {
      const sujeto = contexto.esNota ? `${contexto.nombreDocumento} de una factura` : 'una factura';
      acumulador.error(`La serie "${serie}" no es válida para ${sujeto}: debe ser F seguida de 3 letras mayúsculas o dígitos (F001, FFF1, FC01).`);
    } else if (base === '03' && !PATRON_SERIE_BOLETA.test(serie)) {
      const sujeto = contexto.esNota ? `${contexto.nombreDocumento} de una boleta` : 'una boleta';
      acumulador.error(`La serie "${serie}" no es válida para ${sujeto}: debe ser B seguida de 3 letras mayúsculas o dígitos (B001, BBB1, BC01).`);
    } else if (base === null && !PATRON_SERIE_NOTA.test(serie)) {
      acumulador.error(`La serie "${serie}" no es válida: debe ser F o B seguida de 3 letras mayúsculas o dígitos.`);
    }

    const numero = doc.numero;
    if (!Number.isInteger(numero) || numero < 1 || numero > NUMERO_MAXIMO_CPE) {
      acumulador.error(`El número del comprobante debe ser un entero entre 1 y ${NUMERO_MAXIMO_CPE}: ${String(numero)}.`);
    }
  }
}

/** Fecha y hora de emisión, vencimiento y plazos de envío (advertencias). */
export class ReglaFechasYPlazos implements ReglaValidacionCpe {
  readonly nombre = 'fechas-plazos';

  validar(contexto: ContextoValidacionCpe, acumulador: AcumuladorValidacion): void {
    const { doc, hoy } = contexto;
    const fechaValida = esFechaIso(doc.fechaEmision);
    if (!fechaValida) acumulador.error(`La fecha de emisión "${textoLimpio(doc.fechaEmision)}" no es válida (se espera yyyy-mm-dd).`);
    if (!esHoraValida(doc.horaEmision)) acumulador.error(`La hora de emisión "${textoLimpio(doc.horaEmision)}" no es válida (se espera HH:mm:ss).`);

    if (doc.fechaVencimiento !== undefined && doc.fechaVencimiento !== null && doc.fechaVencimiento !== '') {
      if (!esFechaIso(doc.fechaVencimiento)) {
        acumulador.error(`La fecha de vencimiento "${textoLimpio(doc.fechaVencimiento)}" no es válida (se espera yyyy-mm-dd).`);
      } else if (fechaValida && doc.fechaVencimiento < doc.fechaEmision) {
        acumulador.error('La fecha de vencimiento no puede ser anterior a la fecha de emisión.');
      }
    }
    if (!fechaValida) return;

    const dias = diasEntre(doc.fechaEmision, hoy);
    if (dias < 0) {
      acumulador.error(`La fecha de emisión (${doc.fechaEmision}) no puede ser posterior a hoy (${hoy}).`);
      return;
    }

    if (contexto.tipoBase === '01' && dias > PLAZOS_ENVIO_DIAS.facturaYNotas) {
      acumulador.advertencia(
        `Han pasado ${dias} días desde la emisión: facturas y sus notas se envían hasta ${PLAZOS_ENVIO_DIAS.facturaYNotas} días calendario después (RS 000003-2023); SUNAT puede rechazarlo por presentación fuera de plazo.`,
      );
    }
    if (contexto.tipoBase === '03') {
      if (dias > PLAZOS_ENVIO_DIAS.resumenDiario) {
        acumulador.advertencia(
          `Han pasado ${dias} días desde la emisión: venció el plazo de ${PLAZOS_ENVIO_DIAS.resumenDiario} días para informar boletas y sus notas (RS 114-2019).`,
        );
      } else if (dias > PLAZOS_ENVIO_DIAS.boletaIndividual) {
        acumulador.advertencia(
          `Han pasado ${dias} días desde la emisión: el envío individual de boletas vence a los ${PLAZOS_ENVIO_DIAS.boletaIndividual} días; solo puede informarse por resumen diario (hasta el día ${PLAZOS_ENVIO_DIAS.resumenDiario}).`,
        );
      }
    }
  }
}

export class ReglaMoneda implements ReglaValidacionCpe {
  readonly nombre = 'moneda';

  validar({ doc }: ContextoValidacionCpe, acumulador: AcumuladorValidacion): void {
    if (!MONEDAS_SOPORTADAS.has(doc.moneda)) {
      acumulador.error(`La moneda "${textoLimpio(doc.moneda)}" no es soportada (PEN o USD).`);
    }
  }
}
