import {
  AVISO_BETA_PDF,
  generarPdfComprobante,
  type DatosPdfComprobante,
} from './comprobante-pdf';

/**
 * PARIDAD CON LA HOJA DEL FRONT.
 *
 * La vista previa del POS y el detalle del comprobante (front `ferreteria`, componente
 * `hoja-comprobante`) copian los rótulos de este PDF A4. Esta prueba fija la lista del lado del
 * back: si alguien cambia un rótulo del PDF, falla aquí; y el spec de la hoja del front
 * (`hoja-comprobante.component.spec.ts`) lleva la MISMA lista, para que falle si se cambia solo
 * un lado. Al tocar una, tocar la otra.
 *
 * Fuente de los rótulos: `comprobante-pdf.ts` (`dibujarA4` y sus pasos).
 */
export const ROTULOS_PDF_A4 = {
  /** Recuadro del documento. */
  documento: ['R.U.C. N°'],
  /** Caja cliente / documento: el PDF imprime las etiquetas en MAYÚSCULAS (la hoja puede usar CSS `text-transform`). */
  cliente: ['RAZÓN SOCIAL', 'DIRECCIÓN', 'FECHA DE EMISIÓN', 'FECHA DE VENCIMIENTO', 'MONEDA', 'FORMA DE PAGO'],
  clienteSinNombre: ['CLIENTES VARIOS', 'Sin documento'],
  /** Cabecera de la tabla, en este orden. */
  columnas: ['CANT.', 'UNIDAD', 'DESCRIPCIÓN', 'V. UNIT.', 'P. UNIT.', 'DESC.', 'IMPORTE'],
  /** Totales (exonerada e inafecta salen aunque valgan cero). */
  totales: ['Op. gravada', 'Op. exonerada', 'Op. inafecta', 'Descuentos', 'IGV (18%)', 'IMPORTE TOTAL'],
  credito: ['FORMA DE PAGO: CRÉDITO', 'Monto neto pendiente de pago', 'CUOTA', 'FECHA DE PAGO', 'MONTO'],
  notas: ['MEDIO DE PAGO', 'OBSERVACIONES'],
  qr: ['Resumen (hash)', 'Representación impresa de la Factura Electrónica'],
  qrSinFirma: ['Código QR no disponible: el comprobante aún no tiene firma electrónica.'],
  codigoProducto: ['Cód.'],
  pie: ['Página 1 de 1'],
  beta: ['PRUEBA SUNAT BETA - SIN VALIDEZ TRIBUTARIA'],
  /**
   * Plan «Documentos oro y detalle» §2 (M1–M5, M7–M9): filas que salen solo si hay dato, cantidad de ítems,
   * estado aceptado y pie. MISMA lista literal que `ROTULOS_DETALLE` del spec de la hoja (allá se compara sin
   * distinguir mayúsculas: la hoja pone las etiquetas en mayúsculas con CSS).
   */
  detalle: [
    'HORA',
    'CORREO',
    'GUÍA DE REMISIÓN',
    'ATENDIDO POR',
    'SUCURSAL',
    '1 ítem',
    'Aceptado por SUNAT',
    'Gracias por su preferencia',
  ],
} as const;

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
  return Array.from(Buffer.from(hex, 'hex'), (b) => WIN_ANSI[b] ?? String.fromCharCode(b)).join('');
}

/** Todo el texto de un PDF generado con comprimir:false, en una sola línea. */
function textoDelPdf(pdf: Buffer): string {
  const crudo = pdf.toString('latin1');
  const lineas: string[] = [];
  for (const [, flujo] of crudo.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    if (!/\]\s*TJ/.test(flujo)) continue;
    for (const [, arreglo] of flujo.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      lineas.push(Array.from(arreglo.matchAll(/<([0-9a-fA-F]*)>/g), ([, hex]) => decodificar(hex)).join(''));
    }
  }
  return lineas.join(' ');
}

function factura(parcial: Partial<DatosPdfComprobante> = {}): DatosPdfComprobante {
  return {
    emisor: {
      ruc: '20610206337',
      razonSocial: 'HATUNSALES S.A.C.',
      nombreComercial: 'HatunSales Ferretería',
      direccion: 'Av. Los Próceres 1234',
      ubicacion: 'LIMA - LIMA - LURIN',
      telefono: '01 555-1234',
      email: 'ventas@hatunsales.pe',
      logo: null,
    },
    tipo: '01',
    serie: 'F001',
    numero: 123,
    fechaEmision: '21/10/2026',
    horaEmision: '14:35:10',
    fechaVencimiento: '20/11/2026',
    moneda: 'PEN',
    cliente: {
      tipoDoc: '6',
      numDoc: '20100070970',
      nombre: 'SUPERMERCADOS PERUANOS SOCIEDAD ANONIMA',
      direccion: 'Calle Morelli 181, San Borja, Lima',
    },
    referencia: null,
    items: [
      {
        codigo: 'CEM-001',
        unidad: 'NIU',
        descripcion: 'CEMENTO SOL TIPO I 42.5 KG',
        cantidad: 10,
        valorUnitario: 25.423729,
        precioUnitario: 30,
        descuento: 15,
        importe: 285,
      },
    ],
    totales: { gravada: 241.53, exonerada: 0, inafecta: 0, descuentos: 15, igv: 43.47, porcentajeIgv: 18, total: 285 },
    importeEnLetras: 'SON: DOSCIENTOS OCHENTA Y CINCO CON 00/100 SOLES',
    formaPago: { tipo: 'Credito', cuotas: [{ numero: 1, monto: 285, fechaPago: '20/11/2026' }] },
    observaciones: 'Entrega en obra',
    medioPago: 'Efectivo',
    cadenaQr: '20610206337|01|F001|00000123|43.47|285.00|2026-10-21|6|20100070970|q8ZqH0n0zG5m6Yy0ZkzQb2s5bWc=|',
    codigoHash: 'q8ZqH0n0zG5m6Yy0ZkzQb2s5bWc=',
    ambiente: 'beta',
    avisoEstado: null,
    ...parcial,
  };
}

