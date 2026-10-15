import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, Matches } from 'class-validator';

const limpiar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Emisor exclusivo de pruebas; nunca actualiza emisor_* del negocio. */
export class EmisorBetaDto {
  @Transform(limpiar)
  @Matches(/^\d{11}$/, { message: 'El RUC BETA debe tener 11 dígitos.' })
  ruc!: string;

  @Transform(limpiar)
  @IsString()
  @Length(1, 200)
  razon_social!: string;

  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @Length(0, 200)
  nombre_comercial?: string;

  @Transform(limpiar)
  @IsString()
  @Length(1, 200)
  direccion!: string;

  @Transform(limpiar)
  @Matches(/^\d{6}$/, { message: 'El ubigeo BETA debe tener 6 dígitos.' })
  ubigeo!: string;

  @Transform(limpiar)
  @IsString()
  @Length(1, 60)
  distrito!: string;

  @Transform(limpiar)
  @IsString()
  @Length(1, 60)
  provincia!: string;

  @Transform(limpiar)
  @IsString()
  @Length(1, 60)
  departamento!: string;

  @Transform(limpiar)
  @Matches(/^\d{4}$/, {
    message: 'El establecimiento BETA debe tener 4 dígitos.',
  })
  codigo_establecimiento!: string;
}
