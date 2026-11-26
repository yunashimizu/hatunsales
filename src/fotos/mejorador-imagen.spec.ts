import sharp from 'sharp';
import { aplicarReceta, aplicarYVerificar, mejorarImagen, recorteSinGirar, verificarMejora } from './mejorador-imagen';
import type { RecetaMejora } from './receta-mejora';
import { UMBRALES_MEJORA } from './umbrales-mejora';
import { animada, CAJA_FIGURA, enorme, escalon, figuraBase, generarMuestras, MuestrasPrueba, ZONA_PIEZA } from './muestras-prueba';

jest.setTimeout(60_000);

let m: MuestrasPrueba;
beforeAll(async () => {
  m = await generarMuestras();
});

/** Color medio de una zona (en la imagen ya girada), escalando la zona si la imagen cambió de tamaño. */
async function colorMedio(buffer: Buffer, zona: { left: number; top: number; width: number; height: number }, escala = 1) {
  const z = { left: Math.round(zona.left * escala), top: Math.round(zona.top * escala), width: Math.round(zona.width * escala), height: Math.round(zona.height * escala) };
  // Se toma el centro de la zona: los bordes se mezclan con lo de al lado.
  const centro = { left: z.left + Math.round(z.width * 0.2), top: z.top + Math.round(z.height * 0.2), width: Math.round(z.width * 0.6), height: Math.round(z.height * 0.6) };
  const { channels } = await sharp(buffer).rotate().extract(centro).stats();
  return { r: channels[0].mean, g: channels[1].mean, b: channels[2].mean };
}

const recetaSolo = (cambios: Partial<RecetaMejora>, ancho: number, alto: number): RecetaMejora => ({
  cambia: true, acciones: [], avisos: [], escala: 1, anchoSalida: ancho, altoSalida: alto, ...cambios,
});

describe('mejorarImagen · una foto buena no se toca', () => {
  it('foto nítida y bien expuesta ⇒ «sin_cambios» y sin archivo nuevo (se publica la original byte a byte)', async () => {
    const r = await mejorarImagen(m.buena);
    expect(r.estado).toBe('sin_cambios');
    expect(r.mejorada).toBeUndefined();
    expect(r.motivo).toBeUndefined();
  });

  it('con EXIF 6 también queda igual', async () => {
    expect((await mejorarImagen(m.exif6)).estado).toBe('sin_cambios');
  });
});

