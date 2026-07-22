import { IsInt, IsNumber, IsOptional } from 'class-validator';

export class ActualizarInventarioRequest {
  @IsInt()
  id_producto!: number;

  @IsNumber()
  @IsOptional()
  stock?: number;

  @IsNumber()
  @IsOptional()
  stock_minimo?: number;
}
