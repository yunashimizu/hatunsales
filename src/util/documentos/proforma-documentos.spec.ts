import * as ExcelJS from 'exceljs';
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
          const valor = fila.getCell(9).value as any;
          total = typeof valor === 'object' ? valor.result : valor;
        }
      });
    });
    expect(total).toBe(3665);
  });

  it('oculta las columnas de descuento cuando no hay descuentos y las muestra cuando sí', async () => {
    const sin = await leer(datos());
    expect(sin.hoja.getColumn(6).hidden).toBe(true);
    expect(sin.hoja.getColumn(7).hidden).toBe(true);

    const con = await leer(
      datos({
        items: [{ descripcion: 'Con descuento', cantidad: 2, precio_unitario: 18.5, importe: 37, descuento: 1.5 }],
        total: 37,
        total_gravada: 31.36,
        total_igv: 5.64,
      }),
    );
    expect(con.hoja.getColumn(6).hidden).toBeFalsy();
    let listaOk = false;
    con.hoja.eachRow((fila) => {
      if (fila.getCell(3).value === 'Con descuento') listaOk = fila.getCell(6).value === 20 && fila.getCell(7).value === 1.5;
    });
    expect(listaOk).toBe(true);
  });

  it('no imprime el estado interno al cliente, pero sí avisa si está anulada', async () => {
    const textos = async (estado: string) => {
      const { hoja } = await leer(datos({ estado }));
      const t: string[] = [];
      hoja.eachRow((f) => f.eachCell((c) => typeof c.value === 'string' && t.push(c.value)));
      return t.join('|');
    };
    expect(await textos('enviada')).not.toMatch(/Enviada|Estado:/);
    expect(await textos('anulada')).toContain('ANULADA');
  });

  it('no falla sin contacto ni cuentas', async () => {
    const { buffer } = await leer(datos({ emisor: { ruc: '1', razon_social: 'X' }, cuentas: [] }));
    expect(buffer.length).toBeGreaterThan(1000);
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
  });

  it('deja intacto un PNG que ya es pequeño y lo que no es PNG', async () => {
    const chico = pngSintetico(200, 100);
    expect(await reducirLogo(chico)).toBe(chico);
    const raro = Buffer.from('no soy una imagen');
    expect(await reducirLogo(raro)).toBe(raro);
  });
});
