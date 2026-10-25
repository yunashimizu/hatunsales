import { CatalogoRepository } from './catalogo.repository';

/**
 * Consultas del catálogo público (R03 / R04): la política de stock sale de la
 * caché, el COUNT solo se paga cuando se usa (y en paralelo con las filas) y las
 * filas no pasan por `vw_catalogo`, que agrupa TODO el inventario antes del LIMIT.
 */
/** La consulta del total (las filas también llevan `count(...)` de reseñas, pero no así). */
const ES_CONTEO = /SELECT COUNT\(\*\)/;

function armar(politica: { exclusivo: boolean; idAlmacen?: number } = { exclusivo: false }) {
  const consultas: string[] = [];
  const parametros: any[][] = [];
  let enVuelo = 0;
  let maximoEnVuelo = 0;

  const query = jest.fn(async (sql: string, params: any[] = []) => {
    consultas.push(sql);
    parametros.push(params);
    enVuelo += 1;
    maximoEnVuelo = Math.max(maximoEnVuelo, enVuelo);
    await new Promise((resolver) => setImmediate(resolver));
    enVuelo -= 1;
    if (ES_CONTEO.test(sql)) return [{ total: 7 }];
    if (/FROM inventario\s+WHERE id_almacen/i.test(sql)) return [{ id_producto: 1, stock: 2 }];
    return [{ id_producto: 1, nombre: 'Martillo', stock: 40 }];
  });

  const stockRepo = { politicaStock: jest.fn(async () => ({ modo: 'exclusivo', ...politica })) };
  const repo = new CatalogoRepository({ manager: { query } } as any, stockRepo as any);
  return { repo, consultas, parametros, stockRepo, maximoEnVuelo: () => maximoEnVuelo };
}

const FILTROS = { pagina: 1, limite: 4, orden: 'nuevo' };

describe('CatalogoRepository.buscar', () => {
  it('sin total (portada, buscador) hace una sola consulta: sin COUNT ni lectura de configuración', async () => {
    const { repo, consultas } = armar();

    const { rows } = await repo.buscar(FILTROS, { conTotal: false });

    expect(rows).toHaveLength(1);
    expect(consultas).toHaveLength(1);
    expect(consultas[0]).not.toMatch(ES_CONTEO);
    expect(consultas.join('\n')).not.toMatch(/configuraciones/);
  });

  it('con total lanza el COUNT y las filas a la vez', async () => {
    const { repo, consultas, maximoEnVuelo } = armar();

    const { total } = await repo.buscar(FILTROS);

    expect(total).toBe(7);
    expect(consultas).toHaveLength(2);
    expect(maximoEnVuelo()).toBe(2);
  });

  it('lee stock, rating e imagen por producto (LATERAL), no desde la vista que agrupa todo el catálogo', async () => {
    const { repo, consultas } = armar();

    await repo.buscar(FILTROS, { conTotal: false });

    expect(consultas[0]).not.toMatch(/vw_catalogo|vw_producto_stock|vw_producto_rating/);
    expect(consultas[0]).toMatch(/LEFT JOIN LATERAL/);
    expect(consultas[0]).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
  });

  it('en modo exclusivo muestra el stock del almacén web', async () => {
    const { repo, parametros } = armar({ exclusivo: true, idAlmacen: 2 });

    const { rows } = await repo.buscar(FILTROS, { conTotal: false });

    expect(rows[0].stock).toBe(2);
    expect(parametros[1]).toEqual([2, [1]]);
  });

  it('escapa los comodines de LIKE en el texto buscado', async () => {
    const { repo, parametros } = armar();

    await repo.buscar({ ...FILTROS, q: '50%_X' }, { conTotal: false });

    expect(parametros[0][0]).toBe('%50\\%\\_x%');
  });
});
