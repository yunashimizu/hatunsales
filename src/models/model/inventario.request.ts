import { IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

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
  @IsNumber()
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

  @IsNumber()
  @Min(0.0001)
  cantidad!: number;

  @IsString()
  @IsOptional()
  @MaxLength(250)
  comentario?: string;
}
