import type { AnalisisImagen, MedidasImagen } from './analizador-imagen';
import { decidirReceta } from './receta-mejora';
import { UMBRALES_MEJORA, leerUmbrales, nombreVariable } from './umbrales-mejora';

/**
 * La receta es pura: aquí se prueba con medidas escritas a mano, tomadas de los rangos medidos en el
 * experimento del plan (§4.2). Las pruebas con píxeles de verdad están en analizador-imagen.spec.ts.
 */

function medidas(cambios: Partial<MedidasImagen> = {}): MedidasImagen {
  return {
    w: 1200, h: 900, p1: 20, p50: 180, p99: 245, p995: 248, rango: 225,
    fondo: { r: 245, g: 245, b: 245, L: 245, uniformidad: 0.97, tinte: 0 },
    caja: { x0: 0.08, x1: 0.92, y0: 0.1, y1: 0.9 }, ocupacion: 0.67, sujetoFrac: 0.6,
    p1Sujeto: 20, p99Sujeto: 240, agudeza: 0.6, ruido: 0.5, bloques: 1.0, bloquesDif: 0,
    blancoTotal: 0, negroTotal: 0, blancoSujeto: 0, negroSujeto: 0,
    colorSujeto: { r: 120, g: 100, b: 90 }, colorTotal: { r: 200, g: 195, b: 190 },
    ...cambios,
  };
}

function analisis(cambios: Partial<MedidasImagen> = {}, base: Partial<AnalisisImagen> = {}): AnalisisImagen {
  const ancho = base.ancho ?? 1200, alto = base.alto ?? 900;
  return {
    ancho, alto, formato: 'jpeg', orientacion: 1, alfa: false, paginas: 1, pixeles: ancho * alto,
    medidas: medidas(cambios), ms: 1, ...base,
  };
}

describe('decidirReceta · una foto buena no se toca', () => {
  it('nítida, bien expuesta y de 900 px o más ⇒ sin cambios (se publica el archivo original)', () => {
    const r = decidirReceta(analisis());
    expect(r.cambia).toBe(false);
    expect(r.acciones).toEqual([]);
    expect(r.avisos).toEqual([]);
    expect(r.lineal).toBeUndefined();
    expect(r.enfoque).toBeUndefined();
  });

  it('reducir a 1600 px por sí solo no cuenta como corrección', () => {
    const r = decidirReceta(analisis({}, { ancho: 4000, alto: 3000 }));
    expect(r.cambia).toBe(false);
    expect(r.escala).toBeCloseTo(0.4);
    expect([r.anchoSalida, r.altoSalida]).toEqual([1600, 1200]);
  });

  it('con grano moderado (σ 12: ruido 6,7–8,9) y nítida no enfoca ni suaviza', () => {
    const r = decidirReceta(analisis({ ruido: 7.5 }));
    expect(r.cambia).toBe(false);
  });

  it('la foto de celular sobre madera (ruido 4,4–5,6, fondo sin liso) queda igual', () => {
    const r = decidirReceta(analisis({ ruido: 5.6, fondo: { r: 140, g: 110, b: 80, L: 116, uniformidad: 0.2, tinte: 60 }, ocupacion: 1 }));
    expect(r.cambia).toBe(false);
  });
});

