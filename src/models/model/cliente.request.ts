import { IsString, IsOptional, IsInt, IsEmail, IsNumber } from 'class-validator';

export class CrearClienteRequest {

  @IsString()
  @IsOptional()
  nombre?: string;

  @IsString()
  @IsOptional()
  apellido_paterno?: string;

  @IsString()
  @IsOptional()
  apellido_materno?: string;

  @IsNumber()
  @IsOptional()
  dni?: number;

  @IsString()
  @IsOptional()
  telefono?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  direccion?: string;

  @IsInt()
  @IsOptional()
  id_usuario?: number;

  // jala datos de SUNAT por DNI y guarda en clientes
  @IsString()
  @IsOptional()
  dni_sunat?: string;

  // jala datos de SUNAT por RUC y guarda en empresas
  @IsString()
  @IsOptional()
  ruc_sunat?: string;
}

export class ActualizarClienteRequest {

  @IsString()
  @IsOptional()
  nombre?: string;

  @IsString()
  @IsOptional()
  apellido_paterno?: string;

  @IsString()
  @IsOptional()
  apellido_materno?: string;

  @IsString()
  @IsOptional()
  telefono?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  direccion?: string;
}