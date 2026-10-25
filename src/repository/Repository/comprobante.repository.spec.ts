import { Brackets } from 'typeorm';
import { ComprobanteRepository, FilaComprobanteNueva, FilaItemNueva, NumeroOcupadoError } from './comprobante.repository';

const COLUMNAS_FASE9 = [
  'comprobantes.forma_pago',
  'comprobantes.cuotas',
  'comprobantes.fecha_limite_envio',
  'comprobantes.doc_modificado_tipo',
  'comprobantes.doc_modificado_serie',
  'comprobantes.doc_modificado_numero',
  'comprobantes.id_comprobante_modificado',
  'comprobantes.nota_motivo',
  'comprobantes.nota_sustento',
  'fiscal_envios.respuesta_json',
  'fiscal_envios.bloqueado_hasta',
];

function fila(parcial: Partial<FilaComprobanteNueva> = {}): FilaComprobanteNueva {
  return {
    id_venta: 9,
    id_cliente: null,
    id_tipo: 2,
    id_moneda: 1,
    serie: 'B001',
    numero: 5,
    cliente_tipo_doc: 1,
    cliente_numero_doc: '00000000',
    cliente_denominacion: 'CLIENTES VARIOS',
    cliente_direccion: null,
    cliente_email: null,
    fecha_de_emision: '21-10-2026',
    fecha_de_vencimiento: '21-10-2026',
    porcentaje_igv: 18,
    total_gravada: 16.61,
    total_exonerada: 0,
    total_inafecta: 0,
    total_descuento: 0.4,
    total_igv: 2.99,
    total: 19.6,
    importe_en_letras: 'DIECINUEVE CON 60/100 SOLES',
    observaciones: '',
    enviar_cliente: false,
    ambiente_fiscal: 'produccion',
    id_usuario: 3,
    ...parcial,
  };
}

const ITEM: FilaItemNueva = {
  id_producto: 7,
  unidad_de_medida: 'NIU',
  codigo: 'CEM-01',
  codigo_producto_sunat: null,
  descripcion: 'CEMENTO',
  cantidad: 2,
  valor_unitario: 8.305085,
  precio_unitario: 10,
  descuento: 0.4,
  subtotal: 16.61,
  tipo_de_igv: 1,
  igv: 2.99,
  total: 19.6,
  id_item_origen: 401,
};

