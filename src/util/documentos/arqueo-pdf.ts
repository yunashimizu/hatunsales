import type { ArqueoDetalleResponse } from '../../models/model/caja-arqueo.response';
import { Dinero } from '../../caja/dominio/dinero';
import { fechaHoraLimaLegible } from '../fecha-lima';
import { PALETA } from './proforma-documento';
import { textoPdf } from './proforma-pdf';

// pdfkit no trae tipos en este proyecto (mismo uso que en proformas y reportes).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require('pdfkit');

/**
 * Comprobante imprimible del arqueo de caja: ticket de 80 mm (alto según contenido) o A4.
 * Todo el texto de una línea se escribe con `lineBreak: false`; los saltos los decide este
 * archivo. En A4 se agrega página si un bloque no entra; el ticket mide su alto antes.
 */
export type FormatoArqueoPdf = 'ticket' | 'a4';

export interface EmisorArqueoPdf {
  razon_social: string;
  ruc: string;
  direccion?: string | null;
  /** PNG/JPEG ya descargado (solo A4). */
  logo?: Buffer | null;
}

export interface DatosArqueoPdf {
  arqueo: ArqueoDetalleResponse;
  emisor: EmisorArqueoPdf;
  formato: FormatoArqueoPdf;
  generado_en?: Date;
}

const ANCHO_TICKET = 226.77; // 80 mm
const MARGEN_TICKET = 12;
const MARGEN_A4 = 42;

type Fuente = 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique';
type Alineacion = 'left' | 'right' | 'center';

const COLOR = {
  texto: PALETA.texto,
  gris: PALETA.gris,
  grisClaro: PALETA.grisClaro,
  linea: PALETA.linea,
  fondo: PALETA.fondo,
  marca: PALETA.grafito,
  acento: PALETA.naranja,
  peligro: PALETA.peligro,
  aviso: PALETA.aviso,
  exito: '#1E7B34',
  blanco: PALETA.blanco,
};

function soles(valor: number | null | undefined): string {
  if (valor === null || valor === undefined) return '—';
  return Dinero.desdeNumeroRedondeado(valor).formatear();
}

function fecha(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : fechaHoraLimaLegible(d);
}

function colorEstado(estado: string): string {
  if (estado === 'faltante') return COLOR.peligro;
  if (estado === 'sobrante') return COLOR.aviso;
  if (estado === 'cuadra') return COLOR.exito;
  return COLOR.gris;
}

function etiquetaEstado(estado: string): string {
  return { cuadra: 'CUADRA', faltante: 'FALTANTE', sobrante: 'SOBRANTE', sin_declarar: 'SIN DECLARAR' }[estado] ?? estado.toUpperCase();
}

export function nombreArchivoArqueo(arqueo: Pick<ArqueoDetalleResponse, 'codigo'>, formato: FormatoArqueoPdf): string {
  return `arqueo-${arqueo.codigo.toLowerCase()}${formato === 'ticket' ? '-ticket' : ''}.pdf`;
}

export async function generarArqueoPdf(datos: DatosArqueoPdf): Promise<Buffer> {
  if (datos.formato === 'ticket') {
    const alto = medirTicket(datos);
    return renderizar(datos, [ANCHO_TICKET, alto], MARGEN_TICKET);
  }
  return renderizar(datos, 'A4', MARGEN_A4);
}

/** Primera pasada sobre una hoja muy alta para saber cuánto mide el ticket. */
function medirTicket(datos: DatosArqueoPdf): number {
  const doc = new PDFDocument({ size: [ANCHO_TICKET, 20_000], margins: margenes(MARGEN_TICKET), autoFirstPage: true });
  doc.on('data', () => undefined);
  const dibujo = new DibujoArqueo(doc, datos, MARGEN_TICKET);
  dibujo.dibujar();
  doc.end();
  return Math.ceil(dibujo.yFinal + MARGEN_TICKET);
}

function margenes(m: number) {
  return { top: m, bottom: m, left: m, right: m };
}

function renderizar(datos: DatosArqueoPdf, size: 'A4' | [number, number], margen: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size,
        margins: margenes(margen),
        bufferPages: true,
        info: {
          Title: `Arqueo de caja ${textoPdf(datos.arqueo.codigo)}`,
          Author: textoPdf(datos.emisor.razon_social),
          Subject: datos.arqueo.tipo === 'cierre' ? 'Arqueo de cierre de caja' : 'Arqueo parcial de caja',
          Creator: 'HatunSales',
        },
      });
      const partes: Buffer[] = [];
      doc.on('data', (parte: Buffer) => partes.push(parte));
      doc.on('end', () => resolve(Buffer.concat(partes)));
      doc.on('error', (error: unknown) => reject(error));
      new DibujoArqueo(doc, datos, margen).dibujar();
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

