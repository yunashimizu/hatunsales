import { esConsumidorFinal } from '../../sunat/catalogos/sunat.catalogos';
import { imagenSoportada } from './logo-emisor';
import { PALETA, dibujarFranjaMarca } from './proforma-documento';
import { textoPdf } from './proforma-pdf';
import { generarQrPng } from './qr';

// pdfkit no trae tipos en este proyecto (mismo uso que en proformas, arqueos y guías).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require('pdfkit');

/**
 * Representación impresa de factura, boleta y notas electrónicas (A4 y ticket de 80 mm) con QR y hash.
 * Generador puro: no lee la base de datos ni la red; el negocio arma `DatosPdfComprobante`.
 *
 * CONTRATO CONGELADO: ComprobanteBussnies lo usa para GET /comprobante/:id/pdf. Se pueden agregar
 * campos OPCIONALES, no renombrar ni quitar.
 */

export type FormatoPdfComprobante = 'a4' | 'ticket';

export interface EmisorPdfComprobante {
  ruc: string;
  razonSocial: string;
  nombreComercial?: string | null;
  direccion: string;
  /** «DISTRITO - PROVINCIA - DEPARTAMENTO» o lo que haya configurado. */
  ubicacion?: string | null;
  telefono?: string | null;
  email?: string | null;
  logo?: Buffer | null;
}

export interface ClientePdfComprobante {
  /** Catálogo 06: '0' sin documento, '1' DNI, '4' carné de extranjería, '6' RUC, '7' pasaporte. */
  tipoDoc: string;
  numDoc: string;
  nombre: string;
  direccion?: string | null;
}

export interface ReferenciaPdfComprobante {
  /** '01' factura | '03' boleta. */
  tipoDoc: string;
  serie: string;
  numero: number;
  /** Código del catálogo 09/10 y su descripción. */
  motivo: string;
  motivoDescripcion?: string | null;
  sustento: string;
}

export interface ItemPdfComprobante {
  codigo?: string | null;
  unidad: string;
  descripcion: string;
  cantidad: number;
  /** Sin IGV, antes del descuento. */
  valorUnitario: number;
  /** Con IGV, ya con el descuento. */
  precioUnitario: number;
  /** Descuento de la línea con IGV (0 si no hay). */
  descuento: number;
  /** Total de la línea con IGV. */
  importe: number;
}

export interface TotalesPdfComprobante {
  gravada: number;
  exonerada: number;
  inafecta: number;
  descuentos: number;
  igv: number;
  porcentajeIgv: number;
  total: number;
}

export interface CuotaPdfComprobante {
  numero: number;
  monto: number;
  /** dd/mm/yyyy */
  fechaPago: string;
}

export interface DatosPdfComprobante {
  emisor: EmisorPdfComprobante;
  /** Catálogo 01. */
  tipo: '01' | '03' | '07' | '08';
  serie: string;
  numero: number;
  /** dd/mm/yyyy */
  fechaEmision: string;
  /** HH:mm:ss */
  horaEmision?: string | null;
  /** dd/mm/yyyy */
  fechaVencimiento?: string | null;
  moneda: 'PEN' | 'USD';
  cliente: ClientePdfComprobante;
  referencia?: ReferenciaPdfComprobante | null;
  items: ItemPdfComprobante[];
  totales: TotalesPdfComprobante;
  /** «SON: CIENTO DIECIOCHO CON 00/100 SOLES». */
  importeEnLetras: string;
  formaPago?: {
    tipo: 'Contado' | 'Credito';
    cuotas?: CuotaPdfComprobante[];
  } | null;
  observaciones?: string | null;
  /** Nombres de los medios de pago de la venta (efectivo, tarjeta…), informativo. */
  medioPago?: string | null;
  /** Cadena exacta que codifica el QR (nucleo/cadena-qr.ts): no se recalcula aquí. */
  cadenaQr: string | null;
  /** DigestValue del XML firmado (valor resumen). */
  codigoHash: string | null;
  ambiente: 'beta' | 'produccion' | null;
  /** Estado visible si no está aceptado (p. ej. «PENDIENTE DE ENVÍO A SUNAT»), impreso como aviso. */
  avisoEstado?: string | null;
}

export interface OpcionesPdfComprobante {
  formato: FormatoPdfComprobante;
  /** false solo en pruebas, para poder buscar texto dentro del PDF. */
  comprimir?: boolean;
}

/** Texto de la marca de las pruebas en BETA (mismo texto en A4 y ticket). */
export const AVISO_BETA_PDF = 'PRUEBA SUNAT BETA - SIN VALIDEZ TRIBUTARIA';

const TITULOS: Record<DatosPdfComprobante['tipo'], string> = {
  '01': 'FACTURA ELECTRÓNICA',
  '03': 'BOLETA DE VENTA ELECTRÓNICA',
  '07': 'NOTA DE CRÉDITO ELECTRÓNICA',
  '08': 'NOTA DE DÉBITO ELECTRÓNICA',
};

const NOMBRES_LEYENDA: Record<DatosPdfComprobante['tipo'], string> = {
  '01': 'Factura Electrónica',
  '03': 'Boleta de Venta Electrónica',
  '07': 'Nota de Crédito Electrónica',
  '08': 'Nota de Débito Electrónica',
};

/** Catálogo 06 en palabras (lo que entiende el cliente al leer el papel). */
const TIPOS_DOCUMENTO: Record<string, string> = {
  '0': 'Doc. trib. no dom.',
  '1': 'DNI',
  '4': 'Carné de extranjería',
  '6': 'RUC',
  '7': 'Pasaporte',
  A: 'Cédula diplomática',
  B: 'Doc. país de residencia',
};

/** Catálogo 03 (unidades) en abreviaturas legibles; los demás códigos se imprimen tal cual. */
const UNIDADES: Record<string, string> = {
  NIU: 'UND',
  ZZ: 'SERV',
  KGM: 'KG',
  GRM: 'G',
  MTR: 'M',
  MTK: 'M2',
  MTQ: 'M3',
  LTR: 'L',
  GLL: 'GAL',
  BX: 'CAJA',
  PK: 'PAQ',
  SET: 'JGO',
  PR: 'PAR',
  DZN: 'DOC',
  CEN: 'CIENTO',
  MIL: 'MILLAR',
  RO: 'ROLLO',
  BG: 'BOLSA',
  TNE: 'T',
};

/** En el ticket (80 mm) algunas etiquetas se acortan para que el valor tenga sitio. */
const ETIQUETAS_TICKET: Record<string, string> = {
  'Fecha de emisión': 'Emisión',
  'Fecha de vencimiento': 'Vencimiento',
  'Documento que modifica': 'Modifica a',
  'Carné de extranjería': 'C. extranjería',
  'Doc. país de residencia': 'Doc. extranjero',
};

const MONEDAS = {
  PEN: { simbolo: 'S/', nombre: 'SOLES (PEN)' },
  USD: { simbolo: 'US$', nombre: 'DÓLARES AMERICANOS (USD)' },
} as const;

const MARGEN_A4 = 36;
const ANCHO_TICKET = 226.77; // 80 mm
const MARGEN_TICKET = 10;
/** Límite práctico de alto de página en los visores PDF (200 pulgadas); un ticket más largo se pagina. */
const ALTO_MAXIMO_TICKET = 14_000;
/** Lado del QR en puntos: 92 pt = 32.5 mm en A4 y 100 pt = 35.3 mm en el ticket (el mínimo usual es 28 mm). */
const LADO_QR = { a4: 92, ticket: 100 } as const;
/** Una descripción absurda no debe ocupar más de una página: se corta con «…». */
const MAXIMO_LINEAS_DESCRIPCION = 30;

const COLOR = {
  texto: PALETA.texto,
  gris: PALETA.gris,
  grisClaro: PALETA.grisClaro,
  linea: PALETA.linea,
  fondo: PALETA.fondo,
  cebra: PALETA.cebra,
  marca: PALETA.grafito,
  acento: PALETA.dorado,
  acentoClaro: PALETA.doradoClaro,
  acentoTexto: PALETA.doradoOscuro,
  peligro: PALETA.peligro,
  aviso: PALETA.aviso,
  blanco: PALETA.blanco,
};

