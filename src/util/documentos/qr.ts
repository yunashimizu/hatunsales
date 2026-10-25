import { create } from 'qrcode';
import { deflateSync } from 'zlib';

/**
 * Imagen PNG del código QR de una representación impresa (comprobantes y GRE).
 * Codifica EXACTAMENTE la cadena recibida: quien la arma (nucleo/cadena-qr.ts) es la fuente de verdad.
 *
 * `qrcode` arma la matriz (versión, máscara, corrección de errores) y el PNG se escribe aquí: gris de
 * 8 bits sin canal alfa, que pdfkit incrusta tal cual (sin decodificar píxeles ni separar
 * transparencia). El codificador PNG de qrcode (pngjs) es mucho más lento y entrega RGBA.
 */

export type CorreccionQr = 'L' | 'M' | 'Q' | 'H';

export interface OpcionesQrPng {
  /** Lado aproximado de la imagen en píxeles (se ajusta a un múltiplo exacto del módulo). Por defecto 300. */
  tamanoPx?: number;
  /** Nivel de corrección de errores. Por defecto 'M' (lo habitual en comprobantes electrónicos). */
  correccion?: CorreccionQr;
}

const TAMANO_POR_DEFECTO = 300;
const TAMANO_MINIMO = 64;
const TAMANO_MAXIMO = 1_200;
/** Zona de silencio en módulos. El estándar pide 4; en papel el margen blanco del documento completa el resto. */
const MARGEN_MODULOS = 2;
const CORRECCIONES = new Set<CorreccionQr>(['L', 'M', 'Q', 'H']);

/** Asíncrona por contrato (la usan PDF de comprobante y de GRE); un error de validación llega como rechazo. */
export function generarQrPng(
  cadena: string,
  opciones: OpcionesQrPng = {},
): Promise<Buffer> {
  return new Promise<Buffer>((resolve) =>
    resolve(codificarQrPng(cadena, opciones)),
  );
}

function codificarQrPng(cadena: string, opciones: OpcionesQrPng): Buffer {
  if (typeof cadena !== 'string' || cadena.trim() === '') {
    throw new Error('No hay contenido para el código QR.');
  }
  const correccion = opciones.correccion ?? 'M';
  if (!CORRECCIONES.has(correccion)) {
    throw new Error(
      `Nivel de corrección de QR no válido: "${String(correccion)}" (use L, M, Q o H).`,
    );
  }
  const pedido = Number(opciones.tamanoPx ?? TAMANO_POR_DEFECTO);
  const tamano = Number.isFinite(pedido)
    ? Math.min(TAMANO_MAXIMO, Math.max(TAMANO_MINIMO, Math.round(pedido)))
    : TAMANO_POR_DEFECTO;

  const { modules } = create(cadena, { errorCorrectionLevel: correccion });
  const modulos = modules.size + MARGEN_MODULOS * 2;
  // Escala entera: cada módulo ocupa los mismos píxeles y el lector no ve bordes irregulares.
  const escala = Math.max(1, Math.round(tamano / modulos));
  const lado = modulos * escala;

  // Filas crudas del PNG: byte de filtro (0 = ninguno) + un byte de gris por píxel (0 negro, 255 blanco).
  const bytesFila = lado + 1;
  const crudo = Buffer.alloc(bytesFila * lado, 255);
  for (let filaModulo = 0; filaModulo < modulos; filaModulo++) {
    const inicio = filaModulo * escala * bytesFila;
    crudo[inicio] = 0;
    const fila = filaModulo - MARGEN_MODULOS;
    if (fila >= 0 && fila < modules.size) {
      for (let col = 0; col < modules.size; col++) {
        if (!modules.get(fila, col)) continue;
        const x = inicio + 1 + (col + MARGEN_MODULOS) * escala;
        crudo.fill(0, x, x + escala);
      }
    }
    // Las demás filas de píxeles del mismo módulo son copia de la primera.
    for (let repeticion = 1; repeticion < escala; repeticion++) {
      crudo.copy(
        crudo,
        inicio + repeticion * bytesFila,
        inicio,
        inicio + bytesFila,
      );
    }
  }

  const cabecera = Buffer.alloc(13);
  cabecera.writeUInt32BE(lado, 0);
  cabecera.writeUInt32BE(lado, 4);
  cabecera[8] = 8; // bits por muestra
  cabecera[9] = 0; // escala de grises, sin alfa
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozoPng('IHDR', cabecera),
    trozoPng('IDAT', deflateSync(crudo, { level: 9 })),
    trozoPng('IEND', Buffer.alloc(0)),
  ]);
}

const TABLA_CRC = (() => {
  const tabla = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabla[n] = c >>> 0;
  }
  return tabla;
})();

function crc32(datos: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < datos.length; i++)
    c = TABLA_CRC[(c ^ datos[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function trozoPng(tipo: string, datos: Buffer): Buffer {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length, 0);
  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo), 0);
  return Buffer.concat([largo, cuerpo, crc]);
}
