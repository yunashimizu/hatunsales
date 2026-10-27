/**
 * Nombres en español de las unidades del catálogo 03 (sunat.catalogos.ts), para que el
 * formulario de productos muestre «Kilogramo (kg)» en vez de «KGM». Vive junto al
 * catálogo y unidades-amigables.spec.ts obliga a que ambos coincidan.
 */
export const GRUPOS_UNIDADES = [
  'Conteo',
  'Peso',
  'Longitud',
  'Área',
  'Volumen y líquidos',
  'Envases y empaques',
  'Construcción y materiales',
  'Servicios y alquiler',
] as const;

export type GrupoUnidad = (typeof GRUPOS_UNIDADES)[number];

export interface UnidadAmigable {
  /** Código del catálogo 03 de SUNAT: lo único que viaja al XML. */
  codigo: string;
  nombre: string;
  abreviatura: string;
  grupo: GrupoUnidad;
  /** Sale arriba, en el grupo «Frecuentes» del selector. */
  frecuente: boolean;
  /** `false`: sigue aceptándose pero no se ofrece en el selector. */
  visible: boolean;
}

/** Códigos que se ofrecen arriba del selector (ferretería, gasfitería y construcción). */
export const UNIDADES_FRECUENTES: readonly string[] = [
  'NIU', 'C62', 'KGM', 'MTR', 'MTK', 'GLL', 'QT', 'LTR', 'BG', 'SA', 'BX', 'PK',
  'RO', 'ST', 'RD', 'TU', 'BJ', 'CA', 'MLL', 'PR', 'SET', 'ZZ',
];

/** Códigos aceptados pero no ofrecidos (duplicados o de uso raro en una ferretería). */
const UNIDADES_OCULTAS: readonly string[] = [
  'MIL', 'UM', 'DZP', 'STN', 'LTN', 'GLI', 'MGM', 'MMK', 'MMQ', 'CMQ', 'KWH', 'MWH', 'YDK', 'FTQ', 'FTK',
];

type Base = [codigo: string, nombre: string, abreviatura: string, grupo: GrupoUnidad];

