/**
 * WhatsApp Business (Meta Cloud API) — plug-and-play como Culqi.
 *
 * Sin estas vars el sistema usa solo wa.me (abrir chat del vendedor).
 * Con vars en Railway, POST /whatsapp/enviar intenta Cloud API.
 *
 *   WHATSAPP_ENABLED=true
 *   WHATSAPP_TOKEN=EAAxxxx…          (token permanente / system user)
 *   WHATSAPP_PHONE_NUMBER_ID=123…    (ID del número en Meta)
 *   WHATSAPP_API_VERSION=v21.0
 *   WHATSAPP_GRAPH_URL=https://graph.facebook.com
 *
 * Opcional plantilla (fuera de ventana 24h):
 *   WHATSAPP_TEMPLATE_NAME=hello_world
 *   WHATSAPP_TEMPLATE_LANG=es_PE
 */
export const whatsappConfig = {
  enabled: (process.env.WHATSAPP_ENABLED ?? '').toLowerCase() === 'true',
  token: process.env.WHATSAPP_TOKEN ?? '',
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
  apiVersion: process.env.WHATSAPP_API_VERSION ?? 'v21.0',
  graphUrl: (process.env.WHATSAPP_GRAPH_URL ?? 'https://graph.facebook.com').replace(/\/$/, ''),
  templateName: process.env.WHATSAPP_TEMPLATE_NAME ?? '',
  templateLang: process.env.WHATSAPP_TEMPLATE_LANG ?? 'es_PE',
  timeoutMs: Number(process.env.WHATSAPP_TIMEOUT_MS ?? 20000),
};

/** true solo si hay credenciales Meta listas para enviar por API. */
export function whatsappCloudListo(): boolean {
  return (
    whatsappConfig.enabled &&
    !!whatsappConfig.token &&
    !!whatsappConfig.phoneNumberId
  );
}
