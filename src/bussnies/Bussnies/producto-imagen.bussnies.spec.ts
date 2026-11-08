import { ProductoImagenBussnies } from './producto-imagen.bussnies';

/**
 * Al quitar una foto, la fila propia debe desaparecer ANTES de pedirle al almacén que
 * borre el archivo: el almacén solo lo borra si ya nadie lo referencia, y la fila del
 * propio producto contaría como uso.
 */
function armar() {
  const repo = {
    findOneById: jest.fn().mockResolvedValue({
      id_imagen: 5,
      clave_almacen: '42',
      producto: { id_producto: 3 },
    }),
    eliminar: jest.fn().mockResolvedValue(undefined),
    asegurarPrincipal: jest.fn().mockResolvedValue(undefined),
    findByProducto: jest.fn().mockResolvedValue([]),
  };
  const almacen = { nombre: 'base_datos', guardar: jest.fn(), eliminar: jest.fn().mockResolvedValue(undefined) };
  const servicio = new ProductoImagenBussnies(repo as any, {} as any, almacen as any);
  return { servicio, repo, almacen };
}

describe('ProductoImagenBussnies.remove · imagen compartida', () => {
  it('quita la fila de la imagen antes de pedir el borrado del archivo', async () => {
    const { servicio, repo, almacen } = armar();

    await servicio.remove(3, 5);

    expect(repo.eliminar).toHaveBeenCalledWith(5);
    expect(almacen.eliminar).toHaveBeenCalledWith('42');
    expect(repo.eliminar.mock.invocationCallOrder[0]).toBeLessThan(almacen.eliminar.mock.invocationCallOrder[0]);
  });

  it('resuelve aunque el almacén no haya respondido al borrado', async () => {
    const { servicio, repo, almacen } = armar();
    // El `destroy` de Cloudinary nunca contesta: la respuesta al usuario no debe quedar esperándolo.
    almacen.eliminar.mockReturnValue(new Promise(() => undefined));

    await expect(servicio.remove(3, 5)).resolves.toEqual([]);

    expect(repo.eliminar).toHaveBeenCalledWith(5);
    expect(almacen.eliminar).toHaveBeenCalledWith('42');
  });

  it('un fallo del almacén al borrar el archivo no rompe la respuesta', async () => {
    const { servicio, almacen } = armar();
    almacen.eliminar.mockRejectedValue(new Error('Cloudinary caído'));

    await expect(servicio.remove(3, 5)).resolves.toEqual([]);
  });

  it('si la fila no se puede quitar, el archivo no se toca', async () => {
    const { servicio, repo, almacen } = armar();
    repo.eliminar.mockRejectedValue(new Error('fallo de BD'));

    await expect(servicio.remove(3, 5)).rejects.toThrow('fallo de BD');
    expect(almacen.eliminar).not.toHaveBeenCalled();
  });

  it('no deja quitar la imagen de otro producto', async () => {
    const { servicio, repo, almacen } = armar();

    await expect(servicio.remove(99, 5)).rejects.toThrow('Imagen no encontrada');
    expect(repo.eliminar).not.toHaveBeenCalled();
    expect(almacen.eliminar).not.toHaveBeenCalled();
  });
});

/** Dobles para subir/reemplazar: el almacén numera los archivos y el repositorio guarda en memoria. */
function armarSubidas() {
  let siguiente = 100;
  const filas: any[] = [];
  const almacen = {
    nombre: 'base_datos',
    guardar: jest.fn().mockImplementation(async () => {
      const id = siguiente++;
      return { url: `/archivos/${id}`, thumb_url: `/archivos/${id}`, clave: String(id), mime: 'image/png', size: 10, width: 4, height: 3, proveedor: 'base_datos' };
    }),
    eliminar: jest.fn().mockResolvedValue(undefined),
  };
  const repo = {
    resumenGaleria: jest.fn().mockResolvedValue({ total: 0, siguienteOrden: 0 }),
    // Como TypeORM: guarda todas las filas de una vez y las devuelve con su id, en el mismo orden.
    crearVarias: jest.fn().mockImplementation(async (imagenes: any[]) => {
      imagenes.forEach((imagen) => {
        imagen.id_imagen = 900 + filas.length;
        filas.push(imagen);
      });
      return imagenes;
    }),
    eliminar: jest.fn().mockResolvedValue(undefined),
    findOneById: jest.fn(),
    actualizarArchivo: jest.fn().mockResolvedValue(undefined),
    findByProducto: jest.fn().mockResolvedValue([]),
  };
  const productoRepo = { getById: jest.fn().mockResolvedValue({ id_producto: 3 }) };
  const servicio = new ProductoImagenBussnies(repo as any, productoRepo as any, almacen as any);
  return { servicio, repo, almacen, filas };
}

