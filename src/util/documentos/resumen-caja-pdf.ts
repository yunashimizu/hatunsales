import { Dinero } from '../../caja/dominio/dinero';
import { fechaHoraLimaLegible } from '../fecha-lima';
import { PALETA, dibujarFranjaMarca } from './proforma-documento';
import { textoPdf } from './proforma-pdf';

// pdfkit no trae tipos en este proyecto (mismo uso que en proformas, arqueos y reportes).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require('pdfkit');

/**
 * Resumen de caja por sucursal (A4 vertical): encabezado con el emisor y el rango de fechas, una
 * tarjeta por sucursal (efectivo inicial, ventas, esperado, contado y diferencia, más las ventas
 * por medio de pago) y una banda de TOTAL. No calcula nada: recibe lo que devuelve
 * GET /caja/resumen-sucursales. Donde no hay dato (monto null) escribe «sin dato», nunca 0.
 *
 * Todo el texto de una línea se escribe con `lineBreak: false` y se recorta con «…» si no cabe;
 * los saltos de página los decide este archivo y una tarjeta nunca se parte entre dos hojas.
 */

const MARGEN = 42;
const SIN_DATO = 'sin dato';

type Fuente = 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique';
type Alineacion = 'left' | 'right' | 'center';

const COLOR = {
  texto: PALETA.texto,
  gris: PALETA.gris,
  grisClaro: PALETA.grisClaro,
  linea: PALETA.linea,
  fondo: PALETA.fondo,
  marca: PALETA.grafito,
  acento: PALETA.dorado,
  acentoTexto: PALETA.doradoOscuro,
  acentoClaro: PALETA.doradoClaro,
  plata: PALETA.plata,
  peligro: PALETA.peligro,
  aviso: PALETA.aviso,
  blanco: PALETA.blanco,
};

export interface MetodoResumenCajaPdf {
  metodo: string;
  /** null = sin dato (no es 0). */
  monto: number | null;
}

export interface FilaResumenCajaPdf {
  id_sucursal?: number | null;
  nombre: string;
  turnos: number;
  turnos_abiertos: number;
  /** En todos los montos, null = «sin dato». */
  efectivo_inicial: number | null;
  ventas_total: number | null;
  por_metodo: MetodoResumenCajaPdf[];
  efectivo_esperado: number | null;
  efectivo_contado: number | null;
  /** contado - esperado; negativo = falta, positivo = sobra. */
  diferencia: number | null;
}

export interface EmisorResumenCajaPdf {
  razon_social: string;
  ruc: string;
  direccion?: string | null;
  /** PNG/JPEG ya descargado; sin logo el PDF sale igual. */
  logo?: Buffer | null;
}

export interface DatosResumenCajaPdf {
  /** AAAA-MM-DD (día de Lima). */
  desde: string;
  hasta: string;
  sucursales: FilaResumenCajaPdf[];
  /** null o ausente con 0 sucursales: no se dibuja la banda de TOTAL. */
  total?: FilaResumenCajaPdf | null;
  emisor: EmisorResumenCajaPdf;
  /** Nombre de la sucursal si el resumen se pidió para una sola; vacío = todas. */
  sucursal_filtrada?: string | null;
  generado_en?: Date;
}

export interface OpcionesResumenCajaPdf {
  /** false deja el contenido sin comprimir (solo para pruebas que leen el texto). */
  comprimir?: boolean;
}

function soles(valor: number | null | undefined): string {
  if (valor === null || valor === undefined || !Number.isFinite(valor)) return SIN_DATO;
  return Dinero.desdeNumeroRedondeado(valor).formatear();
}

function ymdLegible(ymd: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(ymd || '—');
}

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

export function nombreArchivoResumenCaja(desde: string, hasta: string): string {
  const seguro = (v: string) => String(v ?? '').replace(/[^0-9A-Za-z-]/g, '') || 'sin-fecha';
  return `resumen-caja-${seguro(desde)}_${seguro(hasta)}.pdf`;
}

