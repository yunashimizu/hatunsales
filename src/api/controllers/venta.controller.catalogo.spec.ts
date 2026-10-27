import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { VentaBussnies } from '../../bussnies/Bussnies/venta.bussnies';
import { VentaDocumentosBussnies } from '../../bussnies/Bussnies/venta-documentos.bussnies';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { crearMiddlewareCompresion } from '../../util/http/compresion';
import { VentaController } from './venta.controller';

const RUTA = '/venta/productos/catalogo';
const CATALOGO = Array.from({ length: 300 }, (_, i) => ({ id_producto: i + 1, nombre: `Producto ${i + 1}`, precio_venta: 12.5, stock: 40 }));

describe('GET /venta/productos/catalogo: revalidación con ETag (D14)', () => {
  let app: INestApplication<App>;
  const servicio = { catalogoProductos: jest.fn() };

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
    app.use(crearMiddlewareCompresion()); // como en main.ts
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    servicio.catalogoProductos.mockReset().mockResolvedValue(CATALOGO);
  });

  it('responde el catálogo con Cache-Control private, no-cache (sin max-age) y un ETag', async () => {
    const r = await request(app.getHttpServer()).get(RUTA);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('private, no-cache');
    expect(r.headers['etag']).toMatch(/^W\/".+"$/);
    expect(r.body).toEqual(CATALOGO);
  });

  it('con el mismo ETag en If-None-Match responde 304 sin cuerpo', async () => {
    const primera = await request(app.getHttpServer()).get(RUTA);
    const segunda = await request(app.getHttpServer()).get(RUTA).set('If-None-Match', primera.headers['etag']);
    expect(segunda.status).toBe(304);
    expect(segunda.text ?? '').toBe('');
  });

  it('si cambió el stock o el precio, el ETag ya no coincide y responde 200 con el catálogo nuevo', async () => {
    const primera = await request(app.getHttpServer()).get(RUTA);
    servicio.catalogoProductos.mockResolvedValue([{ ...CATALOGO[0], stock: 39 }, ...CATALOGO.slice(1)]);
    const segunda = await request(app.getHttpServer()).get(RUTA).set('If-None-Match', primera.headers['etag']);
    expect(segunda.status).toBe(200);
    expect(segunda.headers['etag']).not.toBe(primera.headers['etag']);
    expect((segunda.body as typeof CATALOGO)[0].stock).toBe(39);
  });

  it('comprimido con gzip conserva el ETag y el 304', async () => {
    const primera = await request(app.getHttpServer()).get(RUTA).set('Accept-Encoding', 'gzip');
    expect(primera.headers['content-encoding']).toBe('gzip');
    expect(primera.headers['etag']).toBeDefined();
    const segunda = await request(app.getHttpServer())
      .get(RUTA)
      .set('Accept-Encoding', 'gzip')
      .set('If-None-Match', primera.headers['etag']);
    expect(segunda.status).toBe(304);
  });

  it('sigue pasando limite e id_almacen al negocio', async () => {
    await request(app.getHttpServer()).get(`${RUTA}?limite=50&id_almacen=3`);
    expect(servicio.catalogoProductos).toHaveBeenCalledWith(50, 3);
  });
});
