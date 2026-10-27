import { BadRequestException, ForbiddenException, ParseIntPipe, RequestMethod, ServiceUnavailableException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../guards/roles.decorator';
import { RolesGuard } from '../../guards/roles.guard';
import { ListarVentasRequest, ListarVentasSinComprobanteRequest } from '../../models/model/venta/listar-ventas.request';
import { crearValidationPipe } from '../../util/http/validacion/validation-pipe.factory';
import { VentaController } from './venta.controller';

type Metodo = (...args: unknown[]) => unknown;

function metodoDe(nombre: string): Metodo {
  return (VentaController.prototype as unknown as Record<string, Metodo>)[nombre];
}

/** Rutas GET en el orden en que Nest las registra (el de declaración en la clase). */
function rutasGet(): { nombre: string; ruta: string }[] {
  return Object.getOwnPropertyNames(VentaController.prototype)
    .filter((nombre) => nombre !== 'constructor' && typeof metodoDe(nombre) === 'function')
    .map((nombre) => ({
      nombre,
      ruta: Reflect.getMetadata(PATH_METADATA, metodoDe(nombre)) as string | undefined,
      metodo: Reflect.getMetadata(METHOD_METADATA, metodoDe(nombre)) as RequestMethod | undefined,
    }))
    .filter((r): r is { nombre: string; ruta: string; metodo: RequestMethod } => typeof r.ruta === 'string' && r.metodo === RequestMethod.GET)
    .map(({ nombre, ruta }) => ({ nombre, ruta }));
}

/** ¿La ruta de Express (con :parámetros) atiende esta URL relativa a /venta? */
function atiende(ruta: string, url: string): boolean {
  const patron = ruta.replace(/^\/+/, '').split('/').map((parte) => (parte.startsWith(':') ? '[^/]+' : parte)).join('/');
  return new RegExp(`^${patron}$`).test(url);
}

function pipesDelId(nombre: string): unknown[] {
  const argumentos = Reflect.getMetadata(ROUTE_ARGS_METADATA, VentaController, nombre) as Record<string, { data?: unknown; pipes?: unknown[] }>;
  return Object.values(argumentos ?? {}).find((a) => a.data === 'id')?.pipes ?? [];
}

function contexto(metodo: string, rol: string): ExecutionContext {
  return {
    getHandler: () => metodoDe(metodo),
    getClass: () => VentaController,
    switchToHttp: () => ({ getRequest: () => ({ user: { id_usuario: 1, rol } }) }),
  } as unknown as ExecutionContext;
}

async function validar<T>(metatipo: new () => T, consulta: unknown): Promise<T> {
  return crearValidationPipe().transform(consulta, { type: 'query', metatype: metatipo }) as Promise<T>;
}

async function mensajes<T>(metatipo: new () => T, consulta: unknown): Promise<string> {
  const error = await validar(metatipo, consulta).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(BadRequestException);
  return ((error as BadRequestException).getResponse() as { message: string[] }).message.join(' | ');
}

function crear() {
  const servicio = { listar: jest.fn().mockResolvedValue({ datos: [], total: 0, pagina: 1, por_pagina: 20 }) };
  const documentos = {
    documentos: jest.fn().mockResolvedValue({ venta: { id: 5 } }),
    sinComprobante: jest.fn().mockResolvedValue({ datos: [], total: 0, pagina: 1, por_pagina: 20 }),
  };
  return { controlador: new VentaController(servicio as never, documentos as never), servicio, documentos };
}

describe('VentaController: documentos de la venta e historial', () => {
  it('GET sin-comprobante y :id/documentos se registran antes de GET :id (si no, :id atendería «sin-comprobante»)', () => {
    const rutas = rutasGet();
    const posicion = (nombre: string) => rutas.findIndex((r) => r.nombre === nombre);

    expect(rutas).toEqual(expect.arrayContaining([
      { nombre: 'listar', ruta: '/' },
      { nombre: 'ventasSinComprobante', ruta: 'sin-comprobante' },
      { nombre: 'documentos', ruta: ':id/documentos' },
      { nombre: 'obtener', ruta: ':id' },
    ]));
    expect(posicion('ventasSinComprobante')).toBeLessThan(posicion('obtener'));
    expect(posicion('documentos')).toBeLessThan(posicion('obtener'));
    // La primera ruta GET que atiende /venta/sin-comprobante es la suya.
    expect(rutas.find((r) => atiende(r.ruta, 'sin-comprobante'))?.nombre).toBe('ventasSinComprobante');
    expect(rutas.find((r) => atiende(r.ruta, '5/documentos'))?.nombre).toBe('documentos');
    expect(atiende(':id', 'sin-comprobante')).toBe(true);
  });

  it('roles admin, vendedor y caja; :id entero', () => {
    const guardia = new RolesGuard(new Reflector());
    for (const metodo of ['ventasSinComprobante', 'documentos']) {
      expect(Reflect.getMetadata(ROLES_KEY, metodoDe(metodo))).toEqual(['admin', 'vendedor', 'caja']);
      expect(guardia.canActivate(contexto(metodo, 'cajero'))).toBe(true);
      expect(() => guardia.canActivate(contexto(metodo, 'consulta'))).toThrow(ForbiddenException);
    }
    expect(pipesDelId('documentos')).toContain(ParseIntPipe);
  });

  it('pasa el id, el usuario y los filtros a cada negocio', async () => {
    const { controlador, servicio, documentos } = crear();
    const usuario = { id_usuario: 4, rol: 'vendedor' } as never;
    const filtroHistorial = { texto: 'ACME', estado: 'activa', tiene_comprobante: 'no' } as ListarVentasRequest;
    const filtroSinComprobante = { desde: '2026-10-01', pagina: 2 } as ListarVentasSinComprobanteRequest;

    await controlador.documentos(5, usuario);
    await controlador.ventasSinComprobante(filtroSinComprobante);
    await controlador.listar(filtroHistorial);

    expect(documentos.documentos).toHaveBeenCalledWith(5, usuario);
    expect(documentos.sinComprobante).toHaveBeenCalledWith(filtroSinComprobante);
    expect(servicio.listar).toHaveBeenCalledWith(filtroHistorial);
  });

  it('sin el negocio de documentos (solo en pruebas que no lo arman) responde 503 con un mensaje claro', () => {
    const controlador = new VentaController({} as never);
    expect(() => controlador.documentos(5, {} as never)).toThrow(ServiceUnavailableException);
    expect(() => controlador.ventasSinComprobante({})).toThrow('Los documentos de la venta no están disponibles en este momento. Intente de nuevo en unos minutos.');
  });

  describe('filtros (400 con mensajes en español)', () => {
    it('GET /venta: tipa números, recorta textos y un select vacío es «sin filtro»', async () => {
      const filtro = await validar(ListarVentasRequest, {
        texto: '  F001-12 ',
        desde: '2026-10-01',
        hasta: '2026-10-24',
        estado: 'anulada',
        tiene_comprobante: '',
        origen: 'mostrador',
        pagina: '2',
        por_pagina: '50',
        _t: '1729800000',
      });
      expect(filtro).toBeInstanceOf(ListarVentasRequest);
      expect(filtro).toEqual({ texto: 'F001-12', desde: '2026-10-01', hasta: '2026-10-24', estado: 'anulada', origen: 'mostrador', pagina: 2, por_pagina: 50 });
    });

    it('GET /venta: fechas inexistentes, estado y tiene_comprobante fuera de lista, página y texto inválidos', async () => {
      const texto = await mensajes(ListarVentasRequest, {
        desde: '2026-02-30',
        hasta: '24-10-2026',
        estado: 'cerrada',
        tiene_comprobante: 'tal vez',
        pagina: '0',
        por_pagina: 'diez',
        texto: 'x'.repeat(101),
      });
      expect(texto).toContain('desde debe ser una fecha que exista, con formato aaaa-mm-dd.');
      expect(texto).toContain('hasta debe ser una fecha que exista, con formato aaaa-mm-dd.');
      expect(texto).toContain('estado: use activa o anulada.');
      expect(texto).toContain('tiene_comprobante: use si o no.');
      expect(texto).toContain('pagina debe ser 1 o más.');
      expect(texto).toContain('por_pagina debe ser un número entero.');
      expect(texto).toContain('La búsqueda admite hasta 100 caracteres.');
      // ?texto=a&texto=b llega como lista: el mensaje es el del tipo, no el del largo.
      expect(await mensajes(ListarVentasRequest, { texto: ['a', 'b'], pagina: '0' })).toBe('texto debe ser un texto. | pagina debe ser 1 o más.');
    });

    it('un rango al revés se avisa en vez de responder una lista vacía', async () => {
      expect(await mensajes(ListarVentasSinComprobanteRequest, { desde: '2026-10-24', hasta: '2026-10-01' })).toBe(
        'La fecha «desde» no puede ser posterior a «hasta».',
      );
      expect(await mensajes(ListarVentasRequest, { desde: '2026-10-24', hasta: '2026-10-01' })).toBe('La fecha «desde» no puede ser posterior a «hasta».');
      await expect(validar(ListarVentasSinComprobanteRequest, { desde: '2026-10-24', hasta: '2026-10-24' })).resolves.toEqual({
        desde: '2026-10-24',
        hasta: '2026-10-24',
      });
    });

    it('GET /venta/sin-comprobante: solo fechas y página (lo demás se descarta)', async () => {
      const filtro = await validar(ListarVentasSinComprobanteRequest, { desde: '', hasta: '2026-10-24', pagina: '2', por_pagina: '50', estado: 'anulada' });
      expect(filtro).toEqual({ hasta: '2026-10-24', pagina: 2, por_pagina: 50 });
    });
  });
});
