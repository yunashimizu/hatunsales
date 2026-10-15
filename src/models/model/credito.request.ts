import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength, Min } from 'class-validator';

/** POST /credito/cuentas/:id/abonos */
export class AbonoCreditoRequest {
  @Type(() => Number)
  @IsNumber({}, { message: 'El monto del abono debe ser un número' })
  @IsPositive({ message: 'El abono debe ser mayor a 0' })
  @Max(10_000_000, { message: 'El abono no puede superar S/ 10,000,000' })
  monto!: number;

  /** Medio con el que pagó el cliente (efectivo, Yape…). Opcional por compatibilidad. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'id_metodo debe ser un entero' })
  @Min(1)
  id_metodo?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120, { message: 'La referencia admite hasta 120 caracteres' })
  referencia?: string;
}

/** PUT /credito/cliente/:id y PUT /credito/empresa/:id */
export class LineaCreditoRequest {
  @IsOptional()
  @IsBoolean({ message: 'credito_activo debe ser verdadero o falso' })
  credito_activo?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'El límite de crédito debe ser un número' })
  @Min(0, { message: 'El límite de crédito no puede ser negativo' })
  @Max(100_000_000, { message: 'El límite de crédito no puede superar S/ 100,000,000' })
  limite_credito?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Los días de crédito deben ser un entero' })
  @Min(0, { message: 'Los días de crédito van de 0 a 365' })
  @Max(365, { message: 'Los días de crédito van de 0 a 365' })
  dias_credito?: number;
}
