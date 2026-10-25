import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AnularComprobanteRequest } from './comprobante.request';

/** Ítem del comprobante origen que se acredita (motivo 07) o se descuenta (motivo 05). */
export class ItemNotaCreditoRequest {

  /** comprobante_items.id_item del comprobante origen. */
  @IsInt({ message: 'id_item debe ser un número entero' })
  @Min(1, { message: 'id_item debe ser mayor que cero' })
  id_item!: number;

  /** Motivo 07: unidades que se devuelven (no más de las disponibles). */
  @IsOptional()
  @IsNumber({}, { message: 'La cantidad debe ser un número' })
  @Min(0.01, { message: 'La cantidad debe ser mayor que cero' })
  cantidad?: number;

  /** Motivo 05: descuento de la línea en soles, con IGV (no más que el importe disponible de la línea). */
  @IsOptional()
  @IsNumber({}, { message: 'El descuento debe ser un número' })
  @Min(0.01, { message: 'El descuento debe ser mayor que cero' })
  descuento?: number;
}

/** POST /comprobante/:id/nota-credito: qué se acredita y por qué (PLAN V3, D8). */
export class EmitirNotaCreditoRequest {

  /** Catálogo 09 de SUNAT: 01, 02, 05, 06, 07, 09 o 10 según el tipo del comprobante origen. */
  @IsString({ message: 'Indique el motivo de la nota de crédito' })
  @Matches(/^\d{2}$/, { message: 'El motivo debe ser un código de dos dígitos del catálogo 09 de SUNAT' })
  motivo!: string;

  /** Sustento que viaja en el XML. */
  @IsString({ message: 'Indique el sustento de la nota de crédito' })
  @MinLength(3, { message: 'El sustento debe tener al menos 3 caracteres' })
  @MaxLength(250, { message: 'El sustento admite hasta 250 caracteres' })
  sustento!: string;

  /** Motivos 07 (cantidad) y 05 (descuento). */
  @IsOptional()
  @IsArray({ message: 'items debe ser una lista' })
  @ArrayMaxSize(200, { message: 'La nota admite hasta 200 ítems' })
  @ValidateNested({ each: true })
  @Type(() => ItemNotaCreditoRequest)
  items?: ItemNotaCreditoRequest[];

  /** Motivos 09 y 10: importe con IGV que se acredita (no más que el saldo del comprobante). */
  @IsOptional()
  @IsNumber({}, { message: 'El monto debe ser un número' })
  @Min(0.01, { message: 'El monto debe ser mayor que cero' })
  monto?: number;

  /** Motivos con devolución (01, 06 y 07): si al aceptarse la nota lo devuelto vuelve al almacén. Por defecto sí. */
  @IsOptional()
  @IsBoolean({ message: 'reingresar_stock debe ser verdadero o falso' })
  reingresar_stock?: boolean;
}

/**
 * POST /comprobante/anular: el cuerpo de siempre más la verificación de D9 para un envío que quedó
 * sin confirmar (el administrador revisó el comprobante en SUNAT Operaciones en Línea).
 */
export class AnularDocumentoRequest extends AnularComprobanteRequest {

  /** true = el administrador verificó el comprobante en SUNAT Operaciones en Línea (queda auditado). */
  @IsOptional()
  @IsBoolean({ message: 'confirmar_verificado_sol debe ser verdadero o falso' })
  confirmar_verificado_sol?: boolean;

  /** Con confirmar_verificado_sol: true si SUNAT lo tiene (se confirma y se anula con nota), false si no existe allí. */
  @IsOptional()
  @IsBoolean({ message: 'existe_en_sunat debe ser verdadero o falso' })
  existe_en_sunat?: boolean;

  /** Qué verificó y dónde (obligatoria con confirmar_verificado_sol). */
  @IsOptional()
  @IsString({ message: 'La nota debe ser texto' })
  @MaxLength(300, { message: 'La nota admite hasta 300 caracteres' })
  nota?: string;
}
