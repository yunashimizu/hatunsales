import { CajaSesionRepository } from './caja-sesion.repository';
import { SnapshotEsquema } from '../../caja/esquema/esquema-caja.service';
import { sqlEsperadoTurno } from '../../caja/arqueo/sql-esperado';

/**
 * El resumen del turno (GET /caja/sesion, dashboard, cierre) debe contar lo mismo que el
 * arqueo: solo ventas de mostrador. Una venta web asignada a la caja abierta se cobró
 * fuera de la gaveta y no puede inflar el total del cajero.
 */
function snapshot(conOrigen: boolean): SnapshotEsquema {
  const columnas = new Map<string, Set<string>>([
    ['ventas', new Set(['id_venta', 'id_caja', 'fecha', 'total', 'estado', ...(conOrigen ? ['origen'] : [])])],
    ['aperturas_caja', new Set(['id_apertura', 'id_caja', 'fecha', 'monto_inicial', 'id_usuario'])],
    ['cierres_caja', new Set(['id_cierre', 'id_apertura', 'fecha', 'monto_conteo', 'monto_final'])],
    ['cajas', new Set(['id_caja', 'nombre'])],
  ]);
  return new SnapshotEsquema(columnas, Date.now());
}

function armar(conOrigen: boolean) {
  const query = jest.fn(async (sql: string) =>
    sql.includes('GROUP BY') ? [{ metodo: 'Efectivo', total: '80.00', cantidad: 2 }] : [{ ventas: 2, total: '80.00' }],
  );
  const esquema = { snapshot: jest.fn().mockResolvedValue(snapshot(conOrigen)) };
  const repo = new CajaSesionRepository({ query } as any, esquema as any, {} as any);
  return { repo, query };
}

const apertura = {
  id_apertura: 12,
  id_caja: 1,
  caja_nombre: 'Caja 1',
  id_sucursal: 1,
  sucursal_nombre: 'Principal',
  id_usuario: 3,
  fecha: '2026-10-21T13:00:00.000Z',
  monto_inicial: 50,
};

describe('CajaSesionRepository.resumenTurno', () => {
  it('cuenta solo ventas de mostrador en el total y en el desglose por método', async () => {
    const { repo, query } = armar(true);

    const resumen = await repo.resumenTurno(apertura);

    expect(resumen).toEqual({ ventas: 2, total: 80, por_metodo: [{ metodo: 'Efectivo', total: 80, cantidad: 2 }] });
    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql] of query.mock.calls) {
      expect(sql).toMatch(/COALESCE\(v\.origen, 'mostrador'\) = 'mostrador'/);
      expect(sql).toMatch(/COALESCE\(v\.estado, 'activa'\) <> 'anulada'/);
    }
  });

  it('usa el mismo criterio de origen que el efectivo esperado del arqueo', async () => {
    const { repo, query } = armar(true);
    await repo.resumenTurno(apertura);

    const arqueo = sqlEsperadoTurno({ conAbonos: false, movimientosPorTurno: true, conEstado: true, conOrigen: true });
    expect(arqueo).toMatch(/vs\.origen = 'mostrador'/);
    expect(arqueo).toMatch(/COALESCE\(v\.origen, 'mostrador'\)/);
    expect(query.mock.calls[0][0]).toMatch(/COALESCE\(v\.origen, 'mostrador'\) = 'mostrador'/);
  });

  it('en un esquema sin ventas.origen no filtra por origen (todas son de mostrador)', async () => {
    const { repo, query } = armar(false);

    await repo.resumenTurno(apertura);

    for (const [sql] of query.mock.calls) expect(sql).not.toMatch(/origen/);
  });
});

/**
 * T3: sugerido_inicial en disponibles y turnos del arqueo por sucursal. El SQL se arma según las
 * columnas que existan y todo valor del usuario va como parámetro ($n), nunca en el texto.
 */
