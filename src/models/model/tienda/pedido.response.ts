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
  creado_en!: Date;
}
