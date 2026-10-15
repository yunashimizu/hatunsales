import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_CANTIDAD_POR_DENOMINACION } from '../../caja/dominio/denominaciones';

const MAX_MONTO = 10_000_000;

/** Cantidad contada de un billete o moneda. El subtotal lo calcula el servidor. */
export class DenominacionArqueoRequest {
  /** Opcional: se deduce del valor (200…10 billete, 5…0.10 moneda). */
  @IsOptional()
  @IsIn(['billete', 'moneda'], { message: 'tipo debe ser "billete" o "moneda"' })
  tipo?: 'billete' | 'moneda';

  /** Valor en soles: 200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1 */
  @Type(() => Number)
  @IsNumber({}, { message: 'La denominación debe ser un número (por ejemplo 50 o 0.5)' })
  @IsPositive({ message: 'La denominación debe ser mayor a 0' })
  denominacion!: number;

  @Type(() => Number)
  @IsInt({ message: 'La cantidad de billetes o monedas debe ser un entero' })
  @Min(0, { message: 'La cantidad no puede ser negativa' })
  @Max(MAX_CANTIDAD_POR_DENOMINACION, { message: 'La cantidad por denominación es demasiado alta' })
  cantidad!: number;
}

/** Total que el cajero leyó en Yape, Plin, el POS de tarjetas o el banco. */
export class MedioDeclaradoRequest {
  @Type(() => Number)
  @IsInt({ message: 'id_metodo debe ser un entero' })
  @Min(1)
  id_metodo!: number;

  @Type(() => Number)
  @IsNumber({}, { message: 'El monto declarado debe ser un número' })
  @Min(0, { message: 'El monto declarado no puede ser negativo' })
  @Max(MAX_MONTO, { message: 'El monto declarado es demasiado alto' })
  declarado!: number;
}

/** POST /caja/arqueo */
export class RegistrarArqueoRequest {
  /** Por defecto, el turno abierto del usuario. Un admin puede indicar otro turno abierto. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'id_apertura debe ser un entero' })
  @Min(1)
  id_apertura?: number;

  @IsIn(['parcial', 'cierre'], { message: 'tipo debe ser "parcial" o "cierre"' })
  tipo!: 'parcial' | 'cierre';

  /** Conteo por denominación (recomendado). Las que no se cuentan pueden omitirse. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(11, { message: 'Hay 11 denominaciones de soles como máximo' })
  @ValidateNested({ each: true })
  @Type(() => DenominacionArqueoRequest)
  denominaciones?: DenominacionArqueoRequest[];

  /**
   * Solo si no se cuenta por denominación: total de efectivo contado. Si también llegan
   * denominaciones, debe coincidir con su suma.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'El efectivo contado debe ser un número' })
  @Min(0, { message: 'El efectivo contado no puede ser negativo' })
  @Max(MAX_MONTO, { message: 'El efectivo contado es demasiado alto' })
  efectivo_contado?: number;

  /** Totales declarados de los medios que no son efectivo (opcional, uno por medio). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => MedioDeclaradoRequest)
  medios?: MedioDeclaradoRequest[];

  /** Obligatoria (mínimo 5 caracteres) si hay faltante o sobrante. */
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'La observación admite hasta 500 caracteres' })
  observacion?: string;

  /** Evita registrar dos veces el mismo arqueo por doble clic o reintento. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[\x21-\x7E]+$/, { message: 'clave_idempotencia solo admite caracteres visibles sin espacios' })
  clave_idempotencia?: string;
}

/** ?id_apertura= de GET /caja/arqueo/esperado, GET /caja/arqueo y GET /caja/movimientos */
export class TurnoQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'id_apertura debe ser un entero' })
  @Min(1)
  id_apertura?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limite?: number;
}

/** ?formato= de GET /caja/arqueo/:id/pdf */
export class PdfArqueoQuery {
  @IsOptional()
  @IsIn(['ticket', 'a4'], { message: 'formato debe ser "ticket" o "a4"' })
  formato?: 'ticket' | 'a4';
}
