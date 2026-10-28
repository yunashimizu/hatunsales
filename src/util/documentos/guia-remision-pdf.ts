import { imagenSoportada } from './logo-emisor';
import { PALETA, dibujarFranjaMarca } from './proforma-documento';
import { textoPdf } from './proforma-pdf';
import { generarQrPng } from './qr';

// pdfkit no trae tipos en este proyecto (mismo uso que en proformas, arqueos y comprobantes).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require('pdfkit');

/**
 * Representación impresa (A4) de la Guía de Remisión Electrónica Remitente. Generador puro: no lee la base
 * de datos ni la red; el negocio arma `DatosGuiaRemisionPdf` (con el emisor de la configuración fiscal o el
 * con que se firmó la guía). El QR (enlace de la constancia de SUNAT) solo se imprime con la guía aceptada;
 * en cualquier otro estado la hoja lleva la marca de su estado, en el encabezado y de fondo.
 */

export interface DatosGuiaRemisionPdf {
  emisor: {
    ruc: string;
    razonSocial: string;
    nombreComercial?: string | null;
    direccion?: string | null;
    ubicacion?: string | null;
    logo?: Buffer | null;
  };
  /** Estado de la guía: legacy, borrador, pendiente, enviado, aceptado, rechazado o anulado. */
  estado: string;
  /** «T001-00000001»; null mientras es borrador. */
  numero: string | null;
  idGuia: number;
  fechaEmision: string | null;
  horaEmision: string | null;
  fechaInicioTraslado: string | null;
  fechaEntregaTransportista: string | null;
  motivo: { codigo: string; nombre: string } | null;
  descripcionMotivo: string | null;
  modalidad: { codigo: string; nombre: string } | null;
  pesoBrutoTotal: number | null;
  unidadPeso: string | null;
  numeroBultos: number | null;
  destinatario: { tipoDoc: string | null; tipoDocTexto: string | null; numDoc: string | null; nombre: string | null };
  partida: PuntoPdfGuia;
  llegada: PuntoPdfGuia;
  transportista: { ruc: string | null; razonSocial: string | null; registroMtc: string | null } | null;
  vehiculo: { placa: string | null; tarjetaCirculacion: string | null; marca: string | null } | null;
  conductor: { tipoDocTexto: string | null; numDoc: string | null; nombre: string | null; licencia: string | null } | null;
  documentoRelacionado: { tipo: string; numero: string } | null;
  items: Array<{ codigo: string | null; descripcion: string; unidad: string; cantidad: number }>;
  observaciones: string | null;
  /** Enlace del QR que devuelve SUNAT en la constancia. Solo se usa con la guía aceptada. */
  cadenaQr: string | null;
}

export interface PuntoPdfGuia {
  direccion: string | null;
  /** «150119 - LURIN - LIMA - LIMA». */
  ubigeo: string | null;
  codigoEstablecimiento: string | null;
}

export interface OpcionesPdfGuia {
  /** false solo en pruebas (para leer el texto del PDF). */
  comprimir?: boolean;
}

export const LEYENDA_GRE_REMITENTE = 'Representación impresa de la Guía de Remisión Electrónica Remitente';

const MARCAS_ESTADO: Readonly<Record<string, string>> = {
  borrador: 'BORRADOR - SIN VALIDEZ',
  pendiente: 'PENDIENTE DE SUNAT',
  enviado: 'PENDIENTE DE SUNAT',
  rechazado: 'RECHAZADA',
  anulado: 'ANULADA',
  legacy: 'SIN VALIDEZ ELECTRÓNICA',
};

/** Marca que lleva la hoja según el estado; null solo con la guía aceptada por SUNAT. */
export function marcaEstadoGuia(estado: string): string | null {
  return estado === 'aceptado' ? null : (MARCAS_ESTADO[estado] ?? 'SIN VALIDEZ');
}

const MARGEN = 36;
const LADO_QR = 92;
const ALTO_PIE = 18;
const COLOR = {
  texto: PALETA.texto,
  gris: PALETA.gris,
  linea: PALETA.linea,
  fondo: PALETA.fondo,
  cebra: PALETA.cebra,
  marca: PALETA.grafito,
  acento: PALETA.dorado,
  peligro: PALETA.peligro,
  blanco: PALETA.blanco,
};

type Fila = [string, string | null | undefined];

