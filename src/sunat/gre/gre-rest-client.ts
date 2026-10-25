import axios from 'axios';
import { createHash } from 'crypto';
import { Agent } from 'https';
import { sha256Hex } from '../nucleo/zip/paquete-zip';
import type { CredencialesGre } from '../seguridad/credenciales-gre.service';
import {
  clasificarConsultaGre,
  clasificarEnvioGre,
  consultaSinRespuesta,
  envioSinRespuesta,
  MotivoSinRespuestaGre,
  redactarSecretosGre,
} from './clasificador-gre';
import type { GreEsperada, GrePreparada, ResultadoConsultaGre, ResultadoEnvioGre } from './gre.contrato';

/**
 * Cliente de la API REST de la GRE de SUNAT. No existe ambiente BETA aislado: cualquier llamada real es
 * PRODUCCIÓN, por eso el transporte es inyectable (los specs usan uno falso, sin red) y solo se habla
 * con dos hosts fijos, por https, sin seguir redirecciones.
 *
 * - Token [GRE-M] 1.2 (oficial): POST form-urlencoded a api-seguridad con grant_type=password,
 *   scope=https://api-cpe.sunat.gob.pe, client_id, client_secret, username = RUC + usuario SOL y
 *   password = clave SOL. Vigencia en expires_in (hoy 1 hora). Se guarda SOLO en memoria, por client_id,
 *   hasta 5 minutos antes de vencer.
 * - Envío y consulta [A13] (oficial: POST del ZIP con su hash → ticket; GET del ticket → estado y CDR);
 *   rutas y campos JSON [TERCERO: Greenter gre-api, verifac.pe]: POST
 *   /v1/contribuyente/gem/comprobantes/{RUC-09-SERIE-NUMERO} con {archivo:{nomArchivo, arcGreZip, hashZip}}
 *   y GET /v1/contribuyente/gem/comprobantes/envios/{numTicket}.
 * - hashZip = SHA-256 del ZIP en hexadecimal (minúsculas), como lo envía Greenter. SUNAT no publica el
 *   formato: es un SUPUESTO que se confirma con el primer envío real (si SUNAT lo rechazara por el hash,
 *   respondería 422 antes de dar ticket y el número no se consume).
 *
 * Reintentos: el token y la consulta se reintentan ante red o 5xx (son idempotentes); el envío NO se
 * reintenta solo (un 5xx deja el resultado incierto y lo decide el negocio). Ante un 401 se renueva el
 * token una sola vez: SUNAT no procesó esa petición, así que repetirla es seguro.
 */

export const HOST_SEGURIDAD_GRE = 'api-seguridad.sunat.gob.pe';
export const HOST_CPE_GRE = 'api-cpe.sunat.gob.pe';
/** Lista cerrada: el cliente no habla con ningún otro host. */
export const HOSTS_PERMITIDOS_GRE: ReadonlySet<string> = new Set([HOST_SEGURIDAD_GRE, HOST_CPE_GRE]);
export const SCOPE_GRE = 'https://api-cpe.sunat.gob.pe';
const BASE_COMPROBANTES_GRE = `https://${HOST_CPE_GRE}/v1/contribuyente/gem/comprobantes`;

export const MAXIMO_BYTES_RESPUESTA_GRE = 10 * 1024 * 1024;
export const TIMEOUT_GRE_MS = 20_000;
const TIMEOUT_MINIMO_MS = 15_000;
const TIMEOUT_MAXIMO_MS = 30_000;
/** El token se deja de usar 5 minutos antes de que venza. */
export const MARGEN_RENOVACION_TOKEN_MS = 5 * 60_000;
/** Pausas entre reintentos (token: 1 reintento; consulta: 2). */
const PAUSAS_REINTENTO_MS = [1_000, 3_000] as const;
const REINTENTOS_TOKEN = 1;
const REINTENTOS_CONSULTA = 2;

function pausaReintento(intento: number): number {
  return PAUSAS_REINTENTO_MS[Math.min(intento, PAUSAS_REINTENTO_MS.length - 1)];
}