const png = (nombre: string) => ({ originalname: nombre, mimetype: 'image/png', buffer: Buffer.from('x'), size: 1 });

const turno = () => new Promise<void>((r) => setImmediate(r));

describe('ProductoImagenBussnies.subirVarias · fallo a medias', () => {
  // Todo o nada, ahora con las subidas de 3 en 3 y las filas en una sola llamada.

  it('si falla el almacén en una, borra TODAS las claves que llegaron a resolver y no guarda ninguna fila', async () => {
    const { servicio, repo, almacen, filas } = armarSubidas();
    // Con 3 en vuelo, la segunda falla mientras la primera y la tercera sí se resuelven.
    almacen.guardar
      .mockImplementationOnce(async () => ({ url: '/archivos/100', thumb_url: '/archivos/100', clave: '100', mime: 'image/png', size: 1, proveedor: 'base_datos' }))
      .mockRejectedValueOnce(new Error('Cloudinary caído'))
      .mockImplementationOnce(async () => ({ url: '/archivos/102', thumb_url: '/archivos/102', clave: '102', mime: 'image/png', size: 1, proveedor: 'base_datos' }));

    await expect(servicio.subirVarias(3, [png('a.png'), png('b.png'), png('c.png')])).rejects.toThrow('Cloudinary caído');

    expect(almacen.eliminar.mock.calls.map((c) => c[0]).sort()).toEqual(['100', '102']);
    expect(repo.crearVarias).not.toHaveBeenCalled();
    expect(filas).toEqual([]);
    // No hubo filas que quitar: solo archivos.
    expect(repo.eliminar).not.toHaveBeenCalled();
  });

  it('espera a las subidas en vuelo antes de limpiar: una clave que se resuelve después del fallo también se borra', async () => {
    const { servicio, repo, almacen } = armarSubidas();
    let liberarTercera!: () => void;
    almacen.guardar
      .mockRejectedValueOnce(new Error('falla la primera'))
      .mockImplementationOnce(async () => ({ url: '/archivos/101', thumb_url: '/archivos/101', clave: '101', mime: 'image/png', size: 1, proveedor: 'base_datos' }))
      .mockImplementationOnce(() => new Promise((resolver) => {
        liberarTercera = () => resolver({ url: '/archivos/102', thumb_url: '/archivos/102', clave: '102', mime: 'image/png', size: 1, proveedor: 'base_datos' });
      }));

    const resultado = servicio.subirVarias(3, [png('a.png'), png('b.png'), png('c.png')]).catch((e) => e);
    await turno();
    // La tercera sigue en vuelo: todavía no se limpia nada.
    expect(almacen.eliminar).not.toHaveBeenCalled();

    liberarTercera();
    const error = await resultado;

    expect((error as Error).message).toBe('falla la primera');
    expect(almacen.eliminar.mock.calls.map((c) => c[0]).sort()).toEqual(['101', '102']);
    expect(repo.crearVarias).not.toHaveBeenCalled();
  });

  it('si falla la base al guardar las filas, borra todas las claves y el error original sube', async () => {
    const { servicio, repo, almacen } = armarSubidas();
    repo.crearVarias.mockRejectedValue(new Error('fallo de BD'));

    await expect(servicio.subirVarias(3, [png('a.png'), png('b.png'), png('c.png')])).rejects.toThrow('fallo de BD');

    expect(repo.crearVarias).toHaveBeenCalledTimes(1);
    expect(almacen.eliminar.mock.calls.map((c) => c[0]).sort()).toEqual(['100', '101', '102']);
    // La transacción es única: si falló no hay filas creadas que quitar una a una.
    expect(repo.eliminar).not.toHaveBeenCalled();
  });

  it('un fallo al limpiar no tapa el error original', async () => {
    const { servicio, repo, almacen } = armarSubidas();
    repo.crearVarias.mockRejectedValue(new Error('fallo de BD'));
    almacen.eliminar.mockRejectedValue(new Error('tampoco borra'));

    await expect(servicio.subirVarias(3, [png('a.png')])).rejects.toThrow('fallo de BD');
  });

  it('un fallo al limpiar tras un fallo del almacén tampoco tapa el error original', async () => {
    const { servicio, almacen } = armarSubidas();
    almacen.guardar.mockRejectedValue(new Error('Cloudinary caído'));
    almacen.eliminar.mockRejectedValue(new Error('tampoco borra'));

    await expect(servicio.subirVarias(3, [png('a.png'), png('b.png')])).rejects.toThrow('Cloudinary caído');
  });

  it('un lote que sale bien no borra nada', async () => {
    const { servicio, repo, almacen } = armarSubidas();

    const guardadas = await servicio.subirVarias(3, [png('a.png'), png('b.png')]);

    expect(guardadas.map((g) => g.orden)).toEqual([0, 1]);
    expect(guardadas.map((g) => g.is_primary)).toEqual([true, false]);
    expect(repo.eliminar).not.toHaveBeenCalled();
    expect(almacen.eliminar).not.toHaveBeenCalled();
  });
});

