import sharp from 'sharp';
import { BaseDatosAlmacen, SQL_BORRAR_ARCHIVO_SIN_USO, SQL_BORRAR_ARCHIVO_SIN_USO_CON_MEJORA } from './base-datos.almacen';

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

describe('BaseDatosAlmacen.eliminar · mejora de fotos (sql/fase23)', () => {
  const conEsquema = (existe: boolean, query = jest.fn().mockResolvedValue([[], 0])) => {
    const esquema = { disponible: jest.fn().mockResolvedValue(existe) };
    return { almacen: new BaseDatosAlmacen({ query } as any, esquema as any), query, esquema };
  };

  it('con la tabla: tampoco borra un archivo que es la original o la mejorada guardada de otra foto', async () => {
    const { almacen, query } = conEsquema(true);

    await almacen.eliminar('42');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parametros] = query.mock.calls[0];
    expect(sql).toBe(SQL_BORRAR_ARCHIVO_SIN_USO_CON_MEJORA);
    expect(sql).toMatch(/NOT EXISTS[\s\S]*productos_imagenes_mejora m[\s\S]*m.url_original = \$2 OR m.url_mejorada = \$2/);
    // Conserva todas las condiciones de siempre.
    expect(sql.startsWith(SQL_BORRAR_ARCHIVO_SIN_USO)).toBe(true);
    expect(parametros).toEqual([42, '/archivos/42', '42']);
  });

  it('sin la tabla (o sin detector) usa el texto de hoy, que no la nombra', async () => {
    const { almacen, query } = conEsquema(false);
    await almacen.eliminar('42');
    expect(query.mock.calls[0][0]).toBe(SQL_BORRAR_ARCHIVO_SIN_USO);
    expect(query.mock.calls[0][0]).not.toMatch(/productos_imagenes_mejora/);
  });

  it('si el borrado falla, conserva el archivo y no corta la operación', async () => {
    const { almacen } = conEsquema(true, jest.fn().mockRejectedValue(new Error('timeout')));
    await expect(almacen.eliminar('7')).resolves.toBeUndefined();
  });
});

describe('BaseDatosAlmacen.leerOriginal', () => {
  it('devuelve los bytes de la fila y su tipo, solo con un SELECT', async () => {
    const { almacen, query } = armar(jest.fn().mockResolvedValue([{ contenido: Buffer.from('abc'), mime: 'image/png', hash: 'h' }]));
    await expect(almacen.leerOriginal({ clave: '42', url: '/archivos/42' })).resolves.toEqual({ buffer: Buffer.from('abc'), mime: 'image/png' });
    expect(query.mock.calls[0][0]).toMatch(/^SELECT/);
  });

  it('null si la clave no es un id o la fila ya no está', async () => {
    const { almacen, query } = armar(jest.fn().mockResolvedValue([]));
    await expect(almacen.leerOriginal({ clave: 'productos/1/a.jpg', url: '' })).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
    await expect(almacen.leerOriginal({ clave: '9', url: '/archivos/9' })).resolves.toBeNull();
  });
});
