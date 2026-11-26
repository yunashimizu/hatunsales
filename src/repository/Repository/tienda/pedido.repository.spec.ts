import { PedidoRepository } from './pedido.repository';

function armar(filas: unknown) {
  const query = jest.fn(async () => filas);
  const pedidoRepo = { manager: { query } };
  const repo = new PedidoRepository(pedidoRepo as any, {} as any, {} as any, {} as any);
  return { repo, query };
}

describe('PedidoRepository · contarPorPreparar', () => {
  it('cuenta pendientes y pagados en una sola consulta agrupada', async () => {
    const { repo, query } = armar([{ estado: 'pagado', total: '3' }]);

    await expect(repo.contarPorPreparar()).resolves.toEqual({ pendientes: 0, pagados: 3 });
    expect(query).toHaveBeenCalledTimes(1);
    const sql = String((query.mock.calls[0] as unknown[])[0]);
    expect(sql).toMatch(/COUNT\(\*\)/);
    expect(sql).toMatch(/estado IN \('pendiente', 'pagado'\)/);
    expect(sql).toMatch(/GROUP BY estado/);
  });

  it('sin pedidos devuelve ceros', async () => {
    const { repo } = armar([]);
    await expect(repo.contarPorPreparar()).resolves.toEqual({ pendientes: 0, pagados: 0 });
  });

  it('lee ambos estados', async () => {
    const { repo } = armar([{ estado: 'pendiente', total: 2 }, { estado: 'pagado', total: 5 }]);
    await expect(repo.contarPorPreparar()).resolves.toEqual({ pendientes: 2, pagados: 5 });
  });
});

describe('PedidoRepository · Fase 8.2 (vencimiento)', () => {
  function armarTx(candado: boolean, filas: unknown[] = []) {
    const query = jest.fn(async (sql: string, _params?: unknown[]): Promise<any> => {
      if (sql.includes('pg_try_advisory_xact_lock')) return [{ ok: candado }];
      return filas;
    });
    const manager = { query, transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn({ query })) };
    const repo = new PedidoRepository({ manager } as any, {} as any, {} as any, {} as any);
    return { repo, query };
  }

  it('busca con candado de réplica; las clases sin horas no vencen; contra entrega y crédito nunca; nada con cobro en curso', async () => {
    const { repo, query } = armarTx(true, [{ id_pedido: 57, clase: 'transferencia' }]);

    await expect(repo.pedidosVencidos({ pasarela: 0, transferencia: 48 }, 50))
      .resolves.toEqual([{ id_pedido: 57, clase: 'transferencia', horas: 48 }]);

    const [sql, params] = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(sql).toContain("WHEN LOWER(COALESCE(mp.tipo, '')) IN ('tarjeta', 'pasarela') THEN 'pasarela'");
    expect(sql).toContain("WHEN LOWER(COALESCE(mp.tipo, '')) IN ('efectivo', 'credito') THEN NULL");
    expect(sql).toContain("AND pp.estado IN ('pendiente', 'aprobado')");
    expect(sql).toContain("p.estado = 'pendiente'");
    expect(sql).toContain('p.id_venta IS NULL');
    expect(params).toEqual([0, 48, 50]);
  });

  it('otra réplica tiene el candado: no busca nada; con ambas horas en 0 ni abre la transacción', async () => {
    const ocupado = armarTx(false);
    await expect(ocupado.repo.pedidosVencidos({ pasarela: 24, transferencia: 48 }, 50)).resolves.toEqual([]);
    expect(ocupado.query).toHaveBeenCalledTimes(1);

    const apagado = armarTx(true);
    await expect(apagado.repo.pedidosVencidos({ pasarela: 0, transferencia: 0 }, 50)).resolves.toEqual([]);
    expect(apagado.query).not.toHaveBeenCalled();
  });

  it('transicionarEstado: con sinPagoEnCurso el UPDATE condicional excluye cobros pendientes o aprobados; devuelve el cupón del pedido', async () => {
    const query = jest.fn(async (): Promise<any> => [{ id_pedido: 57, stock_reservado: true, id_venta: null, id_cupon: 8 }]);
    const estados = { create: (x: any) => x, save: jest.fn(async (x: any) => x) };
    const manager = { query, getRepository: () => estados };
    const repo = new PedidoRepository({} as any, {} as any, estados as any, {} as any);

    const fila = await repo.transicionarEstado(57, ['pendiente'], 'cancelado', 'Vencido', manager as any, { sinVentaVigente: true, sinPagoEnCurso: true });

    expect(fila).toEqual({ id_pedido: 57, stock_reservado: true, id_venta: null, id_cupon: 8 });
    const sql = String((query.mock.calls[0] as unknown[])[0]);
    expect(sql).toContain("AND pp.estado IN ('pendiente', 'aprobado')");
    expect(sql).toContain('RETURNING p.id_pedido, p.stock_reservado, p.id_venta, p.id_cupon');
  });
});