class DibujoArqueo {
  private y: number;
  private readonly x: number;
  private readonly ancho: number;
  private readonly ticket: boolean;
  private readonly a: ArqueoDetalleResponse;
  private readonly tam: { titulo: number; normal: number; chico: number; enfasis: number };

  constructor(
    private readonly doc: any,
    private readonly d: DatosArqueoPdf,
    private readonly margen: number,
  ) {
    this.y = margen;
    this.x = margen;
    this.ancho = doc.page.width - margen * 2;
    this.ticket = d.formato === 'ticket';
    this.a = d.arqueo;
    this.tam = this.ticket
      ? { titulo: 10.5, normal: 7.6, chico: 6.6, enfasis: 9 }
      : { titulo: 17, normal: 9.5, chico: 8, enfasis: 12 };
  }

  get yFinal(): number {
    return this.y;
  }

  dibujar(): void {
    this.cabecera();
    this.datosTurno();
    this.bloqueEfectivo();
    this.bloqueDenominaciones();
    this.bloqueMedios();
    this.bloqueInformativo();
    this.bloqueObservacion();
    this.firmas();
    this.pie();
  }

  // ── Primitivas ──────────────────────────────────────────────────

  private estilo(fuente: Fuente, tam: number, color: string = COLOR.texto): void {
    this.doc.font(fuente).fontSize(tam).fillColor(color);
  }

  private alto(tam: number): number {
    return tam * 1.35;
  }

  private asegurar(alto: number): void {
    if (this.ticket) return;
    const limite = this.doc.page.height - this.margen - 24;
    if (this.y + alto > limite) {
      this.doc.addPage();
      this.y = this.margen;
    }
  }

  /** Escribe UNA línea (sin salto automático), recortada con "…" y alineada dentro de `ancho`. */
  private texto(valor: string, x: number, y: number, ancho: number, alinear: Alineacion = 'left'): void {
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
    while (recorte.length > 1 && this.doc.widthOfString(`${recorte}…`) > ancho) recorte = recorte.slice(0, -1);
    return `${recorte.trimEnd()}…`;
  }

  /** Parte un texto en líneas que caben en `ancho` con la fuente actual. */
  private envolver(texto: string, ancho: number): string[] {
    const lineas: string[] = [];
    let actual = '';
    for (const palabra of texto.split(' ')) {
      const prueba = actual ? `${actual} ${palabra}` : palabra;
      if (this.doc.widthOfString(prueba) <= ancho) {
        actual = prueba;
        continue;
      }
      if (actual) lineas.push(actual);
      actual = this.doc.widthOfString(palabra) <= ancho ? palabra : this.recortar(palabra, ancho);
    }
    if (actual) lineas.push(actual);
    return lineas;
  }

  private separador(punteado = this.ticket): void {
    const y = this.y + 2;
    this.doc.save().lineWidth(0.6).strokeColor(COLOR.linea);
    if (punteado) this.doc.dash(1.5, { space: 1.5 });
    this.doc.moveTo(this.x, y).lineTo(this.x + this.ancho, y).stroke();
    this.doc.undash().restore();
    this.y += 7;
  }

  /** Fila etiqueta … valor, con un tercer dato opcional (conteo) a la derecha de la etiqueta. */
  private fila(etiqueta: string, valor: string, opciones: { fuente?: Fuente; color?: string; tam?: number; nota?: string } = {}): void {
    const tam = opciones.tam ?? this.tam.normal;
    this.asegurar(this.alto(tam));
    const anchoValor = this.ticket ? 78 : 130;
    this.estilo(opciones.fuente ?? 'Helvetica', tam, opciones.color ?? COLOR.texto);
    this.texto(etiqueta, this.x, this.y, this.ancho - anchoValor - (opciones.nota ? 30 : 0));
    if (opciones.nota) {
      this.estilo('Helvetica', this.tam.chico, COLOR.grisClaro);
      this.texto(opciones.nota, this.x + this.ancho - anchoValor - 30, this.y + (tam - this.tam.chico) / 2, 28, 'right');
      this.estilo(opciones.fuente ?? 'Helvetica', tam, opciones.color ?? COLOR.texto);
    }
    this.texto(valor, this.x + this.ancho - anchoValor, this.y, anchoValor, 'right');
    this.y += this.alto(tam);
  }