describe('decidirReceta · cada defecto dispara su acción y solo esa', () => {
  it('borde vacío ⇒ RECORTE a la caja del sujeto con 6 % de margen', () => {
    const caja = { x0: 0.3, x1: 0.7, y0: 0.35, y1: 0.65 };
    const W = 3200, H = 2400;
    const r = decidirReceta(analisis({ caja, ocupacion: 0.12 }, { ancho: W, alto: H }));
    expect(r.acciones).toEqual(['RECORTE']);
    const mg = 0.06 * Math.max(0.4 * W, 0.3 * H);
    const x0 = Math.round(0.3 * W - mg), y0 = Math.round(0.35 * H - mg);
    expect(r.recorte).toEqual({ left: x0, top: y0, width: Math.round(0.7 * W + mg) - x0, height: Math.round(0.65 * H + mg) - y0 });
    // El recorte (1434 px) cabe en 1600: no se reduce ni se amplía.
    expect(r.escala).toBe(1);
  });

  it('si tras recortar queda chica, además se amplía', () => {
    const r = decidirReceta(analisis({ caja: { x0: 0.3, x1: 0.7, y0: 0.35, y1: 0.65 }, ocupacion: 0.12 }, { ancho: 1600, alto: 1200 }));
    expect(r.acciones).toEqual(['RECORTE', 'AMPLIAR']);
  });

  it('sin fondo liso no recorta aunque el sujeto ocupe poco', () => {
    const r = decidirReceta(analisis({ ocupacion: 0.2, fondo: { r: 120, g: 100, b: 80, L: 104, uniformidad: 0.5, tinte: 40 } }));
    expect(r.acciones).not.toContain('RECORTE');
  });

  it('oscura (p99 < 150) ⇒ ACLARAR con la misma ganancia en R, G y B, tope 2,5', () => {
    const r = decidirReceta(analisis({ p1: 5, p99: 90, p995: 95, rango: 85, p1Sujeto: 5, fondo: { r: 95, g: 95, b: 95, L: 95, uniformidad: 0.97, tinte: 0 } }));
    expect(r.acciones).toEqual(['ACLARAR']);
    const [a, b, c] = r.lineal!.a;
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBeLessThanOrEqual(2.5);
    expect(a).toBeGreaterThan(2);
    expect(r.lineal!.b).toEqual([0, 0, 0]);
    expect(r.avisos).toContain('MUY_OSCURA');
  });

  it('un poco oscura aclara sin avisar', () => {
    const r = decidirReceta(analisis({ p99: 140, p995: 145 }));
    expect(r.acciones).toEqual(['ACLARAR']);
    expect(r.avisos).toEqual([]);
  });

  it('lavada (p1 ≥ 60, rango < 150) ⇒ CONTRASTE con ganancia ≤ 2,0', () => {
    const r = decidirReceta(analisis({ p1: 85, p99: 200, p995: 205, rango: 115, p1Sujeto: 85 }));
    expect(r.acciones).toEqual(['CONTRASTE']);
    expect(r.lineal!.a[0]).toBeLessThanOrEqual(2.0);
    expect(r.lineal!.a[0]).toBe(r.lineal!.a[2]);
    expect(r.lineal!.b[0]).toBeLessThan(0);
  });

  it('el negro de una foto con fondo blanco se mide en el sujeto: no da un falso «lavada»', () => {
    const r = decidirReceta(analisis({ p1: 240, p99: 255, p995: 255, rango: 15, p1Sujeto: 15, sujetoFrac: 0.2 }));
    expect(r.acciones).not.toContain('CONTRASTE');
  });

  it('desenfoque σ 1,2 (agudeza 0,19–0,25) ⇒ ENFOQUE «medio», sin aviso', () => {
    const r = decidirReceta(analisis({ agudeza: 0.22 }));
    expect(r.acciones).toEqual(['ENFOQUE']);
    expect(r.enfoque).toBe('medio');
    expect(r.avisos).toEqual([]);
  });

  it('desenfoque σ 2,5 (agudeza < 0,18) ⇒ enfoque «medio» (no más: halos) y aviso BORROSA', () => {
    const r = decidirReceta(analisis({ agudeza: 0.12 }));
    expect(r.acciones).toEqual(['ENFOQUE']);
    expect(r.enfoque).toBe('medio');
    expect(r.avisos).toEqual(['BORROSA']);
  });

  it('240 px ⇒ AMPLIAR ×2 y aviso MUY_CHICA', () => {
    const r = decidirReceta(analisis({}, { ancho: 240, alto: 180 }));
    expect(r.acciones).toEqual(['AMPLIAR']);
    expect(r.escala).toBe(2);
    expect([r.anchoSalida, r.altoSalida]).toEqual([480, 360]);
    expect(r.avisos).toEqual(['MUY_CHICA']);
    expect(r.enfoque).toBe('ampliacion');
  });

  it('entre 480 y 899 px ⇒ AMPLIAR hasta 1000 px y aviso CHICA', () => {
    const r = decidirReceta(analisis({}, { ancho: 600, alto: 450 }));
    expect(r.acciones).toEqual(['AMPLIAR']);
    expect(r.anchoSalida).toBe(1000);
    expect(r.avisos).toEqual(['CHICA']);
  });

  it('ruido fuerte ⇒ RUIDO (mediana) y ningún enfoque, aunque esté suave', () => {
    for (const agudeza of [0.7, 0.25, 0.12]) {
      const r = decidirReceta(analisis({ ruido: 15, agudeza }));
      expect(r.acciones).toContain('RUIDO');
      expect(r.acciones).not.toContain('ENFOQUE');
      expect(r.enfoque).toBeUndefined();
      expect(r.suavizar).toBe('mediana');
      expect(r.avisos).toContain('RUIDO');
    }
  });

  it('el grano que sube al aclarar cuenta: ruido 5 × ganancia 2,5 ⇒ mediana', () => {
    const r = decidirReceta(analisis({ ruido: 5, p1: 5, p99: 90, p995: 95, rango: 85 }));
    expect(r.acciones).toEqual(['ACLARAR', 'RUIDO']);
  });

  it('con grano visible solo enfoca «ligero» y solo si está borrosa', () => {
    expect(decidirReceta(analisis({ ruido: 7, agudeza: 0.25 })).enfoque).toBeUndefined();
    const borrosa = decidirReceta(analisis({ ruido: 7, agudeza: 0.12 }));
    expect(borrosa.enfoque).toBe('ligero');
    expect(borrosa.acciones).toEqual(['ENFOQUE']);
  });

  it('con cuadritos de JPEG: enfoque «ligero» con suavizado leve antes; aviso solo si la razón ≥ 2', () => {
    const leve = decidirReceta(analisis({ bloques: 1.7, bloquesDif: 1.0, agudeza: 0.25 }));
    expect(leve.enfoque).toBe('ligero');
    expect(leve.suavizar).toBe('leve');
    expect(leve.avisos).toEqual([]);
    const fuerte = decidirReceta(analisis({ bloques: 3.2, bloquesDif: 3.5 }));
    expect(fuerte.cambia).toBe(false);
    expect(fuerte.avisos).toEqual(['COMPRIMIDA']);
  });

  it('balance de blancos solo con fondo claro, liso y cálido; al 60 %', () => {
    const r = decidirReceta(analisis({ fondo: { r: 240, g: 228, b: 200, L: 229, uniformidad: 0.95, tinte: 40 } }));
    expect(r.acciones).toEqual(['BALANCE']);
    const [ar, ag, ab] = r.lineal!.a;
    expect(ar).toBe(1);
    expect(ag).toBeCloseTo(1 + 0.6 * (240 / 228 - 1), 3);
    expect(ab).toBeCloseTo(1 + 0.6 * (240 / 200 - 1), 3);
    // Un fondo frío o sin referencia no se toca.
    expect(decidirReceta(analisis({ fondo: { r: 200, g: 228, b: 240, L: 222, uniformidad: 0.95, tinte: 40 } })).cambia).toBe(false);
    expect(decidirReceta(analisis({ fondo: { r: 160, g: 140, b: 110, L: 141, uniformidad: 0.95, tinte: 50 } })).cambia).toBe(false);
  });

  it('«fondo blanco» está apagado por defecto y se puede encender por umbral', () => {
    const gris = { fondo: { r: 205, g: 205, b: 205, L: 205, uniformidad: 0.95, tinte: 0 }, p99Sujeto: 200 };
    expect(decidirReceta(analisis(gris)).cambia).toBe(false);
    const encendido = decidirReceta(analisis(gris), { ...UMBRALES_MEJORA, fondoBlanco: true });
    expect(encendido.acciones).toEqual(['FONDO_BLANCO']);
    expect(encendido.lineal!.a[0]).toBeLessThanOrEqual(1.25);
  });
});

