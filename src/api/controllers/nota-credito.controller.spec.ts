import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ParseIntPipe,
  RequestMethod,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../guards/roles.decorator';
import { RolesGuard } from '../../guards/roles.guard';
import { EmitirNotaCreditoRequest } from '../../models/model/c-electronico/nota-credito.request';
import { AnularVentaRequest } from '../../models/model/venta/anular-venta.request';
import { crearValidationPipe } from '../../util/http/validacion/validation-pipe.factory';
import { ComprobanteController } from './comprobante.controller';
import { NotaCreditoController } from './nota-credito.controller';
import { VentaController } from './venta.controller';

type Clase = { prototype: object; name: string };

function metodoDe(clase: Clase, nombre: string): (...args: unknown[]) => unknown {
  return (clase.prototype as Record<string, (...args: unknown[]) => unknown>)[nombre];
}

/** Rutas declaradas por un controlador: [verbo, ruta] de cada método con @Get/@Post. */
function rutas(clase: Clase): { metodo: RequestMethod; ruta: string; nombre: string }[] {
  return Object.getOwnPropertyNames(clase.prototype)
    .filter((nombre) => nombre !== 'constructor' && typeof metodoDe(clase, nombre) === 'function')
    .map((nombre) => ({
      nombre,
      ruta: Reflect.getMetadata(PATH_METADATA, metodoDe(clase, nombre)) as string | undefined,
      metodo: Reflect.getMetadata(METHOD_METADATA, metodoDe(clase, nombre)) as RequestMethod,
    }))
    .filter((r): r is { metodo: RequestMethod; ruta: string; nombre: string } => typeof r.ruta === 'string');
}

/** ¿La ruta de Express (con :parámetros) atiende esta URL relativa al prefijo? */
function atiende(ruta: string, url: string): boolean {
  const patron = ruta.replace(/^\/+/, '').split('/').map((parte) => (parte.startsWith(':') ? '[^/]+' : parte)).join('/');
  return new RegExp(`^${patron}$`).test(url);
}

function pipesDelId(clase: Clase, nombre: string): unknown[] {
  const argumentos = Reflect.getMetadata(ROUTE_ARGS_METADATA, clase, nombre) as Record<string, { data?: unknown; pipes?: unknown[] }>;
  return Object.values(argumentos ?? {}).find((a) => a.data === 'id')?.pipes ?? [];
}

function contexto(clase: Clase, metodo: string, rol: string): ExecutionContext {
  return {
    getHandler: () => metodoDe(clase, metodo),
    getClass: () => clase,
    switchToHttp: () => ({ getRequest: () => ({ user: { id_usuario: 1, rol } }) }),
  } as unknown as ExecutionContext;
}

async function validar<T>(metatipo: new () => T, cuerpo: unknown): Promise<T> {
  return crearValidationPipe().transform(cuerpo, { type: 'body', metatype: metatipo }) as Promise<T>;
}

function crear() {
  const notas = {
    contexto: jest.fn().mockResolvedValue({ permitido: true }),
    emitir: jest.fn().mockResolvedValue({ estado: 'emitido', aceptada_sunat: true, avisos: [] }),
  };
  return { controlador: new NotaCreditoController(notas as never), notas };
}

