import {
  IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CrearGuiaRemisionRequest {
  /** La venta es la fuente autoritativa de productos, cantidades y almacén. */
  @IsInt()
  id_venta!: number;

  /** Comprobante relacionado elegido por el backend o confirmado por el usuario. */
  @IsInt()
  @IsOptional()
  id_comprobante?: number;

  @IsString()
  @IsOptional()
  @MaxLength(10)
  fecha_emision?: string;

  @IsDateString()
  fecha_inicio_traslado!: string;

  /** Catálogo SUNAT: 01 = venta en el primer flujo. */
  @IsString()
  @MaxLength(4)
  motivo_traslado_codigo!: string;

  /** Catálogo SUNAT: 01 = privado, 02 = público. */
  @IsIn(['01', '02'])
  modalidad_traslado!: string;

  @IsString()
  @MaxLength(500)
  direccion_origen!: string;

  @IsString()
  @MaxLength(500)
  direccion_destino!: string;

  @IsString()
  @IsOptional()
  @MaxLength(6)
  origen_ubigeo?: string;

  @IsString()
  @IsOptional()
  @MaxLength(6)
  destino_ubigeo?: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  peso_bruto_total!: number;

  @IsString()
  @MaxLength(3)
  unidad_peso!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  numero_bultos?: number;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  placa_principal?: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  marca_vehiculo?: string;

  @IsString()
  @IsOptional()
  @MaxLength(250)
  conductor_nombre?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2)
  conductor_tipo_doc?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  conductor_numero_doc?: string;

  @IsString()
  @IsOptional()
  @MaxLength(30)
  conductor_licencia?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  transportista_ruc?: string;

  @IsString()
  @IsOptional()
  @MaxLength(250)
  transportista_denominacion?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  observaciones?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  clave_idempotencia?: string;
}
