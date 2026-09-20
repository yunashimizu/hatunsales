import { montoEnLetras } from '../fiscal/numero-letras';
import {
  condicionesComerciales,
  cuentasUtiles,
  DatosProformaDocumento,
  describirCuenta,
  estadoParaDocumento,
  etiquetaDocumento,
  formatearCantidad,
  formatearFecha,
  formatearFechaHora,
  formatearPorcentaje,
  formatearSoles,
  LEYENDA_SIN_VALOR_TRIBUTARIO,
  numeroSeguro,
  textoMultilinea,
  textoPlano,
} from './proforma-documento';

// pdfkit no trae tipos en este proyecto (mismo uso que en reportes).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require('pdfkit');

/**
 * Proforma en PDF (A4) con pdfkit.
 *
 * Todo el texto se escribe línea por línea con `lineBreak: false`: los saltos
 * de línea y de página los decide este archivo, nunca pdfkit. Así ninguna
 * fila, total o pie puede quedar partido o encimado por un salto automático.
 */

const MARGEN = 40;
/** Franja inferior reservada para el pie de página. */
const ALTO_PIE = 36;

const COLOR = {
  marca: '#0F4C5C',
  cuentas: '#174A9B',
  marcaSuave: '#E7F0F2',
  texto: '#1F2933',
  gris: '#52606D',
  grisClaro: '#7B8794',
  linea: '#D3D9DF',
  fondo: '#F6F8FA',
  cebra: '#F3F6F8',
  blanco: '#FFFFFF',
  anulada: '#B42318',
};

type Fuente = 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Helvetica-BoldOblique';
type Alineacion = 'left' | 'right' | 'center';

interface Columna {
  titulo: string;
  ancho: number;
  alinear: Alineacion;
}

/** Caracteres extra (fuera de Latin-1) que existen en la codificación WinAnsi. */
const WIN_ANSI_EXTRA = new Set(Array.from('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'));

function caracterWinAnsi(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(ch);
}

/**
 * Deja solo caracteres que Helvetica (WinAnsi) puede dibujar: las tildes y la
 * ñ pasan tal cual; letras de otros alfabetos pierden el acento y los emojis o
 * símbolos no representables se descartan.
 */
export function textoPdf(valor: unknown): string {
  const plano = textoPlano(valor).normalize('NFC');
  let salida = '';
  for (const ch of plano) {
    if (caracterWinAnsi(ch)) {
      salida += ch;
      continue;
    }
    const sinAcento = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (sinAcento && Array.from(sinAcento).every(caracterWinAnsi)) salida += sinAcento;
  }
  return salida.replace(/\s+/g, ' ').trim();
}

