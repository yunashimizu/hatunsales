import { NotFoundException } from '@nestjs/common';
import { ArchivoController } from './archivo.controller';
import sharp from 'sharp';
import { createHash } from 'crypto';
import { RedimensionadorImagen } from '../../util/storage/redimensionador-imagen';

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

describe('ArchivoController · original y mejorada son dos archivos (mejora de fotos, §8 del plan)', () => {
  // Con el redimensionador de verdad y dos fotos de verdad: la mejorada es OTRA fila de `archivos`, con
  // otro id y otro hash, así que el navegador nunca puede servir una por la otra desde su caché.
  it('dos ids con contenidos distintos ⇒ ETag distintos y variantes ?w=480 distintas', async () => {
    const foto = (color: string) => sharp({ create: { width: 1200, height: 900, channels: 3, background: color } }).jpeg().toBuffer();
    const original = await foto('#8a5a2b');
    const mejorada = await foto('#c48a52');
    const porId: Record<string, { contenido: Buffer; mime: string; hash: string }> = {
      '41': { contenido: original, mime: 'image/jpeg', hash: createHash('sha256').update(original).digest('hex') },
      '57': { contenido: mejorada, mime: 'image/jpeg', hash: createHash('sha256').update(mejorada).digest('hex') },
    };
    const almacen = { leer: jest.fn(async (id: number) => porId[String(id)] ?? null) };
    const controlador = new ArchivoController(almacen as never, new RedimensionadorImagen());
    const pedir = async (id: string, w?: string) => {
      const r: any = { cabeceras: {} as Record<string, string>, enviado: undefined as unknown };
      r.setHeader = (n: string, v: string) => { r.cabeceras[n.toLowerCase()] = v; };
      r.status = () => r;
      r.end = () => undefined;
      r.send = (c: unknown) => { r.enviado = c; };
      await controlador.servir(id, '', r, w, 'image/webp');
      return r;
    };

    const [a, b, aw, bw] = [await pedir('41'), await pedir('57'), await pedir('41', '480'), await pedir('57', '480')];

    expect(a.cabeceras.etag).not.toBe(b.cabeceras.etag);
    expect(aw.cabeceras.etag).not.toBe(bw.cabeceras.etag);
    expect(aw.cabeceras.etag).toMatch(/-w480p"$/);
    expect(Buffer.compare(aw.enviado, bw.enviado)).not.toBe(0);
    expect((await sharp(aw.enviado).metadata()).width).toBe(480);
    // Pedir otra vez la variante de la original devuelve la misma (caché por huella), no la de la mejorada.
    const aw2 = await pedir('41', '480');
    expect(Buffer.compare(aw2.enviado, aw.enviado)).toBe(0);
  });
});
