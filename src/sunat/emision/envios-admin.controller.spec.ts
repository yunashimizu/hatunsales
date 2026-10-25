import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtGuard } from '../../guards/jwt.guard';
import { ROLES_KEY } from '../../guards/roles.decorator';
import { RolesGuard } from '../../guards/roles.guard';
import { crearValidationPipe } from '../../util/http/validacion/validation-pipe.factory';
import { FiscalConfigError } from '../config/fiscal-errores';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import { InterruptorEmisionFiscal } from '../config/interruptor-emision.service';
import { BetaAdminController } from './beta-admin.controller';
import { EmisionDirectaService } from './emision-directa.service';
import { EmisorBetaService } from './emisor-beta.service';
import { EnviosAdminController } from './envios-admin.controller';

const ADMIN = { id_usuario: 7, nombre: 'Moisés', email: 'admin@local', rol: 'admin', permisos: [] };

describe('EnviosAdminController y BetaAdminController (HTTP)', () => {
  let app: INestApplication;
  const emision = {
    listarEnvios: jest.fn(async () => ({ datos: [{ id_envio: 1 }], total: 1, pagina: 1, por_pagina: 20 })),
    obtenerEnvio: jest.fn(async (id: number) => (id === 1 ? { id_envio: 1 } : null)),
    obtenerArchivo: jest.fn(),
    reintentar: jest.fn(async (id: number) => ({ id_envio: id, estado: 'ACEPTADO' })),
    recuperarCdr: jest.fn(async (id: number) => ({ id_envio: id, estado: 'PENDIENTE_REENVIO' })),
    confirmarAceptadoManual: jest.fn(async (id: number) => ({ id_envio: id, estado: 'ACEPTADO' })),
    probarCredencialesProduccion: jest.fn(async () => ({ ok: true, codigo: '0011' })),
    estado: jest.fn(async () => ({ habilitado: false })),
    cambiarEstado: jest.fn(),
  };
  const interruptor = { reanudar: jest.fn(async () => ({ ambiente: 'produccion', reanudada: true, bloqueo_anterior: null })) };
  const esquema = { exigir: jest.fn(async () => undefined) };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [EnviosAdminController, BetaAdminController],
      providers: [
        { provide: EmisionDirectaService, useValue: emision },
        { provide: InterruptorEmisionFiscal, useValue: interruptor },
        { provide: FiscalEsquemaService, useValue: esquema },
        { provide: EmisorBetaService, useValue: { vista: jest.fn(), guardar: jest.fn() } },
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate: (contexto: ExecutionContext) => {
          contexto.switchToHttp().getRequest().user = ADMIN;
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = modulo.createNestApplication();
    app.useGlobalPipes(crearValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  it('solo el administrador: @Roles("admin") en ambos controladores', () => {
    expect(Reflect.getMetadata(ROLES_KEY, EnviosAdminController)).toEqual(['admin']);
    expect(Reflect.getMetadata(ROLES_KEY, BetaAdminController)).toEqual(['admin']);
  });

  it('descarga con Content-Disposition saneado, nosniff y sin caché (D13)', async () => {
    emision.obtenerArchivo.mockResolvedValueOnce({
      nombre: 'R-20610206337-01-F001-00000120".xml;\r\nX-Inyectada: 1',
      mime: 'application/xml',
      contenido: Buffer.from('<ApplicationResponse/>'),
    });
    const respuesta = await request(app.getHttpServer()).get('/fiscal/envios/5/archivos/cdr_xml').expect(200);
    expect(respuesta.headers['content-disposition']).toBe('attachment; filename="R-20610206337-01-F001-00000120_.xml___X-Inyectada__1"');
    expect(respuesta.headers['x-content-type-options']).toBe('nosniff');
    expect(respuesta.headers['cache-control']).toBe('private, no-store');
    expect(respuesta.headers['content-type']).toMatch(/^application\/xml/);
    expect(respuesta.headers['x-inyectada']).toBeUndefined();
    expect(emision.obtenerArchivo).toHaveBeenCalledWith(5, 'cdr_xml');
  });

  it('un tipo fuera de la lista cerrada es 400; un archivo que no existe, 404; un id no numérico, 400', async () => {
    const tipo = await request(app.getHttpServer()).get('/fiscal/envios/5/archivos/xml_raro').expect(400);
    expect(tipo.body).toMatchObject({ codigo: 'FISCAL_CONFIG_INVALIDA' });
    expect(emision.obtenerArchivo).not.toHaveBeenCalled();

    emision.obtenerArchivo.mockResolvedValueOnce(null);
    const falta = await request(app.getHttpServer()).get('/fiscal/envios/5/archivos/cdr_zip').expect(404);
    expect(falta.body).toMatchObject({ codigo: 'FISCAL_XML_NO_DISPONIBLE' });

    await request(app.getHttpServer()).get('/fiscal/envios/abc/archivos/zip').expect(400);
    await request(app.getHttpServer()).post('/fiscal/envios/1.5/reintentar').expect(400);
    expect(emision.reintentar).not.toHaveBeenCalled();
  });

  it('el mismo contrato de descarga en el alias /fiscal/beta', async () => {
    emision.obtenerArchivo.mockResolvedValueOnce({ nombre: 'x.zip', mime: 'text/html', contenido: Buffer.from('PK') });
    const respuesta = await request(app.getHttpServer()).get('/fiscal/beta/envios/3/archivos/zip').expect(200);
    // Un mime fuera de la lista no se sirve tal cual.
    expect(respuesta.headers['content-type']).toMatch(/^application\/octet-stream/);
    expect(respuesta.headers['x-content-type-options']).toBe('nosniff');
  });

  it('listado: filtros validados y el alias BETA devuelve { items }', async () => {
    await request(app.getHttpServer()).get('/fiscal/envios?ambiente=PRODUCCION&estado=aceptado&tipo=01&pagina=2&por_pagina=500').expect(200);
    expect(emision.listarEnvios).toHaveBeenCalledWith(expect.objectContaining({ ambiente: 'produccion', estado: 'ACEPTADO', tipo: '01', pagina: 2, por_pagina: 500 }));
    await request(app.getHttpServer()).get('/fiscal/envios?tipo=09').expect(400);
    await request(app.getHttpServer()).get('/fiscal/envios?ambiente=test').expect(400);

    const beta = await request(app.getHttpServer()).get('/fiscal/beta/envios').expect(200);
    expect(beta.body).toEqual({ items: [{ id_envio: 1 }] });
    expect(emision.listarEnvios).toHaveBeenLastCalledWith({ ambiente: 'beta', pagina: 1, por_pagina: 30 });
  });

  it('GET /fiscal/envios/:id responde 404 si no existe', async () => {
    await request(app.getHttpServer()).get('/fiscal/envios/1').expect(200);
    const falta = await request(app.getHttpServer()).get('/fiscal/envios/2').expect(404);
    expect(falta.body).toMatchObject({ codigo: 'FISCAL_DOC_NO_ENCONTRADO' });
  });

  it('confirmar-aceptado exige una nota de 5 a 300 caracteres y usa el usuario del token', async () => {
    await request(app.getHttpServer()).post('/fiscal/envios/4/confirmar-aceptado').send({ nota: 'ok' }).expect(400);
    await request(app.getHttpServer()).post('/fiscal/envios/4/confirmar-aceptado').send({ nota: 'x'.repeat(301) }).expect(400);
    expect(emision.confirmarAceptadoManual).not.toHaveBeenCalled();

    await request(app.getHttpServer()).post('/fiscal/envios/4/confirmar-aceptado').send({ nota: '  Verificado en SOL  ' }).expect(200);
    expect(emision.confirmarAceptadoManual).toHaveBeenCalledWith(4, 7, 'Verificado en SOL');
    expect(esquema.exigir).toHaveBeenCalledWith('emision', 'auditoria');
  });

  it('reintentar, recuperar-cdr, reanudar y probar credenciales (200) con los errores fiscales traducidos', async () => {
    await request(app.getHttpServer()).post('/fiscal/envios/8/reintentar').expect(200);
    expect(emision.reintentar).toHaveBeenCalledWith(8);
    await request(app.getHttpServer()).post('/fiscal/envios/8/recuperar-cdr').expect(200);
    expect(emision.recuperarCdr).toHaveBeenCalledWith(8);

    const reanudada = await request(app.getHttpServer()).post('/fiscal/emision/reanudar').expect(200);
    expect(reanudada.body).toMatchObject({ reanudada: true });
    expect(interruptor.reanudar).toHaveBeenCalledWith(expect.objectContaining({ id_usuario: 7, nombre: 'Moisés' }));

    await request(app.getHttpServer()).post('/fiscal/probar-credenciales-produccion').expect(200);
    expect(emision.probarCredencialesProduccion).toHaveBeenCalledWith(expect.objectContaining({ id_usuario: 7 }));

    emision.reintentar.mockRejectedValueOnce(new FiscalConfigError('FISCAL_EMISION_BLOQUEADA', 'La emisión está detenida.'));
    const bloqueada = await request(app.getHttpServer()).post('/fiscal/envios/8/reintentar').expect(503);
    expect(bloqueada.body).toMatchObject({ codigo: 'FISCAL_EMISION_BLOQUEADA', message: 'La emisión está detenida.' });
  });
});
