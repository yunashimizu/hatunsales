import { leerCdr } from '../cdr/lector-cdr';
import type { AmbienteFiscal, RespuestaSunat, TipoCpe } from '../documento-fiscal.types';
import { ConfiguracionSoapInvalidaError } from '../errores-nucleo';
import { admiteGetStatusCdr } from '../reglas-envio';
import { escaparXml } from '../xml/escritor-xml';
import { leerXmlDeZip } from '../zip/paquete-zip';
import { endpointsSunat, esEndpointProduccion } from './endpoints-sunat';
import { DESCRIPCIONES_CONSULTA_SUNAT, estadoDeConsulta, normalizarCodigoConsulta } from './estados-consulta-sunat';
import { leerRespuestaSoap, RespuestaSoapLeida } from './lector-respuesta-soap';
import { ArgumentosSoap, construirSobreSoap, CredencialesSoap, MetodoSoapSunat, soapActionDe } from './sobre-soap';
import { CODIGOS_RED_TRANSITORIOS, ErrorTransporteSoap, TransporteSoap, TransporteSoapAxios } from './transporte-soap';

export { DESCRIPCIONES_CONSULTA_SUNAT, ESTADOS_CONSULTA_SUNAT } from './estados-consulta-sunat';

/** Timeout de un envío dentro de la venta (el cajero espera). */
export const TIMEOUT_POS_MS = 15_000;
/** Timeout de los reenvíos de la cola y las tareas programadas. */
export const TIMEOUT_WORKER_MS = 30_000;
/** Tamaño máximo de `raw` (respuesta cruda redactada) que se devuelve para guardar. */
export const LIMITE_RAW_BYTES = 20 * 1024;

/** `codigo` de la respuesta NO_DISPONIBLE cuando el servicio de consulta no admite el documento (boletas, series B). */
export const CODIGO_CONSULTA_NO_ADMITIDA = 'CONSULTA_NO_ADMITIDA';

export interface ConfiguracionClienteSoap {
  /** RUC + usuario SOL (BETA: RUC + MODDATOS). */
  usuario: string;
  clave: string;
  ambiente: AmbienteFiscal;
  /** Por omisión TIMEOUT_POS_MS (15 s); el worker usa TIMEOUT_WORKER_MS (30 s). */
  timeoutMs?: number;
  /** Reemplaza el billService del ambiente (p. ej. otro servidor de pruebas). */
  endpointBill?: string;
  /** Reemplaza el billConsultService (solo producción). */
  endpointConsulta?: string;
  /** Reintentos inmediatos de las CONSULTAS ante fallas de red (por omisión 1). Los envíos nunca se reintentan aquí. */
  reintentosConsulta?: number;
}

export interface DependenciasClienteSoap {
  transporte?: TransporteSoap;
  /** Pausa entre reintentos (inyectable para los specs). */
  esperar?: (ms: number) => Promise<void>;
}

type Interpretador = (leida: RespuestaSoapLeida, base: BaseRespuesta) => RespuestaSunat;
type BaseRespuesta = Pick<RespuestaSunat, 'httpStatus' | 'tiempoMs' | 'raw'>;

const esperarPorOmision = (ms: number) => new Promise<void>((resolver) => setTimeout(resolver, ms));

function respuesta(base: BaseRespuesta, datos: Omit<RespuestaSunat, 'tiempoMs' | 'observaciones'> & Partial<Pick<RespuestaSunat, 'observaciones'>>): RespuestaSunat {
  return { observaciones: [], ...datos, httpStatus: base.httpStatus, tiempoMs: base.tiempoMs, raw: base.raw };
}

function transporte(base: BaseRespuesta, codigo: string, descripcion: string): RespuestaSunat {
  return respuesta(base, { tipo: 'TRANSPORTE', codigo, descripcion });
}

/** Constancia contenida en un ZIP base64 → respuesta CDR (o TRANSPORTE si es ilegible). */
function respuestaConCdr(base: BaseRespuesta, zipBase64: string, statusCode?: string): RespuestaSunat {
  const contenido = leerXmlDeZip(zipBase64);
  const cdr = contenido ? leerCdr(contenido.xml) : null;
  if (!contenido || !cdr || cdr.codigo === 'ERROR') {
    return transporte(base, 'CDR_ILEGIBLE', 'SUNAT respondió, pero la constancia (CDR) no se pudo leer; consulte el estado antes de reenviar.');
  }
  return respuesta(base, {
    tipo: 'CDR',
    codigo: cdr.codigo,
    descripcion: cdr.descripcion,
    observaciones: cdr.observaciones,
    cdrZip: Buffer.from(zipBase64.replace(/\s+/g, ''), 'base64'),
    cdrXml: contenido.xml,
    statusCode,
  });
}