function fecha(valor: string | null | undefined): string {
  const t = String(valor ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : t;
}

/** Hasta 3 decimales, sin ceros de más y con separador de miles: 1250.5 → «1,250.5». */
function cantidad(valor: number | null | undefined): string {
  const n = Number(valor);
  if (valor === null || valor === undefined || !Number.isFinite(n)) return '';
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

function t(valor: unknown): string {
  return textoPdf(valor);
}

export async function generarGuiaRemisionPdf(datos: DatosGuiaRemisionPdf, opciones: OpcionesPdfGuia = {}): Promise<Buffer> {
  const cadena = datos.estado === 'aceptado' ? String(datos.cadenaQr ?? '').trim() : '';
  const qr = cadena ? await generarQrPng(cadena, { tamanoPx: 360, correccion: 'M' }) : null;
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const documento = new PDFDocument({
        size: 'A4',
        margins: { top: MARGEN, bottom: MARGEN, left: MARGEN, right: MARGEN },
        bufferPages: true,
        compress: opciones.comprimir !== false,
        info: {
          Title: `Guía de remisión remitente ${t(datos.numero ?? `borrador ${datos.idGuia}`)}`,
          Author: t(datos.emisor.razonSocial),
          Subject: LEYENDA_GRE_REMITENTE,
          Creator: 'HatunSales',
        },
      });
      const partes: Buffer[] = [];
      documento.on('data', (parte: Buffer) => partes.push(parte));
      documento.on('end', () => resolve(Buffer.concat(partes)));
      documento.on('error', (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
      new DibujoGuia(documento, datos, qr).dibujar();
      documento.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(`No se pudo generar la representación impresa: ${String(error)}`));
    }
  });
}

class DibujoGuia {
  private y = MARGEN;
  private readonly ancho: number;
  private readonly marca: string | null;

  constructor(
    private readonly doc: any,
    private readonly d: DatosGuiaRemisionPdf,
    private readonly qr: Buffer | null,
  ) {
    this.ancho = doc.page.width - MARGEN * 2;
    this.marca = marcaEstadoGuia(d.estado);
  }

  dibujar(): void {
    dibujarFranjaMarca(this.doc);
    this.cabecera();
    if (this.marca) this.banner(this.marca);
    this.bloque('DATOS DEL TRASLADO', this.filasTraslado());
    this.bloque('DESTINATARIO', [
      ['Nombre o razón social', this.d.destinatario.nombre],
      ['Documento', [this.d.destinatario.tipoDocTexto, this.d.destinatario.numDoc].filter(Boolean).join(' ')],
    ]);
    this.bloque('PUNTO DE PARTIDA', this.filasPunto(this.d.partida));
    this.bloque('PUNTO DE LLEGADA', this.filasPunto(this.d.llegada));
    const transporte = this.filasTransporte();
    if (transporte.length) this.bloque('TRANSPORTE', transporte);
    this.tablaItems();
    if (this.d.observaciones) this.bloque('OBSERVACIONES', [['Observaciones', this.d.observaciones]]);
    this.cierre();
    this.paginas();
  }

  private filasTraslado(): Fila[] {
    const d = this.d;
    const filas: Fila[] = [
      ['Fecha de emisión', [fecha(d.fechaEmision), d.horaEmision].filter(Boolean).join(' ') || 'Se asigna al emitir'],
      ['Inicio del traslado', fecha(d.fechaInicioTraslado)],
    ];
    if (d.modalidad?.codigo === '01' && d.fechaEntregaTransportista) filas.push(['Entrega al transportista', fecha(d.fechaEntregaTransportista)]);
    filas.push(['Motivo del traslado', d.motivo ? `${d.motivo.codigo} - ${d.motivo.nombre}` : null]);
    if (d.descripcionMotivo) filas.push(['Descripción del motivo', d.descripcionMotivo]);
    filas.push(['Modalidad de transporte', d.modalidad ? `${d.modalidad.codigo} - ${d.modalidad.nombre}` : null]);
    filas.push(['Peso bruto total', d.pesoBrutoTotal !== null ? `${cantidad(d.pesoBrutoTotal)} ${d.unidadPeso ?? 'KGM'}` : null]);
    if (d.numeroBultos !== null) filas.push(['Número de bultos', cantidad(d.numeroBultos)]);
    if (d.documentoRelacionado) filas.push(['Documento relacionado', `${d.documentoRelacionado.tipo} ${d.documentoRelacionado.numero}`]);
    return filas;
  }

