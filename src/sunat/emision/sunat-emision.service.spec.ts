import AdmZip from 'adm-zip';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import { FiscalConfigError } from '../config/fiscal-errores';
import type { AmbienteFiscal, BloqueoEmision } from '../config/fiscal-config.tipos';
import type { InterruptorEmisionFiscal } from '../config/interruptor-emision.service';
import { RelojFiscal } from '../config/reloj-fiscal';
import type { TransaccionesFiscales } from '../config/transacciones-fiscales';
import { ClasificadorRespuestaSunat } from '../nucleo/clasificador-respuesta';
import type { ClasificacionRespuesta, DocumentoCpe } from '../nucleo/documento-fiscal.types';
import { verificarFirmaXml } from '../nucleo/firma/firmador-xml';
import { EnvioCpePreparado, PreparadorEnvioCpe } from '../nucleo/preparador-envio-cpe';
import { generarCertificadoPrueba, materialDePrueba } from '../nucleo/pruebas/certificados-prueba-spec';
import { boletaPrueba, facturaPrueba } from '../nucleo/pruebas/documentos-prueba-spec';
import { cdrPrueba, respuestaFault, respuestaGetStatusCdr, respuestaSendBill } from '../nucleo/pruebas/respuestas-sunat-prueba-spec';
import { fechaLimiteEnvioIndividual } from '../nucleo/reglas-envio';
import { FabricaClienteSoapSunat } from '../nucleo/soap/sunat-soap-client';
import { ErrorTransporteSoap } from '../nucleo/soap/transporte-soap';
import type { CredencialesSolService } from '../seguridad/credenciales-sol.service';
import { EventoEnvioCompletado, OyenteEnvioFiscal, OyentesEnvioFiscal } from './emision.contrato';
import { ESPERA_LENTA_MINUTOS } from './emision.tipos';
import type { CierreEnvio, EnvioRegistrado } from './emision.tipos';
import type { EnvioFiscalRepository, RegistroEnvioNuevo } from './envio-fiscal.repository';
import { NUMERO_PRUEBA_CREDENCIALES, SunatEmisionService } from './sunat-emision.service';

const ABIERTOS = ['ENVIANDO', 'PENDIENTE_REENVIO', 'EXCEPCION'];

/** fiscal_envios en memoria con las mismas reglas de reclamo y cierre que el SQL. */
class EnviosMemoria {
  private siguiente = 100;
  readonly filas = new Map<number, EnvioRegistrado>();
  readonly cierres: Array<{ id: number; cierre: CierreEnvio }> = [];
  fallasCompletar = 0;
  manual: Record<string, unknown> | null = null;

  agregar(datos: {
    ambiente: AmbienteFiscal;
    documento: DocumentoCpe;
    preparado: EnvioCpePreparado;
    estado?: string;
    accion?: string | null;
    intento?: number;
    libre?: boolean;
    codigo_sunat?: string | null;
    id_comprobante?: number | null;
    fecha_limite_envio?: string;
    registrado_con_otros_datos?: boolean;
  }): EnvioRegistrado {
    const id = ++this.siguiente;
    const { documento, preparado } = datos;
    const fila: EnvioRegistrado = {
      id_envio: id,
      ambiente: datos.ambiente,
      tipo_documento: documento.tipo,
      estado: datos.estado ?? 'ENVIANDO',
      estado_anterior: null,
      intento: datos.intento ?? 1,
      nombre_archivo: preparado.zip.nombreZip,
      nombre_base: preparado.nombreBase,
      id_comprobante: datos.id_comprobante === undefined ? 500 : datos.id_comprobante,
      codigo_sunat: datos.codigo_sunat ?? null,
      accion: datos.accion ?? null,
      libre: datos.libre ?? false,
      fecha_limite_envio: datos.fecha_limite_envio ?? fechaLimiteEnvioIndividual(documento.tipo, documento.serie, documento.fechaEmision),
      datos: { documento, digest: preparado.digestValue, cadena_qr: preparado.cadenaQr },
      registrado_con_otros_datos: datos.registrado_con_otros_datos ?? false,
      zip: preparado.zip.zip,
    };
    this.filas.set(id, fila);
    return fila;
  }

  registrar = jest.fn(async (_consultor: unknown, r: RegistroEnvioNuevo) =>
    this.agregar({ ambiente: r.ambiente, documento: r.documento, preparado: r.preparado, id_comprobante: r.idComprobante, fecha_limite_envio: r.fechaLimiteEnvio })
      .id_envio,
  );

  reclamarPrimerEnvio = jest.fn(async (id: number, conZip: boolean) => {
    const f = this.filas.get(id);
    if (!f || f.estado !== 'ENVIANDO' || f.intento !== 1 || f.codigo_sunat !== null) return null;
    f.libre = false;
    return { ...f, zip: conZip ? f.zip : null };
  });

  reclamarReintento = jest.fn(async (id: number, forzar = false) => {
    const f = this.filas.get(id);
    if (!f || !f.libre) return null;
    if (!((f.estado === 'PENDIENTE_REENVIO' && f.accion !== 'RECUPERAR_CDR') || f.estado === 'ENVIANDO' || (f.estado === 'EXCEPCION' && forzar))) return null;
    const anterior = f.estado;
    Object.assign(f, { estado: 'ENVIANDO', intento: f.intento + 1, libre: false });
    return { ...f, estado_anterior: anterior };
  });

  reclamarConsulta = jest.fn(async (id: number) => {
    const f = this.filas.get(id);
    if (!f || !f.libre || !ABIERTOS.includes(f.estado)) return null;
    f.libre = false;
    return { ...f };
  });

  leer = jest.fn(async (id: number) => {
    const f = this.filas.get(id);
    return f ? { ...f } : null;
  });

  completar = jest.fn(async (id: number, _ambiente: AmbienteFiscal, _nombreBase: string, cierre: CierreEnvio) => {
    if (this.fallasCompletar > 0) {
      this.fallasCompletar -= 1;
      throw Object.assign(new Error('se perdió la conexión'), { code: '57P01' });
    }
    const f = this.filas.get(id);
    if (!f || !ABIERTOS.includes(f.estado)) return null;
    Object.assign(f, {
      estado: cierre.estado,
      accion: cierre.accion,
      libre: true,
      codigo_sunat: cierre.sunat?.codigo ?? f.codigo_sunat,
      registrado_con_otros_datos: f.registrado_con_otros_datos || cierre.json.registrado_con_otros_datos === true,
    });
    this.cierres.push({ id, cierre });
    return { id_comprobante: f.id_comprobante, tipo_documento: f.tipo_documento, archivos: ['xml_original', 'xml_firmado', 'zip'] };
  });

  marcarAceptadoManual = jest.fn(async (_tx: unknown, id: number, _mensaje: string, json: Record<string, unknown>) => {
    const f = this.filas.get(id);
    const incierto = !!f && ((f.estado === 'PENDIENTE_REENVIO' && f.accion === 'RECUPERAR_CDR') || (['ENVIANDO', 'EXCEPCION'].includes(f.estado) && f.libre));
    if (!f || !incierto) return null;
    Object.assign(f, { estado: 'ACEPTADO', accion: 'NINGUNA', libre: true });
    this.manual = json;
    return { id_comprobante: f.id_comprobante, tipo_documento: f.tipo_documento, ambiente: f.ambiente, archivos: ['xml_original', 'xml_firmado', 'zip'] };
  });
}

class RelojPrueba extends RelojFiscal {
  momento = new Date('2026-10-13T15:00:00Z');
  ahora(): Date {
    return this.momento;
  }
}

/** Clasificador fijo para los casos que no prueban la tabla de códigos (la mantiene el núcleo). */
function clasificadorFijo(decision: ClasificacionRespuesta): ClasificadorRespuestaSunat {
  return { clasificar: jest.fn(() => decision) } as unknown as ClasificadorRespuestaSunat;
}

const CREDENCIALES_PRODUCCION = { usuario: '20610206337HATUN001', clave: 'ClaveSol#26' };

