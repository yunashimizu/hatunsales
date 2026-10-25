import {
  AVISO_BETA_PDF,
  generarPdfComprobante,
  type DatosPdfComprobante,
  type ItemPdfComprobante,
} from './comprobante-pdf';
import { codificarPng } from './logo-emisor';

/** Bytes 0x80-0x9F de WinAnsi que no coinciden con Latin-1. */
const WIN_ANSI: Record<number, string> = {
  0x85: '…',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x95: '•',
  0x96: '–',
  0x97: '—',
};

function decodificar(hex: string): string {
  return Array.from(
    Buffer.from(hex, 'hex'),
    (b) => WIN_ANSI[b] ?? String.fromCharCode(b),
  ).join('');
}

/** Texto de cada hoja (un flujo de contenido por página, en orden) de un PDF generado con comprimir:false. */
function paginas(pdf: Buffer): string[] {
  const crudo = pdf.toString('latin1');
  const resultado: string[] = [];
  for (const [, flujo] of crudo.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    // Solo los flujos de contenido de página tienen texto (TJ); las imágenes son binarias.
    if (!/\]\s*TJ/.test(flujo)) continue;
    const lineas = Array.from(
      flujo.matchAll(/\[([^\]]*)\]\s*TJ/g),
      ([, arreglo]) =>
        Array.from(arreglo.matchAll(/<([0-9a-fA-F]*)>/g), ([, hex]) =>
          decodificar(hex),
        ).join(''),
    );
    resultado.push(lineas.join('\n'));
  }
  return resultado;
}

/** Todo el texto en una sola línea (las palabras partidas por el ajuste quedan separadas por un espacio). */
function texto(pdf: Buffer): string {
  return paginas(pdf).join('\n').replace(/\n/g, ' ');
}

function numeroDePaginas(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;
}

/** Imágenes dibujadas (operador «/In Do»); un PNG con alfa agrega además su máscara como XObject. */
function imagenesDibujadas(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/I\d+ Do/g) ?? []).length;
}

function hayXObjectDeImagen(pdf: Buffer): boolean {
  return /\/Subtype \/Image/.test(pdf.toString('latin1'));
}

function mediaBox(pdf: Buffer): number[] {
  const caja = /\/MediaBox \[([^\]]+)\]/.exec(pdf.toString('latin1'));
  return caja ? caja[1].trim().split(/\s+/).map(Number) : [];
}

/** Logo PNG RGBA (con transparencia) de 40x20 px. */
function logoPrueba(): Buffer {
  const rgba = Buffer.alloc(40 * 20 * 4);
  for (let i = 0; i < 40 * 20; i++)
    rgba.set([242, 140, 27, i % 7 ? 255 : 0], i * 4);
  return codificarPng(rgba, 40, 20);
}

const CADENA_QR =
  '20610206337|01|F001|00000123|45.76|300.00|2026-10-21|6|20100070970|q8ZqH0n0zG5m6Yy0ZkzQb2s5bWc=|';

function item(parcial: Partial<ItemPdfComprobante> = {}): ItemPdfComprobante {
  return {
    codigo: 'CEM-001',
    unidad: 'NIU',
    descripcion: 'CEMENTO SOL TIPO I 42.5 KG',
    cantidad: 10,
    valorUnitario: 25.423729,
    precioUnitario: 30,
    descuento: 0,
    importe: 300,
    ...parcial,
  };
}

function factura(
  parcial: Partial<DatosPdfComprobante> = {},
): DatosPdfComprobante {
  return {
    emisor: {
      ruc: '20610206337',
      razonSocial: 'HATUNSALES S.A.C.',
      nombreComercial: 'HatunSales Ferretería',
      direccion: 'Av. Los Próceres 1234, Urb. Zárate',
      ubicacion: 'LIMA - LIMA - SAN JUAN DE LURIGANCHO',
      telefono: '01 555-1234',
      email: 'ventas@hatunsales.pe',
      logo: logoPrueba(),
    },
    tipo: '01',
    serie: 'F001',
    numero: 123,
    fechaEmision: '21/10/2026',
    horaEmision: '14:35:10',
    fechaVencimiento: null,
    moneda: 'PEN',
    cliente: {
      tipoDoc: '6',
      numDoc: '20100070970',
      nombre: 'SUPERMERCADOS PERUANOS SOCIEDAD ANONIMA',
      direccion: 'Calle Morelli 181, San Borja, Lima',
    },
    referencia: null,
    items: [item()],
    totales: {
      gravada: 254.24,
      exonerada: 0,
      inafecta: 0,
      descuentos: 0,
      igv: 45.76,
      porcentajeIgv: 18,
      total: 300,
    },
    importeEnLetras: 'SON: TRESCIENTOS CON 00/100 SOLES',
    formaPago: { tipo: 'Contado' },
    observaciones: null,
    medioPago: 'Efectivo',
    cadenaQr: CADENA_QR,
    codigoHash: 'q8ZqH0n0zG5m6Yy0ZkzQb2s5bWc=',
    ambiente: 'produccion',
    avisoEstado: null,
    ...parcial,
  };
}

