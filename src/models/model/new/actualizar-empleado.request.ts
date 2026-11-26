import { IsString, IsEmail, IsInt, IsOptional, IsBoolean, MinLength, Min, ValidateIf } from 'class-validator';
import { CONTRASENA_MINIMA, MENSAJE_CONTRASENA_MINIMA } from '../../../util/jwt/contrasena-minima';

export class ActualizarEmpleadoRequest {

  @IsInt()
  @Min(1)
  id_usuario!: number;

  @IsString()
  @IsOptional()
  nombre?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  /** Si no se envía o viene vacío, no se cambia la contraseña. */
  @ValidateIf((_, value) => value !== undefined && value !== null && String(value).trim() !== '')
  @IsString()
  @MinLength(CONTRASENA_MINIMA, { message: MENSAJE_CONTRASENA_MINIMA })
  password?: string;

  @IsInt()
  @IsOptional()
  @Min(1)
  id_rol?: number;

  @IsBoolean()
  @IsOptional()
  estado?: boolean;
}
