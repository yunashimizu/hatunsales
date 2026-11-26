import { IsString, IsEmail, IsInt, IsOptional, IsBoolean, MinLength, Min } from 'class-validator';
import { CONTRASENA_MINIMA, MENSAJE_CONTRASENA_MINIMA } from '../../../util/jwt/contrasena-minima';

export class CrearEmpleadoRequest {

  @IsString()
  nombre!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(CONTRASENA_MINIMA, { message: MENSAJE_CONTRASENA_MINIMA })
  password!: string;

  /** Cualquier rol existente en la tabla `roles`, excepto cliente. */
  @IsInt()
  @Min(1)
  id_rol!: number;

  @IsBoolean()
  @IsOptional()
  estado?: boolean;
}
