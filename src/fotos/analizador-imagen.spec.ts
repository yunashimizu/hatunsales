import { analizarImagen, AnalisisImagen } from './analizador-imagen';
import { decidirReceta } from './receta-mejora';
import { animada, cajaFiguraEnBorde, enorme, generarMuestras, MuestrasPrueba } from './muestras-prueba';

/**
 * Con píxeles de verdad: las muestras se generan en memoria (muestras-prueba.ts) con las mismas
 * degradaciones del experimento del plan, y se comprueba que la medida separa cada defecto y que la
 * receta dispara su acción y solo esa.
 */
jest.setTimeout(60_000);

let m: MuestrasPrueba;
const analisis: Record<string, AnalisisImagen> = {};

beforeAll(async () => {
  m = await generarMuestras();
  for (const [nombre, buffer] of Object.entries(m)) analisis[nombre] = await analizarImagen(buffer);
});

const acciones = (nombre: string) => decidirReceta(analisis[nombre]).acciones;

describe('analizarImagen · medidas', () => {
  it('la foto buena mide nítida, bien expuesta, con fondo liso y el sujeto ocupando el cuadro', () => {
    const a = analisis.buena;
    expect([a.ancho, a.alto]).toEqual([1200, 900]);
    const d = a.medidas!;
    expect(d.agudeza).toBeGreaterThanOrEqual(0.36);
    expect(d.p99).toBeGreaterThanOrEqual(150);
    expect(d.p1).toBeLessThan(60);
    expect(d.fondo.uniformidad).toBeGreaterThanOrEqual(0.9);
    expect(d.ocupacion).toBeGreaterThan(0.55);
    expect(d.ruido).toBeLessThan(5);
  });

  it('la agudeza separa lo suave (0,18–0,36) de lo muy borroso (< 0,18) y no cambia al oscurecer o lavar', () => {
    const buena = analisis.buena.medidas!.agudeza;
    expect(analisis.desenfocada.medidas!.agudeza).toBeGreaterThanOrEqual(0.18);
    expect(analisis.desenfocada.medidas!.agudeza).toBeLessThan(0.36);
    expect(analisis.muyBorrosa.medidas!.agudeza).toBeLessThan(0.18);
    expect(Math.abs(analisis.oscura.medidas!.agudeza - buena)).toBeLessThan(0.05);
    expect(Math.abs(analisis.lavada.medidas!.agudeza - buena)).toBeLessThan(0.05);
  });

  it('luz y contraste: la oscura tiene p99 < 150 y la lavada p1 ≥ 60', () => {
    expect(analisis.oscura.medidas!.p99).toBeLessThan(150);
    expect(analisis.lavada.medidas!.p1).toBeGreaterThanOrEqual(60);
    expect(analisis.lavada.medidas!.p99 - analisis.lavada.medidas!.p1).toBeLessThan(150);
  });

  it('el grano fuerte se mide (≥ 11) y la buena casi no tiene', () => {
    expect(analisis.ruidoFuerte.medidas!.ruido).toBeGreaterThanOrEqual(11);
  });

  it('borde vacío: la caja del sujeto cae a ±2 % de la real', () => {
    const real = cajaFiguraEnBorde();
    const d = analisis.borde.medidas!;
    expect(d.ocupacion).toBeLessThan(0.55);
    for (const lado of ['x0', 'x1', 'y0', 'y1'] as const) expect(Math.abs(d.caja[lado] - real[lado])).toBeLessThanOrEqual(0.02);
  });

  it('EXIF 6: las medidas son las de la foto ya girada', () => {
    const a = analisis.exif6;
    expect(a.orientacion).toBe(6);
    expect([a.ancho, a.alto]).toEqual([1200, 900]);
    const real = cajaFiguraEnBorde();
    const d = analisis.exif6Borde.medidas!;
    for (const lado of ['x0', 'x1', 'y0', 'y1'] as const) expect(Math.abs(d.caja[lado] - real[lado])).toBeLessThanOrEqual(0.02);
  });

  it('PNG con transparencia ⇒ alfa y sin decodificar; un PNG con canal alfa pero opaco se mide normal', () => {
    expect(analisis.transparente.alfa).toBe(true);
    expect(analisis.transparente.medidas).toBeNull();
    expect(analisis.pngOpaco.alfa).toBe(false);
    expect(analisis.pngOpaco.medidas).not.toBeNull();
  });

  it('más de 25 Mpx ⇒ no se decodifica (sin medidas) y responde enseguida', async () => {
    const grande = await enorme();
    const inicio = Date.now();
    const a = await analizarImagen(grande);
    expect(a.pixeles).toBeGreaterThan(25_000_000);
    expect(a.medidas).toBeNull();
    expect(Date.now() - inicio).toBeLessThan(500);
    expect(decidirReceta(a).omitida).toBe('demasiado_grande');
  });

  it('animada ⇒ sin decodificar y omitida', async () => {
    const a = await analizarImagen(await animada());
    expect(a.paginas).toBeGreaterThan(1);
    expect(a.medidas).toBeNull();
    expect(decidirReceta(a).omitida).toBe('animada');
  });

  it('un archivo que no es imagen lanza (el servicio lo captura y publica el original)', async () => {
    await expect(analizarImagen(Buffer.from('no es una imagen'))).rejects.toThrow();
  });
});

