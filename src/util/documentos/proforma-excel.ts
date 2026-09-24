import * as ExcelJS from 'exceljs';
import { montoEnLetras } from '../fiscal/numero-letras';
import {
  argb,
  avisoEstadoCliente,
  condicionesComerciales,
  contactoEmisor,
  cuentasUtiles,
  DatosProformaDocumento,
  describirCuentaTabla,
  etiquetaDocumento,
  formatearCantidad,
  formatearFecha,
  formatearFechaHora,
  formatearPorcentaje,
  formatearTelefono,
  hayDescuentos,
  LEYENDA_SIN_VALOR_TRIBUTARIO,
  numeroSeguro,
  PALETA,
  precioLista,
  textoMultilinea,
  textoPlano,
} from './proforma-documento';

/**
 * Proforma en Excel (.xlsx) con exceljs: una hoja "Proforma" lista para
 * imprimir en A4 vertical, con la misma información y la misma imagen de marca
 * que el PDF.
 *
 * La hoja usa una grilla fija de 9 columnas (A–I). Las dos columnas de
 * descuento (F, G) se ocultan cuando ninguna línea tiene descuento; todos los
 * bloques están armados con celdas combinadas que las atraviesan, así el
 * diseño se ve igual con o sin ellas.
 */

const ARGB = {
  marca: argb(PALETA.grafito),
  acento: argb(PALETA.naranja),
  acentoSuave: argb(PALETA.naranjaSuave),
  texto: argb(PALETA.texto),
  gris: argb(PALETA.gris),
  grisClaro: argb(PALETA.grisClaro),
  linea: argb(PALETA.linea),
  fondo: argb(PALETA.fondo),
  cebra: argb(PALETA.cebra),
  blanco: argb(PALETA.blanco),
  peligro: argb(PALETA.peligro),
  aviso: argb(PALETA.aviso),
};

const FORMATO_SOLES = '"S/ "#,##0.00';
const FORMATO_IMPORTE = '#,##0.00';
const FORMATO_ENTERO = '#,##0';
const FUENTE = 'Calibri';

/** Ancho (en caracteres) de A–I: N°, Código, Descripción, Und., Cant., P. Lista, Dto., P. Unit., Importe. */
const ANCHOS = [5, 14, 38, 7, 8, 11, 9, 12, 14];
const COL = { n: 1, codigo: 2, descripcion: 3, unidad: 4, cantidad: 5, lista: 6, descuento: 7, precio: 8, importe: 9 };
const ULTIMA = 'I';

const bordeFino: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: ARGB.linea } };
const bordeCompleto: Partial<ExcelJS.Borders> = {
  top: bordeFino,
  left: bordeFino,
  bottom: bordeFino,
  right: bordeFino,
};

function relleno(color: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
}

/**
 * Alto aproximado de una fila según cuántas líneas ocupa el texto más largo.
 * Excel no ajusta solo el alto de las celdas combinadas, así que se calcula.
 */
function altoPorTexto(textos: Array<{ texto: string; ancho: number }>, minimo = 18): number {
  const lineas = Math.max(
    1,
    ...textos.map(({ texto, ancho }) => {
      const util = Math.max(4, Math.floor(ancho * 1.05));
      return String(texto || '')
        .split('\n')
        .reduce((suma, parte) => suma + (Math.ceil(parte.length / util) || 1), 0);
    }),
  );
  return Math.max(minimo, lineas * 13.5 + 4);
}

/** En encabezados/pies de Excel el "&" es un código de control. */
function textoPie(texto: string): string {
  return texto.replace(/&/g, '&&');
}

function extensionImagen(datos?: Buffer | null): 'png' | 'jpeg' {
  if (datos && datos.length > 3 && datos[0] === 0xff && datos[1] === 0xd8 && datos[2] === 0xff) {
    return 'jpeg';
  }
  return 'png';
}

