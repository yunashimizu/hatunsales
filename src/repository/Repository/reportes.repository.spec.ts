import { ReportesRepository } from './reportes.repository';

/** QueryBuilder falso que anota cada llamada. */
function armar() {
  const llamadas: { metodo: string; args: any[] }[] = [];
  const qb: any = {};
  for (const metodo of ['leftJoinAndSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy']) {
    qb[metodo] = jest.fn((...args: any[]) => {
      llamadas.push({ metodo, args });
      return qb;
    });
  }
  qb.getMany = jest.fn().mockResolvedValue([]);
  const repo = new ReportesRepository({ createQueryBuilder: jest.fn(() => qb) } as any);
  return { repo, llamadas };
}

describe('ReportesRepository.obtenerVentasPorPeriodo', () => {
  it('filtra [desde, hasta) con los instantes UTC de los días de Lima y trae el tipo', async () => {
    const { repo, llamadas } = armar();

    await repo.obtenerVentasPorPeriodo(
      new Date('2026-10-21T05:00:00Z'),
      new Date('2026-10-22T05:00:00Z'),
      { id_tipo: 7 },
    );

    const where = llamadas.find((l) => l.metodo === 'where')!;
    expect(where.args[0]).toBe('c.creado_en >= :desde AND c.creado_en < :hasta');
    expect(where.args[1]).toEqual({ desde: '2026-10-21 05:00:00.000', hasta: '2026-10-22 05:00:00.000' });
    expect(llamadas.find((l) => l.metodo === 'leftJoinAndSelect')!.args).toEqual(['c.tipo', 'tipo']);
    expect(llamadas.filter((l) => l.metodo === 'andWhere').map((l) => l.args[0])).toEqual(['c.id_tipo = :id_tipo']);
  });

  it('no descarta anulados en SQL: la regla de lo que cuenta vive en ReportesBussnies', async () => {
    const { repo, llamadas } = armar();

    await repo.obtenerVentasPorPeriodo(new Date('2026-10-01T05:00:00Z'), new Date('2026-11-01T05:00:00Z'), {});

    const condiciones = llamadas.filter((l) => /where/i.test(l.metodo)).map((l) => String(l.args[0]));
    expect(condiciones.some((c) => c.includes('anulado'))).toBe(false);
  });
});
