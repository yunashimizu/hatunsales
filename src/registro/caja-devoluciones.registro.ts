import { ControlCajaService } from '../caja/configuracion/control-caja.service';
import { DevolucionCajaRepository } from '../caja/devolucion/devolucion-caja.repository';
import { DevolucionCajaService } from '../caja/devolucion/devolucion-caja.service';
import { CierreAutomaticoTarea } from '../caja/tareas/cierre-automatico.tarea';
import { RegistroModulo } from './registro-modulo';

/**
 * Fase 7 (caja y devoluciones, sql/fase20). Sin controladores propios: las rutas viven en
 * CajaArqueoController (`caja/devolucion/:id_venta`, `caja/gastos/categorias`), CajaSesionController
 * (`caja/ventas-sin-turno`) y ConfiguracionController (`configuracion/control-caja`).
 *
 * Cadena de inyección (todo en AppModule vía REGISTROS, sin ciclos):
 * - ControlCajaService ← ConfiguracionRepository (AppModule) + BitacoraService @Optional (REGISTRO_BITACORA).
 * - DevolucionCajaRepository ← DataSource 'pgConnection' + EsquemaCajaService (REGISTRO_CAJA).
 * - DevolucionCajaService ← DevolucionCajaRepository, CajaArqueoRepository (REGISTRO_CAJA), CajaSesionRepository
 *   (AppModule), EsquemaCajaService, ControlCajaService @Optional y BitacoraService @Optional. No depende de
 *   ninguna clase de negocio.
 * - CierreAutomaticoTarea ← CajaSesionRepository, CajaSesionBussnies (AppModule), ControlCajaService.
 * Lo reciben con @Optional, en el último lugar del constructor: NotaCreditoBussnies (DevolucionCajaService),
 * CajaArqueoBussnies, CajaSesionBussnies y CajaTurnosBussnies (ControlCajaService), CajaArqueoController
 * (DevolucionCajaService) y ConfiguracionController (ControlCajaService).
 */
export const REGISTRO_CAJA_DEVOLUCIONES: RegistroModulo = {
  entidades: [],
  controladores: [],
  proveedores: [ControlCajaService, DevolucionCajaRepository, DevolucionCajaService, CierreAutomaticoTarea],
};
