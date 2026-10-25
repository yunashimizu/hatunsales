import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CarritoBussnies } from './carrito.bussnies';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fila(parcial: Record<string, unknown> = {}) {
  return {
    id_item: 11,
    id_producto: 5,
    nombre: 'Taladro percutor',
    marca: 'Bosch',
    imagen: null,
    cantidad: 2,
    precio_unitario: '10.00',
    precio_vigente: '10.00',
    activo: true,
    stock_disponible: 9,
    ...parcial,
  };
}

function producto(parcial: Record<string, unknown> = {}) {
  return { id_producto: 5, nombre: 'Taladro percutor', precio_venta: '10.00', precio_final: '10.00', estado: true, stock: 9, ...parcial };
}

function armar(opciones: { filas?: any[]; carritoCliente?: any; carritoToken?: any; producto?: any } = {}) {
  const repo = {
    buscarPorCliente: jest.fn(async () => opciones.carritoCliente ?? null),
    buscarPorToken: jest.fn(async () => opciones.carritoToken ?? null),
    crearParaCliente: jest.fn(async (idCliente: number) => ({ id_carrito: 40, cliente: { id_cliente: idCliente } })),
    crearParaInvitado: jest.fn(async (token: string) => ({ id_carrito: 41, token_invitado: token })),
    listarItems: jest.fn(async () => opciones.filas ?? []),
    actualizarPrecios: jest.fn(async () => undefined),
    buscarItem: jest.fn(async (): Promise<any> => null),
    buscarItemPorId: jest.fn(async (): Promise<any> => null),
    agregarItem: jest.fn(async () => undefined),
    actualizarCantidad: jest.fn(async () => undefined),
    eliminarItem: jest.fn(async () => undefined),
    vaciar: jest.fn(async () => undefined),
    tocar: jest.fn(async () => undefined),
    asignarCliente: jest.fn(async () => undefined),
    marcarConvertido: jest.fn(async () => undefined),
    fusionarEn: jest.fn(async () => true),
  };
  const catalogoRepo = { obtenerPorId: jest.fn(async () => opciones.producto ?? null) };
  return { servicio: new CarritoBussnies(repo as any, catalogoRepo as any), repo, catalogoRepo };
}

const VACIO = { id_carrito: 0, items: [], cantidad_items: 0, subtotal: 0, igv: 0, total: 0 };

describe('CarritoBussnies · ver sin escribir (E18 / R05)', () => {
  it('sin sesión ni token devuelve un carrito vacío virtual y no inserta filas', async () => {
    const { servicio, repo } = armar();

    expect(await servicio.ver({})).toEqual(VACIO);
    expect(repo.crearParaInvitado).not.toHaveBeenCalled();
    expect(repo.listarItems).not.toHaveBeenCalled();
  });

  it('con un token que ya no existe tampoco crea un carrito', async () => {
    const { servicio, repo } = armar();

    expect(await servicio.ver({ tokenInvitado: 'token-que-no-existe' })).toEqual(VACIO);
    expect(repo.crearParaInvitado).not.toHaveBeenCalled();
  });

  it('un cliente sin carrito ve uno vacío; el carrito se crea recién al agregar', async () => {
    const { servicio, repo } = armar();

    expect(await servicio.ver({ idCliente: 3 })).toEqual(VACIO);
    expect(repo.crearParaCliente).not.toHaveBeenCalled();
  });

  it('cambiar la cantidad sin carrito responde "no está en tu carrito" sin crearlo', async () => {
    const { servicio, repo } = armar();

    await expect(servicio.actualizarCantidad({ tokenInvitado: 'x' }, 11, 2)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.crearParaInvitado).not.toHaveBeenCalled();
  });
});

