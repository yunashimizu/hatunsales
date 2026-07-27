/**
 * Configuración de la pasarela de pago.
 *
 * Para pasar de la pasarela simulada a Culqi solo hace falta definir estas
 * variables de entorno; no se toca código:
 *
 *   PASARELA_PROVEEDOR=culqi
 *   CULQI_URL=https://api.culqi.com/v2
 *   CULQI_SECRET_KEY=sk_live_xxxxxxxxxxxx
 *   CULQI_PUBLIC_KEY=pk_live_xxxxxxxxxxxx
 *   CULQI_WEBHOOK_SECRET=whsec_xxxxxxxxxxxx
 *
 * Si PASARELA_PROVEEDOR no está definida o no hay llave secreta, el sistema
 * usa la pasarela simulada y la tienda sigue funcionando de punta a punta.
 */
export const pasarelaConfig = {
  proveedor: (process.env.PASARELA_PROVEEDOR ?? 'simulada').toLowerCase(),
  moneda: process.env.PASARELA_MONEDA ?? 'PEN',

  culqi: {
    url: process.env.CULQI_URL ?? 'https://api.culqi.com/v2',
    secretKey: process.env.CULQI_SECRET_KEY ?? '',
    publicKey: process.env.CULQI_PUBLIC_KEY ?? '',
    webhookSecret: process.env.CULQI_WEBHOOK_SECRET ?? '',
    timeoutMs: Number(process.env.CULQI_TIMEOUT_MS ?? 20000),
  },
};

/** true cuando hay credenciales reales cargadas para el proveedor elegido. */
export function pasarelaConfigurada(): boolean {
  if (pasarelaConfig.proveedor === 'culqi') return !!pasarelaConfig.culqi.secretKey;
  return false;
}
