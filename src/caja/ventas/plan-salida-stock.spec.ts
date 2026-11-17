import { planificarSalidas } from './plan-salida-stock';

describe('planificarSalidas', () => {
  it('stock 0,3 con dos líneas de 0,1 y 0,2: alcanza justo (sin restos de coma flotante)', () => {
    const plan = planificarSalidas(
      [{ id_producto: 7, cantidad: 0.1 }, { id_producto: 7, cantidad: 0.2 }],
      [{ id_inventario: 1, id_producto: 7, id_almacen: 2, stock: 0.3 }],
      2,
    );

    expect(plan).toEqual({
      ok: true,
      salidas: [
        { id_inventario: 1, id_producto: 7, id_almacen: 2, cantidad: 0.1 },
        { id_inventario: 1, id_producto: 7, id_almacen: 2, cantidad: 0.2 },
      ],
      descuentos: [{ id_inventario: 1, cantidad: 0.3 }],
    });
  });

  it('el faltante sale en unidades y exacto', () => {
    const plan = planificarSalidas(
      [{ id_producto: 7, cantidad: 0.5 }],
      [{ id_inventario: 1, id_producto: 7, id_almacen: 2, stock: 0.3 }],
      2,
    );

    expect(plan).toEqual({ ok: false, id_producto: 7, faltante: 0.2 });
  });

  it('sin almacén preferido reparte primero desde el de más stock y luego del siguiente', () => {
    const plan = planificarSalidas(
      [{ id_producto: 7, cantidad: 5.5 }],
      [
        { id_inventario: 1, id_producto: 7, id_almacen: 1, stock: 2 },
        { id_inventario: 2, id_producto: 7, id_almacen: 2, stock: 4.25 },
      ],
    );

    expect(plan).toEqual({
      ok: true,
      salidas: [
        { id_inventario: 2, id_producto: 7, id_almacen: 2, cantidad: 4.25 },
        { id_inventario: 1, id_producto: 7, id_almacen: 1, cantidad: 1.25 },
      ],
      descuentos: [
        { id_inventario: 1, cantidad: 1.25 },
        { id_inventario: 2, cantidad: 4.25 },
      ],
    });
  });

  it('con almacén preferido no derrama a otros almacenes', () => {
    const plan = planificarSalidas(
      [{ id_producto: 7, cantidad: 3 }],
      [
        { id_inventario: 1, id_producto: 7, id_almacen: 1, stock: 10 },
        { id_inventario: 2, id_producto: 7, id_almacen: 2, stock: 1 },
      ],
      2,
    );

    expect(plan).toEqual({ ok: false, id_producto: 7, faltante: 2 });
  });
});
