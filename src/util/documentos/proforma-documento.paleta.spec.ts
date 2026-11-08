import { PALETA } from './proforma-documento';

/**
 * Contraste de lectura (WCAG 2.x) de los colores de marca de los documentos. Todo texto normal
 * debe llegar a 4,5:1. El dorado `#B8975A` NO se usa como texto (da 2,8:1 sobre blanco): solo
 * en líneas, barritas y rellenos, por eso no figura aquí.
 *
 * El mismo hexadecimal del gris claro vive en el front (`--doc-gris-claro` de Cotizaciones y la
 * hoja del comprobante): si se cambia aquí, cambiar allá.
 */
const MINIMO_TEXTO = 4.5;

function luminancia(hex: string): number {
  const canales = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = canales.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contraste(a: string, b: string): number {
  const [claro, oscuro] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (claro + 0.05) / (oscuro + 0.05);
}

type ColorPaleta = keyof typeof PALETA;

/** Pares texto/fondo que los documentos dibujan de verdad (plan: PLAN_VISTA_PREVIA_FIEL_Y_LOGO §1.4 y F5). */
const PARES: Array<[texto: ColorPaleta, fondo: ColorPaleta]> = [
  // Texto sobre papel (blanco), cebra de la tabla y caja gris.
  ['texto', 'blanco'],
  ['texto', 'cebra'],
  ['texto', 'fondo'],
  ['gris', 'blanco'],
  ['gris', 'cebra'],
  ['gris', 'fondo'],
  ['grisClaro', 'blanco'],
  ['grisClaro', 'cebra'],
  ['grisClaro', 'fondo'],
  ['doradoOscuro', 'blanco'],
  ['doradoOscuro', 'doradoSuave'],
  // Estilo B «oro presente»: etiquetas grafito y valores en la caja doradoSuave (cliente/documento, SON).
  ['grafito', 'doradoSuave'],
  ['texto', 'doradoSuave'],
  ['gris', 'doradoSuave'],
  ['aviso', 'blanco'],
  ['peligro', 'blanco'],
  // Texto claro sobre las bandas grafito (cabeceras de tabla, IMPORTE TOTAL, caja del documento).
  ['blanco', 'grafito'],
  ['doradoClaro', 'grafito'],
  ['plata', 'grafito'],
];

describe('paleta de los documentos: contraste de lectura (WCAG)', () => {
  it.each(PARES)('%s sobre %s llega a 4,5:1', (texto, fondo) => {
    expect(contraste(PALETA[texto], PALETA[fondo])).toBeGreaterThanOrEqual(MINIMO_TEXTO);
  });

  it('el gris claro corregido es #6A6C6B y el anterior (#8E908F) quedó fuera', () => {
    expect(PALETA.grisClaro).toBe('#6A6C6B');
    expect(contraste('#8E908F', PALETA.blanco)).toBeLessThan(MINIMO_TEXTO);
  });

  it('el cálculo coincide con valores conocidos (negro/blanco = 21, blanco/blanco = 1)', () => {
    expect(contraste('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contraste('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });

  it('el dorado de marca es solo decorativo: no alcanza para texto sobre blanco', () => {
    expect(contraste(PALETA.dorado, PALETA.blanco)).toBeLessThan(MINIMO_TEXTO);
  });
});
