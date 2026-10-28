import * as ExcelJS from 'exceljs';
import { inflateSync } from 'zlib';
import { codificarPng, imagenSoportada, reducirLogo } from './logo-emisor';
import { DatosProformaDocumento } from './proforma-documento';
import { generarProformaExcel } from './proforma-excel';
import { generarProformaPdf } from './proforma-pdf';
import { ITEMS_EN_TEXTO_WA, textoWhatsappProforma } from './proforma-whatsapp';

function datos(cambios: Partial<DatosProformaDocumento> = {}): DatosProformaDocumento {
  const items = [
    { sku: 'CEM-SOL-42', unidad_medida: 'BLS', descripcion: 'Cemento Sol Tipo I bolsa 42.5 kg', cantidad: 50, precio_unitario: 28.9, importe: 1445, descuento: 0 },
    { sku: 'FIE-8MM-9M', unidad_medida: 'NIU', descripcion: 'Fierro corrugado 8 mm x 9 m', cantidad: 120, precio_unitario: 18.5, importe: 2220, descuento: 0 },
  ];
  return {
    emisor: {
      ruc: '20610206337',
      razon_social: 'HATUNSALES S.A.C.',
      direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN',
      ubicacion: 'LURIN - LIMA - LIMA',
      telefono: '987654321',
      email: 'ventas@hatunsales.pe',
      web: 'https://www.hatunsales.pe',
      logo: null,
    },
    codigo: 'COT-000123',
    estado: 'enviada',
    fecha_emision: new Date('2026-09-24T15:00:00Z'),
    valida_hasta: '2099-10-01',
    cliente: { nombre: 'CONSTRUCTORA ANDINA DEL SUR S.A.C.', documento: '20512345678', direccion: 'AV. LOS CONSTRUCTORES 1520', telefono: '987654321', email: 'compras@andinasur.pe' },
    almacen: 'Almacén Lurín',
    items,
    total_gravada: 3105.93,
    total_igv: 559.07,
    total: 3665,
    porcentaje_igv: 18,
    observaciones: 'Entrega en obra.',
    cuentas: [
      { banco: 'BCP', tipo: 'corriente', numero: '19479681930096', cci: '002194171968193009695', moneda: 'PEN' },
      { banco: 'Yape', numero: '987654321', es_yape: true, titular: 'HATUNSALES SAC' },
    ],
    ...cambios,
  };
}

function itemsMuchos(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    sku: `ART-${i}`,
    unidad_medida: 'NIU',
    descripcion: `Producto de prueba ${i} con una descripción larga para forzar el salto de línea en la tabla`,
    cantidad: i + 1,
    precio_unitario: 10,
    importe: (i + 1) * 10,
    descuento: 0,
  }));
}

function paginasPdf(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;
}

interface TextoPdf {
  pagina: number;
  x: number;
  y: number;
  texto: string;
}

/**
 * Extrae el texto de un PDF generado por pdfkit (Helvetica, cadenas hexadecimales
 * en `[<...> n <...>] TJ`) con su posición, para comprobar contenido y orden.
 */
