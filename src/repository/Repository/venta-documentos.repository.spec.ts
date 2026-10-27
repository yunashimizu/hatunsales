import { esPrincipalVigente, patronContiene, sqlPrincipalVigente, VentaDocumentosRepository } from './venta-documentos.repository';

function crear(opciones: { columnas?: string[]; capacidades?: string[] } = {}) {
  const columnas = new Set(opciones.columnas ?? ['ventas.estado', 'ventas.id_empresa']);
  const capacidades = new Set(opciones.capacidades ?? ['credito', 'notasCredito']);
  const esquema = {
    snapshot: jest.fn(async () => ({
      tieneColumna: (tabla: string, columna: string) => columnas.has(`${tabla}.${columna}`),
      tiene: (capacidad: string) => capacidades.has(capacidad),
    })),
    tiene: jest.fn(async (capacidad: string) => capacidades.has(capacidad)),
  };
  const dataSource = { query: jest.fn() };
  return { repo: new VentaDocumentosRepository(dataSource as never, esquema as never), dataSource, esquema };
}

const sql = (dataSource: { query: jest.Mock }, llamada = 0) => String(dataSource.query.mock.calls[llamada][0]);

describe('VentaDocumentosRepository', () => {
  describe('ayudas de SQL', () => {
    it('el texto buscado se usa tal cual: %, _ y \\ no son comodines', () => {
      expect(patronContiene('100%_a\\b')).toBe('%100\\%\\_a\\\\b%');
    });

    it('principal vigente = factura o boleta no anulada ni en error (también la que está en envío)', () => {
      expect(sqlPrincipalVigente('p')).toBe("p.id_tipo IN (1, 2) AND COALESCE(p.anulado, FALSE) = FALSE AND COALESCE(p.estado, '') <> 'error'");
      expect(esPrincipalVigente({ id_tipo: 2, anulado: false, estado: 'pendiente' })).toBe(true);
      expect(esPrincipalVigente({ id_tipo: 1, anulado: false, estado: null })).toBe(true);
      expect(esPrincipalVigente({ id_tipo: 1, anulado: true, estado: 'emitido' })).toBe(false);
      expect(esPrincipalVigente({ id_tipo: 1, anulado: false, estado: 'error' })).toBe(false);
      expect(esPrincipalVigente({ id_tipo: 7, anulado: false, estado: 'emitido' })).toBe(false);
    });
  });

  describe('venta', () => {
    it('null si la venta no existe', async () => {
      const { repo, dataSource } = crear();
      dataSource.query.mockResolvedValueOnce([]);
      await expect(repo.venta(99)).resolves.toBeNull();
      expect(dataSource.query.mock.calls[0][1]).toEqual([99]);
    });

    it('fecha de Lima con -05:00, estado en minúsculas, pagos con su medio y la deuda viva', async () => {
      const { repo, dataSource } = crear();
      dataSource.query.mockResolvedValueOnce([
        {
          id_venta: 5,
          fecha: '2026-10-24T18:30:00-05:00',
          total: '118.00',
          estado: 'activa',
          cliente_nombre: 'JUAN PEREZ',
          cliente_dni: '1234567',
          empresa_nombre: null,
          empresa_ruc: null,
          cantidad_lineas: 2,
          pagos: [{ metodo: 'EFECTIVO', monto: '100.00' }, { metodo: 'Crédito', monto: '18.00' }],
          a_credito: true,
          saldo_cxc: '18.00',
        },
      ]);

      const venta = await repo.venta(5);

      expect(venta).toEqual({
        id_venta: 5,
        fecha: '2026-10-24T18:30:00-05:00',
        total: 118,
        estado: 'activa',
        // El DNI se guarda como número: el cero inicial se recupera.
        cliente: { nombre: 'JUAN PEREZ', documento: '01234567' },
        pagos: [{ metodo: 'EFECTIVO', monto: 100 }, { metodo: 'Crédito', monto: 18 }],
        a_credito: true,
        saldo_cxc: 18,
        cantidad_lineas: 2,
      });
      const consulta = sql(dataSource);
      expect(consulta).toContain(`to_char((v.fecha AT TIME ZONE 'UTC') AT TIME ZONE 'America/Lima', 'YYYY-MM-DD"T"HH24:MI:SS"-05:00"')`);
      expect(consulta).toContain(`LOWER(COALESCE(NULLIF(TRIM(v.estado), ''), 'activa'))`);
      expect(consulta).toContain('LEFT JOIN empresas e ON e.id_empresa = v.id_empresa');
      expect(consulta).toContain('FROM cuentas_por_cobrar x');
    });

    it('sin columnas opcionales ni crédito no las consulta; empresa con RUC o clientes varios', async () => {
      const { repo, dataSource } = crear({ columnas: [], capacidades: [] });
      dataSource.query
        .mockResolvedValueOnce([{ id_venta: 6, fecha: null, total: '10', estado: 'activa', empresa_nombre: 'ACME SAC', empresa_ruc: '20100000001', pagos: null, a_credito: false, saldo_cxc: '0' }])
        .mockResolvedValueOnce([{ id_venta: 7, fecha: '2026-10-24T09:00:00-05:00', total: '5', estado: 'activa', pagos: [] }]);

      const empresa = await repo.venta(6);
      const varios = await repo.venta(7);

      const consulta = sql(dataSource);
      expect(consulta).toContain(`'activa' AS estado`);
      expect(consulta).toContain('LEFT JOIN empresas e ON FALSE');
      expect(consulta).toContain(`FALSE AS a_credito, '0' AS saldo_cxc`);
      expect(consulta).not.toContain('v.estado');
      expect(consulta).not.toContain('cuentas_por_cobrar');
      expect(empresa).toMatchObject({ fecha: '', cliente: { nombre: 'ACME SAC', documento: '20100000001' }, pagos: [] });
      expect(varios?.cliente).toEqual({ nombre: 'CLIENTES VARIOS', documento: null });
    });
  });

  describe('comprobantes', () => {
    it('factura, boleta y notas de la venta con su último envío; fase9/14 leídas como JSON', async () => {
      const { repo, dataSource } = crear();
      dataSource.query.mockResolvedValueOnce([
        {
          id_comprobante: 30, id_tipo: 7, serie: 'FC01', numero: 3, fecha_de_emision: '24-10-2026', cliente_tipo_doc: 6,
          cliente_numero_doc: '20100000001', cliente_denominacion: 'ACME SAC', id_moneda: 1, total: '10.00', porcentaje_igv: '18.00',
          anulado: false, estado: 'emitido', estado_sunat: 'ACEPTADO', aceptada_sunat: true, ambiente_fiscal: 'produccion',
          proveedor_fiscal: 'sunat_directo', id_venta: 5, id_envio_ultimo: 71, error_mensaje: null, sunat_description: 'aceptada',
          motivo_anulacion: null, id_comprobante_modificado: '10', doc_modificado_serie: 'F001', doc_modificado_numero: '12',
          nota_motivo: '07', efecto_nota: 'devolucion', efectos_aplicados: 'false', envio_id: 71, envio_estado: 'ACEPTADO',
          envio_codigo: '0', envio_mensaje: 'La Nota de Credito numero FC01-3, ha sido aceptada', envio_accion: 'NINGUNA', envio_libre: true,
        },
        {
          // Histórica, sin envío ni columnas de fase14.
          id_comprobante: 9, id_tipo: 2, serie: 'BBB1', numero: 4, fecha_de_emision: '01-07-2026', cliente_tipo_doc: 1,
          cliente_numero_doc: '45678912', cliente_denominacion: 'JUAN', id_moneda: null, total: '25', porcentaje_igv: null,
          anulado: 't', estado: 'emitido', estado_sunat: null, aceptada_sunat: false, ambiente_fiscal: null, proveedor_fiscal: 'nubefact',
          id_venta: 5, id_envio_ultimo: null, error_mensaje: null, sunat_description: null, motivo_anulacion: 'Venta 5 anulada',
          id_comprobante_modificado: null, doc_modificado_serie: null, doc_modificado_numero: null, nota_motivo: null,
          efecto_nota: null, efectos_aplicados: null, envio_id: null, envio_libre: true,
        },
      ]);

      const [notaCredito, historica] = await repo.comprobantes(5);

      expect(dataSource.query.mock.calls[0][1]).toEqual([5, [1, 2, 7]]);
      const consulta = sql(dataSource);
      expect(consulta).toContain('CROSS JOIN LATERAL (SELECT to_jsonb(c) AS j) x');
      expect(consulta).toContain("x.j ->> 'efecto_nota'");
      expect(consulta).toContain('ORDER BY c.creado_en DESC NULLS LAST, c.id_comprobante DESC');
      expect(notaCredito).toMatchObject({
        id_comprobante: 30, id_tipo: 7, total: 10, porcentaje_igv: 18, id_comprobante_modificado: 10, doc_modificado_numero: 12,
        nota_motivo: '07', efecto_nota: 'devolucion', efectos_aplicados: false, mensaje_envio: 'La Nota de Credito numero FC01-3, ha sido aceptada',
        envio: { estado: 'ACEPTADO', codigo: '0', accion: 'NINGUNA', libre: true },
      });
      expect(historica).toMatchObject({
        id_moneda: 1, porcentaje_igv: 18, anulado: true, estado_sunat: null, envio: null, efecto_nota: null, efectos_aplicados: null,
        motivo_anulacion: 'Venta 5 anulada',
      });
    });
  });

  describe('guias', () => {
    it('en el orden en que se crearon; el estado vacío es borrador, como en el negocio de guías', async () => {
      const { repo, dataSource } = crear();
      dataSource.query.mockResolvedValueOnce([
        { id_guia: 2, serie: null, numero: null, estado: 'borrador', fecha_emision: null, motivo_codigo: '01', motivo_texto: null },
        { id_guia: 3, serie: 'T001', numero: '7', estado: 'aceptado', fecha_emision: '2026-10-24', motivo_codigo: null, motivo_texto: 'VENTA' },
      ]);

      const guias = await repo.guias(5);

      expect(sql(dataSource)).toContain(`COALESCE(NULLIF(TRIM(g.estado), ''), 'borrador') AS estado`);
      expect(sql(dataSource)).toContain('ORDER BY g.id_guia');
      expect(guias).toEqual([
        { id_guia: 2, serie: null, numero: null, estado: 'borrador', fecha_emision: null, motivo_codigo: '01', motivo_texto: null },
        { id_guia: 3, serie: 'T001', numero: 7, estado: 'aceptado', fecha_emision: '2026-10-24', motivo_codigo: null, motivo_texto: 'VENTA' },
      ]);
    });
  });

  describe('sinComprobante', () => {
    function responder(dataSource: { query: jest.Mock }, filas: unknown[], total: number) {
      dataSource.query.mockImplementation(async (consulta: string) => (consulta.includes('COUNT(*)') ? [{ total }] : filas));
    }

    it('ventas activas sin principal vigente, días de Lima, último comprobante y paginado con tope de 100', async () => {
      const { repo, dataSource } = crear();
      responder(
        dataSource,
        [
          {
            id_venta: 33, fecha: '2026-10-24T18:30:00-05:00', total: '59.00', cliente_nombre: null, cliente_dni: null,
            empresa_nombre: 'ACME SAC', empresa_ruc: '20100000001', ultimo_serie: 'B001', ultimo_numero: 3, ultimo_anulado: false,
            ultimo_mensaje: '2800 - Documento no permitido',
          },
          { id_venta: 30, fecha: '2026-10-20T10:00:00-05:00', total: '5', ultimo_serie: null },
        ],
        141,
      );

      const resultado = await repo.sinComprobante({ desde: '2026-10-01', hasta: '2026-10-24', pagina: 2, por_pagina: 500 });

      const [conteo, datos] = [dataSource.query.mock.calls[0], dataSource.query.mock.calls[1]];
      expect(conteo[1]).toEqual(['2026-10-01', '2026-10-24']);
      expect(datos[1]).toEqual(['2026-10-01', '2026-10-24', 100, 100]);
      for (const consulta of [String(conteo[0]), String(datos[0])]) {
        expect(consulta).toContain(`NOT EXISTS (SELECT 1 FROM comprobantes p WHERE p.id_venta = v.id_venta AND ${sqlPrincipalVigente('p')})`);
        expect(consulta).toContain(`LOWER(COALESCE(NULLIF(TRIM(v.estado), ''), 'activa')) = 'activa'`);
        expect(consulta).toContain("v.fecha >= (CAST($1 AS date)::timestamp AT TIME ZONE 'America/Lima' AT TIME ZONE 'UTC')");
        expect(consulta).toContain("v.fecha < ((CAST($2 AS date) + 1)::timestamp AT TIME ZONE 'America/Lima' AT TIME ZONE 'UTC')");
      }
      expect(String(datos[0])).toContain('LIMIT $3 OFFSET $4');
      expect(resultado).toEqual({
        filas: [
          {
            id_venta: 33, fecha: '2026-10-24T18:30:00-05:00', total: 59,
            cliente: { nombre: 'ACME SAC', documento: '20100000001' },
            ultimo: { serie: 'B001', numero: 3, anulado: false, mensaje: '2800 - Documento no permitido' },
          },
          { id_venta: 30, fecha: '2026-10-20T10:00:00-05:00', total: 5, cliente: { nombre: 'CLIENTES VARIOS', documento: null }, ultimo: null },
        ],
        total: 141,
        pagina: 2,
        por_pagina: 100,
      });
    });

    it('sin filtros: primera página de 20; sin la columna ventas.estado todas cuentan como activas', async () => {
      const { repo, dataSource } = crear({ columnas: [] });
      responder(dataSource, [], 0);

      const resultado = await repo.sinComprobante({ pagina: 0 });

      expect(dataSource.query.mock.calls[0][1]).toEqual([]);
      expect(dataSource.query.mock.calls[1][1]).toEqual([20, 0]);
      expect(sql(dataSource)).toContain(`'activa' = 'activa'`);
      expect(sql(dataSource, 1)).toContain('LEFT JOIN empresas e ON FALSE');
      expect(resultado).toEqual({ filas: [], total: 0, pagina: 1, por_pagina: 20 });
    });
  });

  it('notasCreditoHabilitadas pregunta por la capacidad de fase14', async () => {
    const { repo, esquema } = crear({ capacidades: [] });
    await expect(repo.notasCreditoHabilitadas()).resolves.toBe(false);
    expect(esquema.tiene).toHaveBeenCalledWith('notasCredito');
  });
});
