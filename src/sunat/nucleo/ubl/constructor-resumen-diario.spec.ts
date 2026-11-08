import { ResumenInvalidoError } from '../errores-nucleo';
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

describe('ConstructorResumenDiarioUbl: resumen de adición (condición 1)', () => {
  const constructor = new ConstructorResumenDiarioUbl();
  const adicion = (cambios: Partial<LineaResumenDiario> = {}) => linea({ estado: 1, ...cambios });
  const construir = (lineas: LineaResumenDiario[], cambios: Partial<DatosResumenDiario> = {}) => constructor.construir({ ...datos(lineas), ...cambios });

  it('una boleta: lleva la condición 1, el tipo 03 y el número con ocho dígitos', () => {
    const { xml, nombreBase } = construir([adicion()]);
    expect(xml).toMatch(/<cac:Status>\s*<cbc:ConditionCode>1<\/cbc:ConditionCode>\s*<\/cac:Status>/);
    expect(xml).toContain('<cbc:DocumentTypeCode>03</cbc:DocumentTypeCode>');
    expect(xml).toContain('<cbc:ID>BB01-00000009</cbc:ID>');
    expect(xml).not.toContain('<cac:BillingReference>');
    expect(nombreBase).toBe('20614736420-RC-20261105-00001');
  });

  it('varias boletas: una SummaryDocumentsLine por boleta con su número de línea', () => {
    const { xml } = construir([adicion({ numeroLinea: 1, numero: 9 }), adicion({ numeroLinea: 2, numero: 10 }), adicion({ numeroLinea: 3, numero: 11 })]);
    expect(xml.match(/<sac:SummaryDocumentsLine>/g)).toHaveLength(3);
    expect(xml).toContain('<cbc:LineID>3</cbc:LineID>');
    expect(xml).toContain('<cbc:ID>BB01-00000011</cbc:ID>');
    expect(xml.match(/<cbc:ConditionCode>1<\/cbc:ConditionCode>/g)).toHaveLength(3);
  });

  it('nota de crédito de serie B: informa la boleta que modifica', () => {
    const { xml } = construir([
      adicion({ tipoDocumento: '07', serie: 'BC01', numero: 3, documentoModificado: { tipoDocumento: '03', serie: 'BB01', numero: 9 } }),
    ]);
    expect(xml).toContain('<cbc:DocumentTypeCode>07</cbc:DocumentTypeCode>');
    expect(xml).toMatch(/<cac:BillingReference>\s*<cac:InvoiceDocumentReference>\s*<cbc:ID>BB01-00000009<\/cbc:ID>\s*<cbc:DocumentTypeCode>03<\/cbc:DocumentTypeCode>/);
  });

  it('una nota sin la boleta que modifica no se puede informar', () => {
    expect(() => construir([adicion({ tipoDocumento: '07', serie: 'BC01', numero: 3 })])).toThrow(/boleta que modifica/);
  });

  it('boleta con ventas gravadas y exoneradas: un BillingPayment por tipo de operación', () => {
    const { xml } = construir([adicion({ gravada: 10, exonerada: 5, igv: 1.8, total: 16.8 })]);
    expect(xml).toMatch(/<cbc:PaidAmount currencyID="PEN">10\.00<\/cbc:PaidAmount>\s*<cbc:InstructionID>01<\/cbc:InstructionID>/);
    expect(xml).toMatch(/<cbc:PaidAmount currencyID="PEN">5\.00<\/cbc:PaidAmount>\s*<cbc:InstructionID>02<\/cbc:InstructionID>/);
    expect(xml.match(/<sac:BillingPayment>/g)).toHaveLength(2);
  });

  it('boleta solo inafecta: informa la operación 03 y un IGV de cero', () => {
    const { xml } = construir([adicion({ gravada: 0, inafecta: 20, igv: 0, total: 20 })]);
    expect(xml).toMatch(/<cbc:PaidAmount currencyID="PEN">20\.00<\/cbc:PaidAmount>\s*<cbc:InstructionID>03<\/cbc:InstructionID>/);
    expect(xml).toMatch(/<cbc:TaxAmount currencyID="PEN">0\.00<\/cbc:TaxAmount>/);
  });

  it('boleta con descuento global: informa los importes ya descontados y su total', () => {
    // 100.00 con IGV − 10.00 de descuento = 90.00 → base 76.27 + IGV 13.73
    const { xml } = construir([adicion({ gravada: 76.27, igv: 13.73, total: 90 })]);
    expect(xml).toContain('<sac:TotalAmount currencyID="PEN">90.00</sac:TotalAmount>');
    expect(xml).toMatch(/<cbc:PaidAmount currencyID="PEN">76\.27<\/cbc:PaidAmount>/);
    expect(xml).toMatch(/<cbc:TaxAmount currencyID="PEN">13\.73<\/cbc:TaxAmount>/);
  });

  it('cliente sin documento: va el tipo 0 y un guion', () => {
    const { xml } = construir([adicion({ tipoDocumentoCliente: '0', numeroDocumentoCliente: '' })]);
    expect(xml).toMatch(/<cbc:CustomerAssignedAccountID>-<\/cbc:CustomerAssignedAccountID>\s*<cbc:AdditionalAccountID>0<\/cbc:AdditionalAccountID>/);
  });

  it('fecha de referencia distinta de la de generación: ReferenceDate es la emisión y el identificador lleva la generación', () => {
    const { xml, identificador } = construir([adicion({ fechaEmision: '2026-11-03' })], {
      fechaEmisionDocumentos: '2026-11-03',
      fechaGeneracion: '2026-11-05',
      identificador: 'RC-20261105-00002',
    });
    expect(xml).toContain('<cbc:ReferenceDate>2026-11-03</cbc:ReferenceDate>');
    expect(xml).toContain('<cbc:IssueDate>2026-11-05</cbc:IssueDate>');
    expect(identificador).toBe('RC-20261105-00002');
  });

  it('el identificador debe llevar la fecha de generación, no la de emisión de las boletas', () => {
    const errores = constructor.validar({ ...datos([adicion({ fechaEmision: '2026-11-03' })]), fechaEmisionDocumentos: '2026-11-03', identificador: 'RC-20261103-00001' });
    expect(errores.join(' ')).toContain('debe llevar la fecha de generación');
  });

  it('rechaza una línea con otra fecha de emisión y un resumen fuera de los 7 días', () => {
    expect(constructor.validar(datos([adicion({ fechaEmision: '2026-11-04' })])).join(' ')).toContain('todas las líneas deben ser del 2026-11-05');
    const tarde = constructor.validar({ ...datos([adicion({ fechaEmision: '2026-10-28' })]), fechaEmisionDocumentos: '2026-10-28' });
    expect(tarde.join(' ')).toContain('hasta 7 días');
  });

  it('rechaza una factura: el resumen solo informa boletas y sus notas', () => {
    expect(constructor.validar(datos([adicion({ serie: 'F001' })])).join(' ')).toContain('debe empezar con B');
  });

  it('rechaza la misma boleta repetida', () => {
    expect(constructor.validar(datos([adicion({ numeroLinea: 1 }), adicion({ numeroLinea: 2 })])).join(' ')).toContain('está repetido');
  });

  it('más de 500 líneas → error, y 500 exactas se aceptan', () => {
    const muchas = (n: number) => Array.from({ length: n }, (_, i) => adicion({ numeroLinea: i + 1, numero: i + 1 }));
    expect(() => construir(muchas(501))).toThrow(ResumenInvalidoError);
    expect(constructor.validar(datos(muchas(500)))).toEqual([]);
  });
});