/** «Falta S/ 5.00», «Sobra S/ 2.00», «Cuadra» o «sin dato». */
function textoDiferencia(valor: number | null | undefined): { texto: string; color: string } {
  if (valor === null || valor === undefined || !Number.isFinite(valor)) return { texto: SIN_DATO, color: COLOR.grisClaro };
  const d = Dinero.desdeNumeroRedondeado(valor);
  if (d.centimos === 0) return { texto: 'Cuadra', color: COLOR.marca };
  const monto = d.abs().formatear();
  return d.centimos < 0 ? { texto: `Falta ${monto}`, color: COLOR.peligro } : { texto: `Sobra ${monto}`, color: COLOR.aviso };
}

export async function generarResumenCajaPdf(datos: DatosResumenCajaPdf, opciones: OpcionesResumenCajaPdf = {}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: MARGEN, bottom: MARGEN, left: MARGEN, right: MARGEN },
        bufferPages: true,
        compress: opciones.comprimir !== false,
        info: {
          Title: `Resumen de caja ${datos.desde} al ${datos.hasta}`,
          Author: textoPdf(datos.emisor?.razon_social),
          Subject: 'Resumen de caja por sucursal',
          Creator: 'HatunSales',
        },
      });
      const partes: Buffer[] = [];
      doc.on('data', (parte: Buffer) => partes.push(parte));
      doc.on('end', () => resolve(Buffer.concat(partes)));
      doc.on('error', (error: unknown) => reject(error));
      new DibujoResumenCaja(doc, datos).dibujar();
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

const ALTO_CABECERA_TARJETA = 26;
const ALTO_ENCABEZADO_TABLA = 16;
const ALTO_VALORES = 24;
const ALTO_FILA_MEDIO = 14;
const ALTO_TITULO_MEDIOS = 18;
const RELLENO = 10;

class DibujoResumenCaja {
  private y: number;
  private readonly x = MARGEN;
  private readonly ancho: number;
  private readonly generado: string;

  constructor(
    private readonly doc: any,
    private readonly d: DatosResumenCajaPdf,
  ) {
    this.y = MARGEN;
    this.ancho = doc.page.width - MARGEN * 2;
    this.generado = fechaHoraLimaLegible(d.generado_en ?? new Date());
  }

  dibujar(): void {
    dibujarFranjaMarca(this.doc);
    this.cabecera();
    this.nota();
    if (!this.d.sucursales.length) {
      this.vacio();
    } else {
      for (const fila of this.d.sucursales) this.tarjeta(fila);
      if (this.d.total) this.tarjetaTotal(this.d.total);
    }
    this.pie();
  }

  // ── Primitivas ──────────────────────────────────────────────────

  private estilo(fuente: Fuente, tam: number, color: string = COLOR.texto): void {
    this.doc.font(fuente).fontSize(tam).fillColor(color);
  }

  /** Salta de página si `alto` no entra: una tarjeta nunca se parte. */
  private asegurar(alto: number): void {
    const limite = this.doc.page.height - MARGEN - 24;
    if (this.y + alto <= limite) return;
    this.doc.addPage();
    dibujarFranjaMarca(this.doc);
    this.y = MARGEN;
    this.cabeceraContinuacion();
  }

  /** Escribe UNA línea (sin salto automático), recortada con «…» y alineada dentro de `ancho`. */
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

  // ── Encabezado ──────────────────────────────────────────────────

