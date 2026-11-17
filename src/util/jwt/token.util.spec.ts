import { TokenUtil } from './token.util';

/** B7: la cookie de sesión es `secure` en producción aunque falte NODE_ENV=production (Railway). */
describe('TokenUtil.cookieOptions · secure', () => {
  const variables = ['NODE_ENV', 'COOKIE_SECURE', 'RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_NAME'] as const;
  const originales: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of variables) {
      originales[v] = process.env[v];
      delete process.env[v];
    }
  });
  afterEach(() => {
    for (const v of variables) {
      if (originales[v] === undefined) delete process.env[v];
      else process.env[v] = originales[v];
    }
  });

  it('en local (sin variables) no es secure, para no romper http://localhost', () => {
    expect(TokenUtil.cookieOptions('admin').secure).toBe(false);
  });

  it('en Railway sin NODE_ENV es secure', () => {
    process.env.RAILWAY_ENVIRONMENT = 'production';
    expect(TokenUtil.cookieOptions('admin').secure).toBe(true);
  });

  it('NODE_ENV=production y COOKIE_SECURE=true siguen valiendo', () => {
    process.env.NODE_ENV = 'production';
    expect(TokenUtil.cookieOptions('cliente').secure).toBe(true);
    delete process.env.NODE_ENV;
    process.env.COOKIE_SECURE = 'true';
    expect(TokenUtil.cookieOptions('cliente')).toMatchObject({ secure: true, httpOnly: true, sameSite: 'lax' });
  });
});