/** Consultor falso: responde MAX(numero), el catálogo y los INSERT, y anota cada SQL en orden. */
function crearConsultor(opciones: { maximo?: number; columnas?: string[]; errorInsert?: unknown } = {}) {
  const sqls: { sql: string; parametros: unknown[] }[] = [];
  const consultor = {
    query: jest.fn(async (sql: string, parametros: unknown[] = []): Promise<any> => {
      sqls.push({ sql, parametros });
      if (/pg_advisory_xact_lock/.test(sql)) return [{}];
      if (/MAX\(numero\)/.test(sql)) return [{ ultimo: opciones.maximo ?? 4 }];
      if (/information_schema\.columns/.test(sql)) return (opciones.columnas ?? COLUMNAS_FASE9).map((columna) => ({ columna }));
      if (/^\s*INSERT INTO comprobantes\s*\(/.test(sql)) {
        if (opciones.errorInsert) throw opciones.errorInsert;
        return [{ id_comprobante: 77 }];
      }
      if (/INSERT INTO comprobante_items/.test(sql)) return [];
      throw new Error(`SQL no previsto: ${sql.slice(0, 80)}`);
    }),
  };
  return { consultor, sqls };
}

function crearRepositorio(extra: Record<string, unknown> = {}, dataSource: Record<string, unknown> = {}) {
  return new ComprobanteRepository({ manager: { connection: { query: jest.fn(), ...dataSource } }, ...extra } as never);
}

describe('ComprobanteRepository', () => {
  describe('reservarCorrelativo (dentro de la transacción del motor)', () => {
    it('candado de la serie, relectura del siguiente número e INSERT, sin resincronizar secuencias', async () => {
      const { consultor, sqls } = crearConsultor({ maximo: 4 });

      const id = await crearRepositorio().reservarCorrelativo(consultor, fila({ numero: 5 }), [ITEM]);

      expect(id).toBe(77);
      expect(sqls[0]).toEqual({ sql: expect.stringContaining('pg_advisory_xact_lock'), parametros: ['comprobante:B001'] });
      expect(sqls[1].sql).toContain('MAX(numero)');
      expect(sqls.some((s) => /setval|DO \$seq\$|pg_get_serial_sequence/.test(s.sql))).toBe(false);
      const insert = sqls.find((s) => /^\s*INSERT INTO comprobantes/.test(s.sql))!;
      expect(insert.sql).toContain('RETURNING id_comprobante');
      expect(insert.parametros).toEqual(expect.arrayContaining(['B001', 5, 'pendiente', 'sunat_directo', 'NO_ENVIADO', 'produccion', 3]));
    });

    it('si el candidato ya no es el siguiente lanza NumeroOcupadoError sin insertar', async () => {
      const { consultor, sqls } = crearConsultor({ maximo: 5 });

      const error = await crearRepositorio().reservarCorrelativo(consultor, fila({ numero: 5 }), [ITEM]).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NumeroOcupadoError);
      expect(error).toMatchObject({ serie: 'B001', numero: 5, siguiente: 6 });
      expect(sqls.some((s) => /INSERT/.test(s.sql))).toBe(false);
    });

    it('acepta un candidato mayor que el siguiente (se saltó un número que SUNAT ya tiene)', async () => {
      const { consultor } = crearConsultor({ maximo: 0 });

      await expect(crearRepositorio().reservarCorrelativo(consultor, fila({ numero: 2 }), [ITEM])).resolves.toBe(77);
    });

    it('el correlativo inicial de la serie es el piso del siguiente número', async () => {
      const { consultor } = crearConsultor({ maximo: 3 });
      const repo = crearRepositorio();

      await expect(repo.reservarCorrelativo(consultor, fila({ numero: 4 }), [ITEM], 120)).rejects.toMatchObject({ siguiente: 120 });
      await expect(repo.reservarCorrelativo(consultor, fila({ numero: 120 }), [ITEM], 120)).resolves.toBe(77);
    });

    it('el índice único de serie y número se traduce a NumeroOcupadoError; otro 23505 se relanza tal cual', async () => {
      const duplicado = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq_comprobantes_serie_numero' });
      const { consultor } = crearConsultor({ maximo: 4, errorInsert: duplicado });
      await expect(crearRepositorio().reservarCorrelativo(consultor, fila(), [ITEM])).rejects.toBeInstanceOf(NumeroOcupadoError);

      const otro = Object.assign(new Error('duplicate key comprobantes_pkey'), { code: '23505', constraint: 'comprobantes_pkey' });
      const segundo = crearConsultor({ maximo: 4, errorInsert: otro });
      await expect(crearRepositorio().reservarCorrelativo(segundo.consultor, fila(), [ITEM])).rejects.toBe(otro);
    });

    it('una nota guarda su enlace; los efectos e id_item_origen solo si existen las columnas de fase14', async () => {
      const nota = fila({
        id_tipo: 7,
        serie: 'BC01',
        nota: {
          doc_modificado_tipo: '03',
          doc_modificado_serie: 'B001',
          doc_modificado_numero: 12,
          id_comprobante_modificado: 40,
          nota_motivo: '06',
          nota_sustento: 'Devolución total',
          efecto_nota: 'devolucion',
          reingresar_stock: true,
        },
      });

      const sinFase14 = crearConsultor();
      await crearRepositorio().reservarCorrelativo(sinFase14.consultor, nota, [ITEM]);
      const insert = sinFase14.sqls.find((s) => /^\s*INSERT INTO comprobantes/.test(s.sql))!;
      expect(insert.sql).toContain('id_comprobante_modificado');
      expect(insert.sql).not.toContain('efecto_nota');
      expect(sinFase14.sqls.find((s) => /comprobante_items/.test(s.sql))!.sql).not.toContain('id_item_origen');

      const conFase14 = crearConsultor({
        columnas: [...COLUMNAS_FASE9, 'comprobantes.efecto_nota', 'comprobantes.reingresar_stock', 'comprobantes.efectos_aplicados', 'comprobante_items.id_item_origen'],
      });
      await crearRepositorio().reservarCorrelativo(conFase14.consultor, nota, [ITEM]);
      const insertNuevo = conFase14.sqls.find((s) => /^\s*INSERT INTO comprobantes/.test(s.sql))!;
      expect(insertNuevo.sql).toContain('efectos_aplicados');
      expect(insertNuevo.parametros).toEqual(expect.arrayContaining(['devolucion', true, false]));
      const items = conFase14.sqls.find((s) => /comprobante_items/.test(s.sql))!;
      expect(items.sql).toContain('id_item_origen');
      expect(items.parametros).toContainEqual([401]);
    });

    it('sin las columnas de enlace de fase 9 no guarda una nota a medias', async () => {
      const { consultor } = crearConsultor({ columnas: [] });
      const nota = fila({
        id_tipo: 7,
        nota: {
          doc_modificado_tipo: '03', doc_modificado_serie: 'B001', doc_modificado_numero: 1, id_comprobante_modificado: 1,
          nota_motivo: '01', nota_sustento: 'Anulación', efecto_nota: 'ninguno', reingresar_stock: false,
        },
      });
      await expect(crearRepositorio().reservarCorrelativo(consultor, nota, [ITEM])).rejects.toThrow('sql/fase9_sunat_directo.sql');
    });
  });

  it('no expone ninguna forma de borrar comprobantes (D9)', () => {
    const repo = crearRepositorio() as unknown as Record<string, unknown>;
    expect(repo.eliminar).toBeUndefined();
    expect(repo.delete).toBeUndefined();
  });

  it('principalVigenteDeVenta solo cuenta facturas y boletas no anuladas ni en error', async () => {
    const consultor = { query: jest.fn().mockResolvedValue([{ id_comprobante: 3, serie: 'B001', numero: 8, estado: 'pendiente' }]) };

    const vigente = await crearRepositorio().principalVigenteDeVenta(9, consultor);

    expect(vigente).toEqual({ id_comprobante: 3, serie: 'B001', numero: 8, estado: 'pendiente' });
    const [sql, parametros] = consultor.query.mock.calls[0];
    expect(sql).toContain("COALESCE(estado, '') <> 'error'");
    expect(sql).toContain('COALESCE(anulado, FALSE) = FALSE');
    expect(parametros).toEqual([9, [1, 2]]);
  });

  it('listarPorVenta devuelve primero el principal vigente, luego los demás principales y al final las notas', async () => {
    const lista = [
      { id_comprobante: 4, tipo: { id_tipo: 7 }, anulado: false, estado: 'emitido' },
      { id_comprobante: 3, tipo: { id_tipo: 2 }, anulado: false, estado: 'error' },
      { id_comprobante: 2, tipo: { id_tipo: 2 }, anulado: false, estado: 'emitido' },
      { id_comprobante: 1, tipo: { id_tipo: 2 }, anulado: true, estado: 'emitido' },
    ];
    const repo = crearRepositorio({ find: jest.fn().mockResolvedValue(lista) });

    const ordenados = await repo.listarPorVenta(9);

    expect(ordenados.map((c) => c.id_comprobante)).toEqual([2, 3, 1, 4]);
  });

  it('listar escapa los comodines de la búsqueda, limita la página a 100 y filtra por estado SUNAT y ambiente', async () => {
    const condiciones: { sql: string; parametros?: Record<string, unknown> }[] = [];
    const paginacion: Record<string, number> = {};
    const qb: Record<string, jest.Mock> = {};
    Object.assign(qb, {
      leftJoinAndSelect: jest.fn(() => qb),
      andWhere: jest.fn((condicion: unknown, parametros?: Record<string, unknown>) => {
        if (condicion instanceof Brackets) {
          const interno: Record<string, jest.Mock> = {};
          Object.assign(interno, {
            where: jest.fn((sql: string, p: Record<string, unknown>) => (condiciones.push({ sql, parametros: p }), interno)),
            orWhere: jest.fn((sql: string, p: Record<string, unknown>) => (condiciones.push({ sql, parametros: p }), interno)),
          });
          condicion.whereFactory(interno as never);
        } else {
          condiciones.push({ sql: String(condicion), parametros });
        }
        return qb;
      }),
      orderBy: jest.fn(() => qb),
      skip: jest.fn((n: number) => ((paginacion.skip = n), qb)),
      take: jest.fn((n: number) => ((paginacion.take = n), qb)),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    });
    const repo = crearRepositorio({ createQueryBuilder: jest.fn(() => qb) });

    await repo.listar({ texto: '50%_\\x', estado_sunat: 'RECHAZADO', ambiente: 'produccion', desde: '2026-10-01', pagina: 2, por_pagina: 500 });

    expect(paginacion).toEqual({ skip: 100, take: 100 });
    const busqueda = condiciones.filter((c) => c.sql.includes('ILIKE'));
    expect(busqueda).toHaveLength(3);
    for (const condicion of busqueda) {
      expect(condicion.sql).toContain("ESCAPE '\\'");
      expect(condicion.parametros).toEqual({ patron: '%50\\%\\_\\\\x%' });
    }
    expect(condiciones).toContainEqual({ sql: 'c.estado_sunat = :estadoSunat', parametros: { estadoSunat: 'RECHAZADO' } });
    expect(condiciones).toContainEqual({ sql: 'c.ambiente_fiscal = :ambiente', parametros: { ambiente: 'produccion' } });
    expect(condiciones.find((c) => c.sql.startsWith('c.creado_en >='))!.sql).toContain("AT TIME ZONE 'America/Lima'");
  });

  it('notasDe no consulta nada si falta la columna de enlace (fase 9 sin aplicar)', async () => {
    const query = jest.fn(async (sql: string, _parametros?: unknown[]): Promise<any> => (/information_schema/.test(sql) ? [] : [{ id_comprobante: 1 }]));
    const repo = crearRepositorio({}, { query });

    await expect(repo.notasDe(40)).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('datosListado no consulta con una página vacía y sin la tabla de envíos no la une', async () => {
    const query = jest.fn(async (_sql: string, _parametros?: unknown[]): Promise<any> => []);
    const repo = crearRepositorio({}, { query });

    expect(await repo.datosListado([])).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();

    await repo.datosListado([5, 5, 6]);
    const [sql, parametros] = query.mock.calls.find(([s]) => /FROM comprobantes c/.test(String(s)))!;
    expect(String(sql)).not.toContain('fiscal_envios');
    expect(parametros).toEqual([[5, 6]]);
  });
});
