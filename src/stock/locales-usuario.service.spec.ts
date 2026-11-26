import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { LocalesUsuarioService } from './locales-usuario.service';

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

function armar(opciones: { asignados?: number[] | null; tabla?: boolean; falla?: boolean; rol?: string } = {}) {
  const repo = {
    almacenesPermitidos: jest.fn(async () => {
      if (opciones.falla) throw new Error('sin conexión');
      return opciones.asignados === undefined ? null : opciones.asignados;
    }),
    almacen: jest.fn(async (id: number) => ({ nombre: `Almacén ${id}`, sucursal: id === 2 ? 'Local B' : 'Local A' })),
    usuario: jest.fn(async (id: number) => (id === 404 ? null : { id_usuario: id, nombre: 'Ana', rol: opciones.rol ?? 'vendedor' })),
    localesDe: jest.fn(async () => [{ id_sucursal: 1, nombre: 'Local A' }]),
    todas: jest.fn(async () => []),
    sucursalesExistentes: jest.fn(async (ids: number[]) => new Set(ids.filter((v) => v !== 99))),
    reemplazar: jest.fn(async () => [3]),
  };
  const esquema = { tiene: jest.fn(async () => opciones.tabla ?? true) };
  const bitacora = { registrarCon: jest.fn(async () => undefined) };
  return { servicio: new LocalesUsuarioService(repo as any, esquema as any, bitacora as any), repo, esquema, bitacora };
}

const VENDEDOR = { id_usuario: 7, rol: 'vendedor' } as any;
const ADMIN = { id_usuario: 1, rol: 'Administrador' } as any;

describe('LocalesUsuarioService (Fase 8.5, D7)', () => {
  it('usuario SIN locales asignados (la tabla vacía de producción): exactamente como hoy', async () => {
    const { servicio } = armar({ asignados: null });
    expect(await servicio.alcance(VENDEDOR)).toEqual({ restringido: false });
    await expect(servicio.exigirAlmacen(VENDEDOR, 2, 'ajustar')).resolves.toBeUndefined();
    expect(await servicio.filtrar(VENDEDOR, [{ id_almacen: 1 }, { id_almacen: 2 }])).toHaveLength(2);
    // En la venta: el elegido o, si no vino, el por defecto (lo de hoy), incluso sin almacén.
    expect(await servicio.almacenParaVenta(VENDEDOR, 2, 1)).toBe(2);
    expect(await servicio.almacenParaVenta(VENDEDOR, undefined, 1)).toBe(1);
    expect(await servicio.almacenParaVenta(VENDEDOR, undefined, undefined)).toBeUndefined();
  });

  it('admin ve y hace todo aunque tenga filas en la tabla (ni siquiera consulta)', async () => {
    const { servicio, repo } = armar({ asignados: [1] });
    expect(await servicio.alcance(ADMIN)).toEqual({ restringido: false });
    await expect(servicio.exigirAlmacen(ADMIN, 2, 'vender')).resolves.toBeUndefined();
    expect(repo.almacenesPermitidos).not.toHaveBeenCalled();
  });

  it('usuario asignado al local A: no vende, ajusta ni saca stock del almacén del local B (403 con mensaje claro)', async () => {
    const { servicio } = armar({ asignados: [1] });
    for (const accion of ['vender', 'ajustar', 'transferir'] as const) {
      const error = await servicio.exigirAlmacen(VENDEDOR, 2, accion).catch((e) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getResponse()).toMatchObject({ codigo: 'ALMACEN_FUERA_DE_SUS_LOCALES', id_almacen: 2 });
      expect(error.getResponse().message).toMatch(/«Almacén 2» \(local Local B\): su usuario no está asignado a ese local/);
    }
    await expect(servicio.exigirAlmacen(VENDEDOR, 1, 'vender')).resolves.toBeUndefined();
    expect(await servicio.filtrar(VENDEDOR, [{ id_almacen: 1 }, { id_almacen: 2 }])).toEqual([{ id_almacen: 1 }]);
  });

  it('venta de un usuario restringido sin almacén elegido: el por defecto si es suyo, si no su único almacén; con varios, 403', async () => {
    expect(await armar({ asignados: [1, 3] }).servicio.almacenParaVenta(VENDEDOR, undefined, 3)).toBe(3);
    expect(await armar({ asignados: [1] }).servicio.almacenParaVenta(VENDEDOR, undefined, 2)).toBe(1);
    await expect(armar({ asignados: [1, 3] }).servicio.almacenParaVenta(VENDEDOR, undefined, 2)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(armar({ asignados: [] }).servicio.almacenParaVenta(VENDEDOR, undefined, 2)).rejects.toThrow(ForbiddenException);
    await expect(armar({ asignados: [1] }).servicio.almacenParaVenta(VENDEDOR, 2, 1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sin la tabla o si la lectura falla: nadie queda restringido (la regla no frena una venta por un problema propio)', async () => {
    expect(await armar({ asignados: [1], tabla: false }).servicio.alcance(VENDEDOR)).toEqual({ restringido: false });
    expect(await armar({ falla: true }).servicio.alcance(VENDEDOR)).toEqual({ restringido: false });
    expect(await armar({ asignados: [1] }).servicio.alcance(undefined)).toEqual({ restringido: false });
  });

  it('guardar: reemplaza, valida y anota en la bitácora; [] quita la restricción', async () => {
    const { servicio, repo, bitacora } = armar();
    await servicio.guardar(7, [2, '1', 2], ADMIN);
    expect(repo.reemplazar).toHaveBeenCalledWith(7, [1, 2]);
    const evento = (bitacora.registrarCon.mock.calls[0] as any[])[0]();
    expect(evento).toMatchObject({ accion: 'usuario.locales', id_usuario: 1, id_entidad: 7, antes: { id_sucursales: [3] }, despues: { id_sucursales: [1, 2] } });

    await servicio.guardar(7, [], ADMIN);
    expect(repo.reemplazar).toHaveBeenLastCalledWith(7, []);

    await expect(servicio.guardar(7, 'x', ADMIN)).rejects.toBeInstanceOf(BadRequestException);
    await expect(servicio.guardar(7, [99], ADMIN)).rejects.toThrow(/no existe/);
    await expect(armar({ rol: 'admin' }).servicio.guardar(7, [1], ADMIN)).rejects.toThrow(/administrador ve y hace todo/);
    await expect(armar({ tabla: false }).servicio.guardar(7, [1], ADMIN)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
