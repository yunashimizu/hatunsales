import type { ObservacionSunat } from '../documento-fiscal.types';
import { decodificarXml, descendientes, hijos, intentarParsearXml, nombreLocal, quitarBom, ruta, texto } from '../xml/lector-xml';
import { leerCdr, type EstadoCdr } from './lector-cdr';

/**
 * Comprueba que una constancia (CDR) corresponda al comprobante que se envió antes de darla por
 * buena. Hace falta porque con 1033/2109 («registrado previamente») o al recuperar por getStatusCdr
 * SUNAT puede devolver la constancia de OTRO documento con la misma serie y número (p. ej. una serie
 * usada antes con otro sistema). El resultado SIEMPRE trae el ResponseCode: coincidir no significa
 * aceptado (un CDR de rechazo también coincide).
 *
 * Estructura (Manual del Programador, anexo 1, y CDR reales de BETA): SenderParty = SUNAT
 * (20131312955), ReceiverParty = RUC del emisor, DocumentResponse/Response/ReferenceID y
 * DocumentReference/ID = SERIE-NUMERO (BETA lo manda con ceros: «FB01-00000001») y
 * RecipientParty = «<tipo>-<número>» del adquirente, donde SUNAT no respeta el tipo enviado
 * (una boleta con adquirente 0/«-» vuelve como «6--»).
 */

export interface ComprobanteEsperadoCdr {
  rucEmisor: string;
  /** Catálogo 01. */
  tipo: string;
  serie: string;
  numero: number;
  /** RUC-TT-SERIE-NNNNNNNN del envío; si llega el nombre del archivo del CDR se compara con R-<nombreBase>. */
  nombreBase?: string;
  /** Catálogo 06 y número del adquirente; '0'/'-' o ausente cuando no aplica. */
  tipoDocReceptor?: string | null;
  numDocReceptor?: string | null;
}

export interface VerificacionCdr {
  coincide: boolean;
  /** Por qué no coincide (texto para el usuario y la auditoría). */
  motivo?: string;
  /** ResponseCode del CDR ('ERROR' si no se pudo leer). */
  codigo: string;
  descripcion: string;
  estado: EstadoCdr;
  observaciones: ObservacionSunat[];
}

/** RUC de SUNAT: emite y firma todas las constancias; nunca cuenta como emisor del comprobante. */
const RUC_SUNAT = '20131312955';

/** «F001-00000012» y «F001-12» son el mismo documento. */
function normalizarSerieNumero(valor: string): string {
  const coincidencia = /^([A-Z0-9]{4})-0*(\d+)$/i.exec((valor ?? '').trim());
  return coincidencia ? `${coincidencia[1].toUpperCase()}-${coincidencia[2]}` : (valor ?? '').trim().toUpperCase();
}

/** «R-20610206337-01-F001-00000012» y «r-20610206337-01-f001-12» son el mismo nombre. */
function normalizarNombreArchivo(valor: string): string {
  const limpio = (valor ?? '').trim();
  const partes = /^(R-)?(\d{11})-(\d{2})-([A-Z0-9]{4})-0*(\d+)$/i.exec(limpio);
  return partes ? `${(partes[1] ?? '').toUpperCase()}${partes[2]}-${partes[3]}-${partes[4].toUpperCase()}-${partes[5]}` : limpio.toUpperCase();
}

function idsDeParte(raiz: Element | Document, nombreParte: string): string[] {
  return descendientes(raiz, nombreParte)
    .flatMap((parte) => descendientes(parte, 'PartyIdentification'))
    .flatMap((identificacion) => hijos(identificacion, 'ID'))
    .map((elemento) => texto(elemento))
    .filter((valor) => valor !== '');
}

/** RUC de 11 dígitos de una parte: «20610206337», y por tolerancia también «R-20610206337» o «6-20610206337». */
function rucDeParte(valor: string): string | null {
  return /(?:^|-)(\d{11})$/.exec(valor.trim())?.[1] ?? null;
}

/** Número del adquirente sin el tipo: «6-20131312955» → «20131312955»; «-» y «6--» → '' (sin documento). */
function numeroDeAdquirente(valor: string): string {
  const limpio = valor.trim();
  const sinTipo = /^[^-]{1,2}-(.*)$/.exec(limpio)?.[1] ?? limpio;
  return sinTipo.trim() === '-' ? '' : sinTipo.trim().toUpperCase();
}

