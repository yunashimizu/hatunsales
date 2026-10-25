import { GreTicketsTarea } from '../bussnies/tareas/gre-tickets.tarea';
import { UbigeoController } from '../catalogos/ubigeo/ubigeo.controller';
import { UbigeoService } from '../catalogos/ubigeo/ubigeo.service';
import { RegistroModulo } from './registro-modulo';

/**
 * Guía de remisión remitente: catálogo de ubigeos INEI (GET /ubigeo) y la consulta automática de tickets.
 * GuiaRemisionController, GuiaRemisionBussnies, GuiaRemisionRepository y las entidades de la guía siguen
 * registrados en app.module.ts; el negocio usa además EmisionGre (REGISTRO_SUNAT_GRE), FiscalConfigService,
 * RelojFiscal y TransaccionesFiscales (REGISTRO_SUNAT_CONFIG) y UbigeoService (este registro).
 */
export const REGISTRO_GUIAS: RegistroModulo = {
  entidades: [],
  controladores: [UbigeoController],
  proveedores: [{ provide: UbigeoService, useFactory: () => new UbigeoService() }, GreTicketsTarea],
};
