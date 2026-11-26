import { Logger } from '@nestjs/common';
import { BitacoraService } from './bitacora.service';
import { BitacoraRepository } from './bitacora.repository';
import { ACCIONES_BITACORA, ETIQUETA_ACCION_BITACORA } from './bitacora.acciones';

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

function crear(opciones: { tabla?: boolean; insertar?: jest.Mock; listar?: jest.Mock; catalogoFalla?: boolean } = {}) {
  const repo = {
    insertar: opciones.insertar ?? jest.fn(async () => undefined),
    listar: opciones.listar ?? jest.fn(async () => []),
  };
  const esquema = {
    tiene: jest.fn(async (c: string) => {
      if (opciones.catalogoFalla) throw new Error('sin conexión');
      return c === 'bitacora' && (opciones.tabla ?? true);
    }),
  };
  return { servicio: new BitacoraService(repo as never, esquema as never), repo, esquema };
}

describe('BitacoraService.registrar: nunca hace fallar la operación principal', () => {
  it('con la tabla: una fila con textos recortados, JSON sin secretos y la entidad como número', async () => {
    const { servicio, repo } = crear();

    await servicio.registrar({
      accion: ACCIONES_BITACORA.PRODUCTO_PRECIO_CAMBIADO,
      id_usuario: 4,
      rol: 'vendedor',
      entidad: 'producto',
      id_entidad: '77',
      antes: { precio_venta: 10, token: 'xyz' },
      despues: { precio_venta: 9 },
      motivo: '  ',
    });

    expect(repo.insertar).toHaveBeenCalledTimes(1);
    const [fila] = repo.insertar.mock.calls[0][0];
    expect(fila).toEqual({
      id_usuario: 4,
      rol: 'vendedor',
      id_autorizador: null,
      id_almacen: null,
      accion: 'producto.precio_cambiado',
      entidad: 'producto',
      id_entidad: 77,
      antes: JSON.stringify({ precio_venta: 10, token: '[omitido]' }),
      despues: JSON.stringify({ precio_venta: 9 }),
      motivo: null,
      ip: null,
    });
  });

  it('sin la tabla (fase19 sin correr) no inserta y no lanza', async () => {
    const { servicio, repo } = crear({ tabla: false });

    await expect(servicio.registrar({ accion: ACCIONES_BITACORA.INVENTARIO_AJUSTE, id_usuario: 4 })).resolves.toBeUndefined();

    expect(repo.insertar).not.toHaveBeenCalled();
  });

  it('si el INSERT falla o el catálogo no responde, solo avisa en el log', async () => {
    const falla = crear({ insertar: jest.fn(async () => { throw new Error('relation "bitacora_acciones" does not exist'); }) });
    await expect(falla.servicio.registrar({ accion: ACCIONES_BITACORA.VENTA_ANULADA })).resolves.toBeUndefined();

    const sinCatalogo = crear({ catalogoFalla: true });
    await expect(sinCatalogo.servicio.registrar({ accion: ACCIONES_BITACORA.VENTA_ANULADA })).resolves.toBeUndefined();
    await expect(sinCatalogo.servicio.disponible()).resolves.toBe(false);
  });

  it('registrarVarios: un solo INSERT para todas; un objeto vacío o sin acción no cuenta', async () => {
    const { servicio, repo } = crear();

    await servicio.registrarVarios([
      { accion: ACCIONES_BITACORA.VENTA_REBAJA_SOBRE_TOPE, entidad: 'venta', id_entidad: 9, antes: {} },
      { accion: ACCIONES_BITACORA.VENTA_BAJO_COSTO, entidad: 'venta', id_entidad: 9, id_autorizador: 1 },
      null as never,
    ]);
    await servicio.registrarVarios([]);

    expect(repo.insertar).toHaveBeenCalledTimes(1);
    const filas = repo.insertar.mock.calls[0][0];
    expect(filas.map((f: any) => f.accion)).toEqual(['venta.rebaja_sobre_tope', 'venta.bajo_costo']);
    expect(filas[0].antes).toBeNull();
    expect(filas[1].id_autorizador).toBe(1);
  });
});

describe('BitacoraService.registrarCon: el evento se arma dentro (B2, endurecimiento de B1)', () => {
  it('un evento, varios o ninguno: inserta lo que la fábrica devuelve (null y undefined no cuentan)', async () => {
    const { servicio, repo } = crear();

    await servicio.registrarCon(() => ({ accion: ACCIONES_BITACORA.VENTA_ANULADA, entidad: 'venta', id_entidad: 3 }));
    await servicio.registrarCon(() => [
      { accion: ACCIONES_BITACORA.VENTA_REBAJA_SOBRE_TOPE, entidad: 'venta', id_entidad: 9 },
      null,
      { accion: ACCIONES_BITACORA.VENTA_AUTORIZADA, entidad: 'venta', id_entidad: 9, id_autorizador: 1 },
    ]);
    await servicio.registrarCon(() => null);
    await servicio.registrarCon(() => []);

    expect(repo.insertar).toHaveBeenCalledTimes(2);
    expect(repo.insertar.mock.calls[0][0]).toHaveLength(1);
    expect(repo.insertar.mock.calls[1][0].map((f: any) => f.accion)).toEqual(['venta.rebaja_sobre_tope', 'venta.autorizada']);
  });

  it('si ARMAR el evento lanza (p. ej. un .map sobre null), no lanza, no inserta y avisa en el log', async () => {
    const { servicio, repo } = crear();
    const aviso = jest.spyOn(Logger.prototype, 'warn');
    aviso.mockClear();
    const resultado: { comprobantes_anulados: { numero_formateado: string }[] } = { comprobantes_anulados: null as never };

    await expect(
      servicio.registrarCon(() => ({
        accion: ACCIONES_BITACORA.VENTA_ANULADA,
        despues: { comprobantes: resultado.comprobantes_anulados.map((c) => c.numero_formateado) },
      })),
    ).resolves.toBeUndefined();

    expect(repo.insertar).not.toHaveBeenCalled();
    expect(aviso).toHaveBeenCalledWith(expect.stringContaining('No se pudo armar el evento de la bitácora'));
  });

  it('con la fábrica bien armada pero el INSERT fallando, tampoco lanza', async () => {
    const { servicio } = crear({ insertar: jest.fn(async () => { throw new Error('se cayó la conexión'); }) });
    await expect(servicio.registrarCon(() => ({ accion: ACCIONES_BITACORA.INVENTARIO_AJUSTE }))).resolves.toBeUndefined();
  });

  it('registrarVarios con algo que no es arreglo no lanza', async () => {
    const { servicio, repo } = crear();
    await expect(servicio.registrarVarios(null as never)).resolves.toBeUndefined();
    expect(repo.insertar).not.toHaveBeenCalled();
  });
});