function formatearTelefono(valor?: string | null): string {
  const d = String(valor ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('51')) return `+51 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  if (d.length === 9) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  return textoPlano(valor);
}

export function generarProformaPdf(datos: DatosProformaDocumento): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: MARGEN, bottom: MARGEN, left: MARGEN, right: MARGEN },
        bufferPages: true,
        info: {
          Title: `Proforma ${textoPdf(datos.codigo)}`,
          Author: textoPdf(datos.emisor?.razon_social),
          Subject: 'Proforma comercial',
          Creator: 'HatunSales',
        },
      });
      const partes: Buffer[] = [];
      doc.on('data', (parte: Buffer) => partes.push(parte));
      doc.on('end', () => resolve(Buffer.concat(partes)));
      doc.on('error', (error: unknown) => reject(error));

      new DibujoProforma(doc, datos).dibujar();
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

class DibujoProforma {
  private y = MARGEN;
  private readonly ancho: number;
  private readonly izquierda = MARGEN;
  private readonly columnas: Columna[];
  private readonly codigo: string;
  private readonly razonSocial: string;
  private readonly generadoEn: Date;

  constructor(
    private readonly doc: any,
    private readonly d: DatosProformaDocumento,
  ) {
    this.ancho = doc.page.width - MARGEN * 2;
    this.codigo = textoPdf(d.codigo) || '—';
    this.razonSocial = textoPdf(d.emisor?.razon_social) || 'HATUNSALES S.A.C.';
    this.generadoEn = d.generado_en ?? new Date();

    const fijas: Columna[] = [
      { titulo: 'N°', ancho: 24, alinear: 'center' },
      { titulo: 'Código', ancho: 58, alinear: 'left' },
      { titulo: 'Unidad', ancho: 42, alinear: 'center' },
      { titulo: 'P. Unit.', ancho: 62, alinear: 'right' },
      { titulo: 'Cant.', ancho: 42, alinear: 'right' },
      { titulo: 'Dto.', ancho: 48, alinear: 'right' },
      { titulo: 'Descripción', ancho: 0, alinear: 'left' },
      { titulo: 'Importe', ancho: 72, alinear: 'right' },
    ];
    const ocupado = fijas.reduce((suma, c) => suma + c.ancho, 0);
    fijas[6].ancho = this.ancho - ocupado;
    this.columnas = fijas;
  }

  dibujar(): void {
    this.cabecera();
    this.datosGenerales();
    this.tabla();
    this.totales();
    this.cuentasBancarias();
    this.observaciones();
    this.condiciones();
    this.pies();
  }

  // ── Primitivas de texto ─────────────────────────────────────────

  private estilo(fuente: Fuente, tam: number, color: string): void {
    this.doc.font(fuente).fontSize(tam).fillColor(color);
  }

  private interlineado(tam: number): number {
    return tam * 1.25;
  }

  /** Escribe UNA línea (sin salto automático) alineada dentro de `ancho`. */
  private linea(texto: string, x: number, y: number, ancho?: number, alinear: Alineacion = 'left'): void {
    if (!texto) return;
    let xx = x;
    if (ancho !== undefined && alinear !== 'left') {
      const w = this.doc.widthOfString(texto);
      xx = alinear === 'right' ? x + ancho - w : x + (ancho - w) / 2;
    }
    this.doc.text(texto, xx, y, { lineBreak: false });
  }

  /** Parte un texto en líneas que caben en `ancho` con la fuente actual. */
  private envolver(texto: string, ancho: number): string[] {
    const limpio = textoPdf(texto);
    if (!limpio) return [];
    const lineas: string[] = [];
    let actual = '';
    for (const palabra of limpio.split(' ')) {
      const prueba = actual ? `${actual} ${palabra}` : palabra;
      if (this.doc.widthOfString(prueba) <= ancho) {
        actual = prueba;
        continue;
      }
      if (actual) lineas.push(actual);
      actual = '';
      if (this.doc.widthOfString(palabra) <= ancho) {
        actual = palabra;
        continue;
      }
      // Palabra más ancha que la columna (p. ej. un código largo): se corta.
      let trozo = '';
      for (const ch of palabra) {
        if (trozo && this.doc.widthOfString(trozo + ch) > ancho) {
          lineas.push(trozo);
          trozo = ch;
        } else {
          trozo += ch;
        }
      }
      actual = trozo;
    }
    if (actual) lineas.push(actual);
    return lineas;
  }

  /** Recorta con "…" para que quepa en una línea. */
  private recortar(texto: string, ancho: number): string {
    if (this.doc.widthOfString(texto) <= ancho) return texto;
    let recorte = texto;
    while (recorte.length > 1 && this.doc.widthOfString(`${recorte}…`) > ancho) {
      recorte = recorte.slice(0, -1);
    }
    return `${recorte.trimEnd()}…`;
  }

  // ── Paginación ──────────────────────────────────────────────────

  private get limiteInferior(): number {
    return this.doc.page.height - MARGEN - ALTO_PIE;
  }

  private cabe(alto: number): boolean {
    return this.y + alto <= this.limiteInferior;
  }

  private nuevaPagina(): void {
    this.doc.addPage();
    this.y = MARGEN;
    this.cabeceraContinuacion();
  }

  /** Salta de página si el bloque no entra completo en lo que queda. */
  private asegurar(alto: number): boolean {
    if (this.cabe(alto)) return false;
    this.nuevaPagina();
    return true;
  }

  // ── Cabecera ────────────────────────────────────────────────────

  private cabecera(): void {
    const doc = this.doc;
    const top = MARGEN;
    const cajaAncho = 184;
    const cajaAlto = 86;
    const cajaX = this.izquierda + this.ancho - cajaAncho;
    const anchoIzquierda = this.ancho - cajaAncho - 18;

    let xTexto = this.izquierda;
    let altoLogo = 0;
    if (this.d.emisor?.logo) {
      try {
        doc.image(this.d.emisor.logo, this.izquierda, top, { fit: [74, 74], valign: 'center' });
        xTexto = this.izquierda + 86;
        altoLogo = 74;
      } catch {
        // Logo ilegible: el documento sigue sin logo.
      }
    }
    const anchoTexto = anchoIzquierda - (xTexto - this.izquierda);

    let y = top + 4;
    this.estilo('Helvetica-Bold', 14, COLOR.marca);
    for (const l of this.envolver(this.razonSocial, anchoTexto).slice(0, 3)) {
      this.linea(l, xTexto, y);
      y += this.interlineado(14);
    }
    y += 2;
    this.estilo('Helvetica', 8.5, COLOR.gris);
    const direccion = [this.d.emisor?.direccion, this.d.emisor?.ubicacion]
      .map((t) => textoPdf(t))
      .filter(Boolean);
    for (const parte of direccion) {
      for (const l of this.envolver(parte, anchoTexto).slice(0, 3)) {
        this.linea(l, xTexto, y);
        y += this.interlineado(8.5);
      }
    }

    // Recuadro "R.U.C. / PROFORMA / código" al estilo de los documentos peruanos.
    doc.save();
    doc.rect(cajaX, top + 30, cajaAncho, 23).fill(COLOR.marca);
    doc.restore();
    doc.save();
    doc.lineWidth(1.3).strokeColor(COLOR.marca).roundedRect(cajaX, top, cajaAncho, cajaAlto, 5).stroke();
    doc.restore();

    this.estilo('Helvetica-Bold', 11, COLOR.texto);
    this.linea(`R.U.C. ${textoPdf(this.d.emisor?.ruc) || '—'}`, cajaX, top + 11, cajaAncho, 'center');
    // Centrado manual incluyendo el espaciado entre letras.
    this.estilo('Helvetica-Bold', 12.5, COLOR.blanco);
    const anchoTitulo = doc.widthOfString('PROFORMA', { characterSpacing: 2 });
    doc.text('PROFORMA', cajaX + (cajaAncho - anchoTitulo) / 2, top + 36, {
      lineBreak: false,
      characterSpacing: 2,
    });

    this.estilo('Helvetica-Bold', 15, COLOR.marca);
    const codigo = this.recortar(this.codigo, cajaAncho - 12);
    this.linea(codigo, cajaX, top + 62, cajaAncho, 'center');

    this.y = Math.max(y, top + altoLogo, top + cajaAlto) + 14;
  }

  /** Encabezado compacto en las páginas 2 en adelante. */
  private cabeceraContinuacion(): void {
    const top = MARGEN;
    this.estilo('Helvetica-Bold', 9, COLOR.marca);
    const derecha = `PROFORMA ${this.codigo}`;
    const anchoDerecha = this.doc.widthOfString(derecha);
    this.linea(derecha, this.izquierda, top, this.ancho, 'right');
    this.linea(this.recortar(this.razonSocial, this.ancho - anchoDerecha - 20), this.izquierda, top);
    this.estilo('Helvetica', 7.5, COLOR.grisClaro);
    this.linea('(continuación)', this.izquierda, top + 12, this.ancho, 'right');
    this.doc.save();
    this.doc.moveTo(this.izquierda, top + 24).lineTo(this.izquierda + this.ancho, top + 24)
      .lineWidth(0.8).strokeColor(COLOR.marca).stroke();
    this.doc.restore();
    this.y = top + 34;
  }

  // ── Datos del cliente y de la proforma ──────────────────────────

  private datosGenerales(): void {
    const doc = this.doc;
    const pad = 10;
    const separacion = 20;
    const colAncho = (this.ancho - pad * 2 - separacion) / 2;
    const etiquetaIzq = 56;
    const etiquetaDer = 96;
    const tamValor = 8.5;
    const altoLinea = this.interlineado(tamValor);

    const cliente = this.d.cliente ?? {};
    const documento = textoPdf(cliente.documento);
    const izquierda: Array<[string, string]> = [['Cliente', textoPdf(cliente.nombre) || '—']];
    if (documento) izquierda.push([etiquetaDocumento(documento), documento]);
    if (textoPdf(cliente.direccion)) izquierda.push(['Dirección', textoPdf(cliente.direccion)]);
    if (formatearTelefono(cliente.telefono)) izquierda.push(['Teléfono', formatearTelefono(cliente.telefono)]);
    if (textoPdf(cliente.email)) izquierda.push(['Correo', textoPdf(cliente.email)]);

    const derecha: Array<[string, string]> = [
      ['Fecha de emisión', formatearFecha(this.d.fecha_emision) || '—'],
    ];
    const valida = formatearFecha(this.d.valida_hasta ?? null);
    if (valida) derecha.push(['Válida hasta', valida]);
    derecha.push(['Moneda', 'Soles (PEN)']);
    derecha.push(['Estado', estadoParaDocumento(this.d.estado, this.d.valida_hasta, this.generadoEn)]);
    if (textoPdf(this.d.almacen)) derecha.push(['Almacén de despacho', textoPdf(this.d.almacen)]);

    this.estilo('Helvetica', tamValor, COLOR.texto);
    const preparar = (filas: Array<[string, string]>, anchoEtiqueta: number) =>
      filas.map(([etiqueta, valor]) => ({
        etiqueta,
        lineas: (this.envolver(valor, colAncho - anchoEtiqueta).slice(0, 4)),
      }));
    const bloqueIzq = preparar(izquierda, etiquetaIzq);
    const bloqueDer = preparar(derecha, etiquetaDer);
    const altoBloque = (b: Array<{ lineas: string[] }>) =>
      b.reduce((s, f) => s + Math.max(1, f.lineas.length) * altoLinea + 2.5, 0);

    const altoTitulo = 16;
    const alto = pad + altoTitulo + Math.max(altoBloque(bloqueIzq), altoBloque(bloqueDer)) + pad - 2;
    this.asegurar(alto + 12);
    const top = this.y;

    doc.save();
    doc.lineWidth(0.8).fillColor(COLOR.fondo).strokeColor(COLOR.linea)
      .roundedRect(this.izquierda, top, this.ancho, alto, 5).fillAndStroke();
    doc.restore();
    const xDerecha = this.izquierda + pad + colAncho + separacion;
    doc.save();
    doc.moveTo(xDerecha - separacion / 2, top + pad)
      .lineTo(xDerecha - separacion / 2, top + alto - pad)
      .lineWidth(0.6).strokeColor(COLOR.linea).stroke();
    doc.restore();

    const dibujarColumna = (
      titulo: string,
      bloque: Array<{ etiqueta: string; lineas: string[] }>,
      x: number,
      anchoEtiqueta: number,
    ) => {
      let y = top + pad;
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(COLOR.marca);
      doc.text(titulo, x, y, { lineBreak: false, characterSpacing: 0.8 });
      y += altoTitulo;
      for (const fila of bloque) {
        this.estilo('Helvetica-Bold', 8, COLOR.gris);
        this.linea(`${fila.etiqueta}:`, x, y + 0.5);
        this.estilo('Helvetica', tamValor, COLOR.texto);
        const lineas = fila.lineas.length ? fila.lineas : ['—'];
        lineas.forEach((l, i) => this.linea(l, x + anchoEtiqueta, y + i * altoLinea));
        y += lineas.length * altoLinea + 2.5;
      }
    };

    dibujarColumna('DATOS DEL CLIENTE', bloqueIzq, this.izquierda + pad, etiquetaIzq);
    dibujarColumna('DATOS DE LA PROFORMA', bloqueDer, xDerecha, etiquetaDer);

    this.y = top + alto + 14;
  }

  // ── Tabla de ítems ──────────────────────────────────────────────

  private cabeceraTabla(): void {
    const doc = this.doc;
    const alto = 20;
    doc.save();
    doc.rect(this.izquierda, this.y, this.ancho, alto).fill(COLOR.marca);
    doc.restore();
    this.estilo('Helvetica-Bold', 8, COLOR.blanco);
    let x = this.izquierda;
    for (const col of this.columnas) {
      this.linea(col.titulo, x + 5, this.y + 6.5, col.ancho - 10, col.alinear);
      x += col.ancho;
    }
    this.y += alto;
  }

  private tabla(): void {
    const doc = this.doc;
    const tam = 8.5;
    const altoLinea = this.interlineado(tam);
    const padX = 5;
    const padY = 5.5;
    const items = this.d.items ?? [];

    // La cabecera de la tabla nunca queda sola al final de una página.
    this.asegurar(20 + 24);
    this.cabeceraTabla();

    if (!items.length) {
      this.estilo('Helvetica-Oblique', tam, COLOR.grisClaro);
      this.linea('La proforma no tiene productos.', this.izquierda + padX, this.y + padY);
      this.y += 22;
      return;
    }

    items.forEach((item, indice) => {
      this.estilo('Helvetica', tam, COLOR.texto);
      const lineasDesc = this.envolver(item.descripcion || 'Producto', this.columnas[6].ancho - padX * 2);
      const lineasSku = this.envolver(item.sku || '—', this.columnas[1].ancho - padX * 2);
      const lineas = Math.max(1, lineasDesc.length, lineasSku.length);
      const alto = Math.max(20, lineas * altoLinea + padY * 2 - 2);

      if (!this.cabe(alto)) {
        this.nuevaPagina();
        this.cabeceraTabla();
      }

      const top = this.y;
      if (indice % 2 === 1) {
        doc.save();
        doc.rect(this.izquierda, top, this.ancho, alto).fill(COLOR.cebra);
        doc.restore();
      }
      doc.save();
      doc.moveTo(this.izquierda, top + alto).lineTo(this.izquierda + this.ancho, top + alto)
        .lineWidth(0.5).strokeColor(COLOR.linea).stroke();
      doc.restore();

      const valores: string[][] = [
        [String(indice + 1)],
        lineasSku.length ? lineasSku : ['—'],
        [textoPdf(item.unidad_medida) || 'NIU'],
        [formatearSoles(item.precio_unitario)],
        [formatearCantidad(item.cantidad)],
        [formatearSoles(item.descuento)],
        lineasDesc,
        [formatearSoles(item.importe)],
      ];

      let x = this.izquierda;
      this.columnas.forEach((col, i) => {
        if (i === 7) this.estilo('Helvetica-Bold', tam, COLOR.texto);
        else if (i === 1) this.estilo('Helvetica', 8, COLOR.gris);
        else this.estilo('Helvetica', tam, COLOR.texto);
        valores[i].forEach((texto, n) => {
          this.linea(texto, x + padX, top + padY + n * altoLinea, col.ancho - padX * 2, col.alinear);
        });
        x += col.ancho;
      });

      this.y = top + alto;
    });

    // Cierre de la tabla con una línea del color de marca.
    doc.save();
    doc.moveTo(this.izquierda, this.y).lineTo(this.izquierda + this.ancho, this.y)
      .lineWidth(1).strokeColor(COLOR.marca).stroke();
    doc.restore();
    this.y += 10;
  }

  // ── Totales ─────────────────────────────────────────────────────

  private totales(): void {
    const doc = this.doc;
    const anchoTot = 226;
    const xTot = this.izquierda + this.ancho - anchoTot;
    const altoFila = 18;
    const altoTotal = 26;
    const pct = formatearPorcentaje(this.d.porcentaje_igv);

    this.estilo('Helvetica-Bold', 8.5, COLOR.texto);
    const son = `SON: ${montoEnLetras(numeroSeguro(this.d.total))}`;
    const lineasSon = this.envolver(son, this.ancho - 20);
    const altoSon = lineasSon.length * this.interlineado(8.5) + 12;

    // Totales y monto en letras siempre juntos en la misma página.
    const altoBloque = altoFila * 2 + altoTotal + 8 + altoSon;
    this.asegurar(altoBloque);
    const top = this.y;

    // Resumen a la izquierda.
    const items = this.d.items ?? [];
    const unidades = items.reduce((s, i) => s + numeroSeguro(i.cantidad), 0);
    this.estilo('Helvetica', 8, COLOR.gris);
    this.linea(`Ítems: ${items.length}    ·    Unidades: ${formatearCantidad(unidades)}`, this.izquierda, top + 5);
    this.linea('Precios unitarios con IGV incluido.', this.izquierda, top + 5 + this.interlineado(8));

    doc.save();
    doc.lineWidth(0.8).strokeColor(COLOR.linea)
      .rect(xTot, top, anchoTot, altoFila * 2 + altoTotal).stroke();
    doc.restore();

    const filas: Array<[string, number]> = [
      ['Op. gravada', this.d.total_gravada],
      [`IGV (${pct})`, this.d.total_igv],
    ];
    filas.forEach(([etiqueta, valor], i) => {
      const y = top + i * altoFila;
      if (i > 0) {
        doc.save();
        doc.moveTo(xTot, y).lineTo(xTot + anchoTot, y).lineWidth(0.5).strokeColor(COLOR.linea).stroke();
        doc.restore();
      }
      this.estilo('Helvetica', 8.5, COLOR.gris);
      this.linea(etiqueta, xTot + 10, y + 5.5);
      this.estilo('Helvetica', 9, COLOR.texto);
      this.linea(formatearSoles(valor), xTot, y + 5, anchoTot - 10, 'right');
    });

    const yTotal = top + altoFila * 2;
    doc.save();
    doc.rect(xTot, yTotal, anchoTot, altoTotal).fill(COLOR.marca);
    doc.restore();
    this.estilo('Helvetica-Bold', 10.5, COLOR.blanco);
    this.linea('TOTAL', xTot + 10, yTotal + 8);
    this.estilo('Helvetica-Bold', 13, COLOR.blanco);
    this.linea(formatearSoles(this.d.total), xTot, yTotal + 6.5, anchoTot - 10, 'right');

    // Monto en letras.
    const ySon = yTotal + altoTotal + 8;
    doc.save();
    doc.lineWidth(0.6).fillColor(COLOR.marcaSuave).strokeColor(COLOR.linea)
      .roundedRect(this.izquierda, ySon, this.ancho, altoSon, 4).fillAndStroke();
    doc.restore();
    this.estilo('Helvetica-Bold', 8.5, COLOR.texto);
    lineasSon.forEach((l, i) => this.linea(l, this.izquierda + 10, ySon + 6.5 + i * this.interlineado(8.5)));

    this.y = ySon + altoSon + 16;
  }

  private cuentasBancarias(): void {
    const cuentas = cuentasUtiles(this.d.cuentas);
    if (!cuentas.length) return;

    const tam = 8.3;
    const altoLinea = this.interlineado(tam);
    const lineas = cuentas.flatMap((cuenta) => this.envolver(describirCuenta(cuenta), this.ancho - 24));
    const alto = 25 + Math.max(1, lineas.length) * altoLinea + 10;
    this.asegurar(alto);

    const top = this.y;
    this.doc.save();
    this.doc.lineWidth(1).fillColor(COLOR.cuentas).strokeColor(COLOR.cuentas)
      .roundedRect(this.izquierda, top, this.ancho, alto, 5).fillAndStroke();
    this.doc.restore();
    this.estilo('Helvetica-Bold', 9, COLOR.blanco);
    this.linea('CUENTAS PARA DEPÓSITO O TRANSFERENCIA', this.izquierda + 12, top + 8);
    this.estilo('Helvetica', tam, COLOR.blanco);
    let y = top + 25;
    cuentas.forEach((cuenta) => {
      const texto = this.envolver(describirCuenta(cuenta), this.ancho - 24);
      texto.forEach((linea) => {
        this.linea(linea, this.izquierda + 12, y);
        y += altoLinea;
      });
    });
    this.y = top + alto + 12;
  }

  // ── Observaciones y condiciones ─────────────────────────────────

  private tituloSeccion(titulo: string): void {
    this.estilo('Helvetica-Bold', 9, COLOR.marca);
    this.linea(titulo.toUpperCase(), this.izquierda, this.y);
    this.doc.save();
    this.doc.moveTo(this.izquierda, this.y + 13).lineTo(this.izquierda + this.ancho, this.y + 13)
      .lineWidth(0.6).strokeColor(COLOR.linea).stroke();
    this.doc.restore();
    this.y += 19;
  }

  /** Párrafo que puede continuar en la página siguiente, línea por línea. */
  private parrafo(lineas: string[], x: number, tam: number, color: string, fuente: Fuente = 'Helvetica'): void {
    const alto = this.interlineado(tam);
    for (const l of lineas) {
      if (!this.cabe(alto)) this.nuevaPagina();
      this.estilo(fuente, tam, color);
      this.linea(l, x, this.y);
      this.y += alto;
    }
  }

  private observaciones(): void {
    const parrafos = textoMultilinea(this.d.observaciones);
    if (!parrafos.length) return;

    this.estilo('Helvetica', 8.5, COLOR.texto);
    const lineas: string[] = [];
    for (const p of parrafos) {
      if (!p) lineas.push('');
      else lineas.push(...this.envolver(p, this.ancho));
    }
    // El título nunca queda solo al pie de la página.
    this.asegurar(19 + Math.min(lineas.length, 3) * this.interlineado(8.5));
    this.tituloSeccion('Observaciones');
    this.parrafo(lineas, this.izquierda, 8.5, COLOR.texto);
    this.y += 12;
  }

  private condiciones(): void {
    const tam = 8.3;
    const alto = this.interlineado(tam);
    const sangria = 12;
    this.estilo('Helvetica', tam, COLOR.texto);

    const vinetas = condicionesComerciales(this.d).map((c) => this.envolver(c, this.ancho - sangria));
    this.asegurar(19 + alto * Math.min(3, vinetas.flat().length));
    this.tituloSeccion('Condiciones comerciales');

    const vineta = (lineas: string[], x: number) => {
      if (!this.cabe(alto * Math.min(2, lineas.length))) this.nuevaPagina();
      this.estilo('Helvetica', tam, COLOR.marca);
      this.linea('•', x, this.y);
      this.parrafo(lineas, x + sangria, tam, COLOR.texto);
      this.y += 1.5;
    };

    vinetas.forEach((l) => vineta(l, this.izquierda));

  }

  // ── Pie y marca de agua (en todas las páginas) ─────────────────

  private marcaAgua(): void {
    if (String(this.d.estado ?? '').toLowerCase() !== 'anulada') return;
    const doc = this.doc;
    const cx = doc.page.width / 2;
    const cy = doc.page.height / 2;
    doc.save();
    doc.rotate(-35, { origin: [cx, cy] });
    doc.font('Helvetica-Bold').fontSize(96).fillColor(COLOR.anulada).fillOpacity(0.08);
    const w = doc.widthOfString('ANULADA');
    doc.text('ANULADA', cx - w / 2, cy - 48, { lineBreak: false });
    doc.restore();
    doc.fillOpacity(1);
  }

  private pies(): void {
    const doc = this.doc;
    const rango = doc.bufferedPageRange();
    const generado = formatearFechaHora(this.generadoEn);
    const ruc = textoPdf(this.d.emisor?.ruc);

    for (let i = 0; i < rango.count; i++) {
      doc.switchToPage(rango.start + i);
      this.marcaAgua();

      const yLinea = doc.page.height - MARGEN - ALTO_PIE + 10;
      doc.save();
      doc.moveTo(this.izquierda, yLinea).lineTo(this.izquierda + this.ancho, yLinea)
        .lineWidth(0.6).strokeColor(COLOR.linea).stroke();
      doc.restore();

      const pagina = `Página ${i + 1} de ${rango.count}`;
      const generadoTexto = generado ? `Generado: ${generado}` : '';

      this.estilo('Helvetica-Bold', 7.5, COLOR.gris);
      const anchoPagina = doc.widthOfString(pagina);
      this.linea(pagina, this.izquierda, yLinea + 6, this.ancho, 'right');
      this.estilo('Helvetica-Oblique', 7.5, COLOR.gris);
      this.linea(
        this.recortar(LEYENDA_SIN_VALOR_TRIBUTARIO, this.ancho - anchoPagina - 20),
        this.izquierda,
        yLinea + 6,
      );

      this.estilo('Helvetica', 7, COLOR.grisClaro);
      const anchoGenerado = doc.widthOfString(generadoTexto);
      this.linea(generadoTexto, this.izquierda, yLinea + 17, this.ancho, 'right');
      const identificacion = [this.razonSocial, ruc ? `RUC ${ruc}` : '', `Proforma ${this.codigo}`]
        .filter(Boolean)
        .join('  ·  ');
      this.linea(
        this.recortar(identificacion, this.ancho - anchoGenerado - 20),
        this.izquierda,
        yLinea + 17,
      );
    }
  }
}
