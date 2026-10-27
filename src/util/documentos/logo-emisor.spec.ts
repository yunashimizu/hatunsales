import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { LOGO_EMISOR_OFICIAL, emisorConfig } from '../../config/emisor.config';
import {
  codificarPng,
  dimensionesImagen,
  imagenSoportada,
  limpiarCacheLogo,
  obtenerLogoEmisor,
} from './logo-emisor';

const archivoOficial = join(process.cwd(), LOGO_EMISOR_OFICIAL.replace(/^\/+/, ''));

/** JPEG mínimo: SOI + cabecera SOF0 con alto y ancho (no se decodifica, solo se lee la medida). */
function jpegMinimo(ancho: number, alto: number): Buffer {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(alto, 5);
  sof.writeUInt16BE(ancho, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), sof, Buffer.from([0xff, 0xd9])]);
}

describe('logo oficial del emisor', () => {
  beforeEach(() => limpiarCacheLogo());

  it('es la configuración por defecto y el archivo existe y es una imagen válida', () => {
    expect(emisorConfig.logo_url).toBe(LOGO_EMISOR_OFICIAL);
    expect(existsSync(archivoOficial)).toBe(true);
    expect(imagenSoportada(readFileSync(archivoOficial))).toBe(true);
  });

  it('el logo oficial no es cuadrado ni pesa de más (cabe en las cajas de los documentos)', () => {
    const datos = readFileSync(archivoOficial);
    const medida = dimensionesImagen(datos);
    expect(medida).not.toBeNull();
    expect(medida!.ancho).toBeGreaterThan(medida!.alto * 0.9);
    expect(datos.length).toBeLessThan(2 * 1024 * 1024);
  });

  it('con la ruta oficial entrega ese archivo', async () => {
    const logo = await obtenerLogoEmisor(LOGO_EMISOR_OFICIAL);
    expect(logo).not.toBeNull();
    expect(imagenSoportada(logo!)).toBe(true);
  });

  it('un valor vacío o nulo usa el logo oficial', async () => {
    const oficial = await obtenerLogoEmisor(LOGO_EMISOR_OFICIAL);
    expect(await obtenerLogoEmisor('')).toEqual(oficial);
    expect(await obtenerLogoEmisor('   ')).toEqual(oficial);
    expect(await obtenerLogoEmisor(null)).toEqual(oficial);
    expect(await obtenerLogoEmisor(undefined)).toEqual(oficial);
  });

  it('la ruta del PNG anterior, que ya no existe, cae al logo oficial', async () => {
    const oficial = await obtenerLogoEmisor(LOGO_EMISOR_OFICIAL);
    expect(await obtenerLogoEmisor('/uploads/hatunsales.png')).toEqual(oficial);
  });

  it('una ruta fuera de uploads o un archivo inexistente también cae al oficial', async () => {
    const oficial = await obtenerLogoEmisor(LOGO_EMISOR_OFICIAL);
    expect(await obtenerLogoEmisor('/uploads/../package.json')).toEqual(oficial);
    expect(await obtenerLogoEmisor('/uploads/no-existe.png')).toEqual(oficial);
    expect(await obtenerLogoEmisor('texto-cualquiera')).toEqual(oficial);
  });

  it('un logo propio válido (data URI) se respeta y no se reemplaza por el oficial', async () => {
    const propio = codificarPng(Buffer.alloc(4 * 4 * 4, 255), 4, 4);
    const uri = `data:image/png;base64,${propio.toString('base64')}`;
    const logo = await obtenerLogoEmisor(uri);
    expect(logo).toEqual(propio);
  });
});

describe('dimensionesImagen', () => {
  it('lee ancho y alto de un PNG', () => {
    expect(dimensionesImagen(codificarPng(Buffer.alloc(6 * 3 * 4), 6, 3))).toEqual({ ancho: 6, alto: 3 });
  });

  it('lee ancho y alto de un JPEG', () => {
    expect(dimensionesImagen(jpegMinimo(640, 480))).toEqual({ ancho: 640, alto: 480 });
  });

  it('devuelve null si no es una imagen conocida o está truncada', () => {
    expect(dimensionesImagen(Buffer.from('no soy una imagen'))).toBeNull();
    expect(dimensionesImagen(Buffer.alloc(0))).toBeNull();
    expect(dimensionesImagen(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
  });
});
