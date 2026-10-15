/**
 * Documentos de prueba SOLO para specs. Las líneas salen del motor real del
 * negocio (util/fiscal/calculo-fiscal.ts, precios CON IGV) y se convierten con
 * construirLineaCpe: así los specs prueban que XML = BD.
 */
import { calcularComprobante } from '../../../util/fiscal/calculo-fiscal';
import { afectacionDesdeTipoIgvNubefact } from '../../catalogos/sunat.catalogos';
import type { DocumentoCpe, EmisorCpe, LineaCpe, TotalesCpe } from '../documento-fiscal.types';
import { construirLineaCpe, totalesCpeDesdeLineas } from '../linea-cpe';

export const HOY_PRUEBA = '2026-10-13';

export const EMISOR_PRUEBA: EmisorCpe = Object.freeze({
  ruc: '20610206337',
  razonSocial: 'HATUNSALES S.A.C.',
  nombreComercial: 'HATUNSALES',
  direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN',
  ubigeo: '150119',
  distrito: 'LURIN',
  provincia: 'LIMA',
  departamento: 'LIMA',
  codigoEstablecimiento: '0000',
}) as EmisorCpe;

/** RUC real de SUNAT (dígito verificador válido): el mismo cliente que usa la prueba BETA. */
export const RUC_CLIENTE_PRUEBA = '20131312955';

export interface ItemVentaPrueba {
  descripcion: string;
  cantidad: number;
  /** Precio unitario CON IGV, como en el POS. */
  precio: number;
  /** Descuento CON IGV sobre la línea. */
  descuento?: number;
  /** Codificación del sistema: 1 gravado, 8 exonerado, 9 inafecto. */
  tipoIgv?: number;
  unidad?: string;
  codigoInterno?: string;
  codigoSunat?: string;
}

export function lineasDesdeVenta(items: ItemVentaPrueba[], porcentajeIgv = 18): { lineas: LineaCpe[]; totales: TotalesCpe } {
  const resumen = calcularComprobante(
    items.map((i) => ({ cantidad: i.cantidad, precio_unitario: i.precio, descuento: i.descuento ?? 0, tipo_de_igv: i.tipoIgv ?? 1 })),
    porcentajeIgv,
  );
  const lineas = resumen.lineas.map((linea, indice) =>
    construirLineaCpe(
      {
        cantidad: linea.cantidad,
        precioUnitario: linea.precio_unitario,
        subtotal: linea.subtotal,
        igv: linea.igv,
        total: linea.total,
        afectacion: afectacionDesdeTipoIgvNubefact(linea.tipo_de_igv),
        descuento: linea.descuento,
      },
      {
        unidad: items[indice].unidad ?? 'NIU',
        descripcion: items[indice].descripcion,
        codigoInterno: items[indice].codigoInterno,
        codigoSunat: items[indice].codigoSunat,
      },
      porcentajeIgv,
    ),
  );
  const desdeLineas = totalesCpeDesdeLineas(lineas);
  return {
    lineas,
    totales: {
      gravada: resumen.total_gravada,
      exonerada: resumen.total_exonerada,
      inafecta: resumen.total_inafecta,
      igv: resumen.total_igv,
      descuentos: desdeLineas.descuentos,
      total: resumen.total,
    },
  };
}

const ITEM_CEMENTO: ItemVentaPrueba = { descripcion: 'CEMENTO SOL TIPO I 42.5 KG', cantidad: 1, precio: 10, codigoInterno: 'P-0001' };

export function facturaPrueba(items: ItemVentaPrueba[] = [ITEM_CEMENTO], cambios: Partial<DocumentoCpe> = {}): DocumentoCpe {
  const { lineas, totales } = lineasDesdeVenta(items);
  return {
    tipo: '01',
    serie: 'FFF1',
    numero: 7,
    fechaEmision: HOY_PRUEBA,
    horaEmision: '10:30:00',
    moneda: 'PEN',
    emisor: { ...EMISOR_PRUEBA },
    cliente: { tipoDoc: '6', numDoc: RUC_CLIENTE_PRUEBA, nombre: 'SUPERINTENDENCIA NACIONAL DE ADUANAS Y DE ADMINISTRACION TRIBUTARIA - SUNAT', direccion: 'AV. GARCILASO DE LA VEGA 1472 LIMA' },
    lineas,
    totales,
    formaPago: { tipo: 'Contado' },
    ...cambios,
  };
}

export function boletaPrueba(items: ItemVentaPrueba[] = [ITEM_CEMENTO], cambios: Partial<DocumentoCpe> = {}): DocumentoCpe {
  return facturaPrueba(items, {
    tipo: '03',
    serie: 'BBB1',
    numero: 26,
    cliente: { tipoDoc: '0', numDoc: '-', nombre: 'CLIENTES VARIOS' },
    ...cambios,
  });
}

export function notaCreditoPrueba(items: ItemVentaPrueba[] = [ITEM_CEMENTO], cambios: Partial<DocumentoCpe> = {}): DocumentoCpe {
  return facturaPrueba(items, {
    tipo: '07',
    serie: 'FC01',
    numero: 1,
    formaPago: undefined,
    referencia: { tipoDoc: '01', serie: 'FFF1', numero: 7, motivo: '01', sustento: 'ANULACION DE LA OPERACION' },
    ...cambios,
  });
}

export function notaDebitoPrueba(items: ItemVentaPrueba[] = [ITEM_CEMENTO], cambios: Partial<DocumentoCpe> = {}): DocumentoCpe {
  return facturaPrueba(items, {
    tipo: '08',
    serie: 'FD01',
    numero: 1,
    formaPago: undefined,
    referencia: { tipoDoc: '01', serie: 'FFF1', numero: 7, motivo: '02', sustento: 'AUMENTO EN EL VALOR' },
    ...cambios,
  });
}
