import { DOMParser } from '@xmldom/xmldom';
import { XmlInvalidoError } from '../errores-nucleo';

/**
 * Lectura de XML sin depender de prefijos ni de espacios de nombres: SUNAT
 * cambia los prefijos entre servidores (soap-env, S, ns2, ar…) y a veces
 * agrega atributos (<cbc:ResponseCode listAgencyName="PE:SUNAT">). Todo se
 * busca por nombre local sobre el DOM, nunca con expresiones regulares.
 */

const ELEMENTO = 1;
const TEXTO = 3;
const CDATA = 4;

/** Las respuestas externas nunca traen DTD: se rechazan para evitar expansión de entidades. */
const PATRON_DOCTYPE = /<!DOCTYPE/i;

/** Parsea y lanza XmlInvalidoError si el XML está mal formado. */
export function parsearXml(xml: string, contexto = 'XML'): Document {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new XmlInvalidoError(`${contexto}: el documento está vacío.`);
  }
  if (PATRON_DOCTYPE.test(xml)) {
    throw new XmlInvalidoError(`${contexto}: no se admiten declaraciones DOCTYPE.`);
  }
  const errores: string[] = [];
  const registrar = (mensaje: unknown) => errores.push(String(mensaje).trim());
  const documento = new DOMParser({
    errorHandler: { warning: () => undefined, error: registrar, fatalError: registrar },
  }).parseFromString(xml, 'text/xml');

  if (errores.length > 0 || !documento?.documentElement) {
    throw new XmlInvalidoError(`${contexto} mal formado: ${errores[0] ?? 'no tiene elemento raíz'}`);
  }
  return documento;
}

/** Igual que parsearXml pero devuelve null en vez de lanzar (respuestas de terceros). */
export function intentarParsearXml(xml: string): Document | null {
  try {
    return parsearXml(xml);
  } catch {
    return null;
  }
}

export function esElemento(nodo: Node | null | undefined): nodo is Element {
  return !!nodo && nodo.nodeType === ELEMENTO;
}

export function nombreLocal(nodo: Element): string {
  return nodo.localName || nodo.nodeName.replace(/^.*:/, '');
}

/** Hijos directos con ese nombre local. */
export function hijos(padre: Element | Document, nombre?: string): Element[] {
  const resultado: Element[] = [];
  const lista = padre.childNodes;
  for (let i = 0; i < lista.length; i++) {
    const nodo = lista.item(i);
    if (esElemento(nodo) && (nombre === undefined || nombreLocal(nodo) === nombre)) resultado.push(nodo);
  }
  return resultado;
}

/** Todos los descendientes con ese nombre local, en orden de documento. */
export function descendientes(raiz: Element | Document, nombre: string): Element[] {
  const resultado: Element[] = [];
  const pendientes: Node[] = [];
  const agregarHijos = (nodo: Node) => {
    const lista = nodo.childNodes;
    for (let i = lista.length - 1; i >= 0; i--) pendientes.push(lista.item(i));
  };
  agregarHijos(raiz);
  while (pendientes.length > 0) {
    const nodo = pendientes.pop()!;
    if (!esElemento(nodo)) continue;
    if (nombreLocal(nodo) === nombre) resultado.push(nodo);
    agregarHijos(nodo);
  }
  return resultado;
}

export function primerDescendiente(raiz: Element | Document, nombre: string): Element | null {
  return descendientes(raiz, nombre)[0] ?? null;
}

/**
 * Sigue una ruta de nombres locales: el primero se busca como descendiente y
 * los siguientes como hijos directos. ruta(doc, 'DocumentResponse', 'Response', 'ResponseCode').
 */
export function ruta(raiz: Element | Document, primero: string, ...siguientes: string[]): Element | null {
  for (const inicio of descendientes(raiz, primero)) {
    let actual: Element | null = inicio;
    for (const nombre of siguientes) {
      actual = actual ? hijos(actual, nombre)[0] ?? null : null;
    }
    if (actual) return actual;
  }
  return null;
}

/** Texto de un elemento (concatenando texto y CDATA de sus descendientes), sin espacios en los extremos. */
export function texto(elemento: Element | null | undefined): string {
  if (!elemento) return '';
  let resultado = '';
  const recorrer = (nodo: Node) => {
    const lista = nodo.childNodes;
    for (let i = 0; i < lista.length; i++) {
      const hijo = lista.item(i);
      if (hijo.nodeType === TEXTO || hijo.nodeType === CDATA) resultado += hijo.nodeValue ?? '';
      else if (esElemento(hijo)) recorrer(hijo);
    }
  };
  recorrer(elemento);
  return resultado.trim();
}

/** true si el elemento no tiene hijos elemento ni texto significativo. */
export function estaVacio(elemento: Element): boolean {
  return hijos(elemento).length === 0 && texto(elemento) === '';
}
