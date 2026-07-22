import { IsInt, IsOptional, IsEmail } from 'class-validator';

export class EliminarUsuarioRequest {

  @IsInt()
  @IsOptional()
  id_usuario?: number;

  @IsEmail()
  @IsOptional()
  email?: string;
}