const boleta = (
  parcial: Partial<DatosPdfComprobante> = {},
): DatosPdfComprobante =>
  factura({
    tipo: '03',
    serie: 'B001',
    numero: 45,
    cliente: {
      tipoDoc: '0',
      numDoc: '-',
      nombre: 'CLIENTES VARIOS',
      direccion: null,
    },
    items: [
      item({
        codigo: null,
        descripcion: 'Clavos de 3" (kg)',
        unidad: 'KGM',
        cantidad: 2.5,
        valorUnitario: 7.627119,
        precioUnitario: 9,
        importe: 22.5,
      }),
    ],
    totales: {
      gravada: 19.07,
      exonerada: 0,
      inafecta: 0,
      descuentos: 0,
      igv: 3.43,
      porcentajeIgv: 18,
      total: 22.5,
    },
    importeEnLetras: 'VEINTIDOS CON 50/100 SOLES',
    ...parcial,
  });

const notaCredito = (
  parcial: Partial<DatosPdfComprobante> = {},
): DatosPdfComprobante =>
  factura({
    tipo: '07',
    serie: 'FC01',
    numero: 7,
    referencia: {
      tipoDoc: '01',
      serie: 'F001',
      numero: 12,
      motivo: '07',
      motivoDescripcion: 'Devolución por ítem',
      sustento:
        'El cliente devolvió 2 bolsas de cemento dañadas en el traslado.',
    },
    items: [item({ cantidad: 2, importe: 60 })],
    totales: {
      gravada: 50.85,
      exonerada: 0,
      inafecta: 0,
      descuentos: 0,
      igv: 9.15,
      porcentajeIgv: 18,
      total: 60,
    },
    importeEnLetras: 'SON: SESENTA CON 00/100 SOLES',
    formaPago: null,
    ...parcial,
  });

const credito = (): DatosPdfComprobante =>
  factura({
    fechaVencimiento: '20/12/2026',
    formaPago: {
      tipo: 'Credito',
      cuotas: [
        { numero: 1, monto: 150, fechaPago: '20/11/2026' },
        { numero: 2, monto: 150, fechaPago: '20/12/2026' },
      ],
    },
  });

function sesentaLineas(): DatosPdfComprobante {
  const items = Array.from({ length: 60 }, (_, i) =>
    item({
      codigo: `P-${String(i + 1).padStart(3, '0')}`,
      descripcion:
        i % 5 === 0
          ? `Línea ${i + 1}: TUBERÍA PVC SAP CLASE 10 DE 1/2" x 5 m CON UNIÓN ROSCADA, INCLUYE ACCESORIOS DE INSTALACIÓN Y CINTA TEFLÓN PARA SELLADO`
          : `Línea ${i + 1}: CEMENTO SOL TIPO I 42.5 KG`,
      cantidad: 1,
      importe: 30,
    }),
  );
  return factura({
    items,
    totales: {
      gravada: 1525.42,
      exonerada: 0,
      inafecta: 0,
      descuentos: 0,
      igv: 274.58,
      porcentajeIgv: 18,
      total: 1800,
    },
    importeEnLetras: 'SON: MIL OCHOCIENTOS CON 00/100 SOLES',
  });
}

