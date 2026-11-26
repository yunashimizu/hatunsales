import { IsEmail, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { CONTRASENA_MINIMA, MENSAJE_CONTRASENA_MINIMA } from '../../util/jwt/contrasena-minima';

export class ActualizarPerfilRequest {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nombre?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  email?: string;

  /** Obligatoria solo si se quiere cambiar la contraseña. */
  @ValidateIf((o) => !!o.password_nueva)
  @IsString()
  password_actual?: string;

  @IsOptional()
  @IsString()
  @MinLength(CONTRASENA_MINIMA, { message: MENSAJE_CONTRASENA_MINIMA })
  @MaxLength(100)
  password_nueva?: string;
}
