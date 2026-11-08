import { CreditoRepository } from './credito.repository';

/** Repositorio con un DataSource falso que anota el SQL y los parámetros, sin tocar ninguna base de datos. */
function armar(respuestas: any[] = []) {
  const consultas: { sql: string; params: any[] }[] = [];
  const dataSource = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      consultas.push({ sql, params });
      return respuestas.length ? respuestas.shift() : [];
    }),
  };
  const esquema = { exigir: jest.fn().mockResolvedValue(undefined), tiene: jest.fn().mockResolvedValue(true) };
  return { repo: new CreditoRepository(dataSource as any, esquema as any), consultas };
}

describe('CreditoRepository · Fase F0', () => {
  it('listar devuelve el teléfono del deudor y el comprobante principal (serie-número) de la venta', async () => {
    const { repo, consultas } = armar([[{ total: 1 }], [{ id_cxc: 1, comprobante: 'F001-00000012', telefono: '987654321' }]]);

    const r = await repo.listar({});

    const sql = consultas[1].sql;
    expect(sql).toContain('AS telefono');
    expect(sql).toContain('c.telefono');
    expect(sql).toContain('e.telefonos');
    expect(sql).toContain("cp.serie || '-' || LPAD(cp.numero::text, 8, '0') AS comprobante");
    expect(sql).toContain('cp.id_venta = cxc.id_venta');
    expect(sql).toContain('cp.id_tipo IN (1, 2)');
    // El vigente (ni anulado ni con error) va primero.
    expect(sql).toContain("COALESCE(cp.anulado, FALSE) OR LOWER(COALESCE(cp.estado, '')) = 'error'");
    expect(r.data[0]).toMatchObject({ comprobante: 'F001-00000012', telefono: '987654321' });
  });

  it('obtener trae lo mismo que la lista', async () => {
    const { repo, consultas } = armar([[{ id_cxc: 7, comprobante: null, telefono: null }], []]);

    const cxc = await repo.obtener(7);

    expect(consultas[0].sql).toContain('AS telefono');
    expect(consultas[0].sql).toContain('comp.comprobante');
    expect(cxc).toMatchObject({ id_cxc: 7, comprobante: null, telefono: null, abonos: [] });
  });

  it('antigüedad: cuatro tramos calculados en SQL con la fecha de Lima, solo cuentas con saldo', async () => {
    const { repo, consultas } = armar([
      [{ al_dia_n: 2, al_dia_s: '300.00', t1_n: 1, t1_s: '50.50', t2_n: 0, t2_s: '0', t3_n: 3, t3_s: '1200.10' }],
    ]);

    const r = await repo.antiguedad();

    expect(r).toEqual({
      al_dia: { cuentas: 2, saldo: 300 },
      de_1_a_30: { cuentas: 1, saldo: 50.5 },
      de_31_a_60: { cuentas: 0, saldo: 0 },
      mas_de_60: { cuentas: 3, saldo: 1200.1 },
    });
    const sql = consultas[0].sql;
    expect(sql).toContain("America/Lima");
    expect(sql).toContain("estado IN ('pendiente', 'parcial', 'vencido')");
    expect(sql).toContain('cxc.saldo > 0');
    expect(sql).toContain('d BETWEEN 31 AND 60');
  });

  it('deuda vencida: total y las de mayor saldo con sus días de atraso', async () => {
    const { repo, consultas } = armar([
      [{ cuentas: 2, total: '900.00' }],
      [
        { deudor: 'Constructora Andina', saldo: '700.00', dias: 12, comprobante: 'F001-00000030' },
        { deudor: 'Luis Torres', saldo: '200.00', dias: 40, comprobante: null },
      ],
    ]);

    const r = await repo.deudaVencida(5);

    expect(r.cuentas).toBe(2);
    expect(r.total).toBe(900);
    expect(r.mayores[0]).toEqual({ deudor: 'Constructora Andina', saldo: 700, dias: 12, comprobante: 'F001-00000030' });
    expect(r.mayores[1].comprobante).toBeNull();
    expect(consultas[1].params).toEqual([5]);
    expect(consultas[1].sql).toContain('ORDER BY cxc.saldo DESC');
  });

  it('total vencido: solo COUNT + SUM, en números y con el mismo criterio que la deuda vencida', async () => {
    const { repo, consultas } = armar([[{ cuentas: '4', total: '1250.40' }]]);

    const r = await repo.totalVencido();

    expect(r).toEqual({ cuentas: 4, total: 1250.4 });
    expect(typeof r.cuentas).toBe('number');
    expect(typeof r.total).toBe('number');
    expect(consultas).toHaveLength(1);
    const sql = consultas[0].sql;
    expect(sql).toContain('COUNT(*)::int AS cuentas');
    expect(sql).toContain('SUM(cxc.saldo)');
    expect(sql).toContain("estado IN ('pendiente', 'parcial', 'vencido')");
    expect(sql).toContain('cxc.saldo > 0');
    expect(sql).not.toContain('LIMIT');
  });

  it('total vencido sin deuda: ceros', async () => {
    const { repo } = armar([[{ cuentas: 0, total: '0' }]]);
    await expect(repo.totalVencido()).resolves.toEqual({ cuentas: 0, total: 0 });
  });

  it('deuda vencida sigue lanzando sus dos consultas en paralelo (total compartido con totalVencido)', async () => {
    const pendientes: Array<(filas: any[]) => void> = [];
    const consultas: string[] = [];
    const dataSource = {
      query: jest.fn((sql: string) => new Promise<any[]>((resolver) => {
        consultas.push(sql);
        pendientes.push(resolver);
      })),
    };
    const esquema = { exigir: jest.fn().mockResolvedValue(undefined), tiene: jest.fn().mockResolvedValue(true) };
    const repo = new CreditoRepository(dataSource as any, esquema as any);

    const promesa = repo.deudaVencida(3);
    for (let i = 0; i < 5 && pendientes.length < 2; i++) await Promise.resolve();

    // Las dos consultas salen antes de que ninguna responda.
    expect(consultas).toHaveLength(2);
    expect(consultas[0]).toContain('COUNT(*)::int AS cuentas');
    expect(consultas[1]).toContain('LIMIT $1');
    pendientes[0]([{ cuentas: 1, total: '10.00' }]);
    pendientes[1]([]);
    await expect(promesa).resolves.toMatchObject({ cuentas: 1, total: 10, mayores: [] });
  });
});
