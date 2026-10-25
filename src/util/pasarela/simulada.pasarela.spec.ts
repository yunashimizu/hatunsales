import { PasarelaSimulada } from './simulada.pasarela';

/**
 * La pasarela simulada está activa en producción mientras no haya llaves de
 * Culqi: ahí no puede aprobar cargos ni aceptar webhooks, porque no hay un cobro
 * real detrás. En desarrollo sigue permitiendo probar la tienda de punta a punta.
 */
const ENTORNO_ORIGINAL = { ...process.env };

const solicitud = {
  monto: 118,
  moneda: 'PEN',
  descripcion: 'Pedido PED-20261021-0007',
  email: 'cliente@correo.pe',
  token: 'tok_cualquiera',
  claveIdempotencia: 'pago-7',
};

afterEach(() => {
  process.env = { ...ENTORNO_ORIGINAL };
});

describe('PasarelaSimulada', () => {
  describe('en producción', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('nunca aprueba un cargo, llegue el token que llegue', async () => {
      const resultado = await new PasarelaSimulada().crearCargo(solicitud);
      expect(resultado.aprobado).toBe(false);
      expect(resultado.mensaje).toMatch(/no está habilitado/);
    });

    it('rechaza cualquier webhook: no hay firma que verificar', () => {
      const evento = new PasarelaSimulada().interpretarWebhook({ metadata: { id_pedido: 7 } });
      expect(evento.valido).toBe(false);
    });

    it('también reconoce producción por las variables de Railway', () => {
      process.env.NODE_ENV = 'development';
      process.env.RAILWAY_ENVIRONMENT = 'production';
      expect(new PasarelaSimulada().interpretarWebhook({}).valido).toBe(false);
    });
  });

  describe('en desarrollo', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
      delete process.env.RAILWAY_ENVIRONMENT;
      delete process.env.RAILWAY_ENVIRONMENT_NAME;
    });

    it('aprueba un cargo con token y rechaza los que empiezan con "rechazar"', async () => {
      const pasarela = new PasarelaSimulada();
      expect((await pasarela.crearCargo(solicitud)).aprobado).toBe(true);
      expect((await pasarela.crearCargo({ ...solicitud, token: 'rechazar-1' })).aprobado).toBe(false);
    });

    it('acepta el webhook de prueba con su monto y metadata', () => {
      const evento = new PasarelaSimulada().interpretarWebhook({ referencia: 'ch_1', monto: '118.00', metadata: { id_pedido: 7 } });
      expect(evento).toMatchObject({ valido: true, aprobado: true, monto: 118, referencia: 'ch_1', metadata: { id_pedido: 7 } });
    });
  });
});
