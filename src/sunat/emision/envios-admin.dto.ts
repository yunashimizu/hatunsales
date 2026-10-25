import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';
import { AMBIENTES_FISCALES } from '../config/fiscal-config.tipos';
import type { AmbienteFiscal } from '../config/fiscal-config.tipos';
import { ESTADOS_SUNAT, TIPOS_CPE_EMISION } from './emision.tipos';

type Transformacion = { value: unknown };
const recortar = ({ value }: Transformacion) => (typeof value === 'string' ? value.trim() : value);
const minusculas = ({ value }: Transformacion) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const mayusculas = ({ value }: Transformacion) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

/** GET /fiscal/envios. por_pagina mayor a 100 se recorta a 100 (no es un error). */
export class ListarEnviosDto {
  @IsOptional()
  @Transform(minusculas)
  @IsIn([...AMBIENTES_FISCALES], { message: 'El ambiente debe ser beta o produccion.' })
  ambiente?: AmbienteFiscal;

  @IsOptional()
  @Transform(mayusculas)
  @IsIn([...ESTADOS_SUNAT], { message: `El estado debe ser uno de: ${ESTADOS_SUNAT.join(', ')}.` })
  estado?: string;

  @IsOptional()
  @Transform(recortar)
  @IsIn([...TIPOS_CPE_EMISION], { message: 'El tipo debe ser 01 (factura), 03 (boleta), 07 (nota de crédito) u 08 (nota de débito).' })
  tipo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'id_comprobante debe ser un número entero.' })
  @Min(1, { message: 'id_comprobante debe ser al menos 1.' })
  id_comprobante?: number;

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

/** POST /fiscal/envios/:id/confirmar-aceptado: qué verificó el administrador en SUNAT (queda en la auditoría). */
export class ConfirmarAceptadoDto {
  @Transform(recortar)
  @IsString({ message: 'Escriba en la nota qué verificó en SUNAT Operaciones en Línea.' })
  @Length(5, 300, { message: 'La nota debe tener entre 5 y 300 caracteres: indique qué verificó en SUNAT.' })
  nota!: string;
}
