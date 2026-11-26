import { ControlStockService } from '../stock/control-stock.service';
import { LocalesUsuarioRepository } from '../stock/locales-usuario.repository';
import { LocalesUsuarioService } from '../stock/locales-usuario.service';
import { CobrosPorDevolverService } from '../pedidos-web/cobros-por-devolver.service';
import { VencimientoPedidosTarea } from '../pedidos-web/vencimiento-pedidos.tarea';
import { EstadoSistemaService } from '../estado-sistema/estado-sistema.service';
import { UsuarioLocalesController } from '../api/controllers/usuario-locales.controller';
import { EstadoSistemaController } from '../api/controllers/estado-sistema.controller';
import { RegistroModulo } from './registro-modulo';

/**
 * Fase 8 (stock confiable, pedidos web y estado del sistema; sql/fase21).
 *
 * Cadena de inyección (todo en AppModule vía REGISTROS, sin ciclos):
 * - ControlStockService ← ConfiguracionRepository (AppModule) + BitacoraService @Optional (REGISTRO_BITACORA).
 * - LocalesUsuarioRepository ← DataSource 'pgConnection'.
 * - LocalesUsuarioService ← LocalesUsuarioRepository, EsquemaCajaService (REGISTRO_CAJA), BitacoraService @Optional.
 * - CobrosPorDevolverService ← DataSource, ConfiguracionRepository @Optional, EnviadorCorreo @Optional
 *   (REGISTRO_CORREO), BitacoraService @Optional. No depende de clases de negocio.
 * - VencimientoPedidosTarea ← PedidoRepository y PedidoBussnies (AppModule), ControlStockService, BitacoraService @Optional.
 * - EstadoSistemaService ← EsquemaCajaService, DataSource.
 * Lo reciben con @Optional, en el último lugar del constructor: InventarioBussnies y VentaBussnies
 * (LocalesUsuarioService), AlmacenController (LocalesUsuarioService), RecepcionBussnies (ControlStockService,
 * BitacoraService), PagoBussnies y PedidoAdminController (CobrosPorDevolverService), ConfiguracionController
 * (ControlStockService). Los repositorios InventarioRepository y StockTiendaRepository reciben EsquemaCajaService
 * @Optional (rastro del movimiento).
 */
export const REGISTRO_STOCK_PEDIDOS: RegistroModulo = {
  entidades: [],
  controladores: [UsuarioLocalesController, EstadoSistemaController],
  proveedores: [
    ControlStockService,
    LocalesUsuarioRepository,
    LocalesUsuarioService,
    CobrosPorDevolverService,
    VencimientoPedidosTarea,
    EstadoSistemaService,
  ],
};
