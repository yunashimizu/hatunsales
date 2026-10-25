import { calcularComprobante } from '../../util/fiscal/calculo-fiscal';
import type { EmisorFiscal } from '../config/fiscal-config.tipos';
import type { DocumentoCpe } from '../nucleo/documento-fiscal.types';
import { construirLineaCpe, totalesCpeDesdeLineas } from '../nucleo/linea-cpe';
import { SERIES_BETA } from './emision.tipos';

/** Documento identificado como prueba; los importes los calcula el mismo motor del POS. */
export function crearDocumentoPruebaBeta(
  emisor: EmisorFiscal,
  tipo: '01' | '03',
  numero: number,
  ahora: Date,
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
  return {
    tipo,
    serie: tipo === '01' ? SERIES_BETA.factura : SERIES_BETA.boleta,
    numero,
    fechaEmision: fecha,
    horaEmision: hora,
    moneda: 'PEN',
    emisor: { ...emisor },
    cliente:
      tipo === '01'
        ? {
            tipoDoc: '6',
            numDoc: '20131312955',
            nombre:
              'SUPERINTENDENCIA NACIONAL DE ADUANAS Y DE ADMINISTRACION TRIBUTARIA - SUNAT',
          }
        : { tipoDoc: '0', numDoc: '-', nombre: 'CLIENTES VARIOS' },
    lineas: [linea],
    totales: totalesCpeDesdeLineas([linea]),
    formaPago: { tipo: 'Contado' },
  };
}
