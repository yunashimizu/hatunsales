import * as ExcelJS from 'exceljs';
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
  LEYENDA_SIN_VALOR_TRIBUTARIO,
  numeroSeguro,
  textoMultilinea,
  textoPlano,
} from './proforma-documento';

/**
 * Proforma en Excel (.xlsx) con exceljs: una hoja "Proforma" lista para
 * imprimir en A4 vertical, con la misma información que el PDF.
 */

const ARGB = {
  marca: 'FF0F4C5C',
  marcaSuave: 'FFE7F0F2',
  texto: 'FF1F2933',
  gris: 'FF52606D',
  grisClaro: 'FF7B8794',
  linea: 'FFC9D1D9',
  fondo: 'FFF6F8FA',
  cebra: 'FFF3F6F8',
  blanco: 'FFFFFFFF',
};

const FORMATO_SOLES = '"S/ "#,##0.00';
const FORMATO_ENTERO = '#,##0';
const FUENTE = 'Calibri';

/** Ancho en caracteres: N°, Código, Unidad, P. Unit., Cant., Dto., Descripción, Importe. */
const ANCHOS = [6, 14, 11, 15, 9, 14, 42, 17];

const bordeFino: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: ARGB.linea } };
const bordeCompleto: Partial<ExcelJS.Borders> = {
  top: bordeFino,
  left: bordeFino,
  bottom: bordeFino,
  right: bordeFino,
};

