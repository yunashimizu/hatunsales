import { IsOptional, IsString, MaxLength } from 'class-validator';

/** PUT /fiscal/alertas: correo para los avisos diarios; vacío = usar el correo del emisor. */
export class AlertasCorreoDto {
  @IsOptional()
  @IsString()
  @MaxLength(254)
  correo?: string;
}
