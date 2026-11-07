import {
  generarResumenCajaPdf,
  nombreArchivoResumenCaja,
  type DatosResumenCajaPdf,
  type FilaResumenCajaPdf,
} from './resumen-caja-pdf';
import { codificarPng } from './logo-emisor';

/** Bytes 0x80-0x9F de WinAnsi que no coinciden con Latin-1. */
const WIN_ANSI: Record<number, string> = { 0x85: '…', 0x96: '–', 0x97: '—', 0xab: '«', 0xbb: '»' };

function decodificar(hex: string): string {
  return Array.from(Buffer.from(hex, 'hex'), (b) => WIN_ANSI[b] ?? String.fromCharCode(b)).join('');
}

/** Todo el texto del PDF (generado con comprimir:false) en una sola cadena. */
function texto(pdf: Buffer): string {
  const crudo = pdf.toString('latin1');
  const lineas: string[] = [];
  for (const [, flujo] of crudo.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    if (!/\]\s*TJ/.test(flujo)) continue;
    for (const [, arreglo] of flujo.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      lineas.push(Array.from(arreglo.matchAll(/<([0-9a-fA-F]*)>/g), ([, hex]) => decodificar(hex)).join(''));
    }
  }
  return lineas.join('\n');
}

function numeroDePaginas(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;
}

function imagenesDibujadas(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/I\d+ Do/g) ?? []).length;
}

function logo(): Buffer {
  const rgba = Buffer.alloc(40 * 20 * 4);
  for (let i = 0; i < 40 * 20; i++) rgba.set([62, 64, 63, 255], i * 4);
  return codificarPng(rgba, 40, 20);
}

function fila(extra: Partial<FilaResumenCajaPdf> = {}): FilaResumenCajaPdf {
  return {
    id_sucursal: 1,
    nombre: 'Principal',
    turnos: 2,
    turnos_abiertos: 1,
    efectivo_inicial: 70,
    ventas_total: 255,
    por_metodo: [
      { metodo: 'EFECTIVO', monto: 170 },
      { metodo: 'Yape', monto: 60 },
      { metodo: 'Crédito', monto: 25 },
    ],
    efectivo_esperado: 240,
    efectivo_contado: 190,
    diferencia: -50,
    ...extra,
  };
}