type Fuente = 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique';
type Alineacion = 'left' | 'right' | 'center';
type Fila = [string, string];

export async function generarPdfComprobante(
  datos: DatosPdfComprobante,
  opciones: OpcionesPdfComprobante,
): Promise<Buffer> {
  const formato = opciones?.formato;
  if (formato !== 'a4' && formato !== 'ticket') {
    throw new Error(
      `Formato de impresión no soportado: "${String(formato)}" (use a4 o ticket).`,
    );
  }
  if (!datos || !TITULOS[datos.tipo]) {
    throw new Error(
      `Tipo de comprobante no soportado para la representación impresa: "${String(datos?.tipo)}".`,
    );
  }
  const comprimir = opciones.comprimir !== false;
  const cadenaQr = String(datos.cadenaQr ?? '').trim();
  // El QR se genera una sola vez y lo comparten la medición del ticket y el dibujo final.
  const qr = cadenaQr
    ? await generarQrPng(cadenaQr, { tamanoPx: 360, correccion: 'M' })
    : null;

  if (formato === 'ticket') {
    const alto = medirTicket(datos, qr);
    return renderizar(
      datos,
      qr,
      'ticket',
      [ANCHO_TICKET, Math.min(alto, ALTO_MAXIMO_TICKET)],
      comprimir,
    );
  }
  return renderizar(datos, qr, 'a4', 'A4', comprimir);
}

/** Primera pasada sobre una hoja altísima (sin imágenes) para saber cuánto mide el ticket. */
function medirTicket(datos: DatosPdfComprobante, qr: Buffer | null): number {
  const doc = new PDFDocument({
    size: [ANCHO_TICKET, 1_000_000],
    margins: margenes(MARGEN_TICKET),
    compress: false,
  });
  doc.on('data', () => undefined);
  const dibujo = new DibujoComprobante(doc, datos, qr, 'ticket', true);
  dibujo.dibujar();
  doc.end();
  // Holgura: los bloques piden algo más de alto del que ocupan (asegurar) y no deben saltar de hoja.
  return Math.ceil(dibujo.yFinal + MARGEN_TICKET + 12);
}

function margenes(m: number) {
  return { top: m, bottom: m, left: m, right: m };
}

function renderizar(
  datos: DatosPdfComprobante,
  qr: Buffer | null,
  formato: FormatoPdfComprobante,
  size: 'A4' | [number, number],
  comprimir: boolean,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size,
        margins: margenes(formato === 'ticket' ? MARGEN_TICKET : MARGEN_A4),
        bufferPages: true,
        compress: comprimir,
        info: {
          Title: `${TITULOS[datos.tipo]} ${serieNumero(datos.serie, datos.numero)}`,
          Author: textoPdf(datos.emisor?.razonSocial),
          Subject: `Representación impresa de la ${NOMBRES_LEYENDA[datos.tipo]}`,
          Creator: 'HatunSales',
        },
      });
      const partes: Buffer[] = [];
      doc.on('data', (parte: Buffer) => partes.push(parte));
      doc.on('end', () => resolve(Buffer.concat(partes)));
      doc.on('error', (error: unknown) => reject(comoError(error)));
      new DibujoComprobante(doc, datos, qr, formato, false).dibujar();
      doc.end();
    } catch (error) {
      reject(comoError(error));
    }
  });
}

function comoError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(
        `No se pudo generar la representación impresa: ${String(error)}`,
      );
}

// ── Formatos de texto ─────────────────────────────────────────────

/** «F001-00000123»: el correlativo con 8 dígitos, igual que en el XML y en el QR. */
function serieNumero(serie: string, numero: number): string {
  const n = Number(numero);
  const correlativo =
    Number.isInteger(n) && n >= 0
      ? String(n).padStart(8, '0')
      : String(numero ?? '');
  return `${textoPdf(serie)}-${correlativo}`;
}

/** Redondeo decimal sin el error binario de toFixed (1.005 -> 1.01). */
function redondear(valor: number, decimales: number): number {
  const n = Number(valor);
  if (!Number.isFinite(n)) return 0;
  const exacto = Number(
    `${Math.round(Number(`${Math.abs(n)}e${decimales}`))}e-${decimales}`,
  );
  // Números en notación exponencial (1e-7) no admiten el truco del exponente: redondeo directo.
  return Number.isFinite(exacto)
    ? exacto * Math.sign(n)
    : Math.round(n * 10 ** decimales) / 10 ** decimales;
}

function conMiles(valor: number, decimales: number): string {
  const n = redondear(valor, decimales);
  const [entero, fraccion] = Math.abs(n).toFixed(decimales).split('.');
  const signo = n < 0 ? '-' : '';
  return `${signo}${entero.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraccion ? `.${fraccion}` : ''}`;
}

function monto(valor: number): string {
  return conMiles(valor, 2);
}

/** Valores unitarios: entre 2 y 4 decimales (el XML admite más; el papel no necesita tantos). */
function unitario(valor: number): string {
  return conMiles(valor, 4)
    .replace(/(\.\d\d\d?)0+$/, '$1')
    .replace(/(\.\d\d)0$/, '$1');
}

function cantidad(valor: number): string {
  return conMiles(valor, 3).replace(/\.?0+$/, '');
}

function porcentaje(valor: number): string {
  return conMiles(valor, 2).replace(/\.?0+$/, '');
}

function unidadLegible(codigo: string): string {
  const limpio = textoPdf(codigo).toUpperCase();
  return UNIDADES[limpio] ?? limpio;
}

/** Párrafos de un texto libre: respeta los saltos de línea que escribió el usuario. */
function parrafos(valor: string | number | null | undefined): string[] {
  return String(valor ?? '')
    .split(/\r?\n/)
    .map((linea) => textoPdf(linea))
    .filter(Boolean);
}

function conSon(letras: string): string {
  const limpio = textoPdf(letras);
  if (!limpio) return '';
  return /^SON\b/i.test(limpio) ? limpio : `SON: ${limpio}`;
}

// ── Dibujo ────────────────────────────────────────────────────────

class DibujoComprobante {
  private y: number;
  private readonly x: number;
  private readonly ancho: number;
  private readonly margen: number;
  private readonly ticket: boolean;
  private readonly tam: {
    razon: number;
    titulo: number;
    serie: number;
    normal: number;
    chico: number;
    total: number;
  };
  private readonly simbolo: string;
  private readonly logo: { imagen: any; ancho: number; alto: number } | null;

  constructor(
    private readonly doc: any,
    private readonly d: DatosPdfComprobante,
    private readonly qr: Buffer | null,
    formato: FormatoPdfComprobante,
    /** Pasada de medición: no se incrustan imágenes (solo importa cuánto ocupan). */
    private readonly midiendo: boolean,
  ) {
    this.ticket = formato === 'ticket';
    this.margen = this.ticket ? MARGEN_TICKET : MARGEN_A4;
    this.x = this.margen;
    this.y = this.margen;
    this.ancho = doc.page.width - this.margen * 2;
    this.tam = this.ticket
      ? {
          razon: 9.5,
          titulo: 9,
          serie: 10.5,
          normal: 7.4,
          chico: 6.5,
          total: 9,
        }
      : {
          razon: 12.5,
          titulo: 11,
          serie: 13,
          normal: 8.5,
          chico: 7.4,
          total: 10.5,
        };
    this.simbolo = MONEDAS[d.moneda]?.simbolo ?? 'S/';
    this.logo = this.abrirLogo();
  }

  get yFinal(): number {
    return this.y;
  }

  dibujar(): void {
    this.franjaMarca();
    this.marcaAgua();
    if (this.ticket) this.dibujarTicket();
    else this.dibujarA4();
  }

  // ── Primitivas ──────────────────────────────────────────────────

