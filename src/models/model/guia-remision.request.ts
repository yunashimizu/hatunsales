import { IsInt, IsString, IsNumber, ValidateNested, IsArray } from 'class-validator';
import { Type } from 'class-transformer';

export class GuiaRemisionItemRequest {
  @IsInt()
  id_producto!: number;

  @IsNumber()
  cantidad!: number;

  @IsString()
  unidad_medida!: string;
}

export class CrearGuiaRemisionRequest {
  @IsInt()
  id_empresa!: number;

  @IsInt()
  id_cliente!: number;

  @IsString()
  direccion_origen!: string;

  @IsString()
  direccion_destino!: string;

  @IsString()
  motivo_traslado!: string;

  @IsString()
  peso_total!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GuiaRemisionItemRequest)
  items!: GuiaRemisionItemRequest[];
}
