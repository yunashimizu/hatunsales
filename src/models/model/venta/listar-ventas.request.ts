import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min, ValidateBy } from 'class-validator';
import { esFechaYmd } from '../../../util/fecha-lima';

/**
 * Filtros de GET /venta (historial) y GET /venta/sin-comprobante. Las fechas son días de Lima y
 * `por_pagina` se limita a 100 en el repositorio (como antes: un valor mayor no da error).
 */

export const ESTADOS_VENTA = ['activa', 'anulada'] as const;
export const OPCIONES_TIENE_COMPROBANTE = ['si', 'no'] as const;

/** Recorta el texto del filtro; vacío equivale a «sin filtro» (un select sin elegir no da 400). */
const recortar = () =>
  Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const limpio = value.trim();
    return limpio === '' ? undefined : limpio;
  });

/** aaaa-mm-dd que exista en el calendario (rechaza 2026-02-30 con un mensaje claro, no con un error de la BD). */
const diaLima = (campo: string) =>
  ValidateBy({
    name: 'diaLima',
    validator: {
      validate: (valor: unknown) => esFechaYmd(valor),
      defaultMessage: () => `${campo} debe ser una fecha que exista, con formato aaaa-mm-dd.`,
    },
  });

/** Un rango al revés no es un error del servidor ni una lista vacía sin explicación: se avisa. */
const noAntesDeDesde = () =>
  ValidateBy({
    name: 'noAntesDeDesde',
    validator: {
      validate: (hasta: unknown, argumentos) => {
        const desde = (argumentos?.object as { desde?: unknown } | undefined)?.desde;
        return !esFechaYmd(hasta) || !esFechaYmd(desde) || desde <= hasta;
      },
      defaultMessage: () => 'La fecha «desde» no puede ser posterior a «hasta».',
    },
  });

/*
 * Con stopAtFirstError solo sale el primer mensaje de cada campo y class-validator valida en el orden en que
 * se aplican los decoradores (de abajo hacia arriba): el del tipo va al final para que «diez» diga «número
 * entero» y no «1 o más».
 */
class PaginaVentasRequest {
  @IsOptional()
  @recortar()
  @diaLima('desde')
  desde?: string;

  @IsOptional()
  @recortar()
  @noAntesDeDesde()
  @diaLima('hasta')
  hasta?: string;

  @IsOptional()
  @Type(() => Number)
  @Min(1, { message: 'pagina debe ser 1 o más.' })
  @IsInt({ message: 'pagina debe ser un número entero.' })
  pagina?: number;

  @IsOptional()
  @Type(() => Number)
  @Min(1, { message: 'por_pagina debe ser 1 o más.' })
  @IsInt({ message: 'por_pagina debe ser un número entero.' })
  por_pagina?: number;
}

/** GET /venta: gemelo de FiltroHistorialVentas del frontend, más `origen` (filtro que el listado ya tenía). */
export class ListarVentasRequest extends PaginaVentasRequest {
  /** Cliente (nombre o documento), número de venta o serie-número de sus comprobantes. */
  @IsOptional()
  @recortar()
  @MaxLength(100, { message: 'La búsqueda admite hasta 100 caracteres.' })
  @IsString({ message: 'texto debe ser un texto.' })
  texto?: string;

  @IsOptional()
  @recortar()
  @IsIn(ESTADOS_VENTA, { message: `estado: use ${ESTADOS_VENTA.join(' o ')}.` })
  estado?: (typeof ESTADOS_VENTA)[number];

  /** 'si': con factura o boleta vigente; 'no': sin ninguna (o solo con anuladas o con error). */
  @IsOptional()
  @recortar()
  @IsIn(OPCIONES_TIENE_COMPROBANTE, { message: `tiene_comprobante: use ${OPCIONES_TIENE_COMPROBANTE.join(' o ')}.` })
  tiene_comprobante?: (typeof OPCIONES_TIENE_COMPROBANTE)[number];

  /** 'mostrador' | 'tienda'. */
  @IsOptional()
  @recortar()
  @MaxLength(30, { message: 'origen admite hasta 30 caracteres.' })
  @IsString({ message: 'origen debe ser un texto.' })
  origen?: string;
}

/** GET /venta/sin-comprobante (gemelo de FiltroVentasSinComprobante del frontend). */
export class ListarVentasSinComprobanteRequest extends PaginaVentasRequest {}