  /** Franja de marca en el borde superior de cada hoja A4. */
  private franjaMarca(): void {
    if (!this.ticket) dibujarFranjaMarca(this.doc);
  }

  private estilo(
    fuente: Fuente,
    tam: number,
    color: string = COLOR.texto,
  ): void {
    this.doc.font(fuente).fontSize(tam).fillColor(color);
  }

  private alto(tam: number): number {
    return tam * 1.3;
  }

  /** Tope de escritura de la página (en A4 deja sitio al pie con la numeración). */
  private limite(): number {
    return this.doc.page.height - this.margen - (this.ticket ? 0 : 16);
  }

  /** Salta de página si `alto` no entra: así un bloque (totales, QR) nunca se parte. */
  private asegurar(alto: number): boolean {
    if (this.y + alto <= this.limite()) return false;
    this.doc.addPage();
    this.y = this.margen;
    this.franjaMarca();
    this.marcaAgua();
    return true;
  }

  /** Escribe UNA línea (sin salto automático de pdfkit), recortada con «…» y alineada dentro de `ancho`. */
  private linea(
    valor: string,
    x: number,
    y: number,
    ancho: number,
    alinear: Alineacion = 'left',
  ): void {
    const t = this.recortar(textoPdf(valor), ancho);
    if (!t) return;
    let xx = x;
    if (alinear !== 'left') {
      const w = this.doc.widthOfString(t);
      xx = alinear === 'right' ? x + ancho - w : x + (ancho - w) / 2;
    }
    this.doc.text(t, xx, y, { lineBreak: false });
  }

  private recortar(texto: string, ancho: number): string {
    if (!texto || this.doc.widthOfString(texto) <= ancho) return texto;
    let recorte = texto;
    while (recorte.length > 1 && this.doc.widthOfString(`${recorte}…`) > ancho)
      recorte = recorte.slice(0, -1);
    return `${recorte.trimEnd()}…`;
  }

  /** Parte un texto (ya saneado) en líneas que caben en `ancho` con la fuente actual; corta palabras larguísimas (hash, códigos). */
  private envolver(
    texto: string,
    ancho: number,
    maximo = Number.POSITIVE_INFINITY,
  ): string[] {
    const lineas: string[] = [];
    let actual = '';
    for (const palabra of texto.split(' ').filter(Boolean)) {
      const prueba = actual ? `${actual} ${palabra}` : palabra;
      if (this.doc.widthOfString(prueba) <= ancho) {
        actual = prueba;
        continue;
      }
      if (actual) lineas.push(actual);
      let resto = palabra;
      while (resto.length > 1 && this.doc.widthOfString(resto) > ancho) {
        let corte = 1;
        while (
          corte < resto.length - 1 &&
          this.doc.widthOfString(resto.slice(0, corte + 1)) <= ancho
        )
          corte++;
        lineas.push(resto.slice(0, corte));
        resto = resto.slice(corte);
      }
      actual = resto;
    }
    if (actual) lineas.push(actual);
    if (lineas.length > maximo) {
      const cortadas = lineas.slice(0, maximo);
      cortadas[maximo - 1] = this.recortar(`${cortadas[maximo - 1]}…`, ancho);
      return cortadas;
    }
    return lineas;
  }

  /** Líneas de varios párrafos con la fuente indicada (para medir antes de dibujar). */
  private lineasDe(
    textos: string[],
    fuente: Fuente,
    tam: number,
    ancho: number,
    maximo?: number,
  ): string[] {
    this.estilo(fuente, tam);
    return textos.flatMap((t) => this.envolver(textoPdf(t), ancho, maximo));
  }

  /** Bloque de texto que fluye (salta de página línea a línea si hace falta). */
  private parrafo(
    textos: string[],
    opciones: {
      fuente?: Fuente;
      tam?: number;
      color?: string;
      alinear?: Alineacion;
      x?: number;
      ancho?: number;
    } = {},
  ): void {
    const fuente = opciones.fuente ?? 'Helvetica';
    const tam = opciones.tam ?? this.tam.normal;
    const x = opciones.x ?? this.x;
    const ancho = opciones.ancho ?? this.ancho;
    for (const linea of this.lineasDe(textos, fuente, tam, ancho)) {
      this.asegurar(this.alto(tam));
      this.estilo(fuente, tam, opciones.color ?? COLOR.texto);
      this.linea(linea, x, this.y, ancho, opciones.alinear ?? 'left');
      this.y += this.alto(tam);
    }
  }

  private separador(): void {
    this.asegurar(8);
    const y = this.y + 3;
    this.doc.save().lineWidth(0.6).strokeColor(COLOR.gris);
    if (this.ticket) this.doc.dash(1.5, { space: 1.5 });
    this.doc
      .moveTo(this.x, y)
      .lineTo(this.x + this.ancho, y)
      .stroke();
    this.doc.undash().restore();
    this.y += 8;
  }

  /** Recuadro con un aviso en negrita; intenta que entre en una línea antes de partirlo. */
  private banner(texto: string, color: string): void {
    const t = textoPdf(texto);
    if (!t) return;
    const relleno = this.ticket ? 4 : 6;
    const disponible = this.ancho - relleno * 2;
    let tam = this.ticket ? this.tam.normal + 0.6 : 10;
    this.estilo('Helvetica-Bold', tam, color);
    while (tam > 6 && this.doc.widthOfString(t) > disponible) {
      tam -= 0.25;
      this.estilo('Helvetica-Bold', tam, color);
    }
    const lineas = this.envolver(t, disponible);
    const alto = lineas.length * this.alto(tam) + relleno * 2 - 2;
    this.asegurar(alto + 6);
    this.doc
      .save()
      .roundedRect(this.x, this.y, this.ancho, alto, 3)
      .lineWidth(1.2)
      .strokeColor(color)
      .stroke()
      .restore();
    this.estilo('Helvetica-Bold', tam, color);
    let yy = this.y + relleno;
    for (const linea of lineas) {
      this.linea(linea, this.x + relleno, yy, disponible, 'center');
      yy += this.alto(tam);
    }
    this.y += alto + (this.ticket ? 5 : 8);
  }

  /** Marca de agua diagonal de BETA (solo A4: la impresora térmica no imprime grises; el ticket lleva recuadros). */
  private marcaAgua(): void {
    if (this.d.ambiente !== 'beta' || this.ticket) return;
    const { width, height } = this.doc.page;
    this.doc.save();
    this.doc.rotate(-35, { origin: [width / 2, height / 2] });
    this.doc.fillOpacity(0.09);
    // Sin recorte: girado, el texto usa la diagonal de la hoja (más larga que su ancho).
    for (const [texto, tam, dy] of [
      ['PRUEBA SUNAT BETA', 50, -46],
      ['SIN VALIDEZ TRIBUTARIA', 30, 14],
    ] as const) {
      this.estilo('Helvetica-Bold', tam, COLOR.peligro);
      this.doc.text(
        texto,
        (width - this.doc.widthOfString(texto)) / 2,
        height / 2 + dy,
        { lineBreak: false },
      );
    }
    this.doc.restore();
  }

  private abrirLogo(): { imagen: any; ancho: number; alto: number } | null {
    const logo = this.d.emisor?.logo;
    // Se valida antes: un PNG dañado haría fallar a pdfkit dentro de un callback (fuera de este try).
    if (!logo || !Buffer.isBuffer(logo) || !imagenSoportada(logo)) return null;
    try {
      const imagen = this.doc.openImage(logo);
      return imagen?.width && imagen?.height
        ? { imagen, ancho: imagen.width, alto: imagen.height }
        : null;
    } catch {
      // Logo ilegible: el comprobante sale sin logo (el logo es decorativo, nunca bloquea la impresión).
      return null;
    }
  }

  /** Tamaño del logo escalado para caber en la caja, sin deformarlo. */
  private medidaLogo(
    maxAncho: number,
    maxAlto: number,
  ): { ancho: number; alto: number } {
    if (!this.logo) return { ancho: 0, alto: 0 };
    const escala = Math.min(
      maxAncho / this.logo.ancho,
      maxAlto / this.logo.alto,
    );
    return { ancho: this.logo.ancho * escala, alto: this.logo.alto * escala };
  }