const interpretarSendBill: Interpretador = (leida, base) =>
  leida.applicationResponse
    ? respuestaConCdr(base, leida.applicationResponse)
    : transporte(base, 'RESPUESTA_INVALIDA', 'SUNAT respondió sin la constancia (applicationResponse).');

const interpretarSendSummary: Interpretador = (leida, base) =>
  leida.ticket
    ? respuesta(base, { tipo: 'TICKET', codigo: '', descripcion: `SUNAT recibió el lote; ticket ${leida.ticket}.`, ticket: leida.ticket })
    : transporte(base, 'RESPUESTA_INVALIDA', 'SUNAT respondió sin ticket.');

/** getStatus de un ticket: 98 en proceso; 0/99 con la constancia del lote. */
function interpretarTicket(ticket: string): Interpretador {
  return (leida, base) => {
    const estado = leida.estado;
    if (!estado?.statusCode) return transporte(base, 'RESPUESTA_INVALIDA', 'SUNAT respondió sin el estado del ticket.');
    const codigo = estado.statusCode;
    if (estado.content) return respuestaConCdr(base, estado.content, codigo);
    if (codigo === '98') {
      return respuesta(base, { tipo: 'TICKET', codigo, statusCode: codigo, ticket, descripcion: estado.statusMessage ?? 'SUNAT sigue procesando el lote.' });
    }
    return respuesta(base, {
      tipo: 'ESTADO',
      codigo,
      statusCode: codigo,
      ticket,
      estadoComprobante: codigo === '99' ? 'RECHAZADO' : 'DESCONOCIDO',
      descripcion: estado.statusMessage ?? (codigo === '99' ? 'SUNAT procesó el lote con errores.' : `Estado del ticket: ${codigo}.`),
    });
  };
}

/** billConsultService: constancia si existe; si no, el estado del comprobante (tabla del anexo 2 del Manual). */
const interpretarConsulta: Interpretador = (leida, base) => {
  const estado = leida.estado;
  if (!estado?.statusCode) return transporte(base, 'RESPUESTA_INVALIDA', 'SUNAT respondió sin el estado del comprobante.');
  const codigo = normalizarCodigoConsulta(estado.statusCode);
  if (estado.content) return respuestaConCdr(base, estado.content, codigo);
  return respuesta(base, {
    tipo: 'ESTADO',
    codigo,
    statusCode: codigo,
    estadoComprobante: estadoDeConsulta(codigo),
    descripcion: estado.statusMessage ?? DESCRIPCIONES_CONSULTA_SUNAT[codigo] ?? `Estado del comprobante: ${codigo}.`,
  });
};

function validarUrl(url: string, nombre: string): string {
  let parseada: URL;
  try {
    parseada = new URL(url);
  } catch {
    throw new ConfiguracionSoapInvalidaError(`El endpoint ${nombre} "${url}" no es una URL válida.`);
  }
  const local = parseada.hostname === 'localhost' || parseada.hostname === '127.0.0.1';
  if (parseada.protocol !== 'https:' && !(local && parseada.protocol === 'http:')) {
    throw new ConfiguracionSoapInvalidaError(`El endpoint ${nombre} debe usar HTTPS.`);
  }
  return parseada.toString();
}

/**
 * Cliente SOAP de SUNAT (SEE - Del Contribuyente). Cada operación devuelve una
 * RespuestaSunat normalizada (nunca lanza por la red ni por un Fault): la
 * decisión de qué hacer la toma clasificarRespuesta.
 *  - enviarComprobante → billService.sendBill (CDR inmediato)
 *  - enviarResumen     → billService.sendSummary (ticket; RC y RA)
 *  - consultarTicket   → billService.getStatus
 *  - consultarCdr      → billConsultService.getStatusCdr (solo producción)
 *  - consultarValidez  → billConsultService.getStatus (solo producción)
 * Las dos consultas solo admiten facturas y sus notas con serie F (admiteGetStatusCdr): para
 * cualquier otro documento responden NO_DISPONIBLE sin usar la red.
 */