const PATRON_CLIENT_ID = /^[A-Za-z0-9-]{8,100}$/;
const PATRON_TICKET = /^[A-Za-z0-9-]{1,100}$/;
/** RUC-09-T###-N (anexo N.° 13, 1.4.b): el mismo nombre del ZIP y de la ruta del envío. */
const PATRON_NOMBRE_GRE = /^\d{11}-09-T[A-Z0-9]{3}-\d{1,8}$/;

export function urlTokenGre(clientId: string): string {
  return `https://${HOST_SEGURIDAD_GRE}/v1/clientessol/${encodeURIComponent(clientId)}/oauth2/token/`;
}

export function urlEnvioGre(nombreBase: string): string {
  return `${BASE_COMPROBANTES_GRE}/${encodeURIComponent(nombreBase)}`;
}

export function urlConsultaGre(ticket: string): string {
  return `${BASE_COMPROBANTES_GRE}/envios/${encodeURIComponent(ticket)}`;
}

// ── Transporte ────────────────────────────────────────────────────────────────

export interface PeticionHttpGre {
  metodo: 'GET' | 'POST';
  url: string;
  cabeceras: Readonly<Record<string, string>>;
  cuerpo?: string;
  timeoutMs: number;
}

export interface RespuestaHttpGre {
  estadoHttp: number;
  cuerpo: string;
}

/** Transporte HTTP de la GRE (inyectable: los specs usan uno falso, sin red). */
export interface TransporteHttpGre {
  ejecutar(peticion: PeticionHttpGre): Promise<RespuestaHttpGre>;
}

/** Falla antes de recibir respuesta. `codigo`: ETIMEDOUT, ECONNRESET, URL_NO_PERMITIDA… El mensaje ya viene sin secretos. */
export class ErrorTransporteGre extends Error {
  constructor(
    readonly codigo: string,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'ErrorTransporteGre';
  }
}

/** Lanza si la URL no es https a uno de los dos hosts de la GRE (sin usuario/clave embebidos ni puerto raro). */
export function exigirUrlPermitidaGre(url: string): void {
  let destino: URL;
  try {
    destino = new URL(url);
  } catch {
    throw new ErrorTransporteGre('URL_NO_PERMITIDA', 'La dirección del servicio de SUNAT no es válida.');
  }
  const permitida =
    destino.protocol === 'https:' &&
    HOSTS_PERMITIDOS_GRE.has(destino.hostname.toLowerCase()) &&
    (destino.port === '' || destino.port === '443') &&
    destino.username === '' &&
    destino.password === '';
  if (!permitida) {
    throw new ErrorTransporteGre('URL_NO_PERMITIDA', `Por seguridad solo se llama a ${[...HOSTS_PERMITIDOS_GRE].join(' y ')} por https (se intentó ${destino.protocol}//${destino.hostname}).`);
  }
}

export interface ErrorHttpSaneado {
  codigo: string;
  mensaje: string;
  estadoHttp: number | null;
  metodo: string | null;
  /** Sin parámetros de consulta. */
  url: string | null;
}

/**
 * Convierte cualquier error (de axios u otro) en un objeto nuevo y plano, apto para logs y respuestas:
 * nunca copia config.data (lleva client_secret y password), las cabeceras (Authorization) ni el cuerpo
 * de la respuesta, y borra del mensaje los secretos conocidos y cualquier patrón de token o clave.
 */