  private imagen(
    imagen: any,
    x: number,
    y: number,
    ancho: number,
    alto: number,
  ): void {
    if (this.midiendo) return;
    this.doc.image(imagen, x, y, { width: ancho, height: alto });
  }

  // ── Datos derivados ─────────────────────────────────────────────

  private get titulo(): string {
    return TITULOS[this.d.tipo];
  }

  private get codigo(): string {
    return serieNumero(this.d.serie, this.d.numero);
  }

  private get leyenda(): string {
    return `Representación impresa de la ${NOMBRES_LEYENDA[this.d.tipo]}. Consulte su validez en www.sunat.gob.pe`;
  }

  private fechaEmision(): string {
    const fecha = textoPdf(this.d.fechaEmision);
    const hora = textoPdf(this.d.horaEmision);
    return hora ? `${fecha} ${hora}` : fecha;
  }

  private filasCliente(): Fila[] {
    const c = this.d.cliente ?? ({} as ClientePdfComprobante);
    const tipo = String(c.tipoDoc ?? '').trim();
    const numero = textoPdf(c.numDoc);
    const filas: Fila[] = [
      [
        tipo === '6' ? 'Razón social' : 'Cliente',
        textoPdf(c.nombre) || 'CLIENTES VARIOS',
      ],
    ];
    if (esConsumidorFinal(tipo, numero))
      filas.push(['Documento', 'Sin documento']);
    else filas.push([TIPOS_DOCUMENTO[tipo] ?? 'Documento', numero]);
    if (textoPdf(c.direccion)) filas.push(['Dirección', textoPdf(c.direccion)]);
    return filas;
  }

  private filasDocumento(): Fila[] {
    const filas: Fila[] = [['Fecha de emisión', this.fechaEmision()]];
    if (textoPdf(this.d.fechaVencimiento))
      filas.push(['Fecha de vencimiento', textoPdf(this.d.fechaVencimiento)]);
    filas.push([
      'Moneda',
      MONEDAS[this.d.moneda]?.nombre ?? textoPdf(this.d.moneda),
    ]);
    if (this.d.formaPago?.tipo)
      filas.push([
        'Forma de pago',
        this.d.formaPago.tipo === 'Credito' ? 'Crédito' : 'Contado',
      ]);
    return filas;
  }

  private filasReferencia(): Fila[] {
    const r = this.d.referencia;
    if (!r) return [];
    const tipo =
      r.tipoDoc === '01'
        ? 'FACTURA ELECTRÓNICA'
        : r.tipoDoc === '03'
          ? 'BOLETA DE VENTA ELECTRÓNICA'
          : `Documento ${textoPdf(r.tipoDoc)}`;
    const motivo = [textoPdf(r.motivo), textoPdf(r.motivoDescripcion)]
      .filter(Boolean)
      .join(' - ');
    return [
      ['Documento que modifica', `${tipo} ${serieNumero(r.serie, r.numero)}`],
      ['Motivo', motivo || '—'],
      ['Sustento', String(r.sustento ?? '')],
    ];
  }

  private filasTotales(): Fila[] {
    const t = this.d.totales ?? ({} as TotalesPdfComprobante);
    const s = this.simbolo;
    const filas: Fila[] = [
      ['Op. gravada', `${s} ${monto(t.gravada)}`],
      ['Op. exonerada', `${s} ${monto(t.exonerada)}`],
      ['Op. inafecta', `${s} ${monto(t.inafecta)}`],
    ];
    if (Number(t.descuentos) > 0)
      filas.push(['Descuentos', `${s} ${monto(t.descuentos)}`]);
    filas.push([
      `IGV (${porcentaje(t.porcentajeIgv)}%)`,
      `${s} ${monto(t.igv)}`,
    ]);
    return filas;
  }

  private get cuotas(): CuotaPdfComprobante[] {
    return this.d.formaPago?.tipo === 'Credito'
      ? (this.d.formaPago.cuotas ?? [])
      : [];
  }

  /** Monto neto pendiente de pago (crédito): la suma de las cuotas o, si no vinieran, el total. */
  private pendienteCredito(): number {
    const cuotas = this.cuotas;
    if (!cuotas.length) return Number(this.d.totales?.total) || 0;
    return redondear(
      cuotas.reduce((suma, c) => suma + (Number(c.monto) || 0), 0),
      2,
    );
  }

  // ── A4 ──────────────────────────────────────────────────────────

  private dibujarA4(): void {
    this.cabeceraA4();
    if (this.d.ambiente === 'beta') this.banner(AVISO_BETA_PDF, COLOR.peligro);
    if (textoPdf(this.d.avisoEstado))
      this.banner(String(this.d.avisoEstado), COLOR.aviso);
    this.caja(null, [this.filasCliente(), this.filasDocumento()]);
    if (this.d.referencia)
      this.caja('DOCUMENTO QUE MODIFICA', [this.filasReferencia()]);
    this.tablaA4();
    this.totalesA4();
    this.creditoA4();
    this.notasA4();
    this.qrA4();
    this.pieA4();
  }

  private cabeceraA4(): void {
    const e = this.d.emisor ?? ({} as EmisorPdfComprobante);
    const anchoCaja = 200;
    const xCaja = this.x + this.ancho - anchoCaja;
    const logo = this.medidaLogo(86, 70);
    const xTexto = this.logo ? this.x + logo.ancho + 12 : this.x;
    const anchoTexto = xCaja - 14 - xTexto;

    // Bloque del emisor (se mide primero para centrar ambas columnas).
    const razon = this.lineasDe(
      [e.razonSocial],
      'Helvetica-Bold',
      this.tam.razon,
      anchoTexto,
      2,
    );
    const comercial =
      textoPdf(e.nombreComercial) &&
      textoPdf(e.nombreComercial) !== textoPdf(e.razonSocial)
        ? this.lineasDe(
            [String(e.nombreComercial)],
            'Helvetica-Bold',
            9,
            anchoTexto,
            1,
          )
        : [];
    const contacto = [
      textoPdf(e.telefono) && `Telf. ${textoPdf(e.telefono)}`,
      textoPdf(e.email),
    ]
      .filter(Boolean)
      .join('  ·  ');
    const detalle = this.lineasDe(
      [e.direccion, e.ubicacion ?? '', contacto],
      'Helvetica',
      8,
      anchoTexto,
      3,
    );
    const altoEmisor =
      razon.length * this.alto(this.tam.razon) +
      comercial.length * this.alto(9) +
      3 +
      detalle.length * this.alto(8);

    const tituloLineas = this.lineasDe(
      [this.titulo],
      'Helvetica-Bold',
      this.tam.titulo,
      anchoCaja - 20,
    );
    const altoCaja =
      12 +
      this.alto(11) +
      6 +
      tituloLineas.length * this.alto(this.tam.titulo) +
      10 +
      this.alto(this.tam.serie) +
      8;
    const alto = Math.max(altoEmisor, altoCaja, logo.alto);

    if (this.logo)
      this.imagen(
        this.logo.imagen,
        this.x,
        this.y + (alto - logo.alto) / 2,
        logo.ancho,
        logo.alto,
      );
    let yy = this.y + Math.max(0, (alto - altoEmisor) / 2);
    this.estilo('Helvetica-Bold', this.tam.razon, COLOR.marca);
    for (const l of razon) {
      this.linea(l, xTexto, yy, anchoTexto);
      yy += this.alto(this.tam.razon);
    }
    this.estilo('Helvetica-Bold', 9, COLOR.acentoTexto);
    for (const l of comercial) {
      this.linea(l, xTexto, yy, anchoTexto);
      yy += this.alto(9);
    }
    yy += 3;
    this.estilo('Helvetica', 8, COLOR.gris);
    for (const l of detalle) {
      this.linea(l, xTexto, yy, anchoTexto);
      yy += this.alto(8);
    }

    // Recuadro del documento: RUC, tipo y serie-número.
    const yCaja = this.y + (alto - altoCaja) / 2;
    this.doc
      .save()
      .roundedRect(xCaja, yCaja, anchoCaja, altoCaja, 5)
      .lineWidth(1.4)
      .strokeColor(COLOR.marca)
      .stroke()
      .restore();
    let yc = yCaja + 12;
    this.estilo('Helvetica-Bold', 11, COLOR.marca);
    this.linea(`R.U.C. N° ${textoPdf(e.ruc)}`, xCaja, yc, anchoCaja, 'center');
    yc += this.alto(11) + 4;
    const altoBanda = tituloLineas.length * this.alto(this.tam.titulo) + 6;
    this.doc
      .save()
      .rect(xCaja + 1, yc - 2, anchoCaja - 2, altoBanda)
      .fill(COLOR.marca)
      .rect(xCaja + 1, yc - 2 + altoBanda, anchoCaja - 2, 1.6)
      .fill(COLOR.acento)
      .restore();
    this.estilo('Helvetica-Bold', this.tam.titulo, COLOR.blanco);
    for (const l of tituloLineas) {
      this.linea(l, xCaja + 10, yc + 3.5, anchoCaja - 20, 'center');
      yc += this.alto(this.tam.titulo);
    }
    yc += 10;
    this.estilo('Helvetica-Bold', this.tam.serie, COLOR.marca);
    this.linea(this.codigo, xCaja, yc, anchoCaja, 'center');

    this.y += alto + 12;
  }

