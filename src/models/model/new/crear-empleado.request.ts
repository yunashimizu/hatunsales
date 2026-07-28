import { IsString, IsEmail, IsInt, IsOptional, IsBoolean, MinLength, Min } from 'class-validator';

export class CrearEmpleadoRequest {

  @IsString()
  nombre!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  /** Cualquier rol existente en la tabla `roles`, excepto cliente. */
  @IsInt()
  @Min(1)
  id_rol!: number;

  @IsBoolean()
  @IsOptional()
  estado?: boolean;
}
