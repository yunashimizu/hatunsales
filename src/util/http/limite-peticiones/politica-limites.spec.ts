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
});
