import { create } from 'qrcode';
import { inflateSync } from 'zlib';
import { generarQrPng } from './qr';

const CADENA =
  '20610206337|01|F001|00000123|18.00|118.00|2026-10-21|6|20100070970|q8ZqH0n0zG5m6Yy0ZkzQb2s5bWc=|';

/** Lector mínimo de PNG en gris de 8 bits con filtro 0 (lo que produce generarQrPng). */
function leerPng(png: Buffer): {
  ancho: number;
  alto: number;
  tipoColor: number;
  bits: number;
  pixel: (x: number, y: number) => number;
} {
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  let pos = 8;
  let ancho = 0;
  let alto = 0;
  let bits = 0;
  let tipoColor = -1;
  const idat: Buffer[] = [];
  while (pos < png.length) {
    const largo = png.readUInt32BE(pos);
    const tipo = png.subarray(pos + 4, pos + 8).toString('ascii');
    const datos = png.subarray(pos + 8, pos + 8 + largo);
    if (tipo === 'IHDR') {
      ancho = datos.readUInt32BE(0);
      alto = datos.readUInt32BE(4);
      bits = datos[8];
      tipoColor = datos[9];
    }
    if (tipo === 'IDAT') idat.push(datos);
    pos += 12 + largo;
  }
  const crudo = inflateSync(Buffer.concat(idat));
  expect(crudo.length).toBe((ancho + 1) * alto);
  for (let y = 0; y < alto; y++) expect(crudo[y * (ancho + 1)]).toBe(0);
  return {
    ancho,
    alto,
    tipoColor,
    bits,
    pixel: (x, y) => crudo[y * (ancho + 1) + 1 + x],
  };
}

/** Matriz de módulos (true = oscuro) muestreando el centro de cada módulo. */
function leerModulos(
  png: Buffer,
  margen = 2,
): { matriz: boolean[][]; ancho: number; tipoColor: number } {
  const imagen = leerPng(png);
  const lado = create(CADENA, { errorCorrectionLevel: 'M' }).modules.size;
  const escala = imagen.ancho / (lado + margen * 2);
  const matriz: boolean[][] = [];
  for (let fila = 0; fila < lado; fila++) {
    const valores: boolean[] = [];
    for (let col = 0; col < lado; col++) {
      valores.push(
        imagen.pixel(
          Math.floor((col + margen + 0.5) * escala),
          Math.floor((fila + margen + 0.5) * escala),
        ) < 128,
      );
    }
    matriz.push(valores);
  }
  return { matriz, ancho: imagen.ancho, tipoColor: imagen.tipoColor };
}

describe('generarQrPng', () => {
  it('genera un PNG en gris sin alfa que codifica exactamente la cadena recibida (nivel M por defecto)', async () => {
    const png = await generarQrPng(CADENA);
    const { matriz, tipoColor } = leerModulos(png);
    expect(tipoColor).toBe(0);
    expect(leerPng(png).bits).toBe(8);

    const esperado = create(CADENA, { errorCorrectionLevel: 'M' }).modules;
    for (let fila = 0; fila < esperado.size; fila++) {
      for (let col = 0; col < esperado.size; col++) {
        expect(matriz[fila][col]).toBe(Boolean(esperado.get(fila, col)));
      }
    }
  });

  it('respeta el tamaño pedido con una escala entera por módulo', async () => {
    const lado = create(CADENA, { errorCorrectionLevel: 'M' }).modules.size + 4;
    const png = await generarQrPng(CADENA, { tamanoPx: 500 });
    const { ancho } = leerModulos(png);
    expect(ancho % lado).toBe(0);
    expect(Math.abs(ancho - 500)).toBeLessThanOrEqual(lado);
  });

  it('usa el nivel de corrección indicado (H produce más módulos que L)', async () => {
    const bajo = leerPng(
      await generarQrPng(CADENA, { correccion: 'L', tamanoPx: 64 }),
    );
    const alto = leerPng(
      await generarQrPng(CADENA, { correccion: 'H', tamanoPx: 64 }),
    );
    const ladoL = create(CADENA, { errorCorrectionLevel: 'L' }).modules.size;
    const ladoH = create(CADENA, { errorCorrectionLevel: 'H' }).modules.size;
    expect(ladoH).toBeGreaterThan(ladoL);
    expect(bajo.ancho % (ladoL + 4)).toBe(0);
    expect(alto.ancho % (ladoH + 4)).toBe(0);
  });

  it('rechaza una cadena vacía o un nivel desconocido con un mensaje claro', async () => {
    await expect(generarQrPng('')).rejects.toThrow(
      'No hay contenido para el código QR.',
    );
    await expect(generarQrPng('   ')).rejects.toThrow('No hay contenido');
    await expect(
      generarQrPng(CADENA, { correccion: 'X' as never }),
    ).rejects.toThrow('Nivel de corrección de QR no válido');
  });

  it('acota tamaños absurdos', async () => {
    const enorme = leerPng(await generarQrPng(CADENA, { tamanoPx: 1_000_000 }));
    expect(enorme.ancho).toBeLessThanOrEqual(1_250);
    const invalido = leerPng(
      await generarQrPng(CADENA, { tamanoPx: Number.NaN }),
    );
    expect(invalido.ancho).toBeGreaterThan(200);
  });
});
