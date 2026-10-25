import { ClasificadorRespuestaSunat } from '../clasificador-respuesta';
import {
  cdrPrueba,
  respuestaFault,
  respuestaGetStatus,
  respuestaGetStatusCdr,
  respuestaSendBill,
} from '../pruebas/respuestas-sunat-prueba-spec';
import { origenDelFault } from './lector-respuesta-soap';
import {
  CODIGO_CONSULTA_NO_ADMITIDA,
  ConfiguracionClienteSoap,
  ESTADOS_CONSULTA_SUNAT,
  LIMITE_RAW_BYTES,
  SunatSoapClient,
  TIMEOUT_POS_MS,
} from './sunat-soap-client';
import { ErrorTransporteSoap, PeticionSoap, RespuestaHttpSoap, TransporteSoap } from './transporte-soap';

const CREDENCIALES = {
  usuario: '20123456789MODDATOS',
  clave: 'CLAVE<PRUEBA&SEGURA',
};

function crearCliente(
  ambiente: ConfiguracionClienteSoap['ambiente'] = 'beta',
  transporte = { enviar: jest.fn() },
  opciones: Partial<ConfiguracionClienteSoap> = {},
  esperar = jest.fn().mockResolvedValue(undefined),
) {
  const cliente = new SunatSoapClient(
    {
      ...CREDENCIALES,
      ambiente,
      endpointBill: 'http://127.0.0.1:8080/bill',
      ...(ambiente === 'produccion'
        ? { endpointConsulta: 'http://127.0.0.1:8080/consulta' }
        : {}),
      ...opciones,
    },
    { transporte: transporte as TransporteSoap, esperar },
  );
  return { cliente, transporte, esperar };
}

