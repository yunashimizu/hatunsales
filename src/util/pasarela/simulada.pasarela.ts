import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { esProduccion } from '../../config/runtime.config';
import {
  EventoWebhook,
  PasarelaPago,
  ResultadoCargo,
  SolicitudCargo,
} from './pasarela.interface';

/**
 * Pasarela de respaldo mientras no haya llaves de Culqi.
 *
 * En desarrollo aprueba todo cargo con token (salvo que empiece con 'rechazar')
 * y acepta cualquier webhook, para probar la tienda de punta a punta.
 *
 * En producción NO existe un cobro real detrás: nunca aprueba un cargo ni
 * acepta un webhook. Si lo hiciera, cualquiera marcaría pedidos como pagados
 * (y generaría su venta) sin que entre dinero. Los pagos sin pasarela
 * (transferencia, Yape, contra entrega) los confirma el administrador.
 */
@Injectable()
export class PasarelaSimulada implements PasarelaPago {

  readonly nombre = 'simulada';

  llavePublica(): string {
    return '';
  }

  operativa(): boolean {
    return true;
  }

  async crearCargo(solicitud: SolicitudCargo): Promise<ResultadoCargo> {
    if (esProduccion()) {
      return {
        aprobado: false,
        referencia: '',
        proveedor: this.nombre,
        mensaje: 'El pago con tarjeta no está habilitado en la tienda. Elige transferencia, Yape o pago contra entrega.',
        crudo: { simulado: true, rechazado_en_produccion: true },
      };
    }

    const rechazar = solicitud.token?.startsWith('rechazar');

    return {
      aprobado: !rechazar,
      referencia: `SIM-${randomUUID().slice(0, 12).toUpperCase()}`,
      proveedor: this.nombre,
      mensaje: rechazar ? 'Pago rechazado (modo de prueba)' : 'Pago aprobado (modo de prueba)',
      crudo: { simulado: true, monto: solicitud.monto, moneda: solicitud.moneda },
    };
  }

  interpretarWebhook(cuerpo: any): EventoWebhook {
    return {
      // Sin firma que verificar: solo vale fuera de producción.
      valido: !esProduccion(),
      tipo: String(cuerpo?.type ?? 'simulado'),
      referencia: cuerpo?.referencia,
      aprobado: cuerpo?.aprobado !== false,
      monto: cuerpo?.monto ? Number(cuerpo.monto) : undefined,
      metadata: cuerpo?.metadata ?? {},
      crudo: cuerpo,
    };
  }
}
