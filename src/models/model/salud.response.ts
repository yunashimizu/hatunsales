import { ApiProperty } from '@nestjs/swagger';

export type EstadoPingBd = 'ok' | 'error' | 'timeout';

export interface ResultadoPingBd {
  readonly estado: EstadoPingBd;
  /** Tiempo de la consulta `SELECT 1` en ms. */
  readonly ms: number;
}

/** GET /salud: sin datos sensibles (ni host de BD, ni variables, ni usuarios). */
export class SaludResponse {
  @ApiProperty({ enum: ['ok', 'degradado'], example: 'ok' })
  estado!: 'ok' | 'degradado';

  @ApiProperty({ enum: ['ok', 'error', 'timeout'], example: 'ok' })
  bd!: EstadoPingBd;

  @ApiProperty({ nullable: true, example: 4, description: 'Latencia de SELECT 1 en ms (null si falló)' })
  bd_ms!: number | null;

  @ApiProperty({ example: 'a1b2c3d', description: 'Commit desplegado (7 caracteres) o "local"' })
  version!: string;

  @ApiProperty({ example: 3600, description: 'Segundos desde que arrancó el proceso' })
  uptime_s!: number;

  @ApiProperty({ example: '2026-10-13T15:04:05.000Z' })
  fecha!: string;
}
