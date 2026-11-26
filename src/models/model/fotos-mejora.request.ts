import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { LIMITE_MEJORA_MAXIMO, LIMITE_REVISION_MAXIMO } from '../../fotos/reprocesado-fotos.service';

/** POST /fotos-mejora/diagnostico (revisar sin cambiar nada). */
export class RevisarFotosRequest {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limite debe ser un número entero.' })
  @Min(1, { message: 'limite debe ser al menos 1.' })
  @Max(LIMITE_REVISION_MAXIMO, { message: `limite admite hasta ${LIMITE_REVISION_MAXIMO}.` })
  limite?: number;
}

/** POST /fotos-mejora/deshacer (todas, o las de un producto). */
export class DeshacerFotosRequest {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'id_producto debe ser un número entero.' })
  @Min(1, { message: 'id_producto debe ser al menos 1.' })
  id_producto?: number;
}

/** POST /fotos-mejora/reprocesar (mejorar una tanda de las que faltan). */
export class MejorarFotosRequest extends DeshacerFotosRequest {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limite debe ser un número entero.' })
  @Min(1, { message: 'limite debe ser al menos 1.' })
  @Max(LIMITE_MEJORA_MAXIMO, { message: `limite admite hasta ${LIMITE_MEJORA_MAXIMO}.` })
  limite?: number;
}

/** PUT /fotos-mejora/config. */
export class ConfigurarFotosRequest {
  @IsBoolean({ message: 'activa debe ser verdadero o falso.' })
  activa!: boolean;
}