function crear(opciones: { clasificador?: ClasificadorRespuestaSunat; credenciales?: jest.Mock } = {}) {
  const reloj = new RelojPrueba();
  const envios = new EnviosMemoria();
  const transporte = { enviar: jest.fn() };
  const bloqueos: Record<AmbienteFiscal, BloqueoEmision | null> = { beta: null, produccion: null };
  const interruptor = {
    leer: jest.fn(async (ambiente: AmbienteFiscal) => bloqueos[ambiente]),
    abrir: jest.fn(async (ambiente: AmbienteFiscal, causa: { codigo: string; motivo: string }) => {
      bloqueos[ambiente] = { ...causa, fecha: '2026-10-13T15:00:00.000Z' };
      return bloqueos[ambiente];
    }),
  };
  const credencialesSol = { obtener: opciones.credenciales ?? jest.fn(async () => ({ ...CREDENCIALES_PRODUCCION })) };
  const oyentes = new OyentesEnvioFiscal();
  const eventos: EventoEnvioCompletado[] = [];
  oyentes.registrar({ alCompletarEnvio: async (evento: EventoEnvioCompletado) => void eventos.push(evento) } as OyenteEnvioFiscal);
  const auditoria = { registrar: jest.fn(async () => undefined) };
  const consultasTx: string[] = [];
  const transacciones = {
    ejecutar: jest.fn(async (trabajo: (tx: { query: jest.Mock }) => Promise<unknown>) =>
      trabajo({ query: jest.fn(async (sql: string) => (consultasTx.push(sql), [])) }),
    ),
  };
  const servicio = new SunatEmisionService(
    envios as unknown as EnvioFiscalRepository,
    new PreparadorEnvioCpe(),
    new FabricaClienteSoapSunat({ transporte, esperar: async () => undefined }),
    opciones.clasificador ?? new ClasificadorRespuestaSunat({ warn: () => undefined }),
    credencialesSol as unknown as CredencialesSolService,
    interruptor as unknown as InterruptorEmisionFiscal,
    oyentes,
    auditoria as unknown as FiscalAuditoriaRepository,
    transacciones as unknown as TransaccionesFiscales,
    reloj,
  );
  const esperas: number[] = [];
  jest.spyOn(servicio as unknown as { esperar: (ms: number) => Promise<void> }, 'esperar').mockImplementation(async (ms: number) => {
    esperas.push(ms);
  });
  return { servicio, envios, transporte, interruptor, bloqueos, credencialesSol, eventos, auditoria, transacciones, reloj, esperas };
}

const certificado = generarCertificadoPrueba({ desde: new Date('2026-10-01'), hasta: new Date('2027-10-13') });
const material = materialDePrueba(certificado);

function factura(serie = 'FB01', numero = 5): DocumentoCpe {
  return facturaPrueba(undefined, { serie, numero });
}

function boleta(serie = 'BB01', numero = 6): DocumentoCpe {
  return boletaPrueba(undefined, { serie, numero });
}

function cdrDe(documento: DocumentoCpe, codigo = '0', descripcion = 'Aceptada'): string {
  return cdrPrueba({ codigo, descripcion, referencia: `${documento.serie}-${documento.numero}` });
}

const SEND_BILL = '"urn:sendBill"';
const GET_STATUS_CDR = '"urn:getStatusCdr"';