export function verificarCdr(
  cdrXml: string | Buffer,
  esperado: ComprobanteEsperadoCdr,
  nombreArchivoCdr?: string | null,
): VerificacionCdr {
  const xml = Buffer.isBuffer(cdrXml) ? decodificarXml(cdrXml) : quitarBom(String(cdrXml ?? ''));
  const leido = leerCdr(xml);
  const base = {
    codigo: leido.codigo,
    descripcion: leido.descripcion,
    estado: leido.estado,
    observaciones: leido.observaciones,
  };
  const falla = (motivo: string): VerificacionCdr => ({ ...base, coincide: false, motivo });

  if (leido.codigo === 'ERROR') return falla('La constancia (CDR) de SUNAT no se pudo leer.');
  const documento = intentarParsearXml(xml);
  const raiz = documento?.documentElement;
  if (!documento || !raiz || nombreLocal(raiz) !== 'ApplicationResponse') {
    return falla('La constancia (CDR) de SUNAT no se pudo leer.');
  }

  const esperadoSerieNumero = normalizarSerieNumero(`${esperado.serie}-${esperado.numero}`);
  const respuesta = ruta(documento, 'DocumentResponse', 'Response');
  const referencia = ruta(documento, 'DocumentResponse', 'DocumentReference');
  const referencias = [
    texto(respuesta ? hijos(respuesta, 'ReferenceID')[0] : null),
    texto(referencia ? hijos(referencia, 'ID')[0] : null),
  ].filter((valor) => valor !== '');
  if (referencias.length === 0) return falla('La constancia (CDR) no indica a qué comprobante responde.');
  const otra = referencias.find((valor) => normalizarSerieNumero(valor) !== esperadoSerieNumero);
  if (otra) {
    return falla(`La constancia (CDR) es del comprobante ${otra} y no de ${esperado.serie}-${esperado.numero}.`);
  }

  const tipoReferencia = texto(referencia ? hijos(referencia, 'DocumentTypeCode')[0] : null);
  if (tipoReferencia && tipoReferencia !== esperado.tipo) {
    return falla(`La constancia (CDR) es de un documento tipo ${tipoReferencia} y no ${esperado.tipo}.`);
  }

  // El emisor va en ReceiverParty y SUNAT en SenderParty; se aceptan ambas posiciones (por si SUNAT
  // invierte los papeles) pero el RUC de SUNAT se descarta: si no, cualquier CDR «traería» un emisor.
  const emisores = [...new Set([...idsDeParte(raiz, 'ReceiverParty'), ...idsDeParte(raiz, 'SenderParty')].map(rucDeParte))]
    .filter((ruc): ruc is string => ruc !== null && ruc !== RUC_SUNAT);
  const rucEmisor = String(esperado.rucEmisor ?? '').trim();
  if (emisores.length > 0 && !emisores.includes(rucEmisor)) {
    return falla(`La constancia (CDR) es de otro emisor (RUC ${emisores.join(', ')}).`);
  }

  // Solo se compara el número: SUNAT no repite el tipo de documento enviado en RecipientParty.
  const adquirente = idsDeParte(documento, 'RecipientParty')[0];
  const numeroReceptor = String(esperado.numDocReceptor ?? '').trim().toUpperCase();
  const tipoReceptor = String(esperado.tipoDocReceptor ?? '').trim();
  if (adquirente && numeroReceptor && numeroReceptor !== '-' && tipoReceptor && tipoReceptor !== '0') {
    const numeroCdr = numeroDeAdquirente(adquirente);
    if (numeroCdr && numeroCdr !== numeroReceptor) {
      return falla(`La constancia (CDR) es de otro adquirente (${adquirente}).`);
    }
  }

  if (nombreArchivoCdr && esperado.nombreBase) {
    const nombre = nombreArchivoCdr.trim().replace(/^.*[\\/]/, '').replace(/\.(xml|zip)$/i, '');
    if (normalizarNombreArchivo(nombre) !== normalizarNombreArchivo(`R-${esperado.nombreBase.trim()}`)) {
      return falla(`El archivo de la constancia (${nombreArchivoCdr}) no corresponde a ${esperado.nombreBase}.`);
    }
  }

  return { ...base, coincide: true };
}
