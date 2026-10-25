import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RecepcionBussnies } from './recepcion.bussnies';

/**
 * Recepción de mercadería: el stock entra una sola vez y nunca a medias.
 *
 * El repositorio falso imita lo que garantiza PostgreSQL en el real: el UPDATE
 * condicional de la observación es atómico (solo una revisión encuentra la fila
 * 'pendiente') y lo que corre dentro de la transacción se deshace si algo falla.
 */
const tick = () => new Promise((r) => setTimeout(r, 0));

function armar(cantidad = 5) {
  const manager = { soy: 'manager-de-la-transaccion' };
  const obs: any = {
    id_observacion: 9,
    id_producto: 3,
    id_almacen: 1,
    nro_guia: 'G-100',
    cantidad: String(cantidad),
    estado: 'pendiente',
  };
  const stock = { unidades: 0 };

  const inventario = {
    ajustar: jest.fn(async (dto: any) => {
      await tick();
      stock.unidades += Number(dto.cantidad);
      return { stock: stock.unidades };
    }),
    ajustarEnTransaccion: jest.fn(async (_m: any, dto: any) => {
      await tick();
      stock.unidades += Number(dto.cantidad);
      return stock.unidades;
    }),
  };

  const repo: any = {
    asegurarSchema: jest.fn().mockResolvedValue(undefined),
    buscarObservacion: jest.fn(async () => ({ ...obs })),
    marcarObservacion: jest.fn(async (_id: number, estado: string) => {
      await tick();
      if (obs.estado !== 'pendiente') return null;
      obs.estado = estado;
      return { ...obs };
    }),
    revisarObservacion: jest.fn(async (_id: number, estado: string, _u: any, _c: any, alRevisar?: any) => {
      await tick();
      if (obs.estado !== 'pendiente') return { resultado: 'ya_revisada', estado: obs.estado };
      obs.estado = estado;
      const antes = stock.unidades;
      try {
        if (alRevisar) await alRevisar(manager, { ...obs });
      } catch (error) {
        obs.estado = 'pendiente';
        stock.unidades = antes;
        throw error;
      }
      return { resultado: 'revisada', observacion: { ...obs } };
    }),
    productosExistentes: jest.fn(async (ids: number[]) => new Set(ids.filter((id) => id !== 404))),
    registrarRecepcion: jest.fn(async (params: any, aplicarStock: any) => {
      const antes = stock.unidades;
      try {
        await aplicarStock(manager, { id_recepcion: 77 });
      } catch (error) {
        stock.unidades = antes;
        throw error;
      }
      return {
        id_recepcion: 77,
        observaciones: params.items
          .filter((i: any) => i.cantidad_observada > 0)
          .map((i: any, n: number) => ({ id_observacion: 100 + n, id_producto: i.id_producto, id_item: n + 1 })),
        repetida: false,
      };
    }),
    actualizarPrecioCompra: jest.fn().mockResolvedValue(undefined),
  };

  const archivos = { nombre: 'base_datos', guardar: jest.fn(), eliminar: jest.fn() };
  const servicio = new RecepcionBussnies(repo, inventario as any, archivos as any);
  return { servicio, repo, inventario, obs, stock, manager };
}

const cuerpo = (items: any[], extra: Record<string, unknown> = {}) => ({
  id_proveedor: 2,
  id_almacen: 1,
  nro_guia: 'G-100',
  items,
  ...extra,
});

describe('RecepcionBussnies · visto bueno de observaciones', () => {
  it('dos vistos buenos simultáneos (doble clic o dos usuarios) suman el stock una sola vez', async () => {
    const { servicio, stock, obs } = armar(5);

    const resultados = await Promise.allSettled([
      servicio.aprobarObservacion(9, { id_usuario: 1 } as any),
      servicio.aprobarObservacion(9, { id_usuario: 2 } as any),
    ]);

    expect(stock.unidades).toBe(5);
    expect(obs.estado).toBe('aprobado');
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rechazada = resultados.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rechazada.reason).toBeInstanceOf(BadRequestException);
    expect(rechazada.reason.message).toMatch(/ya fue revisada/);
  });

  it('un rechazo cruzado con un visto bueno nunca deja stock de una observación rechazada', async () => {
    const { servicio, stock, obs } = armar(5);

    await Promise.allSettled([
      servicio.rechazarObservacion(9, { id_usuario: 2 } as any),
      servicio.aprobarObservacion(9, { id_usuario: 1 } as any),
    ]);

    const coherente =
      (obs.estado === 'aprobado' && stock.unidades === 5) || (obs.estado === 'rechazado' && stock.unidades === 0);
    expect(coherente).toBe(true);
  });

  it('el stock se suma con el manager de la misma transacción que marca la observación', async () => {
    const { servicio, inventario, manager } = armar(4);

    const r = await servicio.aprobarObservacion(9, { id_usuario: 1 } as any, 'llegó completo');

    expect(r.stock_ingresado).toBe(4);
    expect(r.estado).toBe('aprobado');
    expect(inventario.ajustarEnTransaccion).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ id_producto: 3, id_almacen: 1, cantidad: 4, motivo: 'compra' }),
    );
    expect(inventario.ajustar).not.toHaveBeenCalled();
  });

  it('si el stock no se puede sumar, la observación sigue pendiente', async () => {
    const { servicio, inventario, obs, stock } = armar(5);
    inventario.ajustarEnTransaccion.mockRejectedValueOnce(new BadRequestException('Falta aplicar la migración'));

    await expect(servicio.aprobarObservacion(9)).rejects.toThrow('Falta aplicar la migración');
    expect(obs.estado).toBe('pendiente');
    expect(stock.unidades).toBe(0);
  });

  it('distingue una observación inexistente de una ya revisada', async () => {
    const { servicio, repo } = armar();
    repo.revisarObservacion.mockResolvedValueOnce({ resultado: 'no_existe' });
    await expect(servicio.rechazarObservacion(1234)).rejects.toBeInstanceOf(NotFoundException);

    repo.revisarObservacion.mockResolvedValueOnce({ resultado: 'ya_revisada', estado: 'aprobado' });
    await expect(servicio.rechazarObservacion(9)).rejects.toThrow('ya fue revisada (aprobado)');
  });
});

