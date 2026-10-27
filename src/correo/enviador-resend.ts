import axios from 'axios';
import type { ConfigCorreo } from './correo.config';
import { EnviadorCorreo, ErrorEnvioCorreo, MensajeCorreo, ResultadoEnvioCorreo } from './enviador-correo.contrato';
import { errorDeProveedor, TIMEOUT_CORREO_MS } from './http-correo';

export const URL_RESEND = 'https://api.resend.com/emails';

/** Resend (API HTTP): conviene cuando haya un dominio propio con SPF/DKIM. */
export class EnviadorResend extends EnviadorCorreo {
  readonly nombre = 'resend';

  constructor(private readonly config: Pick<ConfigCorreo, 'apiKey' | 'remitente' | 'remitenteNombre'>) {
    super();
  }

  async enviar(mensaje: MensajeCorreo): Promise<ResultadoEnvioCorreo> {
    if (!this.config.apiKey || !this.config.remitente) {
      throw new ErrorEnvioCorreo('Resend: faltan CORREO_API_KEY o CORREO_REMITENTE.', true);
    }
    const nombre = (mensaje.remitenteNombre || this.config.remitenteNombre || 'HATUNSALES').replace(/[<>"]/g, '');
    const cuerpo = {
      from: `${nombre} <${this.config.remitente}>`,
      to: [mensaje.para],
      subject: mensaje.asunto,
      html: mensaje.html,
      text: mensaje.texto,
      attachments: mensaje.adjuntos.map((a) => ({ filename: a.nombre, content: a.contenido.toString('base64') })),
    };
    try {
      const respuesta = await axios.post(URL_RESEND, cuerpo, {
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
        timeout: TIMEOUT_CORREO_MS,
      });
      const id = (respuesta?.data as { id?: string } | undefined)?.id;
      return { id_mensaje: id ?? null };
    } catch (error) {
      throw errorDeProveedor('Resend', error);
    }
  }
}
