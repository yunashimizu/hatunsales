import { BaseDatosAlmacen } from './base-datos.almacen';

/**
 * Una misma foto (mismo hash) se guarda una sola vez en `archivos` y la comparten
 * todos los productos o recepciones que la subieron. Borrar por id rompía la imagen
 * de los demás: el borrado debe ser condicional y en una sola sentencia.
 */
function armar(query = jest.fn().mockResolvedValue([[], 0])) {
  const almacen = new BaseDatosAlmacen({ query } as any);
  return { almacen, query };
}

describe('BaseDatosAlmacen.eliminar · archivo compartido por hash', () => {
  it('borra solo si ninguna imagen de producto, foto de recepción ni ítem de pedido usa el archivo', async () => {
    const { almacen, query } = armar();

    await almacen.eliminar('42');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parametros] = query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM archivos/);
    expect(sql).toMatch(/NOT EXISTS[\s\S]*productos_imagenes/);
    expect(sql).toMatch(/NOT EXISTS[\s\S]*recepcion_adjuntos/);
    expect(sql).toMatch(/NOT EXISTS[\s\S]*pedido_items/);
    expect(parametros).toEqual([42, '/archivos/42', '42']);
  });

  it('ignora claves que no son un id de archivo', async () => {
    const { almacen, query } = armar();

    await almacen.eliminar('productos/12/foto.jpg');
    await almacen.eliminar('0');

    expect(query).not.toHaveBeenCalled();
  });

  it('si no puede comprobar el uso conserva el archivo y no corta la operación', async () => {
    const { almacen } = armar(jest.fn().mockRejectedValue(new Error('relation "pedido_items" does not exist')));

    await expect(almacen.eliminar('7')).resolves.toBeUndefined();
  });
});
