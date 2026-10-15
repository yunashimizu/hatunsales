import { Dinero } from '../decimal';
import type { CuotaCpe, LineaCpe } from '../documento-fiscal.types';
import { esFechaIso } from '../fechas-fiscales';
import {
  AcumuladorValidacion,
  ContextoValidacionCpe,
  diferenciaCentimos,
  errorImporte,
  formatoMonto,
  ReglaValidacionCpe,
  textoLimpio,
} from './base-validacion';

const TOLERANCIA_TOTALES_CENTIMOS = 1;
const MAXIMO_CUOTAS = 999;
/** Motivo 13 del catálogo 09: corrige el monto neto pendiente o las fechas de las cuotas. */
const MOTIVO_NC_AJUSTE_CUOTAS = '13';

function sumar(lineas: readonly LineaCpe[], campo: 'valorVenta' | 'igv' | 'total' | 'descuentoBase', afectacion?: string): number {
  return Dinero.suma(lineas.filter((l) => afectacion === undefined || l.afectacion === afectacion).map((l) => l[campo])).aNumero();
}

/** Los totales de cabecera deben ser la suma de las líneas (±0,01): el builder los escribe tal cual. */
export class ReglaTotales implements ReglaValidacionCpe {
  readonly nombre = 'totales';

  validar({ doc }: ContextoValidacionCpe, acumulador: AcumuladorValidacion): void {
    const totales = doc.totales;
    if (!totales) {
      acumulador.error('Faltan los totales del comprobante.');
      return;
    }
    const campos: Array<[keyof typeof totales, string]> = [
      ['gravada', 'el total gravado'],
      ['exonerada', 'el total exonerado'],
      ['inafecta', 'el total inafecto'],
      ['igv', 'el total de IGV'],
      ['descuentos', 'el total de descuentos'],
      ['total', 'el importe total'],
    ];
    let validos = true;
    for (const [campo, nombre] of campos) {
      const motivo = errorImporte(totales[campo], { positivo: campo === 'total' });
      if (motivo) {
        acumulador.error(`Totales: ${nombre} ${motivo}.`);
        validos = false;
      }
    }
    if (!validos || !Array.isArray(doc.lineas) || doc.lineas.length === 0) return;

    const comparaciones: Array<[string, number, number]> = [
      ['el total gravado', totales.gravada, sumar(doc.lineas, 'valorVenta', '10')],
      ['el total exonerado', totales.exonerada, sumar(doc.lineas, 'valorVenta', '20')],
      ['el total inafecto', totales.inafecta, sumar(doc.lineas, 'valorVenta', '30')],
      ['el total de IGV', totales.igv, sumar(doc.lineas, 'igv')],
      ['el importe total', totales.total, sumar(doc.lineas, 'total')],
    ];
    for (const [nombre, declarado, calculado] of comparaciones) {
      if (diferenciaCentimos(declarado, calculado) > TOLERANCIA_TOTALES_CENTIMOS) {
        acumulador.error(`Totales: ${nombre} (${formatoMonto(declarado)}) no cuadra con la suma de las líneas (${formatoMonto(calculado)}).`);
      }
    }

    const reconstruido = Dinero.suma([totales.gravada, totales.exonerada, totales.inafecta, totales.igv]);
    if (diferenciaCentimos(totales.total, reconstruido.aNumero()) > TOLERANCIA_TOTALES_CENTIMOS) {
      acumulador.error(
        `Totales: el importe total (${formatoMonto(totales.total)}) no es gravado + exonerado + inafecto + IGV (${reconstruido}).`,
      );
    }

    const descuentos = sumar(doc.lineas, 'descuentoBase');
    if (diferenciaCentimos(totales.descuentos, descuentos) > TOLERANCIA_TOTALES_CENTIMOS) {
      acumulador.advertencia(
        `Totales: los descuentos declarados (${formatoMonto(totales.descuentos)}) no coinciden con la suma de los descuentos por línea (${formatoMonto(descuentos)}).`,
      );
    }
  }
}

/**
 * Forma de pago (RS 193-2020): Contado, o Crédito con el monto neto pendiente
 * y sus cuotas (Σ cuotas = pendiente, cada una con vencimiento posterior a la
 * emisión). En notas solo la NC motivo 13 informa forma de pago.
 */
export class ReglaFormaPago implements ReglaValidacionCpe {
  readonly nombre = 'forma-pago';

