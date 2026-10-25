import { SnapshotEsquema } from './esquema-caja.service';

/** Catálogo con fase9 (enlace de la nota) y, si se pide, las columnas de sql/fase14_notas_credito_enlace.sql. */
function snapshot(conFase14: boolean, sin: string[] = []): SnapshotEsquema {
  const columnas: Record<string, string[]> = {
    comprobantes: ['id_comprobante', 'id_comprobante_modificado', 'nota_motivo',
      ...(conFase14 ? ['efecto_nota', 'reingresar_stock', 'efectos_aplicados', 'efectos_aplicados_en'] : [])],
    comprobante_items: ['id_item', ...(conFase14 ? ['id_item_origen'] : [])],
    venta_stock_salida: ['id', 'id_venta', 'id_producto', 'id_almacen', 'cantidad', ...(conFase14 ? ['cantidad_devuelta'] : [])],
  };
  const mapa = new Map(Object.entries(columnas).map(([tabla, lista]) => [tabla, new Set(lista.filter((c) => !sin.includes(`${tabla}.${c}`)))]));
  return new SnapshotEsquema(mapa, Date.now());
}

describe('EsquemaCajaService: capacidades de fase14 (notas de crédito)', () => {
  it('sin fase14 las notas de crédito no están disponibles (responden 503) y la anulación no descuenta devoluciones', () => {
    const s = snapshot(false);
    expect(s.tiene('notasCredito')).toBe(false);
    expect(s.tiene('ventaStockDevuelto')).toBe(false);
    expect(s.faltantes('notasCredito')).toEqual(expect.arrayContaining(['comprobantes.efecto_nota', 'comprobante_items.id_item_origen', 'venta_stock_salida.cantidad_devuelta']));
  });

  it('con fase14 completa ambas capacidades quedan disponibles; si falta una sola columna, las notas siguen apagadas', () => {
    expect(snapshot(true).tiene('notasCredito')).toBe(true);
    expect(snapshot(true).tiene('ventaStockDevuelto')).toBe(true);
    expect(snapshot(true, ['comprobantes.efectos_aplicados_en']).faltantes('notasCredito')).toEqual(['comprobantes.efectos_aplicados_en']);
  });
});
