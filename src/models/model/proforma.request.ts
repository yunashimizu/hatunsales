import {
  IsInt, IsString, IsNumber, ValidateNested, IsArray, IsOptional, Min, IsIn, IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ProformaItemRequest {
  @IsInt()
  id_producto!: number;

  @IsNumber()
  @Min(0.001)
  cantidad!: number;

  @IsNumber()
  @Min(0)
  precio_unitario!: number;

  @IsOptional()
  @IsString()
  descripcion?: string;

  @IsOptional()
  @IsString()
  sku?: string;
}

export class CrearProformaRequest {
  @IsOptional()
  @IsInt()
  id_empresa?: number;

  @IsOptional()
  @IsInt()
  id_cliente?: number;

  @IsOptional()
  @IsString()
  cliente_nombre?: string;

  @IsOptional()
  @IsString()
  telefono_envio?: string;

  @IsOptional()
  @IsInt()
  id_almacen?: number;

  @IsOptional()
  @IsString()
  observaciones?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  dias_vigencia?: number;

  @IsOptional()
  @IsNumber()
  total_gravada?: number;

  @IsOptional()
  @IsNumber()
  total_igv?: number;

  @IsOptional()
  @IsNumber()
  total?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProformaItemRequest)
  items!: ProformaItemRequest[];
}

export class MarcarProformaRequest {
  @IsOptional()
  @IsIn(['borrador', 'enviada', 'convertida', 'anulada'])
  estado?: string;

  @IsOptional()
  @IsInt()
  id_venta?: number;
}

export class EnviarCotizacionWaRequest {
  @IsOptional()
  @IsInt()
  id_proforma?: number;

  @IsString()
  telefono!: string;

  @IsOptional()
  @IsString()
  texto?: string;

  /** true = solo armar wa.me (vendedor adjunta proforma). No usa Meta Cloud. */
  @IsOptional()
  @IsBoolean()
  solo_wa_me?: boolean;
}
