import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { VentaBussnies } from '../../bussnies/Bussnies/venta.bussnies';
import { VentaDocumentosBussnies } from '../../bussnies/Bussnies/venta-documentos.bussnies';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { VentaController } from './venta.controller';

const PRODUCTO = { id_producto: 7, nombre: 'CEMENTO SOL', codigo_barras: 'AB/12?%3' };

describe('GET /venta/productos/barcode: código por query y por ruta', () => {
  let app: INestApplication<App>;
  const servicio = { buscarPorCodigoBarras: jest.fn() };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [VentaController],
      providers: [
        { provide: VentaBussnies, useValue: servicio },
        { provide: VentaDocumentosBussnies, useValue: {} },
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = modulo.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    servicio.buscarPorCodigoBarras.mockReset().mockResolvedValue(PRODUCTO);
  });

  it('la ruta con query entrega íntegro un código con / ? % # y +', async () => {
    const codigo = 'AB/12?%3#+x';
    const r = await request(app.getHttpServer())
      .get('/venta/productos/barcode')
      .query({ codigo, id_almacen: '4' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(PRODUCTO);
    expect(servicio.buscarPorCodigoBarras).toHaveBeenCalledWith(codigo, 4);
  });

  it('sin id_almacen o con uno inválido no pasa almacén', async () => {
    await request(app.getHttpServer()).get('/venta/productos/barcode').query({ codigo: '123' });
    await request(app.getHttpServer()).get('/venta/productos/barcode').query({ codigo: '123', id_almacen: 'abc' });
    expect(servicio.buscarPorCodigoBarras).toHaveBeenNthCalledWith(1, '123', undefined);
    expect(servicio.buscarPorCodigoBarras).toHaveBeenNthCalledWith(2, '123', undefined);
  });

  it('sin parámetro codigo delega con cadena vacía (el negocio responde 400)', async () => {
    await request(app.getHttpServer()).get('/venta/productos/barcode');
    expect(servicio.buscarPorCodigoBarras).toHaveBeenCalledWith('', undefined);
  });

  it('conserva la ruta anterior con el código en la URL', async () => {
    const r = await request(app.getHttpServer()).get('/venta/productos/barcode/7501234567890?id_almacen=2');
    expect(r.status).toBe(200);
    expect(servicio.buscarPorCodigoBarras).toHaveBeenCalledWith('7501234567890', 2);
  });
});