  private tituloBloque(titulo: string): void {
    this.asegurar(this.alto(this.tam.normal) + 20);
    this.y += this.ticket ? 1 : 6;
    this.estilo('Helvetica-Bold', this.ticket ? this.tam.normal : this.tam.normal + 1, COLOR.marca);
    this.texto(titulo.toUpperCase(), this.x, this.y, this.ancho);
    this.y += this.alto(this.tam.normal) + (this.ticket ? 1 : 3);
    if (!this.ticket) {
      this.doc.save().lineWidth(1.2).strokeColor(COLOR.acento).moveTo(this.x, this.y - 2).lineTo(this.x + 36, this.y - 2).stroke().restore();
      this.y += 3;
    }
  }

  private parrafo(valor: string, tam = this.tam.normal, color: string = COLOR.texto, fuente: Fuente = 'Helvetica'): void {
    const t = textoPdf(valor);
    if (!t) return;
    this.estilo(fuente, tam, color);
    for (const linea of this.envolver(t, this.ancho)) {
      this.asegurar(this.alto(tam));
      this.estilo(fuente, tam, color);
      this.doc.text(linea, this.x, this.y, { lineBreak: false });
      this.y += this.alto(tam);
    }
    this.y += 2;
  }

  // ── Bloques ─────────────────────────────────────────────────────

  private cabecera(): void {
    const tipo = this.a.tipo === 'cierre' ? 'DE CIERRE' : 'PARCIAL';
    if (this.ticket) {
      this.estilo('Helvetica-Bold', this.tam.enfasis, COLOR.marca);
      this.texto(this.d.emisor.razon_social || 'HATUNSALES S.A.C.', this.x, this.y, this.ancho, 'center');
      this.y += this.alto(this.tam.enfasis);
      this.estilo('Helvetica', this.tam.chico, COLOR.gris);
      this.texto(`RUC ${this.d.emisor.ruc}`, this.x, this.y, this.ancho, 'center');
      this.y += this.alto(this.tam.chico);
      this.separador();
      this.estilo('Helvetica-Bold', this.tam.titulo, COLOR.texto);
      this.texto(`ARQUEO DE CAJA ${tipo}`, this.x, this.y, this.ancho, 'center');
      this.y += this.alto(this.tam.titulo);
      this.estilo('Helvetica', this.tam.normal, COLOR.gris);
      this.texto(this.a.codigo, this.x, this.y, this.ancho, 'center');
      this.y += this.alto(this.tam.normal);
      this.separador();
      return;
    }

    const alto = 64;
    const xTexto = this.d.emisor.logo ? this.x + 76 : this.x;
    if (this.d.emisor.logo) {
      try {
        this.doc.image(this.d.emisor.logo, this.x, this.y, { fit: [66, 56], valign: 'center' });
      } catch {
        // Logo ilegible: el documento sale sin logo.
      }
    }
    this.estilo('Helvetica-Bold', 13, COLOR.marca);
    this.texto(this.d.emisor.razon_social || 'HATUNSALES S.A.C.', xTexto, this.y + 6, 250);
    this.estilo('Helvetica', 9, COLOR.gris);
    this.texto(`RUC ${this.d.emisor.ruc}`, xTexto, this.y + 24, 250);
    if (this.d.emisor.direccion) this.texto(this.d.emisor.direccion, xTexto, this.y + 37, 250);

    const anchoCaja = 190;
    const xCaja = this.x + this.ancho - anchoCaja;
    this.doc.save().roundedRect(xCaja, this.y, anchoCaja, alto, 6).lineWidth(1.2).strokeColor(COLOR.marca).stroke().restore();
    this.estilo('Helvetica-Bold', 12.5, COLOR.marca);
    this.texto('ARQUEO DE CAJA', xCaja, this.y + 10, anchoCaja, 'center');
    this.estilo('Helvetica-Bold', 10, COLOR.acento);
    this.texto(tipo, xCaja, this.y + 28, anchoCaja, 'center');
    this.estilo('Helvetica', 10, COLOR.texto);
    this.texto(this.a.codigo, xCaja, this.y + 44, anchoCaja, 'center');
    this.y += alto + 14;
  }

