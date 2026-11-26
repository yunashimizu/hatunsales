import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PosRapidoService } from './pos-rapido.service';

function armar(opciones: { capacidades?: Partial<Record<string, boolean>>; ultimos?: any[]; frecuentes?: any[]; sucursal?: any } = {}) {
  const repo = {
    ultimosProductos: jest.fn(async () => opciones.ultimos ?? []),
    sucursalDeAlmacen: jest.fn(async () => ('sucursal' in opciones ? opciones.sucursal : { id_sucursal: 1 })),
    frecuentes: jest.fn(async () => opciones.frecuentes ?? []),
  };
  const esquema = { tiene: jest.fn(async (c: string) => opciones.capacidades?.[c] ?? true) };
  return { servicio: new PosRapidoService(repo as any, esquema as any), repo, esquema };
}

const fila = (id: number) => ({
  id_producto: id, nombre: `P${id}`, precio_venta: '10.50', descuento: '0.00', unidad_medida: 'NIU', stock: 4, ventas: 3, cantidad: '5',
});

describe('PosRapidoService.ultimosProductos (Fase 3.2)', () => {
  it('cliente: 5 como máximo, ventas no anuladas, precio pagado y fecha ISO, sin costos', async () => {
    const { servicio, repo } = armar({
      ultimos: [{
        id_producto: 9001, nombre: 'MARTILLO', unidad_medida: 'NIU', precio: '70.00', cantidad: 2,
        fecha: new Date('2026-11-24T15:00:00Z'), id_venta: 33, precio_venta_actual: '100.00', activo: true,
      }],
    });
    const r = await servicio.ultimosProductos('cliente', 7);
    expect(repo.ultimosProductos).toHaveBeenCalledWith('cliente', 7, 5, true);
    expect(r).toEqual({
      tipo: 'cliente', id: 7,
      productos: [{
        id_producto: 9001, nombre: 'MARTILLO', unidad_medida: 'NIU', precio: 70, cantidad: 2,
        fecha: '2026-11-24T15:00:00.000Z', id_venta: 33, precio_venta_actual: 100, activo: true,
      }],
    });
    expect(JSON.stringify(r)).not.toMatch(/costo|precio_compra/);
  });

  it('sin la columna estado no filtra anuladas; empresa sin ventas.id_empresa → vacía sin consultar', async () => {
    const { servicio, repo } = armar({ capacidades: { ventaEstado: false, ventaEmpresa: false } });
    await servicio.ultimosProductos('cliente', 7);
    expect(repo.ultimosProductos).toHaveBeenLastCalledWith('cliente', 7, 5, false);
    await expect(servicio.ultimosProductos('empresa', 3)).resolves.toEqual({ tipo: 'empresa', id: 3, productos: [] });
    expect(repo.ultimosProductos).toHaveBeenCalledTimes(1);
  });

  it('id no válido → 400', async () => {
    const { servicio } = armar();
    await expect(servicio.ultimosProductos('cliente', NaN)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PosRapidoService.frecuentes (Fase 3.3)', () => {
  it('devuelve hasta 12 del local con lo justo para el botón y usa la caché', async () => {
    const { servicio, repo } = armar({ frecuentes: [fila(1), fila(2), fila(3)] });
    const r = await servicio.frecuentes(5);
    expect(repo.frecuentes).toHaveBeenCalledWith(5, 1, 30, 12, true, true);
    expect(r.productos[0]).toEqual({ id_producto: 1, nombre: 'P1', precio_venta: 10.5, descuento: 0, unidad_medida: 'NIU', stock: 4 });
    expect(r).toMatchObject({ id_almacen: 5, id_sucursal: 1, dias: 30 });
    await servicio.frecuentes(5);
    expect(repo.frecuentes).toHaveBeenCalledTimes(1);
  });

  it('con menos de 3 productos vendidos → lista vacía (el POS usa la suya)', async () => {
    const { servicio } = armar({ frecuentes: [fila(1), fila(2)] });
    await expect(servicio.frecuentes(5)).resolves.toMatchObject({ productos: [] });
  });

  it('sin venta_stock_salida o si la consulta falla → vacía; almacén inexistente → 404; sin id → 400', async () => {
    const sinSalida = armar({ capacidades: { ventaStockSalida: false }, frecuentes: [fila(1), fila(2), fila(3)] });
    await expect(sinSalida.servicio.frecuentes(5)).resolves.toMatchObject({ productos: [] });
    expect(sinSalida.repo.frecuentes).not.toHaveBeenCalled();

    const falla = armar();
    falla.repo.frecuentes.mockRejectedValue(new Error('boom'));
    await expect(falla.servicio.frecuentes(5)).resolves.toMatchObject({ productos: [] });

    await expect(armar({ sucursal: undefined }).servicio.frecuentes(99)).rejects.toBeInstanceOf(NotFoundException);
    await expect(armar().servicio.frecuentes(NaN)).rejects.toBeInstanceOf(BadRequestException);
  });
});