export function sanearErrorHttpGre(error: unknown, secretos: readonly (string | null | undefined)[] = []): ErrorHttpSaneado {
  const objeto = (error && typeof error === 'object' ? error : {}) as {
    code?: unknown;
    message?: unknown;
    response?: { status?: unknown };
    config?: { method?: unknown; url?: unknown };
  };
  let mensaje = redactarSecretosGre(error instanceof Error ? error.message : typeof objeto.message === 'string' ? objeto.message : String(error));
  for (const secreto of secretos) {
    if (secreto && secreto.length >= 4) mensaje = mensaje.split(secreto).join('[REDACTADO]');
  }
  let url: string | null = null;
  if (typeof objeto.config?.url === 'string') {
    try {
      const destino = new URL(objeto.config.url);
      url = `${destino.protocol}//${destino.host}${destino.pathname}`;
    } catch {
      url = null;
    }
  }
  const estado = Number(objeto.response?.status);
  return {
    codigo: (typeof objeto.code === 'string' || typeof objeto.code === 'number' ? String(objeto.code) : '').toUpperCase() || 'ERROR_RED',
    mensaje,
    estadoHttp: Number.isInteger(estado) ? estado : null,
    metodo: typeof objeto.config?.method === 'string' ? objeto.config.method.toUpperCase() : null,
    url,
  };
}

function esUrlNoPermitida(error: unknown): boolean {
  return error instanceof ErrorTransporteGre && error.codigo === 'URL_NO_PERMITIDA';
}

function normalizarErrorRed(error: unknown): ErrorTransporteGre {
  if (error instanceof ErrorTransporteGre) return error;
  const saneado = sanearErrorHttpGre(error);
  // El AbortSignal de respaldo cancela la petición: para el llamador es un timeout.
  if (saneado.codigo === 'ERR_CANCELED' || saneado.codigo === 'ECONNABORTED' || /aborted|timeout/i.test(saneado.mensaje)) {
    return new ErrorTransporteGre('ETIMEDOUT', 'SUNAT no respondió dentro del tiempo límite.');
  }
  return new ErrorTransporteGre(saneado.codigo, `No se pudo comunicar con SUNAT: ${saneado.mensaje}`);
}

let agenteCompartido: Agent | null = null;

function agenteHttps(): Agent {
  agenteCompartido ??= new Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2, timeout: 60_000 });
  return agenteCompartido;
}

/** Transporte real con axios: sin redirecciones, timeout de respuesta + corte total y tope de 10 MB. */
export class TransporteHttpGreAxios implements TransporteHttpGre {
  async ejecutar(peticion: PeticionHttpGre): Promise<RespuestaHttpGre> {
    exigirUrlPermitidaGre(peticion.url);
    try {
      const respuesta = await axios.request<string>({
        method: peticion.metodo,
        url: peticion.url,
        headers: { ...peticion.cabeceras },
        data: peticion.cuerpo,
        timeout: peticion.timeoutMs,
        signal: AbortSignal.timeout(peticion.timeoutMs + 2_000),
        transitional: { clarifyTimeoutError: true, silentJSONParsing: true, forcedJSONParsing: false },
        responseType: 'text',
        transformResponse: [(datos: unknown) => datos],
        validateStatus: () => true,
        maxRedirects: 0,
        maxContentLength: MAXIMO_BYTES_RESPUESTA_GRE,
        maxBodyLength: MAXIMO_BYTES_RESPUESTA_GRE,
        httpsAgent: agenteHttps(),
      });
      return { estadoHttp: respuesta.status, cuerpo: typeof respuesta.data === 'string' ? respuesta.data : String(respuesta.data ?? '') };
    } catch (error) {
      throw normalizarErrorRed(error);
    }
  }
}

// ── Cliente ───────────────────────────────────────────────────────────────────

/** No se pudo obtener el token. `tipo`: credenciales rechazadas, servicio no disponible, o datos inválidos (sin llamar). */
export class ErrorTokenGre extends Error {
  constructor(
    readonly tipo: 'credenciales' | 'no_disponible' | 'invalido',
    mensaje: string,
    readonly estadoHttp: number | null = null,
  ) {
    super(mensaje);
    this.name = 'ErrorTokenGre';
  }
}

interface TokenEnCache {
  token: string;
  /** Hasta cuándo se usa (5 minutos antes del vencimiento real). */
  usarHastaMs: number;
  /** Huella de las credenciales con que se pidió: si cambian en el panel, se pide otro. */
  huella: string;
}