  /** Recuadro con filas «etiqueta: valor» en una o dos columnas (no se parte entre páginas). */
  private caja(titulo: string | null, columnas: Fila[][]): void {
    const relleno = 8;
    const separacion = 14;
    const tam = this.tam.normal;
    const anchoColumna =
      (this.ancho - relleno * 2 - separacion * (columnas.length - 1)) /
      columnas.length;
    // La columna de etiquetas mide lo que la más larga (con tope, para dejar sitio al valor).
    this.estilo('Helvetica-Bold', tam - 0.8);
    const anchoEtiqueta = Math.min(
      anchoColumna * 0.45,
      Math.max(
        70,
        ...columnas
          .flat()
          .map(([etiqueta]) => this.doc.widthOfString(etiqueta.toUpperCase())),
      ) + 10,
    );
    const anchoValor = anchoColumna - anchoEtiqueta;
    const medidas = columnas.map((filas) =>
      filas.map(([, valor]) =>
        this.lineasDe(
          parrafos(valor).length ? parrafos(valor) : ['—'],
          'Helvetica',
          tam,
          anchoValor,
          6,
        ),
      ),
    );
    const altoColumna = (indice: number) =>
      medidas[indice].reduce(
        (suma, lineas) => suma + lineas.length * this.alto(tam) + 2,
        0,
      );
    const altoTitulo = titulo ? 18 : 0;
    const alto =
      altoTitulo +
      relleno +
      Math.max(...columnas.map((_, i) => altoColumna(i))) +
      relleno -
      2;
    this.asegurar(alto + 8);

    this.doc
      .save()
      .roundedRect(this.x, this.y, this.ancho, alto, 4)
      .lineWidth(0.7)
      .strokeColor(COLOR.linea)
      .stroke()
      .restore();
    if (titulo) {
      this.doc
        .save()
        .rect(this.x + 0.5, this.y + 0.5, this.ancho - 1, altoTitulo - 2)
        .fill(COLOR.fondo)
        .rect(this.x + 0.5, this.y + 0.5, 3, altoTitulo - 2)
        .fill(COLOR.acento)
        .restore();
      this.estilo('Helvetica-Bold', 7.8, COLOR.marca);
      this.linea(
        titulo,
        this.x + relleno,
        this.y + 5,
        this.ancho - relleno * 2,
      );
    }
    columnas.forEach((filas, i) => {
      const xCol = this.x + relleno + i * (anchoColumna + separacion);
      let yy = this.y + altoTitulo + relleno;
      filas.forEach(([etiqueta], j) => {
        this.estilo('Helvetica-Bold', tam - 0.8, COLOR.gris);
        this.linea(etiqueta.toUpperCase(), xCol, yy + 0.8, anchoEtiqueta - 6);
        this.estilo('Helvetica', tam, COLOR.texto);
        for (const l of medidas[i][j]) {
          this.linea(l, xCol + anchoEtiqueta, yy, anchoValor);
          yy += this.alto(tam);
        }
        yy += 2;
      });
    });
    this.y += alto + 8;
  }

  private columnasTabla(): Array<{
    titulo: string;
    ancho: number;
    alinear: Alineacion;
  }> {
    const fijas = [
      { titulo: 'CANT.', ancho: 44, alinear: 'right' as Alineacion },
      { titulo: 'UNIDAD', ancho: 42, alinear: 'center' as Alineacion },
      { titulo: 'V. UNIT.', ancho: 58, alinear: 'right' as Alineacion },
      { titulo: 'P. UNIT.', ancho: 58, alinear: 'right' as Alineacion },
      { titulo: 'DESC.', ancho: 50, alinear: 'right' as Alineacion },
      { titulo: 'IMPORTE', ancho: 64, alinear: 'right' as Alineacion },
    ];
    const resto = this.ancho - fijas.reduce((s, c) => s + c.ancho, 0);
    return [
      fijas[0],
      fijas[1],
      { titulo: 'DESCRIPCIÓN', ancho: resto, alinear: 'left' },
      ...fijas.slice(2),
    ];
  }

  private encabezadoTabla(): void {
    const columnas = this.columnasTabla();
    const alto = 18;
    this.doc
      .save()
      .rect(this.x, this.y, this.ancho, alto)
      .fill(COLOR.marca)
      .restore();
    this.doc
      .save()
      .lineWidth(1.6)
      .strokeColor(COLOR.acento)
      .moveTo(this.x, this.y + alto)
      .lineTo(this.x + this.ancho, this.y + alto)
      .stroke()
      .restore();
    this.estilo('Helvetica-Bold', 7.4, COLOR.blanco);
    let cx = this.x;
    for (const c of columnas) {
      this.linea(c.titulo, cx + 4, this.y + 6, c.ancho - 8, c.alinear);
      cx += c.ancho;
    }
    this.y += alto;
  }

  private tablaA4(): void {
    const columnas = this.columnasTabla();
    const tam = this.tam.normal;
    const items = Array.isArray(this.d.items) ? this.d.items : [];
    const anchoDescripcion = columnas[2].ancho - 8;
    const filas = items.map((item) => {
      const descripcion = this.lineasDe(
        parrafos(item.descripcion).length ? parrafos(item.descripcion) : ['—'],
        'Helvetica',
        tam,
        anchoDescripcion,
        MAXIMO_LINEAS_DESCRIPCION,
      );
      const codigo = textoPdf(item.codigo);
      return {
        item,
        descripcion,
        codigo,
        alto:
          descripcion.length * this.alto(tam) +
          (codigo ? this.alto(6.8) : 0) +
          7,
      };
    });
    // Encabezado + primera fila juntos: un encabezado huérfano al pie de página no sirve.
    this.asegurar(18 + (filas[0]?.alto ?? 16));
    this.encabezadoTabla();
    filas.forEach((fila, indice) => {
      if (this.asegurar(fila.alto)) this.encabezadoTabla();
      if (indice % 2 === 1)
        this.doc
          .save()
          .rect(this.x, this.y, this.ancho, fila.alto)
          .fill(COLOR.cebra)
          .restore();
      const yTexto = this.y + 4;
      const valores = [
        cantidad(fila.item.cantidad),
        unidadLegible(fila.item.unidad),
        '',
        unitario(fila.item.valorUnitario),
        unitario(fila.item.precioUnitario),
        Number(fila.item.descuento) ? monto(fila.item.descuento) : '',
        monto(fila.item.importe),
      ];
      let cx = this.x;
      columnas.forEach((c, i) => {
        if (i === 2) {
          this.estilo('Helvetica', tam, COLOR.texto);
          let yy = yTexto;
          for (const l of fila.descripcion) {
            this.linea(l, cx + 4, yy, c.ancho - 8);
            yy += this.alto(tam);
          }
          if (fila.codigo) {
            this.estilo('Helvetica', 6.8, COLOR.grisClaro);
            this.linea(`Cód. ${fila.codigo}`, cx + 4, yy, c.ancho - 8);
          }
        } else {
          this.estilo(
            i === columnas.length - 1 ? 'Helvetica-Bold' : 'Helvetica',
            tam,
            COLOR.texto,
          );
          this.linea(valores[i], cx + 4, yTexto, c.ancho - 8, c.alinear);
        }
        cx += c.ancho;
      });
      this.y += fila.alto;
      this.doc
        .save()
        .lineWidth(0.4)
        .strokeColor(COLOR.linea)
        .moveTo(this.x, this.y)
        .lineTo(this.x + this.ancho, this.y)
        .stroke()
        .restore();
    });
    if (!filas.length) {
      this.estilo('Helvetica-Oblique', tam, COLOR.gris);
      this.linea(
        'Sin líneas de detalle.',
        this.x + 4,
        this.y + 5,
        this.ancho - 8,
      );
      this.y += 18;
    }
    this.y += 10;
  }

