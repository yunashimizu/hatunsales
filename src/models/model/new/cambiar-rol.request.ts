import { IsInt, IsOptional, IsEmail, Min, Max } from 'class-validator';

export class CambiarRolRequest {

  @IsInt()
  @IsOptional()
  id_usuario?: number;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsInt()
  @Min(1)
  @Max(4)
  id_rol!: number;
}