describe('ProductoImagenBussnies.subirVarias · paralelismo y una sola transacción', () => {
  it('con 5 fotos nunca hay más de 3 guardar en vuelo', async () => {
    const { servicio, almacen } = armarSubidas();
    let enVuelo = 0;
    let maximo = 0;
    let n = 100;
    almacen.guardar.mockImplementation(async () => {
      const id = n++;
      enVuelo++;
      maximo = Math.max(maximo, enVuelo);
      await turno();
      enVuelo--;
      return { url: `/archivos/${id}`, thumb_url: `/archivos/${id}`, clave: String(id), mime: 'image/png', size: 10, width: 4, height: 3, proveedor: 'base_datos' };
    });

    await servicio.subirVarias(3, ['a', 'b', 'c', 'd', 'e'].map((x) => png(`${x}.png`)));

    expect(almacen.guardar).toHaveBeenCalledTimes(5);
    expect(maximo).toBe(3);
  });

  it('consulta la galería una sola vez y guarda las 5 filas con una sola llamada a crearVarias', async () => {
    const { servicio, repo } = armarSubidas();

    await servicio.subirVarias(3, ['a', 'b', 'c', 'd', 'e'].map((x) => png(`${x}.png`)));

    expect(repo.resumenGaleria).toHaveBeenCalledTimes(1);
    expect(repo.resumenGaleria).toHaveBeenCalledWith(3);
    expect(repo.crearVarias).toHaveBeenCalledTimes(1);
    expect(repo.crearVarias.mock.calls[0][0]).toHaveLength(5);
  });

  it('las filas salen en el orden recibido aunque las subidas terminen al revés', async () => {
    const { servicio, repo, almacen } = armarSubidas();
    // La primera foto es la más lenta: termina de última.
    almacen.guardar.mockImplementation(async (entrada: any) => {
      const letra = entrada.nombre_original[0];
      const retraso = letra === 'a' ? 3 : letra === 'b' ? 2 : 1;
      for (let i = 0; i < retraso; i++) await turno();
      return { url: `/archivos/${letra}`, thumb_url: `/archivos/${letra}`, clave: letra, mime: 'image/png', size: 10, width: 4, height: 3, proveedor: 'base_datos' };
    });

    await servicio.subirVarias(3, [png('a.png'), png('b.png'), png('c.png')]);

    const filas = repo.crearVarias.mock.calls[0][0];
    expect(filas.map((f: any) => f.clave_almacen)).toEqual(['a', 'b', 'c']);
    expect(filas.map((f: any) => f.orden)).toEqual([0, 1, 2]);
  });

  it('con la galería vacía, solo la primera del lote queda como principal', async () => {
    const { servicio, repo } = armarSubidas();

    await servicio.subirVarias(3, [png('a.png'), png('b.png'), png('c.png')]);

    expect(repo.crearVarias.mock.calls[0][0].map((f: any) => f.is_primary)).toEqual([true, false, false]);
  });

  it('con la galería ya con fotos, ninguna queda como principal y el orden sigue desde el siguiente', async () => {
    const { servicio, repo } = armarSubidas();
    repo.resumenGaleria.mockResolvedValue({ total: 4, siguienteOrden: 7 });

    await servicio.subirVarias(3, [png('a.png'), png('b.png')]);

    const filas = repo.crearVarias.mock.calls[0][0];
    expect(filas.map((f: any) => f.is_primary)).toEqual([false, false]);
    expect(filas.map((f: any) => f.orden)).toEqual([7, 8]);
  });

  it('devuelve las filas guardadas con su id, en el orden recibido', async () => {
    const { servicio } = armarSubidas();

    const guardadas = await servicio.subirVarias(3, [png('a.png'), png('b.png')]);

    expect(guardadas.map((g) => g.id_imagen)).toEqual([900, 901]);
  });

  it('no sube nada si un archivo no es una imagen válida', async () => {
    const { servicio, repo, almacen } = armarSubidas();

    await expect(servicio.subirVarias(3, [png('a.png'), { ...png('b.bmp'), mimetype: 'image/bmp' }])).rejects.toThrow('no es una imagen válida');

    expect(almacen.guardar).not.toHaveBeenCalled();
    expect(repo.crearVarias).not.toHaveBeenCalled();
  });
});

