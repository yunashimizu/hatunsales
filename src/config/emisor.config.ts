/**
 * Datos del emisor que se imprimen en la cabecera del comprobante.
 *
 * Sirven solo para la vista previa: quien realmente rotula el documento es
 * NUBEFACT con los datos registrados en la cuenta. Se pueden sobreescribir
 * desde la tabla `configuraciones` sin volver a desplegar.
 */
export const emisorConfig = {
  ruc: process.env.EMISOR_RUC ?? '20610206337',
  razon_social: process.env.EMISOR_RAZON_SOCIAL ?? 'HATUNSALES S.A.C.',
  direccion: process.env.EMISOR_DIRECCION ?? 'LT. 8 MZ. N1 URB. NUEVO LURIN',
  ubicacion: process.env.EMISOR_UBICACION ?? 'LURIN - LIMA - LIMA',
  logo_url: process.env.EMISOR_LOGO_URL ?? '',
};

/** Claves equivalentes en la tabla `configuraciones`. */
export const CLAVES_EMISOR = [
  'emisor_ruc',
  'emisor_razon_social',
  'emisor_direccion',
  'emisor_ubicacion',
  'emisor_logo_url',
] as const;