  /** Importe en letras a la izquierda y totales a la derecha: un solo bloque que no se parte. */
  private totalesA4(): void {
    const anchoTotales = 230;
    const anchoLetras = this.ancho - anchoTotales - 16;
    const filas = this.filasTotales();
    const tam = this.tam.normal;
    const altoFilas = filas.length * (this.alto(tam) + 2);
    const altoTotal = this.alto(this.tam.total) + 10;
    const altoDerecha = altoFilas + altoTotal + 4;
    const letras = this.lineasDe(
      [conSon(this.d.importeEnLetras)],
      'Helvetica-Bold',
      tam,
      anchoLetras - 16,
    );
    const altoIzquierda = letras.length
      ? letras.length * this.alto(tam) + 14
      : 0;
    const alto = Math.max(altoDerecha, altoIzquierda);
    this.asegurar(alto + 10);

    if (letras.length) {
      this.doc
        .save()
        .roundedRect(this.x, this.y, anchoLetras, altoIzquierda, 4)
        .fill(COLOR.fondo)
        .restore();
      this.estilo('Helvetica-Bold', tam, COLOR.texto);
      let yy = this.y + 7;
      for (const l of letras) {
        this.linea(l, this.x + 8, yy, anchoLetras - 16);
        yy += this.alto(tam);
      }
    }

    const xT = this.x + this.ancho - anchoTotales;
    let yy = this.y;
    for (const [etiqueta, valor] of filas) {
      this.estilo('Helvetica', tam, COLOR.gris);
      this.linea(etiqueta, xT + 6, yy, anchoTotales - 120);
      this.estilo('Helvetica', tam, COLOR.texto);
      this.linea(valor, xT + anchoTotales - 112, yy, 106, 'right');
      yy += this.alto(tam) + 2;
    }
    yy += 2;
    this.doc
      .save()
      .roundedRect(xT, yy, anchoTotales, altoTotal, 4)
      .fill(COLOR.marca)
      .restore();
    this.estilo('Helvetica-Bold', this.tam.total, COLOR.blanco);
    this.linea('IMPORTE TOTAL', xT + 8, yy + 5.5, anchoTotales - 120);
    this.estilo('Helvetica-Bold', this.tam.total, COLOR.acentoClaro);
    this.linea(
      `${this.simbolo} ${monto(this.d.totales?.total)}`,
      xT + anchoTotales - 118,
      yy + 5.5,
      110,
      'right',
    );
    this.y += alto + 12;
  }

  private creditoA4(): void {
    if (this.d.formaPago?.tipo !== 'Credito') return;
    const cuotas = this.cuotas;
    const tam = this.tam.normal;
    const filaAlto = this.alto(tam) + 3;
    const anchoTabla = 300;
    // Título, monto pendiente y las primeras cuotas siempre juntos.
    this.asegurar(
      this.alto(tam) * 2 + 8 + filaAlto * Math.min(cuotas.length + 1, 4),
    );
    this.doc
      .save()
      .rect(this.x, this.y - 0.5, 3, this.alto(tam) - 1)
      .fill(COLOR.acento)
      .restore();
    this.estilo('Helvetica-Bold', tam, COLOR.marca);
    this.linea('FORMA DE PAGO: CRÉDITO', this.x + 8, this.y, this.ancho - 8);
    this.y += this.alto(tam) + 2;
    this.estilo('Helvetica', tam, COLOR.texto);
    this.linea(
      `Monto neto pendiente de pago: ${this.simbolo} ${monto(this.pendienteCredito())}`,
      this.x,
      this.y,
      this.ancho,
    );
    this.y += this.alto(tam) + 4;
    if (!cuotas.length) return;
    const cols = [
      { t: 'CUOTA', w: 70 },
      { t: 'FECHA DE PAGO', w: 110 },
      { t: 'MONTO', w: anchoTabla - 180 },
    ];
    const encabezado = () => {
      this.doc
        .save()
        .rect(this.x, this.y, anchoTabla, filaAlto)
        .fill(COLOR.marca)
        .rect(this.x, this.y + filaAlto - 1.2, anchoTabla, 1.2)
        .fill(COLOR.acento)
        .restore();
      this.estilo('Helvetica-Bold', tam - 1, COLOR.blanco);
      let cx = this.x;
      cols.forEach((c, i) => {
        this.linea(
          c.t,
          cx + 4,
          this.y + 2.5,
          c.w - 8,
          i === 2 ? 'right' : 'left',
        );
        cx += c.w;
      });
      this.y += filaAlto;
    };
    encabezado();
    for (const cuota of cuotas) {
      if (this.asegurar(filaAlto)) encabezado();
      this.estilo('Helvetica', tam, COLOR.texto);
      const valores = [
        `Cuota ${String(cuota.numero).padStart(3, '0')}`,
        textoPdf(cuota.fechaPago),
        `${this.simbolo} ${monto(cuota.monto)}`,
      ];
      let cx = this.x;
      cols.forEach((c, i) => {
        this.linea(
          valores[i],
          cx + 4,
          this.y + 1.5,
          c.w - 8,
          i === 2 ? 'right' : 'left',
        );
        cx += c.w;
      });
      this.y += filaAlto;
      this.doc
        .save()
        .lineWidth(0.4)
        .strokeColor(COLOR.linea)
        .moveTo(this.x, this.y)
        .lineTo(this.x + anchoTabla, this.y)
        .stroke()
        .restore();
    }
    this.y += 10;
  }

  private notasA4(): void {
    const tam = this.tam.normal;
    for (const [etiqueta, valor] of [
      ['MEDIO DE PAGO', this.d.medioPago],
      ['OBSERVACIONES', this.d.observaciones],
    ] as const) {
      const textos = parrafos(valor);
      if (!textos.length) continue;
      this.asegurar(this.alto(tam) * 2 + 2);
      this.estilo('Helvetica-Bold', tam - 0.6, COLOR.gris);
      this.linea(etiqueta, this.x, this.y, this.ancho);
      this.y += this.alto(tam);
      this.parrafo(textos, { tam });
      this.y += 6;
    }
  }

