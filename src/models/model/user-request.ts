import { IsString, MinLength } from 'class-validator';
import { CONTRASENA_MINIMA, MENSAJE_CONTRASENA_MINIMA } from '../../util/jwt/contrasena-minima';


export class UserRequest {

  @IsString()
  nombre!: string;

  @IsString()
  @MinLength(CONTRASENA_MINIMA, { message: MENSAJE_CONTRASENA_MINIMA })
  contrasena!: string;
}