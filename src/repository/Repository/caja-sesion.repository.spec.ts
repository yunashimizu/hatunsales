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
function snapshotCaja(opciones: { conteo?: boolean; sucursal?: boolean; estado?: boolean } = {}): SnapshotEsquema {
  const { conteo = true, sucursal = true, estado = false } = opciones;
  const columnas = new Map<string, Set<string>>([
    ['aperturas_caja', new Set(['id_apertura', 'id_caja', 'fecha', 'monto_inicial', 'id_usuario'])],
    ['cierres_caja', new Set(['id_cierre', 'id_apertura', 'fecha', ...(conteo ? ['monto_conteo'] : [])])],
    ['cajas', new Set(['id_caja', 'nombre', ...(sucursal ? ['id_sucursal'] : []), ...(estado ? ['estado'] : [])])],
  ]);
  return new SnapshotEsquema(columnas, Date.now());
}

function armarCaja(opciones: { conteo?: boolean; sucursal?: boolean; estado?: boolean } = {}, respuesta: (sql: string) => any[] = () => []) {
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

describe('CajaSesionRepository.ocupantesDeCajas', () => {
  it('turnos sin cierre, uno por caja, con el mismo nombre y fecha que el listado de turnos', async () => {
    const { repo, query } = armarCaja({}, () => [
      { id_caja: 2, id_usuario: 9, usuario_nombre: 'Ana Quispe', abierta_en: '2026-11-09T13:05:00.000Z' },
      { id_caja: 4, id_usuario: null, usuario_nombre: null, abierta_en: null },
    ]);

    const mapa = await repo.ocupantesDeCajas();

    expect(mapa.get(2)).toEqual({ id_usuario: 9, usuario_nombre: 'Ana Quispe', abierta_en: '2026-11-09T13:05:00.000Z' });
    expect(mapa.get(4)).toEqual({ id_usuario: null, usuario_nombre: null, abierta_en: null });
    expect(mapa.has(1)).toBe(false);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM cierres_caja ci WHERE ci\.id_apertura = a\.id_apertura/);
    expect(sql).toMatch(/LEFT JOIN usuarios u ON u\.id_usuario = a\.id_usuario/);
    expect(sql).toMatch(/NULLIF\(TRIM\(CONCAT_WS\(' ', u\.nombre, u\.apellido_paterno\)\), ''\) AS usuario_nombre/);
    expect(sql).toMatch(/to_char\(a\.fecha, .+\) AS abierta_en/);
    expect(sql).toMatch(/DISTINCT ON \(a\.id_caja\)/);
    expect(sql).toMatch(/ORDER BY a\.id_caja, a\.fecha DESC, a\.id_apertura DESC/);
    expect(query.mock.calls[0][1]).toBeUndefined();
  });

  it('sin columna de fecha en aperturas_caja la hora llega NULL y la consulta no la nombra', async () => {
    const query = jest.fn(async (_sql: string) => []);
    const columnas = new Map<string, Set<string>>([
      ['aperturas_caja', new Set(['id_apertura', 'id_caja', 'id_usuario'])],
      ['cierres_caja', new Set(['id_cierre', 'id_apertura'])],
      ['cajas', new Set(['id_caja', 'nombre'])],
    ]);
    const esquema = { snapshot: jest.fn().mockResolvedValue(new SnapshotEsquema(columnas, Date.now())) };
    const repo = new CajaSesionRepository({ query } as any, esquema as any, {} as any);

    await repo.ocupantesDeCajas();

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/to_char\(NULL::timestamp, .+\) AS abierta_en/);
    expect(sql).toMatch(/ORDER BY a\.id_caja, a\.id_apertura DESC/);
  });
});

describe('CajaSesionRepository: hora de apertura y cierre (Fase A)', () => {
  /** Transacción simulada: sin turnos abiertos, la apertura 12 recién insertada y el cierre 40. */
  function armarTx() {
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO aperturas_caja')) return [{ id_apertura: 12 }];
        if (sql.includes('INSERT INTO cierres_caja')) return [{ id_cierre: 40 }];
        if (sql.includes('FOR UPDATE') && sql.includes('aperturas_caja')) return [{ id_apertura: 12 }];
        if (sql.includes('WHERE a.id_apertura = $1')) return [apertura];
        return [];
      }),
    };
    const dataSource = { query: jest.fn(), transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn(manager)) };
    const esquema = { snapshot: jest.fn().mockResolvedValue(snapshot(true)) };
    const repo = new CajaSesionRepository(dataSource as any, esquema as any, {} as any);
    const insert = (tabla: string) => String(manager.query.mock.calls.find((c: unknown[]) => String(c[0]).includes(`INSERT INTO ${tabla}`))?.[0] ?? '');
    return { repo, insert };
  }

  it('la apertura se fecha con clock_timestamp(), el mismo reloj que ventas.fecha', async () => {
    const { repo, insert } = armarTx();

    await repo.abrir({ idCaja: 1, idUsuario: 3, montoInicial: 50 });

    expect(insert('aperturas_caja')).toContain('clock_timestamp()');
    expect(insert('aperturas_caja')).not.toContain('NOW()');
  });

  it('el cierre se fecha con clock_timestamp(): la hora de cerrar, no la de empezar a esperar el candado', async () => {
    const { repo, insert } = armarTx();

    await expect(repo.cerrar({ idApertura: 12, idUsuario: 3, montoConteo: 80 }))
      .resolves.toMatchObject({ id_apertura: 12, id_cierre: 40, cerrada: true });

    expect(insert('cierres_caja')).toContain('clock_timestamp()');
    expect(insert('cierres_caja')).not.toContain('NOW()');
  });
});