describe('decidirReceta · lo que no se mejora', () => {
  it('transparencia ⇒ omitida (pero el aviso de tamaño se da igual)', () => {
    const r = decidirReceta({ ...analisis({}, { ancho: 300, alto: 300 }), alfa: true, medidas: null });
    expect(r.omitida).toBe('transparencia');
    expect(r.cambia).toBe(false);
    expect(r.avisos).toEqual(['MUY_CHICA']);
  });

  it('animada ⇒ omitida', () => {
    expect(decidirReceta({ ...analisis(), paginas: 3, medidas: null }).omitida).toBe('animada');
  });

  it('más de 25 Mpx ⇒ omitida «demasiado_grande»', () => {
    const r = decidirReceta({ ...analisis({}, { ancho: 6000, alto: 4300 }), medidas: null });
    expect(r.omitida).toBe('demasiado_grande');
  });
});

describe('umbrales · se pueden pisar con FOTOS_* sin tocar código', () => {
  it('nombre de la variable', () => {
    expect(nombreVariable('agudezaNitida')).toBe('FOTOS_AGUDEZA_NITIDA');
    expect(nombreVariable('fondoBlanco')).toBe('FOTOS_FONDO_BLANCO');
  });

  it('un valor válido pisa al medido; uno inválido se ignora', () => {
    const u = leerUmbrales({ FOTOS_AGUDEZA_NITIDA: '0,34', FOTOS_RUIDO_FUERTE: 'muchísimo', FOTOS_FONDO_BLANCO: 'si', FOTOS_LADO_CHICA: '-3' });
    expect(u.agudezaNitida).toBe(0.34);
    expect(u.ruidoFuerte).toBe(UMBRALES_MEJORA.ruidoFuerte);
    expect(u.fondoBlanco).toBe(true);
    expect(u.ladoChica).toBe(UMBRALES_MEJORA.ladoChica);
  });

  it('sin variables quedan los medidos', () => {
    expect(leerUmbrales({})).toEqual({ ...UMBRALES_MEJORA });
  });
});
