import {
  cdrPrueba,
  respuestaFault,
  respuestaGetStatus,
  respuestaSendBill,
} from '../pruebas/respuestas-sunat-prueba-spec';
import {
  ConfiguracionClienteSoap,
  LIMITE_RAW_BYTES,
  SunatSoapClient,
  TIMEOUT_POS_MS,
} from './sunat-soap-client';
import { ErrorTransporteSoap, PeticionSoap, TransporteSoap } from './transporte-soap';

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
