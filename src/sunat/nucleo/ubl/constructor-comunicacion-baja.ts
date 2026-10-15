import { PLAZOS_ENVIO_DIAS } from '../../catalogos/sunat.catalogos';
import { BajaInvalidaError } from '../errores-nucleo';
import { diasEntre, esFechaIso, resolverHoy } from '../fechas-fiscales';
import { leerIdentificadorResumen, nombreArchivoResumen, NUMERO_MAXIMO_CPE, PATRON_SERIE_FACTURA } from '../identificadores-cpe';
import { PATRON_CARACTERES_CONTROL } from '../validacion/base-validacion';
import { el, EscritorXml, NodoXml } from '../xml/escritor-xml';
import type { ResultadoResumenUbl } from './constructor-resumen-diario';
import { atributosRaizUbl, ESPACIOS_UBL } from './espacios-ubl';
import { FragmentosUbl21 } from './fragmentos-ubl';

/** Factura y sus notas: las boletas se anulan por resumen diario (condición 3). */
export type TipoDocumentoBaja = '01' | '07' | '08';

export interface LineaComunicacionBaja {
  numeroLinea: number;
  tipoDocumento: TipoDocumentoBaja;
  serie: string;
  numero: number;
  /** Motivo de la baja (1 a 100 caracteres). */
  motivo: string;
}

export interface DatosComunicacionBaja {
  /** RA-YYYYMMDD-NNNNN con la fecha de GENERACIÓN (use identificadorResumen('RA', fechaGeneracion, n)). */
  identificador: string;
  fechaGeneracion: string;
  /** Fecha de emisión común a todos los documentos que se dan de baja (cbc:ReferenceDate). */
  fechaEmisionDocumentos: string;
  emisor: { ruc: string; razonSocial: string };
  lineas: LineaComunicacionBaja[];
}

export const MAXIMO_LINEAS_BAJA = 500;
const LONGITUD_MAXIMA_MOTIVO = 100;
const TIPOS_BAJA = new Set(['01', '07', '08']);

/**
 * La comunicación de baja se presenta hasta el 7.º día calendario contado
 * desde el día siguiente a la emisión: con emisión el día D, vale de D a D+7
 * (hora de Lima).
 */
export function bajaDentroDePlazo(fechaEmision: string, hoy?: string | Date): boolean {
  if (!esFechaIso(fechaEmision)) return false;
  const dias = diasEntre(fechaEmision, resolverHoy(hoy ?? null));
  return dias >= 0 && dias <= PLAZOS_ENVIO_DIAS.comunicacionBaja;
}

/**
 * Comunicación de baja (VoidedDocuments, UBL 2.0, CustomizationID 1.0),
 * enviada por sendSummary. Todas las líneas comparten la fecha de emisión y
 * deben ser series F; el ID y el nombre del archivo llevan la fecha de generación.
 */
export class ConstructorComunicacionBajaUbl {
  constructor(
    private readonly fragmentos: FragmentosUbl21 = new FragmentosUbl21(),
    private readonly escritor: EscritorXml = new EscritorXml(),
  ) {}