export interface OpcionesClienteRestGre {
  /** Timeout por petición; se acota entre 15 y 30 s (por omisión 20 s). */
  timeoutMs?: number;
  /** Reloj para la caché del token (los specs lo fijan). */
  ahora?: () => number;
  /** Pausa entre reintentos (los specs la vuelven inmediata). */
  esperar?: (ms: number) => Promise<void>;
}

function huellaCredenciales(credenciales: CredencialesGre): string {
  return createHash('sha256')
    .update([credenciales.clientId, credenciales.clientSecret, credenciales.usuarioSol, credenciales.claveSol].join('\u0000'))
    .digest('hex');
}

function leerJsonSeguro(cuerpo: string): Record<string, unknown> | null {
  try {
    const valor: unknown = JSON.parse(cuerpo);
    return valor && typeof valor === 'object' && !Array.isArray(valor) ? (valor as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Mensaje del servidor de autenticación (OAuth2 error_description, o {cod, msg}), sin secretos. */
function mensajeErrorToken(cuerpo: string, secretos: readonly string[]): string {
  const json = leerJsonSeguro(cuerpo);
  const partes = [json?.error_description, json?.msg, json?.error]
    .filter((valor): valor is string => typeof valor === 'string' && valor.trim() !== '')
    .map((valor) => valor.trim().slice(0, 300));
  let mensaje = redactarSecretosGre(partes[0] ?? 'credenciales rechazadas');
  for (const secreto of secretos) {
    if (secreto && secreto.length >= 4) mensaje = mensaje.split(secreto).join('[REDACTADO]');
  }
  return mensaje;
}

export class ClienteRestGre {
  private readonly tokens = new Map<string, TokenEnCache>();
  private readonly pedidosEnCurso = new Map<string, Promise<TokenEnCache>>();
  private readonly timeoutMs: number;
  private readonly ahora: () => number;
  private readonly esperar: (ms: number) => Promise<void>;

  constructor(
    private readonly transporte: TransporteHttpGre,
    opciones: OpcionesClienteRestGre = {},
  ) {
    this.timeoutMs = Math.min(TIMEOUT_MAXIMO_MS, Math.max(TIMEOUT_MINIMO_MS, opciones.timeoutMs ?? TIMEOUT_GRE_MS));
    this.ahora = opciones.ahora ?? (() => Date.now());
    this.esperar = opciones.esperar ?? ((ms) => new Promise<void>((resolver) => setTimeout(resolver, ms)));
  }

  /** Token vigente (de la caché o uno nuevo). Lanza ErrorTokenGre con un mensaje ya saneado. */
  async obtenerToken(credenciales: CredencialesGre): Promise<string> {
    const clientId = String(credenciales?.clientId ?? '').trim();
    if (!PATRON_CLIENT_ID.test(clientId)) {
      throw new ErrorTokenGre('invalido', 'El client_id registrado no tiene un formato válido: vuelva a copiarlo desde SOL › Credenciales de API SUNAT.');
    }
    const huella = huellaCredenciales(credenciales);
    const enCache = this.tokens.get(clientId);
    if (enCache && enCache.huella === huella && enCache.usarHastaMs > this.ahora()) return enCache.token;

    // Una sola petición de token a la vez por credenciales: las demás esperan la misma respuesta.
    const clave = `${clientId}:${huella}`;
    let pedido = this.pedidosEnCurso.get(clave);
    if (!pedido) {
      pedido = this.pedirToken(clientId, credenciales, huella).finally(() => this.pedidosEnCurso.delete(clave));
      this.pedidosEnCurso.set(clave, pedido);
    }
    return (await pedido).token;
  }

  /** Olvida el token de un client_id (o todos). */
  invalidarToken(clientId?: string): void {
    if (clientId === undefined) this.tokens.clear();
    else this.tokens.delete(String(clientId).trim());
  }

  /** Envía el ZIP. Nunca lanza: normaliza en ResultadoEnvioGre. No reintenta solo (salvo renovar el token ante un 401). */
  async enviarGre(credenciales: CredencialesGre, preparada: GrePreparada): Promise<ResultadoEnvioGre> {
    const nombreBase = String(preparada?.nombreBase ?? '');
    if (!PATRON_NOMBRE_GRE.test(nombreBase)) {
      return envioSinRespuesta('invalido', `La guía preparada tiene un nombre de archivo inválido («${nombreBase}»): no se envió.`);
    }
    if (!Buffer.isBuffer(preparada.zip) || preparada.zip.length === 0) {
      return envioSinRespuesta('invalido', 'La guía preparada no tiene el archivo ZIP: no se envió. Vuelva a prepararla.');
    }
    // El hash y el base64 salen siempre de los bytes del ZIP; si no coinciden con lo guardado, algo se alteró.
    const hashZip = sha256Hex(preparada.zip);
    if (preparada.sha256 && preparada.sha256.toLowerCase() !== hashZip) {
      return envioSinRespuesta('invalido', 'El ZIP de la guía no coincide con el hash guardado: no se envió. Vuelva a prepararla.');
    }
    const cuerpo = JSON.stringify({
      archivo: { nomArchivo: `${nombreBase}.zip`, arcGreZip: preparada.zip.toString('base64'), hashZip },
    });
    return this.conToken<ResultadoEnvioGre>(credenciales, {
      peticion: (token) => ({
        metodo: 'POST',
        url: urlEnvioGre(nombreBase),
        cabeceras: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        cuerpo,
        timeoutMs: this.timeoutMs,
      }),
      reintentosRed: 0,
      sinRespuesta: envioSinRespuesta,
      clasificar: (respuesta) => clasificarEnvioGre(respuesta),
    });
  }

  /** Consulta el ticket. Nunca lanza. Se reintenta ante red o 5xx; si aun así falla, la guía sigue con su ticket. */
  async consultarTicket(credenciales: CredencialesGre, ticket: string, esperada?: GreEsperada): Promise<ResultadoConsultaGre> {
    const limpio = String(ticket ?? '').trim();
    if (!PATRON_TICKET.test(limpio)) {
      return consultaSinRespuesta('invalido', `El ticket «${limpio.slice(0, 40)}» no tiene un formato válido: revise la guía.`);
    }
    return this.conToken<ResultadoConsultaGre>(credenciales, {
      peticion: (token) => ({
        metodo: 'GET',
        url: urlConsultaGre(limpio),
        cabeceras: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        timeoutMs: this.timeoutMs,
      }),
      reintentosRed: REINTENTOS_CONSULTA,
      sinRespuesta: consultaSinRespuesta,
      clasificar: (respuesta) => clasificarConsultaGre(respuesta, esperada),
    });
  }

  private async pedirToken(clientId: string, credenciales: CredencialesGre, huella: string): Promise<TokenEnCache> {
    const secretos = [credenciales.clientSecret, credenciales.claveSol];
    const peticion: PeticionHttpGre = {
      metodo: 'POST',
      url: urlTokenGre(clientId),
      cabeceras: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      cuerpo: new URLSearchParams({
        grant_type: 'password',
        scope: SCOPE_GRE,
        client_id: clientId,
        client_secret: credenciales.clientSecret,
        username: credenciales.usuarioSol,
        password: credenciales.claveSol,
      }).toString(),
      timeoutMs: this.timeoutMs,
    };

    for (let intento = 0; ; intento++) {
      let respuesta: RespuestaHttpGre;
      try {
        respuesta = await this.transporte.ejecutar(peticion);
      } catch (error) {
        if (esUrlNoPermitida(error)) throw new ErrorTokenGre('invalido', (error as Error).message);
        if (intento < REINTENTOS_TOKEN) {
          await this.esperar(pausaReintento(intento));
          continue;
        }
        throw new ErrorTokenGre('no_disponible', sanearErrorHttpGre(error, secretos).mensaje);
      }

      const { estadoHttp, cuerpo } = respuesta;
      if (estadoHttp === 429 || estadoHttp >= 500) {
        if (intento < REINTENTOS_TOKEN) {
          await this.esperar(pausaReintento(intento));
          continue;
        }
        throw new ErrorTokenGre('no_disponible', `el servicio de autenticación de SUNAT respondió HTTP ${estadoHttp}`, estadoHttp);
      }
      if (estadoHttp === 400 || estadoHttp === 401 || estadoHttp === 403) {
        // Sin reintento: repetir una clave mala puede bloquear el usuario SOL.
        throw new ErrorTokenGre('credenciales', `${mensajeErrorToken(cuerpo, secretos)} (HTTP ${estadoHttp})`, estadoHttp);
      }
      if (estadoHttp !== 200) {
        throw new ErrorTokenGre('no_disponible', `el servicio de autenticación de SUNAT respondió HTTP ${estadoHttp}`, estadoHttp);
      }

      const json = leerJsonSeguro(cuerpo);
      const token = typeof json?.access_token === 'string' ? json.access_token.trim() : '';
      const segundos = Number(json?.expires_in);
      if (!token || /\s/.test(token) || !Number.isFinite(segundos) || segundos <= 0) {
        throw new ErrorTokenGre('no_disponible', 'SUNAT devolvió un token ilegible');
      }
      const enCache: TokenEnCache = { token, usarHastaMs: this.ahora() + segundos * 1000 - MARGEN_RENOVACION_TOKEN_MS, huella };
      // Un token que vence en menos de 5 minutos se usa una vez y no se guarda.
      if (enCache.usarHastaMs > this.ahora()) this.tokens.set(clientId, enCache);
      return enCache;
    }
  }

  /** Pide el token, ejecuta la petición, renueva el token una vez ante 401 y reintenta red/5xx según `reintentosRed`. */
  private async conToken<T>(
    credenciales: CredencialesGre,
    pasos: {
      peticion: (token: string) => PeticionHttpGre;
      reintentosRed: number;
      sinRespuesta: (motivo: MotivoSinRespuestaGre, detalle: string) => T;
      clasificar: (respuesta: RespuestaHttpGre) => T;
    },
  ): Promise<T> {
    let tokenRenovado = false;
    let reintentos = 0;
    for (;;) {
      let token: string;
      try {
        token = await this.obtenerToken(credenciales);
      } catch (error) {
        if (!(error instanceof ErrorTokenGre)) {
          return pasos.sinRespuesta('token_no_disponible', sanearErrorHttpGre(error, [credenciales?.clientSecret, credenciales?.claveSol]).mensaje);
        }
        return pasos.sinRespuesta(error.tipo === 'no_disponible' ? 'token_no_disponible' : error.tipo, error.message);
      }

      let respuesta: RespuestaHttpGre;
      try {
        respuesta = await this.transporte.ejecutar(pasos.peticion(token));
      } catch (error) {
        // También el mensaje de un ErrorTransporteGre pasa por el saneador: el transporte es inyectable.
        const detalle = sanearErrorHttpGre(error, [token, credenciales.clientSecret, credenciales.claveSol]).mensaje;
        if (esUrlNoPermitida(error)) return pasos.sinRespuesta('invalido', detalle);
        if (reintentos < pasos.reintentosRed) {
          await this.esperar(pausaReintento(reintentos));
          reintentos++;
          continue;
        }
        return pasos.sinRespuesta('red', detalle);
      }

      if (respuesta.estadoHttp === 401 && !tokenRenovado) {
        this.invalidarToken(credenciales.clientId);
        tokenRenovado = true;
        continue;
      }
      if ((respuesta.estadoHttp === 429 || respuesta.estadoHttp >= 500) && reintentos < pasos.reintentosRed) {
        await this.esperar(pausaReintento(reintentos));
        reintentos++;
        continue;
      }
      if (respuesta.cuerpo.length > MAXIMO_BYTES_RESPUESTA_GRE) {
        return pasos.sinRespuesta('red', 'la respuesta de SUNAT superó el tamaño máximo permitido');
      }
      return pasos.clasificar(respuesta);
    }
  }
}