  private datosTurno(): void {
    const caja = this.a.sucursal_nombre ? `${this.a.caja_nombre} · ${this.a.sucursal_nombre}` : this.a.caja_nombre;
    const pares: [string, string][] = [
      ['Caja', caja],
      ['Cajero (turno)', this.a.cajero_nombre ?? '—'],
      ['Arqueo realizado por', this.a.usuario_nombre ?? '—'],
      ['Apertura del turno', fecha(this.a.fecha_apertura)],
      ['Fecha del arqueo', fecha(this.a.fecha)],
      ['Estado del turno', this.a.turno_abierto ? 'Abierto' : 'Cerrado'],
    ];
    if (this.ticket) {
      for (const [etiqueta, valor] of pares) {
        this.estilo('Helvetica', this.tam.normal, COLOR.gris);
        this.texto(`${etiqueta}:`, this.x, this.y, 80);
        this.estilo('Helvetica', this.tam.normal, COLOR.texto);
        this.texto(valor, this.x + 80, this.y, this.ancho - 80);
        this.y += this.alto(this.tam.normal);
      }
      this.separador();
      return;
    }
    // A4: dos columnas sobre un fondo suave.
    const filas = Math.ceil(pares.length / 2);
    const altoFila = 26;
    const altoBloque = filas * altoFila + 8;
    this.asegurar(altoBloque);
    this.doc.save().roundedRect(this.x, this.y, this.ancho, altoBloque, 5).fill(COLOR.fondo).restore();
    const anchoCol = this.ancho / 2;
    pares.forEach(([etiqueta, valor], i) => {
      const col = i % 2;
      const fila = Math.floor(i / 2);
      const xx = this.x + 12 + col * anchoCol;
      const yy = this.y + 6 + fila * altoFila;
      this.estilo('Helvetica', 7.5, COLOR.grisClaro);
      this.texto(etiqueta.toUpperCase(), xx, yy, anchoCol - 24);
      this.estilo('Helvetica-Bold', 10, COLOR.texto);
      this.texto(valor, xx, yy + 10, anchoCol - 24);
    });
    this.y += altoBloque + 6;
  }

  private bloqueEfectivo(): void {
    const e = this.a.efectivo;
    this.tituloBloque('Efectivo en caja');
    this.fila('Monto inicial', soles(e.monto_inicial));
    this.fila('+ Ventas cobradas en efectivo', soles(e.ventas), { nota: `(${e.operaciones_ventas})` });
    if (e.abonos || e.operaciones_abonos) this.fila('+ Cobros de crédito en efectivo', soles(e.abonos), { nota: `(${e.operaciones_abonos})` });
    if (e.ingresos || e.cantidad_ingresos) this.fila('+ Ingresos de efectivo', soles(e.ingresos), { nota: `(${e.cantidad_ingresos})` });
    if (e.egresos || e.cantidad_egresos) this.fila('- Egresos de efectivo', soles(e.egresos), { nota: `(${e.cantidad_egresos})` });
    this.fila('= Efectivo esperado', soles(this.a.efectivo_esperado), { fuente: 'Helvetica-Bold' });
    this.fila(this.a.conteo_por_denominaciones ? 'Efectivo contado (denominaciones)' : 'Efectivo contado', soles(this.a.efectivo_contado), {
      fuente: 'Helvetica-Bold',
    });
    this.resultado();
    if (e.vueltos_entregados > 0) {
      this.parrafo(`Vueltos entregados ${soles(e.vueltos_entregados)} (ya descontados de las ventas).`, this.tam.chico, COLOR.grisClaro, 'Helvetica-Oblique');
    }
    if (this.ticket) this.separador();
  }

  /** Recuadro con la diferencia de efectivo: verde cuadra, rojo faltante, ámbar sobrante. */
  private resultado(): void {
    const color = colorEstado(this.a.estado);
    const alto = this.ticket ? 22 : 30;
    this.asegurar(alto + 6);
    this.y += 3;
    this.doc.save().roundedRect(this.x, this.y, this.ancho, alto, 4).lineWidth(1.2).strokeColor(color).stroke().restore();
    this.estilo('Helvetica-Bold', this.tam.enfasis, color);
    const yTexto = this.y + (alto - this.tam.enfasis) / 2 - 1;
    this.texto(`DIFERENCIA ${etiquetaEstado(this.a.estado)}`, this.x + 8, yTexto, this.ancho / 2);
    this.texto(soles(this.a.diferencia), this.x + this.ancho / 2, yTexto, this.ancho / 2 - 8, 'right');
    this.y += alto + 4;
    if (this.a.estado !== 'cuadra' || this.a.mensaje !== 'Cuadra') {
      this.parrafo(this.a.mensaje, this.tam.chico, color);
    }
  }

