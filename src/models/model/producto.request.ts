import { IsInt, IsString, IsOptional, IsNumber, IsBoolean, Min, MaxLength } from 'class-validator';

export class CrearProductoRequest {
  @IsString()
  @MaxLength(200)
  nombre!: string;

  @IsString()
  @IsOptional()
  descripcion?: string;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  descripcion_corta?: string;

  @IsString()
  @IsOptional()
  @MaxLength(60)
  codigo_barras?: string;

  @IsString()
  @IsOptional()
  @MaxLength(60)
  sku?: string;

  @IsNumber()
  @IsOptional()
  @Min(0)
  precio_compra?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  precio_venta?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  descuento?: number;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  unidad_medida?: string;

  @IsInt()
  @IsOptional()
  id_categoria?: number;

  @IsInt()
  @IsOptional()
  id_marca?: number;

  @IsBoolean()
  @IsOptional()
  estado?: boolean;

  @IsBoolean()
  @IsOptional()
  destacado?: boolean;

  @IsInt()
  @IsOptional()
  id_proveedor?: number;
}

export class ActualizarProductoRequest {
  @IsString()
  @IsOptional()
  @MaxLength(200)
  nombre?: string;

  @IsString()
  @IsOptional()
  descripcion?: string;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  descripcion_corta?: string;

  @IsString()
  @IsOptional()
  @MaxLength(60)
  codigo_barras?: string;

  @IsString()
  @IsOptional()
  @MaxLength(60)
  sku?: string;

  @IsNumber()
  @IsOptional()
  @Min(0)
  precio_compra?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  precio_venta?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  descuento?: number;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  unidad_medida?: string;

  @IsInt()
  @IsOptional()
  id_categoria?: number;

  @IsInt()
  @IsOptional()
  id_marca?: number;

  @IsBoolean()
  @IsOptional()
  estado?: boolean;

  @IsBoolean()
  @IsOptional()
  destacado?: boolean;

  @IsInt()
  @IsOptional()
  id_proveedor?: number;
}