function snapshotCaja(opciones: { conteo?: boolean; sucursal?: boolean } = {}): SnapshotEsquema {
  const { conteo = true, sucursal = true } = opciones;
  const columnas = new Map<string, Set<string>>([
    ['aperturas_caja', new Set(['id_apertura', 'id_caja', 'fecha', 'monto_inicial', 'id_usuario'])],
    ['cierres_caja', new Set(['id_cierre', 'id_apertura', 'fecha', ...(conteo ? ['monto_conteo'] : [])])],
    ['cajas', new Set(['id_caja', 'nombre', ...(sucursal ? ['id_sucursal'] : [])])],
  ]);
  return new SnapshotEsquema(columnas, Date.now());
}

function armarCaja(opciones: { conteo?: boolean; sucursal?: boolean } = {}, respuesta: (sql: string) => any[] = () => []) {
  const query = jest.fn(async (sql: string, _params?: unknown[]) => respuesta(sql));
  const esquema = { snapshot: jest.fn().mockResolvedValue(snapshotCaja(opciones)) };
  const repo = new CajaSesionRepository({ query } as any, esquema as any, {} as any);
  return { repo, query };
}

describe('CajaSesionRepository · sugerido_inicial', () => {
  it('listarDisponibles trae el efectivo contado del último cierre de cada caja', async () => {
    const { repo, query } = armarCaja({}, () => [
      { id_caja: 1, nombre: 'Caja 1', id_sucursal: 1, sucursal_nombre: 'Principal', ocupada: false, sugerido_inicial: '120.50' },
      { id_caja: 2, nombre: 'Caja 2', id_sucursal: null, sucursal_nombre: null, ocupada: true, sugerido_inicial: null },
    ]);

    const items = await repo.listarDisponibles();

    expect(items.map((i) => i.sugerido_inicial)).toEqual([120.5, null]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/ci\.monto_conteo::text/);
    expect(sql).toMatch(/a2\.id_caja = c\.id_caja/);
    expect(sql).toMatch(/ORDER BY a2\.id_apertura DESC\s+LIMIT 1/);
  });

  it('sin columna de conteo en cierres_caja el sugerido es NULL y la consulta no falla', async () => {
    const { repo, query } = armarCaja({ conteo: false }, () => [
      { id_caja: 1, nombre: 'Caja 1', id_sucursal: 1, sucursal_nombre: 'Principal', ocupada: false, sugerido_inicial: null },
    ]);

    const items = await repo.listarDisponibles();

    expect(items[0].sugerido_inicial).toBeNull();
    expect(String(query.mock.calls[0][0])).toMatch(/NULL::text\) AS sugerido_inicial|NULL::text AS sugerido_inicial/);
    expect(String(query.mock.calls[0][0])).not.toMatch(/monto_conteo/);
  });

  it('sugeridoInicial de una caja: monto del último cierre o null', async () => {
    const con = armarCaja({}, () => [{ sugerido: '75.00' }]);
    expect(await con.repo.sugeridoInicial(3)).toBe(75);
    expect(con.query.mock.calls[0][1]).toEqual([3]);

    const sin = armarCaja({}, () => [{ sugerido: null }]);
    expect(await sin.repo.sugeridoInicial(3)).toBeNull();

    const sinColumna = armarCaja({ conteo: false });
    expect(await sinColumna.repo.sugeridoInicial(3)).toBeNull();
    expect(sinColumna.query).not.toHaveBeenCalled();
  });
});

