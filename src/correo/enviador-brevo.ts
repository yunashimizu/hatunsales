import axios from 'axios';
import type { ConfigCorreo } from './correo.config';
import { EnviadorCorreo, ErrorEnvioCorreo, MensajeCorreo, ResultadoEnvioCorreo } from './enviador-correo.contrato';
import { errorDeProveedor, TIMEOUT_CORREO_MS } from './http-correo';

export const URL_BREVO = 'https://api.brevo.com/v3/smtp/email';

/** Brevo (API HTTP v3): permite verificar solo una dirección remitente, sin dominio propio. */
export class EnviadorBrevo extends EnviadorCorreo {
  readonly nombre = 'brevo';

  constructor(private readonly config: Pick<ConfigCorreo, 'apiKey' | 'remitente' | 'remitenteNombre'>) {
    super();
  }

  async enviar(mensaje: MensajeCorreo): Promise<ResultadoEnvioCorreo> {
    if (!this.config.apiKey || !this.config.remitente) {
      throw new ErrorEnvioCorreo('Brevo: faltan CORREO_API_KEY o CORREO_REMITENTE.', true);
    }
    const cuerpo = {
      sender: { name: mensaje.remitenteNombre || this.config.remitenteNombre || 'HATUNSALES', email: this.config.remitente },
      to: [{ email: mensaje.para }],
      subject: mensaje.asunto,
      htmlContent: mensaje.html,
      textContent: mensaje.texto,
      attachment: mensaje.adjuntos.map((a) => ({ name: a.nombre, content: a.contenido.toString('base64') })),
    };
    try {
      const respuesta = await axios.post(URL_BREVO, cuerpo, {
        headers: { 'api-key': this.config.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        timeout: TIMEOUT_CORREO_MS,
      });
      const id = (respuesta?.data as { messageId?: string } | undefined)?.messageId;
      return { id_mensaje: id ?? null };
    } catch (error) {
      throw errorDeProveedor('Brevo', error);
    }
  }
}