describe('SunatEmisionService: envío directo en BETA y PRODUCCIÓN (transporte simulado)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('BETA: manda el ZIP en memoria al endpoint BETA con RUC+MODDATOS, verifica el CDR, guarda y avisa', async () => {
    const { servicio, envios, transporte, eventos, credencialesSol } = crear();
    const doc = factura();
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'beta', documento: doc, preparado });
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaSendBill(cdrDe(doc)) });

    const resultado = await servicio.enviar(envio.id_envio, { ambiente: 'beta', documento: doc, preparado });

    const peticion = transporte.enviar.mock.calls[0][0];
    expect(peticion.url).toBe('https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService');
    expect(peticion.soapAction).toBe(SEND_BILL);
    expect(peticion.cuerpo).toContain('<wsse:Username>20610206337MODDATOS</wsse:Username>');
    expect(peticion.cuerpo).toContain(`<fileName>${preparado.nombreBase}.zip</fileName>`);
    expect(peticion.cuerpo).toContain(`<contentFile>${preparado.zip.base64}</contentFile>`);
    expect(credencialesSol.obtener).not.toHaveBeenCalled();
    expect(envios.reclamarPrimerEnvio).toHaveBeenCalledWith(envio.id_envio, false);
    const xml = new AdmZip(preparado.zip.zip).readAsText(new AdmZip(preparado.zip.zip).getEntries()[0]);
    expect(verificarFirmaXml(xml, certificado.certificatePem)).toBe(true);

    expect(resultado).toMatchObject({
      ambiente: 'beta',
      estado: 'ACEPTADO',
      aceptado: true,
      codigo: '0',
      serie: 'FB01',
      numero: 5,
      id_comprobante: 500,
      fecha_limite_envio: '2026-10-16',
      digest: preparado.digestValue,
      cadena_qr: preparado.cadenaQr,
    });
    expect(resultado.archivos).toEqual(['xml_original', 'xml_firmado', 'zip', 'cdr_xml', 'cdr_zip']);
    expect(envios.cierres[0].cierre).toMatchObject({
      estado: 'ACEPTADO',
      cdr: { xml: expect.stringContaining('ApplicationResponse'), zip: expect.any(Buffer) },
      json: { clasificacion: { estado: 'ACEPTADO', accion: 'NINGUNA' }, respuesta: { tipo: 'CDR', codigo: '0' } },
    });
    expect(JSON.stringify(envios.cierres[0].cierre.json)).not.toContain('PRIVATE KEY');
    expect(eventos).toEqual([
      { id_envio: envio.id_envio, id_comprobante: 500, ambiente: 'beta', tipo_documento: '01', estado: 'ACEPTADO', aceptado: true, origen: 'envio' },
    ]);
  });

  it('PRODUCCIÓN: usa el endpoint real y el usuario secundario SOL del panel (la clave nunca sale en el resultado)', async () => {
    const { servicio, envios, transporte, credencialesSol } = crear();
    const doc = factura('F001', 120);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado });
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaSendBill(cdrDe(doc)) });

    const resultado = await servicio.enviar(envio.id_envio);

    expect(credencialesSol.obtener).toHaveBeenCalledWith('produccion');
    const peticion = transporte.enviar.mock.calls[0][0];
    expect(peticion.url).toBe('https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService');
    expect(peticion.cuerpo).toContain('<wsse:Username>20610206337HATUN001</wsse:Username>');
    // Sin el documento en memoria se manda el ZIP guardado (los mismos bytes).
    expect(envios.reclamarPrimerEnvio).toHaveBeenCalledWith(envio.id_envio, true);
    expect(peticion.cuerpo).toContain(`<contentFile>${preparado.zip.base64}</contentFile>`);
    expect(resultado).toMatchObject({ ambiente: 'produccion', aceptado: true, serie: 'F001', numero: 120 });
    expect(JSON.stringify(resultado)).not.toContain(CREDENCIALES_PRODUCCION.clave);
  });

  it('un usuario SOL de otro RUC no llega a SUNAT: el envío queda pendiente con el motivo', async () => {
    const credenciales = jest.fn(async () => ({ usuario: '20100070970HATUN001', clave: 'x12345678' }));
    const { servicio, envios, transporte } = crear({ credenciales });
    const doc = factura('F001', 7);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado });

    const resultado = await servicio.enviar(envio.id_envio, { ambiente: 'produccion', documento: doc, preparado });

    expect(transporte.enviar).not.toHaveBeenCalled();
    expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', aceptado: false });
    expect(resultado.mensaje).toMatch(/no es del RUC emisor 20610206337/);
    expect(envios.cierres[0].cierre.proximoIntentoMin).toBe(1);
  });

  it('D4: un CDR de OTRO comprobante no se acepta; queda en EXCEPCION y se guarda para auditoría', async () => {
    const { servicio, envios, transporte, eventos } = crear();
    const doc = factura('F001', 8);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado });
    transporte.enviar.mockResolvedValueOnce({
      estadoHttp: 200,
      cuerpo: respuestaSendBill(cdrPrueba({ codigo: '0', descripcion: 'Aceptada', referencia: 'F001-9' })),
    });

    const resultado = await servicio.enviar(envio.id_envio, { ambiente: 'produccion', documento: doc, preparado });

    expect(resultado).toMatchObject({ estado: 'EXCEPCION', aceptado: false, accion: 'RECUPERAR_CDR' });
    expect(resultado.mensaje).toMatch(/^La constancia \(CDR\) no corresponde al comprobante enviado/);
    const { cierre } = envios.cierres[0];
    expect(cierre.cdr?.xml).toContain('F001-9');
    expect(cierre.json).toMatchObject({ verificacion_cdr: { coincide: false }, clasificacion: { estado: 'EXCEPCION' } });
    expect(eventos[0]).toMatchObject({ estado: 'EXCEPCION', aceptado: false });
  });

  it('D5.3: si la BD falla tras la respuesta reintenta el guardado con la respuesta en memoria (sin reenviar)', async () => {
    const { servicio, envios, transporte, esperas } = crear();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const doc = factura();
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'beta', documento: doc, preparado });
    envios.fallasCompletar = 2;
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaSendBill(cdrDe(doc)) });

    const resultado = await servicio.enviar(envio.id_envio, { ambiente: 'beta', documento: doc, preparado });

    expect(resultado.aceptado).toBe(true);
    expect(envios.completar).toHaveBeenCalledTimes(3);
    expect(esperas).toEqual([250, 500]);
    expect(transporte.enviar).toHaveBeenCalledTimes(1);
  });

  it('D5.3: tras 3 reintentos fallidos responde 503 con el envío para recuperarlo (y no reenvía)', async () => {
    const { servicio, envios, transporte, eventos } = crear();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const doc = factura();
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'beta', documento: doc, preparado });
    envios.fallasCompletar = 10;
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaSendBill(cdrDe(doc)) });

    const error = await servicio.enviar(envio.id_envio, { ambiente: 'beta', documento: doc, preparado }).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({ id_envio: envio.id_envio, ambiente: 'beta', estado_sunat: 'ACEPTADO', codigo_sunat: '0' });
    expect(envios.completar).toHaveBeenCalledTimes(4);
    expect(transporte.enviar).toHaveBeenCalledTimes(1);
    expect(eventos).toEqual([]);
  });

  it('nunca repite sendBill por su cuenta: un timeout queda pendiente con espera de 1 minuto', async () => {
    const { servicio, envios, transporte } = crear();
    const doc = factura();
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'beta', documento: doc, preparado });
    transporte.enviar.mockRejectedValueOnce(new ErrorTransporteSoap('ETIMEDOUT', 'Tiempo agotado'));

    const resultado = await servicio.enviar(envio.id_envio, { ambiente: 'beta', documento: doc, preparado });

    expect(transporte.enviar).toHaveBeenCalledTimes(1);
    expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', codigo: 'ETIMEDOUT' });
    expect(resultado.archivos).toEqual(['xml_original', 'xml_firmado', 'zip']);
    expect(envios.cierres[0].cierre.proximoIntentoMin).toBe(1);
  });

  it('si otro proceso ya tomó el envío no se vuelve a mandar', async () => {
    const { servicio, envios, transporte } = crear();
    const doc = factura();
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'beta', documento: doc, preparado, intento: 2 });

    const resultado = await servicio.enviar(envio.id_envio, { ambiente: 'beta', documento: doc, preparado });

    expect(transporte.enviar).not.toHaveBeenCalled();
    expect(resultado).toMatchObject({ estado: 'ENVIANDO', aceptado: false });
    expect(resultado.mensaje).toMatch(/no se volvió a enviar/);
  });

  it('D5.4: un rechazo de credencial abre el interruptor del ambiente y el comprobante espera la reanudación', async () => {
    const clasificador = clasificadorFijo({
      estado: 'ERROR_CONFIG',
      accion: 'REVISAR_CONFIG',
      mensajeUsuario: 'SUNAT rechazó el usuario o la clave SOL (0102).',
      bloqueaEmision: true,
    });
    const { servicio, envios, transporte, interruptor, bloqueos } = crear({ clasificador });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const doc = factura('F001', 30);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado });
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 500, cuerpo: respuestaFault('soap-env:Client.0102', 'Usuario o contraseña incorrectos') });

    const resultado = await servicio.enviar(envio.id_envio, { ambiente: 'produccion', documento: doc, preparado });

    expect(interruptor.abrir).toHaveBeenCalledWith(
      'produccion',
      { codigo: '0102', motivo: 'SUNAT rechazó el usuario o la clave SOL (0102).' },
      { id_envio: envio.id_envio, tipo_documento: '01' },
    );
    expect(bloqueos.produccion).toMatchObject({ codigo: '0102' });
    expect(bloqueos.beta).toBeNull();
    expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR' });
    expect(resultado.mensaje).toMatch(/se enviará cuando se reanude/);
    expect(envios.cierres[0].cierre.proximoIntentoMin).toBe(0);

    // Con el interruptor abierto el siguiente envío ni siquiera llama a SUNAT.
    const otro = factura('F001', 31);
    const otroPreparado = servicio.preparar(otro, material);
    const segundo = envios.agregar({ ambiente: 'produccion', documento: otro, preparado: otroPreparado });
    const pendiente = await servicio.enviar(segundo.id_envio, { ambiente: 'produccion', documento: otro, preparado: otroPreparado });
    expect(transporte.enviar).toHaveBeenCalledTimes(1);
    expect(pendiente).toMatchObject({ estado: 'PENDIENTE_REENVIO' });
    expect(pendiente.mensaje).toMatch(/está detenida/);
  });

  it('valida antes de firmar: un error del documento no persiste ni envía nada', async () => {
    const { servicio, envios, transporte } = crear();
    const doc = factura();
    doc.totales.total = 999;
    expect(() => servicio.preparar(doc, material)).toThrow(FiscalConfigError);
    try {
      servicio.preparar(doc, material);
    } catch (error) {
      expect((error as FiscalConfigError).codigo).toBe('FISCAL_VALIDACION_CPE');
    }
    expect(envios.registrar).not.toHaveBeenCalled();
    expect(transporte.enviar).not.toHaveBeenCalled();
  });

  it('prueba del panel (BETA): registra sin comprobante comercial y envía; exige el RUC del certificado', async () => {
    const { servicio, envios, transporte, transacciones } = crear();
    const doc = factura('FB01', 9);
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaSendBill(cdrDe(doc)) });

    const resultado = await servicio.emitirPrueba(doc, material, 3);

    expect(transacciones.ejecutar).toHaveBeenCalledTimes(1);
    expect(envios.registrar.mock.calls[0][1]).toMatchObject({ ambiente: 'beta', idComprobante: null, idUsuario: 3 });
    expect(resultado).toMatchObject({ aceptado: true, id_comprobante: null });
    await expect(servicio.emitirPrueba(doc, { ...material, ruc: '20131312955' }, 3)).rejects.toMatchObject({ codigo: 'FISCAL_CERT_RUC_NO_COINCIDE' });
  });
});