describe('BitacoraService.listar (pantalla «Actividad»)', () => {
  it('sin la tabla responde vacío con disponible=false, sin consultar', async () => {
    const { servicio, repo } = crear({ tabla: false });

    await expect(servicio.listar({})).resolves.toEqual({ registros: [], siguiente: null, disponible: false });
    expect(repo.listar).not.toHaveBeenCalled();
  });

  it('pagina por cursor: con la página llena, siguiente = id del último; límite acotado a 200', async () => {
    const registros = [{ id: 30 }, { id: 20 }];
    const { servicio, repo } = crear({ listar: jest.fn(async () => registros) });

    await expect(servicio.listar({ limite: 2, antes_de: 40, accion: 'venta.anulada' })).resolves.toEqual({ registros, siguiente: 20, disponible: true });
    expect(repo.listar).toHaveBeenCalledWith({ limite: 2, antes_de: 40, accion: 'venta.anulada' });

    await servicio.listar({ limite: 999 });
    expect(repo.listar.mock.calls[1][0].limite).toBe(200);
    const corta = await servicio.listar({});
    expect(corta.siguiente).toBeNull();
  });
});

describe('BitacoraRepository (SQL)', () => {
  function armar(filas: any[] = []) {
    const dataSource = { query: jest.fn(async () => filas) };
    return { repo: new BitacoraRepository(dataSource as never), dataSource };
  }

  it('inserta todas las filas con un solo INSERT … unnest y castea el JSON a jsonb', async () => {
    const { repo, dataSource } = armar();

    await repo.insertar([
      { id_usuario: 4, rol: 'admin', id_autorizador: null, id_almacen: 2, accion: 'inventario.ajuste', entidad: 'producto', id_entidad: 7, antes: '{"stock":1}', despues: null, motivo: 'm', ip: null },
    ]);

    const [sql, params] = dataSource.query.mock.calls[0] as any[];
    expect(sql).toContain('INSERT INTO bitacora_acciones (id_usuario, rol, id_autorizador, id_almacen, accion, entidad, id_entidad, antes, despues, motivo, ip)');
    expect(sql).toContain('b.antes::jsonb');
    expect(sql).toContain('$8::text[]');
    expect(params).toHaveLength(11);
    expect(params[7]).toEqual(['{"stock":1}']);
  });

  it('lista con filtros de días de Lima sobre timestamptz, usuario, acción, entidad y cursor', async () => {
    const { repo, dataSource } = armar([{
      id: '5', fecha: new Date('2026-11-25T15:00:00Z'), id_usuario: 4, usuario: 'Ana Vende', rol: 'admin', id_autorizador: null,
      autorizador: null, id_almacen: 2, almacen: 'Principal', accion: 'venta.anulada', entidad: 'venta', id_entidad: '9',
      antes: null, despues: { estado: 'anulada' }, motivo: null, ip: null,
    }]);

    const filas = await repo.listar({ desde: '2026-11-01', hasta: '2026-11-25', id_usuario: 4, accion: 'venta.anulada', entidad: 'venta', id_entidad: 9, antes_de: 100, limite: 50 });

    const [sql, params] = dataSource.query.mock.calls[0] as any[];
    expect(sql).toContain("b.fecha >= (CAST($1 AS date)::timestamp AT TIME ZONE 'America/Lima')");
    expect(sql).toContain("b.fecha < ((CAST($2 AS date)::timestamp AT TIME ZONE 'America/Lima') + INTERVAL '1 day')");
    expect(sql).toContain('b.id < $7::bigint');
    expect(sql).toContain('ORDER BY b.id DESC');
    expect(sql).toContain('LIMIT $8');
    expect(params).toEqual(['2026-11-01', '2026-11-25', 4, 'venta.anulada', 'venta', 9, 100, 50]);
    expect(filas[0]).toMatchObject({ id: 5, fecha: '2026-11-25T15:00:00.000Z', usuario: 'Ana Vende', id_entidad: 9, despues: { estado: 'anulada' } });
  });

  it('sin filtros no arma WHERE', async () => {
    const { repo, dataSource } = armar();
    await repo.listar({ limite: 50 });
    const [sql, params] = dataSource.query.mock.calls[0] as any[];
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([50]);
  });
});

describe('Acciones de la bitácora', () => {
  it('cada acción tiene etiqueta y cabe en VARCHAR(60)', () => {
    for (const accion of Object.values(ACCIONES_BITACORA)) {
      expect(ETIQUETA_ACCION_BITACORA[accion]).toBeTruthy();
      expect(accion.length).toBeLessThanOrEqual(60);
    }
  });
});
