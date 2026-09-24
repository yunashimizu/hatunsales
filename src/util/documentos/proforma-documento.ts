/**
 * Modelo de datos y formatos compartidos por los documentos de la proforma
 * (PDF y Excel). Los generadores reciben todo ya resuelto: no consultan la base
 * de datos ni la red, así se pueden probar con datos de ejemplo.
 */

import { redondear } from '../fiscal/calculo-fiscal';

export const ZONA_HORARIA_PERU = 'America/Lima';

/**
 * Colores de marca (tomados del logo: grafito y naranja). PDF y Excel usan la
 * misma paleta para que los dos documentos se vean como de la misma empresa.
 * El naranja se usa solo como acento (líneas, detalles): sobre fondo blanco no
 * tiene contraste suficiente para texto.
 */
export const PALETA = {
  grafito: '#23272B',
  naranja: '#F28C1B',
  naranjaSuave: '#FDF1E3',
  texto: '#1F2933',
  gris: '#4B5563',
  grisClaro: '#8A94A0',
  linea: '#D9DDE2',
  fondo: '#F5F6F8',
  cebra: '#F8F9FA',
  blanco: '#FFFFFF',
  peligro: '#B42318',
  aviso: '#B54708',
} as const;

/** "#23272B" -> "FF23272B" (formato ARGB que usa exceljs). */
export function argb(hex: string): string {
  return `FF${hex.replace('#', '').toUpperCase()}`;
}

export interface EmisorDocumento {
  ruc: string;
  razon_social: string;
  direccion?: string | null;
  ubicacion?: string | null;
  telefono?: string | null;
  email?: string | null;
  web?: string | null;
  /** Imagen PNG o JPEG ya descargada. Si falta, el documento sale sin logo. */
  logo?: Buffer | null;
}

export interface ClienteDocumento {
  nombre?: string | null;
  /** Número de DNI o RUC. */
  documento?: string | null;
  direccion?: string | null;
  telefono?: string | null;
  email?: string | null;
}

export interface ItemDocumento {
  sku?: string | null;
  unidad_medida?: string | null;
  descripcion: string;
  cantidad: number;
  /** Precio unitario con IGV. */
  precio_unitario: number;
  /** Importe de la línea con IGV. */
  importe: number;
  descuento?: number;
}

export interface CuentaBancariaDocumento {
  banco: string;
  tipo?: string | null;
  numero?: string | null;
  cci?: string | null;
  titular?: string | null;
  moneda?: string | null;
  es_yape?: boolean;
}

export interface DatosProformaDocumento {
  emisor: EmisorDocumento;
  codigo: string;
  /** borrador | enviada | aprobada | convertida | anulada */
  estado: string;
  fecha_emision: Date | string | null;
  /** Fecha AAAA-MM-DD. */
  valida_hasta?: string | null;
  cliente: ClienteDocumento;
  almacen?: string | null;
  items: ItemDocumento[];
  total_gravada: number;
  total_igv: number;
  total: number;
  porcentaje_igv: number;
  observaciones?: string | null;
  cuentas?: CuentaBancariaDocumento[];
  /** Condiciones propias del negocio (configuración), una por línea. */
  condiciones_extra?: string[];
  /** Momento de generación; por defecto, ahora. */
  generado_en?: Date;
}

const ETIQUETAS_ESTADO: Record<string, string> = {
  borrador: 'Borrador',
  enviada: 'Enviada',
  aprobada: 'Aprobada',
  convertida: 'Convertida en venta',
  anulada: 'Anulada',
};

/** Valor numérico seguro (nunca NaN ni Infinity). */
export function numeroSeguro(valor: unknown): number {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

/** "S/ 1,234.50" (formato usado en Perú: coma para miles, punto decimal). */
export function formatearSoles(valor: unknown): string {
  return `S/ ${formatearDecimal(valor, 2)}`;
}

export function formatearDecimal(valor: unknown, decimales = 2): string {
  const n = numeroSeguro(valor);
  const signo = n < 0 ? '-' : '';
  const [entero, fraccion] = Math.abs(n).toFixed(decimales).split('.');
  const conMiles = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraccion ? `${signo}${conMiles}.${fraccion}` : `${signo}${conMiles}`;
}

export function formatearCantidad(valor: unknown): string {
  const n = numeroSeguro(valor);
  return Number.isInteger(n) ? formatearDecimal(n, 0) : formatearDecimal(n, 2);
}

/** 18 -> "18%", 18.5 -> "18.5%". */
export function formatearPorcentaje(valor: unknown): string {
  const n = numeroSeguro(valor);
  return `${Number.isInteger(n) ? n : Number(n.toFixed(2))}%`;
}

function partesFechaLima(fecha: Date): Record<string, string> {
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONA_HORARIA_PERU,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(fecha);
  const r: Record<string, string> = {};
  for (const p of partes) r[p.type] = p.value;
  // Algunos motores devuelven "24" para la medianoche.
  if (r.hour === '24') r.hour = '00';
  return r;
}

/**
 * Fecha dd/mm/aaaa en hora de Lima. Una fecha "AAAA-MM-DD" (columna DATE) se
 * formatea tal cual, sin convertir de zona, para no correrla un día.
 */
export function formatearFecha(valor: Date | string | null | undefined): string {
  if (!valor) return '';
  if (typeof valor === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor.trim());
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  }
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return '';
  const p = partesFechaLima(d);
  return `${p.day}/${p.month}/${p.year}`;
}