/**
 * Fase 7: todos los locales, cajas con `activa`, alta y edición de cajas, y abrir una caja
 * desactivada. Las columnas se detectan del catálogo: sin `cajas.estado` toda caja es activa y
 * no se intenta escribir esa columna.
 */
describe('CajaSesionRepository · locales y cajas (Fase 7)', () => {
  const filaCaja = (o: Record<string, unknown> = {}) => ({
    id_caja: 1,
    nombre: 'Caja 1',
    id_sucursal: 1,
    sucursal_nombre: 'Lurín',
    activa: true,
    ocupada: false,
    sugerido_inicial: null,
    ...o,
  });

  it('listarLocales: todas las filas de sucursales por nombre, con dirección o null', async () => {
    const { repo, query } = armarCaja({}, () => [
      { id_sucursal: 2, nombre: 'Lurín', direccion: 'Av. Lima 123' },
      { id_sucursal: 5, nombre: 'Villa', direccion: '  ' },
    ]);
    expect(await repo.listarLocales()).toEqual([
      { id_sucursal: 2, nombre: 'Lurín', direccion: 'Av. Lima 123' },
      { id_sucursal: 5, nombre: 'Villa', direccion: null },
    ]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/FROM sucursales/);
    expect(sql).toMatch(/ORDER BY lower\(nombre\)/);
    expect(sql).not.toMatch(/\bWHERE\b/);
  });

  it('listarDisponibles con columna estado: activa = COALESCE(c.estado, TRUE) y lo mapea', async () => {
    const { repo, query } = armarCaja({ estado: true }, () => [filaCaja(), filaCaja({ id_caja: 2, activa: false })]);
    const items = await repo.listarDisponibles();
    expect(items.map((i) => i.activa)).toEqual([true, false]);
    expect(String(query.mock.calls[0][0])).toMatch(/COALESCE\(c\.estado, TRUE\) AS activa/);
  });

  it('sin columna estado: toda caja es activa y la consulta no nombra la columna', async () => {
    const { repo, query } = armarCaja({ estado: false }, () => [filaCaja({ activa: true })]);
    const items = await repo.listarDisponibles();
    expect(items[0].activa).toBe(true);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/TRUE AS activa/);
    expect(sql).not.toMatch(/c\.estado/);
  });

  /** Transacción simulada con las cajas que ya tiene el local 2. */
  function armarTx(opciones: { estado?: boolean; existentes?: string[]; localExiste?: boolean; ocupada?: boolean } = {}) {
    const { estado = true, existentes = [], localExiste = true, ocupada = false } = opciones;
    const manager = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM sucursales') && sql.includes('FOR UPDATE')) return localExiste ? [{ id_sucursal: 2 }] : [];
        if (sql.includes('SELECT nombre') && sql.includes('FROM cajas')) return existentes.map((nombre) => ({ nombre }));
        if (sql.includes('INSERT INTO cajas')) return [{ id_caja: 9 }];
        if (sql.includes('SELECT id_caja') && sql.includes('FOR UPDATE')) return [{ id_caja: 9, activa: true }];
        if (/^\s*SELECT 1\s+FROM aperturas_caja/.test(sql)) return ocupada ? [{ '?column?': 1 }] : [];
        if (sql.includes('AS sugerido_inicial')) return [filaCaja({ id_caja: 9, id_sucursal: 2, sucursal_nombre: 'Pachacámac' })];
        return [];
      }),
    };
    const dataSource = { query: jest.fn(), transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn(manager)) };
    const esquema = { snapshot: jest.fn().mockResolvedValue(snapshotCaja({ estado })) };
    const repo = new CajaSesionRepository(dataSource as any, esquema as any, {} as any);
    const llamadas = (frag: string) => manager.query.mock.calls.filter((c: unknown[]) => String(c[0]).includes(frag));
    return { repo, manager, llamadas };
  }

  it('crearCaja: bloquea el local antes de leer los nombres y de insertar; sin nombre pone «Caja 1»', async () => {
    const { repo, manager } = armarTx();
    const creada = await repo.crearCaja({ idSucursal: 2, nombre: null });
    const sqls = manager.query.mock.calls.map((c: unknown[]) => String(c[0]));
    const iLock = sqls.findIndex((q) => q.includes('FROM sucursales') && q.includes('FOR UPDATE'));
    const iNombres = sqls.findIndex((q) => q.includes('SELECT nombre'));
    const iInsert = sqls.findIndex((q) => q.includes('INSERT INTO cajas'));
    expect(iLock).toBe(0);
    expect(iNombres).toBeGreaterThan(iLock);
    expect(iInsert).toBeGreaterThan(iNombres);
    const insert = manager.query.mock.calls[iInsert] as unknown[];
    expect(insert[1]).toEqual([2, 'Caja 1']);
    expect(creada.id_caja).toBe(9);
  });

  it('crearCaja sin nombre toma el primer número libre del local (Caja 2 si ya hay Caja 1 y Caja 3)', async () => {
    const { repo, manager } = armarTx({ existentes: ['Caja 1', 'CAJA 3'] });
    await repo.crearCaja({ idSucursal: 2 });
    const insert = manager.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('INSERT INTO cajas')) as unknown[];
    expect(insert[1]).toEqual([2, 'Caja 2']);
  });

  it('crearCaja con un nombre ya usado en el local (sin distinguir mayúsculas) → CAJA_NOMBRE_REPETIDO y no inserta', async () => {
    const { repo, llamadas } = armarTx({ existentes: ['Caja Principal'] });
    await expect(repo.crearCaja({ idSucursal: 2, nombre: '  caja principal ' })).rejects.toThrow('CAJA_NOMBRE_REPETIDO');
    expect(llamadas('INSERT INTO cajas')).toHaveLength(0);
  });

  it('crearCaja en un local inexistente → SUCURSAL_NO_ENCONTRADA y no inserta', async () => {
    const { repo, llamadas } = armarTx({ localExiste: false });
    await expect(repo.crearCaja({ idSucursal: 99 })).rejects.toThrow('SUCURSAL_NO_ENCONTRADA');
    expect(llamadas('INSERT INTO cajas')).toHaveLength(0);
  });

  it('actualizarCaja: renombrar bloquea local y caja y compara contra las demás cajas del local', async () => {
    const { repo, manager, llamadas } = armarTx({ existentes: ['Caja 1'] });
    await expect(repo.actualizarCaja(9, { nombre: 'caja 1' })).rejects.toThrow('CAJA_NOMBRE_REPETIDO');
    expect(llamadas('UPDATE cajas')).toHaveLength(0);
    expect(manager.query.mock.calls.some((c: unknown[]) => String(c[0]).includes('FROM sucursales') && String(c[0]).includes('FOR UPDATE'))).toBe(true);

    const ok = armarTx({ existentes: ['Caja 1'] });
    await ok.repo.actualizarCaja(9, { nombre: ' Mostrador ' });
    const upd = ok.llamadas('UPDATE cajas')[0] as unknown[];
    expect(String(upd[0])).toMatch(/SET nombre = \$1/);
    expect(upd[1]).toEqual(['Mostrador', 9]);
  });

  it('actualizarCaja desactivar con turno abierto → CAJA_CON_TURNO_ABIERTO, con la caja bloqueada y sin escribir', async () => {
    const { repo, llamadas } = armarTx({ ocupada: true });
    await expect(repo.actualizarCaja(9, { activa: false })).rejects.toThrow('CAJA_CON_TURNO_ABIERTO');
    expect(llamadas('SELECT id_caja FROM cajas WHERE id_caja = $1 FOR UPDATE')).toHaveLength(1);
    expect(llamadas('UPDATE cajas')).toHaveLength(0);
  });

  it('actualizarCaja desactivar sin turno escribe estado = false; activar escribe true sin mirar turnos', async () => {
    const sin = armarTx({ ocupada: false });
    await sin.repo.actualizarCaja(9, { activa: false });
    expect((sin.llamadas('UPDATE cajas')[0] as unknown[])[1]).toEqual([false, 9]);

    const act = armarTx({ ocupada: true });
    await act.repo.actualizarCaja(9, { activa: true });
    expect((act.llamadas('UPDATE cajas')[0] as unknown[])[1]).toEqual([true, 9]);
  });

  it('sin columna estado no se intenta escribirla: CAJA_ESQUEMA_NO_SOPORTA', async () => {
    const { repo, manager } = armarTx({ estado: false });
    await expect(repo.actualizarCaja(9, { activa: false })).rejects.toThrow('CAJA_ESQUEMA_NO_SOPORTA');
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('abrir una caja desactivada → CAJA_DESACTIVADA y no inserta el turno', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM cajas WHERE id_caja = $1 FOR UPDATE')) return [{ id_caja: 3, activa: false }];
        return [];
      }),
    };
    const dataSource = { query: jest.fn(), transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn(manager)) };
    const esquema = { snapshot: jest.fn().mockResolvedValue(snapshotCaja({ estado: true })) };
    const repo = new CajaSesionRepository(dataSource as any, esquema as any, {} as any);

    await expect(repo.abrir({ idCaja: 3, idUsuario: 7, montoInicial: 0 })).rejects.toThrow('CAJA_DESACTIVADA');
    expect(manager.query.mock.calls.some((c: unknown[]) => String(c[0]).includes('INSERT INTO aperturas_caja'))).toBe(false);
    expect(String(manager.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('FOR UPDATE'))?.[0])).toMatch(/COALESCE\(estado, TRUE\) AS activa/);
  });
});