function textosDelPdf(pdf: Buffer): TextoPdf[] {
  const crudo = pdf.toString('latin1');
  const salida: TextoPdf[] = [];
  let pagina = 0;
  const flujos = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let flujo: RegExpExecArray | null;
  while ((flujo = flujos.exec(crudo))) {
    let contenido: string;
    try {
      contenido = inflateSync(Buffer.from(flujo[1], 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    if (!contenido.includes(' TJ')) continue;
    pagina++;
    const bloques = /BT\s+1 0 0 1 ([\d.-]+) ([\d.-]+) Tm([\s\S]*?)ET/g;
    let bloque: RegExpExecArray | null;
    while ((bloque = bloques.exec(contenido))) {
      const matriz = /\[([^\]]*)\]\s*TJ/.exec(bloque[3]);
      if (!matriz) continue;
      const texto = Array.from(matriz[1].matchAll(/<([0-9a-fA-F]*)>/g))
        .map((h) => Buffer.from(h[1], 'hex').toString('latin1'))
        .join('');
      salida.push({ pagina, x: Number(bloque[1]), y: Number(bloque[2]), texto });
    }
  }
  return salida;
}

function textoPlanoPdf(pdf: Buffer): string {
  return textosDelPdf(pdf).map((t) => t.texto).join('\n');
}

describe('textoWhatsappProforma', () => {
  const base = {
    razon_social: 'HATUNSALES S.A.C.',
    telefono_emisor: '987654321',
    codigo: 'COT-000123',
    cliente_nombre: 'CONSTRUCTORA ANDINA S.A.C.',
    es_empresa: true,
    valida_hasta: '2026-10-01',
    items: [{ descripcion: 'Cemento Sol', cantidad: 50, subtotal: 1445 }],
    total: 7130.6,
  };

  it('usa los mismos formatos que el documento (miles con coma y fecha dd/mm/aaaa)', () => {
    const texto = textoWhatsappProforma(base);
    expect(texto).toContain('S/ 7,130.60');
    expect(texto).toContain('S/ 1,445.00');
    expect(texto).toContain('01/10/2026');
    expect(texto).not.toContain('2026-10-01');
  });

  it('saluda distinto a una empresa y a una persona', () => {
    expect(textoWhatsappProforma(base)).toContain('Estimados señores de CONSTRUCTORA ANDINA S.A.C.:');
    expect(textoWhatsappProforma({ ...base, es_empresa: false, cliente_nombre: 'Ana Pérez' })).toContain('Estimado(a) Ana Pérez:');
    expect(textoWhatsappProforma({ ...base, cliente_nombre: null })).toContain('Estimado cliente:');
  });

  it('menciona el teléfono solo si está configurado', () => {
    expect(textoWhatsappProforma(base)).toContain('llámenos al 987 654 321');
    const sin = textoWhatsappProforma({ ...base, telefono_emisor: '' });
    expect(sin).not.toContain('llámenos');
    expect(sin).toContain('responda a este mensaje');
  });

  it('resume cuando hay más ítems de los que caben y no rompe el formato de WhatsApp', () => {
    const items = Array.from({ length: ITEMS_EN_TEXTO_WA + 3 }, (_, i) => ({ descripcion: `Prod *${i}*`, cantidad: 1, subtotal: 10 }));
    const texto = textoWhatsappProforma({ ...base, items });
    expect(texto).toContain('… y 3 ítem(s) más');
    expect(texto).not.toContain('Prod *');
  });
});

describe('generarProformaPdf', () => {
  it('genera un PDF válido de una página para una proforma normal', async () => {
    const pdf = await generarProformaPdf(datos());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(paginasPdf(pdf)).toBe(1);
  });

  it('pagina cuando hay muchos ítems', async () => {
    const pdf = await generarProformaPdf(datos({ items: itemsMuchos(60) }));
    expect(paginasPdf(pdf)).toBeGreaterThan(1);
  });

  it('no falla sin logo, sin contacto, sin cuentas ni observaciones, con caracteres raros y con descuentos', async () => {
    const pdf = await generarProformaPdf(
      datos({
        emisor: { ruc: '20610206337', razon_social: 'Empresa 😀 S.A.C.' },
        cuentas: [],
        observaciones: null,
        cliente: { nombre: null },
        items: [
          { descripcion: 'Producto 😀 con emoji', cantidad: 1.5, precio_unitario: 10, importe: 15, descuento: 2 },
          { descripcion: 'x'.repeat(400), sku: 'S'.repeat(60), cantidad: 1, precio_unitario: 1, importe: 1 },
        ],
      }),
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('funciona con la lista de productos vacía', async () => {
    const pdf = await generarProformaPdf(datos({ items: [] }));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  describe('orden de la referencia', () => {
    const CABECERAS = ['N°', 'Código', 'Unidad', 'P. Unit.', 'Cant.', 'Dto.', 'Descripción', 'Importe'];

    it('la tabla lleva las cabeceras en la secuencia N°, Código, Unidad, P. Unit., Cant., Dto., Descripción, Importe', async () => {
      const textos = textosDelPdf(await generarProformaPdf(datos()));
      const cabecera = textos.filter((t) => t.pagina === 1 && CABECERAS.includes(t.texto));
      expect(cabecera.map((t) => t.texto)).toEqual(CABECERAS);
      // Misma línea y de izquierda a derecha.
      expect(new Set(cabecera.map((t) => t.y)).size).toBe(1);
      const xs = cabecera.map((t) => t.x);
      expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    });

    it('Dto. aparece siempre: con S/ 0.00 sin descuentos y con el descuento de la línea cuando hay', async () => {
      const sin = textoPlanoPdf(await generarProformaPdf(datos()));
      expect(sin).toContain('Dto.');
      expect(sin).toContain('S/ 0.00');
      expect(sin).not.toContain('P. Lista');

      const con = textoPlanoPdf(
        await generarProformaPdf(
          datos({
            items: [{ descripcion: 'Con descuento', cantidad: 2, precio_unitario: 18.5, importe: 37, descuento: 1.5 }],
            total: 37,
            total_gravada: 31.36,
            total_igv: 5.64,
          }),
        ),
      );
      // P. Unit. = lista (18.50 + 1.50), Dto. = 1.50 × 2, Importe = 37.
      expect(con).toContain('S/ 20.00');
      expect(con).toContain('S/ 3.00');
      expect(con).toContain('S/ 37.00');
      expect(con).toContain('Descuento aplicado');
    });

    it('el cuadro de totales trae Subtotal, Op. gravada, IGV y TOTAL, y la nota de precios con IGV', async () => {
      const texto = textoPlanoPdf(await generarProformaPdf(datos()));
      const orden = ['Subtotal', 'Op. gravada', 'IGV (18%)', 'TOTAL'].map((t) => texto.indexOf(t));
      expect(orden.every((i) => i >= 0)).toBe(true);
      expect([...orden].sort((a, b) => a - b)).toEqual(orden);
      expect(texto).toContain('Precios unitarios con IGV incluido.');
      expect(texto).not.toContain('Importes en Soles');
      expect(texto).not.toContain('Descuento aplicado');
    });

    it('datos de la proforma: Estado siempre visible, Almacén de despacho y vigencia en días', async () => {
      const texto = textoPlanoPdf(await generarProformaPdf(datos({ valida_hasta: '2026-10-01' })));
      expect(texto).toContain('Estado:');
      expect(texto).toContain('Enviada');
      expect(texto).toContain('Almacén de despacho:');
      expect(texto).not.toContain('Despacho desde');
      expect(texto).toContain('01/10/2026 (7 días)');
      const filas = ['Fecha de emisión:', 'Válida hasta:', 'Moneda:', 'Estado:', 'Almacén de despacho:'];
      const posiciones = filas.map((f) => texto.indexOf(f));
      expect([...posiciones].sort((a, b) => a - b)).toEqual(posiciones);

      const borrador = textoPlanoPdf(await generarProformaPdf(datos({ estado: 'borrador' })));
      expect(borrador).toContain('Borrador');
    });

    it('datos del cliente: cliente, documento y teléfono antes que dirección y correo', async () => {
      const texto = textoPlanoPdf(await generarProformaPdf(datos()));
      const filas = ['Cliente:', 'RUC:', 'Teléfono:', 'Dirección:', 'Correo:'];
      const posiciones = filas.map((f) => texto.indexOf(f));
      expect(posiciones.every((i) => i >= 0)).toBe(true);
      expect([...posiciones].sort((a, b) => a - b)).toEqual(posiciones);
    });

    it('la primera condición dice «Proforma válida hasta el …» y no queda texto de la versión anterior', async () => {
      const texto = textoPlanoPdf(await generarProformaPdf(datos({ valida_hasta: '2099-10-01' })));
      expect(texto).toContain('Proforma válida hasta el 01/10/2099. Pasada esa fecha, los precios pueden variar.');
      expect(texto).toContain('Los precios están expresados en Soles (PEN) e incluyen IGV.');
      expect(texto).not.toContain('Oferta válida');
    });

    it('con 60 ítems sigue paginando y repite la cabecera de la tabla en cada hoja', async () => {
      const pdf = await generarProformaPdf(datos({ items: itemsMuchos(60) }));
      expect(paginasPdf(pdf)).toBeGreaterThan(1);
      const textos = textosDelPdf(pdf);
      const paginas = new Set(textos.filter((t) => t.texto === 'Importe').map((t) => t.pagina));
      expect(paginas.size).toBeGreaterThan(1);
    });
  });
});

describe('generarProformaExcel', () => {
  async function leer(d: DatosProformaDocumento) {
    const buffer = await generarProformaExcel(d);
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(buffer as any);
    return { buffer, hoja: libro.getWorksheet('Proforma')! };
  }

  it('genera un .xlsx con la hoja Proforma y el total correcto', async () => {
    const { buffer, hoja } = await leer(datos());
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    let total: unknown;
    hoja.eachRow((fila) => {
      fila.eachCell((celda) => {
        if (celda.value === 'TOTAL') {
          const valor = fila.getCell(8).value as any;
          total = typeof valor === 'object' ? valor.result : valor;
        }
      });
    });
    expect(total).toBe(3665);
  });

  const CABECERAS = ['N°', 'Código', 'Unidad', 'P. Unit.', 'Cant.', 'Dto.', 'Descripción', 'Importe'];

  function textosHoja(hoja: ExcelJS.Worksheet): string[] {
    const t: string[] = [];
    hoja.eachRow((f) => f.eachCell((c) => typeof c.value === 'string' && t.push(c.value)));
    return t;
  }

  it('la tabla lleva 8 columnas sin ocultar, en el orden de la referencia, y Dto. siempre visible', async () => {
    const itemConDescuento = { descripcion: 'Con descuento', cantidad: 2, precio_unitario: 18.5, importe: 37, descuento: 1.5 };
    for (const [d, conDescuento] of [
      [datos(), false],
      [
        datos({ items: [itemConDescuento], total: 37, total_gravada: 31.36, total_igv: 5.64 }),
        true,
      ],
    ] as Array<[DatosProformaDocumento, boolean]>) {
      const { hoja } = await leer(d);
      for (let c = 1; c <= 8; c++) expect(hoja.getColumn(c).hidden).toBeFalsy();
      let cabecera: string[] = [];
      hoja.eachRow((fila) => {
        const valores = [1, 2, 3, 4, 5, 6, 7, 8].map((c) => fila.getCell(c).value);
        if (valores.every((v, i) => v === CABECERAS[i])) cabecera = valores as string[];
      });
      expect(cabecera).toEqual(CABECERAS);
      // Nada queda apuntando a la antigua columna I.
      hoja.eachRow((fila) => expect(fila.getCell(9).value).toBeNull());
      if (!conDescuento) continue;
      let lineaOk = false;
      hoja.eachRow((fila) => {
        if (fila.getCell(7).value !== 'Con descuento') return;
        const importe = fila.getCell(8).value as any;
        lineaOk =
          fila.getCell(4).value === 20 &&
          fila.getCell(6).value === 3 &&
          (typeof importe === 'object' ? importe.result : importe) === 37 &&
          importe.formula === `D${fila.number}*E${fila.number}-F${fila.number}` &&
          fila.getCell(4).numFmt === '"S/ "#,##0.00';
      });
      expect(lineaOk).toBe(true);
    }
  });

  it('Dto. vale 0 sin descuentos y el cuadro trae Subtotal, Op. gravada, IGV y TOTAL en ese orden', async () => {
    const { hoja } = await leer(datos());
    hoja.eachRow((fila) => {
      if (fila.getCell(7).value === 'Cemento Sol Tipo I bolsa 42.5 kg') expect(fila.getCell(6).value).toBe(0);
    });
    const textos = textosHoja(hoja);
    const orden = ['Subtotal', 'Op. gravada', 'IGV (18%)', 'TOTAL'].map((t) => textos.indexOf(t));
    expect(orden.every((i) => i >= 0)).toBe(true);
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
    expect(textos).toContain('Precios unitarios con IGV incluido.');
    expect(textos).not.toContain('Descuento aplicado');
  });

  it('con descuento agrega la fila Descuento aplicado antes del Subtotal', async () => {
    const { hoja } = await leer(
      datos({
        items: [{ descripcion: 'Con descuento', cantidad: 2, precio_unitario: 18.5, importe: 37, descuento: 1.5 }],
        total: 37,
        total_gravada: 31.36,
        total_igv: 5.64,
      }),
    );
    const textos = textosHoja(hoja);
    expect(textos.indexOf('Descuento aplicado')).toBeGreaterThan(-1);
    expect(textos.indexOf('Descuento aplicado')).toBeLessThan(textos.indexOf('Subtotal'));
  });

  it('datos de la proforma: Fecha de emisión, Válida hasta (N días), Moneda, Estado y Almacén de despacho', async () => {
    const textos = async (estado: string) => textosHoja((await leer(datos({ estado, valida_hasta: '2099-10-01' }))).hoja).join('|');
    const enviada = await textos('enviada');
    expect(enviada).toContain('Estado:');
    expect(enviada).toContain('Enviada');
    expect(enviada).toContain('Fecha de emisión:');
    expect(enviada).toContain('Almacén de despacho:');
    expect(enviada).not.toMatch(/Despacho desde|Emisión:\|/);
    expect(enviada).toMatch(/01\/10\/2099 \(\d+ días\)/);
    expect(await textos('borrador')).toContain('Borrador');
    expect(await textos('anulada')).toContain('Anulada');
    expect(enviada).toContain('Proforma válida hasta el 01/10/2099. Pasada esa fecha, los precios pueden variar.');
  });

  it('no falla sin contacto ni cuentas', async () => {
    const { buffer } = await leer(datos({ emisor: { ruc: '1', razon_social: 'X' }, cuentas: [] }));
    expect(buffer.length).toBeGreaterThan(1000);
  });
});

describe('generarProformaExcel: logo', () => {
  async function imagenesDeLaHoja(logo: Buffer) {
    const d = datos();
    d.emisor = { ...d.emisor!, logo };
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await generarProformaExcel(d)) as any);
    return wb.worksheets[0].getImages();
  }

  it('dibuja el logo con su proporción real, sin deformarlo, dentro de la caja de 120x80', async () => {
    for (const [ancho, alto] of [[600, 300], [300, 300], [300, 600], [680, 555]]) {
      const rgba = Buffer.alloc(ancho * alto * 4, 255);
      const imagenes = await imagenesDeLaHoja(codificarPng(rgba, ancho, alto));
      expect(imagenes).toHaveLength(1);
      const rango: any = imagenes[0].range;
      // ExcelJS devuelve la medida en EMU (9525 por píxel) cuando el ancla es de una sola celda.
      const w = Number(rango.ext?.width ?? rango.ext?.cx / 9525);
      const h = Number(rango.ext?.height ?? rango.ext?.cy / 9525);
      expect(w).toBeLessThanOrEqual(120.5);
      expect(h).toBeLessThanOrEqual(80.5);
      expect(w / h).toBeCloseTo(ancho / alto, 1);
    }
  });
});

describe('reducirLogo', () => {
  function pngSintetico(ancho: number, alto: number): Buffer {
    const rgba = Buffer.alloc(ancho * alto * 4);
    for (let y = 0; y < alto; y++) {
      for (let x = 0; x < ancho; x++) {
        const i = (y * ancho + x) * 4;
        rgba[i] = (x * 255) / ancho;
        rgba[i + 1] = (y * 255) / alto;
        rgba[i + 2] = ((x + y) * 7) & 255;
        rgba[i + 3] = x < 20 ? 0 : 255; // franja transparente
      }
    }
    return codificarPng(rgba, ancho, alto);
  }

  it('reduce un PNG grande a 420 px de ancho sin perder la validez', async () => {
    const original = pngSintetico(1200, 800);
    expect(imagenSoportada(original)).toBe(true);
    const reducido = await reducirLogo(original);
    expect(reducido.length).toBeLessThan(original.length);
    expect(imagenSoportada(reducido)).toBe(true);
    expect(reducido.readUInt32BE(16)).toBe(420);
    expect(reducido.readUInt32BE(20)).toBe(280);
    // Genera y reduce casi un millón de píxeles en JS puro: con el CPU ocupado (suite completa) pasa de los 5 s por defecto.
  }, 30_000);

  it('deja intacto un PNG que ya es pequeño y lo que no es PNG', async () => {
    const chico = pngSintetico(200, 100);
    expect(await reducirLogo(chico)).toBe(chico);
    const raro = Buffer.from('no soy una imagen');
    expect(await reducirLogo(raro)).toBe(raro);
  });
});
