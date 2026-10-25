import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CatalogoController } from './catalogo.controller';
import { CatalogoBussnies } from '../../../bussnies/Bussnies/tienda/catalogo.bussnies';
import { CuentaTiendaBussnies } from '../../../bussnies/Bussnies/tienda/cuenta.bussnies';
import { crearValidationPipe } from '../../../util/http/validacion/validation-pipe.factory';

/**
 * Catálogo público sin sesión (R11): un id o filtro que no es número responde
 * 400 antes de llegar a PostgreSQL (antes viajaba NaN y salía un 500).
 */
describe('CatalogoController (rutas públicas)', () => {
  let app: INestApplication;
  const servicio = {
    detalle: jest.fn(async (id: number) => ({ id_producto: id })),
    filtros: jest.fn(async () => ({ categorias: [], marcas: [], precio_min: 0, precio_max: 0, atributos: [] })),
    categorias: jest.fn(async () => []),
    marcas: jest.fn(async () => []),
    banners: jest.fn(async () => []),
    destacados: jest.fn(async () => []),
  };
  const cuenta = { listarResenas: jest.fn(async () => []) };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [CatalogoController],
      providers: [
        { provide: CatalogoBussnies, useValue: servicio },
        { provide: CuentaTiendaBussnies, useValue: cuenta },
      ],
    }).compile();

    app = modulo.createNestApplication();
    app.useGlobalPipes(crearValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  it.each(['/tienda/productos/abc', '/tienda/productos/-1', '/tienda/productos/1.5', '/tienda/productos/abc/resenas'])(
    '%s responde 400 sin consultar la BD',
    async (ruta) => {
      await request(app.getHttpServer()).get(ruta).expect(400);
      expect(servicio.detalle).not.toHaveBeenCalled();
      expect(cuenta.listarResenas).not.toHaveBeenCalled();
    },
  );

  it('un id válido llega como número', async () => {
    await request(app.getHttpServer()).get('/tienda/productos/12').expect(200);
    expect(servicio.detalle).toHaveBeenCalledWith(12);
  });

  it('filtros con id_categoria no numérico responde 400', async () => {
    await request(app.getHttpServer()).get('/tienda/filtros?id_categoria=abc').expect(400);
    expect(servicio.filtros).not.toHaveBeenCalled();
  });

  it('filtros sin categoría no filtra', async () => {
    await request(app.getHttpServer()).get('/tienda/filtros').expect(200);
    expect(servicio.filtros).toHaveBeenCalledWith(undefined);
  });

  it('el límite de destacados llega al servicio como número (el servicio lo topa)', async () => {
    await request(app.getHttpServer()).get('/tienda/productos/destacados?limite=100000').expect(200);
    expect(servicio.destacados).toHaveBeenCalledWith(100000);
  });

  it.each(['/tienda/categorias', '/tienda/marcas', '/tienda/banners'])(
    '%s se puede guardar 60 s en el navegador (no lleva stock ni precios)',
    async (ruta) => {
      const respuesta = await request(app.getHttpServer()).get(ruta).expect(200);
      expect(respuesta.headers['cache-control']).toBe('public, max-age=60');
    },
  );
});