  private filasPunto(punto: PuntoPdfGuia): Fila[] {
    const filas: Fila[] = [
      ['Dirección', punto.direccion],
      ['Ubigeo', punto.ubigeo],
    ];
    // El código de establecimiento solo viaja (y se imprime) en el traslado entre establecimientos (04).
    if (this.d.motivo?.codigo === '04' && punto.codigoEstablecimiento) filas.push(['Establecimiento SUNAT', punto.codigoEstablecimiento]);
    return filas;
  }

  private filasTransporte(): Fila[] {
    const { transportista, vehiculo, conductor } = this.d;
    if (transportista) {
      const filas: Fila[] = [
        ['Transportista', transportista.razonSocial],
        ['RUC', transportista.ruc],
      ];
      if (transportista.registroMtc) filas.push(['Registro MTC', transportista.registroMtc]);
      return filas;
    }
    const filas: Fila[] = [];
    if (vehiculo) {
      filas.push(['Vehículo (placa)', vehiculo.placa]);
      if (vehiculo.tarjetaCirculacion) filas.push(['Tarjeta de circulación', vehiculo.tarjetaCirculacion]);
      if (vehiculo.marca) filas.push(['Marca', vehiculo.marca]);
    }
    if (conductor) {
      filas.push(['Conductor', conductor.nombre]);
      filas.push(['Documento del conductor', [conductor.tipoDocTexto, conductor.numDoc].filter(Boolean).join(' ')]);
      filas.push(['Licencia de conducir', conductor.licencia]);
    }
    return filas;
  }

  private cabecera(): void {
    const alto = 92;
    const caja = 180;
    const x = MARGEN;
    let xTexto = x;
    const logo = this.d.emisor.logo;
    // Se valida antes: un PNG dañado haría fallar a pdfkit; el logo es decorativo y nunca bloquea la impresión.
    if (logo && Buffer.isBuffer(logo) && imagenSoportada(logo)) {
      try {
        this.doc.image(logo, x, this.y, { fit: [86, 70], align: 'center', valign: 'center' });
        xTexto = x + 96;
      } catch {
        xTexto = x;
      }
    }
    const anchoTexto = this.ancho - caja - (xTexto - x) - 10;
    let yTexto = this.y + 2;
    this.doc.font('Helvetica-Bold').fontSize(12).fillColor(COLOR.marca);
    this.doc.text(t(this.d.emisor.razonSocial), xTexto, yTexto, { width: anchoTexto });
    yTexto = this.doc.y + 2;
    this.doc.font('Helvetica').fontSize(8).fillColor(COLOR.gris);
    for (const linea of [this.d.emisor.nombreComercial, this.d.emisor.direccion, this.d.emisor.ubicacion]) {
      if (!t(linea)) continue;
      this.doc.text(t(linea), xTexto, yTexto, { width: anchoTexto });
      yTexto = this.doc.y + 1;
    }

    const xCaja = x + this.ancho - caja;
    // Banda grafito con línea dorada detrás del nombre del documento (mismo recuadro de RUC que proforma y comprobante).
    this.doc.save();
    this.doc.rect(xCaja + 1, this.y + 24, caja - 2, 33).fill(COLOR.marca);
    this.doc.rect(xCaja + 1, this.y + 57, caja - 2, 1.8).fill(COLOR.acento);
    this.doc.restore();
    this.doc.roundedRect(xCaja, this.y, caja, alto - 6, 4).lineWidth(1.3).strokeColor(COLOR.marca).stroke();
    const centrado = { width: caja - 12, align: 'center' as const };
    this.doc.font('Helvetica-Bold').fontSize(11).fillColor(COLOR.texto).text(`RUC ${t(this.d.emisor.ruc)}`, xCaja + 6, this.y + 9, centrado);
    this.doc.fontSize(9).fillColor(COLOR.blanco).text('GUÍA DE REMISIÓN ELECTRÓNICA', xCaja + 6, this.y + 28, centrado);
    this.doc.fontSize(11).text('REMITENTE', xCaja + 6, this.y + 42, centrado);
    this.doc.fontSize(this.d.numero ? 13 : 11).fillColor(this.d.numero ? COLOR.marca : COLOR.peligro)
      .text(t(this.d.numero ?? `BORRADOR N.° ${this.d.idGuia}`), xCaja + 6, this.y + 64, centrado);
    this.y = Math.max(this.y + alto, yTexto + 6);
  }