  private cabecera(): void {
    const e = this.d.emisor;
    const alto = 64;
    const xTexto = e.logo ? this.x + 76 : this.x;
    if (e.logo) {
      try {
        this.doc.image(e.logo, this.x, this.y, { fit: [66, 56], valign: 'center' });
      } catch {
        // Logo ilegible: el documento sale sin logo.
      }
    }
    this.estilo('Helvetica-Bold', 13, COLOR.marca);
    this.texto(e.razon_social || 'HATUNSALES S.A.C.', xTexto, this.y + 6, 250);
    this.estilo('Helvetica', 9, COLOR.gris);
    this.texto(`RUC ${e.ruc}`, xTexto, this.y + 22, 250);
    if (e.direccion) this.texto(e.direccion, xTexto, this.y + 34, 250);
    this.estilo('Helvetica', 8, COLOR.grisClaro);
    this.texto(`Generado el ${this.generado} (hora de Lima)`, xTexto, this.y + 47, 250);

    const anchoCaja = 190;
    const xCaja = this.x + this.ancho - anchoCaja;
    // Banda grafito con línea dorada (recortada a las esquinas redondeadas) con el nombre del documento en blanco.
    this.doc.save().roundedRect(xCaja, this.y, anchoCaja, alto, 6).clip();
    this.doc.rect(xCaja, this.y, anchoCaja, 29).fill(COLOR.marca);
    this.doc.rect(xCaja, this.y + 29, anchoCaja, 1.8).fill(COLOR.acento);
    this.doc.restore();
    this.doc.save().roundedRect(xCaja, this.y, anchoCaja, alto, 6).lineWidth(1.3).strokeColor(COLOR.marca).stroke().restore();
    this.estilo('Helvetica-Bold', 12.5, COLOR.blanco);
    this.texto('RESUMEN DE CAJA', xCaja, this.y + 8, anchoCaja, 'center');
    this.estilo('Helvetica-Bold', 9.5, COLOR.acentoTexto);
    this.texto(`${ymdLegible(this.d.desde)} al ${ymdLegible(this.d.hasta)}`, xCaja + 6, this.y + 37, anchoCaja - 12, 'center');
    this.estilo('Helvetica', 8.5, COLOR.texto);
    const alcance = this.d.sucursal_filtrada ? `Sucursal: ${this.d.sucursal_filtrada}` : 'Todas las sucursales';
    this.texto(alcance, xCaja + 6, this.y + 50, anchoCaja - 12, 'center');
    this.y += alto + 12;
  }

  private cabeceraContinuacion(): void {
    this.estilo('Helvetica-Bold', 7.5, COLOR.marca);
    this.texto(`${this.d.emisor.razon_social || 'HATUNSALES S.A.C.'} · Resumen de caja`, this.x, this.y, this.ancho * 0.55);
    this.estilo('Helvetica', 7.5, COLOR.gris);
    this.texto(
      `${ymdLegible(this.d.desde)} al ${ymdLegible(this.d.hasta)}`,
      this.x + this.ancho * 0.55,
      this.y,
      this.ancho * 0.45,
      'right',
    );
    this.doc.save().lineWidth(0.5).strokeColor(COLOR.linea).moveTo(this.x, this.y + 12).lineTo(this.x + this.ancho, this.y + 12).stroke().restore();
    this.doc.save().rect(this.x, this.y + 11.2, 40, 1.6).fill(COLOR.acento).restore();
    this.y += 24;
  }

  private nota(): void {
    this.estilo('Helvetica-Oblique', 7.5, COLOR.grisClaro);
    this.texto(
      'Diferencia = contado menos esperado, solo de turnos cerrados. «sin dato»: sin turnos cerrados o sin registro.',
      this.x,
      this.y,
      this.ancho,
    );
    this.y += 16;
  }

  private vacio(): void {
    this.asegurar(60);
    this.doc.save().roundedRect(this.x, this.y, this.ancho, 54, 5).lineWidth(0.8).strokeColor(COLOR.linea).stroke().restore();
    this.estilo('Helvetica-Bold', 10, COLOR.marca);
    this.texto('Sin turnos de caja en el periodo seleccionado.', this.x, this.y + 14, this.ancho, 'center');
    this.estilo('Helvetica', 8.5, COLOR.gris);
    this.texto('No hay efectivo ni ventas por mostrar para estas fechas.', this.x, this.y + 31, this.ancho, 'center');
    this.y += 64;
  }

  // ── Tarjetas ────────────────────────────────────────────────────

  private altoMedios(fila: FilaResumenCajaPdf): number {
    const filas = fila.por_metodo.length ? Math.ceil(fila.por_metodo.length / 2) : 1;
    return ALTO_TITULO_MEDIOS + filas * ALTO_FILA_MEDIO;
  }

  private static readonly TITULOS_COLUMNAS = ['EFECTIVO INICIAL', 'VENTAS', 'EFECTIVO ESPERADO', 'EFECTIVO CONTADO', 'DIFERENCIA'];

  private valoresColumnas(fila: FilaResumenCajaPdf): { texto: string; color: string }[] {
    const base = (v: number | null | undefined) => ({ texto: soles(v), color: v == null ? COLOR.grisClaro : COLOR.texto });
    return [
      base(fila.efectivo_inicial),
      base(fila.ventas_total),
      base(fila.efectivo_esperado),
      base(fila.efectivo_contado),
      textoDiferencia(fila.diferencia),
    ];
  }

