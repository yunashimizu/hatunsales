export class CarritoItemResponse {
  id_item!: number;
  id_producto!: number;
  nombre!: string;
  imagen!: string | null;
  marca?: string;
  cantidad!: number;
  precio_unitario!: number;
  subtotal!: number;
  stock_disponible!: number;
  excede_stock!: boolean;
}

export class CarritoResponse {
  id_carrito!: number;
  token_invitado?: string;
  items!: CarritoItemResponse[];
  cantidad_items!: number;
  subtotal!: number;
  igv!: number;
  total!: number;
}