describe('SunatEmisionService.reintentar (D5.1, D5.2)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('BETA: reenvía exactamente los mismos bytes del ZIP, sin consultar el CDR y sin volver a firmar', async () => {
    const { servicio, envios, transporte, eventos } = crear();
    const doc = factura();
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'beta', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true });
    const preparar = jest.spyOn(PreparadorEnvioCpe.prototype, 'prepararComprobante');
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaSendBill(cdrDe(doc)) });

    const resultado = await servicio.reintentar(envio.id_envio);

    expect(preparar).not.toHaveBeenCalled();
    expect(transporte.enviar).toHaveBeenCalledTimes(1);
    expect(transporte.enviar.mock.calls[0][0].soapAction).toBe(SEND_BILL);
    expect(transporte.enviar.mock.calls[0][0].cuerpo).toContain(`<contentFile>${preparado.zip.base64}</contentFile>`);
    expect(resultado).toMatchObject({ aceptado: true, estado: 'ACEPTADO' });
    expect(eventos[0]).toMatchObject({ origen: 'reintento', aceptado: true });
  });

  it('PRODUCCIÓN (factura): primero getStatusCdr; si SUNAT ya tiene un CDR coincidente lo completa SIN reenviar', async () => {
    const { servicio, envios, transporte } = crear();
    const doc = factura('F001', 40);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'ENVIANDO', libre: true });
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaGetStatusCdr('0001', 'La constancia existe', cdrDe(doc)) });

    const resultado = await servicio.reintentar(envio.id_envio);

    expect(transporte.enviar).toHaveBeenCalledTimes(1);
    const peticion = transporte.enviar.mock.calls[0][0];
    expect(peticion.soapAction).toBe(GET_STATUS_CDR);
    expect(peticion.url).toBe('https://e-factura.sunat.gob.pe/ol-it-wsconscpegem/billConsultService');
    expect(peticion.cuerpo).toContain('<serieComprobante>F001</serieComprobante>');
    expect(resultado).toMatchObject({ aceptado: true, estado: 'ACEPTADO' });
    expect(envios.cierres[0].cierre.json).toHaveProperty('consulta');
  });

  it('PRODUCCIÓN (factura): si getStatusCdr responde 0011 (no existe) reenvía el MISMO ZIP', async () => {
    const { servicio, envios, transporte } = crear();
    const doc = factura('F001', 41);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true });
    transporte.enviar
      .mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaGetStatusCdr('0011', 'El comprobante no existe') })
      .mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaSendBill(cdrDe(doc)) });

    const resultado = await servicio.reintentar(envio.id_envio);

    expect(transporte.enviar.mock.calls.map((c) => c[0].soapAction)).toEqual([GET_STATUS_CDR, SEND_BILL]);
    expect(transporte.enviar.mock.calls[1][0].cuerpo).toContain(`<contentFile>${preparado.zip.base64}</contentFile>`);
    expect(resultado.aceptado).toBe(true);
  });

  it('PRODUCCIÓN (factura): si la consulta falla no reenvía; queda pendiente con espera y el código anterior', async () => {
    const { servicio, envios, transporte } = crear();
    const doc = factura('F001', 42);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({
      ambiente: 'produccion',
      documento: doc,
      preparado,
      estado: 'PENDIENTE_REENVIO',
      accion: 'REINTENTAR',
      libre: true,
      intento: 2,
      codigo_sunat: 'ETIMEDOUT',
    });
    transporte.enviar.mockRejectedValue(new ErrorTransporteSoap('ECONNRESET', 'Conexión cerrada'));

    const resultado = await servicio.reintentar(envio.id_envio);

    expect(transporte.enviar.mock.calls.every((c) => c[0].soapAction === GET_STATUS_CDR)).toBe(true);
    expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', codigo: 'ETIMEDOUT' });
    expect(envios.cierres[0].cierre).toMatchObject({ sunat: null, proximoIntentoMin: 10 });
  });

  it('boleta en producción: no hay getStatusCdr; reenvía el mismo ZIP', async () => {
    const { servicio, envios, transporte } = crear();
    const doc = boleta('B001', 50);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'ENVIANDO', libre: true });
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaSendBill(cdrDe(doc)) });

    await servicio.reintentar(envio.id_envio);

    expect(transporte.enviar.mock.calls.map((c) => c[0].soapAction)).toEqual([SEND_BILL]);
  });

  it('D5.2: fuera de plazo una factura de BETA no se reenvía (EXCEPCION: emita un comprobante nuevo)', async () => {
    const { servicio, envios, transporte, reloj } = crear();
    const doc = factura();
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'beta', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true });
    reloj.momento = new Date('2026-10-20T15:00:00Z');

    const resultado = await servicio.reintentar(envio.id_envio);

    expect(transporte.enviar).not.toHaveBeenCalled();
    expect(resultado).toMatchObject({ estado: 'EXCEPCION', accion: 'EMITIR_NUEVO' });
    expect(resultado.mensaje).toMatch(/^Fuera de plazo: emita un comprobante nuevo/);
  });

  it('D5.2: fuera de plazo una boleta no se reenvía por sendBill; pasados los 7 días solo queda la nota de crédito', async () => {
    const { servicio, envios, transporte, reloj } = crear();
    const doc = boleta('B001', 51);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true });
    reloj.momento = new Date('2026-10-25T15:00:00Z');

    const resultado = await servicio.reintentar(envio.id_envio);

    expect(transporte.enviar).not.toHaveBeenCalled();
    expect(resultado).toMatchObject({ estado: 'EXCEPCION', accion: 'EMITIR_NUEVO' });
    expect(resultado.mensaje).toMatch(/^El plazo de envío individual de B001-51 venció el 18\/10 y ya pasaron los 7 días del resumen diario\. Si el cliente reclama el comprobante, anúlelo con nota de crédito y emita uno nuevo\./);
  });

  it('S2: una boleta que venció el envío individual pero sigue dentro de los 7 días queda para el resumen diario (RESUMIR), sin nota de crédito', async () => {
    const { servicio, envios, transporte, reloj } = crear();
    const doc = boleta('B001', 52);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true });
    // Emitida el 13/10: el envío individual vence el 18/10; el 19/10 lleva 6 días y el resumen admite hasta el 20/10.
    reloj.momento = new Date('2026-10-19T15:00:00Z');

    const resultado = await servicio.reintentar(envio.id_envio);

    expect(transporte.enviar).not.toHaveBeenCalled();
    expect(resultado).toMatchObject({ estado: 'EXCEPCION', accion: 'RESUMIR' });
    expect(resultado.mensaje).toMatch(/venció el 18\/10\. Se informará a SUNAT en el próximo resumen diario \(hasta el 20\/10\)/);
    expect(resultado.mensaje).toMatch(/«Informar por resumen»/);
    expect(resultado.mensaje).not.toMatch(/nota de crédito/);

    // El 21/10 ya pasaron los 7 días: otra boleta en el mismo caso solo se resuelve con nota de crédito.
    const tarde = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true });
    reloj.momento = new Date('2026-10-21T15:00:00Z');
    expect(await servicio.reintentar(tarde.id_envio)).toMatchObject({ estado: 'EXCEPCION', accion: 'EMITIR_NUEVO' });
  });

  it('D5.2: fuera de plazo una factura de producción: si SUNAT no la tiene → emitir nuevo; si la consulta no es concluyente → recuperar constancia', async () => {
    const { servicio, envios, transporte, reloj } = crear();
    const doc = factura('F001', 53);
    const preparado = servicio.preparar(doc, material);
    const sinRegistro = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true });
    const sinRespuesta = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true });
    reloj.momento = new Date('2026-10-20T15:00:00Z');
    transporte.enviar
      .mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaGetStatusCdr('0011', 'El comprobante no existe') })
      .mockRejectedValueOnce(new ErrorTransporteSoap('ETIMEDOUT', 'Tiempo agotado'));

    expect(await servicio.reintentar(sinRegistro.id_envio)).toMatchObject({ estado: 'EXCEPCION', accion: 'EMITIR_NUEVO' });
    expect(await servicio.reintentar(sinRespuesta.id_envio)).toMatchObject({ estado: 'EXCEPCION', accion: 'RECUPERAR_CDR' });
    expect(transporte.enviar.mock.calls.every((c) => c[0].soapAction === GET_STATUS_CDR)).toBe(true);
  });

  it('D5.2: fuera de plazo una factura de producción consulta antes su CDR y, si SUNAT la tiene, la completa', async () => {
    const { servicio, envios, transporte, reloj } = crear();
    const doc = factura('F001', 52);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'ENVIANDO', libre: true });
    reloj.momento = new Date('2026-10-20T15:00:00Z');
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaGetStatusCdr('0001', 'Existe', cdrDe(doc)) });

    const resultado = await servicio.reintentar(envio.id_envio);

    expect(transporte.enviar.mock.calls.map((c) => c[0].soapAction)).toEqual([GET_STATUS_CDR]);
    expect(resultado).toMatchObject({ aceptado: true });
  });

  it('solo reintenta pendientes o ENVIANDO vencidos; nunca los que esperan recuperar el CDR', async () => {
    const { servicio, envios, transporte } = crear();
    const doc = factura();
    const preparado = servicio.preparar(doc, material);
    const aceptado = envios.agregar({ ambiente: 'beta', documento: doc, preparado, estado: 'ACEPTADO', libre: true });
    const recuperar = envios.agregar({ ambiente: 'beta', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'RECUPERAR_CDR', libre: true });
    const enCurso = envios.agregar({ ambiente: 'beta', documento: doc, preparado, estado: 'ENVIANDO', libre: false });

    await expect(servicio.reintentar(aceptado.id_envio)).rejects.toMatchObject({ codigo: 'FISCAL_REENVIO_NO_PERMITIDO' });
    await expect(servicio.reintentar(recuperar.id_envio)).rejects.toMatchObject({
      codigo: 'FISCAL_REENVIO_NO_PERMITIDO',
      message: expect.stringMatching(/recupere su constancia o confírmelo manualmente/),
    });
    await expect(servicio.reintentar(enCurso.id_envio)).rejects.toMatchObject({ codigo: 'FISCAL_REENVIO_NO_PERMITIDO' });
    await expect(servicio.reintentar(9999)).rejects.toMatchObject({ codigo: 'FISCAL_DOC_NO_ENCONTRADO' });
    expect(transporte.enviar).not.toHaveBeenCalled();
  });

  it('con el interruptor del ambiente abierto no reintenta (FISCAL_EMISION_BLOQUEADA)', async () => {
    const { servicio, envios, transporte, bloqueos } = crear();
    const doc = factura('F001', 60);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true });
    bloqueos.produccion = { codigo: '0104', motivo: 'Clave SOL incorrecta.', fecha: '2026-10-13' };

    await expect(servicio.reintentar(envio.id_envio)).rejects.toMatchObject({ codigo: 'FISCAL_EMISION_BLOQUEADA' });
    expect(envios.reclamarReintento).not.toHaveBeenCalled();
    expect(transporte.enviar).not.toHaveBeenCalled();
  });

  it('backoff 1-3-10-30-60 min y, tras 6 intentos dentro del plazo, sigue cada 60 min (no es un callejón)', async () => {
    const { servicio, envios, transporte } = crear();
    transporte.enviar.mockRejectedValue(new ErrorTransporteSoap('ETIMEDOUT', 'Tiempo agotado'));
    const doc = factura();
    const preparado = servicio.preparar(doc, material);

    const conIntento = (intento: number) =>
      envios.agregar({ ambiente: 'beta', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true, intento });

    await servicio.reintentar(conIntento(1).id_envio, 'tarea');
    await servicio.reintentar(conIntento(3).id_envio, 'tarea');
    expect(envios.cierres.map((c) => c.cierre.proximoIntentoMin)).toEqual([3, 30]);

    const ultimo = await servicio.reintentar(conIntento(5).id_envio, 'tarea');
    expect(ultimo).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR' });
    expect(ultimo.mensaje).toMatch(/SUNAT no respondió en 6 intentos; se seguirá intentando cada hora hasta el 16\/10 \(plazo de envío\)/);
    expect(envios.cierres.at(-1)!.cierre.proximoIntentoMin).toBe(ESPERA_LENTA_MINUTOS);

    // Los siguientes (7.º, 8.º…) conservan la espera lenta.
    const septimo = await servicio.reintentar(conIntento(6).id_envio, 'tarea');
    expect(septimo).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR' });
    expect(envios.cierres.at(-1)!.cierre.proximoIntentoMin).toBe(60);
  });

  it('con una respuesta que pide reintentar (no solo timeout) también sigue cada hora dentro del plazo', async () => {
    const decision: ClasificacionRespuesta = { estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', mensajeUsuario: 'SUNAT está ocupada.', bloqueaEmision: false };
    const { servicio, envios, transporte } = crear({ clasificador: clasificadorFijo(decision) });
    transporte.enviar.mockResolvedValue({ estadoHttp: 200, cuerpo: '<x/>' } as { estadoHttp: number; cuerpo: string });
    const doc = boleta('BB01', 61);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'beta', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true, intento: 5 });

    const resultado = await servicio.reintentar(envio.id_envio, 'tarea');

    expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR' });
    expect(resultado.mensaje).toMatch(/hasta el 18\/10 \(plazo de envío\)\. Última respuesta: SUNAT está ocupada\./);
    expect(envios.cierres[0].cierre.proximoIntentoMin).toBe(60);
  });

  it('al vencer el plazo en pleno reintento pasa a EXCEPCION con la acción del tipo: factura de BETA → emitir nuevo', async () => {
    const { servicio, envios, transporte, reloj } = crear();
    transporte.enviar.mockRejectedValue(new ErrorTransporteSoap('ETIMEDOUT', 'Tiempo agotado'));
    const doc = factura();
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'beta', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true, intento: 6 });
    // El intento empieza dentro del plazo (16/10) y termina pasada la medianoche (17/10).
    jest.spyOn(reloj, 'fechaLima').mockReturnValueOnce('2026-10-16').mockReturnValue('2026-10-17');

    const resultado = await servicio.reintentar(envio.id_envio, 'tarea');

    expect(resultado).toMatchObject({ estado: 'EXCEPCION', accion: 'EMITIR_NUEVO' });
    expect(resultado.mensaje).toMatch(/venció el 16\/10/);
    expect(envios.cierres[0].cierre.proximoIntentoMin).toBeNull();
  });

  it('al vencer el plazo, una factura de PRODUCCIÓN queda para «Recuperar constancia» (RECUPERAR_CDR) y una boleta, para el resumen diario', async () => {
    const { servicio, envios, transporte, reloj } = crear();
    transporte.enviar.mockRejectedValue(new ErrorTransporteSoap('ETIMEDOUT', 'Tiempo agotado'));
    const doc = factura('F001', 62);
    const preparado = servicio.preparar(doc, material);
    const deFactura = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true, intento: 6 });
    const bol = boleta('B001', 63);
    const bolPreparada = servicio.preparar(bol, material);
    const deBoleta = envios.agregar({ ambiente: 'produccion', documento: bol, preparado: bolPreparada, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true, intento: 6 });
    jest.spyOn(reloj, 'fechaLima').mockReturnValueOnce('2026-10-16').mockReturnValue('2026-10-17');

    const factura1 = await servicio.reintentar(deFactura.id_envio, 'tarea');
    expect(factura1).toMatchObject({ estado: 'EXCEPCION', accion: 'RECUPERAR_CDR' });
    expect(factura1.mensaje).toMatch(/«Recuperar constancia»/);

    jest.spyOn(reloj, 'fechaLima').mockReturnValueOnce('2026-10-18').mockReturnValue('2026-10-19');
    const boleta1 = await servicio.reintentar(deBoleta.id_envio, 'tarea');
    // Emitida el 13/10 y hoy 19/10: aún dentro de los 7 días del resumen diario.
    expect(boleta1).toMatchObject({ estado: 'EXCEPCION', accion: 'RESUMIR' });
    expect(boleta1.mensaje).toMatch(/próximo resumen diario/);
  });

  it('reintento manual: queda auditado con el usuario y el estado previo; si no se puede auditar, igual se reintenta', async () => {
    const { servicio, envios, transporte, auditoria } = crear();
    const doc = factura();
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'beta', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true, intento: 3 });
    transporte.enviar.mockResolvedValue({ estadoHttp: 200, cuerpo: respuestaSendBill(cdrDe(doc)) });

    await servicio.reintentar(envio.id_envio, 'reintento', { actor: { id_usuario: 7, nombre: 'Moisés', ip: '10.0.0.5' } });

    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'FISCAL_REINTENTO_MANUAL',
        id_usuario: 7,
        entidad: 'fiscal_envios',
        id_entidad: envio.id_envio,
        ip: '10.0.0.5',
        detalle: expect.objectContaining({ estado_previo: 'PENDIENTE_REENVIO', forzado: false, intento: 3, usuario: 'Moisés' }),
      }),
    );
    expect(envios.reclamarReintento).toHaveBeenCalledWith(envio.id_envio, false);

    // La tarea no es un reintento manual: no audita.
    auditoria.registrar.mockClear();
    const otro = envios.agregar({ ambiente: 'beta', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true });
    await servicio.reintentar(otro.id_envio, 'tarea');
    expect(auditoria.registrar).not.toHaveBeenCalled();

    // Un fallo de la bitácora no impide el reintento común.
    auditoria.registrar.mockRejectedValueOnce(new Error('bitácora caída'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const tercero = envios.agregar({ ambiente: 'beta', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true });
    await expect(servicio.reintentar(tercero.id_envio, 'reintento', { actor: { id_usuario: 7, nombre: 'Moisés', ip: null } })).resolves.toMatchObject({ aceptado: true });
  });

  it('EXCEPCION: «Reintentar ahora» (forzar) la reintenta, la audita con forzado y el estado previo, y sube el intento', async () => {
    const { servicio, envios, transporte, auditoria } = crear();
    const doc = factura();
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'beta', documento: doc, preparado, estado: 'EXCEPCION', accion: 'NINGUNA', libre: true, intento: 6 });
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaSendBill(cdrDe(doc)) });

    const resultado = await servicio.reintentar(envio.id_envio, 'reintento', { forzar: true, actor: { id_usuario: 7, nombre: 'Moisés', ip: null } });

    expect(resultado).toMatchObject({ estado: 'ACEPTADO', aceptado: true });
    expect(envios.reclamarReintento).toHaveBeenCalledWith(envio.id_envio, true);
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'FISCAL_REINTENTO_MANUAL', detalle: expect.objectContaining({ forzado: true, estado_previo: 'EXCEPCION', intento: 6 }) }),
    );
    expect(envios.filas.get(envio.id_envio)!.intento).toBe(7);
  });

  it('EXCEPCION sin forzar (o desde la tarea) no se reintenta; forzar exige conocer al administrador y auditar primero', async () => {
    const { servicio, envios, transporte, auditoria } = crear();
    const doc = factura();
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'beta', documento: doc, preparado, estado: 'EXCEPCION', accion: 'NINGUNA', libre: true, intento: 6 });

    await expect(servicio.reintentar(envio.id_envio, 'reintento', { actor: { id_usuario: 7, nombre: 'Moisés', ip: null } })).rejects.toMatchObject({
      codigo: 'FISCAL_REENVIO_NO_PERMITIDO',
      message: expect.stringMatching(/Reintentar ahora/),
    });
    await expect(servicio.reintentar(envio.id_envio, 'tarea', { forzar: true, actor: { id_usuario: 7, nombre: 'Moisés', ip: null } })).rejects.toMatchObject({
      codigo: 'FISCAL_REENVIO_NO_PERMITIDO',
    });
    // Sin usuario no se fuerza.
    await expect(servicio.reintentar(envio.id_envio, 'reintento', { forzar: true })).rejects.toMatchObject({ codigo: 'FISCAL_CONFIG_INVALIDA' });
    expect(auditoria.registrar).not.toHaveBeenCalled();

    // Si la bitácora falla, el reintento forzado no se hace (se audita antes de tocar nada).
    auditoria.registrar.mockRejectedValueOnce(new Error('bitácora caída'));
    await expect(servicio.reintentar(envio.id_envio, 'reintento', { forzar: true, actor: { id_usuario: 7, nombre: 'Moisés', ip: null } })).rejects.toThrow('bitácora caída');
    expect(envios.reclamarReintento).not.toHaveBeenCalled();
    expect(transporte.enviar).not.toHaveBeenCalled();
  });

});

