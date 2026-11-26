import { PosRapidoRepository } from '../pos-rapido/pos-rapido.repository';
import { PosRapidoService } from '../pos-rapido/pos-rapido.service';
import { PosRapidoController } from '../api/controllers/pos-rapido.controller';
import { AlmacenDireccionService } from '../stock/almacen-direccion.service';
import { RegistroModulo } from './registro-modulo';

/**
 * Tanda G-back (Fases 3.2, 3.3 y 4.4; sql/fase22).
 *
 * Cadena de inyección (todo en AppModule vía REGISTROS, sin ciclos):
 * - PosRapidoRepository ← DataSource 'pgConnection'.
 * - PosRapidoService ← PosRapidoRepository + EsquemaCajaService @Optional (REGISTRO_CAJA).
 * - AlmacenDireccionService ← DataSource, EsquemaCajaService @Optional, FiscalConfigService @Optional
 *   (REGISTRO_SUNAT_CONFIG). No depende de clases de negocio.
 * Lo recibe con @Optional, en el último lugar del constructor: AlmacenController.
 */
export const REGISTRO_DATOS_LIMPIOS: RegistroModulo = {
  entidades: [],
  controladores: [PosRapidoController],
  proveedores: [PosRapidoRepository, PosRapidoService, AlmacenDireccionService],
};
