/**
 * Código de producto SUNAT (catálogo 25, UNSPSC v14_0801) genérico por categoría de ferretería.
 *
 * Desde el 1/1/2027 SUNAT valida que cada línea lleve su código de producto de 8 dígitos (ERR-3496 / ERR-3506,
 * reglas de validación vigentes desde esa fecha). Una venta NUNCA se bloquea por eso: si el producto no tiene código
 * ni hay uno por defecto configurado, la línea sale con el código genérico de su categoría y el sistema avisa
 * («salió con código genérico») para que se cargue el real en Productos.
 *
 * Los códigos son de FAMILIA UNSPSC (4 dígitos + 0000), los que el equipo conoce con certeza; son deliberadamente
 * amplios. [SUPUESTO: SUNAT acepta un código de familia en la línea; no se pudo abrir el anexo oficial del catálogo 25
 * (cpe.sunat.gob.pe responde 403 desde el servidor de desarrollo). Confirmar en BETA con un comprobante de cada
 * código antes del 1/1/2027; si SUNAT exige código de clase, cambiar esta tabla (es el único lugar).]
 */

export interface CodigoGenerico {
  /** 8 dígitos. */
  codigo: string;
  /** Nombre en español del grupo UNSPSC. */
  nombre: string;
}

/** Último recurso: ferretería en general. */
export const CODIGO_GENERICO_GENERAL: CodigoGenerico = { codigo: '31160000', nombre: 'Ferretería' };

interface ReglaCategoria {
  /** Palabras (ya sin tildes y en minúsculas) cuya presencia en la categoría elige esta regla. */
  claves: string[];
  generico: CodigoGenerico;
}

/** El orden importa: la primera regla que coincide gana (lo más específico va primero). */
const REGLAS: readonly ReglaCategoria[] = [
  { claves: ['herramienta electric', 'herramientas electric', 'electroherramienta', 'taladro', 'amoladora', 'esmeril'], generico: { codigo: '27112700', nombre: 'Herramientas eléctricas' } },
  { claves: ['soldadura', 'soldar', 'electrodo'], generico: { codigo: '23270000', nombre: 'Soldadura y accesorios' } },
  { claves: ['abrasivo', 'lija', 'disco de corte'], generico: { codigo: '31190000', nombre: 'Abrasivos' } },
  { claves: ['herramienta', 'jardin', 'medicion'], generico: { codigo: '27110000', nombre: 'Herramientas de mano' } },
  { claves: ['pintura', 'barniz', 'esmalte', 'laca', 'thinner', 'solvente', 'brocha', 'rodillo'], generico: { codigo: '31210000', nombre: 'Pinturas, imprimantes y acabados' } },
  { claves: ['adhesivo', 'pegamento', 'sellador', 'sellante', 'silicona', 'cola'], generico: { codigo: '31200000', nombre: 'Adhesivos y selladores' } },
  { claves: ['electric', 'cable', 'interruptor', 'tomacorriente', 'enchufe', 'termomagnetic'], generico: { codigo: '39120000', nombre: 'Equipo y suministros eléctricos' } },
  { claves: ['ilumin', 'foco', 'lampara', 'luminaria', 'led'], generico: { codigo: '39100000', nombre: 'Iluminación' } },
  { claves: ['gasfiter', 'tuberia', 'tubo', 'fontaner', 'valvula', 'grifo', 'pvc'], generico: { codigo: '40140000', nombre: 'Distribución de fluidos y gas (gasfitería)' } },
  { claves: ['sanitari', 'inodoro', 'lavatorio', 'ducha', 'baño', 'bano'], generico: { codigo: '30180000', nombre: 'Artefactos sanitarios' } },
  { claves: ['piso', 'ceramic', 'porcelanato', 'acabado', 'drywall', 'cielo raso'], generico: { codigo: '30160000', nombre: 'Materiales de acabado interior' } },
  { claves: ['puerta', 'ventana', 'vidrio', 'cerradura', 'bisagra'], generico: { codigo: '30170000', nombre: 'Puertas, ventanas y vidrio' } },
  { claves: ['cemento', 'concreto', 'yeso', 'mortero', 'agregado', 'arena'], generico: { codigo: '30110000', nombre: 'Concreto, cemento y yeso' } },
  { claves: ['construccion', 'fierro', 'acero', 'varilla', 'ladrillo', 'estructura', 'techo', 'calamina'], generico: { codigo: '30100000', nombre: 'Componentes estructurales de construcción' } },
  { claves: ['seguridad', 'epp', 'proteccion', 'casco', 'guante', 'arnes', 'extintor'], generico: { codigo: '46180000', nombre: 'Seguridad y protección personal' } },
  { claves: ['limpieza', 'aseo', 'detergente', 'escoba', 'desinfectante'], generico: { codigo: '47130000', nombre: 'Limpieza y aseo' } },
  { claves: ['ferreteria', 'tornillo', 'perno', 'clavo', 'tuerca', 'fijacion', 'anclaje'], generico: CODIGO_GENERICO_GENERAL },
];

/** Minúsculas, sin tildes (la ñ se conserva como n) y con espacios simples. */
export function normalizarCategoria(texto: string | null | undefined): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Código genérico de la categoría del producto; sin categoría conocida, el de ferretería en general. */
export function codigoGenericoDeCategoria(categoria: string | null | undefined): CodigoGenerico {
  const normalizada = normalizarCategoria(categoria);
  if (!normalizada) return CODIGO_GENERICO_GENERAL;
  // La clave debe empezar una palabra («led» sí en «led 9w», no en «pulido»; «tubo» sí en «tubos»).
  const texto = ` ${normalizada}`;
  const regla = REGLAS.find((r) => r.claves.some((clave) => texto.includes(` ${normalizarCategoria(clave)}`)));
  return regla?.generico ?? CODIGO_GENERICO_GENERAL;
}

/** Las categorías que el sistema reconoce, para mostrarlas en el panel y las pruebas. */
export function categoriasConGenerico(): ReadonlyArray<{ claves: readonly string[]; generico: CodigoGenerico }> {
  return REGLAS;
}