describe('SunatEmisionService.recuperarCdr y confirmarAceptadoManual (D4, D5.1)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('no consulta en BETA ni para boletas (mensaje claro, sin llamar a SUNAT)', async () => {
    const { servicio, envios, transporte } = crear();
    const doc = factura();
    const preparado = servicio.preparar(doc, material);
    const beta = envios.agregar({ ambiente: 'beta', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'RECUPERAR_CDR', libre: true });
    const bol = boleta('B001', 70);
    const bolPreparada = servicio.preparar(bol, material);
    const deBoleta = envios.agregar({ ambiente: 'produccion', documento: bol, preparado: bolPreparada, estado: 'PENDIENTE_REENVIO', accion: 'RECUPERAR_CDR', libre: true });

    await expect(servicio.recuperarCdr(beta.id_envio)).rejects.toMatchObject({ codigo: 'FISCAL_CONSULTA_NO_DISPONIBLE', message: expect.stringMatching(/BETA/) });
    await expect(servicio.recuperarCdr(deBoleta.id_envio)).rejects.toMatchObject({
      codigo: 'FISCAL_CONSULTA_NO_DISPONIBLE',
      message: expect.stringMatching(/boletas/),
    });
    expect(transporte.enviar).not.toHaveBeenCalled();
  });

  it('tras 1033 un CDR recuperado que coincide NO se acepta solo: queda para la confirmación manual', async () => {
    const { servicio, envios, transporte, eventos } = crear();
    const doc = factura('F001', 80);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({
      ambiente: 'produccion',
      documento: doc,
      preparado,
      estado: 'PENDIENTE_REENVIO',
      accion: 'RECUPERAR_CDR',
      libre: true,
      codigo_sunat: '1033',
      registrado_con_otros_datos: true,
    });
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaGetStatusCdr('0001', 'Existe', cdrDe(doc)) });

    const resultado = await servicio.recuperarCdr(envio.id_envio);

    expect(transporte.enviar.mock.calls.map((c) => c[0].soapAction)).toEqual([GET_STATUS_CDR]);
    expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'RECUPERAR_CDR', aceptado: false });
    expect(resultado.mensaje).toMatch(/confírmelo como aceptado/);
    expect(envios.cierres[0].cierre.cdr?.xml).toContain('F001-80');
    expect(eventos[0]).toMatchObject({ origen: 'recuperacion', aceptado: false });
  });

  it('sin 1033/2109 previo, un CDR recuperado coincidente decide el estado (aceptado)', async () => {
    const { servicio, envios, transporte } = crear();
    const doc = factura('F001', 81);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'ENVIANDO', libre: true, codigo_sunat: 'ETIMEDOUT' });
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaGetStatusCdr('0001', 'Existe', cdrDe(doc)) });

    expect(await servicio.recuperarCdr(envio.id_envio)).toMatchObject({ aceptado: true, estado: 'ACEPTADO' });
  });

  it('«Recuperar CDR» queda auditado (FISCAL_CDR_RECUPERADO) con el usuario, el estado y si llegó la constancia', async () => {
    const { servicio, envios, transporte, auditoria } = crear();
    const doc = factura('F001', 83);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'ENVIANDO', libre: true, codigo_sunat: 'ETIMEDOUT' });
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaGetStatusCdr('0001', 'Existe', cdrDe(doc)) });

    await servicio.recuperarCdr(envio.id_envio, { actor: { id_usuario: 7, nombre: 'Moisés', ip: '10.0.0.5' } });

    expect(auditoria.registrar).toHaveBeenCalledTimes(1);
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'FISCAL_CDR_RECUPERADO',
        id_usuario: 7,
        entidad: 'fiscal_envios',
        id_entidad: envio.id_envio,
        ip: '10.0.0.5',
        detalle: expect.objectContaining({ usuario: 'Moisés', estado_previo: 'ENVIANDO', estado: 'ACEPTADO', aceptado: true, constancia_recibida: true }),
      }),
    );
  });

  it('«Recuperar CDR» sin constancia (SUNAT no lo tiene) también se audita, con constancia_recibida en falso', async () => {
    const { servicio, envios, transporte, auditoria } = crear();
    const doc = factura('F001', 84);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'RECUPERAR_CDR', libre: true });
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaGetStatusCdr('0011', 'El comprobante no existe') });

    await servicio.recuperarCdr(envio.id_envio, { actor: { id_usuario: 7, nombre: null, ip: null } });

    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'FISCAL_CDR_RECUPERADO', detalle: expect.objectContaining({ constancia_recibida: false, accion: 'REINTENTAR' }) }),
    );
  });

  it('si la consulta no se puede hacer (BETA, boleta) no hay nada que auditar; y un fallo de la bitácora no tumba la consulta', async () => {
    const { servicio, envios, transporte, auditoria } = crear();
    const doc = factura();
    const preparado = servicio.preparar(doc, material);
    const beta = envios.agregar({ ambiente: 'beta', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'RECUPERAR_CDR', libre: true });
    await expect(servicio.recuperarCdr(beta.id_envio, { actor: { id_usuario: 7, nombre: 'Moisés', ip: null } })).rejects.toMatchObject({ codigo: 'FISCAL_CONSULTA_NO_DISPONIBLE' });
    expect(auditoria.registrar).not.toHaveBeenCalled();

    const doc2 = factura('F001', 85);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc2, preparado: servicio.preparar(doc2, material), estado: 'ENVIANDO', libre: true, codigo_sunat: 'ETIMEDOUT' });
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaGetStatusCdr('0001', 'Existe', cdrDe(doc2)) });
    auditoria.registrar.mockRejectedValueOnce(new Error('bitácora caída'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(servicio.recuperarCdr(envio.id_envio, { actor: { id_usuario: 7, nombre: 'Moisés', ip: null } })).resolves.toMatchObject({ aceptado: true });
  });

  it('la consulta interna del sistema (sin actor) no escribe en la bitácora', async () => {
    const { servicio, envios, transporte, auditoria } = crear();
    const doc = factura('F001', 86);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado: servicio.preparar(doc, material), estado: 'ENVIANDO', libre: true, codigo_sunat: 'ETIMEDOUT' });
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaGetStatusCdr('0001', 'Existe', cdrDe(doc)) });
    await servicio.recuperarCdr(envio.id_envio);
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('si SUNAT no lo tiene (0011) queda listo para reenviarlo; nunca reenvía desde la consulta', async () => {
    const { servicio, envios, transporte } = crear();
    const doc = factura('F001', 82);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'RECUPERAR_CDR', libre: true });
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaGetStatusCdr('0011', 'El comprobante no existe') });

    const resultado = await servicio.recuperarCdr(envio.id_envio);

    expect(transporte.enviar).toHaveBeenCalledTimes(1);
    expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR' });
  });

  it('confirma a mano solo un resultado incierto, en una transacción con la auditoría (usuario, nota y evidencia)', async () => {
    const { servicio, envios, auditoria, eventos, transacciones } = crear();
    const doc = boleta('B001', 90);
    const preparado = servicio.preparar(doc, material);
    const incierto = envios.agregar({
      ambiente: 'produccion',
      documento: doc,
      preparado,
      estado: 'PENDIENTE_REENVIO',
      accion: 'RECUPERAR_CDR',
      libre: true,
      codigo_sunat: '1033',
    });
    const rechazado = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'RECHAZADO', libre: true });

    await expect(servicio.confirmarAceptadoManual(incierto.id_envio, 7, 'ok')).rejects.toMatchObject({ codigo: 'FISCAL_CONFIG_INVALIDA' });
    await expect(servicio.confirmarAceptadoManual(rechazado.id_envio, 7, 'Verificado en SOL')).rejects.toMatchObject({
      codigo: 'FISCAL_CONFIRMACION_NO_PERMITIDA',
    });

    const resultado = await servicio.confirmarAceptadoManual(incierto.id_envio, 7, '  Verificado en SOL: aceptada el 13/10  ');

    expect(resultado).toMatchObject({ estado: 'ACEPTADO', aceptado: true, id_comprobante: 500 });
    expect(transacciones.ejecutar).toHaveBeenCalledTimes(1);
    const [evento, tx] = auditoria.registrar.mock.calls[0] as unknown as [Record<string, any>, unknown];
    expect(tx).toBeDefined();
    expect(evento).toMatchObject({
      accion: 'ENVIO_CONFIRMADO_MANUAL',
      id_usuario: 7,
      entidad: 'fiscal_envios',
      id_entidad: incierto.id_envio,
      detalle: { nota: 'Verificado en SOL: aceptada el 13/10', evidencia: { estado_anterior: 'PENDIENTE_REENVIO', codigo_sunat: '1033' } },
    });
    expect(envios.manual).toMatchObject({ confirmacion_manual: { id_usuario: 7 }, clasificacion: { estado: 'ACEPTADO' } });
    expect(eventos).toEqual([expect.objectContaining({ origen: 'manual', estado: 'ACEPTADO', aceptado: true })]);
  });
});