  private banner(texto: string): void {
    const alto = 22;
    this.asegurar(alto + 8);
    this.doc.roundedRect(MARGEN, this.y, this.ancho, alto, 3).lineWidth(1.4).strokeColor(COLOR.peligro).stroke();
    this.doc.font('Helvetica-Bold').fontSize(11).fillColor(COLOR.peligro)
      .text(t(texto), MARGEN, this.y + 6, { width: this.ancho, align: 'center', lineBreak: false });
    this.y += alto + 8;
  }

  private bloque(titulo: string, filas: Fila[]): void {
    const etiqueta = 122;
    const anchoValor = this.ancho - etiqueta - 16;
    this.doc.font('Helvetica').fontSize(8);
    const alturas = filas.map(([, valor]) => Math.max(12, this.doc.heightOfString(t(valor) || '—', { width: anchoValor }) + 3));
    const alto = 22 + alturas.reduce((total, altura) => total + altura, 0) + 6;
    this.asegurar(Math.min(alto, 200));
    // Si el bloque no cabe, sigue en la hoja siguiente: cada tramo lleva su propio recuadro.
    let inicioTramo = this.y;
    const recuadro = (hasta: number): void => {
      this.doc.roundedRect(MARGEN, inicioTramo, this.ancho, hasta - inicioTramo, 3).lineWidth(0.6).strokeColor(COLOR.linea).stroke();
    };
    this.doc.rect(MARGEN, inicioTramo, this.ancho, 18).fillColor(COLOR.fondo).fill();
    this.doc.rect(MARGEN, inicioTramo, 3, 18).fillColor(COLOR.acento).fill();
    this.doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.marca).text(titulo, MARGEN + 8, inicioTramo + 5, { lineBreak: false });
    let filaY = inicioTramo + 23;
    filas.forEach(([nombre, valor], i) => {
      if (filaY + alturas[i] > this.limiteInferior()) {
        recuadro(filaY + 3);
        this.nuevaPagina();
        inicioTramo = this.y;
        filaY = this.y + 4;
      }
      this.doc.font('Helvetica-Bold').fontSize(7.5).fillColor(COLOR.gris).text(t(nombre), MARGEN + 8, filaY, { width: etiqueta - 8, lineBreak: false });
      this.doc.font('Helvetica').fontSize(8).fillColor(COLOR.texto).text(t(valor) || '—', MARGEN + etiqueta, filaY, { width: anchoValor });
      filaY += alturas[i];
    });
    recuadro(filaY + 3);
    this.y = filaY + 11;
  }

  private tablaItems(): void {
    const columnas = [28, 70, this.ancho - 28 - 70 - 46 - 70, 46, 70];
    const titulos = ['N.°', 'CÓDIGO', 'DESCRIPCIÓN', 'UNIDAD', 'CANTIDAD'];
    const encabezado = (): void => {
      this.asegurar(20 + 16);
      this.doc.rect(MARGEN, this.y, this.ancho, 18).fillColor(COLOR.marca).fill();
      this.doc.rect(MARGEN, this.y + 17.2, this.ancho, 1.6).fillColor(COLOR.acento).fill();
      let cursor = MARGEN;
      this.doc.font('Helvetica-Bold').fontSize(7.5).fillColor(COLOR.blanco);
      titulos.forEach((titulo, i) => {
        this.doc.text(titulo, cursor + 4, this.y + 5, { width: columnas[i] - 8, align: i >= 3 ? 'center' : 'left', lineBreak: false });
        cursor += columnas[i];
      });
      this.y += 18;
    };
    this.asegurar(40);
    this.doc.rect(MARGEN, this.y - 0.5, 3, 10).fillColor(COLOR.acento).fill();
    this.doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.marca).text('BIENES A TRASLADAR', MARGEN + 8, this.y, { lineBreak: false });
    this.y += 13;
    encabezado();
    if (!this.d.items.length) {
      this.doc.font('Helvetica-Oblique').fontSize(8).fillColor(COLOR.gris).text('Sin bienes registrados.', MARGEN + 4, this.y + 5, { lineBreak: false });
      this.y += 20;
    }
    this.d.items.forEach((item, indice) => {
      this.doc.font('Helvetica').fontSize(7.5);
      const descripcion = t(item.descripcion) || '—';
      const alto = Math.max(16, this.doc.heightOfString(descripcion, { width: columnas[2] - 8 }) + 7);
      if (this.y + alto > this.limiteInferior()) {
        this.nuevaPagina();
        encabezado();
      }
      if (indice % 2 === 1) this.doc.rect(MARGEN, this.y, this.ancho, alto).fillColor(COLOR.cebra).fill();
      const valores = [String(indice + 1), t(item.codigo) || '—', descripcion, t(item.unidad), cantidad(item.cantidad)];
      let cursor = MARGEN;
      this.doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.texto);
      valores.forEach((valor, i) => {
        const opciones = i === 2 ? { width: columnas[i] - 8 } : { width: columnas[i] - 8, align: i >= 3 ? 'center' : 'left', lineBreak: false };
        this.doc.text(valor, cursor + 4, this.y + 4, opciones);
        cursor += columnas[i];
      });
      this.doc.moveTo(MARGEN, this.y + alto).lineTo(MARGEN + this.ancho, this.y + alto).lineWidth(0.3).strokeColor(COLOR.linea).stroke();
      this.y += alto;
    });
    this.y += 10;
  }

  /** QR y leyenda con la guía aceptada; si no, la advertencia de que no tiene validez. */
  private cierre(): void {
    if (this.qr) {
      this.asegurar(LADO_QR + 10);
      this.doc.image(this.qr, MARGEN, this.y, { width: LADO_QR, height: LADO_QR });
      const x = MARGEN + LADO_QR + 14;
      const ancho = this.ancho - LADO_QR - 14;
      this.doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.texto).text(t(LEYENDA_GRE_REMITENTE), x, this.y + 22, { width: ancho });
      this.doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.gris)
        .text('Escanee el código QR para consultar la guía en SUNAT.', x, this.doc.y + 4, { width: ancho });
      this.y += LADO_QR + 10;
      return;
    }
    this.asegurar(30);
    const texto = this.d.estado === 'aceptado'
      ? `${LEYENDA_GRE_REMITENTE}. SUNAT no entregó el enlace del código QR en la constancia.`
      : 'Documento sin validez tributaria: SUNAT no ha aceptado esta guía de remisión.';
    this.doc.font('Helvetica-Bold').fontSize(8.5).fillColor(this.d.estado === 'aceptado' ? COLOR.texto : COLOR.peligro)
      .text(t(texto), MARGEN, this.y, { width: this.ancho, align: 'center' });
    this.y = this.doc.y + 8;
  }

  /** Numeración de páginas y, si no está aceptada, la marca de fondo en cada hoja. */
  private paginas(): void {
    const { start, count } = this.doc.bufferedPageRange();
    for (let i = start; i < start + count; i++) {
      this.doc.switchToPage(i);
      if (this.marca) this.marcaAgua(this.marca);
      // El pie va dentro del margen inferior: sin margen, pdfkit no abre una hoja nueva al escribirlo.
      const margenInferior = this.doc.page.margins.bottom;
      this.doc.page.margins.bottom = 0;
      this.doc.font('Helvetica').fontSize(7).fillColor(COLOR.gris)
        .text(`${t(this.d.numero ?? `Borrador N.° ${this.d.idGuia}`)} · Página ${i - start + 1} de ${count}`, MARGEN, this.doc.page.height - MARGEN + 6, {
          width: this.ancho,
          align: 'right',
          lineBreak: false,
        });
      this.doc.page.margins.bottom = margenInferior;
    }
  }

  private marcaAgua(texto: string): void {
    const { width, height } = this.doc.page;
    this.doc.save();
    this.doc.rotate(-35, { origin: [width / 2, height / 2] });
    this.doc.fillOpacity(0.08);
    this.doc.font('Helvetica-Bold').fontSize(44).fillColor(COLOR.peligro);
    const limpio = t(texto);
    this.doc.text(limpio, (width - this.doc.widthOfString(limpio)) / 2, height / 2 - 22, { lineBreak: false });
    this.doc.restore();
  }

  private limiteInferior(): number {
    return this.doc.page.height - MARGEN - ALTO_PIE;
  }

  private asegurar(alto: number): void {
    if (this.y + alto > this.limiteInferior()) this.nuevaPagina();
  }

  private nuevaPagina(): void {
    this.doc.addPage();
    dibujarFranjaMarca(this.doc);
    this.y = MARGEN;
  }
}
