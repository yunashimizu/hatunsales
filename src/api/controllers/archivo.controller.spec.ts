import { NotFoundException } from '@nestjs/common';
import { ArchivoController } from './archivo.controller';

/** GET /archivos/:id es público y se sirve en el dominio de la API (B1). */
function armar(archivo: { contenido: Buffer; mime: string; hash: string } | null) {
  const almacen = { leer: jest.fn().mockResolvedValue(archivo) };
  const redimensionador = { variante: jest.fn().mockResolvedValue(null) };
  const cabeceras: Record<string, string> = {};
  const res = {
    cabeceras,
    estado: 200,
    enviado: undefined as unknown,
    setHeader: jest.fn((nombre: string, valor: string) => {
      cabeceras[nombre.toLowerCase()] = valor;
    }),
    status: jest.fn(function (this: any, codigo: number) {
      this.estado = codigo;
      return this;
    }),
    end: jest.fn(),
    send: jest.fn(function (this: any, cuerpo: unknown) {
      this.enviado = cuerpo;
    }),
  };
  return { controlador: new ArchivoController(almacen as never, redimensionador as never), almacen, redimensionador, res };
}

const HASH = 'a'.repeat(64);

describe('ArchivoController · GET /archivos/:id', () => {
  it('una imagen de la lista cerrada se sirve en línea, con su tipo, caché inmutable, ETag y sin ejecutar nada', async () => {
    const contenido = Buffer.from('jpeg');
    const { controlador, res } = armar({ contenido, mime: 'image/jpeg', hash: HASH });

    await controlador.servir('7', '', res as never);

    expect(res.cabeceras).toEqual({
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable',
      etag: `"${'a'.repeat(32)}"`,
    });
    expect(res.cabeceras['content-disposition']).toBeUndefined();
    expect(res.enviado).toBe(contenido);
  });

  it('un tipo fuera de la lista (SVG guardado antes del cierre) se descarga como binario, nunca en línea', async () => {
    const { controlador, res } = armar({ contenido: Buffer.from('<svg onload=alert(1)>'), mime: 'image/svg+xml', hash: HASH });

    await controlador.servir('8', '', res as never);

    expect(res.cabeceras['content-type']).toBe('application/octet-stream');
    expect(res.cabeceras['content-disposition']).toBe('attachment');
    expect(res.cabeceras['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.cabeceras['x-content-type-options']).toBe('nosniff');
  });

  it('con el mismo ETag responde 304 sin cuerpo', async () => {
    const { controlador, res } = armar({ contenido: Buffer.from('png'), mime: 'image/png', hash: HASH });

    await controlador.servir('7', `"${'a'.repeat(32)}"`, res as never);

    expect(res.status).toHaveBeenCalledWith(304);
    expect(res.end).toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('404 si no existe', async () => {
    const { controlador, res } = armar(null);
    await expect(controlador.servir('99', '', res as never)).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('?w= · miniaturas', () => {
    const original = Buffer.from('original-grande');
    const reducida = Buffer.from('reducida');

    it('con ?w=480 entrega la variante reducida, con su tipo, un ETag propio y Vary: Accept', async () => {
      const { controlador, redimensionador, res } = armar({ contenido: original, mime: 'image/jpeg', hash: HASH });
      redimensionador.variante.mockResolvedValue({ contenido: reducida, mime: 'image/webp' });

      await controlador.servir('7', '', res as never, '480', 'image/avif,image/webp,*/*');

      expect(redimensionador.variante).toHaveBeenCalledWith('a'.repeat(32), original, 'image/jpeg', 480, true);
      expect(res.enviado).toBe(reducida);
      expect(res.cabeceras['content-type']).toBe('image/webp');
      expect(res.cabeceras['etag']).toBe(`"${'a'.repeat(32)}-w480p"`);
      expect(res.cabeceras['vary']).toBe('Accept');
      // Las protecciones de siempre no se pierden con la variante.
      expect(res.cabeceras['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(res.cabeceras['x-content-type-options']).toBe('nosniff');
      expect(res.cabeceras['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('un ancho intermedio se ajusta al permitido y sin WebP se pide el formato original', async () => {
      const { controlador, redimensionador, res } = armar({ contenido: original, mime: 'image/png', hash: HASH });
      redimensionador.variante.mockResolvedValue({ contenido: reducida, mime: 'image/png' });

      await controlador.servir('7', '', res as never, '100', 'image/png');

      expect(redimensionador.variante).toHaveBeenCalledWith('a'.repeat(32), original, 'image/png', 160, false);
      expect(res.cabeceras['etag']).toBe(`"${'a'.repeat(32)}-w160o"`);
    });

    it('si el navegador ya tiene esa variante responde 304 sin volver a procesarla', async () => {
      const { controlador, redimensionador, res } = armar({ contenido: original, mime: 'image/jpeg', hash: HASH });

      await controlador.servir('7', `"${'a'.repeat(32)}-w480p"`, res as never, '480', 'image/webp');

      expect(res.status).toHaveBeenCalledWith(304);
      expect(redimensionador.variante).not.toHaveBeenCalled();
      expect(res.send).not.toHaveBeenCalled();
    });

    it('el ETag de la original no vale para una variante: se vuelve a servir', async () => {
      const { controlador, redimensionador, res } = armar({ contenido: original, mime: 'image/jpeg', hash: HASH });
      redimensionador.variante.mockResolvedValue({ contenido: reducida, mime: 'image/webp' });

      await controlador.servir('7', `"${'a'.repeat(32)}"`, res as never, '480', 'image/webp');

      expect(res.status).not.toHaveBeenCalledWith(304);
      expect(res.enviado).toBe(reducida);
    });

    it('si no se pudo reducir, sirve la original con su ETag de siempre', async () => {
      const { controlador, res } = armar({ contenido: original, mime: 'image/jpeg', hash: HASH });

      await controlador.servir('7', '', res as never, '480', 'image/webp');

      expect(res.enviado).toBe(original);
      expect(res.cabeceras['content-type']).toBe('image/jpeg');
      expect(res.cabeceras['etag']).toBe(`"${'a'.repeat(32)}"`);
    });

    it('un ancho inválido o mayor que el máximo entrega la original sin tocar el redimensionador', async () => {
      for (const valor of ['abc', '-3', '5000']) {
        const { controlador, redimensionador, res } = armar({ contenido: original, mime: 'image/jpeg', hash: HASH });
        await controlador.servir('7', '', res as never, valor, 'image/webp');
        expect(redimensionador.variante).not.toHaveBeenCalled();
        expect(res.enviado).toBe(original);
        expect(res.cabeceras['vary']).toBeUndefined();
      }
    });

    it('un archivo que no es imagen ignora ?w= y sigue descargándose como binario', async () => {
      const { controlador, redimensionador, res } = armar({ contenido: Buffer.from('<svg/>'), mime: 'image/svg+xml', hash: HASH });

      await controlador.servir('7', '', res as never, '480', 'image/webp');

      expect(redimensionador.variante).not.toHaveBeenCalled();
      expect(res.cabeceras['content-type']).toBe('application/octet-stream');
      expect(res.cabeceras['content-disposition']).toBe('attachment');
    });
  });
});
