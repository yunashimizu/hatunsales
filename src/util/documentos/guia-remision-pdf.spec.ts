import { ENLACE_QR_PRUEBA } from '../../sunat/gre/pruebas/respuestas-gre-prueba-spec';
import { generarGuiaRemisionPdf, LEYENDA_GRE_REMITENTE, marcaEstadoGuia, type DatosGuiaRemisionPdf } from './guia-remision-pdf';

/** Bytes 0x80-0x9F de WinAnsi que no coinciden con Latin-1. */
const WIN_ANSI: Record<number, string> = { 0x85: '…', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—' };

function decodificar(hex: string): string {
  return Array.from(Buffer.from(hex, 'hex'), (b) => WIN_ANSI[b] ?? String.fromCharCode(b)).join('');
}

/** Texto de cada hoja de un PDF generado con comprimir:false (un flujo de contenido por página). */
function paginas(pdf: Buffer): string[] {
  const crudo = pdf.toString('latin1');
  const resultado: string[] = [];
  for (const [, flujo] of crudo.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    if (!/\]\s*TJ/.test(flujo)) continue;
    const lineas = Array.from(flujo.matchAll(/\[([^\]]*)\]\s*TJ/g), ([, arreglo]) =>
      Array.from(arreglo.matchAll(/<([0-9a-fA-F]*)>/g), ([, hex]) => decodificar(hex)).join(''),
    );
    resultado.push(lineas.join('\n'));
  }
  return resultado;
}

function texto(pdf: Buffer): string {
  return paginas(pdf).join('\n').replace(/\n/g, ' ');
}

/** Imágenes dibujadas (operador «/In Do»): sin logo, la única es el QR. */
function imagenesDibujadas(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/I\d+ Do/g) ?? []).length;
}

