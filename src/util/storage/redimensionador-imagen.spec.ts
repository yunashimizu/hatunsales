import sharp from 'sharp';
import { ANCHOS_IMAGEN, RedimensionadorImagen, anchoSolicitado, medirImagen, sePuedeRedimensionar } from './redimensionador-imagen';

/** Imágenes reales generadas con la misma librería: así se prueba el recorte de verdad, no un doble. */
async function jpeg(ancho: number, alto: number): Promise<Buffer> {
  return sharp({ create: { width: ancho, height: alto, channels: 3, background: '#b8975a' } }).jpeg().toBuffer();
}

async function png(ancho: number, alto: number): Promise<Buffer> {
  return sharp({ create: { width: ancho, height: alto, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 0.5 } } }).png().toBuffer();
}

describe('anchoSolicitado · lista cerrada de anchos', () => {
  it('un ancho de la lista se respeta', () => {
    for (const ancho of ANCHOS_IMAGEN) expect(anchoSolicitado(ancho)).toBe(ancho);
    expect(anchoSolicitado('480')).toBe(480);
  });

  it('un valor intermedio sube al ancho permitido más cercano', () => {
    expect(anchoSolicitado(100)).toBe(160);
    expect(anchoSolicitado(161)).toBe(320);
    expect(anchoSolicitado('700')).toBe(800);
    expect(anchoSolicitado(1201)).toBe(1600);
  });

  it('lo que no sirve (vacío, texto, cero, negativo o mayor que el máximo) pide la original', () => {
    for (const valor of [undefined, null, '', 'abc', 0, -5, 'NaN', 1601, 99999]) {
      expect(anchoSolicitado(valor)).toBeNull();
    }
  });
});

describe('sePuedeRedimensionar', () => {
  it('JPEG, PNG, WebP y AVIF sí; el GIF no (perdería la animación)', () => {
    expect(sePuedeRedimensionar('image/jpeg')).toBe(true);
    expect(sePuedeRedimensionar('IMAGE/PNG')).toBe(true);
    expect(sePuedeRedimensionar('image/gif')).toBe(false);
    expect(sePuedeRedimensionar('image/svg+xml')).toBe(false);
  });
});

describe('RedimensionadorImagen.variante', () => {
  it('reduce al ancho pedido conservando la proporción y entrega WebP si el navegador lo acepta', async () => {
    const original = await jpeg(2000, 1000);
    const resultado = await new RedimensionadorImagen().variante('h1', original, 'image/jpeg', 480, true);

    expect(resultado?.mime).toBe('image/webp');
    const meta = await sharp(resultado!.contenido).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(480);
    expect(meta.height).toBe(240);
    expect(resultado!.contenido.length).toBeLessThan(original.length);
  });

  it('sin soporte de WebP entrega JPEG, y un PNG sigue siendo PNG (puede tener transparencia)', async () => {
    const reductor = new RedimensionadorImagen();

    const deJpeg = await reductor.variante('h2', await jpeg(1200, 600), 'image/jpeg', 320, false);
    expect(deJpeg?.mime).toBe('image/jpeg');
    expect((await sharp(deJpeg!.contenido).metadata()).width).toBe(320);

    const dePng = await reductor.variante('h3', await png(900, 900), 'image/png', 320, false);
    expect(dePng?.mime).toBe('image/png');
    expect((await sharp(dePng!.contenido).metadata()).hasAlpha).toBe(true);
  });

  it('nunca agranda una foto que ya es más chica que lo pedido', async () => {
    const resultado = await new RedimensionadorImagen().variante('h4', await jpeg(100, 50), 'image/jpeg', 800, true);

    expect((await sharp(resultado!.contenido).metadata()).width).toBe(100);
  });

  it('la segunda vez sale de la caché: es el mismo objeto, sin volver a procesar', async () => {
    const reductor = new RedimensionadorImagen();
    const original = await jpeg(1600, 800);

    const primera = await reductor.variante('h5', original, 'image/jpeg', 480, true);
    const segunda = await reductor.variante('h5', original, 'image/jpeg', 480, true);

    expect(segunda).toBe(primera);
  });

  it('el mismo contenido en otro ancho o formato no se confunde con el anterior', async () => {
    const reductor = new RedimensionadorImagen();
    const original = await jpeg(1600, 800);

    const a = await reductor.variante('h6', original, 'image/jpeg', 480, true);
    const b = await reductor.variante('h6', original, 'image/jpeg', 800, true);
    const c = await reductor.variante('h6', original, 'image/jpeg', 480, false);

    expect(b).not.toBe(a);
    expect(c?.mime).toBe('image/jpeg');
    expect(a?.mime).toBe('image/webp');
  });

  it('dos pedidos iguales al mismo tiempo comparten un solo trabajo', async () => {
    const reductor = new RedimensionadorImagen();
    const original = await jpeg(1600, 800);

    const [uno, dos] = await Promise.all([
      reductor.variante('h7', original, 'image/jpeg', 320, true),
      reductor.variante('h7', original, 'image/jpeg', 320, true),
    ]);

    expect(dos).toBe(uno);
  });

  it('un GIF o un archivo dañado devuelve null (se sirve la original) y no lanza error', async () => {
    const reductor = new RedimensionadorImagen();

    await expect(reductor.variante('h8', Buffer.from('GIF89a'), 'image/gif', 480, true)).resolves.toBeNull();
    await expect(reductor.variante('h9', Buffer.from('esto no es una imagen'), 'image/jpeg', 480, true)).resolves.toBeNull();
  });
});

describe('medirImagen', () => {
  it('devuelve el ancho y el alto reales', async () => {
    await expect(medirImagen(await jpeg(300, 200))).resolves.toEqual({ width: 300, height: 200 });
  });

  it('una foto de celular girada de lado (EXIF 6) se mide como se ve: ancho y alto intercambiados', async () => {
    const girada = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#fff' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    await expect(medirImagen(girada)).resolves.toEqual({ width: 100, height: 200 });
  });

  it('un archivo que no es imagen no es un error: no hay medidas', async () => {
    await expect(medirImagen(Buffer.from('texto'))).resolves.toEqual({});
  });
});
