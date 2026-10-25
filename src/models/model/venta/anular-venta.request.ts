import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * POST /venta/:id/anular (PLAN V3, D9). Si el comprobante de la venta ya fue aceptado por SUNAT se
 * anula con una nota de crédito; si su envío quedó sin confirmar, el administrador lo verifica en SUNAT
 * Operaciones en Línea y vuelve a pedir la anulación indicando qué encontró.
 */
export class AnularVentaRequest {

  /** Motivo de la anulación: va como sustento de la nota de crédito y en el comprobante anulado. */
  @IsOptional()
  @IsString({ message: 'El motivo debe ser texto' })
  @MaxLength(250, { message: 'El motivo admite hasta 250 caracteres' })
  motivo?: string;

  /** true = el administrador verificó el comprobante en SUNAT Operaciones en Línea (queda auditado). */
  @IsOptional()
  @IsBoolean({ message: 'confirmar_verificado_sol debe ser verdadero o falso' })
  confirmar_verificado_sol?: boolean;

  /** Con confirmar_verificado_sol: true si SUNAT tiene el comprobante, false si no existe allí. */
  @IsOptional()
  @IsBoolean({ message: 'existe_en_sunat debe ser verdadero o falso' })
  existe_en_sunat?: boolean;

  /** Qué verificó y dónde (obligatoria con confirmar_verificado_sol). */
  @IsOptional()
  @IsString({ message: 'La nota debe ser texto' })
  @MaxLength(300, { message: 'La nota admite hasta 300 caracteres' })
  nota?: string;
}
