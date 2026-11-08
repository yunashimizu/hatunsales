import { ReportesRepository } from './reportes.repository';

/** QueryBuilder falso que anota cada llamada. */
function armar() {
  const llamadas: { metodo: string; args: any[] }[] = [];
  const qb: any = {};
  for (const metodo of ['leftJoinAndSelect', 'leftJoin', 'select', 'addSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy']) {
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
    expect(llamadas.find((l) => l.metodo === 'leftJoin')!.args).toEqual(['c.tipo', 'tipo']);
    expect(llamadas.some((l) => l.metodo === 'leftJoinAndSelect')).toBe(false);
    expect(llamadas.filter((l) => l.metodo === 'andWhere').map((l) => l.args[0])).toEqual(['c.id_tipo = :id_tipo']);
  });

  it('carga solo las columnas que usa el negocio, sin los textos largos de SUNAT', async () => {
    const { repo, llamadas } = armar();

    await repo.obtenerVentasPorPeriodo(new Date('2026-10-01T05:00:00Z'), new Date('2026-11-01T05:00:00Z'), {});

    const seleccion = llamadas
      .filter((l) => l.metodo === 'select' || l.metodo === 'addSelect')
      .flatMap((l) => (Array.isArray(l.args[0]) ? l.args[0] : [l.args[0]]))
      .map(String);
    const esperadas = [
      'c.id_comprobante', 'c.id_venta', 'c.serie', 'c.numero', 'c.total', 'c.estado', 'c.estado_sunat',
      'c.anulado', 'c.ambiente_fiscal', 'c.creado_en', 'c.fecha_de_emision', 'c.cliente_denominacion',
      'c.cliente_numero_doc', 'c.cliente_tipo_doc', 'tipo.id_tipo', 'tipo.nombre',
    ];
    expect(seleccion).toEqual(expect.arrayContaining(esperadas));
    expect(seleccion).toHaveLength(esperadas.length);
    for (const pesada of ['importe_en_letras', 'sunat_soap_error', 'sunat_observaciones']) {
      expect(seleccion.some((s) => s.includes(pesada))).toBe(false);
    }
    // El orden y el filtro de fechas no cambian.
    expect(llamadas.find((l) => l.metodo === 'orderBy')!.args).toEqual(['c.creado_en', 'ASC']);
    expect(llamadas.find((l) => l.metodo === 'addOrderBy')!.args).toEqual(['c.id_comprobante', 'ASC']);
  });

  it('no descarta anulados en SQL: la regla de lo que cuenta vive en ReportesBussnies', async () => {
    const { repo, llamadas } = armar();

    await repo.obtenerVentasPorPeriodo(new Date('2026-10-01T05:00:00Z'), new Date('2026-11-01T05:00:00Z'), {});

    const condiciones = llamadas.filter((l) => /where/i.test(l.metodo)).map((l) => String(l.args[0]));
    expect(condiciones.some((c) => c.includes('anulado'))).toBe(false);
  });
});

/** Repositorio con un consultor falso que anota el SQL y los parámetros de cada consulta. */
function armarSql(respuestas: any[] = []) {
  const consultas: { sql: string; params: any[] }[] = [];
  const manager = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      consultas.push({ sql, params });
      return respuestas.shift() ?? [];
    }),
  };
  return { repo: new ReportesRepository({ manager } as any), consultas };
}

describe('ReportesRepository · Fase F (rentabilidad, estancados, problemas, pedidos)', () => {
  it('rentabilidad: no consulta sin comprobantes y las notas de crédito restan cantidad, ingreso y costo', async () => {
    const { repo, consultas } = armarSql();

    expect(await repo.obtenerRentabilidadProductos([], 500)).toEqual([]);
    expect(consultas).toHaveLength(0);

    await repo.obtenerRentabilidadProductos([1, 2], 501);
    const { sql, params } = consultas[0];
    expect(params).toEqual([[1, 2], 7, 501]);
    expect(sql).toContain('ci.id_comprobante = ANY($1::int[])');
    expect(sql).toContain('COALESCE(pr.precio_compra, 0)');
    expect(sql).toContain('(CASE WHEN c.id_tipo = $2 THEN -1 ELSE 1 END) * COALESCE(ci.cantidad, 0) * COALESCE(pr.precio_compra, 0)');
    expect(sql).toContain('FILTER (WHERE c.id_tipo <> $2)');
  });

  it('rentabilidad: la venta sin IGV reparte el IGV del comprobante en proporción y también resta en la nota de crédito', async () => {
    const { repo, consultas } = armarSql();

    await repo.obtenerRentabilidadProductos([1], 10);

    const sql = consultas[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain('AS ingreso_sin_igv');
    expect(sql).toContain('(CASE WHEN c.id_tipo = $2 THEN -1 ELSE 1 END) * COALESCE(ci.total, 0) * COALESCE((c.total - COALESCE(c.total_igv, 0)) / NULLIF(c.total, 0), 1)');
    expect(sql).toContain('ORDER BY ingreso_sin_igv DESC');
  });

  it('estancados: activos con stock sumado de todos los almacenes, antiguos y con la misma regla de venta que el reporte', async () => {
    const { repo, consultas } = armarSql();

    await repo.obtenerProductosEstancados(new Date('2026-10-09T15:00:00Z'), 200);

    const { sql, params } = consultas[0];
    expect(params).toEqual(['2026-10-09 15:00:00.000', 200]);
    expect(sql).toContain('HAVING SUM(COALESCE(i.stock, 0)) > 0');
    expect(sql).toContain('COALESCE(p.estado, TRUE) = TRUE');
    expect(sql).toContain('p.creado_en < $1');
    expect(sql).toContain('ult.ultima_venta IS NULL OR ult.ultima_venta < $1');
    expect(sql).toContain("LOWER(COALESCE(c.estado, '')) NOT IN ('anulado', 'error')");
    expect(sql).toContain("UPPER(COALESCE(c.estado_sunat, '')) NOT IN ('ANULADO', 'RECHAZADO')");
    expect(sql).toContain("<> 'beta'");
    expect(sql).toContain('c.id_tipo <> 7');
  });

  it('comprobantes con problema: ni anulados ni de prueba, solo pendientes, con error, rechazados o con excepción', async () => {
    const { repo, consultas } = armarSql();

    await repo.obtenerComprobantesConProblema(5);

    expect(consultas[0].params).toEqual([5]);
    expect(consultas[0].sql).toContain('COALESCE(c.anulado, FALSE) = FALSE');
    expect(consultas[0].sql).toContain("<> 'beta'");
    expect(consultas[0].sql).toContain("c.estado IN ('pendiente', 'error')");
    expect(consultas[0].sql).toContain("IN ('RECHAZADO', 'EXCEPCION')");
  });

  it('pedidos web: cuenta pendientes y pagados, y un estado ausente vale 0', async () => {
    const { repo } = armarSql([[{ estado: 'pagado', total: '3' }]]);

    expect(await repo.contarPedidosWeb()).toEqual({ pendientes: 0, pagados: 3 });
  });
});
