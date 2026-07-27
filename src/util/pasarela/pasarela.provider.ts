import { Logger, Provider } from '@nestjs/common';
import { pasarelaConfig } from '../../config/pasarela.config';
import { PASARELA_PAGO, PasarelaPago } from './pasarela.interface';
import { CulqiPasarela } from './culqi.pasarela';
import { PasarelaSimulada } from './simulada.pasarela';

/**
 * Elige la pasarela según PASARELA_PROVEEDOR. Si el proveedor elegido no tiene
 * credenciales, cae a la simulada y lo avisa por consola: la tienda nunca se
 * queda sin poder cobrar por una variable de entorno olvidada.
 */
export const pasarelaProvider: Provider = {
  provide: PASARELA_PAGO,
  inject: [CulqiPasarela, PasarelaSimulada],
  useFactory: (culqi: CulqiPasarela, simulada: PasarelaSimulada): PasarelaPago => {
    const log = new Logger('Pasarela');
    const elegida = pasarelaConfig.proveedor;

    if (elegida === 'culqi') {
      if (culqi.operativa()) {
        log.log('Pasarela de pago activa: Culqi');
        return culqi;
      }
      log.warn('PASARELA_PROVEEDOR=culqi pero falta CULQI_SECRET_KEY; se usará la pasarela simulada');
    }

    log.log('Pasarela de pago activa: simulada');
    return simulada;
  },
};
