import { ConflictException, ExecutionContext, HttpException, INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import { GuiaRemisionBussnies } from '../../bussnies/Bussnies/guia-remision.bussnies';
import { GreTicketsTarea } from '../../bussnies/tareas/gre-tickets.tarea';
import { UbigeoController } from '../../catalogos/ubigeo/ubigeo.controller';
import { JwtGuard } from '../../guards/jwt.guard';
import { ROLES_KEY } from '../../guards/roles.decorator';
import { REGISTRO_GUIAS } from '../../registro/guias.registro';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { GuiaRemisionRepository } from '../../repository/Repository/guia-remision.repository';
import { REGISTRO_SUNAT_CONFIG } from '../../sunat/registro/config.registro';
import { REGISTRO_SUNAT_GRE } from '../../sunat/registro/gre.registro';
import { REGISTRO_SUNAT_NUCLEO } from '../../sunat/registro/nucleo.registro';
import { FiltroErroresGlobal } from '../../util/http/errores/filtro-errores.filter';
import { crearValidationPipe } from '../../util/http/validacion/validation-pipe.factory';
import { GuiaRemisionController } from './guia-remision.controller';

const servicio = {
  listar: jest.fn(async () => ({ datos: [], total: 0, pagina: 1, por_pagina: 20 })),
  modo: jest.fn(async () => ({ activo: false, codigo: 'GRE_SIN_BETA', motivo: 'Solo se puede validar sin enviar.' })),
  catalogos: jest.fn(() => ({ motivos: [{ codigo: '01' }] })),
  contextoVenta: jest.fn(async () => ({ venta: { id_venta: 10 } })),
  obtener: jest.fn(async (id: number) => ({ id_guia: id })),
  crear: jest.fn(async () => ({ id_guia: 7, estado: 'borrador' })),
  actualizar: jest.fn(async () => ({ id_guia: 7 })),
  validar: jest.fn(async () => ({ valido: true, errores: [], advertencias: [], por_campo: [] })),
  crearYEmitir: jest.fn(async () => ({ guia: { id_guia: 8, estado: 'aceptado' }, resultado: { estado: 'ACEPTADA' } })),
  emitir: jest.fn(async () => ({ guia: { id_guia: 7 }, resultado: { estado: 'TICKET_PENDIENTE' } })),
  consultar: jest.fn(async () => ({ guia: { id_guia: 7 }, resultado: { estado: 'ACEPTADA' } })),
  anular: jest.fn(async () => ({ id_guia: 7, estado: 'anulado' })),
  pdf: jest.fn(async () => ({ nombre: '20610206337-09-T001-00000001.pdf', contenido: Buffer.from('%PDF-1.3') })),
  archivo: jest.fn(async () => ({ nombre: 'R-20610206337-09-T001-00000001.xml', mime: 'application/xml', contenido: Buffer.from('<cdr/>') })),
};

const CUERPO_VALIDO = { id_venta: 10, motivo_traslado: '01', modalidad_traslado: '02', items: [{ id_producto: 5, cantidad: 2 }] };

describe('GuiaRemisionController (HTTP)', () => {
  let app: INestApplication;
  let rol = 'admin';

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [GuiaRemisionController],
      providers: [{ provide: GuiaRemisionBussnies, useValue: servicio }],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate: (contexto: ExecutionContext) => {
          contexto.switchToHttp().getRequest().user = { id_usuario: 3, rol };
          return true;
        },
      })
      .compile();
    app = modulo.createNestApplication();
    app.useGlobalPipes(crearValidationPipe());
    app.useGlobalFilters(new FiltroErroresGlobal());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    rol = 'admin';
    jest.clearAllMocks();
  });

  it('las rutas literales van antes de :id (modo, catalogos y el contexto de venta no se leen como un id)', async () => {
    const http = request(app.getHttpServer());
    expect((await http.get('/guia-remision/modo').expect(200)).body).toMatchObject({ activo: false, codigo: 'GRE_SIN_BETA' });
    await http.get('/guia-remision/catalogos').expect(200);
    await http.get('/guia-remision/ventas/10/contexto').expect(200);
    expect(servicio.contextoVenta).toHaveBeenCalledWith(10);
    expect(servicio.obtener).not.toHaveBeenCalled();
    const invalido = await http.get('/guia-remision/abc').expect(400);
    expect(invalido.body).toMatchObject({ codigo: 'ID_INVALIDO' });
  });

  it('lectura para admin, vendedor y caja; escritura solo admin y vendedor', async () => {
    expect(Reflect.getMetadata(ROLES_KEY, GuiaRemisionController)).toEqual(['admin', 'vendedor', 'caja']);
    for (const metodo of ['crear', 'crearYEmitir', 'actualizar', 'validar', 'emitir', 'consultar', 'anular'] as const) {
      expect(Reflect.getMetadata(ROLES_KEY, GuiaRemisionController.prototype[metodo])).toEqual(['admin', 'vendedor']);
    }
    rol = 'caja';
    const http = request(app.getHttpServer());
    await http.get('/guia-remision').expect(200);
    await http.get('/guia-remision/7').expect(200);
    const prohibido = await http.post('/guia-remision/7/emitir').expect(403);
    expect(prohibido.body.message).toContain('admin o vendedor');
    expect(servicio.emitir).not.toHaveBeenCalled();
  });

  it('valida el cuerpo y los filtros (400 en español) y pasa el usuario al negocio', async () => {
    const http = request(app.getHttpServer());
    const motivo = await http.post('/guia-remision').send({ ...CUERPO_VALIDO, motivo_traslado: '02' }).expect(400);
    expect(JSON.stringify(motivo.body.message)).toContain('Motivo de traslado no habilitado');
    const sinItems = await http.post('/guia-remision').send({ ...CUERPO_VALIDO, items: [] }).expect(400);
    expect(JSON.stringify(sinItems.body.message)).toContain('al menos un bien');
    const unidad = await http.post('/guia-remision').send({ ...CUERPO_VALIDO, items: [{ id_producto: 5, cantidad: 1, unidad: 'XXX' }] }).expect(400);
    expect(JSON.stringify(unidad.body.message)).toContain('catálogo 03');
    await http.get('/guia-remision').query({ por_pagina: 500 }).expect(400);

    await http.post('/guia-remision').send({ ...CUERPO_VALIDO, observaciones: '  ', destinatario: { tipo_documento: '' } }).expect(201);
    expect(servicio.crear).toHaveBeenCalledWith(expect.objectContaining({ motivo_traslado: '01', observaciones: undefined }), 3);
    await http.post('/guia-remision/7/emitir').expect(200);
    expect(servicio.emitir).toHaveBeenCalledWith(7, 3);
  });

  it('POST /guia-remision/emitir crea y emite con el cuerpo del borrador; si falla, el error trae el id_guia guardado', async () => {
    const http = request(app.getHttpServer());
    const ok = await http.post('/guia-remision/emitir').send(CUERPO_VALIDO).expect(201);
    expect(ok.body).toMatchObject({ guia: { id_guia: 8 }, resultado: { estado: 'ACEPTADA' } });
    expect(servicio.crearYEmitir).toHaveBeenCalledWith(expect.objectContaining({ motivo_traslado: '01', id_venta: 10 }), 3);
    // La ruta literal no se lee como ':id' ni llega al negocio con un cuerpo inválido.
    expect(servicio.emitir).not.toHaveBeenCalled();
    await http.post('/guia-remision/emitir').send({ ...CUERPO_VALIDO, modalidad_traslado: '03' }).expect(400);
    expect(servicio.crearYEmitir).toHaveBeenCalledTimes(1);

    servicio.crearYEmitir.mockRejectedValueOnce(
      new HttpException({ message: 'La guía de remisión electrónica está desactivada en el panel de facturación.', codigo: 'GRE_DESACTIVADA', id_guia: 8 }, 503),
    );
    const inactiva = await http.post('/guia-remision/emitir').send(CUERPO_VALIDO).expect(503);
    expect(inactiva.body).toMatchObject({ codigo: 'GRE_DESACTIVADA', id_guia: 8, message: 'La guía de remisión electrónica está desactivada en el panel de facturación.' });

    rol = 'caja';
    await http.post('/guia-remision/emitir').send(CUERPO_VALIDO).expect(403);
    expect(servicio.crearYEmitir).toHaveBeenCalledTimes(2);
  });

  it('los errores del negocio salen con su estado y su código (404, 409)', async () => {
    const http = request(app.getHttpServer());
    servicio.obtener.mockRejectedValueOnce(new NotFoundException({ message: 'La guía 99 no existe.', codigo: 'GRE_NO_ENCONTRADA' }));
    const noExiste = await http.get('/guia-remision/99').expect(404);
    expect(noExiste.body).toMatchObject({ message: 'La guía 99 no existe.', codigo: 'GRE_NO_ENCONTRADA' });
    servicio.emitir.mockRejectedValueOnce(new ConflictException({ message: 'La guía ya tiene un envío a SUNAT en curso: espere su resultado.', codigo: 'GRE_ENVIO_EN_CURSO' }));
    const enCurso = await http.post('/guia-remision/7/emitir').expect(409);
    expect(enCurso.body).toMatchObject({ codigo: 'GRE_ENVIO_EN_CURSO' });
  });

  it('descargas: adjunto con nombre saneado, nosniff, sin caché y tipo de archivo de una lista cerrada', async () => {
    const http = request(app.getHttpServer());
    const pdf = await http.get('/guia-remision/7/pdf').expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toBe('attachment; filename="20610206337-09-T001-00000001.pdf"');
    expect(pdf.headers['x-content-type-options']).toBe('nosniff');
    expect(pdf.headers['cache-control']).toBe('private, no-store');

    servicio.archivo.mockResolvedValueOnce({ nombre: '../R "x".xml', mime: 'application/xml', contenido: Buffer.from('<cdr/>') });
    const cdr = await http.get('/guia-remision/7/archivos/cdr_xml').expect(200);
    expect(cdr.headers['content-disposition']).toBe('attachment; filename="_R__x_.xml"');
    expect(servicio.archivo).toHaveBeenCalledWith(7, 'cdr_xml');
    await http.get('/guia-remision/7/archivos/xml_original').expect(400);
  });
});

