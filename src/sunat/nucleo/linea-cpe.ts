import { DecimalExacto, Dinero } from './decimal';
import type { AfectacionCpe, LineaCpe, TotalesCpe } from './documento-fiscal.types';

/** Decimales del valor unitario sin IGV (igual que calculo-fiscal.ts). */
export const DECIMALES_VALOR_UNITARIO = 6;
/** Decimales del precio de venta unitario (SUNAT admite hasta 10). */
export const DECIMALES_PRECIO_VENTA = 10;

/**
 * Línea tal como la guarda el negocio (comprobante_items, calculada por
 * util/fiscal/calculo-fiscal.ts): el precio INCLUYE IGV y la base se obtuvo
 * desagregando el total, nunca sumando el impuesto encima.
 */
export interface LineaCalculadaNegocio {
  cantidad: number;
  /** Precio unitario CON IGV, antes del descuento (columna P/U). */
  precioUnitario: number;
  /** Base imponible de la línea, ya neta del descuento. */
  subtotal: number;
  igv: number;
  /** Lo que paga el cliente por la línea (subtotal + igv). */
  total: number;
  afectacion: AfectacionCpe;
  /**
   * Descuento CON IGV que registró el negocio. Si llega y es 0, la línea no
   * lleva descuento aunque el redondeo de cantidad × valor unitario difiera
   * en un céntimo del subtotal (SUNAT tolera ±1 en esa fórmula).
   */
  descuento?: number;
}

export interface DatosItemCpe {
  unidad: string;
  descripcion: string;
  codigoInterno?: string;
  codigoSunat?: string;
}

function porcentajeSobreCien(porcentajeIgv: number): DecimalExacto {
  return DecimalExacto.de(100).mas(porcentajeIgv);
}

/**
 * Convierte una línea del negocio en LineaCpe sin recalcular el IGV (design
 * §7.2): el valor de venta, el IGV y el total se copian; solo se derivan
 *  - valorUnitario = precio / (1 + IGV%) a 6 decimales si es gravado (el precio tal cual si no),
 *  - descuentoBase = cantidad × valorUnitario − valorVenta (si es positivo),
 *  - precioVentaUnitario = total / cantidad (10 decimales).
 * Así el XML declara exactamente lo cobrado y lo guardado en la BD.
 */
export function construirLineaCpe(linea: LineaCalculadaNegocio, item: DatosItemCpe, porcentajeIgv: number): LineaCpe {
  const precio = DecimalExacto.de(linea.precioUnitario);
  const cantidad = DecimalExacto.de(linea.cantidad);
  const valorUnitario =
    linea.afectacion === '10' ? precio.por(100).entre(porcentajeSobreCien(porcentajeIgv), DECIMALES_VALOR_UNITARIO) : precio;
  const valorVenta = Dinero.de(linea.subtotal);
  const total = Dinero.de(linea.total);
  const bruto = Dinero.de(cantidad.por(valorUnitario));
  const diferencia = bruto.menos(valorVenta);
  const sinDescuentoDeclarado = linea.descuento !== undefined && !Dinero.de(linea.descuento).esPositivo();

  return {
    cantidad: linea.cantidad,
    unidad: item.unidad,
    descripcion: item.descripcion,
    codigoInterno: item.codigoInterno,
    codigoSunat: item.codigoSunat,
    afectacion: linea.afectacion,
    porcentajeIgv,
    valorUnitario: valorUnitario.aNumero(),
    precioVentaUnitario: cantidad.esCero() ? 0 : total.entre(cantidad, DECIMALES_PRECIO_VENTA).aNumero(),
    descuentoBase: !sinDescuentoDeclarado && diferencia.esPositivo() ? diferencia.aNumero() : 0,
    valorVenta: valorVenta.aNumero(),
    igv: Dinero.de(linea.igv).aNumero(),
    total: total.aNumero(),
  };
}

/** Línea expresada con el valor unitario SIN IGV (formato de los DTO BETA heredados). */
export interface LineaValorSinIgv {
  cantidad: number;
  /** Valor unitario sin IGV, antes del descuento. */
  valorUnitario: number;
  /** Descuento sin IGV sobre la línea. */
  descuentoBase?: number;
  afectacion: AfectacionCpe;
}

/**
 * Solo para los adaptadores BETA heredados (InvoiceUblBuilder.build y
 * NotaCreditoUblBuilder.build), cuyo precio ya viene SIN IGV: calcula la
 * base, el IGV (base × tasa) y el total como antes, pero con aritmética
 * exacta. El flujo real usa construirLineaCpe con las líneas del negocio.
 */
export function lineaCpeDesdeValorSinIgv(linea: LineaValorSinIgv, item: DatosItemCpe, porcentajeIgv: number): LineaCpe {
  const cantidad = DecimalExacto.de(linea.cantidad);
  const valorUnitario = DecimalExacto.de(linea.valorUnitario);
  const bruto = Dinero.de(cantidad.por(valorUnitario));
  const descuentoPedido = Dinero.de(linea.descuentoBase ?? 0);
  const descuento = descuentoPedido.mayorQue(bruto) ? bruto : descuentoPedido.esNegativo() ? Dinero.cero() : descuentoPedido;
  const valorVenta = bruto.menos(descuento);
  const igv = linea.afectacion === '10' ? valorVenta.por(DecimalExacto.de(porcentajeIgv).entre(100, 6)) : Dinero.cero();
  const total = valorVenta.mas(igv);

  return {
    cantidad: linea.cantidad,
    unidad: item.unidad,
    descripcion: item.descripcion,
    codigoInterno: item.codigoInterno,
    codigoSunat: item.codigoSunat,
    afectacion: linea.afectacion,
    porcentajeIgv,
    valorUnitario: valorUnitario.aNumero(),
    precioVentaUnitario: cantidad.esCero() ? 0 : total.entre(cantidad, DECIMALES_PRECIO_VENTA).aNumero(),
    descuentoBase: descuento.aNumero(),
    valorVenta: valorVenta.aNumero(),
    igv: igv.aNumero(),
    total: total.aNumero(),
  };
}

/** Totales del comprobante sumando las líneas al céntimo. */
export function totalesCpeDesdeLineas(lineas: readonly LineaCpe[]): TotalesCpe {
  const sumar = (filtro: (linea: LineaCpe) => boolean, campo: keyof Pick<LineaCpe, 'valorVenta' | 'igv' | 'total' | 'descuentoBase'>) =>
    Dinero.suma(lineas.filter(filtro).map((linea) => linea[campo])).aNumero();

  return {
    gravada: sumar((l) => l.afectacion === '10', 'valorVenta'),
    exonerada: sumar((l) => l.afectacion === '20', 'valorVenta'),
    inafecta: sumar((l) => l.afectacion === '30', 'valorVenta'),
    igv: sumar(() => true, 'igv'),
    descuentos: sumar(() => true, 'descuentoBase'),
    total: sumar(() => true, 'total'),
  };
}