function relleno(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

/** Alto aproximado de una fila según cuántas líneas ocupa el texto más largo. */
function altoPorTexto(textos: Array<{ texto: string; ancho: number }>, minimo = 18): number {
  const lineas = Math.max(
    1,
    ...textos.map(({ texto, ancho }) => {
      const util = Math.max(4, Math.floor(ancho * 1.1));
      return Math.ceil((texto || '').length / util) || 1;
    }),
  );
  return Math.max(minimo, lineas * 13 + 5);
}

/** En encabezados/pies de Excel el "&" es un código de control. */
function textoPie(texto: string): string {
  return texto.replace(/&/g, '&&');
}

function formatearTelefono(valor?: string | null): string {
  const d = String(valor ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('51')) return `+51 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  if (d.length === 9) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  return textoPlano(valor);
}

export async function generarProformaExcel(d: DatosProformaDocumento): Promise<Buffer> {
  const razonSocial = textoPlano(d.emisor?.razon_social) || 'HATUNSALES S.A.C.';
  const ruc = textoPlano(d.emisor?.ruc);
  const codigo = textoPlano(d.codigo) || '—';
  const generadoEn = d.generado_en ?? new Date();
  const items = d.items ?? [];

  const wb = new ExcelJS.Workbook();
  wb.creator = razonSocial;
  wb.lastModifiedBy = razonSocial;
  wb.company = razonSocial;
  wb.title = `Proforma ${codigo}`;
  wb.subject = 'Proforma comercial';
  wb.description = LEYENDA_SIN_VALOR_TRIBUTARIO;
  wb.created = generadoEn;
  wb.modified = generadoEn;
  wb.calcProperties = { fullCalcOnLoad: true };

  const ws = wb.addWorksheet('Proforma', {
    properties: { defaultRowHeight: 16 },
    views: [{ showGridLines: false }],
  });
  ws.columns = ANCHOS.map((width) => ({ width }));

  let fila = 0;
  const siguiente = (alto?: number) => {
    fila += 1;
    if (alto) ws.getRow(fila).height = alto;
    return fila;
  };
  const combinar = (desde: string, hasta: string, r: number) => ws.mergeCells(`${desde}${r}:${hasta}${r}`);

  // ── Cabecera de la empresa ─────────────────────────────────────
  let r = siguiente(26);
  combinar('A', 'H', r);
  Object.assign(ws.getCell(`A${r}`), {
    value: razonSocial,
    font: { name: FUENTE, bold: true, size: 16, color: { argb: ARGB.marca } },
    alignment: { vertical: 'middle', horizontal: 'left' },
  });

  r = siguiente(16);
  combinar('A', 'H', r);
  Object.assign(ws.getCell(`A${r}`), {
    value: ruc ? `RUC ${ruc}` : '',
    font: { name: FUENTE, bold: true, size: 10, color: { argb: ARGB.gris } },
  });

  const direccion = [textoPlano(d.emisor?.direccion), textoPlano(d.emisor?.ubicacion)]
    .filter(Boolean)
    .join(' — ');
  if (direccion) {
    r = siguiente(16);
    combinar('A', 'H', r);
    Object.assign(ws.getCell(`A${r}`), {
      value: direccion,
      font: { name: FUENTE, size: 9, color: { argb: ARGB.gris } },
      alignment: { wrapText: true, vertical: 'top' },
    });
  }
  siguiente(6);

  // ── Título ─────────────────────────────────────────────────────
  r = siguiente(30);
  combinar('A', 'D', r);
  combinar('E', 'H', r);
  Object.assign(ws.getCell(`A${r}`), {
    value: 'PROFORMA',
    font: { name: FUENTE, bold: true, size: 18, color: { argb: ARGB.blanco } },
    fill: relleno(ARGB.marca),
    alignment: { vertical: 'middle', horizontal: 'left', indent: 1 },
  });
  Object.assign(ws.getCell(`E${r}`), {
    value: codigo,
    font: { name: FUENTE, bold: true, size: 15, color: { argb: ARGB.blanco } },
    fill: relleno(ARGB.marca),
    alignment: { vertical: 'middle', horizontal: 'right', indent: 1 },
  });
  siguiente(8);

  // ── Datos del cliente y de la proforma ─────────────────────────
  const cliente = d.cliente ?? {};
  const documento = textoPlano(cliente.documento);
  const izquierda: Array<[string, string]> = [['Cliente', textoPlano(cliente.nombre) || '—']];
  if (documento) izquierda.push([etiquetaDocumento(documento), documento]);
  if (textoPlano(cliente.direccion)) izquierda.push(['Dirección', textoPlano(cliente.direccion)]);
  if (formatearTelefono(cliente.telefono)) izquierda.push(['Teléfono', formatearTelefono(cliente.telefono)]);
  if (textoPlano(cliente.email)) izquierda.push(['Correo', textoPlano(cliente.email)]);

  const derecha: Array<[string, string]> = [['Fecha de emisión', formatearFecha(d.fecha_emision) || '—']];
  const valida = formatearFecha(d.valida_hasta ?? null);
  if (valida) derecha.push(['Válida hasta', valida]);
  derecha.push(['Moneda', 'Soles (PEN)']);
  derecha.push(['Estado', estadoParaDocumento(d.estado, d.valida_hasta, generadoEn)]);
  if (textoPlano(d.almacen)) derecha.push(['Almacén', textoPlano(d.almacen)]);

  r = siguiente(18);
  combinar('A', 'C', r);
  combinar('D', 'H', r);
  for (const [celda, titulo] of [['A', 'DATOS DEL CLIENTE'], ['D', 'DATOS DE LA PROFORMA']]) {
    Object.assign(ws.getCell(`${celda}${r}`), {
      value: titulo,
      font: { name: FUENTE, bold: true, size: 9, color: { argb: ARGB.marca } },
      fill: relleno(ARGB.marcaSuave),
      alignment: { vertical: 'middle', indent: 1 },
      border: bordeCompleto,
    });
  }

  const filasDatos = Math.max(izquierda.length, derecha.length);
  for (let i = 0; i < filasDatos; i++) {
    const [etqIzq, valIzq] = izquierda[i] ?? ['', ''];
    const [etqDer, valDer] = derecha[i] ?? ['', ''];
    r = siguiente(altoPorTexto([{ texto: valIzq, ancho: ANCHOS[2] }, { texto: valDer, ancho: ANCHOS[5] }], 17));
    combinar('A', 'B', r);
    combinar('D', 'E', r);
    const celdas: Array<[string, string, boolean]> = [
      ['A', etqIzq ? `${etqIzq}:` : '', true],
      ['C', valIzq, false],
      ['D', etqDer ? `${etqDer}:` : '', true],
      ['F', valDer, false],
    ];
    for (const [col, valor, esEtiqueta] of celdas) {
      Object.assign(ws.getCell(`${col}${r}`), {
        value: valor,
        font: esEtiqueta
          ? { name: FUENTE, bold: true, size: 9, color: { argb: ARGB.gris } }
          : { name: FUENTE, size: 10, color: { argb: ARGB.texto } },
        fill: relleno(ARGB.fondo),
        alignment: { vertical: 'top', wrapText: !esEtiqueta, indent: esEtiqueta ? 1 : 0 },
        border: bordeCompleto,
      });
    }
  }
  siguiente(10);

  // ── Tabla de ítems ─────────────────────────────────────────────
  const filaCabecera = siguiente(22);
  const titulos = ['N°', 'Código', 'Unidad', 'P. Unit.', 'Cant.', 'Dto.', 'Descripción', 'Importe'];
  titulos.forEach((titulo, i) => {
    Object.assign(ws.getRow(filaCabecera).getCell(i + 1), {
      value: titulo,
      font: { name: FUENTE, bold: true, size: 10, color: { argb: ARGB.blanco } },
      fill: relleno(ARGB.marca),
      alignment: { vertical: 'middle', horizontal: i === 6 || i === 1 ? 'left' : 'center', indent: i === 6 || i === 1 ? 1 : 0 },
      border: bordeCompleto,
    });
  });

  const primeraFilaItem = fila + 1;
  let sumaImportes = 0;
  items.forEach((item, indice) => {
    const descripcion = textoPlano(item.descripcion) || 'Producto';
    const sku = textoPlano(item.sku);
    const cantidad = numeroSeguro(item.cantidad);
    const precio = numeroSeguro(item.precio_unitario);
    const importe = numeroSeguro(item.importe);
    sumaImportes += importe;

    r = siguiente(altoPorTexto([{ texto: descripcion, ancho: ANCHOS[6] }, { texto: sku, ancho: ANCHOS[1] }]));
    const fondo = indice % 2 === 1 ? relleno(ARGB.cebra) : undefined;
    // El importe queda como fórmula solo si coincide con cantidad × precio.
    const cuadra = Math.abs(cantidad * precio - importe) < 0.005;
    const valores: ExcelJS.CellValue[] = [
      indice + 1,
      sku || '—',
      textoPlano(item.unidad_medida) || 'NIU',
      precio,
      cantidad,
      numeroSeguro(item.descuento),
      descripcion,
      cuadra ? { formula: `D${r}*E${r}`, result: importe } : importe,
    ];
    valores.forEach((valor, i) => {
      const celda = ws.getRow(r).getCell(i + 1);
      celda.value = valor;
      celda.font = { name: FUENTE, size: 10, bold: i === 5, color: { argb: i === 1 ? ARGB.gris : ARGB.texto } };
      celda.border = bordeCompleto;
      if (fondo) celda.fill = fondo;
      celda.alignment = {
        vertical: 'top',
        horizontal: i === 0 ? 'center' : i === 3 || i === 4 || i === 5 || i === 7 ? 'right' : 'left',
        wrapText: i === 1 || i === 6,
      };
      if (i === 4) celda.numFmt = Number.isInteger(cantidad) ? FORMATO_ENTERO : '#,##0.00';
      if (i === 3 || i === 5 || i === 7) celda.numFmt = FORMATO_SOLES;
    });
  });
  const ultimaFilaItem = fila;

  if (!items.length) {
    r = siguiente(18);
    combinar('A', 'H', r);
    Object.assign(ws.getCell(`A${r}`), {
      value: 'La proforma no tiene productos.',
      font: { name: FUENTE, italic: true, size: 10, color: { argb: ARGB.grisClaro } },
      border: bordeCompleto,
    });
  }
  siguiente(8);

  // ── Totales ────────────────────────────────────────────────────
  const unidades = items.reduce((s, i) => s + numeroSeguro(i.cantidad), 0);
  const total = numeroSeguro(d.total);
  const totalCuadra = items.length > 0 && Math.abs(sumaImportes - total) < 0.005;
  const filasTotales: Array<[string, ExcelJS.CellValue, boolean]> = [
    ['Op. gravada', numeroSeguro(d.total_gravada), false],
    [`IGV (${formatearPorcentaje(d.porcentaje_igv)})`, numeroSeguro(d.total_igv), false],
    [
      'TOTAL',
      totalCuadra
        ? { formula: `SUM(H${primeraFilaItem}:H${ultimaFilaItem})`, result: total }
        : total,
      true,
    ],
  ];
  const filaResumen = fila + 1;
  filasTotales.forEach(([etiqueta, valor, esTotal]) => {
    r = siguiente(esTotal ? 24 : 18);
    const celdaEtiqueta = ws.getCell(`G${r}`);
    const celdaValor = ws.getCell(`H${r}`);
    celdaEtiqueta.value = etiqueta;
    celdaValor.value = valor;
    celdaValor.numFmt = FORMATO_SOLES;
    celdaEtiqueta.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    celdaValor.alignment = { horizontal: 'right', vertical: 'middle' };
    celdaEtiqueta.border = bordeCompleto;
    celdaValor.border = bordeCompleto;
    if (esTotal) {
      celdaEtiqueta.font = { name: FUENTE, bold: true, size: 12, color: { argb: ARGB.blanco } };
      celdaValor.font = { name: FUENTE, bold: true, size: 13, color: { argb: ARGB.blanco } };
      celdaEtiqueta.fill = relleno(ARGB.marca);
      celdaValor.fill = relleno(ARGB.marca);
    } else {
      celdaEtiqueta.font = { name: FUENTE, size: 10, color: { argb: ARGB.gris } };
      celdaValor.font = { name: FUENTE, size: 10, color: { argb: ARGB.texto } };
    }
  });
  combinar('A', 'C', filaResumen);
  Object.assign(ws.getCell(`A${filaResumen}`), {
    value: `Ítems: ${items.length}   ·   Unidades: ${formatearCantidad(unidades)}   ·   Precios con IGV incluido`,
    font: { name: FUENTE, size: 9, color: { argb: ARGB.gris } },
    alignment: { vertical: 'middle' },
  });

  siguiente(6);
  const son = `SON: ${montoEnLetras(total)}`;
  r = siguiente(altoPorTexto([{ texto: son, ancho: 110 }], 20));
  combinar('A', 'H', r);
  Object.assign(ws.getCell(`A${r}`), {
    value: son,
    font: { name: FUENTE, bold: true, size: 10, color: { argb: ARGB.texto } },
    fill: relleno(ARGB.marcaSuave),
    alignment: { vertical: 'middle', wrapText: true, indent: 1 },
    border: bordeCompleto,
  });

  const titulo = (texto: string) => {
    siguiente(8);
    const t = siguiente(18);
    combinar('A', 'H', t);
    Object.assign(ws.getCell(`A${t}`), {
      value: texto.toUpperCase(),
      font: { name: FUENTE, bold: true, size: 10, color: { argb: ARGB.marca } },
      border: { bottom: { style: 'thin', color: { argb: ARGB.marca } } },
    });
  };
  const parrafo = (texto: string, opciones: Partial<ExcelJS.Font> = {}, sangria = 0) => {
    const p = siguiente(altoPorTexto([{ texto, ancho: 108 }], 16));
    combinar('A', 'H', p);
    Object.assign(ws.getCell(`A${p}`), {
      value: texto,
      font: { name: FUENTE, size: 10, color: { argb: ARGB.texto }, ...opciones },
      alignment: { vertical: 'top', wrapText: true, indent: sangria },
    });
  };

  // ── Observaciones ──────────────────────────────────────────────
  const observaciones = textoMultilinea(d.observaciones);
  if (observaciones.length) {
    titulo('Observaciones');
    observaciones.forEach((linea) => parrafo(linea));
  }

  // ── Cuentas bancarias y condiciones comerciales ───────────────
  const cuentas = cuentasUtiles(d.cuentas);
  if (cuentas.length) {
    siguiente(8);
    const filaCuentas = siguiente(22 + cuentas.length * 16);
    combinar('A', 'H', filaCuentas);
    const celdaCuentas = ws.getCell(`A${filaCuentas}`);
    celdaCuentas.value = `CUENTAS PARA DEPÓSITO O TRANSFERENCIA\n${cuentas
      .map((cuenta) => `• ${describirCuenta(cuenta)}`)
      .join('\n')}`;
    celdaCuentas.font = { name: FUENTE, size: 9, color: { argb: ARGB.blanco } };
    celdaCuentas.fill = relleno(ARGB.marca);
    celdaCuentas.alignment = { vertical: 'middle', wrapText: true, indent: 1 };
    celdaCuentas.border = bordeCompleto;
  }

  titulo('Condiciones comerciales');
  condicionesComerciales(d).forEach((c) => parrafo(`•  ${c}`));

  siguiente(10);
  parrafo(LEYENDA_SIN_VALOR_TRIBUTARIO, { italic: true, size: 9, color: { argb: ARGB.gris } });
  const generado = formatearFechaHora(generadoEn);
  if (generado) {
    parrafo(`Generado: ${generado} (hora de Lima)`, { size: 8, color: { argb: ARGB.grisClaro } });
  }

  // ── Vista e impresión ──────────────────────────────────────────
  ws.views = [
    {
      state: 'frozen',
      xSplit: 0,
      ySplit: filaCabecera,
      topLeftCell: `A${filaCabecera + 1}`,
      activeCell: `A${filaCabecera + 1}`,
      showGridLines: false,
    },
  ];
  ws.pageSetup = {
    paperSize: 9, // A4
    orientation: 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.25, footer: 0.3 },
    printArea: `A1:H${fila}`,
    printTitlesRow: `${filaCabecera}:${filaCabecera}`,
  };
  ws.headerFooter = {
    oddFooter: `&L&8${textoPie(`${razonSocial} · Proforma ${codigo}`)}&R&8Página &P de &N`,
    evenFooter: `&L&8${textoPie(`${razonSocial} · Proforma ${codigo}`)}&R&8Página &P de &N`,
  };

  const contenido = await wb.xlsx.writeBuffer();
  return Buffer.from(contenido as ArrayBuffer);
}