export class SunatSoapClient {
  readonly ambiente: AmbienteFiscal;
  readonly endpointBill: string;
  readonly endpointConsulta: string | null;
  private readonly credenciales: CredencialesSoap;
  private readonly timeoutMs: number;
  private readonly reintentosConsulta: number;
  private readonly transporte: TransporteSoap;
  private readonly esperar: (ms: number) => Promise<void>;

  constructor(cfg: ConfiguracionClienteSoap, dependencias: DependenciasClienteSoap = {}) {
    if (cfg?.ambiente !== 'beta' && cfg?.ambiente !== 'produccion') {
      throw new ConfiguracionSoapInvalidaError(`Ambiente fiscal inválido: "${String(cfg?.ambiente)}" (beta o produccion).`);
    }
    const usuario = String(cfg.usuario ?? '').trim();
    const clave = String(cfg.clave ?? '');
    if (!/^\d{11}[A-Za-z0-9]+$/.test(usuario) || clave.trim() === '') {
      throw new ConfiguracionSoapInvalidaError('Faltan las credenciales SOL: el usuario SOAP es RUC + usuario secundario y la clave no puede estar vacía.');
    }
    const endpoints = endpointsSunat(cfg.ambiente);
    this.ambiente = cfg.ambiente;
    this.endpointBill = validarUrl(cfg.endpointBill ?? endpoints.billService, 'billService');
    const consulta = cfg.endpointConsulta ?? endpoints.consultaCdr;
    this.endpointConsulta = cfg.ambiente === 'produccion' && consulta ? validarUrl(consulta, 'billConsultService') : null;
    if (cfg.ambiente === 'beta' && esEndpointProduccion(this.endpointBill)) {
      throw new ConfiguracionSoapInvalidaError('Un cliente del ambiente BETA no puede apuntar a los servicios de producción de SUNAT.');
    }
    this.credenciales = { usuario, clave };
    this.timeoutMs = Math.min(120_000, Math.max(1_000, Math.trunc(cfg.timeoutMs ?? TIMEOUT_POS_MS)));
    this.reintentosConsulta = Math.min(3, Math.max(0, Math.trunc(cfg.reintentosConsulta ?? 1)));
    this.transporte = dependencias.transporte ?? new TransporteSoapAxios();
    this.esperar = dependencias.esperar ?? esperarPorOmision;
  }

  enviarComprobante(nombreZip: string, base64: string): Promise<RespuestaSunat> {
    return this.llamar('sendBill', this.endpointBill, [['fileName', nombreZip], ['contentFile', base64]], interpretarSendBill, false);
  }

  enviarResumen(nombreZip: string, base64: string): Promise<RespuestaSunat> {
    return this.llamar('sendSummary', this.endpointBill, [['fileName', nombreZip], ['contentFile', base64]], interpretarSendSummary, false);
  }

  consultarTicket(ticket: string): Promise<RespuestaSunat> {
    return this.llamar('getStatus', this.endpointBill, [['ticket', String(ticket ?? '').trim()]], interpretarTicket(String(ticket ?? '').trim()), true);
  }

  consultarCdr(ruc: string, tipo: TipoCpe, serie: string, numero: number): Promise<RespuestaSunat> {
    return this.consultar('getStatusCdr', ruc, tipo, serie, numero);
  }

  consultarValidez(ruc: string, tipo: TipoCpe, serie: string, numero: number): Promise<RespuestaSunat> {
    return this.consultar('getStatus', ruc, tipo, serie, numero);
  }

  private async consultar(metodo: MetodoSoapSunat, ruc: string, tipo: TipoCpe, serie: string, numero: number): Promise<RespuestaSunat> {
    // SUNAT contestaría 0009/0010 (Manual, anexo 2): no se gasta una llamada ni se arriesga un reintento.
    if (!admiteGetStatusCdr(String(tipo ?? '').trim(), String(serie ?? '').trim())) {
      return {
        tipo: 'NO_DISPONIBLE',
        codigo: CODIGO_CONSULTA_NO_ADMITIDA,
        descripcion: `SUNAT solo permite consultar por este servicio facturas y sus notas con serie F (tipo 01, 07 u 08); el documento tipo ${String(tipo ?? '')} ${String(serie ?? '')}-${String(numero ?? '')} no se puede consultar así.`,
        observaciones: [],
        tiempoMs: 0,
      };
    }
    if (!this.endpointConsulta) {
      return {
        tipo: 'NO_DISPONIBLE',
        codigo: 'NO_DISPONIBLE',
        descripcion: 'SUNAT no ofrece el servicio de consulta de comprobantes en el ambiente BETA.',
        observaciones: [],
        tiempoMs: 0,
      };
    }
    const argumentos: ArgumentosSoap = [
      ['rucComprobante', ruc],
      ['tipoComprobante', tipo],
      ['serieComprobante', serie],
      ['numeroComprobante', Math.trunc(Number(numero))],
    ];
    return this.llamar(metodo, this.endpointConsulta, argumentos, interpretarConsulta, true);
  }

