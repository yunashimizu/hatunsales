import {
  GenerarComprobanteRequest,
  ConsultarComprobanteRequest,
  AnularComprobanteRequest,
} from '../../models/model/c-electronico/comprobante.request';
import { ComprobanteResponse, AnulacionResponse } from '../../models/model/c-electronico/comprobante.response';

export interface IComprobanteBussniees {
  generar(dto: GenerarComprobanteRequest): Promise<ComprobanteResponse>;
  consultar(dto: ConsultarComprobanteRequest): Promise<ComprobanteResponse>;
  anular(dto: AnularComprobanteRequest): Promise<AnulacionResponse>;
  consultarAnulacion(dto: ConsultarComprobanteRequest): Promise<AnulacionResponse>;
  listarPorVenta(id_venta: number): Promise<ComprobanteResponse[]>;
}