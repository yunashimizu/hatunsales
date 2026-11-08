import { BadRequestException, ForbiddenException, NotFoundException, StreamableFile } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../guards/roles.decorator';
import { RolesGuard } from '../../guards/roles.guard';
import { ComprobanteController, nombreDescarga } from './comprobante.controller';

function respuestaFalsa() {
  const cabeceras: Record<string, string> = {};
  return {
    cabeceras,
    setHeader: jest.fn((nombre: string, valor: string) => {
      cabeceras[nombre.toLowerCase()] = valor;
    }),
  };
}

function crear() {
  const servicio = {
    obtenerArchivo: jest.fn(),
    obtenerPdf: jest.fn(),
    confirmarAceptado: jest.fn().mockResolvedValue({ estado: 'emitido' }),
    reintentar: jest.fn().mockResolvedValue({ estado: 'emitido' }),
    informarPorResumen: jest.fn().mockResolvedValue({ id_envio: 70, estado: 'TICKET_PENDIENTE' }),
    catalogoMotivos: jest.fn().mockReturnValue({ nota_credito: [], nota_debito: [] }),
    listar: jest.fn().mockResolvedValue({ datos: [], total: 0, pagina: 1, por_pagina: 20 }),
    generar: jest.fn().mockResolvedValue({}),
    obtenerDetalle: jest.fn().mockResolvedValue({ id_comprobante: 5, enviar_cliente: true }),
  };
  const correo = {
    estadoResumen: jest.fn().mockResolvedValue({ estado: 'PENDIENTE', puede_reenviar: true }),
    reenviar: jest.fn().mockResolvedValue({ id_correo: 31, estado: 'ENVIADO' }),
    historial: jest.fn().mockResolvedValue([{ id_correo: 31 }]),
  };
  return { controlador: new ComprobanteController(servicio as never, correo as never), servicio, correo };
}

/** Contexto mínimo para el RolesGuard: el método del controlador y el usuario del token. */
function contexto(metodo: keyof ComprobanteController, rol: string): ExecutionContext {
  return {
    getHandler: () => ComprobanteController.prototype[metodo],
    getClass: () => ComprobanteController,
    switchToHttp: () => ({ getRequest: () => ({ user: { id_usuario: 1, rol } }) }),
  } as unknown as ExecutionContext;
}

