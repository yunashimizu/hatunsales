import { clasificarConsultaGre, clasificarEnvioGre, consultaSinRespuesta, crudoParaAuditoria, envioSinRespuesta, redactarSecretosGre } from './clasificador-gre';
import {
  arcCdrPrueba,
  cdrGrePrueba,
  cuerpoConsulta,
  cuerpoTicket,
  ENLACE_QR_PRUEBA,
  TICKET_PRUEBA,
} from './pruebas/respuestas-gre-prueba-spec';

const esperada = { rucEmisor: '20610206337', serie: 'T001', numero: 1 };

describe('clasificarEnvioGre', () => {
  it('200 con numTicket: TICKET_PENDIENTE para consultar luego', () => {
    const resultado = clasificarEnvioGre({ estadoHttp: 200, cuerpo: cuerpoTicket() });
    expect(resultado).toMatchObject({
      estado: 'TICKET_PENDIENTE',
      ticket: TICKET_PRUEBA,
      fechaRecepcion: '2026-10-21T10:16:00.000-05:00',
      accion: 'CONSULTAR_TICKET',
      errores: [],
      httpStatus: 200,
    });
    expect(resultado.mensaje).toContain(TICKET_PRUEBA);
  });

  it('200 sin ticket (o con un ticket raro): resultado incierto, reintentar el mismo ZIP', () => {
    expect(clasificarEnvioGre({ estadoHttp: 200, cuerpo: '{}' })).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', ticket: null });
    expect(clasificarEnvioGre({ estadoHttp: 200, cuerpo: JSON.stringify({ numTicket: '../../x' }) }).estado).toBe('PENDIENTE_REENVIO');
    expect(clasificarEnvioGre({ estadoHttp: 200, cuerpo: '<html>' }).estado).toBe('PENDIENTE_REENVIO');
  });

  it('422 con errors[{codError, desError}]: RECHAZADA sin ticket y el número no se consume', () => {
    const cuerpo = JSON.stringify({
      cod: '422',
      msg: 'Unprocessable Entity',
      errors: [
        { codError: '1001', desError: 'El campo X es obligatorio' },
        { codError: '155', desError: '' },
      ],
    });
    const resultado = clasificarEnvioGre({ estadoHttp: 422, cuerpo });
    expect(resultado.estado).toBe('RECHAZADA');
    expect(resultado.accion).toBe('CORREGIR_Y_REENVIAR');
    expect(resultado.ticket).toBeNull();
    expect(resultado.codigo).toBe('1001');
    expect(resultado.errores).toEqual([
      { codigo: '1001', descripcion: 'El campo X es obligatorio' },
      { codigo: '155', descripcion: 'El archivo ZIP está vacío' },
    ]);
    expect(resultado.mensaje).toContain('El número no se consume');
    expect(resultado.mensaje).toContain('1001 - El campo X es obligatorio');
  });

  it('422 en el formato de Greenter (errors[{cod, msg}]) también se lee', () => {
    const resultado = clasificarEnvioGre({ estadoHttp: 422, cuerpo: JSON.stringify({ errors: [{ cod: '0161', msg: 'Nombre no coincide' }] }) });
    expect(resultado.errores).toEqual([{ codigo: '0161', descripcion: 'Nombre no coincide' }]);
    expect(resultado.estado).toBe('RECHAZADA');
  });

  it('422 por RUC del usuario distinto (0154) o credenciales: ERROR_CONFIG, no es culpa de la guía', () => {
    const resultado = clasificarEnvioGre({ estadoHttp: 422, cuerpo: JSON.stringify({ errors: [{ codError: '154', desError: '' }] }) });
    expect(resultado).toMatchObject({ estado: 'ERROR_CONFIG', accion: 'REVISAR_CONFIG' });
    expect(resultado.errores[0].descripcion).toContain('RUC del archivo');
  });

  it.each([401, 403])('HTTP %i: ERROR_CONFIG', (estadoHttp) => {
    expect(clasificarEnvioGre({ estadoHttp, cuerpo: '' })).toMatchObject({ estado: 'ERROR_CONFIG', accion: 'REVISAR_CONFIG', ticket: null });
  });

  it.each([500, 502, 503, 504, 429])('HTTP %i: PENDIENTE_REENVIO (incierto)', (estadoHttp) => {
    const resultado = clasificarEnvioGre({ estadoHttp, cuerpo: JSON.stringify({ cod: String(estadoHttp), msg: 'Internal Server Error', exc: 'java.lang.NullPointerException' }) });
    expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR' });
    expect(resultado.mensaje).toContain('incierto');
  });

  it('redirección: no se sigue y la guía no se registró', () => {
    expect(clasificarEnvioGre({ estadoHttp: 302, cuerpo: '' })).toMatchObject({ estado: 'ERROR_CONFIG', accion: 'REVISAR_CONFIG' });
  });

  it('400/404: ERROR_CONFIG con el mensaje de SUNAT', () => {
    const resultado = clasificarEnvioGre({ estadoHttp: 400, cuerpo: JSON.stringify({ cod: '400', msg: 'Bad Request' }) });
    expect(resultado.estado).toBe('ERROR_CONFIG');
    expect(resultado.mensaje).toContain('400 - Bad Request');
  });
});

