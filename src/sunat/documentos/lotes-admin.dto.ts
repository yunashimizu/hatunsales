import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { AMBIENTES_FISCALES } from '../config/fiscal-config.tipos';
import type { AmbienteFiscal } from '../config/fiscal-config.tipos';
import { ESTADOS_SUNAT } from '../emision/emision.tipos';
import type { OperacionLote } from './lotes.contrato';

type Transformacion = { value: unknown };
const minusculas = ({ value }: Transformacion) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const mayusculas = ({ value }: Transformacion) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

/** GET /fiscal/lotes. por_pagina mayor a 100 se recorta a 100 (no es un error). */
export class ListarLotesDto {
  @IsOptional()
  @Transform(minusculas)
  @IsIn([...AMBIENTES_FISCALES], { message: 'El ambiente debe ser beta o produccion.' })
  ambiente?: AmbienteFiscal;

  @IsOptional()
  @Transform(minusculas)
  @IsIn(['baja', 'resumen'], { message: 'La operación debe ser baja (RA) o resumen (RC).' })
  operacion?: OperacionLote;

  @IsOptional()
  @Transform(mayusculas)
  @IsIn([...ESTADOS_SUNAT], { message: `El estado debe ser uno de: ${ESTADOS_SUNAT.join(', ')}.` })
  estado?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pagina debe ser un número entero.' })
  @Min(1, { message: 'pagina debe ser al menos 1.' })
  pagina?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'por_pagina debe ser un número entero.' })
  @Min(1, { message: 'por_pagina debe ser al menos 1.' })
  por_pagina?: number;
}
