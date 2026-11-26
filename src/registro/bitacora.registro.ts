import { BitacoraController } from '../api/controllers/bitacora.controller';
import { BitacoraRepository } from '../bitacora/bitacora.repository';
import { BitacoraService } from '../bitacora/bitacora.service';
import { RegistroModulo } from './registro-modulo';

/**
 * Bitácora de acciones (Fase 6.3, sql/fase19): repositorio, servicio y la lectura de la pantalla «Actividad».
 * BitacoraRepository usa el DataSource 'pgConnection'; BitacoraService usa además EsquemaCajaService
 * (REGISTRO_CAJA). La usan VentaBussnies, InventarioBussnies, ProductoBussnies, CajaSesionBussnies y
 * NotaCreditoBussnies, siempre como dependencia @Optional.
 */
export const REGISTRO_BITACORA: RegistroModulo = {
  entidades: [],
  controladores: [BitacoraController],
  proveedores: [BitacoraRepository, BitacoraService],
};
