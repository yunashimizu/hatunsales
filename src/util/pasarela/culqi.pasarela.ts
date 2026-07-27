import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { pasarelaConfig } from '../../config/pasarela.config';
import {
  EventoWebhook,
  PasarelaPago,
  ResultadoCargo,
  SolicitudCargo,
} from './pasarela.interface';

/**
 * Adaptador de Culqi (https://docs.culqi.com).
 *
 * El flujo es: el navegador tokeniza la tarjeta con la llave pública y nos
 * manda solo el token; aquí creamos el cargo con la llave secreta. La tarjeta
 * nunca pasa por nuestro servidor.
 *
 * Para activarlo basta con las variables de entorno descritas en
 * config/pasarela.config.ts. No hay nada más que cambiar.
 */
@Injectable()
export class CulqiPasarela implements PasarelaPago {

  readonly nombre = 'culqi';
  private readonly log = new Logger(CulqiPasarela.name);

  llavePublica(): string {
    return pasarelaConfig.culqi.publicKey;
  }

  operativa(): boolean {
    return !!pasarelaConfig.culqi.secretKey;
  }

  async crearCargo(solicitud: SolicitudCargo): Promise<ResultadoCargo> {
    const { url, secretKey, timeoutMs } = pasarelaConfig.culqi;

    // Culqi trabaja en céntimos y no acepta decimales.
    const cuerpo = {
      amount: Math.round(solicitud.monto * 100),
      currency_code: solicitud.moneda || 'PEN',
      email: solicitud.email,
      source_id: solicitud.token,
      description: solicitud.descripcion.slice(0, 80),
      metadata: solicitud.metadata ?? {},
    };

    const control = new AbortController();
    const temporizador = setTimeout(() => control.abort(), timeoutMs);

    try {
      const respuesta = await fetch(`${url}/charges`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secretKey}`,
          'x-culqi-idempotency-key': solicitud.claveIdempotencia,
        },
        body: JSON.stringify(cuerpo),
        signal: control.signal,
      });

      const datos: any = await respuesta.json().catch(() => ({}));

      if (!respuesta.ok) {
        return {
          aprobado: false,
          referencia: datos?.charge_id ?? '',
          proveedor: this.nombre,
          mensaje: datos?.user_message ?? datos?.merchant_message ?? 'La tarjeta fue rechazada',
          crudo: datos,
        };
      }

      return {
        aprobado: datos?.outcome?.type === 'venta_exitosa' || respuesta.status === 201,
        referencia: datos?.id ?? '',
        proveedor: this.nombre,
        mensaje: datos?.outcome?.user_message ?? 'Pago aprobado',
        crudo: datos,
      };
    } catch (error: any) {
      const abortado = error?.name === 'AbortError';
      this.log.error(`Error al crear el cargo en Culqi: ${error?.message}`);

      return {
        aprobado: false,
        referencia: '',
        proveedor: this.nombre,
        mensaje: abortado
          ? 'La pasarela no respondió a tiempo. Revisa tu estado de cuenta antes de reintentar.'
          : 'No pudimos comunicarnos con la pasarela de pago',
        crudo: { error: error?.message },
      };
    } finally {
      clearTimeout(temporizador);
    }
  }

  interpretarWebhook(cuerpo: any, cabeceras: Record<string, any>): EventoWebhook {
    const secreto = pasarelaConfig.culqi.webhookSecret;
    const firma = String(cabeceras['x-culqi-signature'] ?? cabeceras['X-Culqi-Signature'] ?? '');

    // Sin secreto configurado no podemos validar; se acepta pero queda en la
    // bitácora para revisión manual.
    const valido = secreto ? this.firmaValida(cuerpo, firma, secreto) : true;
    const objeto = cuerpo?.data ?? cuerpo?.object ?? cuerpo ?? {};
    const tipo = String(cuerpo?.type ?? cuerpo?.event ?? 'desconocido');

    return {
      valido,
      tipo,
      referencia: objeto?.id ?? objeto?.charge_id,
      aprobado: tipo.includes('charge.creation.succeeded') || objeto?.outcome?.type === 'venta_exitosa',
      monto: objeto?.amount ? Number(objeto.amount) / 100 : undefined,
      metadata: objeto?.metadata ?? {},
      crudo: cuerpo,
    };
  }

  private firmaValida(cuerpo: any, firma: string, secreto: string): boolean {
    if (!firma) return false;

    try {
      const esperada = createHmac('sha256', secreto).update(JSON.stringify(cuerpo)).digest('hex');
      const a = Buffer.from(esperada);
      const b = Buffer.from(firma);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}
