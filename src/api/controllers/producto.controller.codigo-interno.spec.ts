import { InternalServerErrorException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ProductoBussnies } from '../../bussnies/Bussnies/producto.bussnies';
import { JwtGuard } from '../../guards/jwt.guard';
import { OptionalJwtGuard } from '../../guards/optional-jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { ProductoController } from './producto.controller';

describe('POST /producto/codigo-interno', () => {
  let app: INestApplication<App>;
  const servicio = { generarCodigoInterno: jest.fn(), getById: jest.fn() };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [ProductoController],
      providers: [{ provide: ProductoBussnies, useValue: servicio }],
    })
      .overrideGuard(JwtGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(OptionalJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = modulo.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    servicio.generarCodigoInterno.mockReset().mockResolvedValue({ codigo: '2000000000015' });
    servicio.getById.mockReset();
  });

  it('responde { codigo } y no lo confunde con la ruta :id', async () => {
    const r = await request(app.getHttpServer()).post('/producto/codigo-interno');
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ codigo: '2000000000015' });
    expect(servicio.generarCodigoInterno).toHaveBeenCalledTimes(1);
    expect(servicio.getById).not.toHaveBeenCalled();
  });

  it('usa los mismos guards y roles que el alta de producto', () => {
    const proto = ProductoController.prototype;
    const guards = (m: unknown) => Reflect.getMetadata('__guards__', m as object);
    const roles = (m: unknown) => Reflect.getMetadata('roles', m as object);
    expect(guards(proto.generarCodigoInterno)).toEqual(guards(proto.create));
    expect(guards(proto.generarCodigoInterno)).toEqual([JwtGuard, RolesGuard]);
    expect(roles(proto.generarCodigoInterno)).toBeDefined();
    expect(roles(proto.generarCodigoInterno)).toEqual(roles(proto.create));
  });

  it('si el negocio falla (secuencia ausente) propaga el 500 con el mensaje', async () => {
    servicio.generarCodigoInterno.mockRejectedValue(
      new InternalServerErrorException('Falta correr sql/codigo_interno_secuencia.sql'),
    );
    const r = await request(app.getHttpServer()).post('/producto/codigo-interno');
    expect(r.status).toBe(500);
    expect(r.body.message).toBe('Falta correr sql/codigo_interno_secuencia.sql');
  });
});