describe('analizarImagen + decidirReceta · cada defecto dispara su acción y solo esa', () => {
  it('buena, EXIF 6 y PNG opaco ⇒ sin cambios', () => {
    for (const nombre of ['buena', 'exif6', 'pngOpaco']) {
      const r = decidirReceta(analisis[nombre]);
      expect({ nombre, cambia: r.cambia, avisos: r.avisos }).toEqual({ nombre, cambia: false, avisos: [] });
    }
  });

  it('desenfoque σ 1,2 ⇒ ENFOQUE «medio»', () => {
    const r = decidirReceta(analisis.desenfocada);
    expect(r.acciones).toEqual(['ENFOQUE']);
    expect(r.enfoque).toBe('medio');
  });

  it('desenfoque σ 2,5 ⇒ ENFOQUE y aviso BORROSA', () => {
    const r = decidirReceta(analisis.muyBorrosa);
    expect(r.acciones).toEqual(['ENFOQUE']);
    expect(r.avisos).toEqual(['BORROSA']);
  });

  it('oscura ⇒ ACLARAR (ganancia ≤ 2,5); lavada ⇒ CONTRASTE (ganancia ≤ 2,0)', () => {
    const o = decidirReceta(analisis.oscura);
    expect(o.acciones).toEqual(['ACLARAR']);
    expect(o.lineal!.a[0]).toBeLessThanOrEqual(2.5);
    const l = decidirReceta(analisis.lavada);
    expect(l.acciones).toEqual(['CONTRASTE']);
    expect(l.lineal!.a[0]).toBeLessThanOrEqual(2.0);
  });

  it('ruido fuerte ⇒ RUIDO y ningún enfoque', () => {
    const r = decidirReceta(analisis.ruidoFuerte);
    expect(r.acciones).toEqual(['RUIDO']);
    expect(r.enfoque).toBeUndefined();
  });

  it('borde ⇒ RECORTE; 240 px ⇒ AMPLIAR ×2 con aviso MUY_CHICA', () => {
    expect(acciones('borde')).toEqual(['RECORTE']);
    expect(acciones('exif6Borde')).toEqual(['RECORTE']);
    const chica = decidirReceta(analisis.chica240);
    expect(chica.acciones).toEqual(['AMPLIAR']);
    expect(chica.escala).toBe(2);
    expect(chica.avisos).toEqual(['MUY_CHICA']);
  });

  it('transparencia ⇒ omitida', () => {
    expect(decidirReceta(analisis.transparente).omitida).toBe('transparencia');
  });
});
