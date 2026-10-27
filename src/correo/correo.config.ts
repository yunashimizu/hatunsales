import { Logger } from '@nestjs/common';
import { EnviadorBrevo } from './enviador-brevo';
import { EnviadorArchivo } from './enviador-archivo';
import { EnviadorCorreo } from './enviador-correo.contrato';
import { EnviadorResend } from './enviador-resend';

export type ProveedorCorreo = 'brevo' | 'resend' | 'archivo';

export interface ConfigCorreo {
  proveedor: ProveedorCorreo;
  apiKey: string | null;
  remitente: string | null;
  remitenteNombre: string | null;
  destinoPruebas: string | null;
}

type Entorno = Record<string, string | undefined>;

const REGEX_CORREO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Formato razonable de correo (no valida que exista): una arroba, un punto en el dominio, sin espacios, hasta 254. */
export function correoValido(texto: unknown): texto is string {
  return typeof texto === 'string' && texto.length <= 254 && REGEX_CORREO.test(texto.trim());
}

function texto(valor: string | undefined): string | null {
  const limpio = (valor ?? '').trim();
  return limpio || null;
}

/** Lee las variables CORREO_* (se lee en cada llamada, no al importar). Sin CORREO_PROVEEDOR el valor es «archivo». */
export function leerConfigCorreo(env: Entorno = process.env): ConfigCorreo {
  const pedido = (env.CORREO_PROVEEDOR ?? '').trim().toLowerCase();
  const proveedor: ProveedorCorreo = pedido === 'brevo' || pedido === 'resend' ? pedido : 'archivo';
  if (pedido && pedido !== proveedor) {
    new Logger('CorreoConfig').warn(`CORREO_PROVEEDOR="${pedido}" no es válido (brevo, resend o archivo): se usa «archivo».`);
  }
  return {
    proveedor,
    apiKey: texto(env.CORREO_API_KEY),
    remitente: texto(env.CORREO_REMITENTE),
    remitenteNombre: texto(env.CORREO_REMITENTE_NOMBRE),
    destinoPruebas: texto(env.CORREO_DESTINO_PRUEBAS),
  };
}

/** Elige el adaptador según CORREO_PROVEEDOR. Nunca lanza: si faltan datos, el envío falla con un mensaje claro. */
export function fabricarEnviador(env: Entorno = process.env): EnviadorCorreo {
  const config = leerConfigCorreo(env);
  if (config.proveedor === 'brevo') return new EnviadorBrevo(config);
  if (config.proveedor === 'resend') return new EnviadorResend(config);
  return new EnviadorArchivo();
}