describe('SunatSoapClient: contrato del transporte BETA y consultas', () => {
  it('envía el XML SOAP esperado con acción y timeout configurados, y conserva el CDR', async () => {
    const cdr = cdrPrueba({ codigo: '0', descripcion: 'Aceptada' });
    const transporte = {
      enviar: jest.fn().mockResolvedValue({
        estadoHttp: 200,
        cuerpo: respuestaSendBill(cdr),
      }),
    };
    const { cliente } = crearCliente('beta', transporte, { timeoutMs: 7_500 });

    const resultado = await cliente.enviarComprobante(
      '20123456789-01-FFF1-00000001.zip',
      'UEsDBA==',
    );

    const peticion = transporte.enviar.mock.calls[0][0] as PeticionSoap;
    expect(peticion).toMatchObject({
      url: 'http://127.0.0.1:8080/bill',
      soapAction: '"urn:sendBill"',
      timeoutMs: 7_500,
    });
    expect(peticion.cuerpo).toContain('<ser:sendBill>');
    expect(peticion.cuerpo).toContain('<fileName>20123456789-01-FFF1-00000001.zip</fileName>');
    expect(peticion.cuerpo).toContain('<contentFile>UEsDBA==</contentFile>');
    expect(peticion.cuerpo).toContain('CLAVE&lt;PRUEBA&amp;SEGURA');
    expect(resultado).toMatchObject({
      tipo: 'CDR',
      codigo: '0',
      httpStatus: 200,
      cdrXml: cdr,
    });
    expect(resultado.cdrZip).toBeInstanceOf(Buffer);
  });

  it.each([
    ['sendBill', (cliente: SunatSoapClient) => cliente.enviarComprobante('a.zip', 'zip')],
    ['sendSummary', (cliente: SunatSoapClient) => cliente.enviarResumen('a.zip', 'zip')],
  ] as const)(
    'no reintenta automáticamente la operación de envío %s ante timeout',
    async (_metodo, ejecutar) => {
      const transporte = {
        enviar: jest
          .fn()
          .mockRejectedValue(new ErrorTransporteSoap('ETIMEDOUT', 'Timeout')),
      };
      const { cliente, esperar } = crearCliente(
        'beta',
        transporte,
        { reintentosConsulta: 3 },
      );

      const resultado = await ejecutar(cliente);

      expect(resultado).toMatchObject({
        tipo: 'TRANSPORTE',
        codigo: 'ETIMEDOUT',
      });
      expect(transporte.enviar).toHaveBeenCalledTimes(1);
      expect(esperar).not.toHaveBeenCalled();
    },
  );

  it('reintenta una consulta idempotente una vez y devuelve el estado normalizado', async () => {
    const transporte = {
      enviar: jest
        .fn()
        .mockRejectedValueOnce(new ErrorTransporteSoap('ECONNRESET', 'Conexión reiniciada'))
        .mockResolvedValueOnce({
          estadoHttp: 200,
          cuerpo: respuestaGetStatus('0011'),
        }),
    };
    const { cliente, esperar } = crearCliente(
      'produccion',
      transporte,
      { reintentosConsulta: 1 },
    );

    const resultado = await cliente.consultarValidez(
      '20123456789',
      '01',
      'FFF1',
      1,
    );

    expect(transporte.enviar).toHaveBeenCalledTimes(2);
    expect(esperar).toHaveBeenCalledWith(300);
    expect(transporte.enviar.mock.calls[0][0]).toMatchObject({
      url: 'http://127.0.0.1:8080/consulta',
      soapAction: '"urn:getStatus"',
      timeoutMs: TIMEOUT_POS_MS,
    });
    expect(resultado).toMatchObject({
      tipo: 'ESTADO',
      codigo: '0011',
      estadoComprobante: 'NO_EXISTE',
      httpStatus: 200,
    });
  });

  it('no reintenta una consulta ante HTTP no transitorio y clasifica el estado HTTP', async () => {
    const transporte = {
      enviar: jest.fn().mockResolvedValue({
        estadoHttp: 401,
        cuerpo: 'Unauthorized',
      }),
    };
    const { cliente, esperar } = crearCliente('produccion', transporte);

    const resultado = await cliente.consultarValidez(
      '20123456789',
      '01',
      'FFF1',
      1,
    );

    expect(resultado).toMatchObject({
      tipo: 'TRANSPORTE',
      codigo: 'HTTP_401',
      httpStatus: 401,
    });
    expect(transporte.enviar).toHaveBeenCalledTimes(1);
    expect(esperar).not.toHaveBeenCalled();
  });

  it('reintenta una consulta ante HTTP 503 transitorio', async () => {
    const transporte = {
      enviar: jest
        .fn()
        .mockResolvedValueOnce({ estadoHttp: 503, cuerpo: 'temporal' })
        .mockResolvedValueOnce({
          estadoHttp: 200,
          cuerpo: respuestaGetStatus('0011'),
        }),
    };
    const { cliente, esperar } = crearCliente(
      'produccion',
      transporte,
      { reintentosConsulta: 1 },
    );

    const resultado = await cliente.consultarValidez(
      '20123456789',
      '01',
      'FFF1',
      1,
    );

    expect(resultado).toMatchObject({
      tipo: 'ESTADO',
      codigo: '0011',
      estadoComprobante: 'NO_EXISTE',
    });
    expect(transporte.enviar).toHaveBeenCalledTimes(2);
    expect(esperar).toHaveBeenCalledWith(300);
  });

  it('interpreta Fault SOAP incluso si SUNAT responde con HTTP 500', async () => {
    const transporte = {
      enviar: jest.fn().mockResolvedValue({
        estadoHttp: 500,
        cuerpo: respuestaFault('soap:Server', 'Servicio temporalmente no disponible'),
      }),
    };
    const { cliente } = crearCliente('beta', transporte);

    const resultado = await cliente.enviarComprobante('a.zip', 'zip');

    expect(resultado).toMatchObject({
      tipo: 'FAULT',
      codigo: 'soap:Server',
      descripcion: 'Servicio temporalmente no disponible',
      httpStatus: 500,
    });
    expect(transporte.enviar).toHaveBeenCalledTimes(1);
  });

  it('no expone credenciales en la respuesta cruda y rechaza contenido que no es XML', async () => {
    const transporte = {
      enviar: jest.fn().mockResolvedValue({
        estadoHttp: 200,
        cuerpo: `<!doctype html><body>${CREDENCIALES.usuario} ${CREDENCIALES.clave}</body>`,
      }),
    };
    const { cliente } = crearCliente('beta', transporte);

    const resultado = await cliente.enviarComprobante('a.zip', 'zip');

    expect(resultado).toMatchObject({
      tipo: 'TRANSPORTE',
      codigo: 'RESPUESTA_INVALIDA',
    });
    expect(resultado.raw).not.toContain(CREDENCIALES.usuario);
    expect(resultado.raw).not.toContain(CREDENCIALES.clave);
    expect(resultado.raw).toContain('***');
  });

  it('no intenta consultar estado de comprobante en BETA', async () => {
    const transporte = { enviar: jest.fn() };
    const { cliente } = crearCliente('beta', transporte);

    const resultado = await cliente.consultarCdr(
      '20123456789',
      '01',
      'FFF1',
      1,
    );

    expect(resultado).toMatchObject({
      tipo: 'NO_DISPONIBLE',
      codigo: 'NO_DISPONIBLE',
    });
    expect(transporte.enviar).not.toHaveBeenCalled();
  });

  it('limita la respuesta cruda al máximo de bytes incluso con caracteres UTF-8', async () => {
    const transporte = {
      enviar: jest.fn().mockResolvedValue({
        estadoHttp: 401,
        cuerpo: 'ñ'.repeat(LIMITE_RAW_BYTES + 10),
      }),
    };
    const { cliente } = crearCliente('beta', transporte);

    const resultado = await cliente.enviarComprobante('a.zip', 'zip');

    expect(Buffer.byteLength(resultado.raw ?? '', 'utf8')).toBeLessThanOrEqual(
      LIMITE_RAW_BYTES,
    );
    expect(resultado.raw).toMatch(/…\[truncado\]$/);
  });

  describe('consultas billConsultService: tabla 0001-0012 del Manual (anexo 2)', () => {
    function clienteConsulta(cuerpo: string) {
      const transporte = { enviar: jest.fn<Promise<RespuestaHttpSoap>, [PeticionSoap]>().mockResolvedValue({ estadoHttp: 200, cuerpo }) };
      return { ...crearCliente('produccion', transporte, { reintentosConsulta: 0 }), transporte };
    }

    it('la tabla trae todos los códigos documentados y ninguno inventado', () => {
      expect(Object.keys(ESTADOS_CONSULTA_SUNAT).sort()).toEqual([
        '0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0009', '0010', '0011', '0012',
      ]);
    });

    it.each([
      ['0001', 'ACEPTADO', 'El comprobante existe y está aceptado.'],
      ['0002', 'RECHAZADO', 'El comprobante existe pero está rechazado.'],
      ['0003', 'DE_BAJA', 'El comprobante existe pero está de baja.'],
      ['0004', 'CONSULTA_INVALIDA', 'Formato de RUC no es válido (debe de contener 11 caracteres numéricos).'],
      ['0005', 'CONSULTA_INVALIDA', 'Formato del tipo de comprobante no es válido (debe de contener 2 caracteres).'],
      ['0006', 'CONSULTA_INVALIDA', 'Formato de serie inválido (debe de contener 4 caracteres).'],
      ['0007', 'CONSULTA_INVALIDA', 'El numero de comprobante debe de ser mayor que cero.'],
      ['0008', 'NO_AUTORIZADO', 'El número de RUC no está inscrito en los registros de la SUNAT.'],
      ['0009', 'CONSULTA_INVALIDA', 'El tipo de comprobante debe de ser (01, 07 o 08).'],
      ['0010', 'CONSULTA_INVALIDA', 'Sólo se puede consultar facturas, notas de crédito y debito electrónicas, cuya serie empieza con "F".'],
      ['0011', 'NO_EXISTE', 'El comprobante de pago electrónico no existe.'],
      ['0012', 'NO_AUTORIZADO', 'El comprobante de pago electrónico no le pertenece.'],
    ] as const)('getStatus %s → %s (sin statusMessage usa el texto oficial)', async (codigo, estadoComprobante, texto) => {
      const { cliente } = clienteConsulta(respuestaGetStatus(codigo));
      const resultado = await cliente.consultarValidez('20610206337', '01', 'F001', 12);
      expect(resultado).toMatchObject({ tipo: 'ESTADO', codigo, statusCode: codigo, estadoComprobante, descripcion: texto });
    });

    it('getStatusCdr respeta el statusMessage de SUNAT y normaliza el código a 4 dígitos', async () => {
      const { cliente, transporte } = clienteConsulta(respuestaGetStatusCdr('11', 'El comprobante no existe'));
      const resultado = await cliente.consultarCdr('20610206337', '01', 'F001', 12);
      expect(resultado).toMatchObject({ tipo: 'ESTADO', codigo: '0011', estadoComprobante: 'NO_EXISTE', descripcion: 'El comprobante no existe' });
      const [peticion] = transporte.enviar.mock.calls[0];
      expect(peticion).toMatchObject({ soapAction: '"urn:getStatusCdr"', url: 'http://127.0.0.1:8080/consulta' });
      expect(peticion.cuerpo).toContain('<numeroComprobante>12</numeroComprobante>');
    });

    it('un código no documentado queda DESCONOCIDO', async () => {
      const { cliente } = clienteConsulta(respuestaGetStatusCdr('0099', 'Otro estado'));
      expect(await cliente.consultarCdr('20610206337', '01', 'F001', 12)).toMatchObject({ tipo: 'ESTADO', codigo: '0099', estadoComprobante: 'DESCONOCIDO' });
    });

    it('con la constancia adjunta devuelve el CDR, sea cual sea el statusCode', async () => {
      const cdr = cdrPrueba({ codigo: '0', descripcion: 'La Factura numero F001-12, ha sido aceptada', referencia: 'F001-12' });
      const { cliente } = clienteConsulta(respuestaGetStatusCdr('0004', 'La constancia existe', cdr));
      expect(await cliente.consultarCdr('20610206337', '01', 'F001', 12)).toMatchObject({ tipo: 'CDR', codigo: '0', statusCode: '0004', cdrXml: cdr });
    });

    it.each([
      ['0010', 'EXCEPCION', 'NINGUNA'],
      ['0005', 'EXCEPCION', 'NINGUNA'],
      ['0012', 'ERROR_CONFIG', 'REVISAR_CONFIG'],
      ['0008', 'ERROR_CONFIG', 'REVISAR_CONFIG'],
    ] as const)('de punta a punta: %s se clasifica %s + %s, nunca PENDIENTE_REENVIO', async (codigo, estado, accion) => {
      const { cliente } = clienteConsulta(respuestaGetStatusCdr(codigo, 'texto de SUNAT'));
      const leida = await cliente.consultarCdr('20610206337', '01', 'F001', 12);
      const decision = new ClasificadorRespuestaSunat({ warn: jest.fn() }).clasificar(leida, { operacion: 'consulta', tipo: '01', serie: 'F001', ambiente: 'produccion' });
      expect(decision).toMatchObject({ estado, accion });
    });
  });

  describe('documentos que getStatusCdr no admite: respuesta normalizada sin usar la red', () => {
    it.each([
      ['03', 'B001'],
      ['07', 'BC01'],
      ['08', 'BD01'],
      ['07', 'BBC1'],
      ['01', 'B001'],
    ] as const)('tipo %s serie %s', async (tipo, serie) => {
      const transporte = { enviar: jest.fn() };
      const { cliente } = crearCliente('produccion', transporte);
      for (const consulta of [cliente.consultarCdr('20610206337', tipo, serie, 15), cliente.consultarValidez('20610206337', tipo, serie, 15)]) {
        const resultado = await consulta;
        expect(resultado).toMatchObject({ tipo: 'NO_DISPONIBLE', codigo: CODIGO_CONSULTA_NO_ADMITIDA, tiempoMs: 0, observaciones: [] });
        expect(resultado.descripcion).toContain('serie F');
        expect(resultado.descripcion).toContain(`${serie}-15`);
      }
      expect(transporte.enviar).not.toHaveBeenCalled();
    });

    it('también en BETA el motivo es el documento (antes que el ambiente)', async () => {
      const transporte = { enviar: jest.fn() };
      const { cliente } = crearCliente('beta', transporte);
      expect(await cliente.consultarCdr('20610206337', '03', 'BB01', 4)).toMatchObject({ tipo: 'NO_DISPONIBLE', codigo: CODIGO_CONSULTA_NO_ADMITIDA });
      expect(transporte.enviar).not.toHaveBeenCalled();
    });

    it('las facturas y notas de serie F sí se consultan', async () => {
      const transporte = { enviar: jest.fn().mockResolvedValue({ estadoHttp: 200, cuerpo: respuestaGetStatusCdr('0011', 'No existe') }) };
      const { cliente } = crearCliente('produccion', transporte);
      for (const [tipo, serie] of [['01', 'F001'], ['07', 'FC01'], ['08', 'FD01']] as const) {
        expect((await cliente.consultarCdr('20610206337', tipo, serie, 1)).tipo).toBe('ESTADO');
      }
      expect(transporte.enviar).toHaveBeenCalledTimes(3);
    });
  });

  describe('origen del Fault (Server / Client)', () => {
    it.each([
      ['soap-env:Client.0111', '0111', 'Client'],
      ['soap-env:Server.0130', '0130', 'Server'],
      ['soap:Server', 'soap:Server', 'Server'],
    ] as const)('%s → codigo %s, faultOrigen %s', async (faultcode, codigo, origen) => {
      const transporte = { enviar: jest.fn().mockResolvedValue({ estadoHttp: 500, cuerpo: respuestaFault(faultcode, 'Detalle de SUNAT') }) };
      const { cliente } = crearCliente('beta', transporte);
      expect(await cliente.enviarComprobante('a.zip', 'zip')).toMatchObject({ tipo: 'FAULT', codigo, faultOrigen: origen });
    });

    it('sin Server/Client en el faultcode no inventa el origen', async () => {
      const transporte = { enviar: jest.fn().mockResolvedValue({ estadoHttp: 500, cuerpo: respuestaFault('ns0:1033', 'Registrado previamente') }) };
      const { cliente } = crearCliente('beta', transporte);
      const resultado = await cliente.enviarComprobante('a.zip', 'zip');
      expect(resultado).toMatchObject({ tipo: 'FAULT', codigo: '1033' });
      expect(resultado).not.toHaveProperty('faultOrigen');
    });

    it('origenDelFault reconoce SOAP 1.1 y 1.2 sin falsos positivos', () => {
      expect(origenDelFault('Client.0154')).toBe('Client');
      expect(origenDelFault('soap-env:server.0835')).toBe('Server');
      expect(origenDelFault('env:Sender')).toBe('Client');
      expect(origenDelFault('env:Receiver')).toBe('Server');
      expect(origenDelFault('soap-env:ServerBusy')).toBeUndefined();
      expect(origenDelFault('0111')).toBeUndefined();
      expect(origenDelFault('')).toBeUndefined();
    });
  });

  it('rechaza endpoints inseguros y endpoints de producción desde BETA', () => {
    const transporte = { enviar: jest.fn() };

    expect(
      () =>
        crearCliente(
          'beta',
          transporte,
          { endpointBill: 'http://sunat.gob.pe/bill' },
        ),
    ).toThrow('debe usar HTTPS');
    expect(
      () =>
        crearCliente(
          'beta',
          transporte,
          { endpointBill: 'https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService' },
        ),
    ).toThrow('no puede apuntar a los servicios de producción');
  });
});
