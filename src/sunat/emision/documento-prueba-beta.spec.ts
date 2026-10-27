import { esUnidadCatalogo03 } from '../catalogos/sunat.catalogos';
import type { EmisorFiscal } from '../config/fiscal-config.tipos';
import { crearDocumentoPruebaUnidades } from './documento-prueba-beta';

const EMISOR: EmisorFiscal = {
  ruc: '20000000001',
  razonSocial: 'EMPRESA DE PRUEBA SAC',
  direccion: 'AV. PRUEBA 123',
  ubigeo: '150101',
  distrito: 'LIMA',
  provincia: 'LIMA',
  departamento: 'LIMA',
  codigoEstablecimiento: '0000',
};
const AHORA = new Date('2026-10-27T15:00:00Z');
const NUEVOS = ['SA', 'RD', 'BR', 'SR', 'BD', 'CO', 'QT', 'PT', 'HUR', 'DAY'];

describe('crearDocumentoPruebaUnidades', () => {
  it('genera una línea por código, en el mismo orden y con la unidad indicada', () => {
    const doc = crearDocumentoPruebaUnidades(EMISOR, 5, AHORA, NUEVOS);
    expect(doc.tipo).toBe('03');
    expect(doc.numero).toBe(5);
    expect(doc.lineas).toHaveLength(NUEVOS.length);
    expect(doc.lineas.map((l) => l.unidad)).toEqual(NUEVOS);
  });

  it('cada línea vale S/ 1.00 y los totales suman', () => {
    const doc = crearDocumentoPruebaUnidades(EMISOR, 1, AHORA, NUEVOS);
    for (const linea of doc.lineas) expect(linea.total).toBe(1);
    expect(doc.totales.total).toBeCloseTo(NUEVOS.length, 2);
    expect(doc.totales.gravada + doc.totales.igv).toBeCloseTo(doc.totales.total, 2);
    const sumaLineas = doc.lineas.reduce((acc, l) => acc + l.total, 0);
    expect(doc.totales.total).toBeCloseTo(sumaLineas, 2);
  });

  it('los códigos de prueba están todos en el catálogo 03 y no repiten descripción', () => {
    const doc = crearDocumentoPruebaUnidades(EMISOR, 1, AHORA, NUEVOS);
    expect(doc.lineas.every((l) => esUnidadCatalogo03(l.unidad))).toBe(true);
    expect(new Set(doc.lineas.map((l) => l.descripcion)).size).toBe(NUEVOS.length);
  });

  it('sin códigos no arma el documento', () => {
    expect(() => crearDocumentoPruebaUnidades(EMISOR, 1, AHORA, [])).toThrow();
  });
});
