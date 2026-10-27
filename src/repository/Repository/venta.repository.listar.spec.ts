import { sqlPrincipalVigente } from './venta-documentos.repository';
import { VentaRepository } from './venta.repository';

/** GET /venta (historial): el listado enriquecido con el estado documental de cada venta. */
function crear(columnas: string[] = ['ventas.estado', 'ventas.id_empresa']) {
  const presentes = new Set(columnas);
  const esquema = {
    snapshot: jest.fn(async () => ({ tieneColumna: (tabla: string, columna: string) => presentes.has(`${tabla}.${columna}`) })),
    tiene: jest.fn(async () => true),
  };
  const dataSource = { query: jest.fn() };
  const repo = new VentaRepository(dataSource as never, esquema as never);
  return { repo, dataSource };
}

function responder(dataSource: { query: jest.Mock }, filas: unknown[], total = filas.length) {
  dataSource.query.mockImplementation(async (consulta: string) => (consulta.startsWith('SELECT COUNT(*)') ? [{ total }] : filas));
}

const consultas = (dataSource: { query: jest.Mock }) => ({
  conteo: { sql: String(dataSource.query.mock.calls[0][0]), params: dataSource.query.mock.calls[0][1] as unknown[] },
  datos: { sql: String(dataSource.query.mock.calls[1][0]), params: dataSource.query.mock.calls[1][1] as unknown[] },
});

const FILA_CON_FACTURA = {
  id_venta: 12,
  fecha: '2026-10-24T18:30:00-05:00',
  total: '118.00',
  origen: 'mostrador',
  id_cliente: null,
  id_empresa: 3,
  cliente_denominacion: 'ACME SAC',
  cantidad_items: 2,
  estado: 'activa',
  metodos_pago: 'EFECTIVO, TARJETA',
  id_comprobante: 40,
  serie: 'F001',
  numero: 12,
  comprobante_tipo: 1,
  comprobante_estado: 'emitido',
  comprobante_estado_sunat: 'ACEPTADO',
  cantidad_notas: 1,
  cantidad_guias: 2,
};

