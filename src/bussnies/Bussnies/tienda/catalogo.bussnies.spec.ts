import { CatalogoBussnies } from './catalogo.bussnies';

/**
 * Endpoints públicos del catálogo: el `limite` llega de la URL sin sesión, así
 * que se topa (antes `?limite=100000` devolvía todo el catálogo y `?limite=abc`
 * terminaba en un 500 por `LIMIT NaN`). Portada y buscador no usan el total, así
 * que tampoco pagan el COUNT.
 */
function armar(filas: any[] = [{ id_producto: 1, nombre: 'Martillo', precio_venta: '15.00', precio_final: '15.00', stock: 4 }]) {
  const repo = { buscar: jest.fn(async () => ({ rows: filas, total: filas.length })) };
  return { servicio: new CatalogoBussnies(repo as any), repo };
}

describe('CatalogoBussnies · límites de los endpoints públicos (R11)', () => {
  it.each([
    [Number.NaN, 8],
    [1000, 24],
    [0, 1],
    [-5, 1],
    [6.9, 6],
    [4, 4],
  ])('destacados con limite %p consulta %p productos sin contar el total', async (pedido, esperado) => {
    const { servicio, repo } = armar();

    await servicio.destacados(pedido);

    expect(repo.buscar).toHaveBeenCalledWith(
      expect.objectContaining({ solo_destacado: true, limite: esperado, pagina: 1 }),
      { conTotal: false },
    );
  });

  it('ofertas también topa el límite y no cuenta el total', async () => {
    const { servicio, repo } = armar();

    await servicio.ofertas(100000);

    expect(repo.buscar).toHaveBeenCalledWith(expect.objectContaining({ solo_oferta: true, limite: 24 }), { conTotal: false });
  });

  it('el buscador rápido topa el límite, recorta el texto y no cuenta el total', async () => {
    const { servicio, repo } = armar();

    await servicio.buscarRapido(`  ${'taladro '.repeat(30)}`, Number('abc'));

    const [filtros, opciones] = repo.buscar.mock.calls[0] as any[];
    expect(filtros.limite).toBe(8);
    expect(filtros.q.length).toBeLessThanOrEqual(100);
    expect(opciones).toEqual({ conTotal: false });
  });

  it('el buscador rápido ignora un texto que no es texto (q repetido en la URL)', async () => {
    const { servicio, repo } = armar();

    await expect(servicio.buscarRapido(['ta', 'la'] as any)).resolves.toEqual([]);
    expect(repo.buscar).not.toHaveBeenCalled();
  });

  it('si no hay destacados muestra los más nuevos, también sin COUNT', async () => {
    const { servicio, repo } = armar([]);

    await servicio.destacados(4);

    expect(repo.buscar).toHaveBeenLastCalledWith(expect.objectContaining({ orden: 'nuevo', limite: 4 }), { conTotal: false });
  });
});
