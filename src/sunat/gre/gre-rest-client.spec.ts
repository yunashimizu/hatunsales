import axios from 'axios';
import { createHash } from 'crypto';
import { generarCertificadoPrueba, materialDePrueba } from '../nucleo/pruebas/certificados-prueba-spec';
import type { CredencialesGre } from '../seguridad/credenciales-gre.service';
import type { GrePreparada } from './gre.contrato';
import {
  ClienteRestGre,
  ErrorTokenGre,
  ErrorTransporteGre,
  exigirUrlPermitidaGre,
  PeticionHttpGre,
  RespuestaHttpGre,
  sanearErrorHttpGre,
  TransporteHttpGre,
  TransporteHttpGreAxios,
  urlConsultaGre,
  urlEnvioGre,
  urlTokenGre,
} from './gre-rest-client';
import { PreparadorGre } from './preparador-gre';
import { greVentaPublica, HOY_GRE_PRUEBA } from './pruebas/documentos-gre-prueba-spec';
import { arcCdrPrueba, cuerpoConsulta, cuerpoTicket, cuerpoToken, TICKET_PRUEBA } from './pruebas/respuestas-gre-prueba-spec';

const CREDENCIALES: CredencialesGre = Object.freeze({
  clientId: 'a1b2c3d4-e5f6-7a8b-9c0d-e1f2a3b4c5d6',
  clientSecret: 'SecretoCliente-123',
  usuarioSol: '20610206337USUARIO1',
  claveSol: 'ClaveSol9x',
});
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.cGF5bG9hZA.ZmlybWE';

type Respuesta = RespuestaHttpGre | Error;

/** Transporte falso con una cola de respuestas por tipo de petición. Ninguna petición sale a la red. */
function transporteFalso(colas: { token?: Respuesta[]; envio?: Respuesta[]; consulta?: Respuesta[] }) {
  const peticiones: PeticionHttpGre[] = [];
  const pendientes = { token: [...(colas.token ?? [])], envio: [...(colas.envio ?? [])], consulta: [...(colas.consulta ?? [])] };
  const tipoDe = (p: PeticionHttpGre) => (p.url.includes('/oauth2/token/') ? 'token' : p.url.includes('/envios/') ? 'consulta' : 'envio');
  const transporte: TransporteHttpGre = {
    ejecutar: jest.fn((peticion: PeticionHttpGre) => {
      peticiones.push(peticion);
      const siguiente = pendientes[tipoDe(peticion)].shift();
      if (siguiente === undefined) return Promise.reject(new Error(`El spec no preparó respuesta para ${tipoDe(peticion)}`));
      return siguiente instanceof Error ? Promise.reject(siguiente) : Promise.resolve(siguiente);
    }),
  };
  return { transporte, peticiones, de: (tipo: 'token' | 'envio' | 'consulta') => peticiones.filter((p) => tipoDe(p) === tipo) };
}

const ok = (cuerpo: string): RespuestaHttpGre => ({ estadoHttp: 200, cuerpo });
const http = (estadoHttp: number, cuerpo = ''): RespuestaHttpGre => ({ estadoHttp, cuerpo });

