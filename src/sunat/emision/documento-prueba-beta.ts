import { calcularComprobante } from '../../util/fiscal/calculo-fiscal';
import type { EmisorFiscal } from '../config/fiscal-config.tipos';
import type { DocumentoCpe, ReferenciaNotaCpe, TipoCpe } from '../nucleo/documento-fiscal.types';
import { construirLineaCpe, totalesCpeDesdeLineas } from '../nucleo/linea-cpe';
import { SERIES_BETA } from './emision.tipos';

/** Documento identificado como prueba; los importes los calcula el mismo motor del POS. */
export function crearDocumentoPruebaBeta(
  emisor: EmisorFiscal,
  tipo: TipoCpe,
  numero: number,
  ahora: Date,
  referencia?: ReferenciaNotaCpe,
): DocumentoCpe {
  const calculada = calcularComprobante([
    { cantidad: 1, precio_unitario: 1.18, descuento: 0, tipo_de_igv: 1 },
  ]).lineas[0];
  const linea = construirLineaCpe(
    {
      cantidad: calculada.cantidad,
      precioUnitario: calculada.precio_unitario,
      subtotal: calculada.subtotal,
      igv: calculada.igv,
      total: calculada.total,
      afectacion: '10',
      descuento: 0,
    },
    {
      unidad: 'NIU',
      descripcion: 'PRUEBA DE INTEGRACION SUNAT BETA - SIN VALOR TRIBUTARIO',
      codigoInterno: 'BETA-01',
    },
    18,
  );
  const fecha = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ahora);
  const hora = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Lima',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(ahora);
  const esNota = tipo === '07' || tipo === '08';
  if (esNota && !referencia) throw new Error('La nota de prueba necesita el comprobante que modifica.');
  const sobreFactura = (esNota ? referencia!.tipoDoc : tipo) === '01';
  return {
    tipo,
    serie: serieDePrueba(tipo, sobreFactura),
    numero,
    fechaEmision: fecha,
    horaEmision: hora,
    moneda: 'PEN',
    emisor: { ...emisor },
    cliente:
      sobreFactura
        ? {
            tipoDoc: '6',
            numDoc: '20131312955',
            nombre:
              'SUPERINTENDENCIA NACIONAL DE ADUANAS Y DE ADMINISTRACION TRIBUTARIA - SUNAT',
          }
        : { tipoDoc: '0', numDoc: '-', nombre: 'CLIENTES VARIOS' },
    lineas: [linea],
    totales: totalesCpeDesdeLineas([linea]),
    ...(esNota ? { referencia } : { formaPago: { tipo: 'Contado' as const } }),
  };
}

/**
 * Boleta de prueba con UNA línea de S/ 1.00 por código de unidad, para comprobar en SUNAT BETA
 * que acepta cada código nuevo del catálogo 03 (SA, RD, BR, SR, BD, CO, QT, PT, HUR, DAY).
 * Si BETA rechaza alguno, ese código se quita del catálogo y de unidades-amigables.ts.
 * No está cableada a ningún endpoint: la invoca quien corra la prueba.
 */
export function crearDocumentoPruebaUnidades(
  emisor: EmisorFiscal,
  numero: number,
  ahora: Date,
  codigos: readonly string[],
): DocumentoCpe {
  if (!codigos.length) throw new Error('Indique al menos un código de unidad para la prueba.');
  const base = crearDocumentoPruebaBeta(emisor, '03', numero, ahora);
  const lineas = codigos.map((codigo) => {
    const calculada = calcularComprobante([
      { cantidad: 1, precio_unitario: 1, descuento: 0, tipo_de_igv: 1 },
    ]).lineas[0];
    return construirLineaCpe(
      {
        cantidad: calculada.cantidad,
        precioUnitario: calculada.precio_unitario,
        subtotal: calculada.subtotal,
        igv: calculada.igv,
        total: calculada.total,
        afectacion: '10',
        descuento: 0,
      },
      {
        unidad: codigo,
        descripcion: `PRUEBA DE UNIDAD ${codigo} - SIN VALOR TRIBUTARIO`,
        codigoInterno: `BETA-${codigo}`,
      },
      18,
    );
  });
  return { ...base, lineas, totales: totalesCpeDesdeLineas(lineas) };
}

function serieDePrueba(tipo: TipoCpe, sobreFactura: boolean): string {
  if (tipo === '01') return SERIES_BETA.factura;
  if (tipo === '03') return SERIES_BETA.boleta;
  if (tipo === '07') return sobreFactura ? SERIES_BETA.nc_factura : SERIES_BETA.nc_boleta;
  return sobreFactura ? SERIES_BETA.nd_factura : SERIES_BETA.nd_boleta;
}

/** Serie BETA de cada tipo de prueba (la de las notas depende de si modifican una factura o una boleta). */
export function serieBetaDe(tipo: TipoCpe, sobreFactura = true): string {
  return serieDePrueba(tipo, sobreFactura);
}
