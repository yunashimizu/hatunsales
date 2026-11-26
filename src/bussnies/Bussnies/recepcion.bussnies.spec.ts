import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { RecepcionBussnies } from './recepcion.bussnies';

/**
 * Recepción de mercadería: el stock entra una sola vez y nunca a medias.
 *
 * El repositorio falso imita lo que garantiza PostgreSQL en el real: el UPDATE
 * condicional de la observación es atómico (solo una revisión encuentra la fila
 * 'pendiente') y lo que corre dentro de la transacción se deshace si algo falla.
 */
const tick = () => new Promise((r) => setTimeout(r, 0));

function armar(cantidad = 5, opciones: { modoGuia?: 'avisar' | 'bloquear'; previa?: any } = {}) {
  const manager = { soy: 'manager-de-la-transaccion' };
  const obs: any = {
    id_observacion: 9,
    id_producto: 3,
    id_almacen: 1,
    nro_guia: 'G-100',
    cantidad: String(cantidad),
    estado: 'pendiente',
  };
  const stock = { unidades: 0 };

  const inventario = {
    ajustar: jest.fn(async (dto: any) => {
      await tick();
      stock.unidades += Number(dto.cantidad);
      return { stock: stock.unidades };
    }),
    ajustarEnTransaccion: jest.fn(async (_m: any, dto: any) => {
      await tick();
      stock.unidades += Number(dto.cantidad);
      return stock.unidades;
    }),
  };

  const repo: any = {
    asegurarSchema: jest.fn().mockResolvedValue(undefined),
    buscarObservacion: jest.fn(async () => ({ ...obs })),
    marcarObservacion: jest.fn(async (_id: number, estado: string) => {
      await tick();
      if (obs.estado !== 'pendiente') return null;
      obs.estado = estado;
      return { ...obs };
    }),
    revisarObservacion: jest.fn(async (_id: number, estado: string, _u: any, _c: any, alRevisar?: any) => {
      await tick();
      if (obs.estado !== 'pendiente') return { resultado: 'ya_revisada', estado: obs.estado };
      obs.estado = estado;
      const antes = stock.unidades;
      try {
        if (alRevisar) await alRevisar(manager, { ...obs });
      } catch (error) {
        obs.estado = 'pendiente';
        stock.unidades = antes;
        throw error;
      }
      return { resultado: 'revisada', observacion: { ...obs } };
    }),
    productosExistentes: jest.fn(async (ids: number[]) => new Set(ids.filter((id) => id !== 404))),
    registrarRecepcion: jest.fn(async (params: any, aplicarStock: any, antesDeInsertar?: any) => {
      const antes = stock.unidades;
      // Como el real: la verificación de la guía corre dentro de la transacción y antes de insertar.
      if (antesDeInsertar) await antesDeInsertar(manager);
      try {
        await aplicarStock(manager, { id_recepcion: 77 });
      } catch (error) {
        stock.unidades = antes;
        throw error;
      }
      return {
        id_recepcion: 77,
        observaciones: params.items
          .filter((i: any) => i.cantidad_observada > 0)
          .map((i: any, n: number) => ({ id_observacion: 100 + n, id_producto: i.id_producto, id_item: n + 1 })),
        repetida: false,
      };
    }),
    actualizarPrecioCompra: jest.fn().mockResolvedValue(undefined),
    recepcionConGuia: jest.fn(async () => opciones.previa ?? null),
  };

  const archivos = { nombre: 'base_datos', guardar: jest.fn(), eliminar: jest.fn() };
  const controlStock = opciones.modoGuia ? { modoGuiaRepetida: jest.fn(async () => opciones.modoGuia) } : undefined;
  const bitacora = { registrarCon: jest.fn(async () => undefined) };
  const servicio = new RecepcionBussnies(repo, inventario as any, archivos as any, controlStock as any, bitacora as any);
  return { servicio, repo, inventario, obs, stock, manager, archivos, bitacora };
}

