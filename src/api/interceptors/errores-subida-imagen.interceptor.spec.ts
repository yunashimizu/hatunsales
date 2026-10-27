import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { lastValueFrom, throwError } from 'rxjs';
import { ErroresSubidaImagenInterceptor, traducirErrorSubidaImagen } from './errores-subida-imagen.interceptor';

/** Lo que hace Nest con un MulterError antes de que llegue a cualquier filtro. */
const comoNest = {
  tamano: () => new PayloadTooLargeException('File too large'),
  campo: () => new BadRequestException('Unexpected field - files'),
  cantidad: () => new BadRequestException('Too many files'),
};

const mensajeDe = (e: unknown) => (e as BadRequestException).getResponse() as any;

describe('traducirErrorSubidaImagen', () => {
  it('LIMIT_FILE_SIZE → 400 «La foto supera 5 MB»', () => {
    const e = traducirErrorSubidaImagen(comoNest.tamano(), true) as BadRequestException;
    expect(e.getStatus()).toBe(400);
    expect(mensajeDe(e)).toMatchObject({ message: 'La foto supera 5 MB', codigo: 'FOTO_MUY_GRANDE' });
  });

  it('LIMIT_UNEXPECTED_FILE y LIMIT_FILE_COUNT en el lote → 400 «Máximo 10 fotos por vez»', () => {
    for (const error of [comoNest.campo(), comoNest.cantidad()]) {
      const e = traducirErrorSubidaImagen(error, true) as BadRequestException;
      expect(e.getStatus()).toBe(400);
      expect(mensajeDe(e)).toMatchObject({ message: 'Máximo 10 fotos por vez', codigo: 'DEMASIADAS_FOTOS' });
    }
  });

  it('en la subida de una sola foto, un campo inesperado no habla de 10 fotos', () => {
    const e = traducirErrorSubidaImagen(comoNest.campo(), false) as BadRequestException;
    expect(e.getStatus()).toBe(400);
    expect(mensajeDe(e).message).toBe('Envíe una sola foto por vez');
  });

  it('deja pasar el resto de errores tal cual', () => {
    const validacion = new BadRequestException('Producto inválido');
    const noEncontrado = new NotFoundException('Imagen no encontrada');
    const interno = new Error('boom');
    expect(traducirErrorSubidaImagen(validacion, true)).toBe(validacion);
    expect(traducirErrorSubidaImagen(noEncontrado, true)).toBe(noEncontrado);
    expect(traducirErrorSubidaImagen(interno, true)).toBe(interno);
  });
});

describe('ErroresSubidaImagenInterceptor', () => {
  const contexto = (url: string) => ({ switchToHttp: () => ({ getRequest: () => ({ originalUrl: url }) }) }) as any;

  it('traduce según la ruta: lote vs. una sola foto', async () => {
    const interceptor = new ErroresSubidaImagenInterceptor();
    const lote = interceptor.intercept(contexto('/producto/3/images/lote'), { handle: () => throwError(() => comoNest.cantidad()) });
    await expect(lastValueFrom(lote)).rejects.toMatchObject({ status: 400, response: { message: 'Máximo 10 fotos por vez' } });

    const una = interceptor.intercept(contexto('/producto/3/images/5/archivo'), { handle: () => throwError(() => comoNest.campo()) });
    await expect(lastValueFrom(una)).rejects.toMatchObject({ status: 400, response: { message: 'Envíe una sola foto por vez' } });
  });
});
