import axios from 'axios';
import { Agent } from 'https';

export interface PeticionSoap {
  url: string;
  cuerpo: string;
  soapAction: string;
  timeoutMs: number;
}

export interface RespuestaHttpSoap {
  estadoHttp: number;
  cuerpo: string;
}

/** Transporte HTTP del cliente SOAP (inyectable: los specs usan uno falso, sin red). */
export interface TransporteSoap {
  enviar(peticion: PeticionSoap): Promise<RespuestaHttpSoap>;
}

/** Falla de red antes de recibir respuesta. `codigo`: ETIMEDOUT, ECONNRESET, ENOTFOUND… */
export class ErrorTransporteSoap extends Error {
  constructor(
    readonly codigo: string,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'ErrorTransporteSoap';
  }
}

export const MAXIMO_BYTES_RESPUESTA_SOAP = 10 * 1024 * 1024;

/** Códigos de red transitorios: tiene sentido reintentar una operación idempotente. */
export const CODIGOS_RED_TRANSITORIOS: ReadonlySet<string> = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ESOCKETTIMEDOUT',
]);

let agenteCompartido: Agent | null = null;

/** Conexiones TLS reutilizables entre envíos (evita un handshake por comprobante con alto tráfico). */
function agenteHttps(): Agent {
  agenteCompartido ??= new Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4, timeout: 60_000 });
  return agenteCompartido;
}

function normalizarErrorRed(error: unknown): ErrorTransporteSoap {
  const codigo = String((error as { code?: unknown })?.code ?? '').toUpperCase();
  const mensaje = error instanceof Error ? error.message : String(error);
  // El AbortSignal de respaldo cancela la petición: para el llamador es un timeout.
  if (codigo === 'ERR_CANCELED' || /aborted|timeout/i.test(mensaje)) {
    return new ErrorTransporteSoap('ETIMEDOUT', 'SUNAT no respondió dentro del tiempo límite.');
  }
  return new ErrorTransporteSoap(codigo || 'ERROR_RED', `No se pudo comunicar con SUNAT: ${mensaje}`);
}

/** Transporte real con axios: timeout de respuesta + corte total, sin redirecciones y con tope de tamaño. */
export class TransporteSoapAxios implements TransporteSoap {
  async enviar(peticion: PeticionSoap): Promise<RespuestaHttpSoap> {
    try {
      const respuesta = await axios.post<string>(peticion.url, peticion.cuerpo, {
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          Accept: 'text/xml',
          SOAPAction: peticion.soapAction,
        },
        timeout: peticion.timeoutMs,
        signal: AbortSignal.timeout(peticion.timeoutMs + 2_000),
        transitional: { clarifyTimeoutError: true, silentJSONParsing: true, forcedJSONParsing: false },
        responseType: 'text',
        transformResponse: [(datos: unknown) => datos],
        validateStatus: () => true,
        maxRedirects: 0,
        maxContentLength: MAXIMO_BYTES_RESPUESTA_SOAP,
        maxBodyLength: 2 * MAXIMO_BYTES_RESPUESTA_SOAP,
        httpsAgent: agenteHttps(),
      });
      return { estadoHttp: respuesta.status, cuerpo: typeof respuesta.data === 'string' ? respuesta.data : String(respuesta.data ?? '') };
    } catch (error) {
      throw normalizarErrorRed(error);
    }
  }
}
