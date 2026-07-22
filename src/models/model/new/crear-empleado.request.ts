import { IsString, IsEmail, IsInt, IsOptional, IsBoolean, MinLength, Min, Max } from 'class-validator';

export class CrearEmpleadoRequest {

  @IsString()
  nombre!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsInt()
  @Min(1)
  @Max(4)
  id_rol!: number;

  @IsBoolean()
  @IsOptional()
  estado?: boolean;
}