describe('registro de la guía de remisión (DI)', () => {
  it('el negocio, el controlador, el catálogo de ubigeos y la tarea se resuelven con los registros de SUNAT', async () => {
    const modulo = await Test.createTestingModule({
      controllers: [GuiaRemisionController, ...REGISTRO_GUIAS.controladores],
      providers: [
        ...REGISTRO_SUNAT_CONFIG.proveedores,
        ...REGISTRO_SUNAT_NUCLEO.proveedores,
        ...REGISTRO_SUNAT_GRE.proveedores,
        ...REGISTRO_GUIAS.proveedores,
        // Registrados en app.module.ts.
        GuiaRemisionRepository,
        GuiaRemisionBussnies,
        ConfiguracionRepository,
        { provide: getDataSourceToken('pgConnection'), useValue: { query: jest.fn(async () => []), transaction: jest.fn() } },
      ],
    }).compile();
    expect(modulo.get(GuiaRemisionController)).toBeInstanceOf(GuiaRemisionController);
    expect(modulo.get(UbigeoController)).toBeInstanceOf(UbigeoController);
    expect(modulo.get(GreTicketsTarea)).toBeInstanceOf(GreTicketsTarea);
    // Con la BD vacía la GRE no está activa: el modo lo explica sin lanzar.
    expect(await modulo.get(GuiaRemisionBussnies).modo()).toMatchObject({ activo: false });
    await modulo.close();
  });
});
