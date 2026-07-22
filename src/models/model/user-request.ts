import { IsString } from 'class-validator';

export class UserRequest {

  @IsString()
  nombre!: string;

  @IsString()
  contrasena!: string;
}