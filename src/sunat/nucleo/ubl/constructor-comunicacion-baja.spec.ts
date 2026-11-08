import { BajaInvalidaError } from '../errores-nucleo';
import {
  bajaDentroDePlazo,
  ConstructorComunicacionBajaUbl,
  DatosComunicacionBaja,
  LineaComunicacionBaja,
  MAXIMO_LINEAS_BAJA,
} from './constructor-comunicacion-baja';

const linea = (cambios: Partial<LineaComunicacionBaja> = {}): LineaComunicacionBaja => ({
  numeroLinea: 1,
  tipoDocumento: '01',
  serie: 'F001',
  numero: 12,
  motivo: 'Error en el RUC del cliente',
  ...cambios,
});

const datos = (cambios: Partial<DatosComunicacionBaja> = {}): DatosComunicacionBaja => ({
  identificador: 'RA-20261105-00001',
  fechaGeneracion: '2026-11-05',
  fechaEmisionDocumentos: '2026-11-03',
  emisor: { ruc: '20614736420', razonSocial: 'EMPRESA DE PRUEBA S.A.C.' },
  lineas: [linea()],
  ...cambios,
});

describe('ConstructorComunicacionBajaUbl: XML', () => {
  const constructor = new ConstructorComunicacionBajaUbl();

  it('arma el VoidedDocuments con versión UBL 2.0, personalización 1.0, fechas e identificador', () => {
    const { xml, identificador, nombreBase } = constructor.construir(datos());
    expect(xml).toContain('<VoidedDocuments');
    expect(xml).toContain('<cbc:UBLVersionID>2.0</cbc:UBLVersionID>');
    expect(xml).toContain('<cbc:CustomizationID>1.0</cbc:CustomizationID>');
    expect(xml).toContain('<cbc:ID>RA-20261105-00001</cbc:ID>');
    expect(xml).toContain('<cbc:ReferenceDate>2026-11-03</cbc:ReferenceDate>');
    expect(xml).toContain('<cbc:IssueDate>2026-11-05</cbc:IssueDate>');
    expect(identificador).toBe('RA-20261105-00001');
    expect(nombreBase).toBe('20614736420-RA-20261105-00001');
  });

  it('cada documento va en su VoidedDocumentsLine con tipo, serie, número y motivo', () => {
    const { xml } = constructor.construir(
      datos({ lineas: [linea(), linea({ numeroLinea: 2, tipoDocumento: '07', serie: 'FC01', numero: 5, motivo: 'Se duplicó' })] }),
    );
    expect(xml.match(/<sac:VoidedDocumentsLine>/g)).toHaveLength(2);
    expect(xml).toContain('<cbc:LineID>2</cbc:LineID>');
    expect(xml).toContain('<cbc:DocumentTypeCode>01</cbc:DocumentTypeCode>');
    expect(xml).toContain('<cbc:DocumentTypeCode>07</cbc:DocumentTypeCode>');
    expect(xml).toContain('<sac:DocumentSerialID>FC01</sac:DocumentSerialID>');
    expect(xml).toContain('<sac:DocumentNumberID>5</sac:DocumentNumberID>');
    expect(xml).toContain('<sac:VoidReasonDescription>Se duplicó</sac:VoidReasonDescription>');
  });

  it('deja el espacio para la firma y los datos del emisor', () => {
    const { xml } = constructor.construir(datos());
    expect(xml).toContain('<ext:UBLExtensions>');
    expect(xml).toContain('20614736420');
    expect(xml).toContain('EMPRESA DE PRUEBA S.A.C.');
  });

  it('recorta los espacios del motivo y escapa los caracteres especiales del XML', () => {
    const { xml } = constructor.construir(datos({ lineas: [linea({ motivo: '  Cliente & "Hnos" <error>  ' })] }));
    expect(xml).toContain('<sac:VoidReasonDescription>Cliente &amp; ');
    expect(xml).toContain('&lt;error&gt;</sac:VoidReasonDescription>');
  });

  it('una baja inválida lanza BajaInvalidaError con la lista de motivos', () => {
    expect.assertions(3);
    try {
      constructor.construir(datos({ lineas: [] }));
    } catch (error) {
      expect(error).toBeInstanceOf(BajaInvalidaError);
      expect((error as BajaInvalidaError).errores).toEqual(['La comunicación de baja debe tener al menos una línea.']);
      expect((error as BajaInvalidaError).message).toContain('no es válida');
    }
  });
});