  /** QR + valor resumen + leyenda en un recuadro que no se parte. */
  private qrA4(): void {
    const lado = LADO_QR.a4;
    const relleno = 8;
    const xTexto = this.x + relleno + lado + 14;
    const anchoTexto = this.ancho - (xTexto - this.x) - relleno;
    const tam = this.tam.chico + 0.4;
    const hash = textoPdf(this.d.codigoHash);
    const lineasHash = this.lineasDe(
      [`Resumen (hash): ${hash || 'no disponible'}`],
      'Helvetica-Bold',
      tam,
      anchoTexto,
    );
    const lineasLeyenda = this.lineasDe(
      [this.leyenda],
      'Helvetica',
      tam,
      anchoTexto,
    );
    const sinQr = this.qr
      ? []
      : this.lineasDe(
          [
            textoPdf(this.d.avisoEstado)
              ? `Código QR no disponible: ${textoPdf(this.d.avisoEstado)}`
              : 'Código QR no disponible: el comprobante aún no tiene firma electrónica.',
          ],
          'Helvetica-Bold',
          tam,
          lado - 12,
        );
    const altoTexto =
      (lineasHash.length + lineasLeyenda.length) * this.alto(tam) + 8;
    const alto = Math.max(lado, altoTexto) + relleno * 2;
    this.asegurar(alto + 4);

    this.doc
      .save()
      .roundedRect(this.x, this.y, this.ancho, alto, 4)
      .lineWidth(0.7)
      .strokeColor(COLOR.linea)
      .stroke()
      .restore();
    const xQr = this.x + relleno;
    const yQr = this.y + relleno;
    if (this.qr) {
      this.imagen(this.qr, xQr, yQr, lado, lado);
    } else {
      this.doc
        .save()
        .lineWidth(0.8)
        .dash(3, { space: 2 })
        .strokeColor(COLOR.grisClaro)
        .rect(xQr, yQr, lado, lado)
        .stroke()
        .undash()
        .restore();
      this.estilo('Helvetica-Bold', tam, COLOR.aviso);
      let yy = yQr + (lado - sinQr.length * this.alto(tam)) / 2;
      for (const l of sinQr) {
        this.linea(l, xQr + 6, yy, lado - 12, 'center');
        yy += this.alto(tam);
      }
    }
    let yy = this.y + (alto - altoTexto) / 2 + 2;
    this.estilo('Helvetica-Bold', tam, COLOR.texto);
    for (const l of lineasHash) {
      this.linea(l, xTexto, yy, anchoTexto);
      yy += this.alto(tam);
    }
    yy += 8;
    this.estilo('Helvetica', tam, COLOR.gris);
    for (const l of lineasLeyenda) {
      this.linea(l, xTexto, yy, anchoTexto);
      yy += this.alto(tam);
    }
    this.y += alto + 6;
  }

  /** Pie fijo de cada hoja: documento y numeración (se dibuja al final, cuando se conoce el total de hojas). */
  private pieA4(): void {
    const rango = this.doc.bufferedPageRange();
    for (let i = rango.start; i < rango.start + rango.count; i++) {
      this.doc.switchToPage(i);
      const yPie = this.doc.page.height - this.margen - 8;
      this.doc
        .save()
        .lineWidth(0.4)
        .strokeColor(COLOR.linea)
        .moveTo(this.x, yPie - 4)
        .lineTo(this.x + this.ancho, yPie - 4)
        .stroke()
        .restore();
      this.estilo('Helvetica', 7, COLOR.grisClaro);
      this.linea(
        `${this.titulo} ${this.codigo} · ${textoPdf(this.d.emisor?.razonSocial)}`,
        this.x,
        yPie,
        this.ancho * 0.75,
      );
      this.linea(
        `Página ${i - rango.start + 1} de ${rango.count}`,
        this.x + this.ancho * 0.75,
        yPie,
        this.ancho * 0.25,
        'right',
      );
    }
  }

  // ── Ticket 80 mm ────────────────────────────────────────────────

  private dibujarTicket(): void {
    this.cabeceraTicket();
    if (this.d.ambiente === 'beta') this.banner(AVISO_BETA_PDF, COLOR.peligro);
    if (textoPdf(this.d.avisoEstado))
      this.banner(String(this.d.avisoEstado), COLOR.aviso);
    this.filasTicket(this.filasDocumento());
    this.separador();
    this.filasTicket(this.filasCliente());
    if (this.d.referencia) {
      this.separador();
      this.filasTicket(this.filasReferencia());
    }
    this.separador();
    this.itemsTicket();
    this.separador();
    this.totalesTicket();
    this.creditoTicket();
    this.notasTicket();
    this.separador();
    this.qrTicket();
    if (this.d.ambiente === 'beta') this.banner(AVISO_BETA_PDF, COLOR.peligro);
  }

  private centrado(
    textos: string[],
    fuente: Fuente,
    tam: number,
    color: string = COLOR.texto,
    maximo?: number,
  ): void {
    for (const l of this.lineasDe(textos, fuente, tam, this.ancho, maximo)) {
      this.asegurar(this.alto(tam));
      this.estilo(fuente, tam, color);
      this.linea(l, this.x, this.y, this.ancho, 'center');
      this.y += this.alto(tam);
    }
  }

  private cabeceraTicket(): void {
    const e = this.d.emisor ?? ({} as EmisorPdfComprobante);
    if (this.logo) {
      const logo = this.medidaLogo(104, 40);
      this.imagen(
        this.logo.imagen,
        this.x + (this.ancho - logo.ancho) / 2,
        this.y,
        logo.ancho,
        logo.alto,
      );
      this.y += logo.alto + 4;
    }
    this.centrado(
      [e.razonSocial],
      'Helvetica-Bold',
      this.tam.razon,
      COLOR.marca,
      3,
    );
    if (
      textoPdf(e.nombreComercial) &&
      textoPdf(e.nombreComercial) !== textoPdf(e.razonSocial)
    ) {
      this.centrado(
        [String(e.nombreComercial)],
        'Helvetica-Bold',
        this.tam.normal,
        COLOR.texto,
        2,
      );
    }
    this.centrado(
      [`RUC ${textoPdf(e.ruc)}`],
      'Helvetica-Bold',
      this.tam.normal,
    );
    this.centrado(
      [e.direccion, e.ubicacion ?? ''],
      'Helvetica',
      this.tam.chico,
      COLOR.gris,
      4,
    );
    const contacto = [
      textoPdf(e.telefono) && `Telf. ${textoPdf(e.telefono)}`,
      textoPdf(e.email),
    ]
      .filter(Boolean)
      .join(' · ');
    if (contacto)
      this.centrado([contacto], 'Helvetica', this.tam.chico, COLOR.gris, 2);
    this.separador();
    this.centrado([this.titulo], 'Helvetica-Bold', this.tam.titulo);
    this.centrado([this.codigo], 'Helvetica-Bold', this.tam.serie, COLOR.marca);
    this.separador();
  }

  /** «Etiqueta: valor» con el valor partido en líneas bajo su columna. */
  private filasTicket(filas: Fila[]): void {
    const tam = this.tam.normal;
    const cortas = filas.map(
      ([etiqueta, valor]): Fila => [
        ETIQUETAS_TICKET[etiqueta] ?? etiqueta,
        valor,
      ],
    );
    // La columna de etiquetas mide lo que la más larga del bloque (con tope, para dejar sitio al valor).
    this.estilo('Helvetica-Bold', tam);
    const anchoEtiqueta = Math.min(
      92,
      Math.max(
        ...cortas.map(([etiqueta]) => this.doc.widthOfString(`${etiqueta}:`)),
      ) + 5,
    );
    const anchoValor = this.ancho - anchoEtiqueta;
    for (const [etiqueta, valor] of cortas) {
      const lineas = this.lineasDe(
        parrafos(valor).length ? parrafos(valor) : ['—'],
        'Helvetica',
        tam,
        anchoValor,
        8,
      );
      lineas.forEach((l, i) => {
        this.asegurar(this.alto(tam));
        if (i === 0) {
          this.estilo('Helvetica-Bold', tam, COLOR.gris);
          this.linea(`${etiqueta}:`, this.x, this.y, anchoEtiqueta - 3);
        }
        this.estilo('Helvetica', tam, COLOR.texto);
        this.linea(l, this.x + anchoEtiqueta, this.y, anchoValor);
        this.y += this.alto(tam);
      });
    }
  }

