import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Tope de unidades por operación (alta, ajuste o transferencia). El stock se
 * guarda como integer en PostgreSQL (máx. 2 147 483 647); cien millones deja
 * margen y frena errores de tipeo como un código de barras pegado en la cantidad.
 */
export const CANTIDAD_MAXIMA_OPERACION = 100_000_000;

const MENSAJE_ENTERO = 'La cantidad debe ser un número entero de unidades (sin decimales)';
const MENSAJE_MAXIMO = `La cantidad no puede superar ${CANTIDAD_MAXIMA_OPERACION.toLocaleString('en-US')} unidades por operación`;

export class ActualizarInventarioRequest {
  @IsInt()
  id_producto!: number;

  /** Almacén sobre el que se aplica. Sin él se usa el primero del producto. */
  @IsInt()
  @IsOptional()
  id_almacen?: number;

  @IsNumber()
  @IsOptional()
  stock?: number;

  @IsNumber()
  @IsOptional()
  stock_minimo?: number;
}

/**
 * Corrección de stock con justificación. A diferencia de fijar el número a
 * mano, deja rastro en el kardex de por qué cambió.
 */
export class AjustarStockRequest {
  @IsInt()
  id_producto!: number;

  @IsInt()
  id_almacen!: number;

  /** Positiva para ingresar unidades, negativa para retirarlas. */
  @IsInt({ message: MENSAJE_ENTERO })
  @Min(-CANTIDAD_MAXIMA_OPERACION, { message: MENSAJE_MAXIMO })
  @Max(CANTIDAD_MAXIMA_OPERACION, { message: MENSAJE_MAXIMO })
  cantidad!: number;

  @IsString()
  @IsIn(['compra', 'devolucion', 'merma', 'robo', 'correccion', 'conteo_fisico', 'otro'])
  motivo!: string;

  @IsString()
  @IsOptional()
  @MaxLength(250)
  comentario?: string;
}

export class TransferirStockRequest {
  @IsInt()
  id_producto!: number;

  @IsInt()
  id_almacen_origen!: number;

  @IsInt()
  id_almacen_destino!: number;

  @IsInt({ message: MENSAJE_ENTERO })
  @Min(1, { message: 'Indique al menos 1 unidad para transferir' })
  @Max(CANTIDAD_MAXIMA_OPERACION, { message: MENSAJE_MAXIMO })
  cantidad!: number;

  @IsString()
  @IsOptional()
  @MaxLength(250)
  comentario?: string;
}
