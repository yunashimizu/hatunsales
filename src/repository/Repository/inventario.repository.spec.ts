import { InventarioRepository } from './inventario.repository';

/**
 * GET /inventario/detallado (pantalla Inventario y ficha de producto): el conteo no
 * necesita la imagen ni los catálogos, y la imagen se busca solo para las filas de la
 * página. Conteo y filas van en paralelo.
 */
function armar() {
  const pendientes: Array<{ sql: string; params: any[]; resolver: (v: any) => void }> = [];
  const query = jest.fn(
    (sql: string, params: any[] = []) =>
      new Promise((resolver) => {
        pendientes.push({ sql, params, resolver });
      }),
  );
  const repo = new InventarioRepository({} as any, { query } as any);
  return { repo, query, pendientes };
}

const fila = {
  id_inventario: 4,
  id_producto: 9,
  producto: 'Clavo 2"',
  sku: 'CLA-2',
  codigo_barras: '',
  unidad_medida: 'NIU',
  categoria: 'Clavos',
  id_almacen: 2,
  almacen: 'Principal',
  sucursal: 'Lurín',
  stock: '3',
  stock_minimo: '5',
  precio_compra: '0.10',
  precio_venta: '0.20',
  alerta: true,
  imagen_url: '/archivos/7',
};

describe('InventarioRepository.listarDetallado', () => {
  it('lanza conteo y filas a la vez; el conteo no lleva el LATERAL ni joins de catálogo', async () => {
    const { repo, query, pendientes } = armar();

    const promesa = repo.listarDetallado({ texto: 'clavo', id_almacen: 2, id_categoria: 3, pagina: 2, por_pagina: 20 });
    await Promise.resolve();

    // Las dos consultas salieron antes de que respondiera ninguna.
    expect(query).toHaveBeenCalledTimes(2);
    const conteo = pendientes.find((p) => p.sql.includes('COUNT(*)'))!;
    const filas = pendientes.find((p) => !p.sql.includes('COUNT(*)'))!;
    expect(conteo.sql).not.toMatch(/LATERAL/);
    expect(conteo.sql).not.toMatch(/almacenes|sucursales|categorias/);
    expect(conteo.params).toEqual(['%clavo%', 2, 3]);

    conteo.resolver([{ total: 41 }]);
    filas.resolver([fila]);
    const resultado = await promesa;

    expect(resultado.total).toBe(41);
    expect(resultado.pagina).toBe(2);
    expect(resultado.datos[0]).toMatchObject({
      id_inventario: 4,
      stock: 3,
      stock_minimo: 5,
      estado: 'bajo',
      imagen_url: '/archivos/7',
    });
  });

  it('corta la página antes de buscar la imagen y repite el mismo orden afuera', async () => {
    const { repo, pendientes } = armar();

    const promesa = repo.listarDetallado({ id_producto: 9, por_pagina: 1 });
    await Promise.resolve();
    const filas = pendientes.find((p) => !p.sql.includes('COUNT(*)'))!;

    expect(filas.sql.indexOf('LIMIT $2 OFFSET $3')).toBeGreaterThan(-1);
    expect(filas.sql.indexOf('LIMIT $2 OFFSET $3')).toBeLessThan(filas.sql.indexOf('LEFT JOIN LATERAL'));
    expect(filas.sql).toMatch(/WHERE pi\.id_producto = b\.id_producto/);
    expect(filas.sql).toMatch(/ORDER BY alerta DESC, p\.nombre ASC, i\.id_inventario ASC/);
    expect(filas.sql).toMatch(/ORDER BY b\.alerta DESC, b\.producto ASC, b\.id_inventario ASC\s*$/);
    expect(filas.params).toEqual([9, 1, 0]);

    for (const p of pendientes) p.resolver(p.sql.includes('COUNT(*)') ? [{ total: 1 }] : [fila]);
    await promesa;
  });
});