  private async llamar(
    metodo: MetodoSoapSunat,
    url: string,
    argumentos: ArgumentosSoap,
    interpretar: Interpretador,
    idempotente: boolean,
  ): Promise<RespuestaSunat> {
    const inicio = Date.now();
    const cuerpo = construirSobreSoap(metodo, this.credenciales, argumentos);
    const reintentos = idempotente ? this.reintentosConsulta : 0;

    for (let intento = 0; ; intento++) {
      try {
        const http = await this.transporte.enviar({ url, cuerpo, soapAction: soapActionDe(metodo), timeoutMs: this.timeoutMs });
        const base: BaseRespuesta = { httpStatus: http.estadoHttp, tiempoMs: Date.now() - inicio, raw: this.redactar(http.cuerpo) };
        const leida = leerRespuestaSoap(http.cuerpo);
        if (leida.fault) {
          return respuesta(base, {
            tipo: 'FAULT',
            codigo: leida.fault.codigo || leida.fault.codigoOriginal || 'FAULT',
            descripcion: leida.fault.detalle && leida.fault.detalle !== leida.fault.mensaje ? `${leida.fault.mensaje} - ${leida.fault.detalle}` : leida.fault.mensaje,
            ...(leida.fault.origen ? { faultOrigen: leida.fault.origen } : {}),
          });
        }
        if (http.estadoHttp < 200 || http.estadoHttp >= 300) {
          if (intento < reintentos && (http.estadoHttp >= 500 || http.estadoHttp === 429)) {
            await this.esperar(300 * (intento + 1));
            continue;
          }
          return transporte(base, `HTTP_${http.estadoHttp}`, `SUNAT respondió HTTP ${http.estadoHttp} sin un SOAP Fault.`);
        }
        if (!leida.esXml) return transporte(base, 'RESPUESTA_INVALIDA', 'SUNAT respondió con un contenido que no es XML.');
        return interpretar(leida, base);
      } catch (error) {
        const codigo = error instanceof ErrorTransporteSoap ? error.codigo : 'ERROR_DESCONOCIDO';
        if (intento < reintentos && CODIGOS_RED_TRANSITORIOS.has(codigo)) {
          await this.esperar(300 * (intento + 1));
          continue;
        }
        const mensaje = error instanceof Error ? error.message : String(error);
        return { tipo: 'TRANSPORTE', codigo, descripcion: this.redactar(mensaje), observaciones: [], tiempoMs: Date.now() - inicio };
      }
    }
  }

  /** Quita usuario y clave (también escapados) y trunca a LIMITE_RAW_BYTES. */
  private redactar(textoCrudo: string): string {
    let resultado = String(textoCrudo ?? '');
    for (const secreto of [this.credenciales.clave, this.credenciales.usuario]) {
      if (!secreto) continue;
      for (const forma of new Set([secreto, escaparXml(secreto)])) resultado = resultado.split(forma).join('***');
    }
    if (Buffer.byteLength(resultado, 'utf8') <= LIMITE_RAW_BYTES) return resultado;
    const sufijo = '…[truncado]';
    const maximoContenido = LIMITE_RAW_BYTES - Buffer.byteLength(sufijo, 'utf8');
    let contenido = '';
    let bytes = 0;
    for (const caracter of resultado) {
      const bytesCaracter = Buffer.byteLength(caracter, 'utf8');
      if (bytes + bytesCaracter > maximoContenido) break;
      contenido += caracter;
      bytes += bytesCaracter;
    }
    return `${contenido}${sufijo}`;
  }
}

/** Crea clientes con un transporte compartido (inyectable en Nest y en los specs). */
export class FabricaClienteSoapSunat {
  constructor(private readonly dependencias: DependenciasClienteSoap = {}) {}

  crear(cfg: ConfiguracionClienteSoap): SunatSoapClient {
    return new SunatSoapClient(cfg, this.dependencias);
  }
}
