import {
  IsInt, IsString, IsOptional, IsBoolean,
  IsNumber, IsArray, ValidateNested, IsIn, Min, MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ItemComprobanteRequest {

  @IsInt()
  @IsOptional()
  id_producto?: number;

  @IsString()
  @IsOptional()
  unidad_de_medida?: string;

  @IsString()
  @IsOptional()
  codigo?: string;

  @IsString()
  @IsOptional()
  codigo_producto_sunat?: string;

  @IsString()
  descripcion!: string;

  @IsNumber()
  @Min(0.0001)
  cantidad!: number;

  /**
   * Precio unitario CON IGV, tal como se le cobra al cliente. Es el campo que
   * debe enviar el frontend, porque `productos.precio_venta` ya incluye IGV.
   */
  @IsNumber()
  @IsOptional()
  precio_unitario?: number;

  /** Alternativa al anterior: valor unitario SIN IGV. */
  @IsNumber()
  @IsOptional()
  valor_unitario?: number;

  /** Descuento de la línea en soles, con IGV incluido. */
  @IsNumber()
  @IsOptional()
  descuento?: number;

  /** Catálogo 07: 1 gravado, 8 exonerado, 9 inafecto. */
  @IsInt()
  @IsOptional()
  tipo_de_igv?: number;

  // Los importes de abajo los calcula el backend. Se aceptan por compatibilidad
  // pero se recalculan siempre, porque enviarlos desde el cliente es lo que
  // hacía que la suma de las líneas no coincidiera con los totales.
  @IsNumber()
  @IsOptional()
  subtotal?: number;

  @IsNumber()
  @IsOptional()
  igv?: number;

  @IsNumber()
  @IsOptional()
  total?: number;
}

export class GenerarComprobanteRequest {

  @IsInt()
  @IsOptional()
  id_venta?: number;

  // ── Receptor: basta con uno de estos ──────────────────────────
  @IsInt()
  @IsOptional()
  id_cliente?: number;

  @IsInt()
  @IsOptional()
  id_empresa?: number;

  /** DNI de 8 dígitos. Si no está en la base se consulta el servicio externo. */
  @IsString()
  @IsOptional()
  dni?: string;

  /** RUC de 11 dígitos. Si no está en la base se consulta el servicio externo. */
  @IsString()
  @IsOptional()
  ruc?: string;

  /** Documento sin distinguir tipo: el backend deduce si es DNI o RUC. */
  @IsString()
  @IsOptional()
  documento?: string;

  // ── Datos del comprobante ─────────────────────────────────────
  @IsInt()
  @IsIn([1, 2, 7, 8], { message: '1=Factura 2=Boleta 7=Nota de crédito 8=Nota de débito' })
  id_tipo!: number;

  @IsInt()
  @IsOptional()
  id_moneda?: number;

  @IsString()
  @IsOptional()
  serie?: string;

  /** Si se omite, se toma el siguiente correlativo de la serie. */
  @IsInt()
  @IsOptional()
  numero?: number;

  // ── Se completan solos a partir del receptor ──────────────────
  @IsInt()
  @IsOptional()
  cliente_tipo_doc?: number;

  @IsString()
  @IsOptional()
  cliente_numero_doc?: string;

  @IsString()
  @IsOptional()
  cliente_denominacion?: string;

  @IsString()
  @IsOptional()
  cliente_direccion?: string;

  @IsString()
  @IsOptional()
  cliente_email?: string;

  @IsString()
  @IsOptional()
  fecha_de_emision?: string;

  @IsString()
  @IsOptional()
  fecha_de_vencimiento?: string;

  /** Descuento aplicado al comprobante completo, en soles y con IGV. */
  @IsNumber()
  @IsOptional()
  descuento_global?: number;

  // Los totales se calculan en el backend. Se aceptan por compatibilidad.
  @IsNumber()
  @IsOptional()
  total_gravada?: number;

  @IsNumber()
  @IsOptional()
  total_igv?: number;

  @IsNumber()
  @IsOptional()
  total?: number;

  // ── Notas de crédito y débito ─────────────────────────────────
  @IsString()
  @IsOptional()
  tipo_de_nota_de_credito?: string;

  @IsString()
  @IsOptional()
  tipo_de_nota_de_debito?: string;

  @IsString()
  @IsOptional()
  documento_que_se_modifica_tipo?: string;

  @IsString()
  @IsOptional()
  documento_que_se_modifica_serie?: string;

  @IsString()
  @IsOptional()
  documento_que_se_modifica_numero?: string;

  // ── Extras ────────────────────────────────────────────────────
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  observaciones?: string;

  @IsString()
  @IsOptional()
  medio_de_pago?: string;

  @IsString()
  @IsOptional()
  condiciones_de_pago?: string;

  @IsString()
  @IsOptional()
  orden_compra_servicio?: string;

  @IsBoolean()
  @IsOptional()
  enviar_sunat?: boolean;

  @IsBoolean()
  @IsOptional()
  enviar_cliente?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ItemComprobanteRequest)
  items!: ItemComprobanteRequest[];
}

export class ConsultarComprobanteRequest {

  @IsInt()
  @IsIn([1, 2, 7, 8], { message: '1=Factura 2=Boleta 7=Nota de crédito 8=Nota de débito' })
  tipo_de_comprobante!: number;

  @IsString()
  serie!: string;

  @IsInt()
  numero!: number;
}

export class AnularComprobanteRequest {

  @IsInt()
  @IsIn([1, 2, 7, 8], { message: '1=Factura 2=Boleta 7=Nota de crédito 8=Nota de débito' })
  @IsOptional()
  tipo_de_comprobante?: number;

  @IsString()
  @IsOptional()
  serie?: string;

  @IsInt()
  @IsOptional()
  numero?: number;

  /** Alternativa a serie y número cuando se anula desde la lista de documentos. */
  @IsInt()
  @IsOptional()
  id_comprobante?: number;

  @IsString()
  @MaxLength(250)
  motivo!: string;
}