describe('SunatEmisionService.confirmarAceptadoManual desde EXCEPCION (S1)', () => {
  it('un envío que requiere revisión (EXCEPCION) se confirma con la nota del administrador, auditado', async () => {
    const { servicio, envios, auditoria } = crear();
    const doc = boleta('B001', 91);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'EXCEPCION', accion: 'EMITIR_NUEVO', libre: true, intento: 6 });

    const resultado = await servicio.confirmarAceptadoManual(envio.id_envio, 7, 'Aparece aceptada en SOL, consulta de validez');

    expect(resultado).toMatchObject({ estado: 'ACEPTADO', aceptado: true });
    expect((auditoria.registrar.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({
      accion: 'ENVIO_CONFIRMADO_MANUAL',
      detalle: { evidencia: { estado_anterior: 'EXCEPCION', accion_anterior: 'EMITIR_NUEVO', intento: 6 } },
    });
  });

  it('una EXCEPCION con un reclamo vigente (alguien la está tocando) no se confirma', async () => {
    const { servicio, envios } = crear();
    const doc = boleta('B001', 92);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'produccion', documento: doc, preparado, estado: 'EXCEPCION', accion: 'NINGUNA', libre: false });
    await expect(servicio.confirmarAceptadoManual(envio.id_envio, 7, 'Verificado en SOL')).rejects.toMatchObject({ codigo: 'FISCAL_CONFIRMACION_NO_PERMITIDA' });
  });
});