export function formatearFechaHora(valor: Date | string | null | undefined): string {
  if (!valor) return '';
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return '';
  const p = partesFechaLima(d);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** Fecha de hoy en Lima como AAAA-MM-DD. */
export function hoyEnLima(ahora = new Date()): string {
  const p = partesFechaLima(ahora);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Suma días a una fecha AAAA-MM-DD sin depender de la zona del servidor. */
export function sumarDias(fechaIso: string, dias: number): string {
  const [a, m, d] = fechaIso.split('-').map(Number);
  const fecha = new Date(Date.UTC(a, m - 1, d));
  fecha.setUTCDate(fecha.getUTCDate() + dias);
  return fecha.toISOString().slice(0, 10);
}

export function etiquetaEstado(estado: string | null | undefined): string {
  const clave = String(estado ?? '').trim().toLowerCase();
  return ETIQUETAS_ESTADO[clave] ?? (clave ? clave.charAt(0).toUpperCase() + clave.slice(1) : 'Borrador');
}

/** True si la proforma sigue abierta y su fecha de validez ya pasó. */
export function estaVencida(estado: string, validaHasta?: string | null, ahora = new Date()): boolean {
  if (!validaHasta || !/^\d{4}-\d{2}-\d{2}$/.test(validaHasta)) return false;
  const abierta = ['borrador', 'enviada', 'aprobada'].includes(String(estado ?? '').toLowerCase());
  return abierta && validaHasta < hoyEnLima(ahora);
}

/** Estado legible, marcando si ya venció. */
export function estadoParaDocumento(estado: string, validaHasta?: string | null, ahora = new Date()): string {
  const etiqueta = etiquetaEstado(estado);
  return estaVencida(estado, validaHasta, ahora) ? `${etiqueta} (vencida)` : etiqueta;
}

/**
 * Aviso de estado para el CLIENTE. Los estados internos (borrador, enviada,
 * aprobada, convertida) no se imprimen: al cliente no le dicen nada. Solo se
 * avisa cuando el documento ya no es utilizable.
 */
export function avisoEstadoCliente(
  estado: string,
  validaHasta?: string | null,
  ahora = new Date(),
): { texto: string; tono: 'peligro' | 'aviso' } | null {
  if (String(estado ?? '').trim().toLowerCase() === 'anulada') {
    return { texto: 'ANULADA', tono: 'peligro' };
  }
  if (estaVencida(estado, validaHasta, ahora)) return { texto: 'VENCIDA', tono: 'aviso' };
  return null;
}

/** True si algún ítem tiene descuento (entonces la tabla muestra precio de lista y descuento). */
export function hayDescuentos(items?: ItemDocumento[] | null): boolean {
  return (items ?? []).some((i) => numeroSeguro(i?.descuento) >= 0.005);
}

/**
 * Precio de lista unitario. `precio_unitario` ya es el precio NETO (con el
 * descuento restado), así que la lista es neto + descuento.
 */
export function precioLista(item: ItemDocumento): number {
  return redondear(numeroSeguro(item.precio_unitario) + numeroSeguro(item.descuento));
}

/** "987654321" -> "987 654 321"; "51987654321" -> "+51 987 654 321". */
export function formatearTelefono(valor?: string | null): string {
  const d = String(valor ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('51')) return `+51 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  if (d.length === 9) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  return textoPlano(valor);
}

/** Medios de contacto del emisor que realmente están configurados. */
export function contactoEmisor(emisor?: EmisorDocumento | null): string[] {
  const telefono = formatearTelefono(emisor?.telefono);
  const web = textoPlano(emisor?.web).replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return [
    telefono ? `Tel. ${telefono}` : '',
    textoPlano(emisor?.email),
    web,
  ].filter(Boolean);
}

/** "DNI" para 8 dígitos, "RUC" para 11, "DNI/RUC" si no se puede saber. */
export function etiquetaDocumento(documento?: string | null): string {
  const d = String(documento ?? '').replace(/\D/g, '');
  if (d.length === 11) return 'RUC';
  if (d.length === 8) return 'DNI';
  return 'DNI/RUC';
}

/** Texto limpio de una sola línea: sin saltos, tabs ni espacios repetidos. */
export function textoPlano(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  return String(valor)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Conserva los saltos de línea (para observaciones). */
export function textoMultilinea(valor: unknown): string[] {
  if (valor === null || valor === undefined) return [];
  const lineas = String(valor)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((linea) => textoPlano(linea));
  // Una sola línea en blanco como separador; ninguna al inicio ni al final.
  const resultado: string[] = [];
  for (const linea of lineas) {
    if (linea === '' && (resultado.length === 0 || resultado[resultado.length - 1] === '')) continue;
    resultado.push(linea);
  }
  while (resultado.length && resultado[resultado.length - 1] === '') resultado.pop();
  return resultado;
}

/** Nombre de archivo seguro a partir del código de la proforma. */
export function nombreArchivoProforma(codigo: string, extension: 'pdf' | 'xlsx'): string {
  const limpio = String(codigo ?? '').replace(/[^A-Za-z0-9_-]+/g, '') || 'SIN-CODIGO';
  return `Proforma-${limpio}.${extension}`;
}

/** Texto de una cuenta bancaria: "BCP · Cta. corriente N° 191-... · CCI 002-...". */
export function describirCuenta(cuenta: CuentaBancariaDocumento): string {
  const partes: string[] = [];
  const banco = textoPlano(cuenta.banco);
  if (cuenta.es_yape) {
    partes.push(`${banco || 'Yape'}: ${textoPlano(cuenta.numero)}`);
  } else {
    const tipo = textoPlano(cuenta.tipo);
    const moneda = textoPlano(cuenta.moneda).toUpperCase();
    const etiquetaTipo = tipo ? `Cta. ${tipo.toLowerCase()}` : 'Cuenta';
    const encabezado = [banco, moneda && moneda !== 'PEN' ? `(${moneda})` : ''].filter(Boolean).join(' ');
    partes.push(encabezado);
    if (textoPlano(cuenta.numero)) partes.push(`${etiquetaTipo} N° ${textoPlano(cuenta.numero)}`);
    if (textoPlano(cuenta.cci)) partes.push(`CCI ${textoPlano(cuenta.cci)}`);
  }
  if (textoPlano(cuenta.titular)) partes.push(`Titular: ${textoPlano(cuenta.titular)}`);
  return partes.filter(Boolean).join(' · ');
}

/** Una cuenta lista para mostrarla como fila de tabla (banco / cuenta / CCI). */
export interface FilaCuenta {
  banco: string;
  /** Tipo de cuenta, moneda y titular en una línea secundaria. */
  detalle: string;
  numero: string;
  cci: string;
}

export function describirCuentaTabla(cuenta: CuentaBancariaDocumento): FilaCuenta {
  const tipo = textoPlano(cuenta.tipo);
  const moneda = textoPlano(cuenta.moneda).toUpperCase();
  const titular = textoPlano(cuenta.titular);
  const detalle = [
    !cuenta.es_yape && tipo ? `Cta. ${tipo.toLowerCase()}` : '',
    !cuenta.es_yape && moneda && moneda !== 'PEN' ? moneda : '',
    titular ? `Titular: ${titular}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    banco: textoPlano(cuenta.banco) || (cuenta.es_yape ? 'Yape' : 'Cuenta'),
    detalle,
    numero: textoPlano(cuenta.numero),
    cci: cuenta.es_yape ? '' : textoPlano(cuenta.cci),
  };
}

/** Cuentas que realmente tienen un número que el cliente pueda usar. */
export function cuentasUtiles(cuentas?: CuentaBancariaDocumento[] | null): CuentaBancariaDocumento[] {
  return (cuentas ?? []).filter(
    (c) => textoPlano(c?.banco) && (textoPlano(c?.numero) || textoPlano(c?.cci)),
  );
}

/** Condiciones comerciales comunes al PDF y al Excel. */
export function condicionesComerciales(datos: DatosProformaDocumento): string[] {
  const valida = formatearFecha(datos.valida_hasta ?? null);
  const extras = (datos.condiciones_extra ?? []).map((c) => textoPlano(c)).filter(Boolean);
  return [
    valida
      ? `Oferta válida hasta el ${valida}. Vencida esa fecha, los precios y la disponibilidad pueden variar.`
      : 'Precios sujetos a variación sin previo aviso.',
    'Precios expresados en Soles (PEN) e incluyen IGV.',
    'Sujeto a disponibilidad de stock al momento de confirmar la compra.',
    ...extras,
  ];
}

export const LEYENDA_SIN_VALOR_TRIBUTARIO =
  'Documento comercial sin valor tributario. No es comprobante de pago.';
