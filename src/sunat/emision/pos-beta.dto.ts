import { IsBoolean } from 'class-validator';

export class PosBetaDto {
  @IsBoolean()
  activo!: boolean;
}
