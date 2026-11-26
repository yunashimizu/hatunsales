import { configLimitesDesdeEntorno, PoliticaLimites } from './politica-limites';

describe('PoliticaLimites · cubetas', () => {
  const politica = new PoliticaLimites(configLimitesDesdeEntorno());

  it('PUT /auth/perfil (cambia contraseña o correo) cae en la cubeta auth (B7)', () => {
    expect(politica.cubetaDe('PUT', '/auth/perfil')).toBe('auth');
    expect(politica.cubetaDe('put', '/Auth/Perfil/')).toBe('auth');
  });

  it('leer el perfil sigue en general', () => {
    expect(politica.cubetaDe('GET', '/auth/perfil')).toBe('general');
  });

  it('login, registro y Google siguen en auth', () => {
    for (const ruta of ['/auth/login', '/auth/register', '/auth/google', '/cliente/registro']) {
      expect(politica.cubetaDe('POST', ruta)).toBe('auth');
    }
  });

  it('POST /venta/autorizacion tiene su cubeta: 30 cada 5 minutos por IP, freno grueso (Fase 6.4)', () => {
    expect(politica.cubetaDe('POST', '/venta/autorizacion')).toBe('autorizacion');
    expect(politica.cubetaDe('post', '/Venta/Autorizacion/')).toBe('autorizacion');
    // Vender y la vista previa siguen en la general.
    expect(politica.cubetaDe('POST', '/venta')).toBe('general');
    expect(politica.cubetaDe('POST', '/venta/preview')).toBe('general');
    expect(politica.cubetaDe('GET', '/venta/autorizacion')).toBe('general');

    const consumos = politica.consumosPara({ metodo: 'POST', ruta: '/venta/autorizacion', ip: '::ffff:10.0.0.7', cuerpo: { email: 'a@b.pe', password: 'x' } });
    expect(consumos).toEqual([{ cubeta: 'autorizacion', clave: 'autorizacion|10.0.0.7', limite: 30, ventanaMs: 5 * 60_000 }]);
    // La contraseña ni el correo forman parte de la clave del contador.
    expect(JSON.stringify(consumos)).not.toContain('a@b.pe');
    expect(politica.mensaje('autorizacion', 120)).toBe('Demasiados intentos de autorización desde esta conexión. Intente de nuevo en 2 min.');
  });
});
