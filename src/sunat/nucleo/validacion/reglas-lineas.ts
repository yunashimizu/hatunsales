import {
  CATALOGO_07_AFECTACION_IGV,
  esAfectacionGratuita,
  esAfectacionOnerosa,
  esUnidadCatalogo03,
} from '../../catalogos/sunat.catalogos';
import { DecimalExacto, Dinero } from '../decimal';
import type { LineaCpe } from '../documento-fiscal.types';
import {
  AcumuladorValidacion,
  ContextoValidacionCpe,
  diferenciaCentimos,
  errorImporte,
  esNumeroFinito,
  formatoMonto,
  PATRON_CARACTERES_CONTROL,
  ReglaValidacionCpe,
  textoLimpio,
} from './base-validacion';

/** Decimales que SUNAT admite en cantidades y precios unitarios (n(12,10)). */
const DECIMALES_UNITARIOS = 10;
const LONGITUD_MAXIMA_DESCRIPCION = 500;
const LONGITUD_MAXIMA_CODIGO_INTERNO = 30;
/** SUNAT tolera ±1 en las fórmulas por ítem; por encima de eso el XML no describe la venta. */
const TOLERANCIA_FORMULA_CENTIMOS = 100;

/**
 * Cada línea: cantidad, unidad del catálogo 03, descripción, códigos,
 * afectación onerosa e importes que cuadran entre sí sin recalcular nada.
 */
export class ReglaLineas implements ReglaValidacionCpe {
  readonly nombre = 'lineas';

  validar(contexto: ContextoValidacionCpe, acumulador: AcumuladorValidacion): void {
    const { doc } = contexto;
    if (!Array.isArray(doc.lineas) || doc.lineas.length === 0) {
      acumulador.error('El comprobante debe tener al menos una línea.');
      return;
    }
    doc.lineas.forEach((linea, indice) => this.validarLinea(linea, `Línea ${indice + 1}`, contexto, acumulador));
  }

  private validarLinea(linea: LineaCpe, etiqueta: string, contexto: ContextoValidacionCpe, acumulador: AcumuladorValidacion): void {
    if (!linea || typeof linea !== 'object') {
      acumulador.error(`${etiqueta}: la línea está vacía.`);
      return;
    }
    this.validarDescripcionYCodigos(linea, etiqueta, contexto, acumulador);
    const afectacionValida = this.validarAfectacion(linea, etiqueta, acumulador);
    const importesValidos = this.validarImportes(linea, etiqueta, acumulador);
    if (afectacionValida && importesValidos) this.validarCuadre(linea, etiqueta, acumulador);
  }

  private validarDescripcionYCodigos(linea: LineaCpe, etiqueta: string, contexto: ContextoValidacionCpe, acumulador: AcumuladorValidacion): void {
    const unidad = textoLimpio(linea.unidad);
    if (!esUnidadCatalogo03(unidad)) {
      acumulador.error(`${etiqueta}: la unidad "${unidad}" no existe en el catálogo 03 de SUNAT (normalícela con normalizarUnidad).`);
    }

    const descripcion = textoLimpio(linea.descripcion);
    if (!descripcion) acumulador.error(`${etiqueta}: falta la descripción.`);
    else if (descripcion.length > LONGITUD_MAXIMA_DESCRIPCION) {
      acumulador.error(`${etiqueta}: la descripción supera los ${LONGITUD_MAXIMA_DESCRIPCION} caracteres que admite SUNAT.`);
    }
    if (PATRON_CARACTERES_CONTROL.test(String(linea.descripcion ?? ''))) {
      acumulador.error(`${etiqueta}: la descripción contiene caracteres de control no permitidos.`);
    }

    const codigoInterno = textoLimpio(linea.codigoInterno);
    if (codigoInterno.length > LONGITUD_MAXIMA_CODIGO_INTERNO) {
      acumulador.error(`${etiqueta}: el código interno supera los ${LONGITUD_MAXIMA_CODIGO_INTERNO} caracteres.`);
    }

    const codigoSunat = textoLimpio(linea.codigoSunat);
    if (codigoSunat) {
      if (!/^\d{8}$/.test(codigoSunat)) {
        acumulador.error(`${etiqueta}: el código de producto SUNAT "${codigoSunat}" debe tener exactamente 8 dígitos (catálogo 25, UNSPSC).`);
      } else if (codigoSunat.endsWith('000000')) {
        acumulador.advertencia(`${etiqueta}: el código de producto SUNAT ${codigoSunat} es un segmento genérico de UNSPSC; use el código de la clase del producto.`);
      }
    } else if (contexto.aplicarReglas2027) {
      acumulador.error(`${etiqueta}: desde el 01/01/2027 el código de producto SUNAT de 8 dígitos (catálogo 25) es obligatorio (RS 000048-2026).`);
    }
  }

