import { ErrorEnvioCorreo } from './enviador-correo.contrato';

/** Traduce el error de axios (o de red) a ErrorEnvioCorreo: red, 408, 429 y 5xx son reintentables; los demás 4xx no. */
export function errorDeProveedor(proveedor: string, error: unknown): ErrorEnvioCorreo {
  if (error instanceof ErrorEnvioCorreo) return error;
  const e = error as { response?: { status?: number; data?: unknown }; message?: string } | null;
  const estado = typeof e?.response?.status === 'number' ? e.response.status : null;
  if (estado === null) {
    return new ErrorEnvioCorreo(`${proveedor}: sin respuesta (${e?.message ?? 'error de red'})`, true, null);
  }
  const datos = e?.response?.data as { message?: string; error?: string } | string | undefined;
  const detalle = typeof datos === 'string' ? datos : (datos?.message ?? datos?.error ?? '');
  const reintentable = estado >= 500 || estado === 429 || estado === 408;
  return new ErrorEnvioCorreo(`${proveedor} respondió ${estado}${detalle ? `: ${String(detalle).slice(0, 300)}` : ''}`, reintentable, estado);
}

export const TIMEOUT_CORREO_MS = 15_000;