function generarA4(datos: DatosPdfComprobante): Promise<Buffer> {
  return generarPdfComprobante(datos, { formato: 'a4', comprimir: false });
}

describe('paridad del PDF A4 con la hoja de la vista previa: rótulos fijos', () => {
  it('factura a crédito en BETA con descuento, medio de pago y observaciones: trae todos los rótulos de la hoja', async () => {
    const t = textoDelPdf(await generarA4(factura()));

    const esperados = [
      ...ROTULOS_PDF_A4.documento,
      ...ROTULOS_PDF_A4.cliente,
      ...ROTULOS_PDF_A4.columnas,
      ...ROTULOS_PDF_A4.totales,
      ...ROTULOS_PDF_A4.credito,
      ...ROTULOS_PDF_A4.notas,
      ...ROTULOS_PDF_A4.qr,
      ...ROTULOS_PDF_A4.codigoProducto,
      ...ROTULOS_PDF_A4.pie,
      ...ROTULOS_PDF_A4.beta,
    ];
    for (const rotulo of esperados) expect(t).toContain(rotulo);
  });

  it('el banner BETA es el texto exacto exportado por el PDF y sale con ambiente beta, no en producción', async () => {
    expect(AVISO_BETA_PDF).toBe(ROTULOS_PDF_A4.beta[0]);
    const beta = textoDelPdf(await generarA4(factura({ ambiente: 'beta' })));
    const produccion = textoDelPdf(await generarA4(factura({ ambiente: 'produccion' })));

    expect(beta).toContain('PRUEBA SUNAT BETA - SIN VALIDEZ TRIBUTARIA');
    expect(produccion).not.toContain('PRUEBA SUNAT BETA');
  });

  it('las columnas de la tabla salen en el orden de la hoja', async () => {
    const t = textoDelPdf(await generarA4(factura()));

    const posiciones = ROTULOS_PDF_A4.columnas.map((columna) => t.indexOf(columna));
    expect(posiciones.every((p) => p >= 0)).toBe(true);
    expect([...posiciones].sort((a, b) => a - b)).toEqual(posiciones);
  });

  it('Op. exonerada y Op. inafecta salen siempre, aunque valgan cero; Descuentos solo si hay', async () => {
    const sinDescuento = textoDelPdf(
      await generarA4(
        factura({
          formaPago: { tipo: 'Contado' },
          totales: { gravada: 254.24, exonerada: 0, inafecta: 0, descuentos: 0, igv: 45.76, porcentajeIgv: 18, total: 300 },
        }),
      ),
    );

    expect(sinDescuento).toContain('Op. exonerada');
    expect(sinDescuento).toContain('Op. inafecta');
    expect(sinDescuento).not.toContain('Descuentos');
    expect(sinDescuento).not.toContain('FORMA DE PAGO: CRÉDITO');
  });

  it('consumidor final: «CLIENTES VARIOS» y «Documento: Sin documento»', async () => {
    const t = textoDelPdf(
      await generarA4(
        factura({
          tipo: '03',
          serie: 'B001',
          fechaVencimiento: null,
          formaPago: { tipo: 'Contado' },
          cliente: { tipoDoc: '0', numDoc: '-', nombre: '', direccion: null },
        }),
      ),
    );

    for (const rotulo of ROTULOS_PDF_A4.clienteSinNombre) expect(t).toContain(rotulo);
    expect(t).toMatch(/CLIENTE CLIENTES VARIOS/); // etiqueta del bloque (no «RAZÓN SOCIAL»: no hay RUC)
    expect(t).not.toContain('RAZÓN SOCIAL');
    expect(t).not.toContain('FECHA DE VENCIMIENTO');
  });

  it('más detalle (M1–M9): hora, correo, guía, atendido por, sucursal, ítems, aceptado y pie, solo si hay dato', async () => {
    const con = textoDelPdf(
      await generarA4(
        factura({
          cliente: { ...factura().cliente, email: 'compras@spsa.pe' },
          guiaRemision: 'T001-00000045',
          atendidoPor: 'Ana Quispe',
          sucursal: 'Tienda Cusco',
          aceptadoSunat: { fecha: '21/10/2026 14:36' },
        }),
      ),
    );
    for (const rotulo of ROTULOS_PDF_A4.detalle) expect(con).toContain(rotulo);
    expect(con).toContain('compras@spsa.pe');
    expect(con).toContain('T001-00000045');
    expect(con).toContain('Aceptado por SUNAT · 21/10/2026 14:36');

    const sin = textoDelPdf(await generarA4(factura({ horaEmision: null })));
    for (const rotulo of ['HORA', 'CORREO', 'GUÍA DE REMISIÓN', 'ATENDIDO POR', 'SUCURSAL', 'Aceptado por SUNAT'])
      expect(sin).not.toContain(rotulo);
    expect(sin).toContain('1 ítem');
    expect(sin).toContain('Gracias por su preferencia');
  });

  it('sin firma electrónica el QR se reemplaza por la casilla de «no disponible»', async () => {
    const t = textoDelPdf(await generarA4(factura({ cadenaQr: null, codigoHash: null })));

    for (const rotulo of ROTULOS_PDF_A4.qrSinFirma) expect(t).toContain(rotulo);
  });
});