  private validarAfectacion(linea: LineaCpe, etiqueta: string, acumulador: AcumuladorValidacion): boolean {
    const afectacion = textoLimpio(linea.afectacion);
    if (esAfectacionGratuita(afectacion)) {
      acumulador.error(
        `${etiqueta}: la afectación ${afectacion} (${CATALOGO_07_AFECTACION_IGV[afectacion]}) es una operación gratuita; esta operación todavía no se puede emitir desde el sistema.`,
      );
      return false;
    }
    if (afectacion === '40') {
      acumulador.error(`${etiqueta}: la afectación 40 es una exportación; esta operación todavía no se puede emitir desde el sistema.`);
      return false;
    }
    if (!esAfectacionOnerosa(afectacion)) {
      acumulador.error(`${etiqueta}: el tipo de afectación del IGV "${afectacion}" no existe (10 gravado, 20 exonerado, 30 inafecto).`);
      return false;
    }
    if (afectacion === '10') {
      const porcentaje = linea.porcentajeIgv;
      if (!esNumeroFinito(porcentaje) || porcentaje <= 0 || porcentaje >= 100) {
        acumulador.error(`${etiqueta}: el porcentaje de IGV de una línea gravada debe estar entre 0 y 100 (recibido: ${String(porcentaje)}).`);
        return false;
      }
    }
    return true;
  }

  private validarImportes(linea: LineaCpe, etiqueta: string, acumulador: AcumuladorValidacion): boolean {
    const revisiones: Array<[string, string | null]> = [
      ['la cantidad', errorImporte(linea.cantidad, { positivo: true, decimales: DECIMALES_UNITARIOS })],
      ['el valor unitario', errorImporte(linea.valorUnitario, { positivo: true, decimales: DECIMALES_UNITARIOS })],
      ['el precio de venta unitario', errorImporte(linea.precioVentaUnitario, { positivo: true, decimales: DECIMALES_UNITARIOS })],
      ['el descuento', errorImporte(linea.descuentoBase)],
      ['el valor de venta', errorImporte(linea.valorVenta, { positivo: true })],
      ['el IGV', errorImporte(linea.igv)],
      ['el total', errorImporte(linea.total, { positivo: true })],
    ];
    let validos = true;
    for (const [campo, motivo] of revisiones) {
      if (motivo) {
        acumulador.error(`${etiqueta}: ${campo} ${motivo}.`);
        validos = false;
      }
    }
    return validos;
  }

  private validarCuadre(linea: LineaCpe, etiqueta: string, acumulador: AcumuladorValidacion): void {
    const valorVenta = Dinero.de(linea.valorVenta);
    const total = Dinero.de(linea.total);

    if (!valorVenta.mas(linea.igv).igualA(total)) {
      acumulador.error(
        `${etiqueta}: valor de venta (${valorVenta}) + IGV (${formatoMonto(linea.igv)}) no es igual al total (${total}).`,
      );
    }

    if (linea.afectacion === '10') {
      const igvEsperado = valorVenta.por(DecimalExacto.de(linea.porcentajeIgv).entre(100, 6));
      if (diferenciaCentimos(linea.igv, igvEsperado.aNumero()) > 1) {
        acumulador.error(
          `${etiqueta}: el IGV (${formatoMonto(linea.igv)}) no corresponde al ${linea.porcentajeIgv}% del valor de venta (${igvEsperado}).`,
        );
      }
    } else if (!Dinero.de(linea.igv).esCero()) {
      acumulador.error(`${etiqueta}: una línea exonerada o inafecta no lleva IGV (recibido ${formatoMonto(linea.igv)}).`);
    }

    const bruto = Dinero.de(DecimalExacto.de(linea.cantidad).por(linea.valorUnitario));
    if (Dinero.de(linea.descuentoBase).mayorQue(bruto)) {
      acumulador.error(`${etiqueta}: el descuento (${formatoMonto(linea.descuentoBase)}) supera el valor bruto de la línea (${bruto}).`);
      return;
    }
    this.compararFormula(
      bruto.menos(linea.descuentoBase).aNumero(),
      linea.valorVenta,
      `${etiqueta}: cantidad × valor unitario − descuento (%esperado%) no coincide con el valor de venta (%real%, cbc:LineExtensionAmount)`,
      acumulador,
    );

    const precioPorCantidad = Dinero.de(DecimalExacto.de(linea.cantidad).por(linea.precioVentaUnitario));
    this.compararFormula(
      precioPorCantidad.aNumero(),
      linea.total,
      `${etiqueta}: cantidad × precio de venta unitario (%esperado%) no coincide con el total (%real%)`,
      acumulador,
    );
  }

  /** Error si difiere más que la tolerancia de SUNAT; advertencia si difiere más de un céntimo. */
  private compararFormula(esperado: number, real: number, plantilla: string, acumulador: AcumuladorValidacion): void {
    const diferencia = diferenciaCentimos(esperado, real);
    if (diferencia <= 1) return;
    const mensaje = plantilla.replace('%esperado%', formatoMonto(esperado)).replace('%real%', formatoMonto(real));
    if (diferencia > TOLERANCIA_FORMULA_CENTIMOS) acumulador.error(`${mensaje}.`);
    else acumulador.advertencia(`${mensaje}; SUNAT lo aceptará con observación.`);
  }
}
