import { RegistroModulo } from '../../registro/registro-modulo';
import { CajaArqueo } from '../../models/DBModel/caja-arqueo.entity';
import { CajaArqueoDenominacion } from '../../models/DBModel/caja-arqueo-denominacion.entity';
import { CajaArqueoController } from '../../api/controllers/caja-arqueo.controller';
import { CajaArqueoRepository } from '../../repository/Repository/caja-arqueo.repository';
import { CajaArqueoBussnies } from '../../bussnies/Bussnies/caja-arqueo.bussnies';
import { EsquemaCajaService } from '../esquema/esquema-caja.service';
import { CreditoVencimientosTarea } from '../tareas/credito-vencimientos.tarea';

/**
 * Caja: arqueo de caja (parcial y de cierre), ingresos/egresos de efectivo, lectura única del
 * esquema de ventas/caja/crédito (sin DDL) y la tarea de vencimientos de crédito.
 * Venta, sesión de caja, crédito y cuentas bancarias siguen registrados en AppModule.
 */
export const REGISTRO_CAJA: RegistroModulo = {
  entidades: [CajaArqueo, CajaArqueoDenominacion],
  controladores: [CajaArqueoController],
  proveedores: [EsquemaCajaService, CajaArqueoRepository, CajaArqueoBussnies, CreditoVencimientosTarea],
};
