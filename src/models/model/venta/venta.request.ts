import {
  IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional,
  IsString, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ItemVentaRequest {

  @IsInt()
  id_producto!: number;

  @IsNumber()
  @Min(0.0001)
  cantidad!: number;

  /**
   * Precio con IGV pactado en el mostrador. Si se omite se toma el precio de
   * venta del producto, que es lo habitual.
   */
  @IsNumber()
  @IsOptional()
  precio_unitario?: number;

  /** Descuento de la línea en soles. */
  @IsNumber()
  @IsOptional()
  descuento?: number;

  @IsInt()
  @IsOptional()
  tipo_de_igv?: number;
}

export class PagoVentaRequest {

  @IsInt()
  @IsOptional()
  id_metodo?: number;

  @IsNumber()
  @Min(0)
  monto!: number;

  /** Número de operación, últimos dígitos de la tarjeta, etc. */
  @IsString()
  @IsOptional()
  @MaxLength(120)
  referencia?: string;
}

export class CrearVentaRequest {

  // ── Receptor ──────────────────────────────────────────────────
  @IsString()
  @IsOptional()
  documento?: string;

  @IsInt()
  @IsOptional()
  id_cliente?: number;

  @IsInt()
  @IsOptional()
  id_empresa?: number;

  // ── Comprobante ───────────────────────────────────────────────
  @IsInt()
  @IsIn([1, 2, 7, 8], { message: '1=Factura 2=Boleta 7=Nota de crédito 8=Nota de débito' })
  id_tipo!: number;

  @IsString()
  @IsOptional()
  serie?: string;

  @IsInt()
  @IsOptional()
  id_moneda?: number;

  /** Cuando es falso la venta queda registrada sin comprobante electrónico. */
  @IsBoolean()
  @IsOptional()
  emitir_comprobante?: boolean;

  @IsBoolean()
  @IsOptional()
  enviar_cliente?: boolean;

  // ── Operación ─────────────────────────────────────────────────
  @IsInt()
  @IsOptional()
  id_almacen?: number;

  @IsInt()
  @IsOptional()
  id_caja?: number;

  @IsBoolean()
  @IsOptional()
  descontar_stock?: boolean;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  observaciones?: string;

  /**
   * Identificador del intento enviado por el frontend. Evita que un doble clic
   * o un reintento por conexión lenta registre la misma venta dos veces.
   */
  @IsString()
  @IsOptional()
  @MaxLength(80)
  clave_idempotencia?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ItemVentaRequest)
  items!: ItemVentaRequest[];

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PagoVentaRequest)
  pagos?: PagoVentaRequest[];
}
