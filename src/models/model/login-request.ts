import { IsString, IsEmail, MinLength, IsOptional, Matches, ValidateIf } from 'class-validator';

export class LoginRequest {

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}

/** Registro público: solo clientes de tienda (empleados se crean en admin). */
export class RegisterRequest {

  @IsOptional()
  @IsString()
  nombre?: string;

  @IsOptional()
  @IsString()
  nombres?: string;

  @IsOptional()
  @IsString()
  apellidos?: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== undefined && v !== null && String(v).trim() !== '')
  @IsString()
  @Matches(/^[\d+\s()-]{6,20}$/, { message: 'Celular inválido' })
  telefono?: string;
}

/** Credential JWT de Google Identity Services (GIS). */
export class GoogleAuthRequest {
  @IsString()
  credential!: string;
}