describe('RecepcionBussnies · confirmar recepción', () => {
  it('si una línea no puede sumar stock no queda nada a medias: falla toda la recepción', async () => {
    const { servicio, inventario, stock } = armar();
    inventario.ajustarEnTransaccion
      .mockImplementationOnce(async (_m: any, dto: any) => {
        stock.unidades += dto.cantidad;
        return stock.unidades;
      })
      .mockRejectedValueOnce(new BadRequestException('El stock resultante supera el máximo'));

    await expect(
      servicio.confirmar(
        cuerpo([
          { id_producto: 3, cantidad_ok: 2 },
          { id_producto: 8, cantidad_ok: 1 },
        ]),
      ),
    ).rejects.toThrow('supera el máximo');
    expect(stock.unidades).toBe(0);
  });

  it('suma lo OK dentro de la transacción de la recepción, en orden de producto', async () => {
    const { servicio, inventario, repo, manager } = armar();

    const r = await servicio.confirmar(
      cuerpo([
        { id_producto: 8, cantidad_ok: 1, precio_compra: 12.5 },
        { id_producto: 3, cantidad_ok: 2, cantidad_observada: 1, motivo_observacion: 'caja golpeada' },
      ]),
      { id_usuario: 4 } as any,
    );

    expect(repo.registrarRecepcion).toHaveBeenCalledTimes(1);
    const productosEnOrden = inventario.ajustarEnTransaccion.mock.calls.map((c: any[]) => c[1].id_producto);
    expect(productosEnOrden).toEqual([3, 8]);
    expect(inventario.ajustarEnTransaccion.mock.calls.every((c: any[]) => c[0] === manager)).toBe(true);
    expect(repo.actualizarPrecioCompra).toHaveBeenCalledWith(manager, 8, 12.5);
    expect(r.stock_ingresado).toEqual([3, 8]);
    expect(r.stock_fallido).toEqual([]);
    expect(r.repetida).toBe(false);
    expect(r.mensaje).toMatch(/espera visto bueno/);
  });

  it('pasa la clave de idempotencia (cuerpo o cabecera) y avisa cuando el reintento ya estaba registrado', async () => {
    const { servicio, repo, inventario } = armar();
    repo.registrarRecepcion.mockResolvedValueOnce({ id_recepcion: 77, observaciones: [], repetida: true });

    const r = await servicio.confirmar(cuerpo([{ id_producto: 3, cantidad_ok: 2 }]), undefined, 'clave-cabecera-1');

    expect(repo.registrarRecepcion.mock.calls[0][0].clave).toBe('clave-cabecera-1');
    expect(inventario.ajustarEnTransaccion).not.toHaveBeenCalled();
    expect(r.repetida).toBe(true);
    expect(r.stock_ingresado).toEqual([]);
    expect(r.mensaje).toMatch(/ya estaba registrada \(#77\)/);

    await servicio.confirmar(cuerpo([{ id_producto: 3, cantidad_ok: 2 }], { clave_idempotencia: 'clave-cuerpo' }));
    expect(repo.registrarRecepcion.mock.calls[1][0].clave).toBe('clave-cuerpo');
  });

  it('rechaza cantidades con decimales antes de registrar nada (el inventario es en unidades enteras)', async () => {
    const { servicio, repo } = armar();

    await expect(servicio.confirmar(cuerpo([{ id_producto: 3, cantidad_ok: 1.5 }]))).rejects.toThrow(
      /números enteros/,
    );
    expect(repo.registrarRecepcion).not.toHaveBeenCalled();
  });

  it('valida todos los productos con una sola consulta', async () => {
    const { servicio, repo } = armar();

    await expect(
      servicio.confirmar(
        cuerpo([
          { id_producto: 3, cantidad_ok: 1 },
          { id_producto: 404, cantidad_ok: 1 },
        ]),
      ),
    ).rejects.toThrow('Producto 404 no encontrado');
    expect(repo.productosExistentes).toHaveBeenCalledTimes(1);
    expect(repo.productosExistentes).toHaveBeenCalledWith([3, 404]);
    expect(repo.registrarRecepcion).not.toHaveBeenCalled();
  });
});
