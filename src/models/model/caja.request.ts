import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const MAX_MONTO_CAJA = 10_000_000;

/** POST /caja/abrir */
export class AbrirCajaRequest {
  @Type(() => Number)
  @IsInt({ message: 'Indique la caja a abrir (id_caja)' })
  @Min(1, { message: 'Indique la caja a abrir (id_caja)' })
  id_caja!: number;

  /**
   * Efectivo con el que arranca el turno. Si no viene, se guarda 0.00 explícito. La validación
   * (negativo, NaN, > 9 999 999.99) la hace la capa de negocio para responder con el código
   * estable CAJA_MONTO_INICIAL_INVALIDO en lugar del mensaje genérico de validación.
   */
  @IsOptional()
  @Type(() => Number)
  monto_inicial?: number | null;

  /** true = «Sin efectivo»: se guarda 0.00 y se ignora monto_inicial. */
  @IsOptional()
  @IsBoolean({ message: 'sin_efectivo debe ser verdadero o falso' })
  sin_efectivo?: boolean;
}

/** GET /caja/aperturas */
export class AperturasCajaQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'id_sucursal debe ser un entero' })
  @Min(1)
  id_sucursal?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'id_caja debe ser un entero' })
  @Min(1)
  id_caja?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'id_usuario debe ser un entero' })
  @Min(1)
  id_usuario?: number;

  /** AAAA-MM-DD (día de Lima); la valida la capa de negocio (código FECHA_INVALIDA). */
  @IsOptional()
  @IsString()
  desde?: string;

  @IsOptional()
  @IsString()
  hasta?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pagina debe ser un entero' })
  @Min(1)
  pagina?: number;

  /** 20 por defecto; la capa de negocio lo limita a 100. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'por_pagina debe ser un entero' })
  @Min(1)
  por_pagina?: number;
}

/** GET /caja/resumen-sucursales */
export class ResumenSucursalesQuery {
  @IsOptional()
  @IsString()
  desde?: string;

  @IsOptional()
  @IsString()
  hasta?: string;
}

/** GET /caja/resumen-sucursales/pdf */
export class ResumenSucursalesPdfQuery extends ResumenSucursalesQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'id_sucursal debe ser un entero' })
  @Min(1)
  id_sucursal?: number;
}

/** POST /caja/cerrar */
export class CerrarCajaRequest {
  /** Si se omite, se cierra la apertura abierta del usuario. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'id_apertura debe ser un entero' })
  @Min(1)
  id_apertura?: number;

  /** Efectivo contado al cerrar. Si se manda id_arqueo (o hay un arqueo de cierre), se toma de ahí. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'El monto contado debe ser un número' })
  @Min(0, { message: 'El monto contado no puede ser negativo' })
  @Max(MAX_MONTO_CAJA, { message: 'El monto contado es demasiado alto' })
  monto_conteo?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'La observación admite hasta 500 caracteres' })
  observacion?: string | null;

  /** Arqueo de tipo 'cierre' de esta apertura que respalda el cierre (opcional). */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'id_arqueo debe ser un entero' })
  @Min(1)
  id_arqueo?: number;
}

/** POST /caja/movimientos: ingreso o egreso de efectivo en el turno abierto. */
export class MovimientoCajaRequest {
  @IsIn(['ingreso', 'egreso'], { message: 'El tipo debe ser "ingreso" o "egreso"' })
  tipo!: 'ingreso' | 'egreso';

  @Type(() => Number)
  @IsNumber({}, { message: 'El monto debe ser un número' })
  @IsPositive({ message: 'El monto debe ser mayor a 0' })
  @Max(MAX_MONTO_CAJA, { message: 'El monto es demasiado alto' })
  monto!: number;

  @IsString({ message: 'Indique el motivo del movimiento' })
  @MinLength(3, { message: 'Indique el motivo del movimiento (mínimo 3 caracteres)' })
  @MaxLength(200, { message: 'El motivo admite hasta 200 caracteres' })
  descripcion!: string;

  /** Solo admin: turno abierto de otra caja. Por defecto, el turno abierto del usuario. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  id_apertura?: number;
}

/** POST /caja/cuentas-bancarias */
export class CuentaBancariaRequest {
  @IsString({ message: 'El banco es obligatorio' })
  @MaxLength(80, { message: 'El banco admite hasta 80 caracteres' })
  banco!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  alias?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  tipo_cuenta?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  numero_cuenta?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  cci?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  titular?: string;

  @IsOptional()
  @IsString()
  @MaxLength(3, { message: 'La moneda es un código de 3 letras (PEN, USD)' })
  moneda?: string;

  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @IsOptional()
  @IsBoolean()
  es_yape?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  orden?: number;
}

/** PUT /caja/cuentas-bancarias/:id (todo opcional: solo cambia lo que llega). */
export class ActualizarCuentaBancariaRequest {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  banco?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  alias?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  tipo_cuenta?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  numero_cuenta?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  cci?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  titular?: string;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  moneda?: string;

  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @IsOptional()
  @IsBoolean()
  es_yape?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  orden?: number;
}

/** POST /caja/yape/iniciar */
export class IniciarYapeRequest {
  @Type(() => Number)
  @IsNumber({}, { message: 'Monto inválido' })
  @IsPositive({ message: 'Monto inválido' })
  @Max(1_000_000, { message: 'Monto demasiado alto' })
  monto!: number;

  /** Correo del cliente para Culqi (si no es válido, Culqi usa el de caja). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  descripcion?: string;
}
