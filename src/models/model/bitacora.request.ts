import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

const PATRON_DIA = /^\d{4}-\d{2}-\d{2}$/;
const MENSAJE_DIA = 'use el formato AAAA-MM-DD';

/** GET /bitacora (pantalla «Actividad», solo administrador). Todo es opcional. */
export class ConsultarBitacoraRequest {
  /** Día de Lima inicial, inclusive. */
  @IsOptional()
  @Matches(PATRON_DIA, { message: `desde: ${MENSAJE_DIA}` })
  desde?: string;

  /** Día de Lima final, inclusive. */
  @IsOptional()
  @Matches(PATRON_DIA, { message: `hasta: ${MENSAJE_DIA}` })
  hasta?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'id_usuario debe ser un número entero.' })
  @Min(1)
  id_usuario?: number;

  /** Una de ACCIONES_BITACORA, p. ej. 'producto.precio_cambiado'. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  accion?: string;

  /** 'venta', 'producto', 'comprobante', 'apertura_caja'… (con id_entidad: la historia de un registro). */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  entidad?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'id_entidad debe ser un número entero.' })
  @Min(1)
  id_entidad?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limite debe ser un número entero.' })
  @Min(1, { message: 'limite debe ser al menos 1.' })
  @Max(200, { message: 'limite admite hasta 200.' })
  limite?: number;

  /** Paginación por cursor: trae los registros con id menor a este (el `siguiente` de la página anterior). */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'antes_de debe ser un número entero.' })
  @Min(1, { message: 'antes_de debe ser al menos 1.' })
  antes_de?: number;
}