describe('SunatEmisionService.probarCredencialesProduccion (D1.4)', () => {
  it('0011 = credenciales correctas; consulta factura <serie>-99999999 y nunca usa sendBill', async () => {
    const { servicio, transporte, auditoria } = crear();
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaGetStatusCdr('0011', 'El comprobante no existe') });

    const resultado = await servicio.probarCredencialesProduccion('20610206337', 'F001', { id_usuario: 1, nombre: 'Admin', ip: null });

    expect(resultado).toMatchObject({ ok: true, codigo: '0011', consulta: { tipo: '01', serie: 'F001', numero: NUMERO_PRUEBA_CREDENCIALES } });
    const cuerpo = transporte.enviar.mock.calls[0][0].cuerpo as string;
    expect(transporte.enviar.mock.calls[0][0].soapAction).toBe(GET_STATUS_CDR);
    expect(cuerpo).toContain('<numeroComprobante>99999999</numeroComprobante>');
    expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({ accion: 'PRUEBA_CREDENCIALES_PRODUCCION', detalle: expect.objectContaining({ ok: true }) }));
    expect(JSON.stringify(resultado)).not.toContain(CREDENCIALES_PRODUCCION.clave);
  });

  it('explica el problema de la credencial (0102, 0111) y no lanza si faltan credenciales', async () => {
    const { servicio, transporte } = crear();
    transporte.enviar
      .mockResolvedValueOnce({ estadoHttp: 500, cuerpo: respuestaFault('soap-env:Client.0102', 'Usuario o contraseña incorrectos') })
      .mockResolvedValueOnce({ estadoHttp: 500, cuerpo: respuestaFault('soap-env:Client.0111', 'No tiene el perfil') });
    const actor = { id_usuario: 1, nombre: 'Admin', ip: null };

    expect(await servicio.probarCredencialesProduccion('20610206337', 'F001', actor)).toMatchObject({ ok: false, codigo: '0102', mensaje: expect.stringMatching(/usuario o la clave SOL/) });
    expect(await servicio.probarCredencialesProduccion('20610206337', 'F001', actor)).toMatchObject({ ok: false, codigo: '0111', mensaje: expect.stringMatching(/perfil/) });

    const sinCredenciales = crear({
      credenciales: jest.fn(async () => {
        throw new FiscalConfigError('FISCAL_CREDENCIALES_SOL_FALTAN', 'Registre el usuario secundario SOL en el panel de facturación.');
      }),
    });
    expect(await sinCredenciales.servicio.probarCredencialesProduccion('20610206337', 'F001', actor)).toMatchObject({
      ok: false,
      codigo: 'FISCAL_CREDENCIALES_SOL_FALTAN',
    });
    expect(sinCredenciales.transporte.enviar).not.toHaveBeenCalled();
  });
});