  private bloqueDenominaciones(): void {
    if (!this.a.conteo_por_denominaciones) return;
    const lineas = this.ticket ? this.a.denominaciones.filter((d) => d.cantidad > 0) : this.a.denominaciones;
    this.tituloBloque('Conteo por denominación');
    if (!lineas.length) {
      this.parrafo('Sin billetes ni monedas (S/ 0.00).', this.tam.chico, COLOR.gris);
    }
    if (this.ticket) {
      for (const d of lineas) this.fila(`${d.etiqueta} x ${d.cantidad}`, soles(d.subtotal));
    } else {
      // Billetes a la izquierda, monedas a la derecha.
      const billetes = lineas.filter((d) => d.tipo === 'billete');
      const monedas = lineas.filter((d) => d.tipo === 'moneda');
      const filas = Math.max(billetes.length, monedas.length);
      const altoFila = this.alto(this.tam.normal) + 1;
      this.asegurar(altoFila * (filas + 2));
      const anchoCol = (this.ancho - 20) / 2;
      const encabezado = (xx: number, titulo: string) => {
        this.estilo('Helvetica-Bold', this.tam.chico, COLOR.gris);
        this.texto(titulo, xx, this.y, anchoCol * 0.4);
        this.texto('Cantidad', xx + anchoCol * 0.4, this.y, anchoCol * 0.25, 'right');
        this.texto('Subtotal', xx + anchoCol * 0.65, this.y, anchoCol * 0.35, 'right');
      };
      encabezado(this.x, 'BILLETES');
      encabezado(this.x + anchoCol + 20, 'MONEDAS');
      this.y += altoFila;
      for (let i = 0; i < filas; i++) {
        [billetes[i], monedas[i]].forEach((d, col) => {
          if (!d) return;
          const xx = this.x + col * (anchoCol + 20);
          if (i % 2 === 0) this.doc.save().rect(xx - 4, this.y - 2, anchoCol + 8, altoFila).fill(COLOR.fondo).restore();
          this.estilo('Helvetica', this.tam.normal, d.cantidad ? COLOR.texto : COLOR.grisClaro);
          this.texto(d.etiqueta, xx, this.y, anchoCol * 0.4);
          this.texto(String(d.cantidad), xx + anchoCol * 0.4, this.y, anchoCol * 0.25, 'right');
          this.texto(soles(d.subtotal), xx + anchoCol * 0.65, this.y, anchoCol * 0.35, 'right');
        });
        this.y += altoFila;
      }
      this.y += 2;
    }
    this.fila('Total billetes', soles(this.a.total_billetes), { tam: this.tam.chico, color: COLOR.gris });
    this.fila('Total monedas', soles(this.a.total_monedas), { tam: this.tam.chico, color: COLOR.gris });
    if (this.ticket) this.separador();
  }

  private bloqueMedios(): void {
    if (!this.a.medios.length) return;
    this.tituloBloque('Otros medios de pago');
    const cols = this.ticket
      ? { nombre: 0.4, esperado: 0.2, declarado: 0.2, diferencia: 0.2 }
      : { nombre: 0.4, esperado: 0.2, declarado: 0.2, diferencia: 0.2 };
    const xs = {
      nombre: this.x,
      esperado: this.x + this.ancho * cols.nombre,
      declarado: this.x + this.ancho * (cols.nombre + cols.esperado),
      diferencia: this.x + this.ancho * (cols.nombre + cols.esperado + cols.declarado),
    };
    const altoFila = this.alto(this.tam.normal);
    this.asegurar(altoFila * 2);
    this.estilo('Helvetica-Bold', this.tam.chico, COLOR.gris);
    this.texto('Medio', xs.nombre, this.y, this.ancho * cols.nombre);
    this.texto('Esperado', xs.esperado, this.y, this.ancho * cols.esperado, 'right');
    this.texto('Declarado', xs.declarado, this.y, this.ancho * cols.declarado, 'right');
    this.texto('Diferencia', xs.diferencia, this.y, this.ancho * cols.diferencia, 'right');
    this.y += altoFila;
    const corto = (n: number | null) => (n === null ? '—' : Dinero.desdeNumeroRedondeado(n).aTexto());
    for (const m of this.a.medios) {
      this.asegurar(altoFila);
      this.estilo('Helvetica', this.tam.normal, COLOR.texto);
      this.texto(m.nombre, xs.nombre, this.y, this.ancho * cols.nombre - 2);
      this.texto(corto(m.esperado), xs.esperado, this.y, this.ancho * cols.esperado, 'right');
      this.texto(m.declarado === null ? 'sin declarar' : corto(m.declarado), xs.declarado, this.y, this.ancho * cols.declarado, 'right');
      this.estilo('Helvetica-Bold', this.tam.normal, colorEstado(m.estado));
      this.texto(m.diferencia === null ? '—' : corto(m.diferencia), xs.diferencia, this.y, this.ancho * cols.diferencia, 'right');
      this.y += altoFila;
    }
    if (this.ticket) this.separador();
  }