describe('CarritoBussnies · precio y stock vigentes (E03)', () => {
  it('usa el precio vigente del catálogo, avisa el cambio y lo deja guardado', async () => {
    const { servicio, repo } = armar({
      carritoToken: { id_carrito: 9, token_invitado: 't-1' },
      filas: [fila({ precio_unitario: '8.00', precio_vigente: '12.50', cantidad: 2 })],
    });

    const carrito = await servicio.ver({ tokenInvitado: 't-1' });

    expect(carrito.items[0]).toMatchObject({ precio_unitario: 12.5, subtotal: 25, precio_cambio: true, precio_anterior: 8 });
    expect(carrito.total).toBe(25);
    expect(repo.actualizarPrecios).toHaveBeenCalledWith([{ id_item: 11, precio: 12.5 }]);
  });

  it('si el precio no cambió no escribe nada ni marca aviso', async () => {
    const { servicio, repo } = armar({ carritoToken: { id_carrito: 9 }, filas: [fila()] });

    const carrito = await servicio.ver({ tokenInvitado: 't-1' });

    expect(carrito.items[0].precio_cambio).toBeUndefined();
    expect(repo.actualizarPrecios).not.toHaveBeenCalled();
  });

  it('un producto con stock 0 también excede el stock', async () => {
    const { servicio } = armar({ carritoToken: { id_carrito: 9 }, filas: [fila({ cantidad: 1, stock_disponible: 0 })] });

    const carrito = await servicio.ver({ tokenInvitado: 't-1' });

    expect(carrito.items[0].excede_stock).toBe(true);
  });

  it('marca como no disponible un producto desactivado del catálogo', async () => {
    const { servicio } = armar({ carritoToken: { id_carrito: 9 }, filas: [fila({ activo: false })] });

    const carrito = await servicio.ver({ tokenInvitado: 't-1' });

    expect(carrito.items[0].no_disponible).toBe(true);
  });

  it('no agrega un producto agotado ni crea el carrito para eso', async () => {
    const { servicio, repo } = armar({ producto: producto({ stock: 0 }) });

    await expect(servicio.agregar({}, 5, 1)).rejects.toThrow(/agotado/);
    expect(repo.crearParaInvitado).not.toHaveBeenCalled();
    expect(repo.agregarItem).not.toHaveBeenCalled();
  });

  it('no agrega un producto desactivado', async () => {
    const { servicio, repo } = armar({ producto: producto({ estado: false }) });

    await expect(servicio.agregar({}, 5, 1)).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.agregarItem).not.toHaveBeenCalled();
  });

  it('no deja superar el stock sumando lo que ya había en el carrito', async () => {
    const { servicio, repo } = armar({ carritoToken: { id_carrito: 9 }, producto: producto({ stock: 3 }) });
    repo.buscarItem.mockResolvedValueOnce({ id_item: 11, cantidad: 2 });

    await expect(servicio.agregar({ tokenInvitado: 't-1' }, 5, 2)).rejects.toThrow('Solo quedan 3 unidades');
  });

  it('al primer "agregar" crea el carrito de invitado con un token generado por el servidor', async () => {
    const { servicio, repo } = armar({ producto: producto() });

    const carrito = await servicio.agregar({ tokenInvitado: 'token-viejo-que-no-existe' }, 5, 1);

    const token = repo.crearParaInvitado.mock.calls[0][0];
    expect(token).toMatch(UUID);
    expect(repo.agregarItem).toHaveBeenCalledWith(41, 5, 1, 10);
    expect(carrito.token_invitado).toBe(token);
  });
});

describe('CarritoBussnies · fusión al iniciar sesión (E17)', () => {
  it('pasa el carrito de invitado al del cliente en una sola operación atómica', async () => {
    const { servicio, repo } = armar({
      carritoToken: { id_carrito: 9, token_invitado: 't-1' },
      carritoCliente: { id_carrito: 20 },
    });

    await servicio.fusionar(3, 't-1');

    expect(repo.fusionarEn).toHaveBeenCalledWith(9, 20);
    expect(repo.agregarItem).not.toHaveBeenCalled();
  });

  it('si el cliente no tenía carrito, el de invitado pasa a ser suyo', async () => {
    const { servicio, repo } = armar({ carritoToken: { id_carrito: 9, token_invitado: 't-1' } });
    repo.buscarPorCliente.mockResolvedValueOnce(null).mockResolvedValueOnce({ id_carrito: 9 });

    await servicio.fusionar(3, 't-1');

    expect(repo.asignarCliente).toHaveBeenCalledWith(9, 3);
    expect(repo.fusionarEn).not.toHaveBeenCalled();
  });
});
