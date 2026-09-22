import { resolverPrecioVenta } from './precio-venta';

describe('resolverPrecioVenta', () => {
  it('aplica el descuento enviado en la línea y no el descuento base del producto', () => {
    const resultado = resolverPrecioVenta({
      precio_lista: 100,
      descuento_producto: 5,
      cantidad: 2,
    });

    expect(resultado.precio_lista_unitario).toBe(100);
    expect(resultado.descuento_unitario_aplicado).toBe(5);
    expect(resultado.descuento_total_linea).toBe(10);
    expect(resultado.precio_unitario_final).toBe(95);
    expect(resultado.total_linea).toBe(190);
  });

  it('mantiene sin descuento cuando la línea llega con cero', () => {
    const resultado = resolverPrecioVenta({
      precio_lista: 100,
      descuento_producto: 0,
      cantidad: 1,
    });

    expect(resultado.descuento_unitario_aplicado).toBe(0);
    expect(resultado.descuento_total_linea).toBe(0);
    expect(resultado.precio_unitario_final).toBe(100);
    expect(resultado.total_linea).toBe(100);
  });
});
