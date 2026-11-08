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
