import sharp from 'sharp';
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

describe('BaseDatosAlmacen.guardar · medidas de la foto', () => {
  const entrada = (buffer: Buffer) => ({ buffer, nombre_original: 'foto.png', mime: 'image/png', carpeta: '3' });
  // El hash ya existe: guardar() reutiliza la fila y no inserta.
  const yaGuardada = () => jest.fn().mockResolvedValue([{ id_archivo: 9 }]);

  it('devuelve el ancho y el alto reales de la imagen', async () => {
    const { almacen } = armar(yaGuardada());
    const png = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#fff' } }).png().toBuffer();

    const guardada = await almacen.guardar(entrada(png));

    expect(guardada).toMatchObject({ url: '/archivos/9', clave: '9', proveedor: 'base_datos', width: 64, height: 32 });
  });

  it('si no puede leer las medidas igual guarda la foto, sin ellas', async () => {
    const { almacen } = armar(yaGuardada());

    const guardada = await almacen.guardar(entrada(Buffer.from('no es una imagen')));

    expect(guardada.url).toBe('/archivos/9');
    expect(guardada.width).toBeUndefined();
    expect(guardada.height).toBeUndefined();
  });
});
