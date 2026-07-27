import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class GuardarDireccionRequest {
  @IsString()
  @IsOptional()
  alias?: string;

  @IsString()
  @IsOptional()
  destinatario?: string;

  @IsString()
  @IsOptional()
  telefono?: string;

  @IsString()
  @IsOptional()
  departamento?: string;

  @IsString()
  @IsOptional()
  provincia?: string;

  @IsString()
  @IsOptional()
  distrito?: string;

  @IsString()
  direccion!: string;

  @IsString()
  @IsOptional()
  referencia?: string;

  @IsString()
  @IsOptional()
  codigo_postal?: string;

  @IsBoolean()
  @IsOptional()
  es_predeterminada?: boolean;
}

export class CrearResenaRequest {
  @IsInt()
  @Min(1)
  @Max(5)
  calificacion!: number;

  @IsString()
  @IsOptional()
  titulo?: string;

  @IsString()
  @IsOptional()
  comentario?: string;
}
