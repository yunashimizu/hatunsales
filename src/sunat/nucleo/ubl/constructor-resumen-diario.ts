import { CATALOGO_06_TIPOS_VALIDOS, PLAZOS_ENVIO_DIAS } from '../../catalogos/sunat.catalogos';
import { Dinero } from '../decimal';
import type { MonedaCpe } from '../documento-fiscal.types';
import { ResumenInvalidoError } from '../errores-nucleo';
import { diasEntre, esFechaIso } from '../fechas-fiscales';
import { identificadorCpe, leerIdentificadorResumen, nombreArchivoResumen, NUMERO_MAXIMO_CPE, PATRON_SERIE_BOLETA } from '../identificadores-cpe';
import { errorImporte } from '../validacion/base-validacion';
import { el, EscritorXml, NodoXml } from '../xml/escritor-xml';
import { atributosRaizUbl, ESPACIOS_UBL } from './espacios-ubl';
import { FragmentosUbl21 } from './fragmentos-ubl';

/** Catálogo 19: 1 adicionar, 2 modificar, 3 anular. */
export type CondicionLineaResumen = 1 | 2 | 3;
/** Boleta, nota de crédito o nota de débito vinculadas a boletas. */
export type TipoDocumentoResumen = '03' | '07' | '08';

export interface LineaResumenDiario {
  numeroLinea: number;
  tipoDocumento: TipoDocumentoResumen;
  serie: string;
  numero: number;
  tipoDocumentoCliente: string;
  numeroDocumentoCliente: string;
  gravada: number;
  exonerada: number;
  inafecta: number;
  gratuita: number;
  igv: number;
  isc?: number;
  otrosTributos?: number;
  total: number;
  estado: CondicionLineaResumen;
  /** Solo para notas (07/08): la boleta (03) o el ticket (12) que modifican. */
  documentoModificado?: { tipoDocumento: '03' | '12'; serie: string; numero: number };
  /** Moneda del documento (por omisión PEN). */
  moneda?: MonedaCpe;
  /** Fecha de emisión del documento (yyyy-mm-dd); si llega debe ser la del resumen. */
  fechaEmision?: string;
}

export interface DatosResumenDiario {
  /** RC-YYYYMMDD-NNNNN con la fecha de GENERACIÓN (use identificadorResumen('RC', fechaGeneracion, n)). */
  identificador: string;
  /** yyyy-mm-dd: día en que se genera y envía (cbc:IssueDate). */
  fechaGeneracion: string;
  /** yyyy-mm-dd: día de emisión de TODAS las boletas del resumen (cbc:ReferenceDate). */
  fechaEmisionDocumentos: string;
  emisor: { ruc: string; razonSocial: string };
  lineas: LineaResumenDiario[];
}

export interface ResultadoResumenUbl {
  xml: string;
  identificador: string;
  /** RUC-RC-YYYYMMDD-NNNNN: nombre del .xml y del .zip, idéntico al cbc:ID. */
  nombreBase: string;
}

export const MAXIMO_LINEAS_RESUMEN = 500;

const TIPOS_RESUMEN = new Set(['03', '07', '08']);
const CONDICIONES = new Set([1, 2, 3]);
const PATRON_SERIE_TICKET = /^[A-Z0-9]{1,20}$/;

/**
 * Resumen diario de boletas y sus notas (SummaryDocuments, UBL 2.0,
 * CustomizationID 1.1), enviado por sendSummary. El ID y el nombre del
 * archivo llevan la fecha de generación; ReferenceDate, la de emisión.
 */
export class ConstructorResumenDiarioUbl {
  constructor(
    private readonly fragmentos: FragmentosUbl21 = new FragmentosUbl21(),
    private readonly escritor: EscritorXml = new EscritorXml(),
  ) {}