describe('NotaCreditoController (/comprobante/:id/nota-credito)', () => {
  it('rutas: GET :id/nota-credito/contexto y POST :id/nota-credito (200 aunque SUNAT rechace), con :id entero', () => {
    expect(Reflect.getMetadata(PATH_METADATA, NotaCreditoController)).toBe('comprobante');
    expect(rutas(NotaCreditoController)).toEqual(
      expect.arrayContaining([
        { nombre: 'contexto', ruta: ':id/nota-credito/contexto', metodo: RequestMethod.GET },
        { nombre: 'emitir', ruta: ':id/nota-credito', metodo: RequestMethod.POST },
      ]),
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, NotaCreditoController.prototype.emitir)).toBe(200);
    expect(pipesDelId(NotaCreditoController, 'contexto')).toContain(ParseIntPipe);
    expect(pipesDelId(NotaCreditoController, 'emitir')).toContain(ParseIntPipe);
  });

  it('ninguna ruta de ComprobanteController (mismo prefijo, registrado antes) tapa las de la nota', () => {
    const delMismoPrefijo = rutas(ComprobanteController);
    expect(Reflect.getMetadata(PATH_METADATA, ComprobanteController)).toBe('comprobante');
    expect(delMismoPrefijo.length).toBeGreaterThan(5);
    const tapan = delMismoPrefijo.filter(
      (r) =>
        (r.metodo === RequestMethod.GET && atiende(r.ruta, '40/nota-credito/contexto'))
        || (r.metodo === RequestMethod.POST && atiende(r.ruta, '40/nota-credito')),
    );
    expect(tapan).toEqual([]);
    // Control del ayudante: «:id/detalle» sí atiende su propia URL.
    expect(atiende(':id/detalle', '40/detalle')).toBe(true);
  });

  it('roles: el contexto lo ven admin, vendedor y caja; emitir solo admin y vendedor', () => {
    const guardia = new RolesGuard(new Reflector());
    expect(Reflect.getMetadata(ROLES_KEY, NotaCreditoController.prototype.contexto)).toEqual(['admin', 'vendedor', 'caja']);
    expect(Reflect.getMetadata(ROLES_KEY, NotaCreditoController.prototype.emitir)).toEqual(['admin', 'vendedor']);
    expect(guardia.canActivate(contexto(NotaCreditoController, 'contexto', 'caja'))).toBe(true);
    expect(guardia.canActivate(contexto(NotaCreditoController, 'emitir', 'vendedor'))).toBe(true);
    expect(() => guardia.canActivate(contexto(NotaCreditoController, 'emitir', 'caja'))).toThrow(ForbiddenException);
    expect(() => guardia.canActivate(contexto(NotaCreditoController, 'contexto', 'consulta'))).toThrow(ForbiddenException);
  });

  it('pasa el id y el usuario del token al negocio; sin usuario va null', async () => {
    const { controlador, notas } = crear();
    const cuerpo = { motivo: '07', sustento: 'Devolución', items: [{ id_item: 401, cantidad: 1 }] } as EmitirNotaCreditoRequest;

    await controlador.emitir(40, cuerpo, { id_usuario: 3 } as never);
    await controlador.emitir(40, cuerpo, undefined as never);
    await controlador.contexto(40);

    expect(notas.emitir).toHaveBeenNthCalledWith(1, 40, cuerpo, 3);
    expect(notas.emitir).toHaveBeenNthCalledWith(2, 40, cuerpo, null);
    expect(notas.contexto).toHaveBeenCalledWith(40);
  });

  it.each([
    ['404 si el comprobante no existe', new NotFoundException('No existe el comprobante')],
    ['409 si otra nota del comprobante está en curso', new ConflictException({ message: 'en curso', codigo: 'NOTA_CREDITO_EN_CURSO', id_comprobante: 61 })],
    ['503 si la emisión no está activa o falta fase14', new ServiceUnavailableException({ message: 'Aplique sql/fase14…', codigo: 'NOTA_CREDITO_MIGRACION_PENDIENTE' })],
  ])('%s: el error del negocio sale tal cual (el filtro global lo traduce)', async (_caso, error) => {
    const { controlador, notas } = crear();
    notas.emitir.mockRejectedValue(error);
    await expect(controlador.emitir(40, {} as EmitirNotaCreditoRequest, { id_usuario: 3 } as never)).rejects.toBe(error);
  });

  describe('cuerpo de POST :id/nota-credito (400 con mensajes en español)', () => {
    it('acepta una devolución por ítem y la deja tipada', async () => {
      const cuerpo = await validar(EmitirNotaCreditoRequest, {
        motivo: '07',
        sustento: 'Devolución de un martillo',
        items: [{ id_item: 401, cantidad: 1 }],
        reingresar_stock: false,
        extra: 'se descarta',
      });
      expect(cuerpo).toBeInstanceOf(EmitirNotaCreditoRequest);
      expect(cuerpo).toEqual({ motivo: '07', sustento: 'Devolución de un martillo', items: [{ id_item: 401, cantidad: 1 }], reingresar_stock: false });
    });

    it('rechaza motivo, sustento, ítems, monto y reingreso inválidos, cada uno con su mensaje', async () => {
      const error = await validar(EmitirNotaCreditoRequest, {
        motivo: '7',
        sustento: 'ab',
        items: [{ id_item: 0, cantidad: 0 }],
        monto: -5,
        reingresar_stock: 'si',
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      const mensajes = ((error as BadRequestException).getResponse() as { message: string[] }).message.join(' | ');
      expect(mensajes).toContain('El motivo debe ser un código de dos dígitos del catálogo 09 de SUNAT');
      expect(mensajes).toContain('El sustento debe tener al menos 3 caracteres');
      expect(mensajes).toContain('id_item debe ser mayor que cero');
      expect(mensajes).toContain('La cantidad debe ser mayor que cero');
      expect(mensajes).toContain('El monto debe ser mayor que cero');
      expect(mensajes).toContain('reingresar_stock debe ser verdadero o falso');
    });

    it('el sustento admite hasta 250 caracteres', async () => {
      const error = await validar(EmitirNotaCreditoRequest, { motivo: '01', sustento: 'x'.repeat(251) }).catch((e: unknown) => e);
      expect(((error as BadRequestException).getResponse() as { message: string[] }).message).toContain('El sustento admite hasta 250 caracteres');
    });
  });
});

describe('POST /venta/:id/anular (D9)', () => {
  it('solo administradores, 200 y :id entero', () => {
    const guardia = new RolesGuard(new Reflector());
    expect(Reflect.getMetadata(ROLES_KEY, VentaController.prototype.anular)).toEqual(['admin']);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, VentaController.prototype.anular)).toBe(200);
    expect(pipesDelId(VentaController, 'anular')).toContain(ParseIntPipe);
    expect(() => guardia.canActivate(contexto(VentaController, 'anular', 'caja'))).toThrow(ForbiddenException);
    expect(guardia.canActivate(contexto(VentaController, 'anular', 'admin'))).toBe(true);
  });

  it('pasa el cuerpo (o uno vacío) y el usuario del token', async () => {
    const servicio = { anular: jest.fn().mockResolvedValue({ estado: 'anulada' }) };
    const controlador = new VentaController(servicio as never);

    await controlador.anular(9, { motivo: 'Cliente desiste' }, { id_usuario: 4 } as never);
    await controlador.anular(9, undefined as never, { id_usuario: 4 } as never);

    expect(servicio.anular).toHaveBeenNthCalledWith(1, 9, { motivo: 'Cliente desiste' }, { id_usuario: 4 });
    expect(servicio.anular).toHaveBeenNthCalledWith(2, 9, {}, { id_usuario: 4 });
  });

  it('el cuerpo es opcional; motivo, verificación en SOL y nota se validan con mensajes en español', async () => {
    expect(await validar(AnularVentaRequest, {})).toEqual({});
    const error = await validar(AnularVentaRequest, {
      motivo: 'x'.repeat(251),
      confirmar_verificado_sol: 'si',
      existe_en_sunat: 1,
      nota: 'n'.repeat(301),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    const mensajes = ((error as BadRequestException).getResponse() as { message: string[] }).message.join(' | ');
    expect(mensajes).toContain('El motivo admite hasta 250 caracteres');
    expect(mensajes).toContain('confirmar_verificado_sol debe ser verdadero o falso');
    expect(mensajes).toContain('existe_en_sunat debe ser verdadero o falso');
    expect(mensajes).toContain('La nota admite hasta 300 caracteres');
  });
});
