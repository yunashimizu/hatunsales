export class PedidoItemResponse {
  id_pedido_item!: number;
  id_producto?: number;
  nombre!: string;
  imagen?: string;
  cantidad!: number;
  precio_unitario!: number;
  subtotal!: number;
  igv!: number;
  total!: number;
}

export class PedidoEstadoResponse {
  estado!: string;
  comentario?: string;
  fecha!: Date;
}

/** Comprobante del pedido (boleta o factura) tal como lo ve el panel o el comprador. */
export class PedidoComprobanteResponse {
  estado!: 'aceptado' | 'en_proceso' | 'requiere_revision' | 'rechazado' | 'anulado' | 'sin_comprobante';
  id_comprobante?: number;
  numero_formateado?: string;
  tipo?: 'boleta' | 'factura';
  estado_sunat?: string;
  puede_descargar!: boolean;
  /** Solo para el personal. */
  motivo?: string;
}

export class PedidoResponse {
  id_pedido!: number;
  codigo!: string;
  estado!: string;
  subtotal!: number;
  igv!: number;
  descuento!: number;
  costo_envio!: number;
  total!: number;
  tipo_comprobante?: string;
  documento_receptor?: string;
  nombre_receptor?: string;
  notas?: string;
  metodo_envio?: string;
  metodo_pago?: string;
  direccion_envio?: string;
  cantidad_items!: number;
  items!: PedidoItemResponse[];
  historial!: PedidoEstadoResponse[];
  /** Solo en el detalle de un pedido (no en listados). */
  comprobante?: PedidoComprobanteResponse;
  creado_en!: Date;
}
