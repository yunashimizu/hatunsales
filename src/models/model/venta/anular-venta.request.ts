import { IsBoolean, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

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

  /**
   * true = anular dando de baja el comprobante en SUNAT (comunicación de baja o resumen diario), sin nota
   * de crédito; solo hasta 7 días después de emitido y con un único comprobante aceptado.
   */
  @IsOptional()
  @IsBoolean({ message: 'sin_nota debe ser verdadero o falso' })
  sin_nota?: boolean;

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

  /**
   * Fase 7.1: efectivo que el cajero confirma haber devuelto al cliente. Solo genera egreso si la venta es de
   * un turno ya cerrado (o sin turno); si es de un turno abierto la anulación ya la descuenta del esperado.
   * Sin este campo la anulación funciona exactamente como antes. Ver GET caja/devolucion/:id_venta.
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'El reembolso en efectivo debe ser un número con hasta 2 decimales' })
  @Min(0, { message: 'El reembolso en efectivo no puede ser negativo' })
  @Max(10_000_000, { message: 'El reembolso en efectivo es demasiado alto' })
  reembolso_efectivo?: number;
}
