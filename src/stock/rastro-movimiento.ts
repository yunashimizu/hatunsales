import type { CapacidadCaja } from '../caja/esquema/esquema-caja.service';

/**
 * Rastro de los movimientos de stock (Fase 8.1, sql/fase21): quién, en qué almacén y por qué documento.
 * Utilidad pura: arma los fragmentos extra del INSERT en `movimientos_inventario` según las columnas que
 * existan. Sin ninguna columna (fase21 sin correr) no agrega nada y el INSERT queda exactamente como antes.
 *
 * Los cuatro sitios que insertan movimientos la usan: InventarioRepository (ajuste y transferencia),
 * VentaRepository (venta, anulación y nota de crédito) y StockTiendaRepository (reserva y devolución del
 * pedido web).
 */

export const TIPOS_DOCUMENTO_MOVIMIENTO = [
  'venta',
  'anulacion',
  'nota_credito',
  'recepcion',
  'observacion_recepcion',
  'ajuste',
  'transferencia',
  'pedido',
  'alta_producto',
] as const;
export type TipoDocumentoMovimiento = (typeof TIPOS_DOCUMENTO_MOVIMIENTO)[number];

export const ETIQUETA_DOCUMENTO_MOVIMIENTO: Record<TipoDocumentoMovimiento, string> = {
  venta: 'Venta',
  anulacion: 'Anulación de venta',
  nota_credito: 'Nota de crédito',
  recepcion: 'Recepción de mercadería',
  observacion_recepcion: 'Observación de recepción aprobada',
  ajuste: 'Ajuste manual',
  transferencia: 'Transferencia entre almacenes',
  pedido: 'Pedido web',
  alta_producto: 'Stock inicial del producto',
};

/** Lo que quien mueve el stock sabe del movimiento. Todo opcional. */
export interface RastroMovimiento {
  id_usuario?: number | null;
  tipo_documento?: TipoDocumentoMovimiento | null;
  id_documento?: number | null;
}

/** Qué columnas de fase21 existen (una capacidad por columna o par de columnas). */
export interface ColumnasRastro {
  usuario: boolean;
  almacen: boolean;
  documento: boolean;
}

export const SIN_COLUMNAS_RASTRO: Readonly<ColumnasRastro> = Object.freeze({ usuario: false, almacen: false, documento: false });

/** Lo mínimo del servicio de esquema que hace falta (los repositorios lo reciben @Optional). */
export interface ConsultaCapacidades {
  tiene(capacidad: CapacidadCaja): Promise<boolean>;
}

/** Nunca lanza: si el catálogo no se puede leer, el movimiento se guarda como antes (sin rastro). */
export async function columnasRastro(esquema?: ConsultaCapacidades | null): Promise<ColumnasRastro> {
  if (!esquema) return { ...SIN_COLUMNAS_RASTRO };
  try {
    const [usuario, almacen, documento] = await Promise.all([
      esquema.tiene('movimientoUsuario'),
      esquema.tiene('movimientoAlmacen'),
      esquema.tiene('movimientoDocumento'),
    ]);
    return { usuario: usuario === true, almacen: almacen === true, documento: documento === true };
  } catch {
    return { ...SIN_COLUMNAS_RASTRO };
  }
}

export function hayColumnasRastro(columnas: ColumnasRastro): boolean {
  return columnas.usuario || columnas.almacen || columnas.documento;
}

function enteroPositivo(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function tipoValido(valor: unknown): TipoDocumentoMovimiento | null {
  return (TIPOS_DOCUMENTO_MOVIMIENTO as readonly string[]).includes(String(valor ?? ''))
    ? (valor as TipoDocumentoMovimiento)
    : null;
}

export interface ExtrasMovimiento {
  /** Nombres de columna a sumar a la lista del INSERT (en orden). */
  columnas: string[];
  /** Expresión de cada columna (un `$n` o una columna de la fila de origen). */
  expresiones: string[];
  /** Valores de los `$n` nuevos, en orden. */
  valores: unknown[];
}

/**
 * Extras de UNA fila (`INSERT … VALUES`). `desde` = número del primer `$` libre. El almacén va como
 * parámetro.
 */
export function extrasFila(
  columnas: ColumnasRastro,
  rastro: RastroMovimiento | null | undefined,
  idAlmacen: number | null | undefined,
  desde: number,
): ExtrasMovimiento {
  return armar(columnas, rastro, desde, { valor: enteroPositivo(idAlmacen) });
}

/**
 * Extras de un INSERT por lotes (`INSERT … SELECT … FROM unnest(…) m`): usuario y documento son los mismos
 * para todas las filas (parámetros) y el almacén sale de cada fila (`expresionAlmacen`, p. ej. `m.id_almacen`;
 * es un fragmento fijo del código, nunca texto del usuario).
 */
export function extrasLote(
  columnas: ColumnasRastro,
  rastro: RastroMovimiento | null | undefined,
  desde: number,
  expresionAlmacen: string,
): ExtrasMovimiento {
  return armar(columnas, rastro, desde, { expresion: expresionAlmacen });
}

function armar(
  columnas: ColumnasRastro,
  rastro: RastroMovimiento | null | undefined,
  desde: number,
  almacen: { valor?: number | null; expresion?: string },
): ExtrasMovimiento {
  const extras: ExtrasMovimiento = { columnas: [], expresiones: [], valores: [] };
  let siguiente = desde;
  const parametro = (valor: unknown, tipo: string) => {
    extras.valores.push(valor);
    return `$${siguiente++}::${tipo}`;
  };
  if (columnas.usuario) {
    extras.columnas.push('id_usuario');
    extras.expresiones.push(parametro(enteroPositivo(rastro?.id_usuario), 'int'));
  }
  if (columnas.almacen) {
    extras.columnas.push('id_almacen');
    extras.expresiones.push(almacen.expresion ?? parametro(almacen.valor ?? null, 'int'));
  }
  if (columnas.documento) {
    const tipo = tipoValido(rastro?.tipo_documento);
    extras.columnas.push('tipo_documento', 'id_documento');
    extras.expresiones.push(parametro(tipo, 'varchar'), parametro(tipo ? enteroPositivo(rastro?.id_documento) : null, 'int'));
  }
  return extras;
}

/** `, col1, col2` (o vacío) para sumar a una lista de columnas o de expresiones. */
export function sufijo(lista: string[]): string {
  return lista.length ? `, ${lista.join(', ')}` : '';
}
