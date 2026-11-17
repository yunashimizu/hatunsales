import { NotFoundException } from '@nestjs/common';
import { ArchivoController } from './archivo.controller';

/** GET /archivos/:id es público y se sirve en el dominio de la API (B1). */
function armar(archivo: { contenido: Buffer; mime: string; hash: string } | null) {
  const almacen = { leer: jest.fn().mockResolvedValue(archivo) };
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
  return { controlador: new ArchivoController(almacen as never), almacen, res };
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
});