  /** Errores que impiden enviar el resumen (lista vacía = válido). */
  validar(datos: DatosResumenDiario): string[] {
    const errores: string[] = [];
    if (!datos || typeof datos !== 'object') return ['No se recibieron los datos del resumen diario.'];

    const partes = leerIdentificadorResumen(datos.identificador);
    if (!partes || partes.prefijo !== 'RC') {
      errores.push(`El identificador "${String(datos.identificador)}" no tiene el formato RC-YYYYMMDD-N.`);
    } else if (partes.fecha !== datos.fechaGeneracion) {
      errores.push(`El identificador ${datos.identificador} debe llevar la fecha de generación (${datos.fechaGeneracion}), no la de emisión de las boletas.`);
    }

    const fechasValidas = esFechaIso(datos.fechaGeneracion) && esFechaIso(datos.fechaEmisionDocumentos);
    if (!esFechaIso(datos.fechaGeneracion)) errores.push('La fecha de generación del resumen no es válida (yyyy-mm-dd).');
    if (!esFechaIso(datos.fechaEmisionDocumentos)) errores.push('La fecha de emisión de los documentos no es válida (yyyy-mm-dd).');
    if (fechasValidas) {
      const dias = diasEntre(datos.fechaEmisionDocumentos, datos.fechaGeneracion);
      if (dias < 0) errores.push('La fecha de generación del resumen no puede ser anterior a la de emisión de los documentos.');
      else if (dias > PLAZOS_ENVIO_DIAS.resumenDiario) {
        errores.push(`El resumen diario se envía hasta ${PLAZOS_ENVIO_DIAS.resumenDiario} días calendario después de la emisión (RS 114-2019); van ${dias} días.`);
      }
    }

    // Solo el formato: el dígito verificador ya se validó al configurar el emisor.
    if (!/^\d{11}$/.test(String(datos.emisor?.ruc ?? ''))) errores.push('El RUC del emisor debe tener 11 dígitos.');
    if (!String(datos.emisor?.razonSocial ?? '').trim()) errores.push('Falta la razón social del emisor.');

    const lineas = Array.isArray(datos.lineas) ? datos.lineas : [];
    if (lineas.length === 0) errores.push('El resumen diario debe tener al menos una línea.');
    if (lineas.length > MAXIMO_LINEAS_RESUMEN) errores.push(`El resumen diario admite como máximo ${MAXIMO_LINEAS_RESUMEN} líneas (tiene ${lineas.length}).`);

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
      if (!TIPOS_RESUMEN.has(linea.tipoDocumento)) errores.push(`${etiqueta}: el tipo de documento debe ser 03, 07 u 08.`);
      if (!PATRON_SERIE_BOLETA.test(String(linea.serie ?? ''))) {
        errores.push(`${etiqueta}: la serie "${String(linea.serie)}" debe empezar con B (el resumen solo informa boletas y sus notas).`);
      }
      if (!Number.isInteger(linea.numero) || linea.numero < 1 || linea.numero > NUMERO_MAXIMO_CPE) {
        errores.push(`${etiqueta}: el número del documento debe ser un entero entre 1 y ${NUMERO_MAXIMO_CPE}.`);
      }
      const clave = `${linea.tipoDocumento}-${linea.serie}-${linea.numero}`;
      if (vistos.has(clave)) errores.push(`${etiqueta}: el documento ${linea.serie}-${linea.numero} está repetido en el resumen.`);
      vistos.add(clave);
      if (!CONDICIONES.has(linea.estado)) errores.push(`${etiqueta}: la condición debe ser 1 (adicionar), 2 (modificar) o 3 (anular).`);
      if (!CATALOGO_06_TIPOS_VALIDOS.has(String(linea.tipoDocumentoCliente ?? '').trim())) {
        errores.push(`${etiqueta}: el tipo de documento del adquirente no existe en el catálogo 06.`);
      }
      if (linea.fechaEmision !== undefined && linea.fechaEmision !== datos.fechaEmisionDocumentos) {
        errores.push(`${etiqueta}: fue emitido el ${linea.fechaEmision}; todas las líneas deben ser del ${datos.fechaEmisionDocumentos}.`);
      }
      const importes: Array<[string, unknown, boolean]> = [
        ['gravado', linea.gravada, false],
        ['exonerado', linea.exonerada, false],
        ['inafecto', linea.inafecta, false],
        ['gratuito', linea.gratuita, false],
        ['IGV', linea.igv, false],
        ['ISC', linea.isc ?? 0, false],
        ['otros tributos', linea.otrosTributos ?? 0, false],
        ['total', linea.total, true],
      ];
      for (const [campo, valor, positivo] of importes) {
        const motivo = errorImporte(valor, { positivo });
        if (motivo) errores.push(`${etiqueta}: el importe ${campo} ${motivo}.`);
      }
      if (linea.tipoDocumento === '07' || linea.tipoDocumento === '08') {
        const modificado = linea.documentoModificado;
        const serieValida = modificado?.tipoDocumento === '12' ? PATRON_SERIE_TICKET : PATRON_SERIE_BOLETA;
        if (!modificado || !serieValida.test(String(modificado.serie ?? '')) || !Number.isInteger(modificado.numero) || modificado.numero < 1) {
          errores.push(`${etiqueta}: la nota debe indicar la boleta que modifica (tipo 03 o 12, serie y número).`);
        }
      }
    });
    return errores;
  }

  construir(datos: DatosResumenDiario): ResultadoResumenUbl {
    const errores = this.validar(datos);
    if (errores.length > 0) throw new ResumenInvalidoError(`El resumen diario no es válido: ${errores.join(' | ')}`, errores);

    const raiz = el(
      'SummaryDocuments',
      atributosRaizUbl(ESPACIOS_UBL.summaryDocuments, true),
      this.fragmentos.extensionesParaFirma(),
      el('cbc:UBLVersionID', null, '2.0'),
      el('cbc:CustomizationID', null, '1.1'),
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

  private linea(linea: LineaResumenDiario): NodoXml {
    const moneda = linea.moneda ?? 'PEN';
    const modificado = linea.documentoModificado;
    return el(
      'sac:SummaryDocumentsLine',
      null,
      el('cbc:LineID', null, linea.numeroLinea),
      el('cbc:DocumentTypeCode', null, linea.tipoDocumento),
      el('cbc:ID', null, identificadorCpe(linea.serie, linea.numero)),
      el(
        'cac:AccountingCustomerParty',
        null,
        el('cbc:CustomerAssignedAccountID', null, String(linea.numeroDocumentoCliente ?? '').trim() || '-'),
        el('cbc:AdditionalAccountID', null, String(linea.tipoDocumentoCliente).trim()),
      ),
      modificado
        ? el(
            'cac:BillingReference',
            null,
            el(
              'cac:InvoiceDocumentReference',
              null,
              el('cbc:ID', null, `${modificado.serie}-${String(modificado.numero).padStart(8, '0')}`),
              el('cbc:DocumentTypeCode', null, modificado.tipoDocumento),
            ),
          )
        : null,
      el('cac:Status', null, el('cbc:ConditionCode', null, linea.estado)),
      el('sac:TotalAmount', { currencyID: moneda }, Dinero.de(linea.total).toString()),
      this.pagos(linea, moneda),
      this.tributo(Dinero.de(linea.igv), { id: '1000', nombre: 'IGV', codigo: 'VAT' }, moneda),
      Dinero.de(linea.isc ?? 0).esPositivo() ? this.tributo(Dinero.de(linea.isc ?? 0), { id: '2000', nombre: 'ISC', codigo: 'EXC' }, moneda) : null,
      Dinero.de(linea.otrosTributos ?? 0).esPositivo()
        ? this.tributo(Dinero.de(linea.otrosTributos ?? 0), { id: '9999', nombre: 'OTROS', codigo: 'OTH' }, moneda)
        : null,
    );
  }

  /** sac:BillingPayment por tipo de operación con importe (01 gravado, 02 exonerado, 03 inafecto, 05 gratuito). */
  private pagos(linea: LineaResumenDiario, moneda: MonedaCpe): NodoXml[] {
    const conceptos: Array<[string, number]> = [
      ['01', linea.gravada],
      ['02', linea.exonerada],
      ['03', linea.inafecta],
      ['05', linea.gratuita],
    ];
    const conImporte = conceptos.filter(([, monto]) => Dinero.de(monto ?? 0).esPositivo());
    const informar = conImporte.length > 0 ? conImporte : [conceptos[0]];
    return informar.map(([instruccion, monto]) =>
      el(
        'sac:BillingPayment',
        null,
        el('cbc:PaidAmount', { currencyID: moneda }, Dinero.de(monto ?? 0).toString()),
        el('cbc:InstructionID', null, instruccion),
      ),
    );
  }

  private tributo(monto: Dinero, esquema: { id: string; nombre: string; codigo: string }, moneda: MonedaCpe): NodoXml {
    return el(
      'cac:TaxTotal',
      null,
      el('cbc:TaxAmount', { currencyID: moneda }, monto.toString()),
      el(
        'cac:TaxSubtotal',
        null,
        el('cbc:TaxAmount', { currencyID: moneda }, monto.toString()),
        el(
          'cac:TaxCategory',
          null,
          el('cac:TaxScheme', null, el('cbc:ID', null, esquema.id), el('cbc:Name', null, esquema.nombre), el('cbc:TaxTypeCode', null, esquema.codigo)),
        ),
      ),
    );
  }
}
