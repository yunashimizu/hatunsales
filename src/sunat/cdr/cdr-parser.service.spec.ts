import { estadoPorCodigoCdr, leerCdr, separarObservacion } from '../nucleo/cdr/lector-cdr';
import { cdrPrueba } from '../nucleo/pruebas/respuestas-sunat-prueba-spec';
import { CdrParserService } from './cdr-parser.service';

describe('CdrParserService', () => {
  const parser = new CdrParserService();

  it('CDR 0 sin notas → ACEPTADO', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ResponseCode>0</cbc:ResponseCode>
  <cbc:Description>La Factura numero F001-1 ha sido aceptada.</cbc:Description>
</ApplicationResponse>`;

    const result = parser.parse(xml);

    expect(result.codigo).toBe('0');
    expect(result.descripcion).toContain('aceptada');
    expect(result.estado).toBe('ACEPTADO');
    expect(result.observaciones).toEqual([]);
    expect(result.rawXml).toBe(xml);
  });

  it('CDR real con DocumentResponse/Response y ResponseCode con atributos', () => {
    const result = parser.parse(cdrPrueba({ codigo: '0', descripcion: 'La Factura numero FFF1-7, ha sido aceptada', conAtributos: true }));
    expect(result.codigo).toBe('0');
    expect(result.descripcion).toBe('La Factura numero FFF1-7, ha sido aceptada');
    expect(result.estado).toBe('ACEPTADO');
    expect(result.referencia).toBe('FFF1-7');
  });

  it('CDR 0 con notas → ACEPTADO_CON_OBSERVACIONES, con las notas separadas en código y texto', () => {
    const result = parser.parse(
      cdrPrueba({
        codigo: '0',
        descripcion: 'La Factura numero FFF1-7, ha sido aceptada',
        notas: ['4252 - El dato ingresado como atributo @listName es incorrecto.', '4093 - El código de ubigeo del domicilio fiscal del emisor no es válido'],
      }),
    );
    expect(result.estado).toBe('ACEPTADO_CON_OBSERVACIONES');
    expect(result.observaciones).toEqual([
      '4252 - El dato ingresado como atributo @listName es incorrecto.',
      '4093 - El código de ubigeo del domicilio fiscal del emisor no es válido',
    ]);
    expect(result.observacionesDetalle).toEqual([
      { codigo: '4252', descripcion: 'El dato ingresado como atributo @listName es incorrecto.' },
      { codigo: '4093', descripcion: 'El código de ubigeo del domicilio fiscal del emisor no es válido' },
    ]);
  });

  it('código 4000 o mayor es una observación: el comprobante está ACEPTADO (antes se marcaba como rechazo)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ApplicationResponse><ResponseCode>4000</ResponseCode><Description>Observado</Description></ApplicationResponse>`;

    const result = parser.parse(xml);

    expect(result.estado).toBe('ACEPTADO_CON_OBSERVACIONES');
    expect(result.codigo).toBe('4000');
  });

  it('2335 (documento alterado) → RECHAZADO', () => {
    const result = parser.parse(cdrPrueba({ codigo: '2335', descripcion: 'El documento electrónico ingresado ha sido alterado', conAtributos: true }));
    expect(result.estado).toBe('RECHAZADO');
    expect(result.codigo).toBe('2335');
  });

  it('2001–2004 también son rechazos (antes se tomaban como aceptados)', () => {
    expect(parser.parse(cdrPrueba({ codigo: '2001', descripcion: 'x' })).estado).toBe('RECHAZADO');
    expect(parser.parse(cdrPrueba({ codigo: '3244', descripcion: 'x', notas: ['4252 - y'] })).estado).toBe('RECHAZADO');
  });

  it('0100–1999 es excepción (comprobante no informado)', () => {
    expect(parser.parse(cdrPrueba({ codigo: '1033', descripcion: 'El comprobante fue registrado previamente' })).estado).toBe('EXCEPCION');
    expect(parser.parse(cdrPrueba({ codigo: '0130', descripcion: 'x' })).estado).toBe('EXCEPCION');
  });

  it('respuesta sin ApplicationResponse → ESTADO_DESCONOCIDO', () => {
    const result = parser.parse('<html>Service Unavailable</html>');
    expect(result.estado).toBe('ESTADO_DESCONOCIDO');
    expect(result.codigo).toBe('ERROR');
    expect(parser.parse('<ApplicationResponse><sin-cerrar></ApplicationResponse>').estado).toBe('ESTADO_DESCONOCIDO');
  });
});

describe('lector de CDR del núcleo', () => {
  it('separarObservacion', () => {
    expect(separarObservacion('4252 - El dato ingresado')).toEqual({ codigo: '4252', descripcion: 'El dato ingresado' });
    expect(separarObservacion('  4093-Ubigeo  ')).toEqual({ codigo: '4093', descripcion: 'Ubigeo' });
    expect(separarObservacion('Texto sin código')).toEqual({ codigo: '', descripcion: 'Texto sin código' });
  });

  it('estadoPorCodigoCdr usa los rangos oficiales', () => {
    expect(estadoPorCodigoCdr('0')).toBe('ACEPTADO');
    expect(estadoPorCodigoCdr('0', [{ codigo: '4252', descripcion: 'x' }])).toBe('ACEPTADO_CON_OBSERVACIONES');
    expect(estadoPorCodigoCdr('4287')).toBe('ACEPTADO_CON_OBSERVACIONES');
    expect(estadoPorCodigoCdr('3999')).toBe('RECHAZADO');
    expect(estadoPorCodigoCdr('2000')).toBe('RECHAZADO');
    expect(estadoPorCodigoCdr('1999')).toBe('EXCEPCION');
    expect(estadoPorCodigoCdr('0100')).toBe('EXCEPCION');
    expect(estadoPorCodigoCdr('99')).toBe('ESTADO_DESCONOCIDO');
    expect(estadoPorCodigoCdr('ERROR')).toBe('ESTADO_DESCONOCIDO');
  });

  it('lee la fecha y hora de respuesta', () => {
    const cdr = leerCdr(cdrPrueba({ codigo: '0', descripcion: 'ok' }));
    expect(cdr.fechaRespuesta).toBe('2026-10-13');
    expect(cdr.horaRespuesta).toBe('10:30:05');
  });
});
