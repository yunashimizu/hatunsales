import { ComprobanteResponse } from '../c-electronico/comprobante.response';

export interface ProductoVentaResponse {
  id_producto: number;
  nombre: string;
  sku: string;
  codigo_barras: string;
  unidad_medida: string;
  precio_venta: number;
  descuento: number;
  /** Precio final con IGV ya aplicado el descuento del producto. */
  precio_final: number;
  stock_disponible: number;
  imagen_url: string;
}

export interface ItemVentaResponse {
  id_producto: number;
  descripcion: string;
  cantidad: number;
  precio_unitario: number;
  descuento: number;
  subtotal: number;
  igv: number;
  total: number;
}

export interface VentaResponse {
  id_venta: number;
  fecha: Date;
  origen: string;
  id_cliente?: number;
  id_empresa?: number;
  cliente_denominacion: string;
  subtotal: number;
  igv: number;
  descuento: number;
  total: number;
  items: ItemVentaResponse[];
  pagos: { id_metodo?: number; metodo?: string; monto: number; referencia?: string }[];
  /** Presente cuando la venta ya generó su documento electrónico. */
  comprobante?: ComprobanteResponse;
  /** Motivo por el que el comprobante no pudo emitirse, para reintentarlo. */
  comprobante_error?: string;
}

export interface VentaListadoResponse {
  id_venta: number;
  fecha: Date;
  origen: string;
  id_cliente?: number;
  id_empresa?: number;
  cliente_denominacion: string;
  total: number;
  cantidad_items: number;
  comprobante?: string;
  comprobante_estado?: string;
  id_comprobante?: number;
}
