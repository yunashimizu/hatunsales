import { IsString, IsEmail, MinLength } from 'class-validator';
import { CONTRASENA_MINIMA, MENSAJE_CONTRASENA_MINIMA } from '../../util/jwt/contrasena-minima';

export class authRequest {

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}

export class RegisterRequest {

  @IsString()
  nombre!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(CONTRASENA_MINIMA, { message: MENSAJE_CONTRASENA_MINIMA })
  password!: string;
}