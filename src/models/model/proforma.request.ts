import { IsInt, IsString, IsNumber, ValidateNested, IsArray } from 'class-validator';
import { Type } from 'class-transformer';

export class ProformaItemRequest {
  @IsInt()
  id_producto!: number;

  @IsNumber()
  cantidad!: number;

  @IsNumber()
  precio_unitario!: number;
}

export class CrearProformaRequest {
  @IsInt()
  id_empresa!: number;

  @IsInt()
  id_cliente!: number;

  @IsString()
  serie!: string;

  @IsInt()
  numero!: number;

  @IsNumber()
  total_gravada!: number;

  @IsNumber()
  total_igv!: number;

  @IsNumber()
  total!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProformaItemRequest)
  items!: ProformaItemRequest[];
}
