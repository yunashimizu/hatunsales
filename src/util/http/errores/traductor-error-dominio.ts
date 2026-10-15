import { esErrorConCodigo, esObjetoPlano, estadoDeclarado, sinCamposReservados } from './error-dominio';
import type { ErrorTraducido, TraductorError } from './error-traducido';
import { mensajePorEstado } from './estado-http';

const REINTENTO_POR_DEFECTO_503 = 5;

function cuerpoPropio(error: { cuerpo?: unknown }): Record<string, unknown> | undefined {
  if (typeof error.cuerpo !== 'function') return undefined;
  try {
    const valor: unknown = (error.cuerpo as () => unknown).call(error);
    return esObjetoPlano(valor) ? valor : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Errores de dominio que no son HttpException pero traen `codigo` (ErrorCaja,
 * FiscalConfigError, ErrorNucleoFiscal, ErrorDominio…). Usa su estado HTTP
 * (`estadoHttp`, `status` o `statusCode`); si no declara ninguno responde 500
 * conservando su código y su mensaje, que por convención es apto para mostrar.
 */
export class TraductorErrorDominio implements TraductorError {
  traducir(error: unknown): ErrorTraducido | null {
    if (!esErrorConCodigo(error)) return null;

    const declarado = estadoDeclarado(error);
    const estado = declarado ?? 500;
    const cuerpo = cuerpoPropio(error);
    const mensaje =
      (typeof cuerpo?.message === 'string' && cuerpo.message.trim()) || error.message?.trim() || mensajePorEstado(estado);
    const reintentar =
      typeof error.reintentarEnSeg === 'number' && error.reintentarEnSeg > 0
        ? Math.ceil(error.reintentarEnSeg)
        : estado === 503
          ? REINTENTO_POR_DEFECTO_503
          : undefined;

    return {
      estado,
      codigo: error.codigo,
      mensaje,
      extra: sinCamposReservados(cuerpo ?? error.detalle),
      reintentarEnSeg: reintentar,
      registro: estado >= 500 ? 'error' : 'ninguno',
      detalleLog: declarado ? undefined : `${error.codigo} sin estado HTTP declarado: se respondió 500`,
    };
  }
}