function datos(cambios: Partial<DatosGuiaRemisionPdf> = {}): DatosGuiaRemisionPdf {
  return {
    emisor: {
      ruc: '20610206337',
      razonSocial: 'HATUNSALES S.A.C.',
      nombreComercial: 'FERRETERÍA HATUN',
      direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN',
      ubicacion: 'LURIN - LIMA - LIMA',
      logo: null,
    },
    estado: 'aceptado',
    numero: 'T001-00000001',
    idGuia: 7,
    fechaEmision: '2026-10-22',
    horaEmision: '10:00:00',
    fechaInicioTraslado: '2026-10-23',
    fechaEntregaTransportista: null,
    motivo: { codigo: '01', nombre: 'Venta' },
    descripcionMotivo: null,
    modalidad: { codigo: '02', nombre: 'Transporte privado' },
    pesoBrutoTotal: 1250.5,
    unidadPeso: 'KGM',
    numeroBultos: 25,
    destinatario: { tipoDoc: '6', tipoDocTexto: 'RUC', numDoc: '20553856451', nombre: 'CONSTRUCTORA LOS ANDES S.A.C.' },
    partida: { direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN', ubigeo: '150119 - LURIN - LIMA - LIMA', codigoEstablecimiento: '0000' },
    llegada: { direccion: 'AV. JOSE LARCO 1150, MIRAFLORES', ubigeo: '150122 - MIRAFLORES - LIMA - LIMA', codigoEstablecimiento: null },
    transportista: null,
    vehiculo: { placa: 'ABC123', tarjetaCirculacion: '15M21012345', marca: 'VOLVO' },
    conductor: { tipoDocTexto: 'DNI', numDoc: '45678912', nombre: 'JUAN CARLOS PEREZ QUISPE', licencia: 'Q45678912' },
    documentoRelacionado: { tipo: 'Factura', numero: 'F001-00000125' },
    items: [
      { codigo: 'CEM-001', descripcion: 'CEMENTO SOL TIPO I BOLSA 42.5 KG', unidad: 'BG', cantidad: 25 },
      { codigo: 'CAB-014', descripcion: 'CABLE THW 14 AWG INDECO', unidad: 'MTR', cantidad: 2.5 },
    ],
    observaciones: 'Entregar en almacén de obra',
    cadenaQr: ENLACE_QR_PRUEBA,
    ...cambios,
  };
}

describe('Representación impresa de la GRE remitente', () => {
  it('aceptada: datos en palabras, número de 8 dígitos, ubigeo legible, QR del CDR y la leyenda', async () => {
    const pdf = await generarGuiaRemisionPdf(datos(), { comprimir: false });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const contenido = texto(pdf);
    for (const esperado of [
      'GUÍA DE REMISIÓN ELECTRÓNICA',
      'REMITENTE',
      'T001-00000001',
      '22/10/2026 10:00:00',
      '01 - Venta',
      '02 - Transporte privado',
      '1,250.5 KGM',
      '150119 - LURIN - LIMA - LIMA',
      '150122 - MIRAFLORES - LIMA - LIMA',
      'RUC 20553856451',
      'Factura F001-00000125',
      'ABC123',
      'JUAN CARLOS PEREZ QUISPE',
      'Q45678912',
      'CEMENTO SOL TIPO I BOLSA 42.5 KG',
      'Entregar en almacén de obra',
      LEYENDA_GRE_REMITENTE,
    ]) {
      expect(contenido).toContain(esperado);
    }
    // El código de establecimiento solo se imprime con el motivo 04.
    expect(contenido).not.toContain('Establecimiento SUNAT');
    expect(imagenesDibujadas(pdf)).toBe(1);
    expect(contenido).not.toContain('SIN VALIDEZ');
  });

  it.each([
    ['borrador', 'BORRADOR - SIN VALIDEZ'],
    ['pendiente', 'PENDIENTE DE SUNAT'],
    ['enviado', 'PENDIENTE DE SUNAT'],
    ['rechazado', 'RECHAZADA'],
    ['anulado', 'ANULADA'],
  ])('%s: sin QR aunque llegue la cadena, con la marca «%s» y sin la leyenda de representación', async (estado, marca) => {
    const pdf = await generarGuiaRemisionPdf(datos({ estado, numero: estado === 'borrador' ? null : 'T001-00000002' }), { comprimir: false });
    const contenido = texto(pdf);
    expect(contenido).toContain(marca);
    expect(contenido).toContain('Documento sin validez tributaria');
    expect(contenido).not.toContain(LEYENDA_GRE_REMITENTE);
    expect(imagenesDibujadas(pdf)).toBe(0);
    if (estado === 'borrador') expect(contenido).toContain('BORRADOR N.° 7');
  });

  it('transporte público y traslado entre establecimientos: transportista, fecha de entrega y códigos de establecimiento', async () => {
    const pdf = await generarGuiaRemisionPdf(
      datos({
        motivo: { codigo: '04', nombre: 'Traslado entre establecimientos de la misma empresa' },
        modalidad: { codigo: '01', nombre: 'Transporte público' },
        fechaEntregaTransportista: '2026-10-23',
        transportista: { ruc: '20100066603', razonSocial: 'TRANSPORTES DEL SUR S.A.C.', registroMtc: '1534567CNG' },
        vehiculo: null,
        conductor: null,
        llegada: { direccion: 'JR. AYACUCHO 450, CERCADO DE LIMA', ubigeo: '150101 - LIMA - LIMA - LIMA', codigoEstablecimiento: '0001' },
      }),
      { comprimir: false },
    );
    const contenido = texto(pdf);
    expect(contenido).toContain('01 - Transporte público');
    expect(contenido).toContain('TRANSPORTES DEL SUR S.A.C.');
    expect(contenido).toContain('1534567CNG');
    expect(contenido).toContain('Entrega al transportista');
    expect(contenido).toContain('0001');
    expect(contenido).toContain('Establecimiento SUNAT');
  });

  it('muchos bienes: varias hojas, la tabla repite su encabezado y cada hoja lleva su número', async () => {
    const items = Array.from({ length: 80 }, (_, i) => ({ codigo: `P-${i + 1}`, descripcion: `PRODUCTO DE PRUEBA NÚMERO ${i + 1}`, unidad: 'NIU', cantidad: i + 1 }));
    const pdf = await generarGuiaRemisionPdf(datos({ items }), { comprimir: false });
    const hojas = paginas(pdf);
    expect(hojas.length).toBeGreaterThan(1);
    expect(hojas.filter((hoja) => hoja.includes('DESCRIPCIÓN')).length).toBeGreaterThanOrEqual(2);
    expect(hojas[hojas.length - 1]).toContain(`Página ${hojas.length} de ${hojas.length}`);
    expect(texto(pdf)).toContain('PRODUCTO DE PRUEBA NÚMERO 80');
  });

  it('marcaEstadoGuia: solo la aceptada sale sin marca', () => {
    expect(marcaEstadoGuia('aceptado')).toBeNull();
    expect(marcaEstadoGuia('legacy')).toBe('SIN VALIDEZ ELECTRÓNICA');
    expect(marcaEstadoGuia('otro')).toBe('SIN VALIDEZ');
  });
});
