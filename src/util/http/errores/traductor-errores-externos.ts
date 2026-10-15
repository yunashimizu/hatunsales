import type { ErrorTraducido, TraductorError } from './error-traducido';
import { codigoPorEstado, mensajePorEstado } from './estado-http';

const CODIGOS_DE_RED = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);

const SERVICIOS = 'SUNAT, la consulta de DNI/RUC o la pasarela de pago';

interface ErrorAxios {
  readonly isAxiosError?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly config?: { readonly method?: unknown; readonly url?: unknown; readonly baseURL?: unknown };
  readonly response?: { readonly status?: unknown };
}

interface ErrorHttpCrudo {
  readonly status?: unknown;
  readonly statusCode?: unknown;
  readonly expose?: unknown;
  readonly type?: unknown;
  readonly limit?: unknown;
}

/** Solo el host: la URL completa puede llevar el token en la query (ApiPeru antiguo). */
export function hostSeguro(url: unknown, base?: unknown): string {
  try {
    return new URL(String(url ?? ''), typeof base === 'string' && base ? base : undefined).host || 'servicio externo';
  } catch {
    return 'servicio externo';
  }
}

function formatearBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** Estado de un error estilo `http-errors` (body-parser, serve-static…), o null. */
function estadoHttpCrudo(error: ErrorHttpCrudo): number | null {
  const estado = typeof error.status === 'number' ? error.status : error.statusCode;
  const esHttpError = typeof error.expose === 'boolean' || typeof error.type === 'string';
  return esHttpError && typeof estado === 'number' && estado >= 400 && estado <= 599 ? estado : null;
}

/**
 * Errores que no vienen de la lógica propia: llamadas HTTP salientes (axios),
 * errores de body-parser (cuerpo demasiado grande, JSON roto) y caídas de red.
 */
export class TraductorErroresExternos implements TraductorError {
  traducir(error: unknown): ErrorTraducido | null {
    if (!error || typeof error !== 'object') return null;

    if ((error as ErrorAxios).isAxiosError === true) return this.desdeAxios(error as ErrorAxios);

    const estadoHttp = estadoHttpCrudo(error as ErrorHttpCrudo);
    if (estadoHttp) return this.desdeErrorHttp(error as ErrorHttpCrudo, estadoHttp);

    const codigo = (error as { code?: unknown }).code;
    if (typeof codigo === 'string' && CODIGOS_DE_RED.has(codigo)) {
      return {
        estado: 503,
        codigo: 'SERVICIO_NO_DISPONIBLE',
        mensaje: 'Un servicio interno no respondió (red o base de datos). Intente de nuevo en unos segundos.',
        reintentarEnSeg: 5,
        registro: 'error',
        detalleLog: `Error de red ${codigo}`,
      };
    }

    const nombre = String((error as { name?: unknown }).name ?? '');
    if (nombre === 'TimeoutError' || nombre === 'AbortError') {
      return {
        estado: 504,
        codigo: 'SERVICIO_EXTERNO_TIEMPO',
        mensaje: `Un servicio externo (${SERVICIOS}) tardó demasiado en responder. Intente de nuevo en unos segundos.`,
        reintentarEnSeg: 5,
        registro: 'error',
        detalleLog: nombre,
      };
    }
    return null;
  }

  private desdeAxios(error: ErrorAxios): ErrorTraducido {
    const metodo = String(error.config?.method ?? 'get').toUpperCase();
    const host = hostSeguro(error.config?.url, error.config?.baseURL);
    const estadoRemoto = error.response?.status;
    const detalleLog = `${metodo} ${host} → ${typeof estadoRemoto === 'number' ? estadoRemoto : String(error.code ?? 'sin respuesta')}`;
    const porTiempo =
      error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || /timeout/i.test(String(error.message ?? ''));

    if (porTiempo) {
      return {
        estado: 504,
        codigo: 'SERVICIO_EXTERNO_TIEMPO',
        mensaje: `Un servicio externo (${SERVICIOS}) tardó demasiado en responder. Intente de nuevo en unos segundos.`,
        reintentarEnSeg: 5,
        registro: 'error',
        detalleLog,
      };
    }
    return {
      estado: 502,
      codigo: 'SERVICIO_EXTERNO_NO_DISPONIBLE',
      mensaje: `Un servicio externo (${SERVICIOS}) respondió con un error. Intente de nuevo en unos segundos.`,
      reintentarEnSeg: 5,
      registro: 'error',
      detalleLog,
    };
  }

  private desdeErrorHttp(error: ErrorHttpCrudo, estado: number): ErrorTraducido {
    switch (error.type) {
      case 'entity.too.large': {
        const limite = typeof error.limit === 'number' ? ` (máximo ${formatearBytes(error.limit)})` : '';
        return {
          estado: 413,
          codigo: 'ARCHIVO_MUY_GRANDE',
          mensaje: `Los datos enviados superan el tamaño permitido${limite}.`,
          registro: 'advertencia',
          detalleLog: 'Cuerpo de la solicitud demasiado grande',
        };
      }
      case 'entity.parse.failed':
        return { estado: 400, codigo: 'JSON_INVALIDO', mensaje: 'El cuerpo de la solicitud no es un JSON válido.', registro: 'ninguno' };
      case 'encoding.unsupported':
      case 'charset.unsupported':
        return {
          estado: 415,
          codigo: 'TIPO_NO_SOPORTADO',
          mensaje: 'La codificación del contenido enviado no es compatible (use UTF-8).',
          registro: 'ninguno',
        };
      case 'request.aborted':
        return {
          estado: 400,
          codigo: 'SOLICITUD_INVALIDA',
          mensaje: 'La solicitud se interrumpió antes de terminar de enviarse.',
          registro: 'ninguno',
        };
      case 'parameters.too.many':
        return { estado: 413, codigo: 'ARCHIVO_MUY_GRANDE', mensaje: 'El formulario tiene demasiados campos.', registro: 'ninguno' };
      default:
        return {
          estado,
          codigo: codigoPorEstado(estado),
          mensaje: mensajePorEstado(estado),
          registro: estado >= 500 ? 'error' : 'ninguno',
          detalleLog: typeof error.type === 'string' ? `Error HTTP ${estado} (${error.type})` : undefined,
        };
    }
  }
}
