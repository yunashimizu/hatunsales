/**
 * Escritor XML mínimo para los documentos UBL. Los builders describen el
 * árbol con `el(...)` y el escritor se encarga del escape: ningún texto
 * (razón social, descripción, motivo) puede romper el XML ni inyectar
 * elementos, porque nunca se concatena sin escapar.
 */

export type ValorAtributoXml = string | number | boolean | null | undefined;
export type AtributosXml = Readonly<Record<string, ValorAtributoXml>>;
export type HijoXml = NodoXml | string | number | null | undefined | false | readonly HijoXml[];

export class NodoXml {
  readonly hijos: readonly (NodoXml | string)[];

  constructor(
    readonly nombre: string,
    readonly atributos: AtributosXml = {},
    hijos: readonly HijoXml[] = [],
  ) {
    this.hijos = aplanar(hijos);
  }
}

function aplanar(hijos: readonly HijoXml[]): (NodoXml | string)[] {
  const resultado: (NodoXml | string)[] = [];
  for (const hijo of hijos) {
    if (hijo === null || hijo === undefined || hijo === false) continue;
    if (Array.isArray(hijo)) resultado.push(...aplanar(hijo));
    else if (hijo instanceof NodoXml) resultado.push(hijo);
    else resultado.push(String(hijo));
  }
  return resultado;
}

/** Crea un elemento: el('cbc:ID', { schemeID: '6' }, '20610206337'). Los hijos null/undefined/false se omiten. */
export function el(nombre: string, atributos?: AtributosXml | null, ...hijos: HijoXml[]): NodoXml {
  return new NodoXml(nombre, atributos ?? {}, hijos);
}

/** Caracteres prohibidos en XML 1.0 (controles C0 salvo tab/LF/CR y sustitutos sueltos). */
const CARACTERES_INVALIDOS_XML =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Quita los caracteres que harían inválido el XML y unifica los saltos de línea. */
export function limpiarTextoXml(texto: string): string {
  return texto.replace(/\r\n?/g, '\n').replace(CARACTERES_INVALIDOS_XML, '');
}

export function escaparXml(texto: string): string {
  return limpiarTextoXml(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface OpcionesSerializacion {
  /** Incluir <?xml version="1.0" encoding="UTF-8"?> (por omisión, sí). */
  declaracion?: boolean;
}

export class EscritorXml {
  constructor(private readonly sangria = '  ') {}

  serializar(raiz: NodoXml, opciones: OpcionesSerializacion = {}): string {
    const lineas: string[] = [];
    if (opciones.declaracion !== false) lineas.push('<?xml version="1.0" encoding="UTF-8"?>');
    this.escribir(raiz, 0, lineas);
    return lineas.join('\n');
  }

  private escribir(nodo: NodoXml, nivel: number, lineas: string[]): void {
    const margen = this.sangria.repeat(nivel);
    const apertura = `${margen}<${nodo.nombre}${this.atributos(nodo.atributos)}`;

    if (nodo.hijos.length === 0) {
      lineas.push(`${apertura}/>`);
      return;
    }
    if (nodo.hijos.every((hijo) => typeof hijo === 'string')) {
      const texto = (nodo.hijos as string[]).map(escaparXml).join('');
      lineas.push(`${apertura}>${texto}</${nodo.nombre}>`);
      return;
    }

    lineas.push(`${apertura}>`);
    for (const hijo of nodo.hijos) {
      if (typeof hijo === 'string') lineas.push(`${this.sangria.repeat(nivel + 1)}${escaparXml(hijo)}`);
      else this.escribir(hijo, nivel + 1, lineas);
    }
    lineas.push(`${margen}</${nodo.nombre}>`);
  }

  private atributos(atributos: AtributosXml): string {
    let texto = '';
    for (const [nombre, valor] of Object.entries(atributos)) {
      if (valor === null || valor === undefined || valor === false) continue;
      texto += ` ${nombre}="${escaparXml(String(valor))}"`;
    }
    return texto;
  }
}
