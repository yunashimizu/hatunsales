import { VentaRepository } from './venta.repository';

function crear(opciones: { columnas?: string[]; capacidades?: string[] } = {}) {
  const columnas = new Set(opciones.columnas ?? ['ventas.estado', 'ventas.id_empresa']);
  const capacidades = new Set(opciones.capacidades ?? ['credito']);
  const esquema = {
    snapshot: jest.fn(async () => ({ tieneColumna: (tabla: string, columna: string) => columnas.has(`${tabla}.${columna}`) })),
    tiene: jest.fn(async (capacidad: string) => capacidades.has(capacidad)),
  };
  const dataSource = { query: jest.fn() };
  return { repo: new VentaRepository(dataSource as never, esquema as never), dataSource };
}

describe('VentaRepository: datos para el comprobante', () => {
  it('cargarProductos trae el código SUNAT del producto leyéndolo como JSON (no falla si falta la columna)', async () => {
    const { repo, dataSource } = crear();
    dataSource.query.mockResolvedValue([
      { id_producto: 7, nombre: 'CEMENTO', precio_venta: '10.00', descuento: '0', reglas_mayoristas: [], stock_disponible: '5', codigo_sunat: '30111601' },
      { id_producto: 8, nombre: 'CLAVO', precio_venta: '1.00', descuento: '0', reglas_mayoristas: [], stock_disponible: '50', codigo_sunat: null },
    ]);

    const productos = await repo.cargarProductos([7, 8]);

    expect(String(dataSource.query.mock.calls[0][0])).toContain("to_jsonb(p) ->> 'codigo_sunat'");
    expect(productos.get(7)).toMatchObject({ id_producto: 7, precio_venta: 10, codigo_sunat: '30111601' });
    expect(productos.get(8)?.codigo_sunat).toBeNull();
  });

  it('obtenerParaComprobante devuelve null si la venta no existe', async () => {
    const { repo, dataSource } = crear();
    dataSource.query.mockResolvedValueOnce([]);

    await expect(repo.obtenerParaComprobante(99)).resolves.toBeNull();
    expect(dataSource.query).toHaveBeenCalledTimes(1);
  });

  it('obtenerParaComprobante lee la venta tal como se cobró: líneas, pagos con su medio y la cuenta por cobrar', async () => {
    const { repo, dataSource } = crear();
    dataSource.query
      .mockResolvedValueOnce([{ id_venta: 9, total: '20.19', id_cliente: 17, id_empresa: null, origen: 'mostrador', estado: 'activa' }])
      .mockResolvedValueOnce([
        {
          id_producto: 7, cantidad: '2', precio: '10.00', precio_lista_unitario: '10', descuento_total_linea: '0.4',
          subtotal: '16.61', igv: '2.99', total: '19.60', descripcion: 'CEMENTO', codigo: 'CEM-01', unidad_medida: 'NIU', codigo_sunat: '30111601',
        },
        {
          // Venta anterior a las columnas de precios: llegan como null.
          id_producto: 8, cantidad: '1', precio: '5.00', precio_lista_unitario: null, descuento_total_linea: null,
          subtotal: null, igv: null, total: null, descripcion: 'CLAVO', codigo: '8', unidad_medida: 'NIU', codigo_sunat: null,
        },
      ])
      .mockResolvedValueOnce([{ id_metodo: 2, monto: '20.19', metodo: 'Tarjeta', tipo: 'tarjeta' }])
      .mockResolvedValueOnce([{ monto_total: '19.60', saldo: '12.50', fecha_vencimiento: '2026-11-05', estado: 'parcial' }]);

    const venta = await repo.obtenerParaComprobante(9);

    expect(venta).toEqual({
      id_venta: 9,
      estado: 'activa',
      origen: 'mostrador',
      total: 20.19,
      id_cliente: 17,
      id_empresa: null,
      lineas: [
        {
          id_producto: 7, descripcion: 'CEMENTO', codigo: 'CEM-01', unidad_de_medida: 'NIU', codigo_sunat: '30111601',
          cantidad: 2, precio: 10, precio_lista_unitario: 10, descuento_total_linea: 0.4, subtotal: 16.61, igv: 2.99, total: 19.6,
        },
        {
          id_producto: 8, descripcion: 'CLAVO', codigo: '8', unidad_de_medida: 'NIU', codigo_sunat: null,
          cantidad: 1, precio: 5, precio_lista_unitario: null, descuento_total_linea: null, subtotal: null, igv: null, total: null,
        },
      ],
      pagos: [{ id_metodo: 2, monto: 20.19, metodo: 'Tarjeta', tipo: 'tarjeta' }],
      credito: { monto_total: 19.6, saldo: 12.5, fecha_vencimiento: '2026-11-05', estado: 'parcial' },
    });
    // Las columnas de precios del detalle se leen como JSON para no fallar con ventas o esquemas antiguos.
    expect(String(dataSource.query.mock.calls[1][0])).toContain("x.j ->> 'descuento_total_linea'");
  });

  it('sin las columnas opcionales de ventas ni el módulo de crédito no las consulta', async () => {
    const { repo, dataSource } = crear({ columnas: [], capacidades: [] });
    dataSource.query
      .mockResolvedValueOnce([{ id_venta: 9, total: '10', id_cliente: null, id_empresa: null, origen: 'mostrador', estado: 'activa' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const venta = await repo.obtenerParaComprobante(9);

    const cabecera = String(dataSource.query.mock.calls[0][0]);
    expect(cabecera).toContain('NULL::int AS id_empresa');
    expect(cabecera).not.toContain('v.estado');
    expect(dataSource.query).toHaveBeenCalledTimes(3);
    expect(venta?.credito).toBeNull();
  });
});

describe('VentaRepository.efectosDeAnulacion (S9.3)', () => {
  it('con salidas de stock registradas y cuentas por cobrar anuladas informa stock devuelto y cuántas se cerraron', async () => {
    const { repo, dataSource } = crear({ capacidades: ['credito', 'ventaStockSalida'] });
    dataSource.query.mockResolvedValueOnce([{ n: 2 }]).mockResolvedValueOnce([{ n: '1' }]);

    expect(await repo.efectosDeAnulacion(9)).toEqual({ stock_devuelto: true, cxc_cerradas: 1 });

    const sqls = dataSource.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqls[0]).toContain('FROM venta_stock_salida WHERE id_venta = $1');
    expect(sqls[1]).toContain("FROM cuentas_por_cobrar WHERE id_venta = $1 AND estado = 'anulado'");
    expect(dataSource.query.mock.calls.every((c: unknown[]) => (c[1] as number[])[0] === 9)).toBe(true);
  });

  it('una venta anterior a las salidas de stock cuenta sus líneas con producto; sin crédito no consulta cuentas', async () => {
    const { repo, dataSource } = crear({ capacidades: [] });
    dataSource.query.mockResolvedValueOnce([{ n: 3 }]);

    expect(await repo.efectosDeAnulacion(9)).toEqual({ stock_devuelto: true, cxc_cerradas: 0 });

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(String(dataSource.query.mock.calls[0][0])).toContain('FROM detalle_venta WHERE id_venta = $1 AND id_producto IS NOT NULL');
  });

  it('una venta sin productos ni salidas no devolvió stock; dentro de la transacción de quien llama usa su consultor', async () => {
    const { repo, dataSource } = crear({ capacidades: ['ventaStockSalida'] });
    const consultor = { query: jest.fn().mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([{ n: 0 }]) };

    expect(await repo.efectosDeAnulacion(9, consultor as never)).toEqual({ stock_devuelto: false, cxc_cerradas: 0 });

    expect(consultor.query).toHaveBeenCalledTimes(2);
    expect(dataSource.query).not.toHaveBeenCalled();
  });
});

describe('VentaRepository.registrar: candados y caja (Fase A)', () => {
  const LINEA = {
    id_producto: 7, descripcion: 'CEMENTO', cantidad: 1, precio_unitario: 10, descuento: 0, subtotal: 8.47, igv: 1.53, total: 10,
    precio_lista_unitario: 10, descuento_unitario_aplicado: 0, descuento_total_linea: 0, precio_unitario_final: 10, id_regla_mayorista: null,
  };
  const DATOS = { id_usuario: 4, subtotal: 8.47, igv: 1.53, descuento: 0, total: 10, origen: 'mostrador' };

  /**
   * Transacción simulada: responde según el texto de cada consulta. `aperturas` y `cierres` son
   * las respuestas, en orden, a la elección de la caja y a la relectura de su cierre.
   */
  function crearRegistro(opciones: { aperturas?: unknown[][]; cierres?: unknown[][] } = {}) {
    const aperturas = [...(opciones.aperturas ?? [[{ id_apertura: 30, id_caja: 3 }]])];
    const cierres = [...(opciones.cierres ?? [[]])];
    const manager = {
      query: jest.fn(async (sql: string, _params?: any): Promise<any[]> => {
        if (sql.includes('FROM aperturas_caja a')) return aperturas.shift() ?? [];
        if (sql.includes('FROM cierres_caja WHERE id_apertura = $1')) return cierres.shift() ?? [];
        if (sql.includes('FROM inventario') && sql.includes('FOR UPDATE')) {
          return [{ id_inventario: 1, id_producto: 7, id_almacen: 2, stock: '10' }];
        }
        if (sql.includes('FROM clientes c')) return [{ credito_activo: true, limite_credito: '1000' }];
        if (sql.includes('SUM(saldo)')) return [{ deuda: '0' }];
        if (sql.includes('INSERT INTO ventas')) return [{ id_venta: 50 }];
        return [];
      }),
    };
    const esquema = {
      snapshot: jest.fn(async () => ({ tieneColumna: () => false })),
      tiene: jest.fn(async () => false),
    };
    const dataSource = { query: jest.fn(), transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn(manager)) };
    const repo = new VentaRepository(dataSource as never, esquema as never);
    const sqls = () => manager.query.mock.calls.map((c: unknown[]) => String(c[0]));
    return { repo, manager, sqls };
  }

  it('a crédito: bloquea al deudor con FOR NO KEY UPDATE después del inventario y antes del INSERT de la venta', async () => {
    const { repo, sqls } = crearRegistro();

    await repo.registrar(
      { ...DATOS, id_cliente: 17, credito: { monto: 10, dias: 15, id_cliente: 17 } },
      [LINEA], [], { descontarStock: true, idAlmacenPreferido: 2 },
    );

    const todas = sqls();
    const inventario = todas.findIndex((s) => s.includes('FROM inventario') && s.includes('FOR UPDATE'));
    const deudor = todas.findIndex((s) => s.includes('FROM clientes c'));
    const caja = todas.findIndex((s) => s.includes('FROM aperturas_caja a'));
    const venta = todas.findIndex((s) => s.includes('INSERT INTO ventas'));
    const cuenta = todas.findIndex((s) => s.includes('INSERT INTO cuentas_por_cobrar'));
    expect(todas[deudor]).toContain('FOR NO KEY UPDATE');
    expect(todas[deudor]).not.toMatch(/FOR UPDATE/);
    expect(inventario).toBeGreaterThanOrEqual(0);
    expect(inventario).toBeLessThan(deudor);
    expect(deudor).toBeLessThan(caja);
    expect(caja).toBeLessThan(venta);
    // La cuenta por cobrar necesita el id de la venta: se queda después.
    expect(venta).toBeLessThan(cuenta);
  });

  it('elige la caja en el servidor: descarta la de otra sucursal, toma FOR KEY SHARE y fecha con clock_timestamp()', async () => {
    const { repo, manager, sqls } = crearRegistro();

    await expect(repo.registrar(DATOS, [LINEA], [], { descontarStock: true, idAlmacenPreferido: 2 }))
      .resolves.toEqual({ id_venta: 50, existente: false });

    const eleccion = sqls().find((s) => s.includes('FROM aperturas_caja a'))!;
    expect(eleccion).toContain('SELECT a.id_apertura, a.id_caja');
    expect(eleccion).toContain('LEFT JOIN almacenes al ON al.id_almacen = $2::int');
    // Una caja de sucursal conocida y distinta de la del almacén solo vale si es la del propio cajero.
    expect(eleccion).toMatch(/AND \(COALESCE\(a\.id_usuario = \$1::int, FALSE\)\s+OR al\.id_sucursal IS NULL OR c\.id_sucursal IS NULL\s+OR al\.id_sucursal = c\.id_sucursal\)/);
    expect(eleccion).toMatch(/FOR KEY SHARE OF a$/);
    const llamadaEleccion = manager.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('FROM aperturas_caja a'))!;
    expect(llamadaEleccion[1]).toEqual([4, 2]);

    const insert = manager.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('INSERT INTO ventas'))!;
    expect(String(insert[0])).toContain('clock_timestamp()');
    expect(String(insert[0])).not.toContain('NOW()');
    expect(insert[1][1]).toBe(3);
  });

  it('relee el cierre en otra sentencia: si la caja se cerró mientras esperaba, elige otra', async () => {
    const { repo, manager, sqls } = crearRegistro({
      aperturas: [[{ id_apertura: 30, id_caja: 3 }], [{ id_apertura: 31, id_caja: 5 }]],
      cierres: [[{ '?column?': 1 }], []],
    });

    await repo.registrar(DATOS, [LINEA], [], { descontarStock: true, idAlmacenPreferido: 2 });

    const relecturas = manager.query.mock.calls.filter((c: unknown[]) => String(c[0]).includes('FROM cierres_caja WHERE id_apertura = $1'));
    expect(relecturas.map((c: unknown[]) => c[1])).toEqual([[30], [31]]);
    expect(sqls().filter((s) => s.includes('FROM aperturas_caja a'))).toHaveLength(2);
    const insert = manager.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('INSERT INTO ventas'))!;
    expect(insert[1][1]).toBe(5);
  });

  it('si la segunda caja también se cerró: CAJA_CERRANDO y no se inserta la venta', async () => {
    const { repo, sqls } = crearRegistro({
      aperturas: [[{ id_apertura: 30, id_caja: 3 }], [{ id_apertura: 31, id_caja: 5 }]],
      cierres: [[{ '?column?': 1 }], [{ '?column?': 1 }]],
    });

    await expect(repo.registrar(DATOS, [LINEA], [], { descontarStock: true, idAlmacenPreferido: 2 }))
      .rejects.toThrow('CAJA_CERRANDO');
    expect(sqls().some((s) => s.includes('INSERT INTO ventas'))).toBe(false);
  });

  it('sin caja abierta la venta queda sin caja y no relee cierres', async () => {
    const { repo, manager, sqls } = crearRegistro({ aperturas: [[]] });

    await repo.registrar(DATOS, [LINEA], [], { descontarStock: true, idAlmacenPreferido: 2 });

    expect(sqls().some((s) => s.includes('FROM cierres_caja WHERE id_apertura = $1'))).toBe(false);
    const insert = manager.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('INSERT INTO ventas'))!;
    expect(insert[1][1]).toBeNull();
  });
});
