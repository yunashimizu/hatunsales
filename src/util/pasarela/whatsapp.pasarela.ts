import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { whatsappCloudListo, whatsappConfig } from '../../config/whatsapp.config';

export type ResultadoEnvioWa = {
  modo: 'cloud' | 'cloud_template' | 'wa_me' | 'no_config';
  ok: boolean;
  message_id?: string;
  wa_me_url?: string;
  mensaje?: string;
};

/**
 * Envío WhatsApp (mismo patrón que Culqi: env en Railway):
 * - Sin Meta → wa.me (vendedor confirma en WhatsApp Web/App)
 * - Con Meta + plantilla → Cloud API template (salida en frío, como hacen retail/e-commerce)
 * - Con Meta sin plantilla → texto libre (solo ventana 24h); si falla → wa.me
 */
@Injectable()
export class WhatsappPasarela {
  private readonly log = new Logger(WhatsappPasarela.name);

  estado() {
    const cloud = whatsappCloudListo();
    const plantilla = !!whatsappConfig.templateName?.trim();
    return {
      cloud_habilitado: cloud,
      plantilla_configurada: plantilla,
      modo: cloud ? (plantilla ? 'cloud_template' : 'cloud') : 'wa_me',
      mensaje: cloud
        ? plantilla
          ? `WhatsApp Business listo (plantilla «${whatsappConfig.templateName}»).`
          : 'WhatsApp Business listo (texto). Fuera de ventana 24h Meta exige plantilla: WHATSAPP_TEMPLATE_NAME.'
        : 'Sin Meta Cloud: se abre WhatsApp (wa.me). Pegue WHATSAPP_* en Railway para API.',
    };
  }

  /** Normaliza celular Perú → 51XXXXXXXXX (solo dígitos). */
  normalizarDestino(telefono: string): string | null {
    let d = String(telefono ?? '').replace(/\D/g, '');
    if (!d) return null;
    if (d.startsWith('51') && d.length >= 11) return d.slice(0, 12);
    if (d.length === 9 && d.startsWith('9')) return `51${d}`;
    if (d.length === 8) return `51${d}`;
    if (d.length >= 10 && d.length <= 15) return d;
    return null;
  }

  urlWaMe(telefonoE164: string, texto: string): string {
    const base = `https://wa.me/${telefonoE164}`;
    if (!texto?.trim()) return base;
    return `${base}?text=${encodeURIComponent(texto.trim())}`;
  }

  async enviarTexto(opts: {
    telefono: string;
    texto: string;
    /** Parámetros {{1}}… de la plantilla Meta (nombre, código, total…). */
    plantillaParams?: string[];
  }): Promise<ResultadoEnvioWa> {
    const destino = this.normalizarDestino(opts.telefono);
    if (!destino) {
      return {
        modo: 'no_config',
        ok: false,
        mensaje: 'Teléfono inválido. Use 9 dígitos (Perú) o con código 51.',
      };
    }

    const waMe = this.urlWaMe(destino, opts.texto);

    if (!whatsappCloudListo()) {
      return {
        modo: 'wa_me',
        ok: true,
        wa_me_url: waMe,
        mensaje: 'Abra WhatsApp con el enlace (Meta Cloud no configurado).',
      };
    }

    const plantilla = whatsappConfig.templateName?.trim();
    if (plantilla) {
      const r = await this.postCloud(destino, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: destino,
        type: 'template',
        template: {
          name: plantilla,
          language: { code: whatsappConfig.templateLang || 'es_PE' },
          components: this.componentesPlantilla(opts.plantillaParams),
        },
      });
      if (r.ok) {
        return {
          modo: 'cloud_template',
          ok: true,
          message_id: r.message_id,
          wa_me_url: waMe,
          mensaje: `Enviado por plantilla Meta «${plantilla}».`,
        };
      }
      this.log.warn(`Plantilla falló, intento texto/wa.me: ${r.error}`);
    }

    try {
      const { data } = await axios.post(
        this.urlMessages(),
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: destino,
          type: 'text',
          text: { preview_url: true, body: opts.texto.slice(0, 4096) },
        },
        this.headers(),
      );
      return {
        modo: 'cloud',
        ok: true,
        message_id: data?.messages?.[0]?.id,
        wa_me_url: waMe,
        mensaje: 'Mensaje enviado por WhatsApp Business (Meta).',
      };
    } catch (error: any) {
      const detalle =
        error?.response?.data?.error?.message ||
        error?.message ||
        'Error Meta WhatsApp';
      this.log.warn(`Cloud API falló, fallback wa.me: ${detalle}`);
      return {
        modo: 'wa_me',
        ok: true,
        wa_me_url: waMe,
        mensaje: `API Meta no disponible (${detalle}). Use el enlace wa.me.`,
      };
    }
  }

  private componentesPlantilla(params?: string[]) {
    const textos = (params ?? []).map((t) => String(t ?? '').slice(0, 1024)).filter(Boolean);
    if (!textos.length) return undefined;
    return [
      {
        type: 'body',
        parameters: textos.map((text) => ({ type: 'text', text })),
      },
    ];
  }

  private urlMessages() {
    return `${whatsappConfig.graphUrl}/${whatsappConfig.apiVersion}/${whatsappConfig.phoneNumberId}/messages`;
  }

  private headers() {
    return {
      headers: {
        Authorization: `Bearer ${whatsappConfig.token}`,
        'Content-Type': 'application/json',
      },
      timeout: whatsappConfig.timeoutMs,
    };
  }

  private async postCloud(
    _destino: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: true; message_id?: string } | { ok: false; error: string }> {
    try {
      const { data } = await axios.post(this.urlMessages(), body, this.headers());
      return { ok: true, message_id: data?.messages?.[0]?.id };
    } catch (error: any) {
      return {
        ok: false,
        error:
          error?.response?.data?.error?.message ||
          error?.message ||
          'Error plantilla Meta',
      };
    }
  }
}
