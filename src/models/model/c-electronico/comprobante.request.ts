import {
  IsInt, IsString, IsOptional, IsBoolean,
  IsNumber, IsArray, ValidateNested, IsIn, Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ItemComprobanteRequest {

  @IsInt()
  @IsOptional()
  id_producto?: number;

  @IsString()
  unidad_de_medida!: string;

  @IsString()
  codigo!: string;

  @IsString()
  @IsOptional()
  codigo_producto_sunat?: string;

  @IsString()
  descripcion!: string;

  @IsNumber()
  @Min(1)
  cantidad!: number;

  @IsNumber()
  valor_unitario!: number;

  @IsNumber()
  precio_unitario!: number;

  @IsNumber()
  subtotal!: number;

  @IsInt()
  tipo_de_igv!: number;

  @IsNumber()
  igv!: number;

  @IsNumber()
  total!: number;
}

export class GenerarComprobanteRequest {

  @IsInt()
  @IsOptional()
  id_venta?: number;

  // ── opción 1: ya existe en BD ─────────────────────────────
  @IsInt()
  @IsOptional()
  id_cliente?: number;

  @IsInt()
  @IsOptional()
  id_empresa?: number;

  // ── opción 2: consulta SUNAT directo ──────────────────────
  // si viene dni → busca/crea en clientes → tipo_doc = 1
  @IsString()
  @IsOptional()
  dni?: string;

  // si viene ruc → busca/crea en empresas → tipo_doc = 6
  @IsString()
  @IsOptional()
  ruc?: string;

  // ── datos del comprobante ─────────────────────────────────
  @IsInt()
  @IsIn([1, 2, 7, 8], { message: '1=Factura 2=Boleta 7=Nota de crédito 8=Nota de débito' })
  id_tipo!: number;

  @IsInt()
  @IsOptional()
  id_moneda?: number;

  @IsString()
  serie!: string;

  @IsInt()
  numero!: number;

  // ── el sistema llena estos automáticamente ────────────────
  @IsInt()
  @IsIn([1, 6], { message: '1=DNI 6=RUC' })
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

  @IsNumber()
  @IsOptional()
  total_gravada?: number;

  @IsNumber()
  total_igv!: number;

  @IsNumber()
  total!: number;

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

  @IsString()
  @IsOptional()
  observaciones?: string;

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
  tipo_de_comprobante!: number;

  @IsString()
  serie!: string;

  @IsInt()
  numero!: number;

  @IsString()
  motivo!: string;
}