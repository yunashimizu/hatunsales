import { IsString, IsOptional, IsInt, IsEmail, Length } from 'class-validator';

export class BuscarDniRequest {

  @IsString()
  @Length(8, 8, { message: 'El DNI debe tener 8 dígitos' })
  dni!: string;

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

export class BuscarRucEmpresaRequest {

  @IsString()
  @Length(11, 11, { message: 'El RUC debe tener 11 dígitos' })
  ruc!: string;

  @IsString()
  @IsOptional()
  telefono?: string;

  @IsEmail()
  @IsOptional()
  email?: string;
}

export class BuscarRucProveedorRequest {

  @IsString()
  @Length(11, 11, { message: 'El RUC debe tener 11 dígitos' })
  ruc!: string;

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