const BASE: Base[] = [
  // Conteo
  ['NIU', 'Unidad', 'und', 'Conteo'],
  ['C62', 'Pieza', 'pza', 'Conteo'],
  ['PR', 'Par', 'par', 'Conteo'],
  ['DZN', 'Docena', 'doc', 'Conteo'],
  ['DZP', 'Docena de paquetes', 'dzp', 'Conteo'],
  ['CEN', 'Ciento', 'cto', 'Conteo'],
  ['GRO', 'Gruesa', 'gro', 'Conteo'],
  ['MLL', 'Millar', 'mll', 'Conteo'],
  ['MIL', 'Millar (código UN/ECE)', 'mil', 'Conteo'],
  ['UM', 'Millón de unidades', 'mdu', 'Conteo'],
  // Peso
  ['KGM', 'Kilogramo', 'kg', 'Peso'],
  ['GRM', 'Gramo', 'g', 'Peso'],
  ['MGM', 'Miligramo', 'mg', 'Peso'],
  ['TNE', 'Tonelada', 't', 'Peso'],
  ['STN', 'Tonelada corta', 't cta', 'Peso'],
  ['LTN', 'Tonelada larga', 't lga', 'Peso'],
  ['LBR', 'Libra', 'lb', 'Peso'],
  ['ONZ', 'Onza', 'oz', 'Peso'],
  // Longitud
  ['MTR', 'Metro', 'm', 'Longitud'],
  ['CMT', 'Centímetro', 'cm', 'Longitud'],
  ['MMT', 'Milímetro', 'mm', 'Longitud'],
  ['KTM', 'Kilómetro', 'km', 'Longitud'],
  ['INH', 'Pulgada', 'pulg', 'Longitud'],
  ['FOT', 'Pie', 'pie', 'Longitud'],
  ['YRD', 'Yarda', 'yd', 'Longitud'],
  // Área
  ['MTK', 'Metro cuadrado', 'm²', 'Área'],
  ['CMK', 'Centímetro cuadrado', 'cm²', 'Área'],
  ['MMK', 'Milímetro cuadrado', 'mm²', 'Área'],
  ['FTK', 'Pie cuadrado', 'pie²', 'Área'],
  ['YDK', 'Yarda cuadrada', 'yd²', 'Área'],
  // Volumen y líquidos
  ['LTR', 'Litro', 'l', 'Volumen y líquidos'],
  ['MLT', 'Mililitro', 'ml', 'Volumen y líquidos'],
  ['HLT', 'Hectolitro', 'hl', 'Volumen y líquidos'],
  ['GLL', 'Galón', 'gl', 'Volumen y líquidos'],
  ['QT', 'Cuarto de galón', '1/4 gl', 'Volumen y líquidos'],
  ['PT', 'Pinta', 'pta', 'Volumen y líquidos'],
  ['GLI', 'Galón (Reino Unido)', 'gl uk', 'Volumen y líquidos'],
  ['BLL', 'Barril', 'brl', 'Volumen y líquidos'],
  ['MTQ', 'Metro cúbico', 'm³', 'Volumen y líquidos'],
  ['CMQ', 'Centímetro cúbico', 'cm³', 'Volumen y líquidos'],
  ['MMQ', 'Milímetro cúbico', 'mm³', 'Volumen y líquidos'],
  ['FTQ', 'Pie cúbico', 'pie³', 'Volumen y líquidos'],
  // Envases y empaques
  ['BX', 'Caja', 'cja', 'Envases y empaques'],
  ['PK', 'Paquete', 'paq', 'Envases y empaques'],
  ['SET', 'Juego', 'jgo', 'Envases y empaques'],
  ['KT', 'Kit', 'kit', 'Envases y empaques'],
  ['BG', 'Bolsa', 'bls', 'Envases y empaques'],
  ['BO', 'Botella', 'bot', 'Envases y empaques'],
  ['RO', 'Rollo', 'rol', 'Envases y empaques'],
  ['4A', 'Bobina', 'bob', 'Envases y empaques'],
  ['BJ', 'Balde', 'bld', 'Envases y empaques'],
  ['BE', 'Fardo', 'fdo', 'Envases y empaques'],
  ['CA', 'Lata', 'lta', 'Envases y empaques'],
  ['CT', 'Cartón', 'ctn', 'Envases y empaques'],
  ['CY', 'Cilindro', 'cil', 'Envases y empaques'],
  ['DR', 'Tambor', 'tmb', 'Envases y empaques'],
  ['JR', 'Frasco', 'frs', 'Envases y empaques'],
  ['PL', 'Cubeta', 'cub', 'Envases y empaques'],
  ['PF', 'Paleta', 'pal', 'Envases y empaques'],
  ['CO', 'Bidón', 'bid', 'Envases y empaques'],
  ['CJ', 'Cono', 'cono', 'Envases y empaques'],
  ['RM', 'Resma', 'rsm', 'Envases y empaques'],
  // Construcción y materiales
  ['SA', 'Saco', 'sco', 'Construcción y materiales'],
  ['ST', 'Plancha / pliego', 'pln', 'Construcción y materiales'],
  ['RD', 'Varilla', 'var', 'Construcción y materiales'],
  ['BR', 'Barra', 'bar', 'Construcción y materiales'],
  ['SR', 'Tira', 'tir', 'Construcción y materiales'],
  ['BD', 'Tabla', 'tbl', 'Construcción y materiales'],
  ['PG', 'Placa', 'plc', 'Construcción y materiales'],
  ['TU', 'Tubo', 'tub', 'Construcción y materiales'],
  ['LEF', 'Hoja', 'hja', 'Construcción y materiales'],
  // Servicios y alquiler
  ['ZZ', 'Servicio', 'serv', 'Servicios y alquiler'],
  ['HUR', 'Hora de servicio', 'h', 'Servicios y alquiler'],
  ['DAY', 'Día de alquiler', 'día', 'Servicios y alquiler'],
  ['KWH', 'Kilovatio hora', 'kWh', 'Servicios y alquiler'],
  ['MWH', 'Megavatio hora', 'MWh', 'Servicios y alquiler'],
];

export const UNIDADES_AMIGABLES: UnidadAmigable[] = BASE.map(([codigo, nombre, abreviatura, grupo]) => ({
  codigo,
  nombre,
  abreviatura,
  grupo,
  frecuente: UNIDADES_FRECUENTES.includes(codigo),
  visible: !UNIDADES_OCULTAS.includes(codigo),
}));
