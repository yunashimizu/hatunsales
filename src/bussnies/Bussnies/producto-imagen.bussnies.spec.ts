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
    contarPorProducto: jest.fn().mockResolvedValue(0),
    siguienteOrden: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockImplementation(async (imagen: any) => {
      imagen.id_imagen = 900 + filas.length;
      filas.push(imagen);
      return imagen;
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

describe('ProductoImagenBussnies.subirVarias · fallo a medias', () => {
  it('si falla la tercera, quita las filas y los archivos de las dos primeras y de la tercera', async () => {
    const { servicio, repo, almacen } = armarSubidas();
    repo.create
      .mockImplementationOnce(async (i: any) => Object.assign(i, { id_imagen: 901 }))
      .mockImplementationOnce(async (i: any) => Object.assign(i, { id_imagen: 902 }))
      .mockRejectedValueOnce(new Error('fallo de BD'));

    await expect(servicio.subirVarias(3, [png('a.png'), png('b.png'), png('c.png')])).rejects.toThrow('fallo de BD');

    expect(repo.eliminar.mock.calls.map((c) => c[0])).toEqual([901, 902]);
    expect(almacen.eliminar.mock.calls.map((c) => c[0])).toEqual(['100', '101', '102']);
    // Las filas se quitan antes que los archivos: el almacén no borra lo que sigue referenciado.
    expect(Math.max(...repo.eliminar.mock.invocationCallOrder)).toBeLessThan(Math.min(...almacen.eliminar.mock.invocationCallOrder));
  });

  it('si falla el almacén en la segunda, limpia la primera y devuelve el error original', async () => {
    const { servicio, repo, almacen } = armarSubidas();
    almacen.guardar
      .mockImplementationOnce(async () => ({ url: '/archivos/100', thumb_url: '/archivos/100', clave: '100', mime: 'image/png', size: 1, proveedor: 'base_datos' }))
      .mockRejectedValueOnce(new Error('Cloudinary caído'));

    await expect(servicio.subirVarias(3, [png('a.png'), png('b.png')])).rejects.toThrow('Cloudinary caído');

    expect(repo.eliminar).toHaveBeenCalledTimes(1);
    expect(almacen.eliminar.mock.calls.map((c) => c[0])).toEqual(['100']);
  });

  it('un fallo al limpiar no tapa el error original', async () => {
    const { servicio, repo, almacen } = armarSubidas();
    repo.create.mockRejectedValue(new Error('fallo de BD'));
    almacen.eliminar.mockRejectedValue(new Error('tampoco borra'));

    await expect(servicio.subirVarias(3, [png('a.png')])).rejects.toThrow('fallo de BD');
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
    expect(repo.create).not.toHaveBeenCalled();
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
