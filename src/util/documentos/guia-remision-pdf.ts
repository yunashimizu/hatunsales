import { textoPdf } from './proforma-pdf';

// pdfkit no trae tipos en este proyecto.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require('pdfkit');

export interface DatosGuiaRemisionPdf {
  emisor: {
    ruc: string;
    razon_social: string;
    direccion?: string | null;
    ubicacion?: string | null;
    logo?: Buffer | null;
  };
  codigo: string;
  estado: string;
  fecha_emision?: string | null;
  fecha_inicio_traslado?: string | null;
  motivo_traslado?: string | null;
  modalidad_traslado?: string | null;
  peso_bruto_total?: number | null;
  unidad_peso?: string | null;
  numero_bultos?: number | null;
  direccion_origen: string;
  direccion_destino: string;
  origen_ubigeo?: string | null;
  destino_ubigeo?: string | null;
  destinatario: {
    tipo_documento: string;
    numero_documento: string;
    denominacion: string;
    direccion: string;
  };
  transporte: {
    placa_principal: string;
    conductor_nombre: string;
    conductor_tipo_doc: string;
    conductor_numero_doc: string;
    conductor_licencia: string;
  };
  comprobante?: { serie: string; numero: number };
  items: Array<{
    codigo: string;
    descripcion: string;
    cantidad: number;
    unidad_medida: string;
  }>;
}

const MARGEN = 36;
const COLOR = {
  texto: '#202124',
  gris: '#5f6368',
  borde: '#8b8b8b',
  suave: '#f7f3f5',
  blanco: '#ffffff',
  peligro: '#9d1c1c',
};

function fecha(valor?: string | null): string {
  const texto = String(valor ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
    const [anio, mes, dia] = texto.split('-');
    return `${dia}/${mes}/${anio}`;
  }
  return texto;
}

function numero(valor: unknown, decimales = 0): string {
  const n = Number(valor);
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(decimales).replace(/\.00$/, '');
}

function texto(valor: unknown): string {
  return textoPdf(valor) || '—';
}

export function generarGuiaRemisionPdf(datos: DatosGuiaRemisionPdf): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const documento = new PDFDocument({
        size: 'A4',
        margins: { top: MARGEN, bottom: MARGEN, left: MARGEN, right: MARGEN },
        bufferPages: true,
        info: {
          Title: `Guía de remisión ${texto(datos.codigo)}`,
          Author: texto(datos.emisor.razon_social),
          Subject: 'Borrador de guía de remisión remitente',
          Creator: 'HatunSales',
        },
      });
      const partes: Buffer[] = [];
      documento.on('data', (parte: Buffer) => partes.push(parte));
      documento.on('end', () => resolve(Buffer.concat(partes)));
      documento.on('error', (error: unknown) => reject(error));
      new DibujoGuia(documento, datos).dibujar();
      documento.end();
    } catch (error) {
      reject(error);
    }
  });
}

class DibujoGuia {
  private y = MARGEN;
  private readonly ancho: number;

  constructor(private readonly documento: any, private readonly datos: DatosGuiaRemisionPdf) {
    this.ancho = documento.page.width - MARGEN * 2;
  }

  dibujar(): void {
    this.cabecera();
    this.bloque('DESTINATARIO', [
      ['RAZÓN SOCIAL', this.datos.destinatario.denominacion],
      [this.datos.destinatario.tipo_documento === '6' ? 'RUC' : 'DNI', this.datos.destinatario.numero_documento],
      ['DIRECCIÓN', this.datos.destinatario.direccion],
    ]);
    this.bloque('ENVÍO', [
      ['F. EMISIÓN', fecha(this.datos.fecha_emision)],
      ['F. INICIO TRASLADO', fecha(this.datos.fecha_inicio_traslado)],
      ['MOTIVO TRASLADO', this.datos.motivo_traslado || 'Venta'],
      ['MOD. TRANSPORTE', this.datos.modalidad_traslado === '02' ? 'Transporte público' : 'Transporte privado'],
      ['PESO BRUTO TOTAL', `${numero(this.datos.peso_bruto_total, 3)} ${texto(this.datos.unidad_peso || 'KGM')}`],
      ['N° BULTOS', numero(this.datos.numero_bultos)],
      ['P. PARTIDA', this.datos.direccion_origen],
      ['P. LLEGADA', this.datos.direccion_destino],
    ]);
    this.bloque('TRANSPORTE', [
      ['PLACA PRINCIPAL', this.datos.transporte.placa_principal],
      ['CONDUCTOR', this.datos.transporte.conductor_nombre],
      ['DOCUMENTO', this.datos.transporte.conductor_numero_doc],
      ['LICENCIA', this.datos.transporte.conductor_licencia],
    ]);
    this.tablaItems();
    if (this.datos.comprobante) {
      this.bloque('FACTURA ELECTRÓNICA', [
        ['COMPROBANTE', `${this.datos.comprobante.serie}-${this.datos.comprobante.numero}`],
      ]);
    }
    this.pie();
  }

