import { IsInt, IsString, IsOptional, IsNumber, IsBoolean, Min, Max, MaxLength } from 'class-validator';
import { CANTIDAD_MAXIMA_OPERACION } from './inventario.request';

/*
 * Topes alineados con las columnas reales de `productos` en PostgreSQL:
 * nombre VARCHAR(150), precio_compra / precio_venta NUMERIC(10,2) y
 * descuento NUMERIC(5,2). Pasarlos devolvía un 500 de la base de datos;
 * con estos límites el usuario recibe un 400 con el motivo.
 */
const LARGO_NOMBRE = 150;
const PRECIO_MAXIMO = 99_999_999.99;
const DESCUENTO_MAXIMO = 999.99;

const MSJ_NOMBRE = `El nombre admite hasta ${LARGO_NOMBRE} caracteres`;
const MSJ_PRECIO = 'El precio no puede superar S/ 99,999,999.99';
const MSJ_DESCUENTO = 'El descuento por unidad no puede superar S/ 999.99';
const MSJ_STOCK_ENTERO = 'El stock debe ser un número entero de unidades (sin decimales)';
const MSJ_STOCK_MAXIMO = `El stock inicial no puede superar ${CANTIDAD_MAXIMA_OPERACION.toLocaleString('en-US')} unidades`;

export class CrearProductoRequest {
  @IsString()
  @MaxLength(LARGO_NOMBRE, { message: MSJ_NOMBRE })
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
  @Max(PRECIO_MAXIMO, { message: MSJ_PRECIO })
  precio_compra?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(PRECIO_MAXIMO, { message: MSJ_PRECIO })
  precio_venta?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(DESCUENTO_MAXIMO, { message: MSJ_DESCUENTO })
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

  /** Cantidad inicial. Se guarda en `inventario` (y en el kardex), no en `productos`. */
  @IsInt({ message: MSJ_STOCK_ENTERO })
  @IsOptional()
  @Min(0, { message: 'El stock inicial no puede ser negativo' })
  @Max(CANTIDAD_MAXIMA_OPERACION, { message: MSJ_STOCK_MAXIMO })
  stock?: number;

  /** Almacén donde entra el stock inicial. Sin él, el primero por nombre. */
  @IsInt()
  @IsOptional()
  id_almacen?: number;
}

export class ActualizarProductoRequest {
  @IsString()
  @IsOptional()
  @MaxLength(LARGO_NOMBRE, { message: MSJ_NOMBRE })
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
  @Max(PRECIO_MAXIMO, { message: MSJ_PRECIO })
  precio_compra?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(PRECIO_MAXIMO, { message: MSJ_PRECIO })
  precio_venta?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(DESCUENTO_MAXIMO, { message: MSJ_DESCUENTO })
  descuento?: number;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  unidad_medida?: string;

  /** null quita la categoría; sin el campo, no se toca. */
  @IsInt()
  @IsOptional()
  id_categoria?: number | null;

  /** null quita la marca; sin el campo, no se toca. */
  @IsInt()
  @IsOptional()
  id_marca?: number | null;

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