  /** Cada ítem en dos líneas: descripción (ajustada) y «cantidad unidad x precio … importe». */
  private itemsTicket(): void {
    const tam = this.tam.normal;
    const anchoImporte = 58;
    this.asegurar(this.alto(tam));
    this.estilo('Helvetica-Bold', tam - 0.4, COLOR.marca);
    this.linea(
      'DESCRIPCIÓN / CANT. x P. UNIT.',
      this.x,
      this.y,
      this.ancho - anchoImporte,
    );
    this.linea(
      'IMPORTE',
      this.x + this.ancho - anchoImporte,
      this.y,
      anchoImporte,
      'right',
    );
    this.y += this.alto(tam) + 2;
    const items = Array.isArray(this.d.items) ? this.d.items : [];
    for (const item of items) {
      const codigo = textoPdf(item.codigo);
      const descripcion = this.lineasDe(
        [
          codigo
            ? `${codigo} - ${String(item.descripcion ?? '')}`
            : String(item.descripcion ?? ''),
        ],
        'Helvetica',
        tam,
        this.ancho,
        MAXIMO_LINEAS_DESCRIPCION,
      );
      // Un ítem completo no se parte entre páginas (solo aplica a tickets larguísimos).
      this.asegurar((descripcion.length + 1) * this.alto(tam) + 2);
      this.estilo('Helvetica', tam, COLOR.texto);
      for (const l of descripcion) {
        this.linea(l, this.x, this.y, this.ancho);
        this.y += this.alto(tam);
      }
      const descuento = Number(item.descuento)
        ? `  (dscto. ${monto(item.descuento)})`
        : '';
      this.estilo('Helvetica', tam, COLOR.gris);
      this.linea(
        `${cantidad(item.cantidad)} ${unidadLegible(item.unidad)} x ${unitario(item.precioUnitario)}${descuento}`,
        this.x + 6,
        this.y,
        this.ancho - anchoImporte - 6,
      );
      this.estilo('Helvetica-Bold', tam, COLOR.texto);
      this.linea(
        monto(item.importe),
        this.x + this.ancho - anchoImporte,
        this.y,
        anchoImporte,
        'right',
      );
      this.y += this.alto(tam) + 2;
    }
    if (!items.length)
      this.centrado(
        ['Sin líneas de detalle.'],
        'Helvetica-Oblique',
        tam,
        COLOR.gris,
      );
  }

  private totalesTicket(): void {
    const tam = this.tam.normal;
    const filas = this.filasTotales();
    const letras = this.lineasDe(
      [conSon(this.d.importeEnLetras)],
      'Helvetica-Bold',
      tam,
      this.ancho,
    );
    this.asegurar(
      filas.length * this.alto(tam) +
        this.alto(this.tam.total) +
        6 +
        letras.length * this.alto(tam) +
        4,
    );
    for (const [etiqueta, valor] of filas) {
      this.estilo('Helvetica', tam, COLOR.gris);
      this.linea(etiqueta, this.x, this.y, this.ancho - 80);
      this.estilo('Helvetica', tam, COLOR.texto);
      this.linea(valor, this.x + this.ancho - 80, this.y, 80, 'right');
      this.y += this.alto(tam);
    }
    this.y += 2;
    this.doc
      .save()
      .rect(
        this.x - 4,
        this.y - 1.5,
        this.ancho + 8,
        this.alto(this.tam.total) + 2,
      )
      .fill(COLOR.marca)
      .restore();
    this.estilo('Helvetica-Bold', this.tam.total, COLOR.blanco);
    this.linea('IMPORTE TOTAL', this.x, this.y, this.ancho - 96);
    this.estilo('Helvetica-Bold', this.tam.total, COLOR.acentoClaro);
    this.linea(
      `${this.simbolo} ${monto(this.d.totales?.total)}`,
      this.x + this.ancho - 96,
      this.y,
      96,
      'right',
    );
    this.y += this.alto(this.tam.total) + 4;
    this.estilo('Helvetica-Bold', tam, COLOR.texto);
    for (const l of letras) {
      this.linea(l, this.x, this.y, this.ancho);
      this.y += this.alto(tam);
    }
    this.y += 2;
  }

  private creditoTicket(): void {
    if (this.d.formaPago?.tipo !== 'Credito') return;
    const tam = this.tam.normal;
    this.separador();
    this.asegurar(this.alto(tam) * 2);
    this.estilo('Helvetica-Bold', tam, COLOR.marca);
    this.linea('FORMA DE PAGO: CRÉDITO', this.x, this.y, this.ancho);
    this.y += this.alto(tam);
    this.estilo('Helvetica', tam, COLOR.texto);
    this.linea('Monto pendiente de pago', this.x, this.y, this.ancho - 80);
    this.linea(
      `${this.simbolo} ${monto(this.pendienteCredito())}`,
      this.x + this.ancho - 80,
      this.y,
      80,
      'right',
    );
    this.y += this.alto(tam);
    for (const cuota of this.cuotas) {
      this.asegurar(this.alto(tam));
      this.estilo('Helvetica', tam, COLOR.texto);
      this.linea(
        `Cuota ${String(cuota.numero).padStart(3, '0')} - vence ${textoPdf(cuota.fechaPago)}`,
        this.x,
        this.y,
        this.ancho - 80,
      );
      this.linea(
        `${this.simbolo} ${monto(cuota.monto)}`,
        this.x + this.ancho - 80,
        this.y,
        80,
        'right',
      );
      this.y += this.alto(tam);
    }
  }

  private notasTicket(): void {
    const filas: Fila[] = [];
    if (parrafos(this.d.medioPago).length)
      filas.push(['Medio de pago', String(this.d.medioPago)]);
    if (parrafos(this.d.observaciones).length)
      filas.push(['Observaciones', String(this.d.observaciones)]);
    if (!filas.length) return;
    this.separador();
    for (const [etiqueta, valor] of filas) {
      this.asegurar(this.alto(this.tam.normal) * 2);
      this.estilo('Helvetica-Bold', this.tam.normal, COLOR.gris);
      this.linea(`${etiqueta}:`, this.x, this.y, this.ancho);
      this.y += this.alto(this.tam.normal);
      this.parrafo(parrafos(valor), { tam: this.tam.normal });
    }
  }

  private qrTicket(): void {
    const lado = LADO_QR.ticket;
    const tam = this.tam.chico;
    const hash = this.lineasDe(
      [`Resumen (hash): ${textoPdf(this.d.codigoHash) || 'no disponible'}`],
      'Helvetica',
      tam,
      this.ancho,
    );
    const leyenda = this.lineasDe([this.leyenda], 'Helvetica', tam, this.ancho);
    const sinQr = this.qr
      ? []
      : this.lineasDe(
          [
            textoPdf(this.d.avisoEstado)
              ? `Código QR no disponible: ${textoPdf(this.d.avisoEstado)}`
              : 'Código QR no disponible: el comprobante aún no tiene firma electrónica.',
          ],
          'Helvetica-Bold',
          tam,
          this.ancho,
        );
    const altoQr = this.qr ? lado + 6 : sinQr.length * this.alto(tam) + 4;
    this.asegurar(altoQr + (hash.length + leyenda.length) * this.alto(tam) + 6);
    if (this.qr) {
      this.imagen(
        this.qr,
        this.x + (this.ancho - lado) / 2,
        this.y,
        lado,
        lado,
      );
    } else {
      this.estilo('Helvetica-Bold', tam, COLOR.aviso);
      let yy = this.y;
      for (const l of sinQr) {
        this.linea(l, this.x, yy, this.ancho, 'center');
        yy += this.alto(tam);
      }
    }
    this.y += altoQr;
    this.estilo('Helvetica', tam, COLOR.texto);
    for (const l of hash) {
      this.linea(l, this.x, this.y, this.ancho, 'center');
      this.y += this.alto(tam);
    }
    this.y += 3;
    this.estilo('Helvetica', tam, COLOR.gris);
    for (const l of leyenda) {
      this.linea(l, this.x, this.y, this.ancho, 'center');
      this.y += this.alto(tam);
    }
    this.y += 3;
  }
}