describe('clasificarConsultaGre', () => {
  it('codRespuesta 98: en proceso, no es error', () => {
    const resultado = clasificarConsultaGre({ estadoHttp: 200, cuerpo: cuerpoConsulta('98') });
    expect(resultado).toMatchObject({ estado: 'TICKET_PENDIENTE', accion: 'CONSULTAR_TICKET', codigo: '98', errores: [], cdr: null });
  });

  it('0 con CDR: ACEPTADA con la constancia extraída del ZIP y el enlace del QR', () => {
    const arcCdr = arcCdrPrueba();
    const resultado = clasificarConsultaGre({ estadoHttp: 200, cuerpo: cuerpoConsulta('0', { indCdrGenerado: '1', arcCdr }) }, esperada);
    expect(resultado.estado).toBe('ACEPTADA');
    expect(resultado.accion).toBe('NINGUNA');
    expect(resultado.codigo).toBe('0');
    expect(resultado.errores).toEqual([]);
    expect(resultado.observaciones).toEqual([]);
    expect(resultado.cdr?.nombre).toBe('R-20610206337-09-T001-00000001.xml');
    expect(resultado.cdr?.xml.toString('utf8')).toContain('ApplicationResponse');
    expect(resultado.cdr?.zip.subarray(0, 2).toString()).toBe('PK');
    expect(resultado.cdr?.enlaceQr).toBe(ENLACE_QR_PRUEBA);
    expect(resultado.crudo).toContain('[arcCdr omitido');
    expect(resultado.crudo).not.toContain(arcCdr.slice(0, 40));
  });

  it('0 con CDR y notas 4000+: ACEPTADA con observaciones', () => {
    const cdr = cdrGrePrueba({ notas: ['4404 - La dirección es muy corta'] });
    const resultado = clasificarConsultaGre({ estadoHttp: 200, cuerpo: cuerpoConsulta('0', { indCdrGenerado: '1', arcCdr: arcCdrPrueba(cdr) }) });
    expect(resultado.estado).toBe('ACEPTADA');
    expect(resultado.observaciones).toEqual([{ codigo: '4404', descripcion: 'La dirección es muy corta' }]);
    expect(resultado.mensaje).toContain('con observaciones');
  });

  it('0 sin constancia: sigue pendiente con el aviso de volver a consultar', () => {
    const resultado = clasificarConsultaGre({ estadoHttp: 200, cuerpo: cuerpoConsulta('0', { indCdrGenerado: '0' }) });
    expect(resultado).toMatchObject({ estado: 'TICKET_PENDIENTE', accion: 'CONSULTAR_TICKET', cdr: null });
    expect(resultado.mensaje).toBe('SUNAT la aceptó pero no entregó la constancia: vuelva a consultar.');
  });

  it('constancia ilegible: pendiente, no se da por aceptada', () => {
    const resultado = clasificarConsultaGre({ estadoHttp: 200, cuerpo: cuerpoConsulta('0', { indCdrGenerado: '1', arcCdr: 'bm8gZXMgdW4gemlw' }) });
    expect(resultado.estado).toBe('TICKET_PENDIENTE');
    expect(resultado.mensaje).toContain('no se pudo leer');
  });

  it('99 con CDR: RECHAZADA con el ResponseCode y la descripción de la constancia', () => {
    const cdr = cdrGrePrueba({ codigo: '2556', descripcion: 'Número de documento de identidad del destinatario no existe' });
    const resultado = clasificarConsultaGre({ estadoHttp: 200, cuerpo: cuerpoConsulta('99', { indCdrGenerado: '1', arcCdr: arcCdrPrueba(cdr) }) }, esperada);
    expect(resultado.estado).toBe('RECHAZADA');
    expect(resultado.accion).toBe('CORREGIR_Y_REENVIAR');
    expect(resultado.codigo).toBe('2556');
    expect(resultado.errores[0]).toEqual({ codigo: '2556', descripcion: 'Número de documento de identidad del destinatario no existe' });
    expect(resultado.cdr).not.toBeNull();
    expect(resultado.mensaje).toContain('El número no se consume');
  });

  it('99 sin CDR: RECHAZADA con error.numError y error.desError', () => {
    const resultado = clasificarConsultaGre({
      estadoHttp: 200,
      cuerpo: cuerpoConsulta('99', { indCdrGenerado: '0', error: { numError: '3401', desError: 'El peso bruto total debe ser mayor a cero' } }),
    });
    expect(resultado).toMatchObject({ estado: 'RECHAZADA', codigo: '3401', cdr: null });
    expect(resultado.errores).toEqual([{ codigo: '3401', descripcion: 'El peso bruto total debe ser mayor a cero' }]);
  });

  it('99 sin descripción: mensaje legible, sin dobles puntos', () => {
    const resultado = clasificarConsultaGre({ estadoHttp: 200, cuerpo: cuerpoConsulta('99', { error: { numError: '', desError: 'Error de estructura.' } }) });
    expect(resultado.estado).toBe('RECHAZADA');
    expect(resultado.mensaje).toContain('SUNAT rechazó la guía: Error de estructura. El número no se consume');
    expect(resultado.mensaje).not.toContain('..');
  });

  it('99 con «registrado previamente» (1033): avisa que verifique en SOL antes de reenviar', () => {
    const resultado = clasificarConsultaGre({
      estadoHttp: 200,
      cuerpo: cuerpoConsulta('99', { error: { numError: '1033', desError: 'El comprobante fue registrado previamente con otros datos' } }),
    });
    expect(resultado.estado).toBe('RECHAZADA');
    expect(resultado.mensaje).toContain('ya estaba registrada');
    expect(resultado.mensaje).toContain('SUNAT Operaciones en Línea');
  });

  it('constancia de otra guía: no se acepta ni se rechaza (cdrNoCorresponde)', () => {
    const cdr = cdrGrePrueba({ referencia: 'T001-00000099' });
    const resultado = clasificarConsultaGre({ estadoHttp: 200, cuerpo: cuerpoConsulta('0', { indCdrGenerado: '1', arcCdr: arcCdrPrueba(cdr) }) }, esperada);
    expect(resultado.estado).toBe('TICKET_PENDIENTE');
    expect(resultado.cdr).toBeNull();
    expect(resultado.cdrNoCorresponde).toContain('T001-00000099');
  });

  it('constancia de otro emisor: no corresponde', () => {
    const cdr = cdrGrePrueba({ rucEmisor: '20553856451' });
    const resultado = clasificarConsultaGre({ estadoHttp: 200, cuerpo: cuerpoConsulta('0', { indCdrGenerado: '1', arcCdr: arcCdrPrueba(cdr) }) }, esperada);
    expect(resultado.estado).toBe('TICKET_PENDIENTE');
    expect(resultado.cdrNoCorresponde).toContain('otro emisor');
  });

  it('la referencia sin ceros (T001-1) corresponde a la guía 1', () => {
    const cdr = cdrGrePrueba({ referencia: 'T001-1' });
    const resultado = clasificarConsultaGre({ estadoHttp: 200, cuerpo: cuerpoConsulta('0', { indCdrGenerado: '1', arcCdr: arcCdrPrueba(cdr) }) }, esperada);
    expect(resultado.estado).toBe('ACEPTADA');
  });

  it('codRespuesta desconocido o cuerpo ilegible: pendiente', () => {
    expect(clasificarConsultaGre({ estadoHttp: 200, cuerpo: cuerpoConsulta('77') }).estado).toBe('TICKET_PENDIENTE');
    expect(clasificarConsultaGre({ estadoHttp: 200, cuerpo: 'no es json' }).estado).toBe('TICKET_PENDIENTE');
  });

  it('5xx o 429 en la consulta: la guía sigue con su ticket (nunca se pide reenviar)', () => {
    for (const estadoHttp of [500, 503, 429]) {
      const resultado = clasificarConsultaGre({ estadoHttp, cuerpo: '' });
      expect(resultado).toMatchObject({ estado: 'TICKET_PENDIENTE', accion: 'CONSULTAR_TICKET' });
    }
  });

  it('401/403 y 422 del ticket (0509): ERROR_CONFIG con la descripción', () => {
    expect(clasificarConsultaGre({ estadoHttp: 401, cuerpo: '' }).estado).toBe('ERROR_CONFIG');
    const resultado = clasificarConsultaGre({ estadoHttp: 422, cuerpo: JSON.stringify({ errors: [{ codError: '0509', desError: '' }] }) });
    expect(resultado.estado).toBe('ERROR_CONFIG');
    expect(resultado.errores[0].descripcion).toBe('El ticket no existe o pertenece a otro RUC');
  });
});

