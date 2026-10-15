/**
 * Clasificación de los medios de pago de `metodos_pago` para la caja. Usa el campo `tipo` y,
 * si está vacío (filas antiguas como 'EFECTIVO' o 'YAPE'), el nombre, con las mismas reglas
 * que el POS (ventas.component.ts esEfectivo/esCredito/esYape/esTarjeta/esTransferencia).
 */
export type CategoriaMetodo = 'efectivo' | 'billetera' | 'tarjeta' | 'transferencia' | 'credito' | 'otro';

export interface MetodoPagoCaja {
  id_metodo: number;
  nombre: string;
  tipo: string;
}

function normalizar(texto: string | null | undefined): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

export function categoriaMetodo(tipo: string | null | undefined, nombre: string | null | undefined): CategoriaMetodo {
  const t = normalizar(tipo);
  const n = normalizar(nombre);
  if (t === 'efectivo' || n === 'efectivo' || (!t && n.includes('efectivo'))) return 'efectivo';
  if (t === 'credito' || n === 'credito') return 'credito';
  if (t === 'billetera' || n.includes('yape') || n.includes('plin')) return 'billetera';
  if (t === 'tarjeta' || n.includes('tarjeta')) return 'tarjeta';
  if (t === 'transferencia' || n.includes('transfer') || n.includes('deposito')) return 'transferencia';
  return 'otro';
}

/** El efectivo se cuenta en la gaveta; el resto (salvo crédito) se concilia contra lo declarado. */
export function seConciliaPorDeclaracion(categoria: CategoriaMetodo): boolean {
  return categoria !== 'efectivo' && categoria !== 'credito';
}

/** Método de efectivo por defecto para una venta sin pagos: tipo/nombre efectivo con menor orden. */
export function metodoEfectivoPorDefecto(metodos: readonly MetodoPagoCaja[]): MetodoPagoCaja | null {
  const candidatos = metodos.filter((m) => categoriaMetodo(m.tipo, m.nombre) === 'efectivo');
  // Primero el que se llama "efectivo" (no "Pago contra entrega"), luego el orden de la lista.
  return candidatos.find((m) => normalizar(m.nombre) === 'efectivo') ?? candidatos[0] ?? null;
}