describe('ClienteRestGre', () => {
  let preparada: GrePreparada;
  let ahora: number;
  const nuevoCliente = (transporte: TransporteHttpGre) =>
    new ClienteRestGre(transporte, { ahora: () => ahora, esperar: () => Promise.resolve() });

  beforeAll(() => {
    const certificado = generarCertificadoPrueba();
    preparada = new PreparadorGre().preparar(greVentaPublica(), materialDePrueba(certificado), { hoy: HOY_GRE_PRUEBA });
  });

  beforeEach(() => {
    ahora = Date.parse('2026-10-21T15:00:00Z');
  });

  describe('token OAuth2', () => {
    it('pide el token con form-urlencoded a api-seguridad con grant_type=password y el usuario RUC+SOL', async () => {
      const falso = transporteFalso({ token: [ok(cuerpoToken())] });
      await expect(nuevoCliente(falso.transporte).obtenerToken(CREDENCIALES)).resolves.toBe(TOKEN);

      const [peticion] = falso.peticiones;
      expect(peticion.metodo).toBe('POST');
      expect(peticion.url).toBe(`https://api-seguridad.sunat.gob.pe/v1/clientessol/${CREDENCIALES.clientId}/oauth2/token/`);
      expect(peticion.cabeceras['Content-Type']).toBe('application/x-www-form-urlencoded');
      const parametros = new URLSearchParams(peticion.cuerpo);
      expect(Object.fromEntries(parametros)).toEqual({
        grant_type: 'password',
        scope: 'https://api-cpe.sunat.gob.pe',
        client_id: CREDENCIALES.clientId,
        client_secret: CREDENCIALES.clientSecret,
        username: '20610206337USUARIO1',
        password: CREDENCIALES.claveSol,
      });
      expect(peticion.timeoutMs).toBeGreaterThanOrEqual(15_000);
      expect(peticion.timeoutMs).toBeLessThanOrEqual(30_000);
    });

    it('lo guarda en memoria por client_id hasta 5 minutos antes de vencer', async () => {
      const falso = transporteFalso({ token: [ok(cuerpoToken(3600)), ok(cuerpoToken(3600, 'otro.token.nuevo'))] });
      const cliente = nuevoCliente(falso.transporte);
      await cliente.obtenerToken(CREDENCIALES);
      ahora += 3299_000; // 55 min menos 1 s
      await expect(cliente.obtenerToken(CREDENCIALES)).resolves.toBe(TOKEN);
      expect(falso.de('token')).toHaveLength(1);
      ahora += 2_000; // ya dentro de los últimos 5 minutos
      await expect(cliente.obtenerToken(CREDENCIALES)).resolves.toBe('otro.token.nuevo');
      expect(falso.de('token')).toHaveLength(2);
    });

    it('un token que vence en menos de 5 minutos no se guarda; si cambian las credenciales se pide otro', async () => {
      const falso = transporteFalso({ token: [ok(cuerpoToken(200)), ok(cuerpoToken(3600)), ok(cuerpoToken(3600, 'token.de.otra.clave'))] });
      const cliente = nuevoCliente(falso.transporte);
      await cliente.obtenerToken(CREDENCIALES);
      await cliente.obtenerToken(CREDENCIALES);
      expect(falso.de('token')).toHaveLength(2);
      await expect(cliente.obtenerToken({ ...CREDENCIALES, claveSol: 'OtraClave1' })).resolves.toBe('token.de.otra.clave');
      expect(falso.de('token')).toHaveLength(3);
    });

    it('peticiones simultáneas comparten una sola petición de token', async () => {
      const falso = transporteFalso({ token: [ok(cuerpoToken())] });
      const cliente = nuevoCliente(falso.transporte);
      const tokens = await Promise.all([cliente.obtenerToken(CREDENCIALES), cliente.obtenerToken(CREDENCIALES), cliente.obtenerToken(CREDENCIALES)]);
      expect(tokens).toEqual([TOKEN, TOKEN, TOKEN]);
      expect(falso.de('token')).toHaveLength(1);
    });

    it('credenciales rechazadas (401): no reintenta y el error no trae secretos', async () => {
      const cuerpo = JSON.stringify({ error: 'invalid_grant', error_description: `password=${CREDENCIALES.claveSol} incorrecta` });
      const falso = transporteFalso({ token: [http(401, cuerpo)] });
      const error = await nuevoCliente(falso.transporte).obtenerToken(CREDENCIALES).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ErrorTokenGre);
      expect((error as ErrorTokenGre).tipo).toBe('credenciales');
      expect((error as ErrorTokenGre).message).not.toContain(CREDENCIALES.claveSol);
      expect(falso.de('token')).toHaveLength(1);
    });

    it('ante 5xx o red reintenta una vez', async () => {
      const recuperado = transporteFalso({ token: [http(503), ok(cuerpoToken())] });
      await expect(nuevoCliente(recuperado.transporte).obtenerToken(CREDENCIALES)).resolves.toBe(TOKEN);
      expect(recuperado.de('token')).toHaveLength(2);

      const caido = transporteFalso({ token: [new ErrorTransporteGre('ECONNRESET', 'socket hang up'), new ErrorTransporteGre('ETIMEDOUT', 'timeout')] });
      const error = await nuevoCliente(caido.transporte).obtenerToken(CREDENCIALES).catch((e: unknown) => e);
      expect((error as ErrorTokenGre).tipo).toBe('no_disponible');
      expect(caido.de('token')).toHaveLength(2);
    });

    it('client_id con formato inválido: no llama a la red', async () => {
      const falso = transporteFalso({});
      const error = await nuevoCliente(falso.transporte).obtenerToken({ ...CREDENCIALES, clientId: '../x' }).catch((e: unknown) => e);
      expect((error as ErrorTokenGre).tipo).toBe('invalido');
      expect(falso.peticiones).toHaveLength(0);
    });
  });

  describe('envío', () => {
    it('POST JSON a /comprobantes/{RUC-09-SERIE-NUMERO} con nomArchivo, arcGreZip (base64) y hashZip (SHA-256 hex)', async () => {
      const falso = transporteFalso({ token: [ok(cuerpoToken())], envio: [ok(cuerpoTicket())] });
      const resultado = await nuevoCliente(falso.transporte).enviarGre(CREDENCIALES, preparada);

      expect(resultado).toMatchObject({ estado: 'TICKET_PENDIENTE', ticket: TICKET_PRUEBA, accion: 'CONSULTAR_TICKET' });
      const [envio] = falso.de('envio');
      expect(envio.metodo).toBe('POST');
      expect(envio.url).toBe('https://api-cpe.sunat.gob.pe/v1/contribuyente/gem/comprobantes/20610206337-09-T001-00000001');
      expect(envio.cabeceras.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(envio.cabeceras['Content-Type']).toBe('application/json');
      const cuerpo = JSON.parse(envio.cuerpo!) as { archivo: { hashZip: string } };
      expect(cuerpo).toEqual({
        archivo: {
          nomArchivo: '20610206337-09-T001-00000001.zip',
          arcGreZip: preparada.zip.toString('base64'),
          hashZip: createHash('sha256').update(preparada.zip).digest('hex'),
        },
      });
      // Supuesto documentado: hex en minúsculas (como Greenter); se confirma con el primer envío real.
      expect(cuerpo.archivo.hashZip).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(resultado)).not.toContain(TOKEN);
    });

    it('ante 401 renueva el token una sola vez y repite el envío', async () => {
      const falso = transporteFalso({ token: [ok(cuerpoToken()), ok(cuerpoToken(3600, 'token.renovado.x'))], envio: [http(401), ok(cuerpoTicket())] });
      const resultado = await nuevoCliente(falso.transporte).enviarGre(CREDENCIALES, preparada);
      expect(resultado.estado).toBe('TICKET_PENDIENTE');
      expect(falso.de('envio').map((p) => p.cabeceras.Authorization)).toEqual([`Bearer ${TOKEN}`, 'Bearer token.renovado.x']);

      const siempre401 = transporteFalso({ token: [ok(cuerpoToken()), ok(cuerpoToken())], envio: [http(401), http(401)] });
      const rechazado = await nuevoCliente(siempre401.transporte).enviarGre(CREDENCIALES, preparada);
      expect(rechazado.estado).toBe('ERROR_CONFIG');
      expect(siempre401.de('envio')).toHaveLength(2);
    });

    it('el envío NO se reintenta solo ante 5xx ni ante un error de red', async () => {
      const con503 = transporteFalso({ token: [ok(cuerpoToken())], envio: [http(503)] });
      expect((await nuevoCliente(con503.transporte).enviarGre(CREDENCIALES, preparada)).estado).toBe('PENDIENTE_REENVIO');
      expect(con503.de('envio')).toHaveLength(1);

      const sinRed = transporteFalso({ token: [ok(cuerpoToken())], envio: [new ErrorTransporteGre('ETIMEDOUT', 'SUNAT no respondió dentro del tiempo límite.')] });
      const resultado = await nuevoCliente(sinRed.transporte).enviarGre(CREDENCIALES, preparada);
      expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', httpStatus: null });
      expect(sinRed.de('envio')).toHaveLength(1);
    });

    it('422: RECHAZADA sin ticket (el número no se consume)', async () => {
      const falso = transporteFalso({ token: [ok(cuerpoToken())], envio: [http(422, JSON.stringify({ errors: [{ codError: '0306', desError: 'No se puede leer el XML' }] }))] });
      const resultado = await nuevoCliente(falso.transporte).enviarGre(CREDENCIALES, preparada);
      expect(resultado).toMatchObject({ estado: 'RECHAZADA', ticket: null, codigo: '0306' });
    });

    it('credenciales rechazadas al pedir el token: ERROR_CONFIG y la guía no se envía', async () => {
      const falso = transporteFalso({ token: [http(400, JSON.stringify({ error: 'invalid_client' }))] });
      const resultado = await nuevoCliente(falso.transporte).enviarGre(CREDENCIALES, preparada);
      expect(resultado).toMatchObject({ estado: 'ERROR_CONFIG', accion: 'REVISAR_CONFIG' });
      expect(falso.de('envio')).toHaveLength(0);
    });

    it('no envía un ZIP alterado o un nombre inválido', async () => {
      const falso = transporteFalso({});
      const cliente = nuevoCliente(falso.transporte);
      const alterada = { ...preparada, sha256: 'f'.repeat(64) };
      expect((await cliente.enviarGre(CREDENCIALES, alterada)).estado).toBe('ERROR_CONFIG');
      expect((await cliente.enviarGre(CREDENCIALES, { ...preparada, nombreBase: '20610206337-01-F001-1' })).estado).toBe('ERROR_CONFIG');
      expect((await cliente.enviarGre(CREDENCIALES, { ...preparada, zip: Buffer.alloc(0) })).estado).toBe('ERROR_CONFIG');
      expect(falso.peticiones).toHaveLength(0);
    });

    it('si el transporte rechaza la URL por seguridad: ERROR_CONFIG sin reintentos', async () => {
      const prohibido = new ErrorTransporteGre('URL_NO_PERMITIDA', 'Por seguridad solo se llama a los hosts de la GRE.');
      const enEnvio = transporteFalso({ token: [ok(cuerpoToken())], envio: [prohibido] });
      expect(await nuevoCliente(enEnvio.transporte).enviarGre(CREDENCIALES, preparada)).toMatchObject({ estado: 'ERROR_CONFIG' });
      expect(enEnvio.de('envio')).toHaveLength(1);

      const enToken = transporteFalso({ token: [prohibido] });
      const error = await nuevoCliente(enToken.transporte).obtenerToken(CREDENCIALES).catch((e: unknown) => e);
      expect((error as ErrorTokenGre).tipo).toBe('invalido');
      expect(enToken.de('token')).toHaveLength(1);
    });

    it('una redirección no se sigue', async () => {
      const falso = transporteFalso({ token: [ok(cuerpoToken())], envio: [http(302)] });
      const resultado = await nuevoCliente(falso.transporte).enviarGre(CREDENCIALES, preparada);
      expect(resultado.estado).toBe('ERROR_CONFIG');
      expect(falso.peticiones).toHaveLength(2);
    });
  });

  describe('consulta del ticket', () => {
    it('GET a /comprobantes/envios/{ticket}: 98 en proceso y 0 con la constancia', async () => {
      const falso = transporteFalso({
        token: [ok(cuerpoToken())],
        consulta: [ok(cuerpoConsulta('98')), ok(cuerpoConsulta('0', { indCdrGenerado: '1', arcCdr: arcCdrPrueba() }))],
      });
      const cliente = nuevoCliente(falso.transporte);
      expect((await cliente.consultarTicket(CREDENCIALES, TICKET_PRUEBA)).estado).toBe('TICKET_PENDIENTE');
      const aceptada = await cliente.consultarTicket(CREDENCIALES, TICKET_PRUEBA, { rucEmisor: '20610206337', serie: 'T001', numero: 1 });
      expect(aceptada.estado).toBe('ACEPTADA');
      expect(aceptada.cdr?.xml.toString('utf8')).toContain('ApplicationResponse');

      const [consulta] = falso.de('consulta');
      expect(consulta.metodo).toBe('GET');
      expect(consulta.url).toBe(`https://api-cpe.sunat.gob.pe/v1/contribuyente/gem/comprobantes/envios/${TICKET_PRUEBA}`);
      expect(consulta.cabeceras.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(falso.de('token')).toHaveLength(1);
    });

    it('reintenta la consulta ante 5xx o red (hasta 2 veces) y luego deja la guía con su ticket', async () => {
      const recuperada = transporteFalso({ token: [ok(cuerpoToken())], consulta: [http(503), new ErrorTransporteGre('ECONNRESET', 'x'), ok(cuerpoConsulta('98'))] });
      expect((await nuevoCliente(recuperada.transporte).consultarTicket(CREDENCIALES, TICKET_PRUEBA)).estado).toBe('TICKET_PENDIENTE');
      expect(recuperada.de('consulta')).toHaveLength(3);

      const caida = transporteFalso({ token: [ok(cuerpoToken())], consulta: [http(500), http(502), http(503)] });
      const resultado = await nuevoCliente(caida.transporte).consultarTicket(CREDENCIALES, TICKET_PRUEBA);
      expect(resultado).toMatchObject({ estado: 'TICKET_PENDIENTE', accion: 'CONSULTAR_TICKET' });
      expect(caida.de('consulta')).toHaveLength(3);
    });

    it('ante 401 renueva el token una vez', async () => {
      const falso = transporteFalso({ token: [ok(cuerpoToken()), ok(cuerpoToken())], consulta: [http(401), ok(cuerpoConsulta('98'))] });
      expect((await nuevoCliente(falso.transporte).consultarTicket(CREDENCIALES, TICKET_PRUEBA)).estado).toBe('TICKET_PENDIENTE');
      expect(falso.de('token')).toHaveLength(2);
    });

    it('un ticket con formato raro no se consulta', async () => {
      const falso = transporteFalso({});
      const resultado = await nuevoCliente(falso.transporte).consultarTicket(CREDENCIALES, '../../otro-servicio');
      expect(resultado.estado).toBe('ERROR_CONFIG');
      expect(falso.peticiones).toHaveLength(0);
    });
  });
});

