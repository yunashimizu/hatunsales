export class ProductoTiendaResponse {
  id_producto!: number;
  nombre!: string;
  slug?: string;
  descripcion?: string;
  descripcion_corta?: string;
  sku?: string;
  codigo_barras?: string;
  precio!: number;
  precio_final!: number;
  descuento!: number;
  unidad_medida?: string;
  destacado!: boolean;
  id_categoria?: number;
  categoria?: string;
  id_marca?: number;
  marca?: string;
  stock!: number;
  disponible!: boolean;
  rating!: number;
  total_resenas!: number;
  imagen!: string | null;
}

export class ProductoDetalleResponse extends ProductoTiendaResponse {
  imagenes!: ImagenResponse[];
  especificaciones!: EspecificacionResponse[];
  stock_sucursales!: StockSucursalResponse[];
  relacionados!: ProductoTiendaResponse[];
}

export class ImagenResponse {
  id_imagen!: number;
  url!: string;
  thumb_url?: string;
  is_primary!: boolean;
}

export class EspecificacionResponse {
  nombre!: string;
  valor!: string;
}

export class StockSucursalResponse {
  id_sucursal!: number;
  sucursal!: string;
  direccion?: string;
  stock!: number;
}

export class CategoriaTiendaResponse {
  id_categoria!: number;
  nombre!: string;
  slug?: string;
  descripcion?: string;
  icono?: string;
  imagen_url?: string;
  total_productos!: number;
}

export class MarcaTiendaResponse {
  id_marca!: number;
  nombre!: string;
  slug?: string;
  logo_url?: string;
  total_productos!: number;
}

export class FiltroValorResponse {
  valor!: string;
  total!: number;
}

export class FiltrosDisponiblesResponse {
  categorias!: CategoriaTiendaResponse[];
  marcas!: MarcaTiendaResponse[];
  precio_min!: number;
  precio_max!: number;
  atributos!: { nombre: string; valores: FiltroValorResponse[] }[];
}

export class PaginaResponse<T> {
  items!: T[];
  total!: number;
  pagina!: number;
  limite!: number;
  total_paginas!: number;
}
