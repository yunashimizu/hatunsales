import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsString, IsOptional, IsNumber, IsBoolean, Matches, Min, Max, MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
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
const MSJ_CODIGO_SUNAT = 'El código de producto SUNAT debe tener exactamente 8 dígitos (catálogo 25, UNSPSC).';
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

  /** Código de producto SUNAT (catálogo 25, 8 dígitos). Vacío lo quita; sin el campo, no se toca. */
  @IsString()
  @IsOptional()
  @MaxLength(8, { message: MSJ_CODIGO_SUNAT })
  codigo_sunat?: string;

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

/**
 * Stock que se fija desde la ficha de edición, en el mismo PUT del producto. El servidor
 * calcula la diferencia y la aplica en la misma transacción solo si el stock real sigue
 * siendo `stock_anterior` (si no, 409 `STOCK_DESACTUALIZADO`).
 */
export class AjusteStockEdicionRequest {
  @IsInt()
  @Min(1)
  id_almacen!: number;

  @IsInt({ message: MSJ_STOCK_ENTERO })
  @Min(0, { message: 'El stock no puede ser negativo' })
  @Max(CANTIDAD_MAXIMA_OPERACION, {
    message: `El stock no puede superar ${CANTIDAD_MAXIMA_OPERACION.toLocaleString('en-US')} unidades`,
  })
  stock_nuevo!: number;

  @IsInt({ message: MSJ_STOCK_ENTERO })
  @Min(0, { message: 'El stock anterior no puede ser negativo' })
  stock_anterior!: number;
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

  /** Código de producto SUNAT (catálogo 25, 8 dígitos). Vacío lo quita; sin el campo, no se toca. */
  @IsString()
  @IsOptional()
  @MaxLength(8, { message: MSJ_CODIGO_SUNAT })
  codigo_sunat?: string;

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

  /** Opcional: fijar el stock de un almacén en la misma petición (y transacción) que la edición. */
  @IsOptional()
  @ValidateNested()
  @Type(() => AjusteStockEdicionRequest)
  ajuste_stock?: AjusteStockEdicionRequest;
}

/** Máximo de asignaciones por llamada a `PUT /producto/codigo-sunat`. */
export const MAX_ASIGNACIONES_CODIGO_SUNAT = 500;

export class AsignacionCodigoSunat {
  @IsInt()
  @Min(1)
  id_producto!: number;

  @IsString()
  @Matches(/^\d{8}$/, { message: MSJ_CODIGO_SUNAT })
  codigo_sunat!: string;
}

/** Carga masiva del código SUNAT desde la tarjeta «Productos sin código». */
export class AsignarCodigosSunatRequest {
  @IsArray()
  @ArrayMinSize(1, { message: 'Envíe al menos una asignación' })
  @ArrayMaxSize(MAX_ASIGNACIONES_CODIGO_SUNAT, {
    message: `Máximo ${MAX_ASIGNACIONES_CODIGO_SUNAT} asignaciones por envío`,
  })
  @ValidateNested({ each: true })
  @Type(() => AsignacionCodigoSunat)
  asignaciones!: AsignacionCodigoSunat[];
}