describe('ConstructorComunicacionBajaUbl: validación', () => {
  const constructor = new ConstructorComunicacionBajaUbl();

  it('una baja correcta no tiene errores', () => {
    expect(constructor.validar(datos())).toEqual([]);
  });

  it('las boletas no van por baja: lo dice con la condición 3 del resumen diario', () => {
    const errores = constructor.validar(datos({ lineas: [linea({ serie: 'B001' })] }));
    expect(errores).toHaveLength(1);
    expect(errores[0]).toMatch(/boleta.*resumen diario \(condición 3\)/);
  });

  it('solo admite factura (01) y notas (07, 08); rechaza serie mal formada y números fuera de rango', () => {
    expect(constructor.validar(datos({ lineas: [linea({ tipoDocumento: '03' as never })] }))[0]).toMatch(/solo se dan de baja facturas/);
    expect(constructor.validar(datos({ lineas: [linea({ serie: 'XX1' })] }))[0]).toMatch(/serie "XX1" no es válida/);
    expect(constructor.validar(datos({ lineas: [linea({ numero: 0 })] }))[0]).toMatch(/número del documento/);
    expect(constructor.validar(datos({ lineas: [linea({ numero: 100_000_000 })] }))[0]).toMatch(/número del documento/);
  });

  it('exige motivo (máximo 100 caracteres y sin caracteres de control)', () => {
    expect(constructor.validar(datos({ lineas: [linea({ motivo: '   ' })] }))[0]).toMatch(/falta el motivo/);
    expect(constructor.validar(datos({ lineas: [linea({ motivo: 'x'.repeat(101) })] }))[0]).toMatch(/supera los 100/);
    expect(constructor.validar(datos({ lineas: [linea({ motivo: 'Error\u0007' })] })).join(' ')).toMatch(/caracteres de control/);
  });

  it('detecta documentos repetidos y números de línea repetidos', () => {
    const errores = constructor.validar(datos({ lineas: [linea(), linea()] }));
    expect(errores.join(' | ')).toMatch(/número de línea debe ser un entero positivo y único/);
    expect(errores.join(' | ')).toMatch(/está repetido/);
  });

  it('el identificador debe ser RA con la fecha de generación', () => {
    expect(constructor.validar(datos({ identificador: 'RC-20261105-00001' }))[0]).toMatch(/formato RA/);
    expect(constructor.validar(datos({ identificador: 'RA-20261104-00001' }))[0]).toMatch(/fecha de generación \(2026-11-05\)/);
    expect(constructor.validar(datos({ identificador: 'basura' }))[0]).toMatch(/formato RA/);
  });

  it('valida las fechas: formato, generación no anterior a la emisión y plazo de 7 días', () => {
    expect(constructor.validar(datos({ fechaGeneracion: '05/11/2026' })).join(' ')).toMatch(/fecha de generación de la baja no es válida/);
    expect(constructor.validar(datos({ fechaEmisionDocumentos: '2026-02-30' })).join(' ')).toMatch(/fecha de emisión de los documentos no es válida/);
    expect(
      constructor.validar(datos({ identificador: 'RA-20261101-00001', fechaGeneracion: '2026-11-01', fechaEmisionDocumentos: '2026-11-03' }))[0],
    ).toMatch(/anterior a la emisión/);
    const tarde = constructor.validar(datos({ fechaGeneracion: '2026-11-11', identificador: 'RA-20261111-00001', fechaEmisionDocumentos: '2026-11-03' }));
    expect(tarde[0]).toMatch(/vence a los 7 días calendario.*nota de crédito/);
  });

  it('valida al emisor (RUC de 11 dígitos y razón social) y el máximo de líneas', () => {
    expect(constructor.validar(datos({ emisor: { ruc: '123', razonSocial: 'X' } }))[0]).toMatch(/11 dígitos/);
    expect(constructor.validar(datos({ emisor: { ruc: '20614736420', razonSocial: '  ' } }))[0]).toMatch(/razón social/);
    const muchas = Array.from({ length: MAXIMO_LINEAS_BAJA + 1 }, (_, i) => linea({ numeroLinea: i + 1, numero: i + 1 }));
    expect(constructor.validar(datos({ lineas: muchas })).join(' ')).toMatch(/máximo 500 líneas/);
  });

  it('sin datos devuelve un único mensaje claro', () => {
    expect(constructor.validar(undefined as never)).toEqual(['No se recibieron los datos de la comunicación de baja.']);
  });
});

describe('bajaDentroDePlazo', () => {
  it('vale de la emisión (día 0) hasta el 7.º día calendario, ambos incluidos', () => {
    expect(bajaDentroDePlazo('2026-11-03', '2026-11-03')).toBe(true);
    expect(bajaDentroDePlazo('2026-11-03', '2026-11-10')).toBe(true);
    expect(bajaDentroDePlazo('2026-11-03', '2026-11-11')).toBe(false);
  });

  it('una fecha de emisión futura o inválida no está en plazo', () => {
    expect(bajaDentroDePlazo('2026-11-05', '2026-11-03')).toBe(false);
    expect(bajaDentroDePlazo('no-es-fecha', '2026-11-03')).toBe(false);
  });

  it('cuenta los días a través del fin de mes y de año', () => {
    expect(bajaDentroDePlazo('2026-12-28', '2027-01-04')).toBe(true);
    expect(bajaDentroDePlazo('2026-12-28', '2027-01-05')).toBe(false);
  });
});
