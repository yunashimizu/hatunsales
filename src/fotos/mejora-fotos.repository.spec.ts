import { ArchivoFoto, MejoraFotosRepository } from './mejora-fotos.repository';

/**
 * Forma de las sentencias y orden de los parámetros. El SQL de verdad se probó además contra el
 * PostgreSQL local de pruebas (ver «Evidencia» del plan, tanda B2).
 */
function armar(respuesta: unknown = [{ id_imagen: 7 }], existe = true) {
  const query = jest.fn().mockResolvedValue(respuesta);
  const esquema = { disponible: jest.fn().mockResolvedValue(existe) };
  return { repo: new MejoraFotosRepository({ query } as any, esquema as any), query, esquema };
}

const original: ArchivoFoto = { proveedor: 'base_datos', url: '/archivos/10', clave: '10', thumb_url: '/archivos/10', mime: 'image/png', size: 1000, ancho: 800, alto: 600 };
const mejorada: ArchivoFoto = { proveedor: 'base_datos', url: '/archivos/11', clave: '11', thumb_url: '/archivos/11', mime: 'image/jpeg', size: 900, ancho: 1000, alto: 750 };

describe('MejoraFotosRepository', () => {
  it('disponible() pregunta al detector de la tabla', async () => {
    const { repo, esquema } = armar(undefined, false);
    await expect(repo.disponible()).resolves.toBe(false);
    expect(esquema.disponible).toHaveBeenCalled();
  });

  it('publicarMejorada: UNA sentencia que guarda la fila y apunta la imagen a la mejorada, solo si sigue en la original', async () => {
    const { repo, query } = armar();

    await expect(repo.publicarMejorada(7, 1, original, mejorada, { acciones: ['RECORTE'] })).resolves.toBe(true);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, p] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO productos_imagenes_mejora/);
    expect(sql).toMatch(/ON CONFLICT \(id_imagen\) DO UPDATE/);
    expect(sql).toMatch(/UPDATE productos_imagenes pi/);
    expect(sql).toMatch(/WHERE id_imagen = \$1 AND url = \$5::text FOR UPDATE/);
    expect(p[0]).toBe(7);
    expect(p.slice(1, 3)).toEqual(['mejorada', 1]);
    expect(p.slice(3, 11)).toEqual(['base_datos', '/archivos/10', '10', '/archivos/10', 'image/png', 1000, 800, 600]);
    expect(p.slice(11, 19)).toEqual(['base_datos', '/archivos/11', '11', '/archivos/11', 'image/jpeg', 900, 1000, 750]);
    expect(JSON.parse(p[19])).toEqual({ acciones: ['RECORTE'] });
    // La imagen toma url = $13 (url_mejorada) y clave = $14 (clave_mejorada).
    expect(sql).toMatch(/SET url = \$13::text, thumb_url = \$15::text, mime = \$16::varchar, size = \$17::integer/);
    expect(sql).toMatch(/clave_almacen = \$14::text, proveedor = \$12::varchar/);
  });

  it('publicarMejorada devuelve false si no actualizó nada (la imagen cambió o no existe)', async () => {
    const { repo } = armar([[], 0]);
    await expect(repo.publicarMejorada(7, 1, original, mejorada, {})).resolves.toBe(false);
  });

  it('registrar: no toca productos_imagenes y deja la mejorada vacía', async () => {
    const { repo, query } = armar();
    await expect(repo.registrar(7, 'sin_cambios', 1, original, {})).resolves.toBe(true);
    const [sql, p] = query.mock.calls[0];
    expect(sql).not.toMatch(/UPDATE productos_imagenes /);
    expect(sql).toMatch(/WHERE pi.id_imagen = \$1 AND pi.url = \$5::text/);
    expect(p[1]).toBe('sin_cambios');
    expect(p.slice(11, 19)).toEqual([null, null, null, null, null, null, null, null]);
  });

  it('elegir: una sentencia, sin borrar nada', async () => {
    const { repo, query } = armar();
    await expect(repo.elegir(7, 'original')).resolves.toBe(true);
    const [sql, p] = query.mock.calls[0];
    expect(p).toEqual([7, 'original']);
    expect(sql).toMatch(/UPDATE productos_imagenes_mejora/);
    expect(sql).toMatch(/UPDATE productos_imagenes pi/);
    expect(sql).not.toMatch(/DELETE/);
  });

  it('porProducto: fotos sin fila salen con mejora null; números y JSON normalizados', async () => {
    const { repo } = armar([
      { pi_id: '1', pi_url: '/archivos/1', pi_width: '800', pi_height: '600', id_imagen: null },
      { pi_id: '2', pi_url: '/archivos/11', pi_width: 1000, pi_height: 750, id_imagen: '2', estado: 'mejorada', version: '1', url_original: '/archivos/10', url_mejorada: '/archivos/11', size_original: '1000', ancho_original: '800', alto_original: '600', size_mejorada: null, ancho_mejorada: '1000', alto_mejorada: '750', informe: '{"acciones":["RECORTE"]}' },
    ]);
    const fotos = await repo.porProducto(3);
    expect(fotos[0]).toEqual({ id_imagen: 1, url: '/archivos/1', width: 800, height: 600, mejora: null });
    expect(fotos[1].mejora).toMatchObject({ id_imagen: 2, version: 1, ancho_original: 800, size_mejorada: null, informe: { acciones: ['RECORTE'] } });
  });

  it('tandas (soloSiNueva): si la foto ya tiene fila no se pisa nada', async () => {
    const { repo, query } = armar([[], 0]);
    await expect(repo.publicarMejorada(7, 1, original, mejorada, {}, true)).resolves.toBe(false);
    await repo.registrar(7, 'sin_cambios', 1, original, {}, true);
    for (const [sql] of query.mock.calls) {
      expect(sql).toMatch(/ON CONFLICT \(id_imagen\) DO NOTHING/);
      expect(sql).not.toMatch(/DO UPDATE/);
    }
  });

  it('porImagen devuelve null si no hay fila', async () => {
    const { repo } = armar([]);
    await expect(repo.porImagen(9)).resolves.toBeNull();
  });
});