  private subtitulo(fila: FilaResumenCajaPdf): string {
    const abiertos = fila.turnos_abiertos > 0 ? ` · ${plural(fila.turnos_abiertos, 'abierto', 'abiertos')}` : '';
    return `${plural(fila.turnos, 'turno', 'turnos')}${abiertos}`;
  }

  private tarjeta(fila: FilaResumenCajaPdf): void {
    const alto = ALTO_CABECERA_TARJETA + RELLENO + ALTO_ENCABEZADO_TABLA + ALTO_VALORES + 6 + this.altoMedios(fila) + RELLENO - 2;
    this.asegurar(alto + 10);
    const { x, ancho } = this;
    const y0 = this.y;

    // Marco y franja de título.
    this.doc.save().roundedRect(x, y0, ancho, alto, 5).lineWidth(0.8).strokeColor(COLOR.linea).stroke().restore();
    this.doc.save().roundedRect(x, y0, ancho, alto, 5).clip();
    this.doc.rect(x, y0, ancho, ALTO_CABECERA_TARJETA).fill(COLOR.fondo);
    this.doc.restore();
    this.doc.save().rect(x + RELLENO, y0 + 7, 3, 12).fill(COLOR.acento).restore();
    this.estilo('Helvetica-Bold', 11, COLOR.marca);
    this.texto(fila.nombre, x + RELLENO + 9, y0 + 7, ancho * 0.6 - RELLENO - 9);
    this.estilo('Helvetica', 8.5, COLOR.gris);
    this.texto(this.subtitulo(fila), x + ancho * 0.6, y0 + 9, ancho * 0.4 - RELLENO, 'right');

    // Tabla de cifras.
    const xt = x + RELLENO;
    const wt = ancho - RELLENO * 2;
    const yTabla = y0 + ALTO_CABECERA_TARJETA + RELLENO;
    this.filaCifras(xt, yTabla, wt, fila, false);

    // Ventas por medio de pago.
    let yy = yTabla + ALTO_ENCABEZADO_TABLA + ALTO_VALORES + 6;
    this.estilo('Helvetica-Bold', 7.5, COLOR.gris);
    this.texto('VENTAS POR MEDIO DE PAGO', xt, yy, wt);
    yy += ALTO_TITULO_MEDIOS - 2;
    this.medios(fila, xt, yy, wt);
    this.y = y0 + alto + 10;
  }

  /** Encabezado de columnas y fila de valores; en la banda TOTAL (`oscura`) va sobre grafito. */
  private filaCifras(x: number, y: number, ancho: number, fila: FilaResumenCajaPdf, oscura: boolean): void {
    const wc = ancho / 5;
    if (!oscura) {
      this.doc
        .save()
        .rect(x, y, ancho, ALTO_ENCABEZADO_TABLA)
        .fill(COLOR.marca)
        .rect(x, y + ALTO_ENCABEZADO_TABLA - 1.2, ancho, 1.2)
        .fill(COLOR.acento)
        .restore();
    }
    const pad = 6;
    DibujoResumenCaja.TITULOS_COLUMNAS.forEach((titulo, i) => {
      this.estilo('Helvetica-Bold', 6.6, oscura ? COLOR.plata : COLOR.blanco);
      this.texto(titulo, x + i * wc + pad, y + 5.2, wc - pad * 2, 'right');
    });
    const valores = this.valoresColumnas(fila);
    valores.forEach((v, i) => {
      const color = oscura ? COLOR.acentoClaro : v.color;
      this.estilo(i === 4 || i === 1 ? 'Helvetica-Bold' : 'Helvetica', 9.5, color);
      this.texto(v.texto, x + i * wc + pad, y + ALTO_ENCABEZADO_TABLA + 8, wc - pad * 2, 'right');
    });
    if (!oscura) {
      this.doc
        .save()
        .lineWidth(0.5)
        .strokeColor(COLOR.linea)
        .moveTo(x, y + ALTO_ENCABEZADO_TABLA + ALTO_VALORES)
        .lineTo(x + ancho, y + ALTO_ENCABEZADO_TABLA + ALTO_VALORES)
        .stroke()
        .restore();
    }
  }

