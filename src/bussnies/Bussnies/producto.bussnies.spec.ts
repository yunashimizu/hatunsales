import { BadRequestException } from '@nestjs/common';
import { ProductoBussnies } from './producto.bussnies';

/** Dobles de repositorio y transacción: nada de esto toca la base de datos. */
function armar() {
  const guardados: any[] = [];
  const productosTx = {
    create: jest.fn((datos: any) => datos),
    save: jest.fn(async (datos: any) => {
      guardados.push(datos);
      return { ...datos, id_producto: 7 };
    }),
  };
  const repo = {
    buscarPorCodigoBarras: jest.fn().mockResolvedValue(null),
    buscarPorSku: jest.fn().mockResolvedValue(null),
    detallePorId: jest.fn().mockResolvedValue({ id_producto: 7, nombre: 'X' }),
    getById: jest.fn().mockResolvedValue({ id_producto: 7 }),
    actualizar: jest.fn().mockResolvedValue(undefined),
  };
  const inventarioRepo = {
    existeAlmacen: jest.fn().mockResolvedValue(true),
    almacenes: jest.fn().mockResolvedValue([]),
    crearFilaVacia: jest.fn(),
    ajustar: jest.fn(),
  };
  const dataSource = {
    transaction: jest.fn(async (cb: any) => cb({ getRepository: () => productosTx })),
  };
  const servicio = new ProductoBussnies(repo as any, inventarioRepo as any, dataSource as any);
  return { servicio, repo, dataSource, guardados };
}

describe('ProductoBussnies · unidad de medida al guardar', () => {
  it('crea con «kg» y guarda el código KGM', async () => {
    const { servicio, guardados } = armar();
    await servicio.create({ nombre: 'Clavos', unidad_medida: 'kg' } as any);
    expect(guardados[0].unidad_medida).toBe('KGM');
  });

  it('crea sin unidad y guarda NIU', async () => {
    const { servicio, guardados } = armar();
    await servicio.create({ nombre: 'Clavos' } as any);
    expect(guardados[0].unidad_medida).toBe('NIU');
  });

  it('crea con «Plancha» y guarda ST', async () => {
    const { servicio, guardados } = armar();
    await servicio.create({ nombre: 'Calamina', unidad_medida: 'Plancha' } as any);
    expect(guardados[0].unidad_medida).toBe('ST');
  });

  it('crea con una unidad desconocida y responde 400 sin tocar la BD', async () => {
    const { servicio, dataSource } = armar();
    const intento = servicio.create({ nombre: 'Clavos', unidad_medida: 'XYZ' } as any);
    await expect(intento).rejects.toBeInstanceOf(BadRequestException);
    await expect(intento).rejects.toThrow('Unidad de medida no válida: «XYZ». Elija una de la lista.');
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('update sin el campo no toca unidad_medida', async () => {
    const { servicio, repo } = armar();
    await servicio.update({ precio_venta: 12 } as any, 7);
    expect(repo.actualizar).toHaveBeenCalledTimes(1);
    const cambios = repo.actualizar.mock.calls[0][1];
    expect(cambios).toEqual({ precio_venta: 12 });
    expect('unidad_medida' in cambios).toBe(false);
  });

  it('update con una unidad legada la guarda como código', async () => {
    const { servicio, repo } = armar();
    await servicio.update({ unidad_medida: 'UND' } as any, 7);
    expect(repo.actualizar.mock.calls[0][1]).toEqual({ unidad_medida: 'NIU' });
  });

  it('update con una unidad inválida responde 400 y no actualiza', async () => {
    const { servicio, repo } = armar();
    await expect(servicio.update({ unidad_medida: 'XYZ' } as any, 7)).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.actualizar).not.toHaveBeenCalled();
  });
});

describe('ProductoBussnies.unidadesMedida', () => {
  it('devuelve grupos, solo unidades visibles y los sinónimos', () => {
    const { servicio } = armar();
    const r = servicio.unidadesMedida();
    expect(r.grupos[0]).toBe('Conteo');
    expect(r.unidades.length).toBeGreaterThan(0);
    expect(r.unidades.every((u) => u.visible)).toBe(true);
    expect(r.unidades.find((u) => u.codigo === 'MIL')).toBeUndefined();
    expect(r.unidades.find((u) => u.codigo === 'MLL')).toBeDefined();
    expect(r.alias['UND']).toBe('NIU');
    expect(r.alias['CJ']).toBeUndefined();
  });
});
