import { IsIn, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CatalogoQueryRequest {
  /** Texto libre: busca en nombre, sku, código de barras y descripción */
  @IsString()
  @IsOptional()
  q?: string;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  id_categoria?: number;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  id_marca?: number;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  precio_min?: number;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  precio_max?: number;

  /** '1' para mostrar únicamente productos con stock disponible */
  @IsString()
  @IsOptional()
  solo_stock?: string;

  /** '1' para mostrar únicamente productos con descuento */
  @IsString()
  @IsOptional()
  solo_oferta?: string;

  /** '1' para mostrar únicamente productos destacados */
  @IsString()
  @IsOptional()
  solo_destacado?: string;

  /**
   * Atributos dinámicos en formato `nombre:valor` separados por coma.
   * Ejemplo: `atributos=Voltaje:220V,Material:Acero`
   */
  @IsString()
  @IsOptional()
  atributos?: string;

  @IsIn(['relevancia', 'precio_asc', 'precio_desc', 'nombre', 'nuevo', 'rating'])
  @IsOptional()
  orden?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  pagina?: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  limite?: number;
}
