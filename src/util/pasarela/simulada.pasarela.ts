import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  EventoWebhook,
  PasarelaPago,
  ResultadoCargo,
  SolicitudCargo,
} from './pasarela.interface';

/**
 * Pasarela de respaldo para desarrollo y para los métodos que no pasan por una
 * pasarela real (transferencia, Yape con constancia, pago contra entrega).
 *
 * Aprueba siempre, salvo que el token empiece con 'rechazar', lo que permite
 * probar el camino de error sin credenciales.
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
      valido: true,
      tipo: String(cuerpo?.type ?? 'simulado'),
      referencia: cuerpo?.referencia,
      aprobado: cuerpo?.aprobado !== false,
      monto: cuerpo?.monto ? Number(cuerpo.monto) : undefined,
      metadata: cuerpo?.metadata ?? {},
      crudo: cuerpo,
    };
  }
}