  validar(contexto: ContextoValidacionCpe, acumulador: AcumuladorValidacion): void {
    const { doc } = contexto;
    const formaPago = doc.formaPago;
    const esNcAjusteCuotas = doc.tipo === '07' && textoLimpio(doc.referencia?.motivo) === MOTIVO_NC_AJUSTE_CUOTAS;

    if (contexto.esNota && !esNcAjusteCuotas) {
      if (formaPago) acumulador.advertencia('La forma de pago solo se informa en la nota de crédito motivo 13: se omitirá del XML.');
      return;
    }
    if (esNcAjusteCuotas && formaPago?.tipo !== 'Credito') {
      acumulador.error('La nota de crédito motivo 13 debe informar la forma de pago al crédito con el nuevo monto pendiente y sus cuotas.');
      return;
    }
    if (!formaPago) return;

    if (formaPago.tipo !== 'Contado' && formaPago.tipo !== 'Credito') {
      acumulador.error(`La forma de pago "${textoLimpio(formaPago.tipo)}" no existe (Contado o Credito).`);
      return;
    }
    if (formaPago.tipo === 'Contado') {
      if ((formaPago.cuotas?.length ?? 0) > 0 || formaPago.montoPendiente) {
        acumulador.advertencia('La venta al contado no lleva monto pendiente ni cuotas: se ignorarán.');
      }
      return;
    }
    this.validarCredito(contexto, acumulador);
  }

  private validarCredito({ doc, esNota }: ContextoValidacionCpe, acumulador: AcumuladorValidacion): void {
    const formaPago = doc.formaPago!;
    const motivoPendiente = errorImporte(formaPago.montoPendiente, { positivo: true });
    if (motivoPendiente) {
      acumulador.error(`Crédito: el monto neto pendiente de pago ${motivoPendiente}.`);
    } else if (!esNota && doc.totales && Dinero.de(formaPago.montoPendiente!).mayorQue(doc.totales.total)) {
      acumulador.error(
        `Crédito: el monto pendiente (${formatoMonto(formaPago.montoPendiente!)}) no puede superar el importe total (${formatoMonto(doc.totales.total)}).`,
      );
    }

    const cuotas: CuotaCpe[] = Array.isArray(formaPago.cuotas) ? formaPago.cuotas : [];
    if (cuotas.length === 0) {
      acumulador.error('Crédito: debe informar al menos una cuota con su monto y fecha de pago.');
      return;
    }
    if (cuotas.length > MAXIMO_CUOTAS) {
      acumulador.error(`Crédito: se admiten como máximo ${MAXIMO_CUOTAS} cuotas.`);
      return;
    }

    let validas = true;
    cuotas.forEach((cuota, indice) => {
      const etiqueta = `Cuota ${indice + 1}`;
      if (cuota?.numero !== undefined && cuota.numero !== indice + 1) {
        acumulador.error(`${etiqueta}: el número de cuota debe ser ${indice + 1} (las cuotas se numeran en orden: Cuota001, Cuota002…).`);
      }
      const motivo = errorImporte(cuota?.monto, { positivo: true });
      if (motivo) {
        acumulador.error(`${etiqueta}: el monto ${motivo}.`);
        validas = false;
      }
      if (!esFechaIso(cuota?.fechaPago)) {
        acumulador.error(`${etiqueta}: la fecha de pago "${textoLimpio(cuota?.fechaPago)}" no es válida (yyyy-mm-dd).`);
      } else if (esFechaIso(doc.fechaEmision) && cuota.fechaPago <= doc.fechaEmision) {
        acumulador.error(`${etiqueta}: vence el ${cuota.fechaPago} y debe ser posterior a la fecha de emisión (${doc.fechaEmision}).`);
      } else if (indice > 0 && esFechaIso(cuotas[indice - 1]?.fechaPago) && cuota.fechaPago < cuotas[indice - 1].fechaPago) {
        acumulador.advertencia(`${etiqueta}: vence antes que la cuota anterior; ordénelas por fecha de pago.`);
      }
    });

    if (validas && !motivoPendiente) {
      const suma = Dinero.suma(cuotas.map((c) => c.monto));
      if (!suma.igualA(formaPago.montoPendiente!)) {
        acumulador.error(`Crédito: la suma de las cuotas (${suma}) debe ser igual al monto pendiente (${formatoMonto(formaPago.montoPendiente!)}).`);
      }
    }
  }
}
