import { IsInt, IsString, IsOptional, IsNumber, Min } from 'class-validator';

export class CrearProductoRequest {
  @IsString()
  nombre!: string;

  @IsString()
  @IsOptional()
  descripcion?: string;

  @IsString()
  @IsOptional()
  codigo_barras?: string;

  @IsNumber()
  @IsOptional()
  precio_compra?: number;

  @IsNumber()
  @IsOptional()
  precio_venta?: number;

  @IsString()
  @IsOptional()
  unidad_medida?: string;

  @IsInt()
  @IsOptional()
  id_proveedor?: number;
}

export class ActualizarProductoRequest {
  @IsString()
  @IsOptional()
  nombre?: string;

  @IsString()
  @IsOptional()
  descripcion?: string;

  @IsString()
  @IsOptional()
  codigo_barras?: string;

  @IsNumber()
  @IsOptional()
  precio_compra?: number;

  @IsNumber()
  @IsOptional()
  precio_venta?: number;

  @IsString()
  @IsOptional()
  unidad_medida?: string;

  @IsInt()
  @IsOptional()
  id_proveedor?: number;
}
