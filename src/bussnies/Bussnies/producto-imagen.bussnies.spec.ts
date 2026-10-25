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
