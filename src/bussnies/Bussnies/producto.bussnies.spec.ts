import { BadRequestException, ConflictException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
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
    // UPDATE de la edición con ajuste de stock (dentro de la transacción).
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const repo = {
    buscarPorCodigoBarras: jest.fn().mockResolvedValue(null),
    buscarPorSku: jest.fn().mockResolvedValue(null),
    // Unicidad de barras y SKU: una sola consulta, sin choques por omisión.
    buscarChoquesDeCodigos: jest.fn().mockResolvedValue([]),
    detallePorId: jest.fn().mockResolvedValue({ id_producto: 7, nombre: 'X' }),
    getById: jest.fn().mockResolvedValue({ id_producto: 7 }),
    actualizarSiExiste: jest.fn().mockResolvedValue(true),
    delete: jest.fn().mockResolvedValue(1),
    listarSinCodigoSunat: jest.fn().mockResolvedValue({ total: 0, datos: [] }),
    // Por omisión todos los ids existen: devuelve los que recibe.
    asignarCodigoSunat: jest.fn(async (ids: number[]) => ids),
  };
  const inventarioRepo = {
    existeAlmacen: jest.fn().mockResolvedValue(true),
    almacenes: jest.fn().mockResolvedValue([]),
    insertarFilaVacia: jest.fn(),
    ajustar: jest.fn(),
  };
  const inventarioBussnies = { ajustarEnTransaccion: jest.fn().mockResolvedValue(12) };
  // Cada transacción recibe un manager propio, para poder comprobar que todo usa el mismo.
  const managers: any[] = [];
  const dataSource = {
    transaction: jest.fn(async (cb: any) => {
      const manager = { getRepository: () => productosTx, query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
      managers.push(manager);
      return cb(manager);
    }),
  };
  const servicio = new ProductoBussnies(repo as any, inventarioRepo as any, dataSource as any, inventarioBussnies as any);
  return { servicio, repo, dataSource, guardados, inventarioRepo, inventarioBussnies, productosTx, managers };
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
    expect(repo.actualizarSiExiste).toHaveBeenCalledTimes(1);
    const cambios = repo.actualizarSiExiste.mock.calls[0][1];
    expect(cambios).toEqual({ precio_venta: 12 });
    expect('unidad_medida' in cambios).toBe(false);
  });

  it('update con una unidad legada la guarda como código', async () => {
    const { servicio, repo } = armar();
    await servicio.update({ unidad_medida: 'UND' } as any, 7);
    expect(repo.actualizarSiExiste.mock.calls[0][1]).toEqual({ unidad_medida: 'NIU' });
  });

  it('update con una unidad inválida responde 400 y no actualiza', async () => {
    const { servicio, repo } = armar();
    await expect(servicio.update({ unidad_medida: 'XYZ' } as any, 7)).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.actualizarSiExiste).not.toHaveBeenCalled();
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
  // Una sola consulta (`buscarChoquesDeCodigos`) trae los productos que usan alguno de los códigos
  // como barras o como SKU; la decisión de qué choque reportar se toma en memoria.
  it('rechaza un código de barras que ya tiene otro producto y dice cuál', async () => {
    const { servicio, repo, guardados } = armar();
    repo.buscarChoquesDeCodigos.mockResolvedValue([{ id_producto: 3, nombre: 'CEMENTO', codigo_barras: ' 7501 ', sku: '' }]);
    await expect(servicio.create({ nombre: 'X', codigo_barras: '7501' } as any)).rejects.toThrow(
      'Ya existe un producto con ese código de barras (CEMENTO)',
    );
    expect(guardados).toHaveLength(0);
  });

  it('rechaza un código de barras que es el SKU de otro (sin distinguir mayúsculas, como el lector)', async () => {
    const { servicio, repo } = armar();
    repo.buscarChoquesDeCodigos.mockResolvedValue([{ id_producto: 3, nombre: 'CEMENTO', codigo_barras: '', sku: 'cem-01' }]);
    const error: any = await servicio.create({ nombre: 'X', codigo_barras: 'CEM-01' } as any).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe('Ese código de barras ya es el SKU de otro producto (CEMENTO)');
  });

  it('rechaza un código de barras que coincide con el SKU de otro aunque nadie lo tenga como barras', async () => {
    const { servicio, repo } = armar();
    repo.buscarChoquesDeCodigos.mockResolvedValue([{ id_producto: 5, nombre: 'ARENA', codigo_barras: null, sku: 'ARE-9' }]);
    await expect(servicio.create({ nombre: 'X', codigo_barras: 'ARE-9' } as any)).rejects.toThrow(
      'Ese código de barras ya es el SKU de otro producto (ARENA)',
    );
    expect(repo.buscarChoquesDeCodigos).toHaveBeenCalledWith(['ARE-9']);
  });

  it('rechaza un SKU que ya es el código de barras de otro producto', async () => {
    const { servicio, repo } = armar();
    repo.buscarChoquesDeCodigos.mockResolvedValue([
      { id_producto: 3, nombre: 'CEMENTO', codigo_barras: '7501234567890', sku: '' },
    ]);
    const error: any = await servicio.create({ nombre: 'X', sku: '7501234567890' } as any).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe('Ese SKU ya es el código de barras de otro producto (CEMENTO)');
    expect(repo.buscarChoquesDeCodigos).toHaveBeenCalledWith(['7501234567890']);
  });

  it('rechaza un SKU repetido', async () => {
    const { servicio, repo } = armar();
    repo.buscarChoquesDeCodigos.mockResolvedValue([{ id_producto: 3, nombre: 'CEMENTO', codigo_barras: '', sku: 'CEM-01' }]);
    await expect(servicio.create({ nombre: 'X', sku: 'CEM-01' } as any)).rejects.toThrow(
      'Ya existe un producto con ese SKU (CEMENTO)',
    );
  });

  it('un producto traído solo por la coincidencia de SKU no se toma por código de barras', async () => {
    const { servicio, repo } = armar();
    // La consulta compara el SKU sin mayúsculas y devuelve un producto cuyo código de barras es
    // distinto del SKU pedido; el SKU solo difiere en mayúsculas (antes tampoco era choque).
    repo.buscarChoquesDeCodigos.mockResolvedValue([{ id_producto: 3, nombre: 'CEMENTO', codigo_barras: '999', sku: 'cem-01' }]);
    await expect(servicio.create({ nombre: 'X', sku: 'CEM-01' } as any)).resolves.toBeDefined();
  });

  it('al editar, el propio producto (idActual) no choca consigo mismo', async () => {
    const { servicio, repo } = armar();
    repo.buscarChoquesDeCodigos.mockResolvedValue([{ id_producto: 7, nombre: 'YO', codigo_barras: '7501', sku: 'YO-1' }]);
    await expect(servicio.update({ codigo_barras: '7501', sku: 'YO-1' } as any, 7)).resolves.toBeDefined();
  });

  it('sin choques crea normalmente', async () => {
    const { servicio, guardados } = armar();
    await servicio.create({ nombre: 'X', codigo_barras: '111', sku: 'X-1' } as any);
    expect(guardados).toHaveLength(1);
  });

  it('sin códigos no consulta', async () => {
    const { servicio, repo } = armar();
    await servicio.create({ nombre: 'X', codigo_barras: '   ', sku: '' } as any);
    await servicio.update({ nombre: 'Y', estado: false } as any, 7);
    expect(repo.buscarChoquesDeCodigos).not.toHaveBeenCalled();
  });

  it('con barras y SKU hace exactamente una consulta, con los dos códigos recortados', async () => {
    const { servicio, repo } = armar();
    await servicio.create({ nombre: 'X', codigo_barras: ' 111 ', sku: ' X-1 ' } as any);
    expect(repo.buscarChoquesDeCodigos).toHaveBeenCalledTimes(1);
    expect(repo.buscarChoquesDeCodigos).toHaveBeenCalledWith(['111', 'X-1']);
    expect(repo.buscarPorCodigoBarras).not.toHaveBeenCalled();
    expect(repo.buscarPorSku).not.toHaveBeenCalled();
  });

  it('con varios choques respeta la prioridad: barras de otro antes que SKU de otro', async () => {
    const { servicio, repo } = armar();
    repo.buscarChoquesDeCodigos.mockResolvedValue([
      { id_producto: 2, nombre: 'ARENA', codigo_barras: '', sku: '111' },
      { id_producto: 4, nombre: 'CEMENTO', codigo_barras: 'X-1', sku: '' },
      { id_producto: 3, nombre: 'YESO', codigo_barras: '111', sku: '' },
    ]);
    await expect(servicio.create({ nombre: 'X', codigo_barras: '111', sku: 'X-1' } as any)).rejects.toThrow(
      'Ya existe un producto con ese código de barras (YESO)',
    );
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

describe('ProductoBussnies · código SUNAT del producto', () => {
  it('normalizarCodigoSunat: undefined no toca, vacío o espacios vacía, texto válido se limpia', () => {
    const { servicio } = armar();
    expect(servicio.normalizarCodigoSunat(undefined)).toBeUndefined();
    expect(servicio.normalizarCodigoSunat('')).toBeNull();
    expect(servicio.normalizarCodigoSunat('   ')).toBeNull();
    expect(servicio.normalizarCodigoSunat(null)).toBeNull();
    expect(servicio.normalizarCodigoSunat(' 3002 1500 ')).toBe('30021500');
  });

  it('normalizarCodigoSunat rechaza 7 dígitos, 9 dígitos y letras con el mensaje del catálogo 25', () => {
    const { servicio } = armar();
    for (const malo of ['3002150', '300215001', '3002150A']) {
      expect(() => servicio.normalizarCodigoSunat(malo)).toThrow(BadRequestException);
      expect(() => servicio.normalizarCodigoSunat(malo)).toThrow(
        'El código de producto SUNAT debe tener exactamente 8 dígitos (catálogo 25, UNSPSC).',
      );
    }
  });

  it('crea con código y lo guarda sin espacios', async () => {
    const { servicio, guardados } = armar();
    await servicio.create({ nombre: 'Clavos', codigo_sunat: ' 30021500 ' } as any);
    expect(guardados[0].codigo_sunat).toBe('30021500');
  });

  it('crea sin código y guarda null', async () => {
    const { servicio, guardados } = armar();
    await servicio.create({ nombre: 'Clavos' } as any);
    expect(guardados[0].codigo_sunat).toBeNull();
  });

  it('crea con 7 dígitos y responde 400 sin tocar la BD', async () => {
    const { servicio, dataSource } = armar();
    await expect(servicio.create({ nombre: 'Clavos', codigo_sunat: '3002150' } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('update sin el campo no toca codigo_sunat', async () => {
    const { servicio, repo } = armar();
    await servicio.update({ precio_venta: 12 } as any, 7);
    expect('codigo_sunat' in repo.actualizarSiExiste.mock.calls[0][1]).toBe(false);
  });

  it('update con cadena vacía deja el código en null', async () => {
    const { servicio, repo } = armar();
    await servicio.update({ codigo_sunat: '' } as any, 7);
    expect(repo.actualizarSiExiste.mock.calls[0][1]).toEqual({ codigo_sunat: null });
  });

  it('update con un código válido lo guarda y con uno inválido responde 400 sin actualizar', async () => {
    const { servicio, repo } = armar();
    await servicio.update({ codigo_sunat: '31162800' } as any, 7);
    expect(repo.actualizarSiExiste.mock.calls[0][1]).toEqual({ codigo_sunat: '31162800' });

    repo.actualizarSiExiste.mockClear();
    await expect(servicio.update({ codigo_sunat: '1234567' } as any, 7)).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.actualizarSiExiste).not.toHaveBeenCalled();
  });

  it('el detalle expone codigo_sunat (null cuando no hay)', async () => {
    const { servicio, repo } = armar();
    repo.detallePorId.mockResolvedValueOnce({ id_producto: 7, nombre: 'X', codigo_sunat: '30021500' });
    expect((await servicio.getById(7)).codigo_sunat).toBe('30021500');
    repo.detallePorId.mockResolvedValueOnce({ id_producto: 7, nombre: 'X', codigo_sunat: null });
    expect((await servicio.getById(7)).codigo_sunat).toBeNull();
  });

  it('productosSinCodigoSunat delega en el repositorio con el límite', async () => {
    const { servicio, repo } = armar();
    repo.listarSinCodigoSunat.mockResolvedValueOnce({ total: 2, datos: [{ id_producto: 1 }] });
    await expect(servicio.productosSinCodigoSunat(50)).resolves.toEqual({ total: 2, datos: [{ id_producto: 1 }] });
    expect(repo.listarSinCodigoSunat).toHaveBeenCalledWith(50);
  });
});

describe('ProductoBussnies.asignarCodigosSunat', () => {
  it('agrupa por código: un UPDATE por código y cuenta los actualizados', async () => {
    const { servicio, repo } = armar();
    const resultado = await servicio.asignarCodigosSunat([
      { id_producto: 1, codigo_sunat: '30021500' },
      { id_producto: 2, codigo_sunat: '30021500' },
      { id_producto: 3, codigo_sunat: '31162800' },
    ]);
    expect(repo.asignarCodigoSunat).toHaveBeenCalledTimes(2);
    expect(repo.asignarCodigoSunat).toHaveBeenCalledWith([1, 2], '30021500');
    expect(repo.asignarCodigoSunat).toHaveBeenCalledWith([3], '31162800');
    expect(resultado).toEqual({ actualizados: 3, rechazados: [] });
  });

  it('reporta como rechazados los ids inexistentes y los códigos inválidos, sin lanzar', async () => {
    const { servicio, repo } = armar();
    repo.asignarCodigoSunat.mockImplementation(async (ids: number[]) => ids.filter((id) => id !== 99));
    const resultado = await servicio.asignarCodigosSunat([
      { id_producto: 1, codigo_sunat: '30021500' },
      { id_producto: 99, codigo_sunat: '30021500' },
      { id_producto: 5, codigo_sunat: '1234567' },
    ]);
    expect(repo.asignarCodigoSunat).toHaveBeenCalledTimes(1);
    expect(repo.asignarCodigoSunat).toHaveBeenCalledWith([1, 99], '30021500');
    expect(resultado.actualizados).toBe(1);
    expect(resultado.rechazados).toEqual(
      expect.arrayContaining([
        { id_producto: 5, motivo: expect.stringMatching(/8 dígitos/) },
        { id_producto: 99, motivo: 'El producto no existe' },
      ]),
    );
    expect(resultado.rechazados).toHaveLength(2);
  });

  it('si un id llega repetido vale la última asignación y no se cuenta dos veces', async () => {
    const { servicio, repo } = armar();
    const resultado = await servicio.asignarCodigosSunat([
      { id_producto: 1, codigo_sunat: '30021500' },
      { id_producto: 1, codigo_sunat: '31162800' },
    ]);
    expect(repo.asignarCodigoSunat).toHaveBeenCalledTimes(1);
    expect(repo.asignarCodigoSunat).toHaveBeenCalledWith([1], '31162800');
    expect(resultado.actualizados).toBe(1);
  });

  it('sin asignaciones no consulta la base', async () => {
    const { servicio, repo } = armar();
    await expect(servicio.asignarCodigosSunat([])).resolves.toEqual({ actualizados: 0, rechazados: [] });
    expect(repo.asignarCodigoSunat).not.toHaveBeenCalled();
  });
});

describe('ProductoBussnies · alta con stock 0 (A2)', () => {
  it('inserta la fila vacía directo, sin consultar antes si existía', async () => {
    const { servicio, inventarioRepo } = armar();
    inventarioRepo.almacenes.mockResolvedValue([{ id_almacen: 2, nombre: 'Principal', sucursal: '' }]);
    await servicio.create({ nombre: 'Clavos', stock: 0 } as any);
    expect(inventarioRepo.insertarFilaVacia).toHaveBeenCalledTimes(1);
    expect(inventarioRepo.insertarFilaVacia.mock.calls[0].slice(1)).toEqual([7, 2]);
    expect(inventarioRepo.ajustar).not.toHaveBeenCalled();
  });
});

describe('ProductoBussnies.update · sin lecturas redundantes (A3)', () => {
  it('con códigos: una consulta de unicidad, un UPDATE y una lectura del detalle', async () => {
    const { servicio, repo, dataSource } = armar();
    await servicio.update({ nombre: 'Clavo 2"', codigo_barras: '111', sku: 'CL-2' } as any, 7);
    expect(repo.buscarChoquesDeCodigos).toHaveBeenCalledTimes(1);
    expect(repo.actualizarSiExiste).toHaveBeenCalledTimes(1);
    expect(repo.detallePorId).toHaveBeenCalledTimes(1);
    expect(repo.getById).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('activar/desactivar (sin códigos): un UPDATE y una lectura', async () => {
    const { servicio, repo } = armar();
    await servicio.update({ nombre: 'Clavo', estado: false } as any, 7);
    expect(repo.buscarChoquesDeCodigos).not.toHaveBeenCalled();
    expect(repo.actualizarSiExiste).toHaveBeenCalledTimes(1);
    expect(repo.detallePorId).toHaveBeenCalledTimes(1);
  });

  it('si el UPDATE no afecta filas responde 404 sin leer el detalle', async () => {
    const { servicio, repo } = armar();
    repo.actualizarSiExiste.mockResolvedValue(false);
    await expect(servicio.update({ precio_venta: 3 } as any, 99)).rejects.toThrow('Producto 99 no encontrado');
    expect(repo.detallePorId).not.toHaveBeenCalled();
  });

  it('sin cambios no actualiza y responde 404 si el detalle no existe', async () => {
    const { servicio, repo } = armar();
    repo.detallePorId.mockResolvedValue(null);
    await expect(servicio.update({} as any, 99)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.actualizarSiExiste).not.toHaveBeenCalled();
  });

  it('un 23505 del UPDATE sigue saliendo como 409', async () => {
    const { servicio, repo } = armar();
    repo.actualizarSiExiste.mockRejectedValue({ code: '23505' });
    await expect(servicio.update({ sku: 'X' } as any, 7)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('ProductoBussnies.update · edición y stock en una transacción (A4)', () => {
  const ajuste = { id_almacen: 2, stock_nuevo: 12, stock_anterior: 10 };

  it('con ajuste_stock el UPDATE y el ajuste reciben el mismo manager', async () => {
    const { servicio, repo, productosTx, inventarioBussnies, dataSource, managers } = armar();
    await servicio.update({ nombre: 'Clavo', ajuste_stock: ajuste } as any, 7);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(productosTx.update).toHaveBeenCalledWith(7, expect.objectContaining({ nombre: 'Clavo' }));
    expect(repo.actualizarSiExiste).not.toHaveBeenCalled();
    expect(inventarioBussnies.ajustarEnTransaccion).toHaveBeenCalledTimes(1);
    const [manager, dto] = inventarioBussnies.ajustarEnTransaccion.mock.calls[0];
    expect(manager).toBe(managers[0]);
    expect(dto).toEqual({
      id_producto: 7,
      id_almacen: 2,
      cantidad: 2,
      motivo: 'correccion',
      comentario: 'Ajuste de stock desde edición de producto',
      stock_esperado: 10,
    });
    expect(repo.detallePorId).toHaveBeenCalledTimes(1);
  });

  it('una baja de stock manda la diferencia negativa', async () => {
    const { servicio, inventarioBussnies } = armar();
    await servicio.update({ nombre: 'Clavo', ajuste_stock: { id_almacen: 2, stock_nuevo: 4, stock_anterior: 10 } } as any, 7);
    expect(inventarioBussnies.ajustarEnTransaccion.mock.calls[0][1]).toMatchObject({ cantidad: -6, stock_esperado: 10 });
  });

  it('sin diferencia no llama al ajuste', async () => {
    const { servicio, inventarioBussnies, productosTx } = armar();
    await servicio.update({ nombre: 'Clavo', ajuste_stock: { id_almacen: 2, stock_nuevo: 10, stock_anterior: 10 } } as any, 7);
    expect(productosTx.update).toHaveBeenCalledTimes(1);
    expect(inventarioBussnies.ajustarEnTransaccion).not.toHaveBeenCalled();
  });

  it('si el ajuste rechaza, update rechaza (la transacción se deshace) y no lee el detalle', async () => {
    const { servicio, repo, inventarioBussnies } = armar();
    const conflicto = new ConflictException({ codigo: 'STOCK_DESACTUALIZADO', stock_actual: 8, message: 'cambió' });
    inventarioBussnies.ajustarEnTransaccion.mockRejectedValue(conflicto);
    await expect(servicio.update({ nombre: 'Clavo', ajuste_stock: ajuste } as any, 7)).rejects.toBe(conflicto);
    expect(repo.detallePorId).not.toHaveBeenCalled();
  });

  it('si el producto no existe responde 404 sin ajustar', async () => {
    const { servicio, productosTx, inventarioBussnies } = armar();
    productosTx.update.mockResolvedValue({ affected: 0 });
    await expect(servicio.update({ nombre: 'Clavo', ajuste_stock: ajuste } as any, 99)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(inventarioBussnies.ajustarEnTransaccion).not.toHaveBeenCalled();
  });

  it('solo stock (sin otros campos): comprueba que el producto exista con el mismo manager', async () => {
    const { servicio, productosTx, inventarioBussnies, managers } = armar();
    await servicio.update({ ajuste_stock: ajuste } as any, 7);
    expect(productosTx.update).not.toHaveBeenCalled();
    expect(managers[0].query).toHaveBeenCalledWith(expect.stringContaining('FROM productos'), [7]);
    expect(inventarioBussnies.ajustarEnTransaccion.mock.calls[0][0]).toBe(managers[0]);
  });
});

describe('ProductoBussnies.delete · borrado directo (A3)', () => {
  it('borra sin leer antes', async () => {
    const { servicio, repo } = armar();
    await expect(servicio.delete(7)).resolves.toBe(1);
    expect(repo.getById).not.toHaveBeenCalled();
    expect(repo.delete).toHaveBeenCalledWith(7);
  });

  it('sin filas afectadas responde 404', async () => {
    const { servicio, repo } = armar();
    repo.delete.mockResolvedValue(0);
    await expect(servicio.delete(99)).rejects.toThrow('Producto 99 no encontrado');
  });

  it('con registros que lo referencian (23503) responde 409 con el mensaje de siempre', async () => {
    const { servicio, repo } = armar();
    repo.delete.mockRejectedValue({ code: '23503' });
    await expect(servicio.delete(7)).rejects.toThrow(
      'No se puede eliminar: el producto tiene ventas, stock o movimientos registrados. Desactívelo en su lugar.',
    );
  });
});
