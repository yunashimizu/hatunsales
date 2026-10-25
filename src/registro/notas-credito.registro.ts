import { NotaCreditoController } from '../api/controllers/nota-credito.controller';
import { NotaCreditoBussnies } from '../bussnies/Bussnies/nota-credito.bussnies';
import { EfectosNotasTarea } from '../bussnies/tareas/efectos-notas.tarea';
import { NotaCreditoRepository } from '../repository/Repository/nota-credito.repository';
import { RegistroModulo } from './registro-modulo';

/**
 * Notas de crédito: negocio y rutas (/comprobante/:id/nota-credito), anulación de ventas y de
 * comprobantes con las ramas de D9 (VentaBussnies y ComprobanteBussnies delegan aquí) y los efectos al
 * aceptarse en SUNAT (oyente de envíos + barrido de cada 5 minutos).
 */
export const REGISTRO_NOTAS_CREDITO: RegistroModulo = {
  entidades: [],
  controladores: [NotaCreditoController],
  proveedores: [NotaCreditoRepository, NotaCreditoBussnies, EfectosNotasTarea],
};