  private cabecera(): void {
    const alto = 92;
    const x = MARGEN;
    if (this.datos.emisor.logo) {
      try {
        this.documento.image(this.datos.emisor.logo, x, this.y, { fit: [86, 70], align: 'center', valign: 'center' });
      } catch {
        // El documento sigue siendo válido aunque el logo no pueda dibujarse.
      }
    }
    this.documento.font('Helvetica-Bold').fontSize(13).fillColor(COLOR.texto)
      .text(texto(this.datos.emisor.razon_social), x + 100, this.y + 5, { lineBreak: false });
    this.documento.font('Helvetica').fontSize(8).fillColor(COLOR.gris)
      .text(`RUC ${texto(this.datos.emisor.ruc)}`, x + 100, this.y + 25, { lineBreak: false })
      .text(texto(this.datos.emisor.direccion), x + 100, this.y + 39, { width: 210, lineBreak: false })
      .text(texto(this.datos.emisor.ubicacion), x + 100, this.y + 52, { width: 210, lineBreak: false });

    this.documento.roundedRect(x + this.ancho - 170, this.y, 170, alto - 8, 4)
      .lineWidth(0.8).strokeColor(COLOR.borde).stroke();
    this.documento.font('Helvetica-Bold').fontSize(11).fillColor(COLOR.texto)
      .text(`RUC ${texto(this.datos.emisor.ruc)}`, x + this.ancho - 160, this.y + 14, { width: 150, align: 'center' })
      .fontSize(10).text('GUÍA DE REMISIÓN', x + this.ancho - 160, this.y + 32, { width: 150, align: 'center' })
      .fontSize(13).text('REMITENTE', x + this.ancho - 160, this.y + 47, { width: 150, align: 'center' })
      .fontSize(14).text(texto(this.datos.codigo), x + this.ancho - 160, this.y + 65, { width: 150, align: 'center' });
    this.y += alto + 8;
  }

  private bloque(titulo: string, filas: Array<[string, string]>): void {
    const anchoValor = this.ancho - 125;
    const alturas = filas.map(([, valor]) => {
      this.documento.font('Helvetica').fontSize(8);
      return Math.max(15, this.documento.heightOfString(texto(valor), { width: anchoValor }) + 3);
    });
    const alto = 25 + alturas.reduce((total: number, altura: number) => total + altura, 0) + 10;
    this.documento.roundedRect(MARGEN, this.y, this.ancho, alto, 4)
      .lineWidth(0.6).strokeColor(COLOR.borde).stroke();
    this.documento.rect(MARGEN, this.y, this.ancho, 20).fillColor(COLOR.suave).fill();
    this.documento.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.texto)
      .text(titulo, MARGEN + 7, this.y + 6, { lineBreak: false });
    let filaY = this.y + 27;
    for (const [[etiqueta, valor], altura] of filas.map((fila, indice) => [fila, alturas[indice]] as const)) {
      this.documento.font('Helvetica-Bold').fontSize(7).fillColor(COLOR.gris)
        .text(texto(etiqueta), MARGEN + 8, filaY, { width: 105, lineBreak: false });
      this.documento.font('Helvetica').fontSize(8).fillColor(COLOR.texto)
        .text(texto(valor), MARGEN + 115, filaY, { width: anchoValor, lineGap: 1 });
      filaY += altura;
    }
    this.y += alto + 8;
  }

  private tablaItems(): void {
    const encabezado = 22;
    const columnas = [30, 62, this.ancho - 30 - 62 - 58 - 58, 58, 58];
    const x = MARGEN;
    this.documento.font('Helvetica-Bold').fontSize(7);
    this.documento.rect(x, this.y, this.ancho, encabezado).fillColor(COLOR.suave).fill()
      .lineWidth(0.6).strokeColor(COLOR.borde).stroke();
    let cursor = x;
    for (const [indice, titulo] of ['ITEM', 'CÓDIGO', 'DESCRIPCIÓN', 'UNIDAD', 'CANTIDAD'].entries()) {
      this.documento.fillColor(COLOR.texto).text(titulo, cursor + 4, this.y + 7, { width: columnas[indice] - 8, align: indice > 2 ? 'center' : 'left', lineBreak: false });
      cursor += columnas[indice];
    }
    this.y += encabezado;
    for (const [indice, item] of this.datos.items.entries()) {
      const alto = 18;
      this.documento.rect(x, this.y, this.ancho, alto).fillColor(indice % 2 ? '#fbfbfb' : COLOR.blanco).fill()
        .lineWidth(0.3).strokeColor(COLOR.borde).stroke();
      const valores = [String(indice + 1), item.codigo, this.unaLinea(item.descripcion, columnas[2] - 8), item.unidad_medida, numero(item.cantidad)];
      cursor = x;
      for (const [columna, valor] of valores.entries()) {
        this.documento.font('Helvetica').fontSize(7).fillColor(COLOR.texto)
          .text(texto(valor), cursor + 4, this.y + 6, { width: columnas[columna] - 8, align: columna > 2 ? 'center' : 'left', lineBreak: false });
        cursor += columnas[columna];
      }
      this.y += alto;
    }
    this.y += 8;
  }

  private unaLinea(valor: unknown, ancho: number): string {
    const completo = texto(valor);
    if (this.documento.widthOfString(completo) <= ancho) return completo;
    let resultado = '';
    for (const caracter of completo) {
      if (this.documento.widthOfString(`${resultado}${caracter}...`) > ancho) break;
      resultado += caracter;
    }
    return `${resultado.trimEnd()}...`;
  }

  private pie(): void {
    const estado = this.datos.estado === 'aceptado' ? 'ACEPTADA' : 'BORRADOR - SIN VALOR TRIBUTARIO';
    this.documento.font('Helvetica-Bold').fontSize(8).fillColor(this.datos.estado === 'aceptado' ? COLOR.texto : COLOR.peligro)
      .text(estado, MARGEN, this.documento.page.height - 92, { width: this.ancho, align: 'center' });
    this.documento.font('Helvetica').fontSize(7).fillColor(COLOR.gris)
      .text('Representación impresa de la guía de remisión remitente', MARGEN, this.documento.page.height - 75, { width: this.ancho, align: 'center' })
      .text('La emisión SUNAT aún no está habilitada en este borrador.', MARGEN, this.documento.page.height - 62, { width: this.ancho, align: 'center' });
  }
}