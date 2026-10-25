import {
  GenerarComprobanteRequest,
  ConsultarComprobanteRequest,
  AnularComprobanteRequest,
} from '../../models/model/c-electronico/comprobante.request';
import { ComprobanteResponse, AnulacionResponse } from '../../models/model/c-electronico/comprobante.response';

export interface IComprobanteBussniees {
  /** Emite factura o boleta en el ambiente vigente; `idUsuario` queda en el comprobante y en su envío. */
  generar(dto: GenerarComprobanteRequest, idUsuario?: number | null): Promise<ComprobanteResponse>;
  consultar(dto: ConsultarComprobanteRequest): Promise<ComprobanteResponse>;
  anular(dto: AnularComprobanteRequest): Promise<AnulacionResponse>;
  consultarAnulacion(dto: ConsultarComprobanteRequest): Promise<AnulacionResponse>;
  listarPorVenta(id_venta: number): Promise<ComprobanteResponse[]>;
}
