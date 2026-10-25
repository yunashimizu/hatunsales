import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtGuard } from '../../guards/jwt.guard';
import { ROLES_KEY } from '../../guards/roles.decorator';
import { crearValidationPipe } from '../../util/http/validacion/validation-pipe.factory';
import { UBIGEOS_INEI } from './ubigeo-inei';
import { UbigeoController } from './ubigeo.controller';
import { normalizarTextoUbigeo, UbigeoService } from './ubigeo.service';

describe('Catálogo de ubigeos INEI', () => {
  const servicio = new UbigeoService();

  it('trae los distritos del INEI, sin códigos repetidos y con 6 dígitos', () => {
    expect(UBIGEOS_INEI.length).toBeGreaterThan(1850);
    expect(UBIGEOS_INEI.length).toBeLessThan(1950);
    const codigos = UBIGEOS_INEI.map(([codigo]) => codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
    expect(codigos.every((c) => /^\d{6}$/.test(c))).toBe(true);
    expect(new Set(codigos.map((c) => c.slice(0, 2))).size).toBe(25);
  });

  it.each([
    ['150101', 'LIMA', 'LIMA', 'LIMA'],
    ['150122', 'LIMA', 'LIMA', 'MIRAFLORES'],
    ['150119', 'LIMA', 'LIMA', 'LURIN'],
    ['150132', 'LIMA', 'LIMA', 'SAN JUAN DE LURIGANCHO'],
    ['040101', 'AREQUIPA', 'AREQUIPA', 'AREQUIPA'],
    ['080101', 'CUSCO', 'CUSCO', 'CUSCO'],
    ['130101', 'LA LIBERTAD', 'TRUJILLO', 'TRUJILLO'],
  ])('código de control INEI %s = %s / %s / %s', (codigo, departamento, provincia, distrito) => {
    expect(servicio.obtener(codigo)).toMatchObject({ codigo, departamento, provincia, distrito });
  });

  it('no son los códigos del RENIEC (Lima 140101, Cusco 070101, Trujillo 120101)', () => {
    expect(servicio.obtener('140101')?.distrito).not.toBe('LIMA');
    expect(servicio.obtener('070101')?.distrito).not.toBe('CUSCO');
    expect(servicio.obtener('120101')?.distrito).not.toBe('TRUJILLO');
  });

  it('busca sin tildes ni mayúsculas y pone primero el distrito que coincide', () => {
    expect(servicio.buscar('lurín')[0]).toMatchObject({ codigo: '150119', texto: 'LURIN - LIMA - LIMA' });
    expect(servicio.buscar('  San Juan de Lurigancho ')[0].codigo).toBe('150132');
    expect(servicio.buscar('miraflores lima')[0].codigo).toBe('150122');
    expect(servicio.buscar('lima')[0].codigo).toBe('150101');
    // La Ñ se busca también con N.
    expect(servicio.buscar('nepena').map((u) => u.distrito)).toContain('NEPEÑA');
  });

  it('por código (o su inicio), con un máximo de 20 resultados y al menos 3 caracteres', () => {
    const lima = servicio.buscar('1501');
    expect(lima).toHaveLength(20);
    expect(lima[0].codigo).toBe('150101');
    expect(lima.every((u) => u.codigo.startsWith('1501'))).toBe(true);
    expect(servicio.buscar('150119').map((u) => u.codigo)).toEqual(['150119']);
    expect(servicio.buscar('li')).toEqual([]);
    expect(servicio.buscar('san', 50).length).toBe(20);
  });

  it('nombres exactos, texto legible y normalización', () => {
    expect(servicio.porNombres('Lima', 'Lima', 'Lurín')?.codigo).toBe('150119');
    expect(servicio.porNombres('LIMA', 'LIMA', 'NO EXISTE')).toBeNull();
    expect(servicio.textoLegible('150119')).toBe('150119 - LURIN - LIMA - LIMA');
    expect(servicio.textoLegible('999999')).toBe('999999');
    expect(servicio.existe('15011')).toBe(false);
    expect(normalizarTextoUbigeo('Quisqui (Kichki)')).toBe('QUISQUI KICHKI');
  });

  describe('HTTP /ubigeo', () => {
    let app: INestApplication;

    beforeAll(async () => {
      const modulo = await Test.createTestingModule({
        controllers: [UbigeoController],
        providers: [{ provide: UbigeoService, useValue: servicio }],
      })
        .overrideGuard(JwtGuard)
        .useValue({
          canActivate: (contexto: ExecutionContext) => {
            contexto.switchToHttp().getRequest().user = { id_usuario: 1, rol: 'caja' };
            return true;
          },
        })
        .compile();
      app = modulo.createNestApplication();
      app.useGlobalPipes(crearValidationPipe());
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it('lectura para admin, vendedor y caja', () => {
      expect(Reflect.getMetadata(ROLES_KEY, UbigeoController)).toEqual(['admin', 'vendedor', 'caja']);
    });

    it('GET /ubigeo?q= devuelve los distritos; con menos de 3 caracteres responde 400 en español', async () => {
      const ok = await request(app.getHttpServer()).get('/ubigeo').query({ q: 'lurin' }).expect(200);
      expect(ok.body[0]).toMatchObject({ codigo: '150119', distrito: 'LURIN' });
      const corta = await request(app.getHttpServer()).get('/ubigeo').query({ q: 'lu' }).expect(400);
      expect(JSON.stringify(corta.body.message)).toContain('al menos 3');
    });

    it('GET /ubigeo/:codigo: 400 si no tiene 6 dígitos y 404 si no existe', async () => {
      const miraflores = await request(app.getHttpServer()).get('/ubigeo/150122').expect(200);
      expect(miraflores.body.distrito).toBe('MIRAFLORES');
      await request(app.getHttpServer()).get('/ubigeo/15012').expect(400);
      await request(app.getHttpServer()).get('/ubigeo/999999').expect(404);
    });
  });
});
