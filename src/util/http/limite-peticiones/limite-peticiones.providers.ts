import type { Provider } from '@nestjs/common';
import { AlmacenLimitesMemoria } from './almacen-limites';
import { configLimitesDesdeEntorno, PoliticaLimites } from './politica-limites';

/** Token del almacén de contadores (interfaz AlmacenLimites). */
export const ALMACEN_LIMITES = Symbol('ALMACEN_LIMITES');

/** Política (leída del entorno al arrancar) y almacén en memoria del limitador. */
export const PROVEEDORES_LIMITE_PETICIONES: Provider[] = [
  { provide: PoliticaLimites, useFactory: () => new PoliticaLimites(configLimitesDesdeEntorno()) },
  {
    provide: ALMACEN_LIMITES,
    useFactory: (politica: PoliticaLimites) => new AlmacenLimitesMemoria(politica.maxClaves),
    inject: [PoliticaLimites],
  },
];