describe('resultados sin respuesta y auditoría', () => {
  it('envío: red → PENDIENTE_REENVIO; credenciales → ERROR_CONFIG; token no disponible → reintentar (no se envió)', () => {
    expect(envioSinRespuesta('red', 'ETIMEDOUT')).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', httpStatus: null });
    expect(envioSinRespuesta('credenciales', 'invalid_grant')).toMatchObject({ estado: 'ERROR_CONFIG', accion: 'REVISAR_CONFIG' });
    expect(envioSinRespuesta('token_no_disponible', 'HTTP 503').mensaje).toContain('No se envió la guía');
  });

  it('consulta sin respuesta: la guía sigue con su ticket', () => {
    expect(consultaSinRespuesta('red', 'ECONNRESET')).toMatchObject({ estado: 'TICKET_PENDIENTE', accion: 'CONSULTAR_TICKET', cdr: null });
    expect(consultaSinRespuesta('credenciales', 'x').estado).toBe('ERROR_CONFIG');
  });

  it('redacta tokens y claves y trunca a 20 KB', () => {
    const texto = 'Authorization: Bearer abc.def.ghi client_secret=S3cr3t0&password=Clave123 {"access_token":"tok-123"}';
    const limpio = redactarSecretosGre(texto);
    expect(limpio).not.toMatch(/abc\.def|S3cr3t0|Clave123|tok-123/);
    expect(crudoParaAuditoria('x'.repeat(30_000)).length).toBeLessThan(21_000);
  });
});