export async function generarProformaExcel(d: DatosProformaDocumento): Promise<Buffer> {
  const razonSocial = textoPlano(d.emisor?.razon_social) || 'HATUNSALES S.A.C.';
  const ruc = textoPlano(d.emisor?.ruc);
  const codigo = textoPlano(d.codigo) || '—';
  const generadoEn = d.generado_en ?? new Date();
  const items = d.items ?? [];
  const conDescuento = hayDescuentos(items);
  const aviso = avisoEstadoCliente(d.estado, d.valida_hasta, generadoEn);

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
    properties: { defaultRowHeight: 16, tabColor: { argb: ARGB.acento } },
    views: [{ showGridLines: false }],
  });
  ws.columns = ANCHOS.map((width) => ({ width }));
  if (!conDescuento) {
    ws.getColumn(COL.lista).hidden = true;
    ws.getColumn(COL.descuento).hidden = true;
  }

  /** Ancho visible total (para estimar el alto de los textos a todo el ancho). */
  const anchoVisible = ANCHOS.reduce(
    (suma, ancho, i) => suma + (!conDescuento && (i + 1 === COL.lista || i + 1 === COL.descuento) ? 0 : ancho),
    0,
  );

  let fila = 0;
  const siguiente = (alto?: number) => {
    fila += 1;
    if (alto) ws.getRow(fila).height = alto;
    return fila;
  };
  const combinar = (desde: string, hasta: string, r: number) => ws.mergeCells(`${desde}${r}:${hasta}${r}`);
  const poner = (ref: string, valor: ExcelJS.CellValue, estilo: Partial<ExcelJS.Style> = {}) => {
    const celda = ws.getCell(ref);
    celda.value = valor;
    Object.assign(celda, estilo);
    return celda;
  };
  const fuente = (opciones: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({
    name: FUENTE,
    size: 10,
    color: { argb: ARGB.texto },
    ...opciones,
  });

  // ── Cabecera: logo + datos del emisor + recuadro R.U.C. / PROFORMA ─────
  const r1 = siguiente(24);
  const r2 = siguiente(22);
  const r3 = siguiente(26);
  const r4 = siguiente(14);

  for (const r of [r1, r2, r3, r4]) combinar('C', 'G', r);
  // Zona del logo: A1:B4 como un solo bloque.
  ws.mergeCells(`A${r1}:B${r4}`);

  poner(`C${r1}`, razonSocial, {
    font: fuente({ bold: true, size: 16, color: { argb: ARGB.marca } }),
    alignment: { vertical: 'middle', horizontal: 'left' },
  });
  const direccion = [textoPlano(d.emisor?.direccion), textoPlano(d.emisor?.ubicacion)]
    .filter(Boolean)
    .join(' — ');
  const contacto = contactoEmisor(d.emisor);
  poner(`C${r2}`, direccion, {
    font: fuente({ size: 9, color: { argb: ARGB.gris } }),
    alignment: { vertical: 'middle', wrapText: true },
  });
  poner(`C${r3}`, contacto.join('   ·   '), {
    font: fuente({ size: 9, color: { argb: ARGB.gris } }),
    alignment: { vertical: 'top', wrapText: true },
  });

  if (d.emisor?.logo) {
    try {
      const imagenId = wb.addImage({
        base64: d.emisor.logo.toString('base64'),
        extension: extensionImagen(d.emisor.logo),
      });
      // El logo es apaisado (3:2): se dibuja con esa proporción para no deformarlo.
      ws.addImage(imagenId, { tl: { col: 0.1, row: 0.1 }, ext: { width: 120, height: 80 } });
    } catch {
      // El documento sigue siendo válido si ExcelJS no acepta la imagen.
    }
  }

  // Recuadro de la derecha (H:I).
  for (const r of [r1, r2, r3, r4]) combinar('H', ULTIMA, r);
  const bordeCaja = { style: 'medium' as const, color: { argb: ARGB.marca } };
  poner(`H${r1}`, ruc ? `R.U.C. ${ruc}` : '', {
    font: fuente({ bold: true, size: 11 }),
    alignment: { vertical: 'middle', horizontal: 'center' },
    border: { top: bordeCaja, left: bordeCaja, right: bordeCaja },
  });
  poner(`H${r2}`, 'PROFORMA', {
    font: fuente({ bold: true, size: 13, color: { argb: ARGB.blanco } }),
    fill: relleno(ARGB.marca),
    alignment: { vertical: 'middle', horizontal: 'center' },
    border: { left: bordeCaja, right: bordeCaja },
  });
  poner(`H${r3}`, codigo, {
    font: fuente({ bold: true, size: 15, color: { argb: ARGB.marca } }),
    alignment: { vertical: 'middle', horizontal: 'center' },
    border: { top: { style: 'medium', color: { argb: ARGB.acento } }, left: bordeCaja, right: bordeCaja },
  });
  poner(`H${r4}`, '', { border: { left: bordeCaja, right: bordeCaja, bottom: bordeCaja } });

  // Regla de marca: línea naranja bajo la cabecera.
  siguiente(6);
  for (let c = 1; c <= 9; c++) {
    ws.getRow(fila).getCell(c).border = { bottom: { style: 'medium', color: { argb: ARGB.acento } } };
  }
  siguiente(8);

  // ── Datos del cliente (izquierda) y de la proforma (derecha) ──────────
  const cliente = d.cliente ?? {};
  const documento = textoPlano(cliente.documento);
  const izquierda: Array<[string, string]> = [['Cliente', textoPlano(cliente.nombre) || '—']];
  if (documento) izquierda.push([etiquetaDocumento(documento), documento]);
  if (textoPlano(cliente.direccion)) izquierda.push(['Dirección', textoPlano(cliente.direccion)]);
  if (formatearTelefono(cliente.telefono)) izquierda.push(['Teléfono', formatearTelefono(cliente.telefono)]);
  if (textoPlano(cliente.email)) izquierda.push(['Correo', textoPlano(cliente.email)]);

  const derecha: Array<[string, string]> = [['Emisión', formatearFecha(d.fecha_emision) || '—']];
  const valida = formatearFecha(d.valida_hasta ?? null);
  if (valida) derecha.push(['Válida hasta', valida]);
  derecha.push(['Moneda', 'Soles (PEN)']);
  if (textoPlano(d.almacen)) derecha.push(['Despacho desde', textoPlano(d.almacen)]);
  if (aviso) derecha.push(['Estado', aviso.texto]);

  const anchoValorIzq = ANCHOS[COL.descripcion - 1];
  const anchoValorDer = conDescuento
    ? ANCHOS[COL.lista - 1] + ANCHOS[COL.descuento - 1] + ANCHOS[COL.precio - 1] + ANCHOS[COL.importe - 1]
    : ANCHOS[COL.precio - 1] + ANCHOS[COL.importe - 1];

  const rTitulo = siguiente(19);
  combinar('A', 'C', rTitulo);
  combinar('D', ULTIMA, rTitulo);
  for (const [celda, titulo] of [['A', 'DATOS DEL CLIENTE'], ['D', 'DATOS DE LA PROFORMA']]) {
    poner(`${celda}${rTitulo}`, titulo, {
      font: fuente({ bold: true, size: 9, color: { argb: ARGB.marca } }),
      fill: relleno(ARGB.acentoSuave),
      alignment: { vertical: 'middle', indent: 1 },
      border: { ...bordeCompleto, left: { style: 'medium', color: { argb: ARGB.acento } } },
    });
  }
  ws.getRow(rTitulo).getCell(3).border = bordeCompleto;
  ws.getRow(rTitulo).getCell(3).fill = relleno(ARGB.acentoSuave);
  for (let c = 5; c <= 9; c++) {
    ws.getRow(rTitulo).getCell(c).border = bordeCompleto;
    ws.getRow(rTitulo).getCell(c).fill = relleno(ARGB.acentoSuave);
  }

  const filasDatos = Math.max(izquierda.length, derecha.length);
  for (let i = 0; i < filasDatos; i++) {
    const [etqIzq, valIzq] = izquierda[i] ?? ['', ''];
    const [etqDer, valDer] = derecha[i] ?? ['', ''];
    const r = siguiente(
      altoPorTexto(
        [
          { texto: valIzq, ancho: anchoValorIzq },
          { texto: valDer, ancho: anchoValorDer },
        ],
        18,
      ),
    );
    combinar('A', 'B', r);
    combinar('D', 'E', r);
    combinar('F', ULTIMA, r);
    const esAviso = etqDer === 'Estado' && aviso;
    const celdas: Array<[string, string, boolean, boolean]> = [
      ['A', etqIzq ? `${etqIzq}:` : '', true, false],
      ['C', valIzq, false, false],
      ['D', etqDer ? `${etqDer}:` : '', true, false],
      ['F', valDer, false, !!esAviso],
    ];
    for (const [col, valor, esEtiqueta, resaltar] of celdas) {
      poner(`${col}${r}`, valor, {
        font: esEtiqueta
          ? fuente({ bold: true, size: 9, color: { argb: ARGB.gris } })
          : fuente({
              bold: resaltar,
              color: { argb: resaltar ? (aviso!.tono === 'peligro' ? ARGB.peligro : ARGB.aviso) : ARGB.texto },
            }),
        alignment: { vertical: 'middle', wrapText: !esEtiqueta, indent: esEtiqueta ? 1 : 0 },
      });
    }
    for (let c = 1; c <= 9; c++) {
      const celda = ws.getRow(r).getCell(c);
      celda.fill = relleno(ARGB.fondo);
      celda.border = bordeCompleto;
    }
  }
  siguiente(10);

  // ── Tabla de ítems ─────────────────────────────────────────────
  const filaCabecera = siguiente(22);
  const titulos = ['N°', 'Código', 'Descripción', 'Und.', 'Cant.', 'P. Lista', 'Dto.', 'P. Unit.', 'Importe'];
  titulos.forEach((titulo, i) => {
    const izq = i === 1 || i === 2;
    poner(`${String.fromCharCode(65 + i)}${filaCabecera}`, titulo, {
      font: fuente({ bold: true, color: { argb: ARGB.blanco } }),
      fill: relleno(ARGB.marca),
      alignment: {
        vertical: 'middle',
        horizontal: izq ? 'left' : i >= 4 ? 'right' : 'center',
        indent: izq || i >= 4 ? 1 : 0,
      },
      border: { ...bordeCompleto, bottom: { style: 'medium', color: { argb: ARGB.acento } } },
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
    const descuento = numeroSeguro(item.descuento);
    sumaImportes += importe;

    const r = siguiente(
      altoPorTexto([
        { texto: descripcion, ancho: ANCHOS[COL.descripcion - 1] },
        { texto: sku, ancho: ANCHOS[COL.codigo - 1] },
      ]),
    );
    const fondo = indice % 2 === 1 ? relleno(ARGB.cebra) : undefined;
    // El importe queda como fórmula solo si coincide con cantidad × precio.
    const cuadra = Math.abs(cantidad * precio - importe) < 0.005;
    const valores: ExcelJS.CellValue[] = [
      indice + 1,
      sku || '—',
      descripcion,
      textoPlano(item.unidad_medida) || 'NIU',
      cantidad,
      precioLista(item),
      descuento >= 0.005 ? descuento : '—',
      precio,
      cuadra ? { formula: `E${r}*H${r}`, result: importe } : importe,
    ];
    valores.forEach((valor, i) => {
      const celda = ws.getRow(r).getCell(i + 1);
      celda.value = valor;
      celda.font = fuente({
        bold: i === 8,
        size: i === 1 ? 9 : 10,
        color: { argb: i === 1 ? ARGB.gris : i === 6 && descuento >= 0.005 ? ARGB.aviso : ARGB.texto },
      });
      celda.border = bordeCompleto;
      if (fondo) celda.fill = fondo;
      celda.alignment = {
        vertical: 'middle',
        horizontal: i === 0 || i === 3 ? 'center' : i >= 4 ? 'right' : 'left',
        wrapText: i === 1 || i === 2,
        indent: i >= 4 || i === 1 || i === 2 ? 1 : 0,
      };
      if (i === 4) celda.numFmt = Number.isInteger(cantidad) ? FORMATO_ENTERO : '#,##0.00';
      if (i === 5 || i === 6 || i === 7 || i === 8) celda.numFmt = FORMATO_IMPORTE;
    });
  });
  const ultimaFilaItem = fila;

  if (!items.length) {
    const r = siguiente(18);
    combinar('A', ULTIMA, r);
    poner(`A${r}`, 'La proforma no tiene productos.', {
      font: fuente({ italic: true, color: { argb: ARGB.grisClaro } }),
      border: bordeCompleto,
    });
  }
  siguiente(8);

  // ── Totales ────────────────────────────────────────────────────
  const unidades = items.reduce((s, i) => s + numeroSeguro(i.cantidad), 0);
  const ahorro = items.reduce((s, i) => s + numeroSeguro(i.descuento) * numeroSeguro(i.cantidad), 0);
  const total = numeroSeguro(d.total);
  const totalCuadra = items.length > 0 && Math.abs(sumaImportes - total) < 0.005;
  const filasTotales: Array<[string, ExcelJS.CellValue, boolean]> = [
    ['Op. gravada', numeroSeguro(d.total_gravada), false],
    [`IGV (${formatearPorcentaje(d.porcentaje_igv)})`, numeroSeguro(d.total_igv), false],
    [
      'TOTAL',
      totalCuadra && items.length
        ? { formula: `SUM(I${primeraFilaItem}:I${ultimaFilaItem})`, result: total }
        : total,
      true,
    ],
  ];
  const filaResumen = fila + 1;
  filasTotales.forEach(([etiqueta, valor, esTotal]) => {
    const r = siguiente(esTotal ? 25 : 18);
    combinar('E', 'H', r);
    const celdaEtiqueta = ws.getCell(`E${r}`);
    const celdaValor = ws.getCell(`I${r}`);
    celdaEtiqueta.value = etiqueta;
    celdaValor.value = valor;
    celdaValor.numFmt = FORMATO_SOLES;
    celdaEtiqueta.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    celdaValor.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    for (let c = 5; c <= 9; c++) ws.getRow(r).getCell(c).border = bordeCompleto;
    if (esTotal) {
      celdaEtiqueta.font = fuente({ bold: true, size: 12, color: { argb: ARGB.blanco } });
      celdaValor.font = fuente({ bold: true, size: 13, color: { argb: ARGB.blanco } });
      for (let c = 5; c <= 9; c++) ws.getRow(r).getCell(c).fill = relleno(ARGB.marca);
      ws.getRow(r).getCell(5).border = { ...bordeCompleto, left: { style: 'thick', color: { argb: ARGB.acento } } };
    } else {
      celdaEtiqueta.font = fuente({ color: { argb: ARGB.gris } });
      celdaValor.font = fuente();
    }
  });
  combinar('A', 'D', filaResumen);
  poner(
    `A${filaResumen}`,
    `Ítems: ${items.length}   ·   Unidades: ${formatearCantidad(unidades)}`,
    { font: fuente({ size: 9, color: { argb: ARGB.gris } }), alignment: { vertical: 'middle' } },
  );
  combinar('A', 'D', filaResumen + 1);
  poner(`A${filaResumen + 1}`, 'Importes en Soles (S/), IGV incluido.', {
    font: fuente({ size: 9, color: { argb: ARGB.gris } }),
    alignment: { vertical: 'middle' },
  });
  if (ahorro >= 0.005) {
    combinar('A', 'D', filaResumen + 2);
    poner(
      `A${filaResumen + 2}`,
      `Descuento aplicado en esta proforma: S/ ${ahorro.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`,
      {
        font: fuente({ bold: true, size: 9, color: { argb: ARGB.aviso } }),
        alignment: { vertical: 'middle' },
      },
    );
  }

  siguiente(6);
  const son = `SON: ${montoEnLetras(total)}`;
  const rSon = siguiente(altoPorTexto([{ texto: son, ancho: anchoVisible }], 21));
  combinar('A', ULTIMA, rSon);
  poner(`A${rSon}`, son, {
    font: fuente({ bold: true }),
    alignment: { vertical: 'middle', wrapText: true, indent: 1 },
  });
  for (let c = 1; c <= 9; c++) {
    const celda = ws.getRow(rSon).getCell(c);
    celda.fill = relleno(ARGB.acentoSuave);
    celda.border = bordeCompleto;
  }
  ws.getRow(rSon).getCell(1).border = { ...bordeCompleto, left: { style: 'thick', color: { argb: ARGB.acento } } };

  const titulo = (texto: string) => {
    siguiente(8);
    const t = siguiente(19);
    combinar('A', ULTIMA, t);
    poner(`A${t}`, texto.toUpperCase(), {
      font: fuente({ bold: true, color: { argb: ARGB.marca } }),
      alignment: { vertical: 'middle', indent: 1 },
      border: {
        left: { style: 'thick', color: { argb: ARGB.acento } },
        bottom: { style: 'thin', color: { argb: ARGB.linea } },
      },
    });
    for (let c = 2; c <= 9; c++) {
      ws.getRow(t).getCell(c).border = { bottom: { style: 'thin', color: { argb: ARGB.linea } } };
    }
  };
  const parrafo = (texto: string, opciones: Partial<ExcelJS.Font> = {}, sangria = 0) => {
    const p = siguiente(altoPorTexto([{ texto, ancho: anchoVisible - 2 }], 16));
    combinar('A', ULTIMA, p);
    poner(`A${p}`, texto, {
      font: fuente(opciones),
      alignment: { vertical: 'top', wrapText: true, indent: sangria },
    });
  };

  // ── Cuentas bancarias (tabla) ──────────────────────────────────
  const cuentas = cuentasUtiles(d.cuentas).map(describirCuentaTabla);
  if (cuentas.length) {
    siguiente(10);
    const rTituloCuentas = siguiente(20);
    combinar('A', ULTIMA, rTituloCuentas);
    poner(`A${rTituloCuentas}`, 'CUENTAS PARA DEPÓSITO O TRANSFERENCIA', {
      font: fuente({ bold: true, color: { argb: ARGB.blanco } }),
      fill: relleno(ARGB.marca),
      alignment: { vertical: 'middle', indent: 1 },
      border: { ...bordeCompleto, left: { style: 'thick', color: { argb: ARGB.acento } } },
    });

    const rEnc = siguiente(17);
    combinar('A', 'B', rEnc);
    combinar('D', ULTIMA, rEnc);
    const hayCci = cuentas.some((c) => c.cci);
    for (const [ref, texto] of [
      [`A${rEnc}`, 'BANCO / ENTIDAD'],
      [`C${rEnc}`, hayCci ? 'N° DE CUENTA' : 'N° DE CUENTA / CELULAR'],
      [`D${rEnc}`, hayCci ? 'CCI (INTERBANCARIO)' : ''],
    ]) {
      poner(ref, texto, {
        font: fuente({ bold: true, size: 8, color: { argb: ARGB.gris } }),
        alignment: { vertical: 'middle', indent: 1 },
      });
    }
    for (let c = 1; c <= 9; c++) {
      const celda = ws.getRow(rEnc).getCell(c);
      celda.fill = relleno(ARGB.fondo);
      celda.border = bordeCompleto;
    }

    cuentas.forEach((c) => {
      const r = siguiente(c.detalle ? 33 : 21);
      combinar('A', 'B', r);
      combinar('D', ULTIMA, r);
      // El número va en negrita y, debajo, el tipo de cuenta / titular en gris.
      const cuenta: ExcelJS.CellRichTextValue = {
        richText: [
          { text: c.numero || '—', font: { name: FUENTE, bold: true, size: 10, color: { argb: ARGB.texto } } },
          ...(c.detalle
            ? [{ text: `\n${c.detalle}`, font: { name: FUENTE, size: 8, color: { argb: ARGB.gris } } }]
            : []),
        ],
      };
      poner(`A${r}`, c.banco, {
        font: fuente({ bold: true }),
        alignment: { vertical: 'middle', wrapText: true, indent: 1 },
      });
      poner(`C${r}`, cuenta, { alignment: { vertical: 'middle', wrapText: true, horizontal: 'left', indent: 1 } });
      poner(`D${r}`, c.cci || '—', {
        font: fuente(),
        alignment: { vertical: 'middle', horizontal: 'left', indent: 1 },
      });
      for (let col = 1; col <= 9; col++) ws.getRow(r).getCell(col).border = bordeCompleto;
    });
  }

  // ── Observaciones y condiciones ────────────────────────────────
  const observaciones = textoMultilinea(d.observaciones);
  if (observaciones.length) {
    titulo('Observaciones');
    observaciones.forEach((linea) => {
      if (linea) parrafo(linea);
    });
  }

  titulo('Condiciones comerciales');
  condicionesComerciales(d).forEach((c) => parrafo(`•  ${c}`));

  // ── Cierre comercial ───────────────────────────────────────────
  if (contacto.length) {
    siguiente(8);
    const rContacto = siguiente(24);
    combinar('A', ULTIMA, rContacto);
    poner(`A${rContacto}`, `Para confirmar su pedido:   ${contacto.join('   ·   ')}`, {
      font: fuente({ bold: true, color: { argb: ARGB.marca } }),
      alignment: { vertical: 'middle', wrapText: true, indent: 1 },
    });
    for (let c = 1; c <= 9; c++) {
      const celda = ws.getRow(rContacto).getCell(c);
      celda.fill = relleno(ARGB.acentoSuave);
      celda.border = bordeCompleto;
    }
    ws.getRow(rContacto).getCell(1).border = {
      ...bordeCompleto,
      left: { style: 'thick', color: { argb: ARGB.acento } },
    };
  }
  siguiente(6);
  const rGracias = siguiente(16);
  combinar('A', ULTIMA, rGracias);
  poner(`A${rGracias}`, 'Gracias por su preferencia.', {
    font: fuente({ italic: true, color: { argb: ARGB.gris } }),
    alignment: { horizontal: 'center' },
  });

  siguiente(8);
  parrafo(LEYENDA_SIN_VALOR_TRIBUTARIO, { italic: true, size: 9, color: { argb: ARGB.gris } });
  const generado = formatearFechaHora(generadoEn);
  if (generado) {
    parrafo(`Generado: ${generado} (hora de Lima)`, { size: 8, color: { argb: ARGB.grisClaro } });
  }

  // ── Vista e impresión ──────────────────────────────────────────
  ws.views = [{ showGridLines: false, zoomScale: 100 }];
  ws.pageSetup = {
    paperSize: 9, // A4
    orientation: 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.25, footer: 0.3 },
    printArea: `A1:${ULTIMA}${fila}`,
    printTitlesRow: `${filaCabecera}:${filaCabecera}`,
  };
  ws.headerFooter = {
    oddFooter: `&L&8${textoPie(`${razonSocial} · Proforma ${codigo}`)}&R&8Página &P de &N`,
    evenFooter: `&L&8${textoPie(`${razonSocial} · Proforma ${codigo}`)}&R&8Página &P de &N`,
  };

  const contenido = await wb.xlsx.writeBuffer();
  return Buffer.from(contenido as ArrayBuffer);
}
