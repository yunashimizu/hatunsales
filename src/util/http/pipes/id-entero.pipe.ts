import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/** Máximo de una columna `integer` de PostgreSQL. */
export const MAXIMO_ID = 2_147_483_647;

/**
 * Parámetro de ruta con un id entero positivo. Reemplaza `Number(id)`, que con
 * 'abc' mandaba NaN a PostgreSQL y terminaba en 500: ahora responde 400 con
 * `codigo: 'ID_INVALIDO'`. Uso: `@Param('id', IdEnteroPipe) id: number`.
 */
@Injectable()
export class IdEnteroPipe implements PipeTransform<unknown, number> {
  transform(valor: unknown, metadata: ArgumentMetadata): number {
    const texto = typeof valor === 'number' ? String(valor) : String(valor ?? '').trim();
    const numero = /^\d{1,10}$/.test(texto) ? Number(texto) : NaN;
    if (!Number.isInteger(numero) || numero < 1 || numero > MAXIMO_ID) {
      const nombre = metadata?.data || 'id';
      throw new BadRequestException({
        message: `El parámetro «${nombre}» debe ser un número entero positivo.`,
        codigo: 'ID_INVALIDO',
      });
    }
    return numero;
  }
}
