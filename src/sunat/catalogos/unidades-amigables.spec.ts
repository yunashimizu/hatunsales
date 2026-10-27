import { UNIDADES_CATALOGO_03 } from './sunat.catalogos';
import { GRUPOS_UNIDADES, UNIDADES_AMIGABLES } from './unidades-amigables';

const FRECUENTES_PLAN = [
  'NIU', 'C62', 'KGM', 'MTR', 'MTK', 'GLL', 'QT', 'LTR', 'BG', 'SA', 'BX', 'PK',
  'RO', 'ST', 'RD', 'TU', 'BJ', 'CA', 'MLL', 'PR', 'SET', 'ZZ',
];
const OCULTAS_PLAN = [
  'MIL', 'UM', 'DZP', 'STN', 'LTN', 'GLI', 'MGM', 'MMK', 'MMQ', 'CMQ', 'KWH', 'MWH', 'YDK', 'FTQ', 'FTK',
];

describe('UNIDADES_AMIGABLES', () => {
  const codigos = UNIDADES_AMIGABLES.map((u) => u.codigo);

  it('todo código amigable existe en el catálogo 03', () => {
    const sobran = codigos.filter((c) => !Object.prototype.hasOwnProperty.call(UNIDADES_CATALOGO_03, c));
    expect(sobran).toEqual([]);
  });

  it('todo código del catálogo 03 tiene entrada amigable (visible o no)', () => {
    const faltan = Object.keys(UNIDADES_CATALOGO_03).filter((c) => !codigos.includes(c));
    expect(faltan).toEqual([]);
  });

  it('no hay códigos repetidos', () => {
    expect(new Set(codigos).size).toBe(codigos.length);
  });

  it('no hay abreviaturas repetidas', () => {
    const abreviaturas = UNIDADES_AMIGABLES.map((u) => u.abreviatura.toLowerCase());
    const repetidas = abreviaturas.filter((a, i) => abreviaturas.indexOf(a) !== i);
    expect(repetidas).toEqual([]);
  });

  it('los frecuentes son exactamente la lista del plan', () => {
    const frecuentes = UNIDADES_AMIGABLES.filter((u) => u.frecuente).map((u) => u.codigo);
    expect([...frecuentes].sort()).toEqual([...FRECUENTES_PLAN].sort());
  });

  it('los no visibles son exactamente la lista del plan y ningún frecuente lo es', () => {
    const ocultas = UNIDADES_AMIGABLES.filter((u) => !u.visible).map((u) => u.codigo);
    expect([...ocultas].sort()).toEqual([...OCULTAS_PLAN].sort());
    expect(UNIDADES_AMIGABLES.filter((u) => u.frecuente && !u.visible)).toEqual([]);
  });

  it('cada unidad pertenece a un grupo conocido y los grupos van en el orden del plan', () => {
    for (const u of UNIDADES_AMIGABLES) expect(GRUPOS_UNIDADES).toContain(u.grupo);
    expect([...GRUPOS_UNIDADES]).toEqual([
      'Conteo', 'Peso', 'Longitud', 'Área', 'Volumen y líquidos',
      'Envases y empaques', 'Construcción y materiales', 'Servicios y alquiler',
    ]);
  });

  it('nombres de ejemplo del plan', () => {
    const por = (c: string) => UNIDADES_AMIGABLES.find((u) => u.codigo === c)!;
    expect(por('NIU')).toMatchObject({ nombre: 'Unidad', abreviatura: 'und' });
    expect(por('QT')).toMatchObject({ nombre: 'Cuarto de galón', abreviatura: '1/4 gl' });
    expect(por('SA')).toMatchObject({ nombre: 'Saco', abreviatura: 'sco' });
    expect(por('MTK')).toMatchObject({ nombre: 'Metro cuadrado', abreviatura: 'm²' });
    expect(por('HUR')).toMatchObject({ nombre: 'Hora de servicio', abreviatura: 'h' });
  });
});