  /** Medios de pago en dos columnas: nombre a la izquierda, monto a la derecha. */
  private medios(fila: FilaResumenCajaPdf, x: number, y: number, ancho: number): void {
    if (!fila.por_metodo.length) {
      this.estilo('Helvetica-Oblique', 8.5, COLOR.grisClaro);
      this.texto('Sin ventas registradas.', x, y, ancho);
      return;
    }
    const hueco = 24;
    const wc = (ancho - hueco) / 2;
    const porColumna = Math.ceil(fila.por_metodo.length / 2);
    fila.por_metodo.forEach((m, i) => {
      const col = i < porColumna ? 0 : 1;
      const yy = y + (col === 0 ? i : i - porColumna) * ALTO_FILA_MEDIO;
      const xx = x + col * (wc + hueco);
      this.estilo('Helvetica', 8.5, COLOR.texto);
      this.texto(m.metodo, xx, yy, wc * 0.55);
      const sin = m.monto === null || m.monto === undefined;
      this.estilo('Helvetica', 8.5, sin ? COLOR.grisClaro : COLOR.texto);
      this.texto(soles(m.monto), xx + wc * 0.5, yy, wc * 0.5, 'right');
    });
  }

  private tarjetaTotal(total: FilaResumenCajaPdf): void {
    const alto = ALTO_CABECERA_TARJETA + ALTO_ENCABEZADO_TABLA + ALTO_VALORES + 6 + this.altoMedios(total) + RELLENO - 2;
    this.asegurar(alto + 10);
    const { x, ancho } = this;
    const y0 = this.y;
    const altoBanda = ALTO_CABECERA_TARJETA + ALTO_ENCABEZADO_TABLA + ALTO_VALORES - 6;

    this.doc.save().roundedRect(x, y0, ancho, alto, 5).lineWidth(1.3).strokeColor(COLOR.marca).stroke().restore();
    this.doc.save().roundedRect(x, y0, ancho, alto, 5).clip();
    this.doc.rect(x, y0, ancho, altoBanda).fill(COLOR.marca);
    this.doc.rect(x, y0 + altoBanda, ancho, 1.8).fill(COLOR.acento);
    this.doc.restore();

    this.estilo('Helvetica-Bold', 11, COLOR.blanco);
    this.texto('TOTAL', x + RELLENO, y0 + 8, ancho * 0.4);
    this.estilo('Helvetica', 8.5, COLOR.plata);
    const sucursales = this.d.sucursales.length;
    this.texto(
      `${plural(sucursales, 'sucursal', 'sucursales')} · ${plural(total.turnos, 'turno', 'turnos')}`,
      x + ancho * 0.4,
      y0 + 10,
      ancho * 0.6 - RELLENO,
      'right',
    );
    this.filaCifras(x + RELLENO, y0 + ALTO_CABECERA_TARJETA - 4, ancho - RELLENO * 2, total, true);

    const yMedios = y0 + altoBanda + 12;
    this.estilo('Helvetica-Bold', 7.5, COLOR.gris);
    this.texto('VENTAS POR MEDIO DE PAGO', x + RELLENO, yMedios, ancho - RELLENO * 2);
    this.medios(total, x + RELLENO, yMedios + ALTO_TITULO_MEDIOS - 2, ancho - RELLENO * 2);
    this.y = y0 + alto + 10;
  }

  // ── Pie ─────────────────────────────────────────────────────────

  private pie(): void {
    const texto = `Generado el ${this.generado} (hora de Lima) · HatunSales`;
    const rango = this.doc.bufferedPageRange();
    for (let i = rango.start; i < rango.start + rango.count; i++) {
      this.doc.switchToPage(i);
      const yPie = this.doc.page.height - MARGEN - 10;
      this.estilo('Helvetica', 7.5, COLOR.grisClaro);
      this.texto(texto, this.x, yPie, this.ancho * 0.75);
      this.texto(`Página ${i - rango.start + 1} de ${rango.count}`, this.x + this.ancho * 0.75, yPie, this.ancho * 0.25, 'right');
    }
  }
}
