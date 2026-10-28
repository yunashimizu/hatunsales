import { Dinero } from '../../caja/dominio/dinero';
import { PALETA } from './proforma-documento';
import { textoPdf } from './proforma-pdf';
import {
  capitalizarEstado,
  DatosReporteVentas,
  etiquetaPeriodo,
  etiquetaTipoReporte,
  idTipoDeDetalle,
} from '../reporte-export';

// pdfkit no trae tipos en este proyecto (mismo uso que en proformas y arqueos).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require('pdfkit');

/**
 * Reporte de ventas en PDF (A4 vertical) con la imagen de marca de la proforma y el arqueo:
 * banda con la empresa y los filtros, tarjetas de indicadores, gráfico de tendencia, ventas por
 * tipo de comprobante, productos más vendidos y más cotizados, clientes y el detalle de
 * comprobantes con la cabecera de la tabla repetida en cada página y «Página x de y» al pie.
 *
 * Todo el texto de una línea se escribe con `lineBreak: false` y se recorta aquí con «…» si no
 * cabe; los saltos de página los decide este archivo (no el flujo de pdfkit).
 */

const ANCHO_PAGINA = 595.28;
const ALTO_PAGINA = 841.89;
const MARGEN = 36;
const ANCHO = ANCHO_PAGINA - MARGEN * 2;
/** Por debajo de esta altura no se dibuja contenido: ahí va el pie. */
const LIMITE_Y = ALTO_PAGINA - MARGEN - 14;
/** Más filas que estas en el detalle harían un PDF de decenas de páginas: el Excel lleva todo. */
const MAX_FILAS_DETALLE = 1500;

type Fuente = 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique';
type Alineacion = 'left' | 'right' | 'center';

const COLOR = {
  marca: PALETA.grafito,
  acento: PALETA.dorado,
  acentoClaro: PALETA.doradoClaro,
  acentoSuave: PALETA.doradoSuave,
  texto: PALETA.texto,
  gris: PALETA.gris,
  grisClaro: PALETA.grisClaro,
  plata: PALETA.plata,
  linea: PALETA.linea,
  fondo: PALETA.fondo,
  cebra: PALETA.cebra,
  blanco: PALETA.blanco,
  peligro: PALETA.peligro,
};

function soles(valor: number | null | undefined): string {
  return Dinero.desdeNumeroRedondeado(Number(valor ?? 0)).formatear();
}

function entero(valor: number | null | undefined): string {
  return Math.round(Number(valor ?? 0)).toLocaleString('en-US');
}