function datos(sucursales: FilaResumenCajaPdf[], extra: Partial<DatosResumenCajaPdf> = {}): DatosResumenCajaPdf {
  return {
    desde: '2026-11-01',
    hasta: '2026-11-05',
    sucursales,
    total: sucursales.length ? fila({ id_sucursal: null, nombre: 'Total', turnos: 4, ventas_total: 375 }) : null,
    emisor: { razon_social: 'HATUNSALES S.A.C.', ruc: '20610206337', direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN' },
    generado_en: new Date('2026-11-06T15:00:00.000Z'),
    ...extra,
  };
}

const cuatro = (): FilaResumenCajaPdf[] => [
  fila({ id_sucursal: 1, nombre: 'Principal' }),
  fila({ id_sucursal: 2, nombre: 'Norte', diferencia: 5, efectivo_contado: 105 }),
  fila({ id_sucursal: 3, nombre: 'Sur', diferencia: 0, efectivo_contado: 240 }),
  fila({ id_sucursal: null, nombre: 'Sin sucursal', turnos_abiertos: 2, efectivo_inicial: null, efectivo_contado: null, diferencia: null }),
];

describe('generarResumenCajaPdf', () => {
  it('con 0 sucursales sale un PDF válido con el aviso de rango vacío y sin TOTAL', async () => {
    const pdf = await generarResumenCajaPdf(datos([]), { comprimir: false });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    const t = texto(pdf);
    expect(t).toContain('RESUMEN DE CAJA');
    expect(t).toContain('01/11/2026 al 05/11/2026');
    expect(t).toContain('Sin turnos de caja en el periodo seleccionado.');
    expect(t).not.toContain('TOTAL');
    expect(numeroDePaginas(pdf)).toBe(1);
  });

  it('con 1 sucursal: rótulos, cifras, «Falta» y TOTAL', async () => {
    const pdf = await generarResumenCajaPdf(datos([fila()], { sucursal_filtrada: 'Principal' }), { comprimir: false });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    const t = texto(pdf);
    for (const rotulo of [
      'RESUMEN DE CAJA',
      'HATUNSALES S.A.C.',
      'RUC 20610206337',
      'Sucursal: Principal',
      'Principal',
      '2 turnos',
      '1 abierto',
      'EFECTIVO INICIAL',
      'VENTAS',
      'EFECTIVO ESPERADO',
      'EFECTIVO CONTADO',
      'DIFERENCIA',
      'VENTAS POR MEDIO DE PAGO',
      'EFECTIVO',
      'Yape',
      'S/ 70.00',
      'S/ 255.00',
      'S/ 240.00',
      'S/ 190.00',
      'Falta S/ 50.00',
      'TOTAL',
      'Generado el 06/11/2026 10:00 (hora de Lima)',
      'Página 1 de 1',
    ]) {
      expect(t).toContain(rotulo);
    }
  });

  it('muestra Sobra y Cuadra según el signo de la diferencia', async () => {
    const t = texto(await generarResumenCajaPdf(datos(cuatro()), { comprimir: false }));
    expect(t).toContain('Sobra S/ 5.00');
    expect(t).toContain('Cuadra');
  });

  it('con 4 sucursales: monto null es «sin dato» (nunca S/ 0.00 inventado) y total de varias sucursales', async () => {
    const pdf = await generarResumenCajaPdf(
      datos(cuatro(), { total: fila({ id_sucursal: null, nombre: 'Total', efectivo_contado: null, diferencia: null }) }),
      { comprimir: false },
    );
    const t = texto(pdf);
    expect(t).toContain('Sin sucursal');
    expect(t).toContain('4 sucursales');
    expect(t).toContain('sin dato');
    expect(t).not.toContain('S/ 0.00');
    expect(t).not.toContain('NaN');
    expect(t).not.toContain('undefined');
    expect(pdf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('un monto de medio de pago null se escribe «sin dato»', async () => {
    const f = fila({ por_metodo: [{ metodo: 'Plin', monto: null }] });
    const t = texto(await generarResumenCajaPdf(datos([f]), { comprimir: false }));
    expect(t).toContain('Plin');
    // Una vez en la nota al pie de la leyenda y otra en el monto de Plin.
    expect(t.match(/sin dato/g)?.length).toBe(2);
  });

  it('una sucursal sin ventas dice «Sin ventas registradas.»', async () => {
    const f = fila({ por_metodo: [], ventas_total: 0 });
    expect(texto(await generarResumenCajaPdf(datos([f]), { comprimir: false }))).toContain('Sin ventas registradas.');
  });

  it('con logo lo dibuja; sin logo, o con un logo ilegible, el PDF sale igual', async () => {
    const con = await generarResumenCajaPdf(datos([fila()], { emisor: { ...datos([]).emisor, logo: logo() } }), { comprimir: false });
    expect(imagenesDibujadas(con)).toBeGreaterThan(0);
    const sin = await generarResumenCajaPdf(datos([fila()]), { comprimir: false });
    expect(imagenesDibujadas(sin)).toBe(0);
    const roto = await generarResumenCajaPdf(datos([fila()], { emisor: { ...datos([]).emisor, logo: Buffer.from('no es una imagen') } }));
    expect(roto.subarray(0, 5).toString()).toBe('%PDF-');
    expect(roto.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('una lista larga pagina sin partir tarjetas y numera «Página x de y»', async () => {
    const muchas = Array.from({ length: 14 }, (_, i) =>
      fila({
        id_sucursal: i + 1,
        nombre: `Sucursal ${String(i + 1).padStart(2, '0')}`,
        por_metodo: Array.from({ length: 1 + (i % 6) * 2 }, (_m, j) => ({ metodo: `Medio ${j + 1}`, monto: 10 + j })),
      }),
    );
    const pdf = await generarResumenCajaPdf(datos(muchas), { comprimir: false });
    const paginas = numeroDePaginas(pdf);
    expect(paginas).toBeGreaterThan(1);
    const t = texto(pdf);
    expect(t).toContain(`Página 1 de ${paginas}`);
    expect(t).toContain(`Página ${paginas} de ${paginas}`);
    // Cada tarjeta lleva su título y su rótulo de medios: ninguna se perdió ni se duplicó.
    expect(t.match(/VENTAS POR MEDIO DE PAGO/g)?.length).toBe(15);
    expect(t.match(/Sucursal \d\d/g)?.length).toBe(14);
    expect(t).toContain('14 sucursales');
  });

  it('textos largos se recortan con «…» y no revientan el PDF', async () => {
    const largo = 'Sucursal con un nombre larguísimo '.repeat(8);
    const pdf = await generarResumenCajaPdf(datos([fila({ nombre: largo })], { sucursal_filtrada: largo }), { comprimir: false });
    expect(texto(pdf)).toContain('…');
    expect(pdf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
  });
});

describe('nombreArchivoResumenCaja', () => {
  it('resumen-caja-<desde>_<hasta>.pdf', () => {
    expect(nombreArchivoResumenCaja('2026-11-01', '2026-11-05')).toBe('resumen-caja-2026-11-01_2026-11-05.pdf');
  });
});
