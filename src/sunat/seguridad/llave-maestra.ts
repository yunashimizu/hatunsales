/**
 * Interpretación de FISCAL_SECRET_KEY: 32 bytes en base64 (`openssl rand -base64 32`)
 * o 64 caracteres hexadecimales (`openssl rand -hex 32`). Nunca se registra el valor.
 */

export const LARGO_LLAVE_MAESTRA = 32;

export type LlaveInterpretada =
  | { estado: 'ausente' }
  | { estado: 'invalida'; motivo: string }
  | { estado: 'valida'; llave: Buffer };

const HEX_64 = /^[0-9a-fA-F]{64}$/;
// 32 bytes = 43 caracteres base64 + un '=' opcional (alfabeto estándar o URL-safe).
const BASE64_32 = /^[A-Za-z0-9+/]{43}=?$|^[A-Za-z0-9_-]{43}=?$/;

export const AYUDA_LLAVE_MAESTRA =
  'Debe tener 32 bytes: genérela con `openssl rand -base64 32` (o `openssl rand -hex 32`).';

export function interpretarLlaveMaestra(valor: string | null | undefined): LlaveInterpretada {
  const texto = (valor ?? '').trim().replace(/^["']|["']$/g, '');
  if (!texto) return { estado: 'ausente' };

  let llave: Buffer | null = null;
  if (HEX_64.test(texto)) {
    llave = Buffer.from(texto, 'hex');
  } else if (BASE64_32.test(texto)) {
    llave = Buffer.from(texto.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }

  if (!llave || llave.length !== LARGO_LLAVE_MAESTRA) {
    return { estado: 'invalida', motivo: `FISCAL_SECRET_KEY no tiene un formato válido. ${AYUDA_LLAVE_MAESTRA}` };
  }
  // Una llave con todos los bytes iguales (p. ej. 32 ceros) es un error de configuración, no una llave.
  if (llave.every((byte) => byte === llave![0])) {
    return { estado: 'invalida', motivo: `FISCAL_SECRET_KEY es trivial (todos los bytes iguales). ${AYUDA_LLAVE_MAESTRA}` };
  }
  return { estado: 'valida', llave };
}