describe('CajaSesionRepository.listarTurnos', () => {
  const fila = {
    id_apertura: 10,
    id_caja: 1,
    caja_nombre: 'Caja 1',
    id_sucursal: 1,
    sucursal_nombre: 'Principal',
    id_usuario: 7,
    usuario_nombre: 'Rosa',
    abierta_en: '2026-11-05T13:00:00.000Z',
    cerrada_en: null,
    monto_inicial: null,
    monto_conteo: null,
    cerrada: false,
  };

  it('pagina con LIMIT/OFFSET parametrizados y cuenta aparte; monto_inicial NULL sigue null', async () => {
    const { repo, query } = armarCaja({}, (sql) => (sql.includes('COUNT(*)') ? [{ total: 41 }] : [fila]));

    const r = await repo.listarTurnos(
      { idSucursal: 1, idCaja: 2, idUsuario: 7, desde: '2026-11-01', hasta: '2026-11-05' },
      { limite: 20, offset: 40 },
    );

    expect(r.total).toBe(41);
    expect(r.filas[0].monto_inicial).toBeNull();
    expect(r.filas[0].cerrada).toBe(false);

    const [sqlLista, paramsLista] = query.mock.calls.find(([s]) => !String(s).includes('COUNT(*)'))!;
    expect(paramsLista).toEqual([1, 2, 7, '2026-11-01', '2026-11-05', 20, 40]);
    expect(sqlLista).toMatch(/c\.id_sucursal = \$1/);
    expect(sqlLista).toMatch(/a\.id_caja = \$2/);
    expect(sqlLista).toMatch(/a\.id_usuario = \$3/);
    expect(sqlLista).toMatch(/CAST\(\$4 AS date\)/);
    expect(sqlLista).toMatch(/CAST\(\$5 AS date\) \+ 1/);
    expect(sqlLista).toMatch(/LIMIT \$6 OFFSET \$7/);
    // Nada del filtro viaja en el texto del SQL.
    expect(sqlLista).not.toMatch(/2026-11/);

    const [sqlConteo, paramsConteo] = query.mock.calls.find(([s]) => String(s).includes('COUNT(*)'))!;
    expect(paramsConteo).toEqual([1, 2, 7, '2026-11-01', '2026-11-05']);
    expect(sqlConteo).not.toMatch(/LIMIT|OFFSET/);
  });

  it('sin página devuelve todos los turnos y no hace el conteo', async () => {
    const { repo, query } = armarCaja({}, () => [fila, { ...fila, id_apertura: 11 }]);
    const r = await repo.listarTurnos({ desde: '2026-11-01', hasta: '2026-11-05' });
    expect(r.filas).toHaveLength(2);
    expect(r.total).toBe(2);
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).not.toMatch(/OFFSET|LIMIT \$/);
  });

  it('una entrada hostil queda como parámetro, no en el SQL', async () => {
    const { repo, query } = armarCaja({});
    await repo.listarTurnos({ desde: "2026-11-01'; DROP TABLE cajas;--" });
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toMatch(/DROP/);
    expect(params).toEqual(["2026-11-01'; DROP TABLE cajas;--"]);
  });

  it('sin columna id_sucursal en cajas: filtrar por sucursal no devuelve nada y no falla', async () => {
    const { repo, query } = armarCaja({ sucursal: false });
    await repo.listarTurnos({ idSucursal: 3 });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/WHERE FALSE/);
    expect(sql).not.toMatch(/sucursales/);
    expect(query.mock.calls[0][1]).toEqual([]);
  });

  it('sin monto_conteo en cierres_caja el contado llega null', async () => {
    const { repo, query } = armarCaja({ conteo: false }, () => [fila]);
    const r = await repo.listarTurnos({});
    expect(r.filas[0].monto_conteo).toBeNull();
    expect(String(query.mock.calls[0][0])).not.toMatch(/monto_conteo::text/);
  });

  it('convierte los montos a Dinero (texto NUMERIC exacto)', async () => {
    const { repo } = armarCaja({}, () => [{ ...fila, cerrada: true, monto_inicial: '50.00', monto_conteo: '190.10' }]);
    const [t] = (await repo.listarTurnos({})).filas;
    expect(t.monto_inicial!.aNumero()).toBe(50);
    expect(t.monto_conteo!.aNumero()).toBe(190.1);
    expect(t.cerrada).toBe(true);
  });

  it('sucursalesDeUsuario y sucursalDeCaja', async () => {
    const a = armarCaja({}, () => [{ id_sucursal: 1 }, { id_sucursal: null }]);
    expect(await a.repo.sucursalesDeUsuario(7)).toEqual([1, null]);
    expect(a.query.mock.calls[0][1]).toEqual([7]);

    const b = armarCaja({}, () => []);
    expect(await b.repo.sucursalDeCaja(99)).toBeUndefined();
    const c = armarCaja({}, () => [{ id_sucursal: null }]);
    expect(await c.repo.sucursalDeCaja(2)).toBeNull();
  });
});
