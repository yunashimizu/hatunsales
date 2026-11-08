import {
  AVISO_ESTRUCTURA_RVIE,
  CABECERAS_RVIE,
  COLUMNAS_RVIE,
  FilaRvie,
  construirCsvRvie,
  construirTxtRvie,
  fechaRvie,
  importeRvie,
  nombreArchivoRvie,
  periodoRvieValido,
  textoRvie,
} from './rvie';

const fila = (cambios: Partial<FilaRvie> = {}): FilaRvie => ({
  fecha: '2026-10-05',
  vencimiento: '',
  tipo: '01',
  serie: 'F001',
  numero: 7,
  clienteTipoDoc: '6',
  clienteNumeroDoc: '20100066603',
  clienteNombre: 'EL SOL SAC',
  gravada: 100,
  igv: 18,
  exonerada: 0,
  inafecta: 0,
  total: 118,
  moneda: 'PEN',
  modificadoFecha: '',
  modificadoTipo: '',
  modificadoSerie: '',
  modificadoNumero: null,
  estado: 'aceptado',
  ...cambios,
});
const datos = { ruc: '20610206337', razonSocial: 'HATUNSALES S.A.C.', periodo: '202610' };

describe('rvie (Registro de ventas para el SIRE)', () => {
  it('el nombre del archivo sigue la convención oficial: LE + RUC + AAAAMM + 00 + 140400 + 02 + O I M 2', () => {
    expect(nombreArchivoRvie('20610206337', '202610', true)).toBe('LE20610206337202610001404000211'+'12.txt');
    expect(nombreArchivoRvie('20610206337', '202610', false)).toBe('LE20610206337202610001404000210'+'12.txt');
    expect(nombreArchivoRvie('20610206337', '202610', true, 2)).toBe('LE20610206337202610001404000211'+'22.txt');
  });

  it('fechas dd/mm/aaaa, importes con punto y dos decimales (sin «-0.00») y textos sin «|» ni saltos de línea', () => {
    expect(fechaRvie('2026-10-05')).toBe('05/10/2026');
    expect(fechaRvie('')).toBe('');
    expect(fechaRvie('05-10-2026')).toBe('');
    expect(importeRvie(118)).toBe('118.00');
    expect(importeRvie(0.005)).toBe('0.01');
    expect(importeRvie(-0.001)).toBe('0.00');
    expect(importeRvie(Number.NaN)).toBe('0.00');
    expect(textoRvie('  A|B\r\nC\t D ')).toBe('A B C D');
    expect(textoRvie(null)).toBe('');
  });

  it('el periodo es AAAAMM entre 2020 y el mes 12', () => {
    for (const bueno of ['202001', '202610', '203012']) expect(periodoRvieValido(bueno)).toBe(true);
    for (const malo of ['201912', '202600', '202613', '2026-10', '26010', '', null, 202610]) expect(periodoRvieValido(malo)).toBe(false);
  });

  it('cada línea del TXT tiene las 34 columnas de las cabeceras, termina en CRLF y no lleva BOM', () => {
    expect(CABECERAS_RVIE).toHaveLength(COLUMNAS_RVIE);
    const txt = construirTxtRvie([fila(), fila({ numero: 8 })], datos);
    const lineas = txt.split('\r\n').filter(Boolean);
    expect(lineas).toHaveLength(2);
    for (const l of lineas) expect(l.split('|')).toHaveLength(COLUMNAS_RVIE);
    expect(txt.endsWith('\r\n')).toBe(true);
    expect(txt.charCodeAt(0)).not.toBe(0xfeff);
    expect(construirTxtRvie([], datos)).toBe('');
  });

  it('la nota de crédito sale en negativo con su documento modificado; la nota de débito, en positivo', () => {
    const nc = construirTxtRvie([fila({ tipo: '07', serie: 'FC01', numero: 2, modificadoFecha: '2026-10-01', modificadoTipo: '01', modificadoSerie: 'F001', modificadoNumero: 7 })], datos).split('|');
    expect(nc.slice(14, 17)).toEqual(['-100.00', '0.00', '-18.00']);
    expect(nc[25]).toBe('-118.00');
    expect(nc.slice(28, 32)).toEqual(['01/10/2026', '01', 'F001', '7']);
    const nd = construirTxtRvie([fila({ tipo: '08', serie: 'FD01' })], datos).split('|');
    expect(nd[25]).toBe('118.00');
  });

  it('el CSV lleva BOM, cabeceras, la columna «Estado» y escapa comas y comillas', () => {
    const csv = construirCsvRvie([fila({ clienteNombre: 'SOL, "HNOS"' }), fila({ estado: 'anulado' })], datos);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const [cabecera, a, b] = csv.slice(1).split('\r\n');
    expect(cabecera.split(',')).toHaveLength(COLUMNAS_RVIE + 1);
    expect(cabecera.endsWith('Estado')).toBe(true);
    expect(a).toContain('"SOL, ""HNOS"""');
    expect(a.endsWith('Aceptado')).toBe(true);
    expect(b).toContain('ANULADO');
    expect(b.endsWith('Anulado')).toBe(true);
  });

  it('deja escrito el aviso de que la estructura es supuesta y la valida el contador', () => {
    expect(AVISO_ESTRUCTURA_RVIE).toBe('Estructura basada en PLE 14.1; el contador debe validar el primer archivo contra la propuesta SIRE.');
  });
});
