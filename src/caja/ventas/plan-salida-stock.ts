/**
 * Reparto de una venta entre las filas de inventario ya bloqueadas (FOR UPDATE). Es puro:
 * el repositorio bloquea TODAS las filas de una vez, en orden fijo (id_producto, id_almacen),
 * y aquí se decide de dónde sale cada unidad con las mismas reglas de siempre:
 *
 * - Con almacén preferido: solo de ese almacén (sin derrame a otros).
 * - Sin él (legacy): primero el preferido si lo hay, luego el de más stock.
 * - Las líneas se atienden en el orden del carrito; si un producto se repite, la segunda
 *   línea ve el stock que dejó la primera (igual que cuando se consultaba línea por línea).
 */
export interface FilaInventarioBloqueada {
  id_inventario: number;
  id_producto: number;
  id_almacen: number;
  stock: number;
}

export interface LineaPorDespachar {
  id_producto: number;
  cantidad: number;
}

export interface SalidaStock {
  id_inventario: number;
  id_producto: number;
  id_almacen: number;
  cantidad: number;
}

export type PlanSalida =
  | {
      ok: true;
      /** Una salida por línea y fila tocada, en el orden del carrito (para kardex y movimientos). */
      salidas: SalidaStock[];
      /** Total a descontar por fila de inventario (un solo UPDATE por fila). */
      descuentos: { id_inventario: number; cantidad: number }[];
    }
  | { ok: false; id_producto: number; faltante: number };

export function planificarSalidas(
  lineas: readonly LineaPorDespachar[],
  filas: readonly FilaInventarioBloqueada[],
  idAlmacenPreferido?: number,
): PlanSalida {
  const exclusivo = idAlmacenPreferido != null && Number.isFinite(idAlmacenPreferido) && idAlmacenPreferido > 0;
  const restante = new Map<number, number>(filas.map((f) => [f.id_inventario, Math.max(0, Number(f.stock) || 0)]));
  const salidas: SalidaStock[] = [];

  for (const linea of lineas) {
    const candidatas = filas
      .filter(
        (f) =>
          f.id_producto === linea.id_producto
          && (restante.get(f.id_inventario) ?? 0) > 0
          && (!exclusivo || f.id_almacen === idAlmacenPreferido),
      )
      .sort((a, b) => {
        if (!exclusivo) {
          const pa = a.id_almacen === idAlmacenPreferido ? 1 : 0;
          const pb = b.id_almacen === idAlmacenPreferido ? 1 : 0;
          if (pa !== pb) return pb - pa;
          const sa = restante.get(a.id_inventario) ?? 0;
          const sb = restante.get(b.id_inventario) ?? 0;
          if (sa !== sb) return sb - sa;
        }
        return a.id_almacen - b.id_almacen || a.id_inventario - b.id_inventario;
      });

    let pendiente = linea.cantidad;
    for (const fila of candidatas) {
      if (pendiente <= 0) break;
      const disponible = restante.get(fila.id_inventario) ?? 0;
      const tomar = Math.min(pendiente, disponible);
      if (tomar <= 0) continue;
      restante.set(fila.id_inventario, disponible - tomar);
      salidas.push({ id_inventario: fila.id_inventario, id_producto: linea.id_producto, id_almacen: fila.id_almacen, cantidad: tomar });
      pendiente -= tomar;
    }
    if (pendiente > 0) return { ok: false, id_producto: linea.id_producto, faltante: pendiente };
  }

  const porFila = new Map<number, number>();
  for (const s of salidas) porFila.set(s.id_inventario, (porFila.get(s.id_inventario) ?? 0) + s.cantidad);
  const descuentos = [...porFila.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id_inventario, cantidad]) => ({ id_inventario, cantidad }));

  return { ok: true, salidas, descuentos };
}
