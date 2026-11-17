import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { HashUtil } from '../util/jwt/hash.util';

/**
 * B3: el token lleva la huella (`pv`) de la contraseña con la que se emitió.
 * Al cambiarla, los tokens viejos mueren al instante y el nuevo entra al instante,
 * aunque la caché de 30 s todavía tenga la huella anterior.
 */
function armar(hashInicial = 'hash-viejo') {
  const usuario = { id_usuario: 1, nombre: 'Ana', email: 'ana@mail.com', estado: true, password: hashInicial, rol: { nombre: 'admin' } };
  const usuarioRepo = { findOne: jest.fn(async () => ({ ...usuario })) };
  const vwRepo = { find: jest.fn(async () => [{ permiso: 'ventas' }]) };
  const estrategia = new JwtStrategy(usuarioRepo as never, vwRepo as never);
  return { estrategia, usuario, usuarioRepo };
}

const token = (pv?: string) => ({ sub: 1, nombre: 'Ana', email: 'ana@mail.com', rol: 'admin', permisos: [], ...(pv ? { pv } : {}) });

describe('JwtStrategy · huella de la contraseña (B3)', () => {
  it('token con la huella vigente: entra y la segunda petición sale de la caché', async () => {
    const { estrategia, usuarioRepo } = armar();
    const pv = HashUtil.huella('hash-viejo');

    await expect(estrategia.validate(token(pv))).resolves.toMatchObject({ id_usuario: 1, rol: 'admin', permisos: ['ventas'] });
    await estrategia.validate(token(pv));

    expect(usuarioRepo.findOne).toHaveBeenCalledTimes(1);
  });

  it('token sin huella (emitido antes de esta versión): se acepta hasta que caduque', async () => {
    const { estrategia, usuario } = armar();

    await expect(estrategia.validate(token())).resolves.toMatchObject({ id_usuario: 1 });
    usuario.password = 'hash-nuevo';
    await expect(estrategia.validate(token())).resolves.toMatchObject({ id_usuario: 1 });
  });

  it('tras cambiar la contraseña: el token nuevo relee la base y entra; el viejo relee y es rechazado', async () => {
    const { estrategia, usuario, usuarioRepo } = armar();
    const pvViejo = HashUtil.huella('hash-viejo')!;
    const pvNuevo = HashUtil.huella('hash-nuevo')!;

    // Caché caliente con la huella vieja.
    await estrategia.validate(token(pvViejo));
    expect(usuarioRepo.findOne).toHaveBeenCalledTimes(1);

    usuario.password = 'hash-nuevo';

    // El token recién emitido no coincide con la caché: relee y entra al instante.
    await expect(estrategia.validate(token(pvNuevo))).resolves.toMatchObject({ id_usuario: 1 });
    expect(usuarioRepo.findOne).toHaveBeenCalledTimes(2);

    // El viejo ya no coincide con la caché (ahora nueva): relee y la base lo rechaza.
    await expect(estrategia.validate(token(pvViejo))).rejects.toThrow(
      new UnauthorizedException('La contraseña cambió. Inicie sesión de nuevo'),
    );
    expect(usuarioRepo.findOne).toHaveBeenCalledTimes(3);

    // El nuevo sigue saliendo de la caché.
    await estrategia.validate(token(pvNuevo));
    expect(usuarioRepo.findOne).toHaveBeenCalledTimes(3);
  });

  it('token viejo con la caché vacía: lo rechaza en la primera petición', async () => {
    const { estrategia } = armar('hash-nuevo');

    await expect(estrategia.validate(token(HashUtil.huella('hash-viejo')))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('cuenta desactivada o inexistente: 401 como antes', async () => {
    const { estrategia, usuarioRepo } = armar();
    usuarioRepo.findOne.mockResolvedValueOnce(null as never);

    await expect(estrategia.validate(token(HashUtil.huella('hash-viejo')))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
