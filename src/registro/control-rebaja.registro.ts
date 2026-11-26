import { ControlRebajaService } from '../control-rebaja/control-rebaja.service';
import { RegistroModulo } from './registro-modulo';

/**
 * Control de rebajas del POS (Fase 6.4): configuración, verificación del administrador y permisos de
 * autorización. ControlRebajaService usa ConfiguracionRepository (AppModule), el DataSource
 * 'pgConnection' y BitacoraService (REGISTRO_BITACORA, @Optional). Lo usan VentaBussnies y
 * ConfiguracionController, ambos como dependencia @Optional. Sin controladores propios: las rutas viven
 * en VentaController (`POST venta/autorizacion`) y ConfiguracionController (`configuracion/control-rebaja`).
 */
export const REGISTRO_CONTROL_REBAJA: RegistroModulo = {
  entidades: [],
  controladores: [],
  proveedores: [ControlRebajaService],
};