function cantidad(valor: number | null | undefined): string {
  const n = Number(valor ?? 0);
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function porcentaje(parte: number): string {
  return `${(parte * 100).toFixed(1)} %`;
}

/** Cifra corta para el eje del gráfico: «S/ 850», «S/ 2.4 mil», «S/ 1.2 M». */
function monedaCorta(valor: number): string {
  const a = Math.abs(valor);
  const sinCero = (n: number) => n.toFixed(1).replace(/\.0$/, '');
  if (a >= 1_000_000) return `S/ ${sinCero(a / 1_000_000)} M`;
  if (a >= 10_000) return `S/ ${Math.round(a / 1000)} mil`;
  if (a >= 1_000) return `S/ ${sinCero(a / 1000)} mil`;
  return `S/ ${Math.round(a)}`;
}

function ymdLegible(ymd: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(ymd || '—');
}

const ABREVIATURA_TIPO: Record<string, string> = {
  Factura: 'FAC',
  Boleta: 'BOL',
  'Nota de crédito': 'N.C.',
  'Nota de débito': 'N.D.',
};

interface ColumnaPdf<T> {
  titulo: string;
  ancho: number;
  alinear?: Alineacion;
  texto?: (fila: T, indice: number) => string;
  /** Segunda línea, en gris pequeño bajo el texto principal. */
  sub?: (fila: T) => string;
  color?: (fila: T) => string;
  negrita?: boolean;
  /** En lugar de texto: barra proporcional (0–1) con su etiqueta a la derecha. */
  barra?: (fila: T) => { parte: number; etiqueta: string; color?: string };
}

export async function generarReporteVentasPdf(datos: DatosReporteVentas): Promise<Buffer> {
  const { cabecera, reporte } = datos;
  const stats = reporte.estadisticas;
  const filtroTipo = reporte.filtro_tipo;
  const devueltos = reporte.productos_modo === 'devueltos';
  const rangoTexto = `${cabecera.fechaInicio} — ${cabecera.fechaFin}`;
  const tipoTexto = filtroTipo ? filtroTipo.nombre : 'Todos los comprobantes';

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGEN, bottom: MARGEN, left: MARGEN, right: MARGEN },
    bufferPages: true,
    info: {
      Title: cabecera.titulo,
      Author: cabecera.empresa,
      Subject: `${etiquetaPeriodo(reporte.periodo)} · ${rangoTexto} · ${tipoTexto}`,
      Creator: 'HatunSales',
      Producer: 'HatunSales',
    },
  });
  const trozos: Buffer[] = [];
  doc.on('data', (trozo: Buffer) => trozos.push(trozo));
  const terminado = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(trozos)));
    doc.on('error', reject);
  });

  let y = 0;

  // ---------------------------------------------------------------------------------- texto y formas

  function ajustar(texto: string, ancho: number, fuente: Fuente, tam: number): string {
    doc.font(fuente).fontSize(tam);
    if (doc.widthOfString(texto) <= ancho) return texto;
    let t = texto;
    while (t.length > 1 && doc.widthOfString(`${t}…`) > ancho) t = t.slice(0, -1);
    return `${t.trimEnd()}…`;
  }

  function texto(
    valor: unknown,
    x: number,
    yy: number,
    ancho: number,
    o: { fuente?: Fuente; tam?: number; color?: string; alinear?: Alineacion; espaciado?: number } = {},
  ): void {
    const fuente = o.fuente ?? 'Helvetica';
    const tam = o.tam ?? 8;
    const limpio = ajustar(textoPdf(valor), ancho, fuente, tam);
    doc
      .font(fuente)
      .fontSize(tam)
      .fillColor(o.color ?? COLOR.texto)
      .text(limpio, x, yy, {
        width: ancho,
        align: o.alinear ?? 'left',
        lineBreak: false,
        characterSpacing: o.espaciado ?? 0,
      });
  }

  function rect(x: number, yy: number, w: number, h: number, color: string): void {
    doc.save();
    doc.rect(x, yy, w, h).fill(color);
    doc.restore();
  }

  function linea(x1: number, y1: number, x2: number, y2: number, color: string, grosor = 0.5): void {
    doc.save();
    doc.strokeColor(color).lineWidth(grosor).moveTo(x1, y1).lineTo(x2, y2).stroke();
    doc.restore();
  }

  // ---------------------------------------------------------------------------------- páginas

  function encabezadoPrimera(): void {
    rect(0, 0, ANCHO_PAGINA, 82, COLOR.marca);
    rect(0, 82, ANCHO_PAGINA, 3, COLOR.acento);
    texto(cabecera.empresa, MARGEN, 20, ANCHO * 0.58, { fuente: 'Helvetica-Bold', tam: 16, color: COLOR.blanco });
    texto(`RUC ${cabecera.ruc}`, MARGEN, 42, ANCHO * 0.58, { tam: 8.5, color: COLOR.plata });
    if (cabecera.direccion) texto(cabecera.direccion, MARGEN, 54, ANCHO * 0.58, { tam: 7.5, color: COLOR.plata });
    texto(`Generado el ${cabecera.generadoEl} (hora de Lima)`, MARGEN, 66, ANCHO * 0.58, {
      tam: 7,
      color: COLOR.plata,
    });

    const xd = MARGEN + ANCHO * 0.58;
    const wd = ANCHO * 0.42;
    texto('REPORTE DE VENTAS', xd, 20, wd, {
      fuente: 'Helvetica-Bold',
      tam: 12,
      color: COLOR.acento,
      alinear: 'right',
      espaciado: 0.8,
    });
    texto(`${etiquetaPeriodo(reporte.periodo)} · ${rangoTexto}`, xd, 40, wd, {
      tam: 8.5,
      color: COLOR.blanco,
      alinear: 'right',
    });
    texto(`Tipo: ${tipoTexto}`, xd, 54, wd, {
      fuente: 'Helvetica-Bold',
      tam: 8.5,
      color: filtroTipo ? COLOR.acento : COLOR.plata,
      alinear: 'right',
    });
    y = 102;
  }

  function encabezadoContinuacion(): void {
    texto(`${cabecera.empresa} · Reporte de ventas`, MARGEN, MARGEN - 6, ANCHO * 0.55, {
      fuente: 'Helvetica-Bold',
      tam: 7.5,
      color: COLOR.marca,
    });
    texto(`${etiquetaPeriodo(reporte.periodo)} · ${rangoTexto} · ${tipoTexto}`, MARGEN + ANCHO * 0.45, MARGEN - 6, ANCHO * 0.55, {
      tam: 7.5,
      color: COLOR.gris,
      alinear: 'right',
    });
    linea(MARGEN, MARGEN + 6, MARGEN + ANCHO, MARGEN + 6, COLOR.linea);
    rect(MARGEN, MARGEN + 5.2, 40, 1.6, COLOR.acento);
    y = MARGEN + 20;
  }

  function nuevaPagina(): void {
    doc.addPage();
    encabezadoContinuacion();
  }

  /** Si lo que sigue no cabe en la página, salta (y redibuja la cabecera de la tabla en curso). */
  function asegurar(alto: number, redibujar?: () => void): void {
    if (y + alto <= LIMITE_Y) return;
    nuevaPagina();
    redibujar?.();
  }

  /** Título que se dibuja junto a la tabla que sigue: así no queda un título solo al pie de una página. */
  let seccionPendiente: { titulo: string; nota?: string } | null = null;
  function seccionTabla(titulo: string, nota?: string): void {
    seccionPendiente = { titulo, nota };
  }

  function seccion(titulo: string, nota?: string, altoMinimo = 80): void {
    asegurar(altoMinimo);
    rect(MARGEN, y + 1, 3, nota ? 21 : 11, COLOR.acento);
    texto(titulo, MARGEN + 9, y, ANCHO - 9, { fuente: 'Helvetica-Bold', tam: 10.5, color: COLOR.marca });
    if (nota) texto(nota, MARGEN + 9, y + 13, ANCHO - 9, { tam: 7, color: COLOR.grisClaro });
    y += nota ? 32 : 22;
  }

  // ---------------------------------------------------------------------------------- tarjetas

  function tarjetas(
    items: Array<{ etiqueta: string; valor: string; sub: string; acento?: string; peligro?: boolean }>,
    alto: number,
    tamValor: number,
  ): void {
    const hueco = 9;
    const w = (ANCHO - hueco * (items.length - 1)) / items.length;
    items.forEach((it, i) => {
      const x = MARGEN + i * (w + hueco);
      doc.save();
      doc.roundedRect(x, y, w, alto, 5).lineWidth(0.6).fillAndStroke(COLOR.fondo, COLOR.linea);
      doc.restore();
      rect(x, y + 6, 3, alto - 12, it.acento ?? COLOR.acento);
      texto(it.etiqueta.toUpperCase(), x + 11, y + 8, w - 16, { tam: 6.3, color: COLOR.gris, espaciado: 0.5 });
      texto(it.valor, x + 11, y + 8 + 11, w - 16, {
        fuente: 'Helvetica-Bold',
        tam: tamValor,
        color: it.peligro ? COLOR.peligro : COLOR.marca,
      });
      texto(it.sub, x + 11, y + alto - 13, w - 16, { tam: 6.3, color: COLOR.grisClaro });
    });
    y += alto + 9;
  }

  // ---------------------------------------------------------------------------------- tablas

  function tabla<T>(columnas: ColumnaPdf<T>[], filas: T[], alto: number, vacio: string): void {
    const pad = 5;
    const dibujarCabecera = (): void => {
      rect(MARGEN, y, ANCHO, 18, COLOR.marca);
      let x = MARGEN;
      for (const col of columnas) {
        texto(col.titulo, x + pad, y + 5.5, col.ancho - pad * 2, {
          fuente: 'Helvetica-Bold',
          tam: 7,
          color: COLOR.blanco,
          alinear: col.alinear ?? 'left',
        });
        x += col.ancho;
      }
      y += 18;
    };

    // Título + tabla se reparten bien entre páginas: si la tabla cabe en una página y partirla dejaría menos
    // de 3 filas en alguno de los dos lados, pasa entera a la página siguiente.
    const pendiente = seccionPendiente;
    seccionPendiente = null;
    const altoTitulo = pendiente ? (pendiente.nota ? 32 : 22) : 0;
    const altoTotal = altoTitulo + 18 + Math.max(filas.length, 1) * alto + 10;
    const disponible = LIMITE_Y - y;
    if (altoTotal > disponible) {
      const caben = Math.floor((disponible - altoTitulo - 18) / alto);
      const quedarian = filas.length - caben;
      const cabeEnUnaPagina = altoTotal <= LIMITE_Y - (MARGEN + 20);
      if (cabeEnUnaPagina && (caben < 3 || quedarian < 3)) nuevaPagina();
    }
    if (pendiente) seccion(pendiente.titulo, pendiente.nota, altoTitulo + 18 + alto * Math.min(filas.length || 1, 3));
    asegurar(18 + (filas.length ? alto * Math.min(filas.length, 2) : 26));
    dibujarCabecera();

    if (!filas.length) {
      texto(vacio, MARGEN + pad, y + 8, ANCHO - pad * 2, { fuente: 'Helvetica-Oblique', tam: 8, color: COLOR.gris });
      linea(MARGEN, y + 26, MARGEN + ANCHO, y + 26, COLOR.linea);
      y += 30;
      return;
    }

    filas.forEach((fila, i) => {
      asegurar(alto, dibujarCabecera);
      if (i % 2 === 1) rect(MARGEN, y, ANCHO, alto, COLOR.cebra);
      let x = MARGEN;
      for (const col of columnas) {
        const alinear = col.alinear ?? 'left';
        const color = col.color?.(fila) ?? COLOR.texto;
        if (col.barra) {
          const b = col.barra(fila);
          const anchoBarra = Math.max(20, col.ancho - pad * 2 - 40);
          const yb = y + alto / 2 - 2.5;
          rect(x + pad, yb, anchoBarra, 5, COLOR.linea);
          rect(x + pad, yb, Math.max(0, Math.min(1, b.parte)) * anchoBarra, 5, b.color ?? COLOR.acento);
          texto(b.etiqueta, x + pad + anchoBarra + 4, y + alto / 2 - 4, 34, { tam: 7, color: COLOR.gris, alinear: 'right' });
        } else {
          const principal = col.texto ? col.texto(fila, i) : '';
          const sub = col.sub?.(fila);
          const ySub = y + 4;
          const yUnica = y + (alto - 9) / 2;
          texto(principal, x + pad, sub ? ySub : yUnica, col.ancho - pad * 2, {
            fuente: col.negrita ? 'Helvetica-Bold' : 'Helvetica',
            tam: 8,
            color,
            alinear,
          });
          if (sub) {
            texto(sub, x + pad, y + 14, col.ancho - pad * 2, { tam: 6.5, color: COLOR.grisClaro, alinear });
          }
        }
        x += col.ancho;
      }
      linea(MARGEN, y + alto, MARGEN + ANCHO, y + alto, COLOR.linea, 0.3);
      y += alto;
    });
    y += 10;
  }

  // ---------------------------------------------------------------------------------- gráfico

  function graficoTendencia(): void {
    const serie = stats.serie ?? [];
    seccion('Tendencia de ventas', 'Importe neto vendido en cada tramo del periodo; la columna oscura marca el pico.', 150);
    if (!serie.length) {
      texto('Sin ventas en el periodo para graficar.', MARGEN + 9, y, ANCHO - 9, {
        fuente: 'Helvetica-Oblique',
        tam: 8,
        color: COLOR.gris,
      });
      y += 22;
      return;
    }
    const x0 = MARGEN + 46;
    const anchoArea = ANCHO - 46 - 4;
    const altoArea = 92;
    const yTop = y + 8;
    const yBase = yTop + altoArea;
    const max = Math.max(...serie.map((s) => Math.max(s.total, 0)), 1);

    for (const fr of [1, 0.5, 0]) {
      const yy = yBase - altoArea * fr;
      linea(x0 - 4, yy, x0 + anchoArea, yy, fr === 0 ? COLOR.gris : COLOR.linea, fr === 0 ? 0.7 : 0.4);
      texto(monedaCorta(max * fr), MARGEN, yy - 3.5, 40, { tam: 6.3, color: COLOR.grisClaro, alinear: 'right' });
    }

    const n = serie.length;
    const paso = anchoArea / n;
    const ancho = Math.min(30, paso * 0.68);
    serie.forEach((p, i) => {
      const h = (Math.max(p.total, 0) / max) * altoArea;
      const bx = x0 + i * paso + (paso - ancho) / 2;
      const esPico = p.total > 0 && p.total === max;
      if (h > 0) rect(bx, yBase - Math.max(h, 1), ancho, Math.max(h, 1), esPico ? COLOR.marca : COLOR.acento);
      if (p.total < 0) rect(bx, yBase - 2, ancho, 2, COLOR.peligro);
      if (n <= 10 && p.total > 0) {
        texto(monedaCorta(p.total), bx - 10, yBase - h - 9, ancho + 20, { tam: 6, color: COLOR.gris, alinear: 'center' });
      }
      const mostrarEtiqueta = n <= 12 || i === 0 || i === n - 1 || i === Math.floor((n - 1) / 2);
      if (mostrarEtiqueta) {
        texto(p.etiqueta, bx + ancho / 2 - 30, yBase + 5, 60, { tam: 6.5, color: COLOR.gris, alinear: 'center' });
      }
    });
    y = yBase + 24;
  }

  // ---------------------------------------------------------------------------------- contenido

  encabezadoPrimera();

  tarjetas(
    [
      {
        etiqueta: 'Total vendido (neto)',
        valor: soles(reporte.total_vendido),
        sub: reporte.notas_credito.cantidad
          ? `Neto: ${reporte.notas_credito.cantidad} nota${reporte.notas_credito.cantidad === 1 ? '' : 's'} de crédito`
          : 'Ventas netas del periodo',
        peligro: reporte.total_vendido < 0,
      },
      { etiqueta: 'Comprobantes', valor: entero(reporte.cantidad_comprobantes), sub: 'Facturas y boletas vigentes', acento: COLOR.marca },
      { etiqueta: 'Ticket promedio', valor: soles(reporte.ticket_promedio), sub: 'Venta neta por comprobante', acento: COLOR.marca },
      { etiqueta: 'Ventas brutas', valor: soles(reporte.total_bruto), sub: 'Antes de las notas de crédito', acento: COLOR.marca },
    ],
    56,
    13.5,
  );
  tarjetas(
    [
      { etiqueta: 'Venta máxima', valor: soles(stats.venta_maxima), sub: 'Comprobante más alto', acento: COLOR.linea },
      { etiqueta: 'Venta mínima', valor: soles(stats.venta_minima), sub: 'Comprobante más bajo', acento: COLOR.linea },
      { etiqueta: 'Días con venta', valor: entero(stats.dias_con_venta), sub: 'Con al menos un comprobante', acento: COLOR.linea },
      {
        etiqueta: 'Anulados / error',
        valor: entero(stats.anulados + stats.con_error),
        sub: `${stats.anulados} anulados · ${stats.con_error} con error o rechazados`,
        acento: COLOR.linea,
      },
    ],
    44,
    11.5,
  );
  y += 4;

  graficoTendencia();

  // Ventas por tipo de comprobante
  seccionTabla(
    'Ventas por tipo de comprobante',
    filtroTipo
      ? `El reporte está filtrado por «${filtroTipo.nombre}»; aquí se ve el reparto de todos los tipos del periodo.`
      : 'Cómo se reparte lo vendido entre facturas, boletas y notas del periodo.',
  );
  const sumaAbs = reporte.por_tipo.reduce((acc, t) => acc + Math.abs(t.total), 0);
  tabla(
    [
      {
        titulo: 'Tipo de comprobante',
        ancho: 210,
        negrita: true,
        texto: (t) => t.tipo + (filtroTipo?.id_tipo === t.id_tipo ? '   (filtro aplicado)' : ''),
      },
      { titulo: 'Comprobantes', ancho: 85, alinear: 'right', texto: (t) => entero(t.cantidad) },
      {
        titulo: 'Importe',
        ancho: 100,
        alinear: 'right',
        negrita: true,
        texto: (t) => soles(t.total),
        color: (t) => (t.total < 0 ? COLOR.peligro : COLOR.texto),
      },
      {
        titulo: 'Participación',
        ancho: 128,
        barra: (t) => {
          const parte = sumaAbs > 0 ? Math.abs(t.total) / sumaAbs : 0;
          return { parte, etiqueta: porcentaje(parte), color: t.total < 0 ? COLOR.peligro : COLOR.acento };
        },
      },
    ],
    reporte.por_tipo,
    18,
    'Sin comprobantes en el periodo.',
  );

  // Productos más vendidos (o devueltos)
  const maxVendido = Math.max(...reporte.top_productos_vendidos.map((p) => p.total), 1);
  seccionTabla(
    devueltos ? 'Productos con más devoluciones' : 'Productos más vendidos',
    devueltos
      ? 'Productos de las notas de crédito del periodo, ordenados por importe devuelto.'
      : 'Ordenados por importe neto vendido (las notas de crédito restan).',
  );
  tabla(
    [
      { titulo: '#', ancho: 22, alinear: 'center', texto: (_p, i) => String(i + 1), color: () => COLOR.grisClaro },
      {
        titulo: 'Producto',
        ancho: 235,
        negrita: true,
        texto: (p) => p.producto,
        sub: (p) => (p.codigo ? `Código ${p.codigo}` : ''),
      },
      { titulo: devueltos ? 'Cant. devuelta' : 'Cantidad', ancho: 66, alinear: 'right', texto: (p) => cantidad(p.cantidad) },
      { titulo: 'Importe', ancho: 85, alinear: 'right', negrita: true, texto: (p) => soles(p.total) },
      {
        titulo: devueltos ? '% de lo devuelto' : '% de las ventas',
        ancho: 115,
        barra: (p) => {
          const parte = reporte.total_vendido > 0 && !devueltos ? p.total / reporte.total_vendido : p.total / maxVendido;
          return { parte: p.total / maxVendido, etiqueta: porcentaje(Math.max(0, parte)) };
        },
      },
    ],
    reporte.top_productos_vendidos,
    24,
    devueltos ? 'Sin devoluciones en el periodo.' : 'Sin productos vendidos en el periodo.',
  );

  // Productos más cotizados
  const maxCotizado = Math.max(...reporte.top_productos_cotizados.map((p) => p.cotizaciones), 1);
  seccionTabla(
    'Productos más cotizados',
    'Cotizaciones del periodo (no anuladas) que incluyen cada producto, y cuántas llegaron a ser venta.',
  );
  tabla(
    [
      { titulo: '#', ancho: 22, alinear: 'center', texto: (_p, i) => String(i + 1), color: () => COLOR.grisClaro },
      {
        titulo: 'Producto',
        ancho: 215,
        negrita: true,
        texto: (p) => p.producto,
        sub: (p) => (p.sku ? `Código ${p.sku}` : ''),
      },
      { titulo: 'Cantidad', ancho: 58, alinear: 'right', texto: (p) => cantidad(p.cantidad) },
      { titulo: 'Importe', ancho: 80, alinear: 'right', texto: (p) => soles(p.total) },
      {
        titulo: 'Cotizaciones',
        ancho: 95,
        barra: (p) => ({ parte: p.cotizaciones / maxCotizado, etiqueta: String(p.cotizaciones) }),
      },
      {
        titulo: 'Convertidas',
        ancho: 53,
        alinear: 'right',
        texto: (p) => (p.cotizaciones ? `${p.convertidas} de ${p.cotizaciones}` : '—'),
        color: (p) => (p.convertidas > 0 ? COLOR.texto : COLOR.grisClaro),
      },
    ],
    reporte.top_productos_cotizados,
    24,
    'Sin cotizaciones en el periodo.',
  );

  // Clientes
  const topClientes = stats.top_clientes ?? [];
  const maxCliente = Math.max(...topClientes.map((c) => Math.abs(c.total)), 1);
  seccionTabla('Clientes con mayor importe', 'Neto por cliente: sus notas de crédito restan de lo que compró.');
  tabla(
    [
      { titulo: '#', ancho: 22, alinear: 'center', texto: (_c, i) => String(i + 1), color: () => COLOR.grisClaro },
      {
        titulo: 'Cliente',
        ancho: 235,
        negrita: true,
        texto: (c) => c.cliente,
        sub: (c) => (c.documento ? `Documento ${c.documento}` : ''),
      },
      { titulo: 'Comprobantes', ancho: 78, alinear: 'right', texto: (c) => entero(c.cantidad) },
      { titulo: 'Importe', ancho: 88, alinear: 'right', negrita: true, texto: (c) => soles(c.total) },
      {
        titulo: '% del total',
        ancho: 100,
        barra: (c) => ({
          parte: Math.abs(c.total) / maxCliente,
          etiqueta: porcentaje(reporte.total_vendido > 0 ? Math.max(0, c.total / reporte.total_vendido) : 0),
        }),
      },
    ],
    topClientes,
    24,
    'Sin clientes en el periodo.',
  );

  // Detalle de comprobantes
  const filasDetalle = reporte.detalle.slice(0, MAX_FILAS_DETALLE);
  seccionTabla(
    'Detalle de comprobantes',
    `${entero(reporte.detalle.length)} documento${reporte.detalle.length === 1 ? '' : 's'} del periodo. Las notas de crédito restan; no se incluyen anulados, rechazados por SUNAT, con error ni pruebas BETA.`,
  );
  tabla(
    [
      { titulo: 'Comprobante', ancho: 80, negrita: true, texto: (d) => d.numero_formateado || `${d.serie ?? ''}-${d.numero ?? ''}` },
      {
        titulo: 'Tipo',
        ancho: 34,
        texto: (d) => {
          return ABREVIATURA_TIPO[etiquetaTipoReporte(idTipoDeDetalle(d))] ?? '—';
        },
        color: () => COLOR.gris,
      },
      { titulo: 'Fecha', ancho: 52, texto: (d) => ymdLegible(d.fecha) },
      { titulo: 'Cliente', ancho: 148, texto: (d) => d.cliente || '—' },
      { titulo: 'Documento', ancho: 66, texto: (d) => d.documento_cliente || '—', color: () => COLOR.gris },
      { titulo: 'Estado', ancho: 49, texto: (d) => capitalizarEstado(d.estado), color: () => COLOR.gris },
      {
        titulo: 'Total',
        ancho: 94,
        alinear: 'right',
        negrita: true,
        texto: (d) => soles(d.total_vendido),
        color: (d) => (Number(d.total_vendido) < 0 ? COLOR.peligro : COLOR.texto),
      },
    ],
    filasDetalle,
    15,
    'Sin movimientos en el periodo seleccionado.',
  );
  if (filasDetalle.length) {
    asegurar(30);
    y -= 4;
    rect(MARGEN, y, ANCHO, 20, COLOR.marca);
    rect(MARGEN, y + 20, ANCHO, 1.6, COLOR.acento);
    texto('Total neto', MARGEN + 8, y + 6, 200, { fuente: 'Helvetica-Bold', tam: 8.5, color: COLOR.blanco });
    texto(soles(reporte.total_vendido), MARGEN + ANCHO - 200, y + 5, 192, {
      fuente: 'Helvetica-Bold',
      tam: 10,
      color: COLOR.acentoClaro,
      alinear: 'right',
    });
    y += 26;
  }
  if (reporte.detalle.length > MAX_FILAS_DETALLE) {
    asegurar(24);
    texto(
      `Se muestran los primeros ${entero(MAX_FILAS_DETALLE)} de ${entero(reporte.detalle.length)} comprobantes. El detalle completo está en el reporte en Excel.`,
      MARGEN,
      y,
      ANCHO,
      { fuente: 'Helvetica-Oblique', tam: 7.5, color: COLOR.gris },
    );
    y += 18;
  }

  // ---------------------------------------------------------------------------------- pie de página

  const paginas = doc.bufferedPageRange();
  for (let i = 0; i < paginas.count; i++) {
    doc.switchToPage(paginas.start + i);
    // El pie va dentro del margen inferior: sin margen, pdfkit no abre una página al escribirlo.
    doc.page.margins.bottom = 0;
    const yPie = ALTO_PAGINA - 30;
    linea(MARGEN, yPie - 5, MARGEN + ANCHO, yPie - 5, COLOR.linea);
    texto(`${cabecera.empresa} · ${cabecera.titulo}`, MARGEN, yPie, 230, { tam: 7, color: COLOR.gris });
    texto(`Generado el ${cabecera.generadoEl}`, MARGEN + 200, yPie, 123, { tam: 7, color: COLOR.grisClaro, alinear: 'center' });
    texto(`Página ${i + 1} de ${paginas.count}`, MARGEN + ANCHO - 120, yPie, 120, {
      fuente: 'Helvetica-Bold',
      tam: 7,
      color: COLOR.gris,
      alinear: 'right',
    });
  }

  doc.end();
  return terminado;
}