describe('generarPdfComprobante', () => {
  describe.each(['a4', 'ticket'] as const)('formato %s', (formato) => {
    const generar = (datos: DatosPdfComprobante, comprimir = false) =>
      generarPdfComprobante(datos, { formato, comprimir });

    it('factura gravada: título, serie-número, cliente, totales, letras, hash, leyenda y QR', async () => {
      const pdf = await generar(factura());
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(numeroDePaginas(pdf)).toBe(1);
      const t = texto(pdf);
      for (const esperado of [
        'FACTURA ELECTRÓNICA',
        'F001-00000123',
        'HATUNSALES S.A.C.',
        '20610206337',
        'SUPERMERCADOS PERUANOS SOCIEDAD ANONIMA',
        '20100070970',
        '21/10/2026 14:35:10',
        'SOLES (PEN)',
        'CEMENTO SOL TIPO I 42.5 KG',
        'Op. gravada',
        'S/ 254.24',
        'IGV (18%)',
        'S/ 45.76',
        'IMPORTE TOTAL',
        'S/ 300.00',
        'SON: TRESCIENTOS CON 00/100 SOLES',
        'Resumen (hash): q8ZqH0n0zG5m6Yy0ZkzQb2s5bWc=',
        'Efectivo',
      ]) {
        expect(t).toContain(esperado);
      }
      expect(t).toContain(
        'Representación impresa de la Factura Electrónica. Consulte su validez en www.sunat.gob.pe',
      );
      expect(t).not.toContain(AVISO_BETA_PDF);
      // QR + logo como XObject de imagen.
      expect(imagenesDibujadas(pdf)).toBe(2);
      expect(hayXObjectDeImagen(pdf)).toBe(true);
      expect(t).not.toContain('Código QR no disponible');
      // Ninguna etiqueta ni valor quedó recortado con «…».
      expect(t).not.toContain('…');
    });

    it('comprimido por defecto: más chico y sigue siendo un PDF válido', async () => {
      const comprimido = await generarPdfComprobante(factura(), { formato });
      const plano = await generar(factura());
      expect(comprimido.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(comprimido.length).toBeGreaterThan(0);
      expect(comprimido.length).toBeLessThan(plano.length);
      expect(numeroDePaginas(comprimido)).toBe(1);
    });

    it('boleta a consumidor final: sin documento y con «SON:» agregado si faltaba', async () => {
      const pdf = await generar(boleta());
      const t = texto(pdf);
      expect(t).toContain('BOLETA DE VENTA ELECTRÓNICA');
      expect(t).toContain('B001-00000045');
      expect(t).toContain('CLIENTES VARIOS');
      expect(t).toContain('Sin documento');
      expect(t).toContain('SON: VEINTIDOS CON 50/100 SOLES');
      expect(t).toMatch(formato === 'a4' ? /2\.5 KG/ : /2\.5 KG x 9\.00/);
      expect(t).toContain(
        'Representación impresa de la Boleta de Venta Electrónica',
      );
      expect(numeroDePaginas(pdf)).toBe(1);
    });

    it('nota de crédito: documento que modifica, motivo y sustento', async () => {
      const t = texto(await generar(notaCredito()));
      expect(t).not.toContain('…');
      expect(t).toContain('NOTA DE CRÉDITO ELECTRÓNICA');
      expect(t).toContain('FC01-00000007');
      expect(t).toContain('FACTURA ELECTRÓNICA F001-00000012');
      expect(t).toContain('07 - Devolución por ítem');
      expect(t).toContain(
        'El cliente devolvió 2 bolsas de cemento dañadas en el traslado.',
      );
      expect(t).toContain('SON: SESENTA CON 00/100 SOLES');
    });

    it('nota de débito: título propio', async () => {
      const t = texto(
        await generar(
          notaCredito({
            tipo: '08',
            serie: 'FD01',
            referencia: {
              tipoDoc: '01',
              serie: 'F001',
              numero: 12,
              motivo: '02',
              motivoDescripcion: 'Aumento en el valor',
              sustento: 'Flete adicional',
            },
          }),
        ),
      );
      expect(t).toContain('NOTA DE DÉBITO ELECTRÓNICA');
      expect(t).toContain('FD01-00000007');
    });

    it('factura a crédito: vencimiento, monto pendiente y cuotas', async () => {
      const t = texto(await generar(credito()));
      expect(t).not.toContain('…');
      expect(t).toContain(
        formato === 'a4'
          ? 'FECHA DE VENCIMIENTO 20/12/2026'
          : 'Vencimiento: 20/12/2026',
      );
      expect(t).toContain('FORMA DE PAGO: CRÉDITO');
      expect(t).toContain('S/ 300.00');
      expect(t).toContain('Cuota 001');
      expect(t).toContain('Cuota 002');
      expect(t).toContain('20/11/2026');
      expect(t).toContain('S/ 150.00');
    });

    it('caracteres especiales (&, <, comillas, tildes y eñe) se imprimen sin romperse', async () => {
      const datos = factura({
        cliente: {
          tipoDoc: '6',
          numDoc: '20512345678',
          nombre: 'JOSÉ PEÑA & HIJOS <FERRETERÍA> S.A.C.',
          direccion: 'Jr. Ñaña 45 "B"',
        },
        items: [
          item({
            descripcion:
              "Codo PVC 90° 1/2\" & unión <SAP> 'reforzada' — ÁÉÍÓÚ áéíóú Ññ ü",
          }),
        ],
        observaciones:
          "Entregar en 'almacén' <norte> & sur\nSegunda línea con ñandú 🙂",
      });
      const pdf = await generar(datos);
      const t = texto(pdf);
      expect(t).toContain('JOSÉ PEÑA & HIJOS');
      expect(t).toContain('<FERRETERÍA>');
      expect(t).toContain('Ñaña 45 "B"');
      expect(t).toContain('ÁÉÍÓÚ');
      expect(t).toContain('áéíóú Ññ ü');
      expect(t).toContain('90°');
      expect(t).toContain("'almacén' <norte> & sur");
      expect(t).toContain('Segunda línea con ñandú');
      // El emoji no existe en la fuente estándar: se descarta en lugar de imprimir basura.
      expect(t).not.toMatch(/[�\uD800-\uDFFF]/);
    });

    it('BETA: aviso visible de prueba sin validez tributaria', async () => {
      const pdf = await generar(
        factura({
          ambiente: 'beta',
          avisoEstado: 'PENDIENTE DE CONFIRMACIÓN DE SUNAT',
        }),
      );
      const t = texto(pdf);
      // Con los recuadros de aviso el ticket sigue midiendo una sola tira.
      expect(numeroDePaginas(pdf)).toBe(1);
      expect(t).toContain('PENDIENTE DE CONFIRMACIÓN DE SUNAT');
      expect(t).toContain(AVISO_BETA_PDF);
      if (formato === 'a4') {
        // Marca de agua diagonal semitransparente en la hoja.
        expect(t).toContain('PRUEBA SUNAT BETA');
        expect(t).toContain('SIN VALIDEZ TRIBUTARIA');
        expect(pdf.toString('latin1')).toMatch(/\/ca 0\.09/);
      } else {
        // En el ticket el aviso va arriba y al final (antes de cortar el papel).
        expect(t.split(AVISO_BETA_PDF).length - 1).toBe(2);
      }
    });

    it('dólares: símbolo y nombre de la moneda', async () => {
      const t = texto(
        await generar(
          factura({
            moneda: 'USD',
            importeEnLetras: 'SON: TRESCIENTOS CON 00/100 DOLARES AMERICANOS',
          }),
        ),
      );
      expect(t).toContain('DÓLARES AMERICANOS (USD)');
      expect(t).toContain('US$ 300.00');
      expect(t).not.toContain('S/ 300.00');
    });

    it('sin cadena QR: no dibuja el QR e imprime el aviso de estado', async () => {
      const pdf = await generar(
        factura({
          cadenaQr: null,
          codigoHash: null,
          avisoEstado: 'PENDIENTE DE ENVÍO A SUNAT',
          emisor: { ...factura().emisor, logo: null },
        }),
      );
      const t = texto(pdf);
      expect(imagenesDibujadas(pdf)).toBe(0);
      expect(hayXObjectDeImagen(pdf)).toBe(false);
      expect(t).toContain('PENDIENTE DE ENVÍO A SUNAT');
      expect(t).toContain('Código QR no disponible');
      expect(t).toContain('Resumen (hash): no disponible');
    });

    it('un logo dañado no impide generar el comprobante', async () => {
      const pdf = await generar(
        factura({
          emisor: {
            ...factura().emisor,
            logo: Buffer.from('no es una imagen'),
          },
        }),
      );
      expect(imagenesDibujadas(pdf)).toBe(1);
      expect(texto(pdf)).toContain('FACTURA ELECTRÓNICA');
    });

    it('descripciones larguísimas se ajustan en varias líneas sin perder el texto', async () => {
      const larga =
        'TUBERÍA PVC SAP CLASE 10 DE 1/2" x 5 m CON UNIÓN ROSCADA INCLUYE ACCESORIOS Y CINTA TEFLÓN PARA SELLADO FINAL DE OBRA';
      const t = texto(
        await generar(factura({ items: [item({ descripcion: larga })] })),
      );
      expect(t).toContain(formato === 'a4' ? larga : `CEM-001 - ${larga}`);
    });
  });

  describe('A4', () => {
    it('ancho A4 y QR de al menos 28 mm', async () => {
      const pdf = await generarPdfComprobante(factura(), {
        formato: 'a4',
        comprimir: false,
      });
      expect(mediaBox(pdf).slice(2).map(Math.round)).toEqual([595, 842]);
      // La matriz de transformación del QR («w 0 0 -h x y cm») lleva el lado en puntos.
      const lados = Array.from(
        pdf
          .toString('latin1')
          .matchAll(/([\d.]+) 0 0 -([\d.]+) [\d.]+ [\d.]+ cm\s*\/I\d+ Do/g),
        ([, w]) => Number(w),
      );
      expect(Math.max(...lados)).toBeGreaterThanOrEqual((28 / 25.4) * 72);
    });

    it('60 líneas: varias hojas, cabecera de tabla repetida, numeración y totales + QR sin partir', async () => {
      const pdf = await generarPdfComprobante(sesentaLineas(), {
        formato: 'a4',
        comprimir: false,
      });
      const hojas = paginas(pdf);
      expect(numeroDePaginas(pdf)).toBe(4);
      expect(hojas).toHaveLength(4);
      expect(hojas[0]).toContain('DESCRIPCIÓN');
      expect(hojas[1]).toContain('DESCRIPCIÓN');
      expect(hojas[0]).toContain('Línea 1:');
      expect(texto(pdf)).toContain('Línea 60:');
      hojas.forEach((hoja, i) =>
        expect(hoja).toContain(`Página ${i + 1} de 4`),
      );
      // Totales completos en una sola hoja.
      const conTotal = hojas.find((h) => h.includes('IMPORTE TOTAL'));
      expect(conTotal).toContain('Op. gravada');
      expect(conTotal).toContain('IGV (18%)');
      expect(conTotal).toContain('SON: MIL OCHOCIENTOS CON 00/100 SOLES');
      // El QR (operador Do) está en la misma hoja que su valor resumen.
      const crudos = Array.from(
        pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)endstream/g),
        ([, f]) => f,
      ).filter((f) => /\]\s*TJ/.test(f));
      const indiceHash = hojas.findIndex((h) => h.includes('Resumen (hash)'));
      expect(indiceHash).toBeGreaterThanOrEqual(0);
      expect(crudos[indiceHash]).toMatch(/\/I\d+ Do/);
    });

    it('BETA en todas las hojas', async () => {
      const pdf = await generarPdfComprobante(
        { ...sesentaLineas(), ambiente: 'beta' },
        { formato: 'a4', comprimir: false },
      );
      for (const hoja of paginas(pdf))
        expect(hoja).toContain('PRUEBA SUNAT BETA');
    });
  });

  describe('ticket 80 mm', () => {
    it('ancho de 226.77 pt y alto según el contenido', async () => {
      const corto = await generarPdfComprobante(boleta(), {
        formato: 'ticket',
        comprimir: false,
      });
      const largo = await generarPdfComprobante(sesentaLineas(), {
        formato: 'ticket',
        comprimir: false,
      });
      const [, , anchoCorto, altoCorto] = mediaBox(corto);
      const [, , anchoLargo, altoLargo] = mediaBox(largo);
      expect(anchoCorto).toBeCloseTo(226.77, 2);
      expect(anchoLargo).toBeCloseTo(226.77, 2);
      expect(altoCorto).toBeLessThan(842);
      expect(altoLargo).toBeGreaterThan(altoCorto + 1000);
      expect(numeroDePaginas(largo)).toBe(1);
      expect(texto(largo)).toContain('Línea 60:');
    });

    it('cada ítem en dos líneas: descripción y cantidad x precio con su importe', async () => {
      const t = texto(
        await generarPdfComprobante(
          factura({
            items: [item({ descuento: 5, precioUnitario: 29.5, importe: 295 })],
          }),
          { formato: 'ticket', comprimir: false },
        ),
      );
      expect(t).toContain('CEM-001 - CEMENTO SOL TIPO I 42.5 KG');
      expect(t).toContain('10 UND x 29.50 (dscto. 5.00)');
      expect(t).toContain('295.00');
    });
  });

  it('rechaza un formato o tipo desconocido con un mensaje claro', async () => {
    await expect(
      generarPdfComprobante(factura(), { formato: 'carta' as never }),
    ).rejects.toThrow('Formato de impresión no soportado');
    await expect(
      generarPdfComprobante(factura({ tipo: '09' as never }), {
        formato: 'a4',
      }),
    ).rejects.toThrow('Tipo de comprobante no soportado');
  });

  it('rendimiento: un comprobante normal se genera en menos de 300 ms (A4 y ticket)', async () => {
    await generarPdfComprobante(factura(), { formato: 'a4' });
    for (const formato of ['a4', 'ticket'] as const) {
      const inicio = process.hrtime.bigint();
      await generarPdfComprobante(factura(), { formato });
      const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
      expect(ms).toBeLessThan(300);
    }
  });
});