describe('VentaRepository.listar (historial de ventas)', () => {
  it('cada fila con su comprobante vigente, medios de pago, notas y guías, en los tipos del contrato', async () => {
    const { repo, dataSource } = crear();
    responder(dataSource, [
      FILA_CON_FACTURA,
      {
        id_venta: 11, fecha: '2026-10-24T09:00:00-05:00', total: '25', origen: 'tienda', id_cliente: 7, id_empresa: null,
        cliente_denominacion: 'JUAN PEREZ', cantidad_items: 1, estado: 'anulada', metodos_pago: '', id_comprobante: null,
        serie: null, numero: null, comprobante_tipo: null, comprobante_estado: null, comprobante_estado_sunat: null,
        cantidad_notas: 0, cantidad_guias: 0,
      },
    ], 2);

    const resultado = await repo.listar({});

    expect(resultado).toEqual({
      datos: [
        {
          id_venta: 12,
          fecha: '2026-10-24T18:30:00-05:00',
          origen: 'mostrador',
          id_empresa: 3,
          cliente_denominacion: 'ACME SAC',
          total: 118,
          cantidad_items: 2,
          estado: 'activa',
          metodos_pago: 'EFECTIVO, TARJETA',
          comprobante: 'F001-00000012',
          comprobante_estado: 'emitido',
          id_comprobante: 40,
          serie: 'F001',
          numero: 12,
          comprobante_tipo: 1,
          comprobante_estado_sunat: 'ACEPTADO',
          cantidad_notas: 1,
          cantidad_guias: 2,
        },
        // Sin comprobante vigente no van comprobante, id_comprobante, serie ni número.
        {
          id_venta: 11,
          fecha: '2026-10-24T09:00:00-05:00',
          origen: 'tienda',
          id_cliente: 7,
          cliente_denominacion: 'JUAN PEREZ',
          total: 25,
          cantidad_items: 1,
          estado: 'anulada',
          metodos_pago: '',
          comprobante_tipo: null,
          comprobante_estado_sunat: null,
          cantidad_notas: 0,
          cantidad_guias: 0,
        },
      ],
      total: 2,
      pagina: 1,
      por_pagina: 20,
    });

    const { conteo, datos } = consultas(dataSource);
    expect(conteo.params).toEqual([]);
    expect(datos.params).toEqual([20, 0]);
    expect(datos.sql).toContain(`to_char((v.fecha AT TIME ZONE 'UTC') AT TIME ZONE 'America/Lima', 'YYYY-MM-DD"T"HH24:MI:SS"-05:00"') AS fecha`);
    // El comprobante de la fila es el principal vigente (D10), no el último de cualquier tipo.
    expect(datos.sql).toContain(`WHERE p.id_venta = v.id_venta AND ${sqlPrincipalVigente('p')}`);
    expect(datos.sql).toContain('n.id_tipo = 7) AS cantidad_notas');
    expect(datos.sql).toContain('FROM guias_remision g WHERE g.id_venta = v.id_venta) AS cantidad_guias');
    expect(datos.sql).toContain("string_agg(m.nombre, ', ' ORDER BY m.primero)");
    expect(datos.sql).toContain('ORDER BY v.fecha DESC NULLS LAST, v.id_venta DESC');
    expect(datos.sql).toContain('LIMIT $1 OFFSET $2');
  });

  it('texto sin comodines sobre cliente, documento, número de venta y serie-número (con o sin ceros)', async () => {
    const { repo, dataSource } = crear();
    responder(dataSource, []);

    await repo.listar({ texto: '  100%_A  ' });

    const { conteo, datos } = consultas(dataSource);
    expect(conteo.params).toEqual(['%100\\%\\_A%']);
    expect(datos.params).toEqual(['%100\\%\\_A%', 20, 0]);
    for (const consulta of [conteo.sql, datos.sql]) {
      expect(consulta).toContain("TRIM(CONCAT_WS(' ', c.nombre, c.apellido_paterno, c.apellido_materno)) ILIKE $1 ESCAPE '\\'");
      expect(consulta).toContain("LPAD(c.dni::text, 8, '0') ILIKE $1 ESCAPE '\\'");
      expect(consulta).toContain("COALESCE(e.ruc, '') ILIKE $1 ESCAPE '\\'");
      expect(consulta).toContain("CAST(v.id_venta AS TEXT) ILIKE $1 ESCAPE '\\'");
      expect(consulta).toContain("(s.serie || '-' || LPAD(s.numero::text, 8, '0')) ILIKE $1 ESCAPE '\\'");
      expect(consulta).toContain("(s.serie || '-' || s.numero::text) ILIKE $1 ESCAPE '\\'");
      expect(consulta).not.toContain('100%');
    }
  });

  it('días de Lima, origen, estado y con o sin comprobante; parámetros en orden y página con tope de 100', async () => {
    const { repo, dataSource } = crear();
    responder(dataSource, []);

    const resultado = await repo.listar({
      desde: '2026-10-01',
      hasta: '2026-10-24',
      origen: 'mostrador',
      estado: 'anulada',
      tiene_comprobante: 'no',
      pagina: 3,
      por_pagina: 500,
    });

    const { conteo, datos } = consultas(dataSource);
    expect(conteo.params).toEqual(['2026-10-01', '2026-10-24', 'mostrador', 'anulada']);
    expect(datos.params).toEqual(['2026-10-01', '2026-10-24', 'mostrador', 'anulada', 100, 200]);
    for (const consulta of [conteo.sql, datos.sql]) {
      expect(consulta).toContain("v.fecha >= (CAST($1 AS date)::timestamp AT TIME ZONE 'America/Lima' AT TIME ZONE 'UTC')");
      expect(consulta).toContain("v.fecha < ((CAST($2 AS date) + 1)::timestamp AT TIME ZONE 'America/Lima' AT TIME ZONE 'UTC')");
      expect(consulta).toContain("COALESCE(v.origen, 'mostrador') = $3");
      expect(consulta).toContain("LOWER(COALESCE(NULLIF(TRIM(v.estado), ''), 'activa')) = $4");
      expect(consulta).toContain(`NOT EXISTS (SELECT 1 FROM comprobantes p WHERE p.id_venta = v.id_venta AND ${sqlPrincipalVigente('p')})`);
    }
    expect(resultado).toMatchObject({ pagina: 3, por_pagina: 100, total: 0 });

    responder(dataSource, []);
    dataSource.query.mockClear();
    await repo.listar({ tiene_comprobante: 'si' });
    const conComprobante = consultas(dataSource).conteo.sql;
    expect(conComprobante).toContain(`EXISTS (SELECT 1 FROM comprobantes p WHERE p.id_venta = v.id_venta AND ${sqlPrincipalVigente('p')})`);
    expect(conComprobante).not.toContain('NOT EXISTS');
  });

  it('sin las columnas ventas.estado ni ventas.id_empresa no las referencia (todas activas, sin empresa)', async () => {
    const { repo, dataSource } = crear([]);
    responder(dataSource, []);

    await repo.listar({ estado: 'activa' });

    const { conteo, datos } = consultas(dataSource);
    expect(conteo.sql).toContain(`'activa' = $1`);
    expect(datos.sql).toContain(`'activa' AS estado`);
    expect(datos.sql).toContain('NULL::int AS id_empresa');
    expect(datos.sql).toContain('LEFT JOIN empresas e ON FALSE');
    expect(datos.sql).not.toContain('v.estado');
    expect(datos.sql).not.toContain('v.id_empresa');
  });
});