describe('SunatEmisionService: respuestas reales del clasificador del núcleo', () => {
  it('un CDR de rechazo no se presenta como aceptado', async () => {
    const { servicio, envios, transporte } = crear();
    const doc = factura();
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'beta', documento: doc, preparado });
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaSendBill(cdrDe(doc, '2017', 'El numero de documento de identidad del receptor debe ser RUC')) });

    const resultado: { aceptado: boolean; estado: string } = await servicio.enviar(envio.id_envio, { ambiente: 'beta', documento: doc, preparado });

    expect(resultado.aceptado).toBe(false);
    expect(['RECHAZADO', 'EXCEPCION', 'ERROR_CONFIG']).toContain(resultado.estado);
  });

  it('no deja pasar una respuesta sin CDR como aceptada', async () => {
    const { servicio, envios, transporte } = crear();
    const doc = factura();
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'beta', documento: doc, preparado });
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: '<x/>' } as { estadoHttp: number; cuerpo: string });

    const resultado = await servicio.enviar(envio.id_envio, { ambiente: 'beta', documento: doc, preparado });

    expect(resultado.aceptado).toBe(false);
    expect(resultado.estado).toBe('PENDIENTE_REENVIO');
  });
});


describe('SunatEmisionService: timeout del primer envío y tiempos de SUNAT (A1/A5)', () => {
  afterEach(() => jest.restoreAllMocks());

  function preparadoBeta(servicio: SunatEmisionService, envios: EnviosMemoria) {
    const doc = factura('FB01', 77);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'beta', documento: doc, preparado });
    return { doc, preparado, envio };
  }

  it('sin opciones el cliente SOAP espera 15 s (mostrador); con timeoutMs del worker espera 30 s', async () => {
    const crearCliente = jest.spyOn(FabricaClienteSoapSunat.prototype, 'crear');
    const { servicio, envios, transporte } = crear();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    transporte.enviar.mockImplementation(async () => ({ estadoHttp: 200, cuerpo: respuestaSendBill(cdrDe(factura('FB01', 77))) }));

    const mostrador = preparadoBeta(servicio, envios);
    await servicio.enviar(mostrador.envio.id_envio, { ambiente: 'beta', documento: mostrador.doc, preparado: mostrador.preparado });
    expect(crearCliente).toHaveBeenLastCalledWith(expect.objectContaining({ timeoutMs: 15_000 }));

    const fondo = preparadoBeta(servicio, envios);
    await servicio.enviar(fondo.envio.id_envio, { ambiente: 'beta', documento: fondo.doc, preparado: fondo.preparado }, { timeoutMs: 30_000 });
    expect(crearCliente).toHaveBeenLastCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
  });

  it('el timeout pedido se acota a 1–120 s, como el cliente SOAP', async () => {
    const crearCliente = jest.spyOn(FabricaClienteSoapSunat.prototype, 'crear');
    const { servicio, envios, transporte } = crear();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    transporte.enviar.mockImplementation(async () => ({ estadoHttp: 200, cuerpo: respuestaSendBill(cdrDe(factura('FB01', 77))) }));

    const largo = preparadoBeta(servicio, envios);
    await servicio.enviar(largo.envio.id_envio, { ambiente: 'beta', documento: largo.doc, preparado: largo.preparado }, { timeoutMs: 999_999 });
    expect(crearCliente).toHaveBeenLastCalledWith(expect.objectContaining({ timeoutMs: 120_000 }));
    const corto = preparadoBeta(servicio, envios);
    await servicio.enviar(corto.envio.id_envio, { ambiente: 'beta', documento: corto.doc, preparado: corto.preparado }, { timeoutMs: 10 });
    expect(crearCliente).toHaveBeenLastCalledWith(expect.objectContaining({ timeoutMs: 1_000 }));
  });

  it('la prueba del panel (emitirPrueba) espera a SUNAT con el timeout del worker (30 s)', async () => {
    const crearCliente = jest.spyOn(FabricaClienteSoapSunat.prototype, 'crear');
    const { servicio, transporte } = crear();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const doc = factura('FB01', 78);
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaSendBill(cdrDe(doc)) });

    await servicio.emitirPrueba(doc, material, 4);

    expect(crearCliente).toHaveBeenLastCalledWith(expect.objectContaining({ ambiente: 'beta', timeoutMs: 30_000 }));
  });

  it('devuelve tiempo_sunat_ms y deja UNA línea de log con SUNAT, total, estado y origen (sin credenciales)', async () => {
    const { servicio, envios, transporte, reloj } = crear();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { doc, preparado, envio } = preparadoBeta(servicio, envios);
    transporte.enviar.mockImplementationOnce(async () => {
      reloj.momento = new Date(reloj.momento.getTime() + 2_300);
      return { estadoHttp: 200, cuerpo: respuestaSendBill(cdrDe(doc)) };
    });

    const resultado = await servicio.enviar(envio.id_envio, { ambiente: 'beta', documento: doc, preparado });

    expect(typeof resultado.tiempo_sunat_ms).toBe('number');
    expect(resultado.tiempo_sunat_ms).toBe(envios.cierres[0].cierre.sunat?.tiempoMs);
    const lineas = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(`Envío ${envio.id_envio} `));
    expect(lineas).toHaveLength(1);
    expect(lineas[0]).toMatch(new RegExp(`^Envío ${envio.id_envio} ${preparado.nombreBase} \\(beta\\): SUNAT \\d+ ms, total 2300 ms, ACEPTADO, origen envio$`));
    expect(lineas[0]).not.toContain('MODDATOS');
  });

  it('un reintento también se mide (origen tarea)', async () => {
    const { servicio, envios, transporte } = crear();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const doc = factura('FB01', 79);
    const preparado = servicio.preparar(doc, material);
    const envio = envios.agregar({ ambiente: 'beta', documento: doc, preparado, estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', libre: true });
    transporte.enviar.mockResolvedValueOnce({ estadoHttp: 200, cuerpo: respuestaSendBill(cdrDe(doc)) });

    await servicio.reintentar(envio.id_envio, 'tarea');

    const lineas = log.mock.calls.map((c) => String(c[0]));
    expect(lineas.some((l) => new RegExp(`^Envío ${envio.id_envio} .*: SUNAT \\d+ ms, total \\d+ ms, ACEPTADO, origen tarea$`).test(l))).toBe(true);
  });

  it('cerrado sin llamar a SUNAT (emisión detenida): tiempo_sunat_ms null y el log dice «sin respuesta»', async () => {
    const { servicio, envios, transporte, bloqueos } = crear();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { doc, preparado, envio } = preparadoBeta(servicio, envios);
    bloqueos.beta = { codigo: '0102', motivo: 'Clave SOL rechazada.', fecha: '2026-10-13' };

    const resultado = await servicio.enviar(envio.id_envio, { ambiente: 'beta', documento: doc, preparado });

    expect(transporte.enviar).not.toHaveBeenCalled();
    expect(resultado.tiempo_sunat_ms).toBeNull();
    expect(log.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/: SUNAT sin respuesta, total \d+ ms, PENDIENTE_REENVIO, origen envio$/));
  });
});