describe('ProductoImagenBussnies.reemplazar', () => {
  const existente = { id_imagen: 5, clave_almacen: '42', orden: 2, is_primary: true, producto: { id_producto: 3 } };

  it('guarda el archivo nuevo, actualiza la fila sin tocar orden ni principal y borra el viejo al final', async () => {
    const { servicio, repo, almacen } = armarSubidas();
    repo.findOneById.mockResolvedValue(existente);

    await servicio.reemplazar(3, 5, png('nueva.png'));

    expect(repo.actualizarArchivo).toHaveBeenCalledWith(5, expect.objectContaining({ url: '/archivos/100', clave_almacen: '100', proveedor: 'base_datos' }));
    // Solo cambian los campos del archivo: orden e is_primary no viajan en la actualización.
    const datos = repo.actualizarArchivo.mock.calls[0][1];
    expect(datos).not.toHaveProperty('orden');
    expect(datos).not.toHaveProperty('is_primary');
    expect(repo.crearVarias).not.toHaveBeenCalled();
    expect(almacen.eliminar).toHaveBeenCalledTimes(1);
    expect(almacen.eliminar).toHaveBeenCalledWith('42');
    expect(almacen.guardar.mock.invocationCallOrder[0]).toBeLessThan(repo.actualizarArchivo.mock.invocationCallOrder[0]);
    expect(repo.actualizarArchivo.mock.invocationCallOrder[0]).toBeLessThan(almacen.eliminar.mock.invocationCallOrder[0]);
  });

  it('si no se puede guardar el archivo nuevo, la foto vieja queda intacta', async () => {
    const { servicio, repo, almacen } = armarSubidas();
    repo.findOneById.mockResolvedValue(existente);
    almacen.guardar.mockRejectedValue(new Error('almacén caído'));

    await expect(servicio.reemplazar(3, 5, png('nueva.png'))).rejects.toThrow('almacén caído');

    expect(repo.actualizarArchivo).not.toHaveBeenCalled();
    expect(almacen.eliminar).not.toHaveBeenCalled();
  });

  it('si falla la actualización de la fila, descarta el archivo nuevo y no toca el viejo', async () => {
    const { servicio, repo, almacen } = armarSubidas();
    repo.findOneById.mockResolvedValue(existente);
    repo.actualizarArchivo.mockRejectedValue(new Error('fallo de BD'));

    await expect(servicio.reemplazar(3, 5, png('nueva.png'))).rejects.toThrow('fallo de BD');

    expect(almacen.eliminar.mock.calls.map((c) => c[0])).toEqual(['100']);
  });

  it('resuelve aunque el almacén no haya respondido al borrado del archivo viejo', async () => {
    const { servicio, repo, almacen } = armarSubidas();
    repo.findOneById.mockResolvedValue(existente);
    almacen.eliminar.mockReturnValue(new Promise(() => undefined));

    await expect(servicio.reemplazar(3, 5, png('nueva.png'))).resolves.toEqual([]);
    expect(almacen.eliminar).toHaveBeenCalledWith('42');
  });

  it('si el archivo es idéntico al actual (misma clave), no lo borra', async () => {
    const { servicio, repo, almacen } = armarSubidas();
    repo.findOneById.mockResolvedValue({ ...existente, clave_almacen: '100' });

    await servicio.reemplazar(3, 5, png('igual.png'));

    expect(almacen.eliminar).not.toHaveBeenCalled();
  });

  it('un fallo al borrar el archivo viejo no hace fallar el reemplazo', async () => {
    const { servicio, repo, almacen } = armarSubidas();
    repo.findOneById.mockResolvedValue(existente);
    almacen.eliminar.mockRejectedValue(new Error('no se pudo borrar'));

    await expect(servicio.reemplazar(3, 5, png('nueva.png'))).resolves.toEqual([]);
    expect(repo.actualizarArchivo).toHaveBeenCalled();
  });

  it('no deja reemplazar la foto de otro producto ni un tipo no admitido', async () => {
    const { servicio, repo, almacen } = armarSubidas();
    repo.findOneById.mockResolvedValue(existente);

    await expect(servicio.reemplazar(99, 5, png('a.png'))).rejects.toThrow('Imagen no encontrada');
    await expect(servicio.reemplazar(3, 5, { ...png('a.bmp'), mimetype: 'image/bmp' })).rejects.toThrow('no es una imagen válida');

    expect(almacen.guardar).not.toHaveBeenCalled();
    expect(repo.actualizarArchivo).not.toHaveBeenCalled();
  });
});