describe('seguridad del transporte', () => {
  afterEach(() => jest.restoreAllMocks());

  it('solo https y solo los dos hosts de la GRE (lista cerrada)', () => {
    expect(() => exigirUrlPermitidaGre(urlTokenGre('abc12345'))).not.toThrow();
    expect(() => exigirUrlPermitidaGre(urlEnvioGre('20610206337-09-T001-00000001'))).not.toThrow();
    expect(() => exigirUrlPermitidaGre(urlConsultaGre(TICKET_PRUEBA))).not.toThrow();
    for (const url of [
      'http://api-cpe.sunat.gob.pe/v1/contribuyente/gem/comprobantes/x',
      'https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService',
      'https://api-cpe.sunat.gob.pe.evil.com/v1',
      'https://api-cpe.sunat.gob.pe:8443/v1',
      'https://usuario:clave@api-cpe.sunat.gob.pe/v1',
      'no es url',
    ]) {
      expect(() => exigirUrlPermitidaGre(url)).toThrow(ErrorTransporteGre);
    }
  });

  it('el transporte real rechaza un host no permitido sin llamar a axios', async () => {
    const solicitud = jest.spyOn(axios, 'request');
    await expect(
      new TransporteHttpGreAxios().ejecutar({ metodo: 'GET', url: 'https://example.com/v1', cabeceras: {}, timeoutMs: 15_000 }),
    ).rejects.toMatchObject({ codigo: 'URL_NO_PERMITIDA' });
    expect(solicitud).not.toHaveBeenCalled();
  });

  it('el transporte real no sigue redirecciones, limita la respuesta a 10 MB y no lanza por estados HTTP', async () => {
    const solicitud = jest.spyOn(axios, 'request').mockResolvedValue({ status: 302, data: '' } as never);
    const respuesta = await new TransporteHttpGreAxios().ejecutar({
      metodo: 'POST',
      url: urlEnvioGre('20610206337-09-T001-00000001'),
      cabeceras: { Authorization: 'Bearer x' },
      cuerpo: '{}',
      timeoutMs: 20_000,
    });
    expect(respuesta).toEqual({ estadoHttp: 302, cuerpo: '' });
    const config = solicitud.mock.calls[0][0] as Record<string, unknown>;
    expect(config.maxRedirects).toBe(0);
    expect(config.maxContentLength).toBe(10 * 1024 * 1024);
    expect(config.timeout).toBe(20_000);
    expect((config.validateStatus as (s: number) => boolean)(500)).toBe(true);
  });

  it('un error de axios se sanea: sin config.data, sin Authorization, sin client_secret ni password', async () => {
    const cuerpoToken = `grant_type=password&client_secret=${CREDENCIALES.clientSecret}&username=20610206337USUARIO1&password=${CREDENCIALES.claveSol}`;
    const errorAxios = Object.assign(new Error(`connect ECONNREFUSED; body ${cuerpoToken}; Authorization: Bearer ${TOKEN}`), {
      code: 'ECONNREFUSED',
      isAxiosError: true,
      config: {
        method: 'post',
        url: `${urlTokenGre(CREDENCIALES.clientId)}?client_secret=${CREDENCIALES.clientSecret}`,
        data: cuerpoToken,
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      },
      request: { _header: `POST /v1 HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}` },
      response: { status: 503, data: cuerpoToken, headers: {} },
    });

    const saneado = sanearErrorHttpGre(errorAxios, [CREDENCIALES.clientSecret, CREDENCIALES.claveSol]);
    const serializado = JSON.stringify(saneado);
    for (const secreto of [CREDENCIALES.clientSecret, CREDENCIALES.claveSol, TOKEN]) expect(serializado).not.toContain(secreto);
    expect(serializado).not.toMatch(/"data"|"headers"|Authorization: Bearer ey/);
    expect(saneado).toMatchObject({ codigo: 'ECONNREFUSED', estadoHttp: 503, metodo: 'POST' });
    expect(saneado.url).toBe(urlTokenGre(CREDENCIALES.clientId));

    // El transporte real convierte el error de axios en uno propio igual de limpio.
    jest.spyOn(axios, 'request').mockRejectedValue(errorAxios);
    const error = await new TransporteHttpGreAxios()
      .ejecutar({ metodo: 'POST', url: urlTokenGre(CREDENCIALES.clientId), cabeceras: {}, cuerpo: cuerpoToken, timeoutMs: 15_000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorTransporteGre);
    const texto = `${(error as Error).message} ${JSON.stringify(error)}`;
    for (const secreto of [CREDENCIALES.clientSecret, CREDENCIALES.claveSol, TOKEN]) expect(texto).not.toContain(secreto);
  });
});
