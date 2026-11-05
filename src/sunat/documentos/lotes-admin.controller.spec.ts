import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtGuard } from '../../guards/jwt.guard';
import { ROLES_KEY } from '../../guards/roles.decorator';
import { RolesGuard } from '../../guards/roles.guard';
import { crearValidationPipe } from '../../util/http/validacion/validation-pipe.factory';
import { FiscalConfigError } from '../config/fiscal-errores';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import { LotesAdminController } from './lotes-admin.controller';
import { LotesFiscales } from './lotes.contrato';

const ADMIN = { id_usuario: 7, nombre: 'Moisés', email: 'admin@local', rol: 'admin', permisos: [] };

describe('LotesAdminController (HTTP): bajas RA y resúmenes RC', () => {
  let app: INestApplication;
  const lotes = {
    listar: jest.fn(async () => ({ datos: [{ id_envio: 1 }], total: 1, pagina: 1, por_pagina: 20 })),
    obtener: jest.fn(async (id: number) => (id === 1 ? { id_envio: 1, identificador: 'RA-20261105-00001' } : null)),
    archivo: jest.fn(),
    reintentar: jest.fn(async (id: number) => ({ id_envio: id, estado: 'TICKET_PENDIENTE' })),
  };
  const esquema = { exigir: jest.fn(async () => undefined) };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [LotesAdminController],
      providers: [
        { provide: LotesFiscales, useValue: lotes },
        { provide: FiscalEsquemaService, useValue: esquema },
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

  it('solo el administrador: @Roles("admin")', () => {
    expect(Reflect.getMetadata(ROLES_KEY, LotesAdminController)).toEqual(['admin']);
  });

  it('listado: filtros validados (ambiente, operación, estado, página) y sin caché', async () => {
    const respuesta = await request(app.getHttpServer())
      .get('/fiscal/lotes?ambiente=PRODUCCION&operacion=BAJA&estado=ticket_pendiente&pagina=2&por_pagina=500')
      .expect(200);
    expect(respuesta.headers['cache-control']).toBe('private, no-store');
    expect(lotes.listar).toHaveBeenCalledWith(
      expect.objectContaining({ ambiente: 'produccion', operacion: 'baja', estado: 'TICKET_PENDIENTE', pagina: 2, por_pagina: 500 }),
    );
    expect(esquema.exigir).toHaveBeenCalledWith('emision');

    await request(app.getHttpServer()).get('/fiscal/lotes?operacion=emitir').expect(400);
    await request(app.getHttpServer()).get('/fiscal/lotes?estado=INVENTADO').expect(400);
    await request(app.getHttpServer()).get('/fiscal/lotes?ambiente=test').expect(400);
    await request(app.getHttpServer()).get('/fiscal/lotes?pagina=0').expect(400);
  });

  it('GET /fiscal/lotes/:id responde 404 si no existe y 400 si el id no es un entero', async () => {
    await request(app.getHttpServer()).get('/fiscal/lotes/1').expect(200);
    const falta = await request(app.getHttpServer()).get('/fiscal/lotes/2').expect(404);
    expect(falta.body).toMatchObject({ codigo: 'FISCAL_DOC_NO_ENCONTRADO' });
    await request(app.getHttpServer()).get('/fiscal/lotes/abc').expect(400);
  });

  it('descarga con Content-Disposition saneado, nosniff y sin caché (mismas cabeceras que los envíos)', async () => {
    lotes.archivo.mockResolvedValueOnce({
      nombre: 'R-20610206337-RA-20261105-00001".xml;\r\nX-Inyectada: 1',
      mime: 'application/xml',
      contenido: Buffer.from('<ApplicationResponse/>'),
    });

    const respuesta = await request(app.getHttpServer()).get('/fiscal/lotes/5/archivos/cdr_xml').expect(200);

    expect(respuesta.headers['content-disposition']).toBe('attachment; filename="R-20610206337-RA-20261105-00001_.xml___X-Inyectada__1"');
    expect(respuesta.headers['x-content-type-options']).toBe('nosniff');
    expect(respuesta.headers['cache-control']).toBe('private, no-store');
    expect(respuesta.headers['access-control-expose-headers']).toBe('Content-Disposition');
    expect(respuesta.headers['x-inyectada']).toBeUndefined();
    expect(lotes.archivo).toHaveBeenCalledWith(5, 'cdr_xml');
  });

  it('un tipo fuera de la lista cerrada es 400; un archivo que no existe, 404', async () => {
    const tipo = await request(app.getHttpServer()).get('/fiscal/lotes/5/archivos/xml_raro').expect(400);
    expect(tipo.body).toMatchObject({ codigo: 'FISCAL_CONFIG_INVALIDA' });
    expect(lotes.archivo).not.toHaveBeenCalled();

    lotes.archivo.mockResolvedValueOnce(null);
    const falta = await request(app.getHttpServer()).get('/fiscal/lotes/5/archivos/zip').expect(404);
    expect(falta.body).toMatchObject({ codigo: 'FISCAL_XML_NO_DISPONIBLE' });
  });

  it('reintentar: 200 con el resultado y los errores fiscales traducidos (409 no permitido, 503 emisión detenida)', async () => {
    const ok = await request(app.getHttpServer()).post('/fiscal/lotes/8/reintentar').expect(200);
    expect(ok.body).toMatchObject({ id_envio: 8, estado: 'TICKET_PENDIENTE' });
    expect(lotes.reintentar).toHaveBeenCalledWith(8);

    lotes.reintentar.mockRejectedValueOnce(new FiscalConfigError('FISCAL_REENVIO_NO_PERMITIDO', 'No está disponible.'));
    await request(app.getHttpServer()).post('/fiscal/lotes/8/reintentar').expect(409);
    lotes.reintentar.mockRejectedValueOnce(new FiscalConfigError('FISCAL_EMISION_BLOQUEADA', 'La emisión está detenida.'));
    const bloqueada = await request(app.getHttpServer()).post('/fiscal/lotes/8/reintentar').expect(503);
    expect(bloqueada.body).toMatchObject({ codigo: 'FISCAL_EMISION_BLOQUEADA' });

    await request(app.getHttpServer()).post('/fiscal/lotes/1.5/reintentar').expect(400);
  });
});
