import { AddressInfo } from 'net';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import {
  ErrorTransporteSoap,
  PeticionSoap,
  TransporteSoapAxios,
} from './transporte-soap';

describe('TransporteSoapAxios: HTTP local sin conectar con SUNAT', () => {
  let servidor: Server;
  let atender: (req: IncomingMessage, res: ServerResponse) => void;
  let peticiones: Array<{ metodo: string; soapAction: string | undefined; cuerpo: string }>;
  let url: string;
  let temporizador: NodeJS.Timeout | undefined;

  beforeEach(async () => {
    peticiones = [];
    atender = (_req, res) => res.end();
    servidor = createServer((req, res) => {
      const trozos: Buffer[] = [];
      req.on('data', (trozo: Buffer) => trozos.push(trozo));
      req.on('end', () => {
        const accion = req.headers.soapaction;
        peticiones.push({
          metodo: req.method ?? '',
          soapAction: Array.isArray(accion) ? accion.join(',') : accion,
          cuerpo: Buffer.concat(trozos).toString('utf8'),
        });
        atender(req, res);
      });
    });
    await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve));
    const address = servidor.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}/soap`;
  });

  afterEach(async () => {
    if (temporizador) clearTimeout(temporizador);
    servidor.closeAllConnections();
    if (servidor.listening) {
      await new Promise<void>((resolve, reject) =>
        servidor.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('envía POST SOAP y devuelve el cuerpo aun ante HTTP 503', async () => {
    atender = (_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/xml' });
      res.end('<soap:Fault>Servicio temporalmente no disponible</soap:Fault>');
    };
    const peticion: PeticionSoap = {
      url,
      cuerpo: '<soap:Envelope/>',
      soapAction: '"urn:sendBill"',
      timeoutMs: 1_000,
    };

    const respuesta = await new TransporteSoapAxios().enviar(peticion);

    expect(respuesta).toEqual({
      estadoHttp: 503,
      cuerpo: '<soap:Fault>Servicio temporalmente no disponible</soap:Fault>',
    });
    expect(peticiones).toEqual([
      {
        metodo: 'POST',
        soapAction: '"urn:sendBill"',
        cuerpo: '<soap:Envelope/>',
      },
    ]);
  });

  it('no sigue redirecciones, evitando reenviar el cuerpo SOAP a otra URL', async () => {
    atender = (_req, res) => {
      res.writeHead(302, { Location: '/otro-destino' });
      res.end('redirect');
    };

    const respuesta = await new TransporteSoapAxios().enviar({
      url,
      cuerpo: '<soap:Envelope/>',
      soapAction: '"urn:sendBill"',
      timeoutMs: 1_000,
    });

    expect(respuesta.estadoHttp).toBe(302);
    expect(peticiones).toHaveLength(1);
    expect(peticiones[0].cuerpo).toBe('<soap:Envelope/>');
  });

  it('normaliza el timeout de Axios como error de transporte reintentable', async () => {
    atender = (_req, res) => {
      temporizador = setTimeout(() => res.end('demasiado tarde'), 100);
    };

    await expect(
      new TransporteSoapAxios().enviar({
        url,
        cuerpo: '<soap:Envelope/>',
        soapAction: '"urn:sendBill"',
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject<Partial<ErrorTransporteSoap>>({
      name: 'ErrorTransporteSoap',
      codigo: 'ETIMEDOUT',
    });
  });
});