describe('mejorarImagen · correcciones', () => {
  it('borde vacío ⇒ recorta al sujeto y el resultado es JPEG con las medidas del recorte', async () => {
    const r = await mejorarImagen(m.borde);
    expect(r.estado).toBe('mejorada');
    expect(r.receta.acciones).toEqual(['RECORTE']);
    const meta = await sharp(r.mejorada!.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([r.receta.recorte!.width, r.receta.recorte!.height]);
    expect(r.despues!.ocupacion).toBeGreaterThan(0.7);
  });

  it('EXIF 6 + borde: el recorte se calcula girado y cae sobre el sujeto (igual que sin EXIF)', async () => {
    const sinExif = await mejorarImagen(m.borde);
    const conExif = await mejorarImagen(m.exif6Borde);
    expect(conExif.estado).toBe('mejorada');
    expect([conExif.mejorada!.ancho, conExif.mejorada!.alto]).toEqual([sinExif.mejorada!.ancho, sinExif.mejorada!.alto]);
    // Mismo contenido: diferencia media por píxel pequeña (solo la de recomprimir dos veces).
    const a = await sharp(sinExif.mejorada!.buffer).raw().toBuffer();
    const b = await sharp(conExif.mejorada!.buffer).raw().toBuffer();
    let suma = 0;
    for (let i = 0; i < a.length; i++) suma += a[i] > b[i] ? a[i] - b[i] : b[i] - a[i];
    expect(suma / a.length).toBeLessThan(3);
    expect(conExif.despues!.ocupacion).toBeGreaterThan(0.7);
  });

  it('desenfoque σ 1,2 ⇒ la agudeza sube', async () => {
    const r = await mejorarImagen(m.desenfocada);
    expect(r.estado).toBe('mejorada');
    expect(r.despues!.agudeza).toBeGreaterThan(r.analisis.medidas!.agudeza + 0.05);
  });

  it('240 px ⇒ ampliada ×2', async () => {
    const r = await mejorarImagen(m.chica240);
    expect(r.estado).toBe('mejorada');
    expect([r.mejorada!.ancho, r.mejorada!.alto]).toEqual([480, 360]);
  });

  it('ruido fuerte ⇒ la mediana baja el grano y no se enfoca', async () => {
    const r = await mejorarImagen(m.ruidoFuerte);
    expect(r.estado).toBe('mejorada');
    expect(r.receta.enfoque).toBeUndefined();
    expect(r.despues!.ruido!).toBeLessThan(r.analisis.medidas!.ruido! * 0.7);
  });

  it('color: tras ACLARAR y CONTRASTE la pieza naranja vuelve a su tono (R/G y B/G a menos de un 3 % de la foto buena)', async () => {
    const real = await colorMedio(m.buena, ZONA_PIEZA);
    for (const nombre of ['oscura', 'lavada'] as const) {
      const r = await mejorarImagen(m[nombre]);
      expect(r.estado).toBe('mejorada');
      const c = await colorMedio(r.mejorada!.buffer, ZONA_PIEZA);
      expect(Math.abs(c.r / c.g / (real.r / real.g) - 1)).toBeLessThan(0.03);
      expect(Math.abs(c.b / c.g / (real.b / real.g) - 1)).toBeLessThan(0.03);
    }
  });

  it('color: la ganancia de niveles es la misma en los tres canales (el tono del color plano no gira)', async () => {
    const antes = await colorMedio(m.oscura, ZONA_PIEZA);
    const r = await mejorarImagen(m.oscura);
    const despues = await colorMedio(r.mejorada!.buffer, ZONA_PIEZA);
    expect(Math.abs(despues.r / despues.g / (antes.r / antes.g) - 1)).toBeLessThan(0.03);
    expect(Math.abs(despues.b / despues.g / (antes.b / antes.g) - 1)).toBeLessThan(0.03);
  });

  it('halo: en un escalón 60 → 200 el enfoque «medio» no se pasa más de 14 niveles', async () => {
    const png = await escalon();
    const receta = recetaSolo({ acciones: ['ENFOQUE'], enfoque: 'medio' }, 400, 200);
    const salida = await aplicarReceta(png, receta);
    const { data, info } = await sharp(salida.buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
    const fila = 100 * info.width;
    let minimo = 255, maximo = 0;
    for (let x = 0; x < info.width; x++) {
      const v = data[fila + x * info.channels];
      if (v < minimo) minimo = v;
      if (v > maximo) maximo = v;
    }
    expect(60 - minimo).toBeLessThanOrEqual(14);
    expect(maximo - 200).toBeLessThanOrEqual(14);
  });
});

describe('recorteSinGirar · las 8 orientaciones EXIF', () => {
  it('recortar antes de girar da lo mismo que girar y después recortar', async () => {
    // Imagen asimétrica (sin pérdida) para que un recorte mal girado se note.
    const base = await sharp(await figuraBase()).resize(240, 180).png().toBuffer();
    const recorte = { left: 30, top: 20, width: 100, height: 70 };
    for (let orientacion = 1; orientacion <= 8; orientacion++) {
      // Se guarda «al revés» y con la etiqueta que lo endereza: visto, es siempre la misma imagen.
      const guardada = await sharp(base).rotate(0).withMetadata({ orientation: orientacion }).jpeg({ quality: 100 }).toBuffer();
      const vista = await sharp(guardada).rotate().png().toBuffer();
      const meta = await sharp(vista).metadata();
      const esperado = await sharp(vista).extract(recorte).raw().toBuffer();
      const obtenido = await sharp(guardada)
        .extract(recorteSinGirar(recorte, orientacion, meta.width!, meta.height!))
        .rotate()
        .raw()
        .toBuffer();
      expect({ orientacion, igual: Buffer.compare(esperado, obtenido) === 0 }).toEqual({ orientacion, igual: true });
    }
  });
});

describe('verificarMejora · «no hacer daño»', () => {
  it('descarta una ganancia que quema el sujeto (blanco puro)', async () => {
    const receta = recetaSolo({ acciones: ['ACLARAR'], lineal: { a: [2.2, 2.2, 2.2], b: [0, 0, 0] } }, 1200, 900);
    const { verificacion } = await aplicarYVerificar(m.buena, receta);
    expect(verificacion.ok).toBe(false);
    expect(verificacion.motivo).toBe('blanco');
  });

  it('descarta un cambio de color que no pidió el balance', async () => {
    const receta = recetaSolo({ acciones: ['CONTRASTE'], lineal: { a: [0.8, 1, 1.2], b: [0, 0, 0] } }, 1200, 900);
    const { verificacion } = await aplicarYVerificar(m.buena, receta);
    expect(verificacion.ok).toBe(false);
    expect(verificacion.motivo).toBe('color');
  });

  it('descarta lo que deja la foto menos aguda (suavizar sin quitar ruido)', async () => {
    const receta = recetaSolo({ acciones: ['ENFOQUE'], suavizar: 'leve' }, 1200, 900);
    const { verificacion } = await aplicarYVerificar(m.buena, receta);
    expect(verificacion.ok).toBe(false);
    expect(verificacion.motivo).toBe('agudeza');
  });

  it('acepta las correcciones de verdad: aclarar la oscura, devolver contraste a la lavada, recortar', async () => {
    for (const nombre of ['oscura', 'lavada', 'borde', 'desenfocada'] as const) {
      const r = await mejorarImagen(m[nombre]);
      expect({ nombre, estado: r.estado, verificacion: r.verificacion!.ok }).toEqual({ nombre, estado: 'mejorada', verificacion: true });
    }
  });

  it('con medidas escritas a mano: una ganancia pareja y un desplazamiento igual no cuentan como cambio de color', () => {
    const base = { agudeza: 0.5, sujetoFrac: 0.5, blancoSujeto: 0, negroSujeto: 0, blancoTotal: 0, negroTotal: 0, colorSujeto: { r: 100, g: 80, b: 60 }, colorTotal: { r: 150, g: 140, b: 130 } } as any;
    const receta = recetaSolo({ acciones: ['CONTRASTE'], lineal: { a: [2, 2, 2], b: [-100, -100, -100] } }, 10, 10);
    const despues = { ...base, colorSujeto: { r: 100, g: 60, b: 20 }, colorTotal: { r: 200, g: 180, b: 160 } };
    expect(verificarMejora(base, despues, receta)).toMatchObject({ ok: true });
    const teñida = { ...despues, colorTotal: { r: 200, g: 180, b: 190 } };
    expect(verificarMejora(base, teñida, receta)).toMatchObject({ ok: false, motivo: 'color' });
  });

  it('si la verificación falla, mejorarImagen devuelve «sin_cambios» con motivo «verificacion»', async () => {
    // Umbrales que fuerzan una ganancia que quema: «aclarar» (×2,4) algo que ya estaba bien.
    const umbrales = { ...UMBRALES_MEJORA, p99Oscura: 256, blancoObjetivo: 600 };
    const r = await mejorarImagen(m.buena, umbrales);
    expect(r.receta.acciones).toContain('ACLARAR');
    expect(r.estado).toBe('sin_cambios');
    expect(r.motivo).toBe('verificacion');
    expect(r.mejorada).toBeUndefined();
  });
});

describe('mejorarImagen · lo que no se mejora', () => {
  it('transparencia, animada y más de 25 Mpx ⇒ «omitida» con su motivo', async () => {
    expect(await mejorarImagen(m.transparente)).toMatchObject({ estado: 'omitida', motivo: 'transparencia' });
    expect(await mejorarImagen(await animada())).toMatchObject({ estado: 'omitida', motivo: 'animada' });
    expect(await mejorarImagen(await enorme())).toMatchObject({ estado: 'omitida', motivo: 'demasiado_grande' });
  });
});

describe('tiempo', () => {
  it('analizar + mejorar una foto de 1600 px tarda menos de 2 s', async () => {
    const foto = await sharp(await figuraBase()).resize(1600, 1200).blur(1.2).jpeg({ quality: 90 }).toBuffer();
    const inicio = Date.now();
    const r = await mejorarImagen(foto);
    const ms = Date.now() - inicio;
    expect(r.estado).toBe('mejorada');
    expect(r.receta.acciones).toContain('ENFOQUE');
    expect(ms).toBeLessThan(2000);
    // El valor queda en la salida para anotarlo en la evidencia del plan.
    console.info(`[mejora-fotos] 1600 px: análisis ${r.ms.analisis} ms + mejora ${r.ms.mejora} ms = ${ms} ms`);
  });
});

describe('CAJA_FIGURA', () => {
  it('la figura ocupa más del 55 % (si no, la «buena» se recortaría)', () => {
    const area = ((CAJA_FIGURA.x1 - CAJA_FIGURA.x0) * (CAJA_FIGURA.y1 - CAJA_FIGURA.y0)) / (1200 * 900);
    expect(area).toBeGreaterThan(0.55);
  });
});