describe('ComprobanteController', () => {
  describe('GET /comprobante/:id/archivos/:tipo', () => {
    it('rechaza con 400 un tipo fuera de la lista cerrada sin consultar nada', async () => {
      const { controlador, servicio } = crear();
      const res = respuestaFalsa();

      await expect(controlador.archivo(5, '../../etc/passwd', res as never)).rejects.toBeInstanceOf(BadRequestException);
      await expect(controlador.archivo(5, 'pdf', res as never)).rejects.toBeInstanceOf(BadRequestException);
      expect(servicio.obtenerArchivo).not.toHaveBeenCalled();
    });

    it('propaga el 404 del negocio (comprobante sin envío o archivo inexistente)', async () => {
      const { controlador, servicio } = crear();
      servicio.obtenerArchivo.mockRejectedValue(new NotFoundException('todavía no tiene constancia (CDR)'));

      await expect(controlador.archivo(5, 'cdr_xml', respuestaFalsa() as never)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('descarga como adjunto privado, sin caché ni adivinar el tipo, con el nombre saneado', async () => {
      const { controlador, servicio } = crear();
      servicio.obtenerArchivo.mockResolvedValue({
        nombre: 'R-20610206337-01-F001-00000012 "final".xml',
        mime: 'application/xml',
        contenido: Buffer.from('<cdr/>'),
      });
      const res = respuestaFalsa();

      const archivo = await controlador.archivo(5, 'cdr_xml', res as never);

      expect(servicio.obtenerArchivo).toHaveBeenCalledWith(5, 'cdr_xml');
      expect(archivo).toBeInstanceOf(StreamableFile);
      expect(res.cabeceras).toMatchObject({
        'content-type': 'application/xml',
        'content-disposition': 'attachment; filename="R-20610206337-01-F001-00000012__final_.xml"',
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
        'content-length': '6',
      });
    });
  });

  describe('GET /comprobante/:id/pdf', () => {
    it('entrega el PDF del negocio como application/pdf adjunto', async () => {
      const { controlador, servicio } = crear();
      servicio.obtenerPdf.mockResolvedValue({ nombre: 'F001-00000012-ticket.pdf', contenido: Buffer.from('%PDF-1.4') });
      const res = respuestaFalsa();

      await controlador.pdf(5, res as never, 'TICKET');

      expect(servicio.obtenerPdf).toHaveBeenCalledWith(5, 'ticket');
      expect(res.cabeceras['content-type']).toBe('application/pdf');
      expect(res.cabeceras['content-disposition']).toBe('attachment; filename="F001-00000012-ticket.pdf"');
      expect(res.cabeceras['cache-control']).toBe('private, no-store');
    });

    it('A4 por defecto y 400 con un formato desconocido', async () => {
      const { controlador, servicio } = crear();
      servicio.obtenerPdf.mockResolvedValue({ nombre: 'B001-00000001.pdf', contenido: Buffer.from('%PDF') });

      await controlador.pdf(5, respuestaFalsa() as never);
      expect(servicio.obtenerPdf).toHaveBeenCalledWith(5, 'a4');

      await expect(controlador.pdf(5, respuestaFalsa() as never, 'docx')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('POST /comprobante/:id/confirmar-aceptado', () => {
    it('solo lo puede usar un administrador', () => {
      const guardia = new RolesGuard(new Reflector());
      expect(Reflect.getMetadata(ROLES_KEY, ComprobanteController.prototype.confirmarAceptado)).toEqual(['admin']);
      expect(guardia.canActivate(contexto('confirmarAceptado', 'admin'))).toBe(true);
      expect(() => guardia.canActivate(contexto('confirmarAceptado', 'caja'))).toThrow(ForbiddenException);
      expect(() => guardia.canActivate(contexto('confirmarAceptado', 'vendedor'))).toThrow(ForbiddenException);
      // Reintentar sí lo pueden hacer los roles de venta.
      expect(guardia.canActivate(contexto('reintentar', 'caja'))).toBe(true);
    });

    it('pasa el usuario del token y la nota al negocio', async () => {
      const { controlador, servicio } = crear();

      await controlador.confirmarAceptado(5, { nota: 'Verificado en SOL' }, { id_usuario: 4 } as never);

      expect(servicio.confirmarAceptado).toHaveBeenCalledWith(5, 4, 'Verificado en SOL');
    });
  });

  describe('POST /comprobante/:id/reintentar', () => {
    const peticion = { ip: '10.0.0.5', socket: {} } as never;
    const admin = { id_usuario: 4, nombre: 'Moisés', rol: 'admin' } as never;

    it('el reintento común lo hacen los roles de venta; pasa al negocio quién lo pide y que no es forzado', async () => {
      const { controlador, servicio } = crear();

      await controlador.reintentar(5, {}, { id_usuario: 9, nombre: 'Caja', rol: 'caja' } as never, peticion);

      expect(servicio.reintentar).toHaveBeenCalledWith(5, { forzar: false, actor: expect.objectContaining({ id_usuario: 9, nombre: 'Caja', ip: '10.0.0.5' }) });
    });

    it('«Reintentar ahora» (forzar) es solo del administrador: otro rol recibe 403 y no se reintenta nada', async () => {
      const { controlador, servicio } = crear();

      for (const rol of ['vendedor', 'caja', 'consulta']) {
        await expect(async () => controlador.reintentar(5, { forzar: true }, { id_usuario: 9, rol } as never, peticion)).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(servicio.reintentar).not.toHaveBeenCalled();

      await controlador.reintentar(5, { forzar: true }, admin, peticion);
      expect(servicio.reintentar).toHaveBeenCalledWith(5, { forzar: true, actor: expect.objectContaining({ id_usuario: 4 }) });
      // Los alias del rol de administración también valen.
      await controlador.reintentar(5, { forzar: true }, { id_usuario: 1, nombre: 'Gerencia', rol: 'Administrador' } as never, peticion);
      expect(servicio.reintentar).toHaveBeenCalledTimes(2);
    });
  });

  describe('POST /comprobante/:id/resumir («Informar por resumen»)', () => {
    const peticion = { ip: '10.0.0.5', socket: {} } as never;

    it('lo usan el administrador y el vendedor; el cajero (que solo cobra) recibe 403', () => {
      const guardia = new RolesGuard(new Reflector());
      expect(Reflect.getMetadata(ROLES_KEY, ComprobanteController.prototype.resumir)).toEqual(['admin', 'vendedor']);
      expect(guardia.canActivate(contexto('resumir', 'admin'))).toBe(true);
      expect(guardia.canActivate(contexto('resumir', 'vendedor'))).toBe(true);
      expect(() => guardia.canActivate(contexto('resumir', 'caja'))).toThrow(ForbiddenException);
      expect(() => guardia.canActivate(contexto('resumir', 'consulta'))).toThrow(ForbiddenException);
    });

    it('pasa al negocio quién lo pide (usuario e IP para la bitácora) y devuelve el resultado del resumen', async () => {
      const { controlador, servicio } = crear();

      const resultado = await controlador.resumir(5, { id_usuario: 4, nombre: 'Moisés', rol: 'admin' } as never, peticion);

      expect(servicio.informarPorResumen).toHaveBeenCalledWith(5, expect.objectContaining({ id_usuario: 4, nombre: 'Moisés', ip: '10.0.0.5' }));
      expect(resultado).toMatchObject({ id_envio: 70, estado: 'TICKET_PENDIENTE' });
    });
  });

  it('el catálogo de motivos sale del negocio (catálogo SUNAT)', () => {
    const { controlador, servicio } = crear();
    expect(controlador.motivos()).toEqual({ nota_credito: [], nota_debito: [] });
    expect(servicio.catalogoMotivos).toHaveBeenCalled();
  });

  it('el listado normaliza los filtros nuevos y limita la página a 100', async () => {
    const { controlador, servicio } = crear();

    await controlador.listar('ana', '1', undefined, 'rechazado', 'PRODUCCION', '2026-10-01', undefined, '2', '500');

    expect(servicio.listar).toHaveBeenCalledWith({
      texto: 'ana',
      id_tipo: 1,
      estado: undefined,
      estado_sunat: 'RECHAZADO',
      ambiente: 'produccion',
      desde: '2026-10-01',
      hasta: undefined,
      pagina: 2,
      por_pagina: 100,
    });
  });

  it('generar pasa el usuario del token para la auditoría del comprobante', async () => {
    const { controlador, servicio } = crear();
    await controlador.generar({ id_tipo: 2, items: [] } as never, { id_usuario: 9 } as never);
    expect(servicio.generar).toHaveBeenCalledWith({ id_tipo: 2, items: [] }, 9);
  });

  describe('correo del comprobante', () => {
    it('GET :id/detalle mezcla el resumen del correo en el detalle sin tocar el resto', async () => {
      const { controlador, servicio, correo } = crear();
      const detalle = await controlador.detalle(5);
      expect(servicio.obtenerDetalle).toHaveBeenCalledWith(5);
      expect(correo.estadoResumen).toHaveBeenCalledWith({ id_comprobante: 5, enviar_cliente: true });
      expect(detalle).toEqual({ id_comprobante: 5, enviar_cliente: true, correo: { estado: 'PENDIENTE', puede_reenviar: true } });
    });

    it('POST :id/correo reenvía con el destino y el usuario del token; sin cuerpo usa el del comprobante', async () => {
      const { controlador, correo } = crear();
      expect(await controlador.reenviarCorreo(5, { destino: 'otro@ejemplo.pe' }, { id_usuario: 9 } as never)).toEqual({ id_correo: 31, estado: 'ENVIADO' });
      expect(correo.reenviar).toHaveBeenCalledWith(5, 'otro@ejemplo.pe', 9);
      await controlador.reenviarCorreo(5, undefined as never, undefined);
      expect(correo.reenviar).toHaveBeenLastCalledWith(5, undefined, null);
    });

    it('GET :id/correos devuelve el historial', async () => {
      const { controlador, correo } = crear();
      expect(await controlador.historialCorreos(5)).toEqual([{ id_correo: 31 }]);
      expect(correo.historial).toHaveBeenCalledWith(5);
    });

    it('las rutas nuevas se declaran antes de GET :id y admiten admin, vendedor y caja', () => {
      const orden = Object.getOwnPropertyNames(ComprobanteController.prototype);
      expect(orden.indexOf('reenviarCorreo')).toBeLessThan(orden.indexOf('obtenerPorId'));
      expect(orden.indexOf('historialCorreos')).toBeLessThan(orden.indexOf('obtenerPorId'));
      const guard = new RolesGuard(new Reflector());
      for (const rol of ['admin', 'vendedor', 'caja']) {
        expect(guard.canActivate(contexto('reenviarCorreo', rol))).toBe(true);
        expect(guard.canActivate(contexto('historialCorreos', rol))).toBe(true);
      }
    });
  });

  it('nombreDescarga deja solo [A-Za-z0-9._-] y nunca un nombre vacío u oculto', () => {
    expect(nombreDescarga('F001-00000012.pdf')).toBe('F001-00000012.pdf');
    expect(nombreDescarga('../..\\x;"y\r\n.xml')).toBe('_.._x__y__.xml');
    expect(nombreDescarga('...', 'respaldo.zip')).toBe('respaldo.zip');
  });
});
