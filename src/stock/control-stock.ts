/**
 * Configuración de la Fase 8 (stock y pedidos web), en la tabla `configuraciones`. Utilidad pura: claves,
 * valores por defecto y normalización. Sin ninguna clave guardada el sistema se comporta como antes de la
 * Fase 8: ningún pedido vence solo y una guía repetida solo se informa en la respuesta (no bloquea).
 */

export const CLAVES_CONTROL_STOCK = {
  /** 8.2 (D5): horas sin pagar tras las que vence un pedido pagado con tarjeta/pasarela. 0 = apagado; sugerido 24. */
  vencimientoPasarela: 'pedido_vencimiento_horas_pasarela',
  /** 8.2 (D5): ídem para transferencia, depósito o billetera (Yape/Plin). 0 = apagado; sugerido 48. */
  vencimientoTransferencia: 'pedido_vencimiento_horas_transferencia',
  /** 8.4: `avisar` (por defecto: solo informa) o `bloquear` (409 salvo confirmación explícita). */
  guiaRepetida: 'recepcion_guia_repetida',
} as const;

export const MODOS_GUIA_REPETIDA = ['avisar', 'bloquear'] as const;
export type ModoGuiaRepetida = (typeof MODOS_GUIA_REPETIDA)[number];

/** Mínimo cuando el vencimiento está encendido: un pedido de la mañana no vence a la tarde. */
export const VENCIMIENTO_HORAS_MINIMO = 2;
/** Máximo (30 días): más que eso ya no es «sin pagar», es un pedido olvidado que el dueño debe mirar. */
export const VENCIMIENTO_HORAS_MAXIMO = 720;

export interface ConfigControlStock {
  /** 0 = apagado. */
  pedido_vencimiento_horas_pasarela: number;
  /** 0 = apagado. */
  pedido_vencimiento_horas_transferencia: number;
  recepcion_guia_repetida: ModoGuiaRepetida;
}

export const CONTROL_STOCK_POR_DEFECTO: Readonly<ConfigControlStock> = Object.freeze({
  pedido_vencimiento_horas_pasarela: 0,
  pedido_vencimiento_horas_transferencia: 0,
  recepcion_guia_repetida: 'avisar',
});

function textoLimpio(valor: unknown): string {
  return String(valor ?? '').trim().toLowerCase();
}

/** Lo guardado: 0 o vacío = apagado; fuera de rango se acerca al límite; ilegible = apagado (no vence nada). */
export function horasVencimientoDeTexto(valor: string | null | undefined): number {
  if (valor === null || valor === undefined || String(valor).trim() === '') return 0;
  const n = Number(String(valor).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const horas = Math.round(n);
  if (horas < VENCIMIENTO_HORAS_MINIMO) return VENCIMIENTO_HORAS_MINIMO;
  return Math.min(horas, VENCIMIENTO_HORAS_MAXIMO);
}

/** Cualquier valor que no sea exactamente `bloquear` es `avisar` (la regla que bloquea nace apagada). */
export function modoGuiaDeTexto(valor: string | null | undefined): ModoGuiaRepetida {
  return textoLimpio(valor) === 'bloquear' ? 'bloquear' : 'avisar';
}

export function configControlStockDesdeValores(valores: Record<string, string | null | undefined>): ConfigControlStock {
  return {
    pedido_vencimiento_horas_pasarela: horasVencimientoDeTexto(valores[CLAVES_CONTROL_STOCK.vencimientoPasarela]),
    pedido_vencimiento_horas_transferencia: horasVencimientoDeTexto(valores[CLAVES_CONTROL_STOCK.vencimientoTransferencia]),
    recepcion_guia_repetida: modoGuiaDeTexto(valores[CLAVES_CONTROL_STOCK.guiaRepetida]),
  };
}

/** Cuerpo de `PUT configuracion/control-stock`: todo opcional, solo cambia lo que llega. */
export interface CambioControlStock {
  pedido_vencimiento_horas_pasarela?: unknown;
  pedido_vencimiento_horas_transferencia?: unknown;
  recepcion_guia_repetida?: unknown;
}

function horasDelCambio(nombre: string, valor: unknown): number {
  const crudo = String(valor).trim();
  const n = Number(crudo.replace(',', '.'));
  const valido = crudo !== '' && Number.isInteger(n) && (n === 0 || (n >= VENCIMIENTO_HORAS_MINIMO && n <= VENCIMIENTO_HORAS_MAXIMO));
  if (!valido) {
    throw new Error(
      `«${nombre}» debe ser 0 (apagado) o un número entero de horas entre ${VENCIMIENTO_HORAS_MINIMO} y ${VENCIMIENTO_HORAS_MAXIMO}.`,
    );
  }
  return n;
}

/** Valida el cambio; devuelve solo lo que llegó. Lanza `Error` con un mensaje legible si algo no vale. */
export function validarCambioControlStock(cambio: CambioControlStock): Partial<ConfigControlStock> {
  const nuevo: Partial<ConfigControlStock> = {};
  if (cambio.pedido_vencimiento_horas_pasarela !== undefined && cambio.pedido_vencimiento_horas_pasarela !== null) {
    nuevo.pedido_vencimiento_horas_pasarela = horasDelCambio('pedido_vencimiento_horas_pasarela', cambio.pedido_vencimiento_horas_pasarela);
  }
  if (cambio.pedido_vencimiento_horas_transferencia !== undefined && cambio.pedido_vencimiento_horas_transferencia !== null) {
    nuevo.pedido_vencimiento_horas_transferencia = horasDelCambio(
      'pedido_vencimiento_horas_transferencia',
      cambio.pedido_vencimiento_horas_transferencia,
    );
  }
  if (cambio.recepcion_guia_repetida !== undefined && cambio.recepcion_guia_repetida !== null) {
    const modo = textoLimpio(cambio.recepcion_guia_repetida);
    if (!(MODOS_GUIA_REPETIDA as readonly string[]).includes(modo)) {
      throw new Error(`«recepcion_guia_repetida» debe ser uno de: ${MODOS_GUIA_REPETIDA.join(', ')}.`);
    }
    nuevo.recepcion_guia_repetida = modo as ModoGuiaRepetida;
  }
  return nuevo;
}

/** Guía comparable: sin espacios en los bordes y en mayúsculas (igual que el diagnóstico y el índice de fase21). */
export function guiaNormalizada(guia: unknown): string {
  return String(guia ?? '').trim().toUpperCase();
}