const cuerpo = (items: any[], extra: Record<string, unknown> = {}) => ({
  id_proveedor: 2,
  id_almacen: 1,
  nro_guia: 'G-100',
  items,
  ...extra,
});

describe('RecepcionBussnies · visto bueno de observaciones', () => {
  it('dos vistos buenos simultáneos (doble clic o dos usuarios) suman el stock una sola vez', async () => {
    const { servicio, stock, obs } = armar(5);

    const resultados = await Promise.allSettled([
      servicio.aprobarObservacion(9, { id_usuario: 1 } as any),
      servicio.aprobarObservacion(9, { id_usuario: 2 } as any),
    ]);

    expect(stock.unidades).toBe(5);
    expect(obs.estado).toBe('aprobado');
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rechazada = resultados.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rechazada.reason).toBeInstanceOf(BadRequestException);
    expect(rechazada.reason.message).toMatch(/ya fue revisada/);
  });

  it('un rechazo cruzado con un visto bueno nunca deja stock de una observación rechazada', async () => {
    const { servicio, stock, obs } = armar(5);

    await Promise.allSettled([
      servicio.rechazarObservacion(9, { id_usuario: 2 } as any),
      servicio.aprobarObservacion(9, { id_usuario: 1 } as any),
    ]);

    const coherente =
      (obs.estado === 'aprobado' && stock.unidades === 5) || (obs.estado === 'rechazado' && stock.unidades === 0);
    expect(coherente).toBe(true);
  });

  it('el stock se suma con el manager de la misma transacción que marca la observación', async () => {
    const { servicio, inventario, manager } = armar(4);

    const r = await servicio.aprobarObservacion(9, { id_usuario: 1 } as any, 'llegó completo');

    expect(r.stock_ingresado).toBe(4);
    expect(r.estado).toBe('aprobado');
    expect(inventario.ajustarEnTransaccion).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ id_producto: 3, id_almacen: 1, cantidad: 4, motivo: 'compra' }),
      // Fase 8.1: el movimiento guarda la observación aprobada y quién dio el visto bueno.
      { id_usuario: 1, tipo_documento: 'observacion_recepcion', id_documento: 9 },
    );
    expect(inventario.ajustar).not.toHaveBeenCalled();
  });

  it('si el stock no se puede sumar, la observación sigue pendiente', async () => {
    const { servicio, inventario, obs, stock } = armar(5);
    inventario.ajustarEnTransaccion.mockRejectedValueOnce(new BadRequestException('Falta aplicar la migración'));

    await expect(servicio.aprobarObservacion(9)).rejects.toThrow('Falta aplicar la migración');
    expect(obs.estado).toBe('pendiente');
    expect(stock.unidades).toBe(0);
  });

  it('distingue una observación inexistente de una ya revisada', async () => {
    const { servicio, repo } = armar();
    repo.revisarObservacion.mockResolvedValueOnce({ resultado: 'no_existe' });
    await expect(servicio.rechazarObservacion(1234)).rejects.toBeInstanceOf(NotFoundException);

    repo.revisarObservacion.mockResolvedValueOnce({ resultado: 'ya_revisada', estado: 'aprobado' });
    await expect(servicio.rechazarObservacion(9)).rejects.toThrow('ya fue revisada (aprobado)');
  });
});

