import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CrearRolRequest {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  nombre!: string;
}

export class ActualizarRolRequest {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  nombre?: string;
}