  private bloqueInformativo(): void {
    const filas: [string, string, string?][] = [];
    if (this.a.credito.operaciones) filas.push(['Ventas al crédito (no es dinero)', soles(this.a.credito.ventas), `(${this.a.credito.operaciones})`]);
    if (this.a.ventas_web.cantidad) filas.push(['Ventas web (se cobran fuera de caja)', soles(this.a.ventas_web.total), `(${this.a.ventas_web.cantidad})`]);
    if (this.a.ventas_anuladas.cantidad) filas.push(['Ventas anuladas (no cuentan)', soles(this.a.ventas_anuladas.total), `(${this.a.ventas_anuladas.cantidad})`]);
    if (this.a.tolerancia > 0) filas.push(['Tolerancia de redondeo', soles(this.a.tolerancia)]);
    if (!filas.length) return;
    this.tituloBloque('Información del turno');
    for (const [etiqueta, valor, nota] of filas) this.fila(etiqueta, valor, { tam: this.tam.chico, color: COLOR.gris, nota });
    if (this.ticket) this.separador();
  }

  private bloqueObservacion(): void {
    this.tituloBloque('Resultado');
    this.parrafo(this.a.resumen, this.tam.normal, this.a.hay_diferencia ? COLOR.peligro : COLOR.exito, 'Helvetica-Bold');
    if (this.a.observacion) {
      this.y += 2;
      this.parrafo(`Observación: ${this.a.observacion}`, this.tam.normal, COLOR.texto);
    }
    if (this.a.id_cierre) this.parrafo(`Usado en el cierre del turno N° ${this.a.id_cierre}.`, this.tam.chico, COLOR.gris);
  }

  private firmas(): void {
    const alto = this.ticket ? 42 : 70;
    this.asegurar(alto);
    this.y += alto - 16;
    const anchoFirma = this.ticket ? (this.ancho - 16) / 2 : 170;
    const posiciones = this.ticket
      ? [this.x, this.x + anchoFirma + 16]
      : [this.x + 30, this.x + this.ancho - 30 - anchoFirma];
    const etiquetas = ['Cajero', 'Supervisor'];
    posiciones.forEach((xx, i) => {
      this.doc.save().lineWidth(0.7).strokeColor(COLOR.gris).moveTo(xx, this.y).lineTo(xx + anchoFirma, this.y).stroke().restore();
      this.estilo('Helvetica', this.tam.chico, COLOR.gris);
      this.texto(etiquetas[i], xx, this.y + 3, anchoFirma, 'center');
    });
    this.y += this.alto(this.tam.chico) + 8;
  }

  private pie(): void {
    const generado = fechaHoraLimaLegible(this.d.generado_en ?? new Date());
    const texto = `Generado el ${generado} (hora de Lima) · HatunSales`;
    this.estilo('Helvetica', this.tam.chico, COLOR.grisClaro);
    if (this.ticket) {
      this.texto(texto, this.x, this.y, this.ancho, 'center');
      this.y += this.alto(this.tam.chico);
      return;
    }
    // A4: pie fijo al fondo de cada página, con número de página.
    const rango = this.doc.bufferedPageRange();
    for (let i = rango.start; i < rango.start + rango.count; i++) {
      this.doc.switchToPage(i);
      const yPie = this.doc.page.height - this.margen - 10;
      this.estilo('Helvetica', 7.5, COLOR.grisClaro);
      this.texto(texto, this.x, yPie, this.ancho * 0.75);
      this.texto(`Página ${i - rango.start + 1} de ${rango.count}`, this.x + this.ancho * 0.75, yPie, this.ancho * 0.25, 'right');
    }
  }
}
