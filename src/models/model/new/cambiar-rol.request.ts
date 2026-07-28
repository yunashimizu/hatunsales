import { IsInt, IsOptional, IsEmail, Min } from 'class-validator';

export class CambiarRolRequest {

  @IsInt()
  @IsOptional()
  id_usuario?: number;

  @IsEmail()
  @IsOptional()
  email?: string;

  /** Cualquier rol existente en la tabla `roles`, excepto cliente. */
  @IsInt()
  @Min(1)
  id_rol!: number;
}