  validar(datos: DatosComunicacionBaja): string[] {
    const errores: string[] = [];
    if (!datos || typeof datos !== 'object') return ['No se recibieron los datos de la comunicación de baja.'];

    const partes = leerIdentificadorResumen(datos.identificador);
    if (!partes || partes.prefijo !== 'RA') {
      errores.push(`El identificador "${String(datos.identificador)}" no tiene el formato RA-YYYYMMDD-N.`);
    } else if (partes.fecha !== datos.fechaGeneracion) {
      errores.push(`El identificador ${datos.identificador} debe llevar la fecha de generación (${datos.fechaGeneracion}).`);
    }

    if (!esFechaIso(datos.fechaGeneracion)) errores.push('La fecha de generación de la baja no es válida (yyyy-mm-dd).');
    if (!esFechaIso(datos.fechaEmisionDocumentos)) errores.push('La fecha de emisión de los documentos no es válida (yyyy-mm-dd).');
    if (esFechaIso(datos.fechaGeneracion) && esFechaIso(datos.fechaEmisionDocumentos)) {
      if (datos.fechaGeneracion < datos.fechaEmisionDocumentos) {
        errores.push('La fecha de generación de la baja no puede ser anterior a la emisión de los documentos.');
      } else if (!bajaDentroDePlazo(datos.fechaEmisionDocumentos, datos.fechaGeneracion)) {
        errores.push(
          `La comunicación de baja vence a los ${PLAZOS_ENVIO_DIAS.comunicacionBaja} días calendario de la emisión (${datos.fechaEmisionDocumentos}); fuera de plazo debe emitirse una nota de crédito.`,
        );
      }
    }

    // Solo el formato: el dígito verificador ya se validó al configurar el emisor.
    if (!/^\d{11}$/.test(String(datos.emisor?.ruc ?? ''))) errores.push('El RUC del emisor debe tener 11 dígitos.');
    if (!String(datos.emisor?.razonSocial ?? '').trim()) errores.push('Falta la razón social del emisor.');

    const lineas = Array.isArray(datos.lineas) ? datos.lineas : [];
    if (lineas.length === 0) errores.push('La comunicación de baja debe tener al menos una línea.');
    if (lineas.length > MAXIMO_LINEAS_BAJA) errores.push(`La comunicación de baja admite como máximo ${MAXIMO_LINEAS_BAJA} líneas.`);

    const vistos = new Set<string>();
    const numerosLinea = new Set<number>();
    lineas.forEach((linea, indice) => {
      const etiqueta = `Línea ${indice + 1}`;
      if (!linea || typeof linea !== 'object') {
        errores.push(`${etiqueta}: la línea está vacía.`);
        return;
      }
      if (!Number.isInteger(linea.numeroLinea) || linea.numeroLinea < 1 || numerosLinea.has(linea.numeroLinea)) {
        errores.push(`${etiqueta}: el número de línea debe ser un entero positivo y único.`);
      }
      numerosLinea.add(linea.numeroLinea);
      if (!TIPOS_BAJA.has(linea.tipoDocumento)) errores.push(`${etiqueta}: solo se dan de baja facturas (01) y sus notas (07, 08).`);
      const serie = String(linea.serie ?? '');
      if (!PATRON_SERIE_FACTURA.test(serie)) {
        errores.push(
          /^B/i.test(serie)
            ? `${etiqueta}: la serie ${serie} es de boleta; las boletas y sus notas se anulan por resumen diario (condición 3), no por comunicación de baja.`
            : `${etiqueta}: la serie "${serie}" no es válida (F seguida de 3 letras o dígitos).`,
        );
      }
      if (!Number.isInteger(linea.numero) || linea.numero < 1 || linea.numero > NUMERO_MAXIMO_CPE) {
        errores.push(`${etiqueta}: el número del documento debe ser un entero entre 1 y ${NUMERO_MAXIMO_CPE}.`);
      }
      const clave = `${linea.tipoDocumento}-${serie}-${linea.numero}`;
      if (vistos.has(clave)) errores.push(`${etiqueta}: el documento ${serie}-${linea.numero} está repetido.`);
      vistos.add(clave);
      const motivo = String(linea.motivo ?? '').trim();
      if (!motivo) errores.push(`${etiqueta}: falta el motivo de la baja.`);
      else if (motivo.length > LONGITUD_MAXIMA_MOTIVO) errores.push(`${etiqueta}: el motivo supera los ${LONGITUD_MAXIMA_MOTIVO} caracteres.`);
      if (PATRON_CARACTERES_CONTROL.test(String(linea.motivo ?? ''))) errores.push(`${etiqueta}: el motivo contiene caracteres de control.`);
    });
    return errores;
  }

  construir(datos: DatosComunicacionBaja): ResultadoResumenUbl {
    const errores = this.validar(datos);
    if (errores.length > 0) throw new BajaInvalidaError(`La comunicación de baja no es válida: ${errores.join(' | ')}`, errores);

    const raiz = el(
      'VoidedDocuments',
      atributosRaizUbl(ESPACIOS_UBL.voidedDocuments, true),
      this.fragmentos.extensionesParaFirma(),
      el('cbc:UBLVersionID', null, '2.0'),
      el('cbc:CustomizationID', null, '1.0'),
      el('cbc:ID', null, datos.identificador),
      el('cbc:ReferenceDate', null, datos.fechaEmisionDocumentos),
      el('cbc:IssueDate', null, datos.fechaGeneracion),
      this.fragmentos.firma(datos.emisor),
      this.fragmentos.proveedorResumen(datos.emisor),
      datos.lineas.map((linea) => this.linea(linea)),
    );
    return {
      xml: this.escritor.serializar(raiz),
      identificador: datos.identificador,
      nombreBase: nombreArchivoResumen(datos.emisor.ruc, datos.identificador),
    };
  }

  private linea(linea: LineaComunicacionBaja): NodoXml {
    return el(
      'sac:VoidedDocumentsLine',
      null,
      el('cbc:LineID', null, linea.numeroLinea),
      el('cbc:DocumentTypeCode', null, linea.tipoDocumento),
      el('sac:DocumentSerialID', null, linea.serie),
      el('sac:DocumentNumberID', null, linea.numero),
      el('sac:VoidReasonDescription', null, String(linea.motivo).trim()),
    );
  }
}
