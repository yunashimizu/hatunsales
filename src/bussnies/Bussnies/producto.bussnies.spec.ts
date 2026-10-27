import { BadRequestException, ConflictException, InternalServerErrorException } from '@nestjs/common';
import { ean13Interno, esEan13Valido } from '../../util/codigo-barras.util';
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

describe('ProductoBussnies · unicidad de código de barras y SKU', () => {
  it('rechaza un código de barras que ya tiene otro producto y dice cuál', async () => {
    const { servicio, repo, guardados } = armar();
    repo.buscarPorCodigoBarras.mockResolvedValue({ id_producto: 3, nombre: 'CEMENTO', codigo_barras: ' 7501 ' });
    await expect(servicio.create({ nombre: 'X', codigo_barras: '7501' } as any)).rejects.toThrow(
      'Ya existe un producto con ese código de barras (CEMENTO)',
    );
    expect(guardados).toHaveLength(0);
  });

  it('rechaza un código de barras que es el SKU de otro (la consulta cae a SKU)', async () => {
    const { servicio, repo } = armar();
    repo.buscarPorCodigoBarras.mockResolvedValue({ id_producto: 3, nombre: 'CEMENTO', codigo_barras: '', sku: 'CEM-01' });
    const error: any = await servicio.create({ nombre: 'X', codigo_barras: 'CEM-01' } as any).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe('Ese código de barras ya es el SKU de otro producto (CEMENTO)');
  });

  it('rechaza un código de barras que coincide con el SKU de otro aunque la consulta por barras no lo vea', async () => {
    const { servicio, repo } = armar();
    repo.buscarPorSku.mockResolvedValue({ id_producto: 5, nombre: 'ARENA' });
    await expect(servicio.create({ nombre: 'X', codigo_barras: 'ARE-9' } as any)).rejects.toThrow(
      'Ese código de barras ya es el SKU de otro producto (ARENA)',
    );
    expect(repo.buscarPorSku).toHaveBeenCalledWith('ARE-9');
  });

  it('rechaza un SKU que ya es el código de barras de otro producto', async () => {
    const { servicio, repo } = armar();
    repo.buscarPorCodigoBarras.mockResolvedValue({ id_producto: 3, nombre: 'CEMENTO', codigo_barras: '7501234567890' });
    const error: any = await servicio.create({ nombre: 'X', sku: '7501234567890' } as any).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe('Ese SKU ya es el código de barras de otro producto (CEMENTO)');
    expect(repo.buscarPorCodigoBarras).toHaveBeenCalledWith('7501234567890');
  });

  it('rechaza un SKU repetido', async () => {
    const { servicio, repo } = armar();
    repo.buscarPorSku.mockResolvedValue({ id_producto: 3, nombre: 'CEMENTO' });
    await expect(servicio.create({ nombre: 'X', sku: 'CEM-01' } as any)).rejects.toThrow(
      'Ya existe un producto con ese SKU (CEMENTO)',
    );
  });

  it('un SKU hallado solo por la caída a SKU de la consulta de barras no se toma por código de barras', async () => {
    const { servicio, repo } = armar();
    // buscarPorCodigoBarras cae a SKU y devuelve un producto cuyo código de barras es distinto del SKU pedido.
    repo.buscarPorCodigoBarras.mockResolvedValue({ id_producto: 3, nombre: 'CEMENTO', codigo_barras: '999', sku: 'CEM-01' });
    await expect(servicio.create({ nombre: 'X', sku: 'CEM-01' } as any)).resolves.toBeDefined();
  });

  it('al editar, el propio producto no cuenta como choque', async () => {
    const { servicio, repo } = armar();
    repo.buscarPorCodigoBarras.mockResolvedValue({ id_producto: 7, nombre: 'YO', codigo_barras: '7501' });
    repo.buscarPorSku.mockResolvedValue({ id_producto: 7, nombre: 'YO' });
    await expect(servicio.update({ codigo_barras: '7501', sku: 'YO-1' } as any, 7)).resolves.toBeDefined();
  });

  it('sin choques crea normalmente', async () => {
    const { servicio, guardados } = armar();
    await servicio.create({ nombre: 'X', codigo_barras: '111', sku: 'X-1' } as any);
    expect(guardados).toHaveLength(1);
  });
});

describe('ProductoBussnies · generarCodigoInterno', () => {
  function conSecuencia(numeros: number[]) {
    const ctx = armar();
    const repo = ctx.repo as any;
    repo.siguienteCodigoInterno = jest.fn();
    for (const n of numeros) repo.siguienteCodigoInterno.mockResolvedValueOnce(n);
    return { ...ctx, repo };
  }

  it('devuelve un EAN-13 válido que empieza en 2 con la secuencia rellenada', async () => {
    const { servicio, repo } = conSecuencia([42]);
    const { codigo } = await servicio.generarCodigoInterno();
    expect(codigo).toHaveLength(13);
    expect(codigo.startsWith('20000000004')).toBe(true);
    expect(esEan13Valido(codigo)).toBe(true);
    expect(repo.buscarPorCodigoBarras).toHaveBeenCalledWith(codigo);
  });

  it('si el candidato ya existe, toma el siguiente número', async () => {
    const { servicio, repo } = conSecuencia([1, 2]);
    repo.buscarPorCodigoBarras.mockResolvedValueOnce({ id_producto: 9 });
    const { codigo } = await servicio.generarCodigoInterno();
    expect(codigo).toBe(ean13Interno(2));
    expect(repo.siguienteCodigoInterno).toHaveBeenCalledTimes(2);
  });

  it('tras 5 candidatos ocupados responde 500 sin seguir', async () => {
    const { servicio, repo } = conSecuencia([1, 2, 3, 4, 5, 6]);
    repo.buscarPorCodigoBarras.mockResolvedValue({ id_producto: 9 });
    const intento = servicio.generarCodigoInterno();
    await expect(intento).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(repo.siguienteCodigoInterno).toHaveBeenCalledTimes(5);
  });

  it('si la secuencia no existe (42P01) responde 500 con el aviso del SQL', async () => {
    const { servicio, repo } = conSecuencia([]);
    repo.siguienteCodigoInterno.mockRejectedValue({ code: '42P01', message: 'relation does not exist' });
    const intento = servicio.generarCodigoInterno();
    await expect(intento).rejects.toBeInstanceOf(InternalServerErrorException);
    await expect(intento).rejects.toThrow('Falta correr sql/codigo_interno_secuencia.sql');
  });

  it('42P01 dentro de driverError también se reconoce', async () => {
    const { servicio, repo } = conSecuencia([]);
    repo.siguienteCodigoInterno.mockRejectedValue({ driverError: { code: '42P01' } });
    await expect(servicio.generarCodigoInterno()).rejects.toThrow('Falta correr sql/codigo_interno_secuencia.sql');
  });

  it('otro error de la base sube tal cual', async () => {
    const { servicio, repo } = conSecuencia([]);
    const falla = new Error('conexión caída');
    repo.siguienteCodigoInterno.mockRejectedValue(falla);
    await expect(servicio.generarCodigoInterno()).rejects.toBe(falla);
  });

  it('si la secuencia superó los 11 dígitos responde 500', async () => {
    const { servicio } = conSecuencia([100_000_000_000]);
    await expect(servicio.generarCodigoInterno()).rejects.toThrow('agotó los 11 dígitos');
  });
});