describe('RecepcionBussnies · confirmar recepción', () => {
  it('si una línea no puede sumar stock no queda nada a medias: falla toda la recepción', async () => {
    const { servicio, inventario, stock } = armar();
    inventario.ajustarEnTransaccion
      .mockImplementationOnce(async (_m: any, dto: any) => {
        stock.unidades += dto.cantidad;
        return stock.unidades;
      })
      .mockRejectedValueOnce(new BadRequestException('El stock resultante supera el máximo'));

    await expect(
      servicio.confirmar(
        cuerpo([
          { id_producto: 3, cantidad_ok: 2 },
          { id_producto: 8, cantidad_ok: 1 },
        ]),
      ),
    ).rejects.toThrow('supera el máximo');
    expect(stock.unidades).toBe(0);
  });

  it('suma lo OK dentro de la transacción de la recepción, en orden de producto', async () => {
    const { servicio, inventario, repo, manager } = armar();

    const r = await servicio.confirmar(
      cuerpo([
        { id_producto: 8, cantidad_ok: 1, precio_compra: 12.5 },
        { id_producto: 3, cantidad_ok: 2, cantidad_observada: 1, motivo_observacion: 'caja golpeada' },
      ]),
      { id_usuario: 4 } as any,
    );

    expect(repo.registrarRecepcion).toHaveBeenCalledTimes(1);
    const productosEnOrden = inventario.ajustarEnTransaccion.mock.calls.map((c: any[]) => c[1].id_producto);
    expect(productosEnOrden).toEqual([3, 8]);
    expect(inventario.ajustarEnTransaccion.mock.calls.every((c: any[]) => c[0] === manager)).toBe(true);
    expect(repo.actualizarPrecioCompra).toHaveBeenCalledWith(manager, 8, 12.5);
    expect(r.stock_ingresado).toEqual([3, 8]);
    expect(r.stock_fallido).toEqual([]);
    expect(r.repetida).toBe(false);
    expect(r.mensaje).toMatch(/espera visto bueno/);
  });

  it('pasa la clave de idempotencia (cuerpo o cabecera) y avisa cuando el reintento ya estaba registrado', async () => {
    const { servicio, repo, inventario } = armar();
    repo.registrarRecepcion.mockResolvedValueOnce({ id_recepcion: 77, observaciones: [], repetida: true });

    const r = await servicio.confirmar(cuerpo([{ id_producto: 3, cantidad_ok: 2 }]), undefined, 'clave-cabecera-1');

    expect(repo.registrarRecepcion.mock.calls[0][0].clave).toBe('clave-cabecera-1');
    expect(inventario.ajustarEnTransaccion).not.toHaveBeenCalled();
    expect(r.repetida).toBe(true);
    expect(r.stock_ingresado).toEqual([]);
    expect(r.mensaje).toMatch(/ya estaba registrada \(#77\)/);

    await servicio.confirmar(cuerpo([{ id_producto: 3, cantidad_ok: 2 }], { clave_idempotencia: 'clave-cuerpo' }));
    expect(repo.registrarRecepcion.mock.calls[1][0].clave).toBe('clave-cuerpo');
  });

  it('rechaza cantidades con decimales antes de registrar nada (el inventario es en unidades enteras)', async () => {
    const { servicio, repo } = armar();

    await expect(servicio.confirmar(cuerpo([{ id_producto: 3, cantidad_ok: 1.5 }]))).rejects.toThrow(
      /números enteros/,
    );
    expect(repo.registrarRecepcion).not.toHaveBeenCalled();
  });

  it('valida todos los productos con una sola consulta', async () => {
    const { servicio, repo } = armar();

    await expect(
      servicio.confirmar(
        cuerpo([
          { id_producto: 3, cantidad_ok: 1 },
          { id_producto: 404, cantidad_ok: 1 },
        ]),
      ),
    ).rejects.toThrow('Producto 404 no encontrado');
    expect(repo.productosExistentes).toHaveBeenCalledTimes(1);
    expect(repo.productosExistentes).toHaveBeenCalledWith([3, 404]);
    expect(repo.registrarRecepcion).not.toHaveBeenCalled();
  });
});

describe('RecepcionBussnies · foto de la observación (B1)', () => {
  const imagen = (mimetype: string) => ({
    originalname: 'foto', mimetype, buffer: Buffer.from('contenido'), size: 9,
  });

  it('rechaza SVG, HTML y cualquier tipo fuera de la lista cerrada sin guardar nada', async () => {
    const { servicio, archivos } = armar();

    for (const tipo of ['image/svg+xml', 'text/html', 'image/x-icon', 'application/octet-stream', '']) {
      await expect(servicio.subirFoto(9, imagen(tipo))).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(archivos.guardar).not.toHaveBeenCalled();
  });

  it('acepta un tipo de la lista y guarda el tipo validado (en minúsculas), no el texto declarado', async () => {
    const { servicio, repo, archivos } = armar();
    archivos.guardar.mockResolvedValue({ url: '/archivos/5', mime: 'image/png' });
    repo.agregarAdjunto = jest.fn().mockResolvedValue({ id_adjunto: 1 });

    await servicio.subirFoto(9, imagen('IMAGE/PNG'));

    expect(archivos.guardar).toHaveBeenCalledWith(expect.objectContaining({ mime: 'image/png', carpeta: 'recepcion/9' }));
    expect(repo.agregarAdjunto).toHaveBeenCalledWith(9, '/archivos/5', 'image/png');
  });
});

/**
 * Proveedores: el RUC es opcional, pero si viene informado tiene que tener el dígito
 * verificador correcto. Al EDITAR solo se rechaza si el RUC cambió respecto del guardado:
 * un RUC antiguo mal digitado que nadie tocó no impide cambiar el teléfono.
 * El cuerpo llega como `any`, así que se prueba con lo que manda el panel.
 */
describe('RecepcionBussnies · RUC del proveedor', () => {
  const RUC_BUENO = '20131312955';
  const RUC_MALO = '20131312954'; // mismo número con el dígito final cambiado
  const OTRO_RUC_MALO = '20131312953';

  function armarProveedores(rucGuardado = '') {
    const { servicio, repo } = armar();
    repo.crearProveedor = jest.fn(async (datos: any) => ({ id_proveedor: 4, ...datos }));
    repo.actualizarProveedor = jest.fn(async (id: number, datos: any) => ({ id_proveedor: id, ...datos }));
    repo.obtenerProveedor = jest.fn(async (id: number) => (id === 404 ? null : { id_proveedor: id, ruc: rucGuardado }));
    // Fase 9.5: candado por RUC (ejecuta la función con un manager simulado) y sin otro proveedor con ese RUC.
    repo.conCandadoProveedorRuc = jest.fn(async (_ruc: string, fn: any) => fn('manager'));
    repo.proveedorConRuc = jest.fn(async () => null);
    return { servicio, repo };
  }

  describe('crear', () => {
    it('con un RUC de dígito malo se rechaza y no guarda nada', async () => {
      const { servicio, repo } = armarProveedores();

      await expect(servicio.crearProveedor({ nombre: 'Aceros SAC', ruc: RUC_MALO }))
        .rejects.toThrow(new BadRequestException('RUC no válido'));
      expect(repo.crearProveedor).not.toHaveBeenCalled();
      expect(repo.obtenerProveedor).not.toHaveBeenCalled();
    });

    it('con un RUC válido guarda', async () => {
      const { servicio, repo } = armarProveedores();

      const creado = await servicio.crearProveedor({ nombre: 'Aceros SAC', ruc: RUC_BUENO });

      // Desde 9.5 se crea dentro del candado por RUC: segundo argumento = el manager de esa transacción.
      expect(repo.crearProveedor).toHaveBeenCalledWith(expect.objectContaining({ nombre: 'Aceros SAC', ruc: RUC_BUENO }), 'manager');
      expect(creado.id_proveedor).toBe(4);
    });

    it('un proveedor sin RUC se sigue pudiendo crear (ausente, vacío, en blanco o nulo)', async () => {
      const { servicio, repo } = armarProveedores();

      for (const ruc of [undefined, '', '   ', null]) {
        await servicio.crearProveedor({ nombre: 'Sin RUC', ruc });
      }
      await servicio.crearProveedor({ nombre: 'Sin la clave' });

      expect(repo.crearProveedor).toHaveBeenCalledTimes(5);
    });

    it('el nombre sigue siendo lo primero que se exige', async () => {
      const { servicio } = armarProveedores();

      await expect(servicio.crearProveedor({ nombre: '  ', ruc: RUC_MALO }))
        .rejects.toThrow(new BadRequestException('El nombre del proveedor es obligatorio'));
    });
  });

  describe('editar', () => {
    it('con el mismo RUC antiguo mal digitado (sin cambios) pasa: se puede cambiar el teléfono', async () => {
      const { servicio, repo } = armarProveedores(RUC_MALO);

      const editado = await servicio.actualizarProveedor(4, { nombre: 'Aceros SAC', ruc: RUC_MALO, telefono: '987654321' });

      expect(repo.actualizarProveedor).toHaveBeenCalledWith(4, expect.objectContaining({ ruc: RUC_MALO, telefono: '987654321' }));
      expect(editado.id_proveedor).toBe(4);
    });

    it('el mismo RUC con espacios en los extremos cuenta como sin cambios', async () => {
      const { servicio, repo } = armarProveedores(RUC_MALO);

      await servicio.actualizarProveedor(4, { nombre: 'Aceros SAC', ruc: ` ${RUC_MALO} ` });

      expect(repo.actualizarProveedor).toHaveBeenCalledTimes(1);
    });

    it('si cambia a un RUC de dígito malo se rechaza (venga de uno válido, de uno malo distinto o de ninguno)', async () => {
      for (const guardado of [RUC_BUENO, OTRO_RUC_MALO, '']) {
        const { servicio, repo } = armarProveedores(guardado);

        await expect(servicio.actualizarProveedor(4, { nombre: 'Aceros SAC', ruc: RUC_MALO }))
          .rejects.toThrow(new BadRequestException('RUC no válido'));
        expect(repo.actualizarProveedor).not.toHaveBeenCalled();
      }
    });

    it('si vacía el RUC pasa, aunque el guardado fuera uno malo', async () => {
      const { servicio, repo } = armarProveedores(RUC_MALO);

      for (const ruc of [undefined, '', '   ', null]) {
        await servicio.actualizarProveedor(4, { nombre: 'Aceros SAC', ruc });
      }
      await servicio.actualizarProveedor(4, { nombre: 'Aceros SAC' });

      expect(repo.actualizarProveedor).toHaveBeenCalledTimes(5);
    });

    it('con un RUC válido pasa (desde 9.5 lee lo guardado una vez, para saber si el RUC cambia)', async () => {
      const { servicio, repo } = armarProveedores(RUC_MALO);

      await servicio.actualizarProveedor(4, { nombre: 'Aceros SAC', ruc: RUC_BUENO });

      expect(repo.actualizarProveedor).toHaveBeenCalledTimes(1);
      expect(repo.obtenerProveedor).toHaveBeenCalledTimes(1);
    });

    it('un proveedor que no existe responde «no encontrado», no «RUC no válido»', async () => {
      const { servicio, repo } = armarProveedores();

      await expect(servicio.actualizarProveedor(404, { nombre: 'Aceros SAC', ruc: RUC_MALO }))
        .rejects.toBeInstanceOf(NotFoundException);
      expect(repo.actualizarProveedor).not.toHaveBeenCalled();
    });
  });
});

describe('RecepcionBussnies · guía repetida del mismo proveedor (Fase 8.4)', () => {
  const PREVIA = {
    id_recepcion: 41, nro_guia: 'g-100', fecha: '2026-11-20T15:00:00.000Z', id_almacen: 1, almacen: 'Principal',
    id_usuario: 3, usuario: 'Ana', lineas: 2, unidades_ok: 10,
  };
  const linea = [{ id_producto: 3, cantidad_ok: 2 }];

  it('sin guía repetida: la respuesta trae guia_repetida null y el movimiento guarda la recepción y el usuario', async () => {
    const { servicio, inventario, repo, manager, bitacora } = armar();

    const r = await servicio.confirmar(cuerpo(linea), { id_usuario: 5, rol: 'vendedor' } as any);

    expect(r.guia_repetida).toBeNull();
    expect(repo.recepcionConGuia).toHaveBeenCalledWith(2, 'G-100', manager);
    expect((inventario.ajustarEnTransaccion.mock.calls[0] as any[])[2]).toEqual({ id_usuario: 5, tipo_documento: 'recepcion', id_documento: 77 });
    expect(bitacora.registrarCon).not.toHaveBeenCalled();
  });

  it('modo por defecto (sin configuración = avisar): se registra igual y la respuesta lo informa', async () => {
    const { servicio, stock, bitacora } = armar(5, { previa: PREVIA });

    const r = await servicio.confirmar(cuerpo(linea), { id_usuario: 5, rol: 'vendedor' } as any);

    expect(stock.unidades).toBe(2);
    expect(r.id_recepcion).toBe(77);
    expect(r.mensaje).toBe('Recepción confirmada. Stock actualizado.');
    expect(r.guia_repetida).toMatchObject({ modo: 'avisar', recepcion_previa: PREVIA });
    expect(r.guia_repetida!.mensaje).toContain('recepción #41');
    expect(bitacora.registrarCon).toHaveBeenCalledTimes(1);
  });

  it('modo bloquear: 409 RECEPCION_GUIA_REPETIDA con la recepción previa y no entra stock', async () => {
    const { servicio, stock, repo } = armar(5, { modoGuia: 'bloquear', previa: PREVIA });

    const error = await servicio.confirmar(cuerpo(linea), { id_usuario: 5 } as any).catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ codigo: 'RECEPCION_GUIA_REPETIDA', recepcion_previa: PREVIA, confirmable: true });
    expect(error.getResponse().message).toMatch(/ya se registró en la recepción #41/);
    expect(stock.unidades).toBe(0);
    expect(repo.actualizarPrecioCompra).not.toHaveBeenCalled();
  });

  it('modo bloquear con confirmar_guia_repetida: true se registra y queda anotado; un texto "true" no confirma', async () => {
    const confirmada = armar(5, { modoGuia: 'bloquear', previa: PREVIA });
    const r = await confirmada.servicio.confirmar(cuerpo(linea, { confirmar_guia_repetida: true }), { id_usuario: 5 } as any);
    expect(confirmada.stock.unidades).toBe(2);
    expect(r.guia_repetida).toMatchObject({ modo: 'bloquear' });
    const evento = (confirmada.bitacora.registrarCon.mock.calls[0] as any[])[0]();
    expect(evento).toMatchObject({ accion: 'recepcion.guia_repetida', id_entidad: 77, antes: { id_recepcion: 41 }, despues: { confirmada: true } });

    const texto = armar(5, { modoGuia: 'bloquear', previa: PREVIA });
    await expect(texto.servicio.confirmar(cuerpo(linea, { confirmar_guia_repetida: 'true' }), { id_usuario: 5 } as any))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('un reintento idempotente (repetida: true) no informa guía repetida', async () => {
    const { servicio, repo } = armar(5, { modoGuia: 'bloquear', previa: PREVIA });
    repo.registrarRecepcion.mockImplementationOnce(async () => ({ id_recepcion: 41, observaciones: [], repetida: true }));

    const r = await servicio.confirmar(cuerpo(linea, { clave_idempotencia: 'k-1' }), { id_usuario: 5 } as any);

    expect(r.repetida).toBe(true);
    expect(r.guia_repetida).toBeNull();
  });

  it('con el índice único de fase21 activo, el 23505 sale como 409 no confirmable', async () => {
    const { servicio, repo } = armar(5, { previa: PREVIA });
    repo.registrarRecepcion.mockImplementationOnce(async () => {
      throw Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq_recepciones_proveedor_guia' });
    });

    const error = await servicio.confirmar(cuerpo(linea, { confirmar_guia_repetida: true }), { id_usuario: 5 } as any).catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ codigo: 'RECEPCION_GUIA_REPETIDA', confirmable: false });
  });

  it('lectura previa (GET recepcion/guia-repetida): dice si está repetida y qué hará la confirmación', async () => {
    const con = armar(5, { modoGuia: 'bloquear', previa: PREVIA });
    expect(await con.servicio.guiaRepetida(2, ' g-100 ')).toMatchObject({ repetida: true, modo: 'bloquear', recepcion_previa: PREVIA });
    const sin = armar(5);
    expect(await sin.servicio.guiaRepetida(2, 'G-999')).toEqual({ repetida: false, modo: 'avisar', recepcion_previa: null, mensaje: null });
  });
});

describe('RecepcionBussnies · RUC de proveedor repetido (Fase 9.5)', () => {
  const RUC = '20131312955';
  function armarRepetido(rucGuardado = '', otro: any = { id_proveedor: 9, nombre: 'Ferretera Norte SAC' }) {
    const { servicio, repo } = armar();
    repo.crearProveedor = jest.fn(async (datos: any) => ({ id_proveedor: 4, ...datos }));
    repo.actualizarProveedor = jest.fn(async (id: number, datos: any) => ({ id_proveedor: id, ...datos }));
    repo.obtenerProveedor = jest.fn(async (id: number) => ({ id_proveedor: id, ruc: rucGuardado }));
    repo.conCandadoProveedorRuc = jest.fn(async (_ruc: string, fn: any) => fn('manager'));
    repo.proveedorConRuc = jest.fn(async () => otro);
    return { servicio, repo };
  }

  it('crear con un RUC que ya tiene otro proveedor → 409 PROVEEDOR_RUC_REPETIDO con su nombre, sin crear', async () => {
    const { servicio, repo } = armarRepetido();
    const error: any = await servicio.crearProveedor({ nombre: 'Nuevo', ruc: ` ${RUC} ` }).catch((e) => e);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({
      codigo: 'PROVEEDOR_RUC_REPETIDO',
      proveedor_existente: { id_proveedor: 9, nombre: 'Ferretera Norte SAC' },
    });
    expect(error.getResponse().message).toContain('Ferretera Norte SAC');
    expect(repo.conCandadoProveedorRuc).toHaveBeenCalledWith(RUC, expect.any(Function));
    expect(repo.proveedorConRuc).toHaveBeenCalledWith(RUC, undefined, 'manager');
    expect(repo.crearProveedor).not.toHaveBeenCalled();
  });

  it('crear sin RUC no consulta duplicados; con RUC libre crea dentro del candado', async () => {
    const { servicio, repo } = armarRepetido('', null);
    await servicio.crearProveedor({ nombre: 'Sin RUC' });
    expect(repo.conCandadoProveedorRuc).not.toHaveBeenCalled();
    await servicio.crearProveedor({ nombre: 'Con RUC', ruc: RUC });
    expect(repo.crearProveedor).toHaveBeenLastCalledWith(expect.objectContaining({ ruc: RUC }), 'manager');
  });

  it('editar sin cambiar el RUC nunca se bloquea, aunque haya duplicados viejos', async () => {
    const { servicio, repo } = armarRepetido(RUC);
    await servicio.actualizarProveedor(4, { nombre: 'Editado', ruc: RUC, telefono: '999' });
    await servicio.actualizarProveedor(4, { nombre: 'Editado', ruc: '' });
    expect(repo.proveedorConRuc).not.toHaveBeenCalled();
    expect(repo.actualizarProveedor).toHaveBeenCalledTimes(2);
  });

  it('editar cambiando el RUC al de otro → 409 sin guardar; excluye al propio proveedor', async () => {
    const { servicio, repo } = armarRepetido('20100070970');
    const error: any = await servicio.actualizarProveedor(4, { nombre: 'Editado', ruc: RUC }).catch((e) => e);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse().codigo).toBe('PROVEEDOR_RUC_REPETIDO');
    expect(repo.proveedorConRuc).toHaveBeenCalledWith(RUC, 4, 'manager');
    expect(repo.actualizarProveedor).not.toHaveBeenCalled();
  });

  it('si el índice único gana la carrera (23505) responde 409, no 500', async () => {
    const { servicio, repo } = armarRepetido('', null);
    repo.crearProveedor = jest.fn(async () => { throw Object.assign(new Error('dup'), { code: '23505' }); });
    const error: any = await servicio.crearProveedor({ nombre: 'X', ruc: RUC }).catch((e) => e);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse().codigo).toBe('PROVEEDOR_RUC_REPETIDO');
  });
});
