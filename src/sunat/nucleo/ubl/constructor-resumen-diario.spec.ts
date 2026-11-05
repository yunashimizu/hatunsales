import { ConstructorResumenDiarioUbl, DatosResumenDiario, LineaResumenDiario } from './constructor-resumen-diario';

const linea = (cambios: Partial<LineaResumenDiario> = {}): LineaResumenDiario => ({
  numeroLinea: 1,
  tipoDocumento: '03',
  serie: 'BB01',
  numero: 9,
  tipoDocumentoCliente: '1',
  numeroDocumentoCliente: '00000000',
  gravada: 25.17,
  exonerada: 0,
  inafecta: 0,
  gratuita: 0,
  igv: 4.53,
  total: 29.7,
  estado: 3,
  moneda: 'PEN',
  fechaEmision: '2026-11-05',
  ...cambios,
});

const datos = (lineas: LineaResumenDiario[]): DatosResumenDiario => ({
  identificador: 'RC-20261105-00001',
  fechaGeneracion: '2026-11-05',
  fechaEmisionDocumentos: '2026-11-05',
  emisor: { ruc: '20614736420', razonSocial: 'EMPRESA DE PRUEBA S.A.C.' },
  lineas,
});

describe('ConstructorResumenDiarioUbl: tasa del IGV', () => {
  const construir = (lineas: LineaResumenDiario[]) => new ConstructorResumenDiarioUbl().construir(datos(lineas)).xml;

  it('lleva cbc:Percent dentro de la categoría del IGV, antes del esquema (SUNAT rechaza sin ella: 2992)', () => {
    const xml = construir([linea()]);
    expect(xml).toMatch(/<cac:TaxCategory>\s*<cbc:Percent>18\.00<\/cbc:Percent>\s*<cac:TaxScheme>\s*<cbc:ID>1000<\/cbc:ID>/);
  });

  it('usa la tasa de la línea cuando llega y 18 cuando no llega', () => {
    expect(construir([linea({ porcentajeIgv: 10 })])).toContain('<cbc:Percent>10.00</cbc:Percent>');
    expect(construir([linea()])).toContain('<cbc:Percent>18.00</cbc:Percent>');
  });

  it('no agrega tasa a los demás tributos (ISC, otros)', () => {
    const xml = construir([linea({ isc: 1.5, total: 31.2 })]);
    expect(xml.match(/<cbc:Percent>/g)).toHaveLength(1);
  });
});
