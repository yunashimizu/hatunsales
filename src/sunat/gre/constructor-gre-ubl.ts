import { formatearDecimal } from '../nucleo/decimal';
import { identificadorCpe, nombreBaseCpe } from '../nucleo/identificadores-cpe';
import { ESPACIOS_UBL } from '../nucleo/ubl/espacios-ubl';
import { FragmentosUbl21 } from '../nucleo/ubl/fragmentos-ubl';
import { el, EscritorXml, NodoXml } from '../nucleo/xml/escritor-xml';
import {
  CATALOGO_61_DOCUMENTOS_RELACIONADOS,
  DOCUMENTOS_RELACIONADOS_CON_SERIE,
  ID_ENVIO_GRE,
  MAXIMO_CONDUCTORES_GRE,
  MOTIVO_GRE_TRASLADO_ESTABLECIMIENTOS,
  TIPO_CONDUCTOR_PRINCIPAL,
  TIPO_CONDUCTOR_SECUNDARIO,
  TIPO_DOCUMENTO_GRE_REMITENTE,
} from './catalogos-gre';
import type {
  ConductorGre,
  DireccionGre,
  DocumentoGre,
  DocumentoRelacionadoGre,
  ItemGre,
  PersonaGre,
  TransportistaGre,
  VehiculoGre,
} from './gre.tipos';

/** Espacio de nombres de la raíz DespatchAdvice (UBL 2.1, OASIS). */
export const ESPACIO_DESPATCH_ADVICE = 'urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2';

/** Atributos de catálogo que fija el anexo N.° 14 (RS 000123-2022, con el listURI del motivo corregido por la RS 000108-2026). */
const CATALOGO_SUNAT = 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo';
const ATRIBUTOS_TIPO_DOCUMENTO = { listAgencyName: 'PE:SUNAT', listName: 'Tipo de Documento', listURI: `${CATALOGO_SUNAT}01` } as const;
const ATRIBUTOS_DOCUMENTO_IDENTIDAD = {
  schemeName: 'Documento de Identidad',
  schemeAgencyName: 'PE:SUNAT',
  schemeURI: `${CATALOGO_SUNAT}06`,
} as const;
const ATRIBUTOS_DOCUMENTO_RELACIONADO = {
  listAgencyName: 'PE:SUNAT',
  listName: 'Documento relacionado al transporte',
  listURI: `${CATALOGO_SUNAT}61`,
} as const;
const ATRIBUTOS_MOTIVO_TRASLADO = { listAgencyName: 'PE:SUNAT', listName: 'Motivo de traslado', listURI: `${CATALOGO_SUNAT}20` } as const;
const ATRIBUTOS_MODALIDAD_TRASLADO = { listName: 'Modalidad de traslado', listAgencyName: 'PE:SUNAT', listURI: `${CATALOGO_SUNAT}18` } as const;
const ATRIBUTOS_UBIGEO = { schemeAgencyName: 'PE:INEI', schemeName: 'Ubigeos' } as const;
const ATRIBUTOS_ESTABLECIMIENTO = { listAgencyName: 'PE:SUNAT', listName: 'Establecimientos anexos' } as const;
const ATRIBUTOS_UNIDAD = {
  unitCodeListID: 'UN/ECE rec 20',
  unitCodeListAgencyName: 'United Nations Economic Commission for Europe',
} as const;
const ATRIBUTOS_UNSPSC = { listID: 'UNSPSC', listAgencyName: 'GS1 US', listName: 'Item Classification' } as const;

/** [A14] peso n(12,3) y cantidad n(12,10). */
const DECIMALES_PESO = 3;
const DECIMALES_CANTIDAD = 10;

export interface ResultadoXmlGre {
  xml: string;
  /** RUC-09-SERIE-NNNNNNNN: nombre del .xml y del .zip, sin extensión. */
  nombreBase: string;
}

/** Nombre base del archivo de la GRE (anexo N.° 13, 1.4.b): el mismo para el .xml, el .zip y la URL del envío. */
export function nombreBaseGre(ruc: string, serie: string, numero: number): string {
  return nombreBaseCpe(ruc, TIPO_DOCUMENTO_GRE_REMITENTE, serie, numero);
}

function texto(valor: string | number | null | undefined): string {
  return valor === null || valor === undefined ? '' : String(valor).trim();
}

/**
 * Arma el DespatchAdvice UBL 2.1 de la GRE remitente (anexo N.° 14 de la RS 097-2012/SUNAT según la
 * RS 000123-2022 y la RS 000108-2026) con los elementos en el orden del XSD de OASIS, listo para firmar
 * (un único ext:ExtensionContent vacío). No valida reglas de negocio: recibe un documento ya validado
 * por validarDocumentoGre. Todo texto pasa por el escritor XML, que lo escapa.
 */
export class ConstructorGreUbl {
  private readonly escritor = new EscritorXml();
  private readonly fragmentos = new FragmentosUbl21();

  construir(doc: DocumentoGre): ResultadoXmlGre {
    const raiz = el(
      'DespatchAdvice',
      {
        xmlns: ESPACIO_DESPATCH_ADVICE,
        'xmlns:cac': ESPACIOS_UBL.cac,
        'xmlns:cbc': ESPACIOS_UBL.cbc,
        'xmlns:ext': ESPACIOS_UBL.ext,
        'xmlns:ds': ESPACIOS_UBL.ds,
      },
      this.fragmentos.extensionesParaFirma(),
      el('cbc:UBLVersionID', null, '2.1'),
      el('cbc:CustomizationID', null, '2.0'),
      el('cbc:ID', null, identificadorCpe(doc.serie, doc.numero)),
      el('cbc:IssueDate', null, doc.fechaEmision),
      el('cbc:IssueTime', null, doc.horaEmision),
      el('cbc:DespatchAdviceTypeCode', ATRIBUTOS_TIPO_DOCUMENTO, TIPO_DOCUMENTO_GRE_REMITENTE),
      texto(doc.observaciones) ? el('cbc:Note', null, texto(doc.observaciones)) : null,
      (doc.documentosRelacionados ?? []).map((relacionado) => this.documentoRelacionado(relacionado, doc.remitente.ruc)),
      this.fragmentos.firma(doc.remitente),
      el('cac:DespatchSupplierParty', null, this.parte({ tipoDoc: '6', numDoc: doc.remitente.ruc, nombre: doc.remitente.razonSocial })),
      el('cac:DeliveryCustomerParty', null, this.parte(doc.destinatario)),
      this.envio(doc),
      doc.items.map((item, indice) => this.linea(item, indice)),
    );
    return {
      xml: this.escritor.serializar(raiz),
      nombreBase: nombreBaseGre(doc.remitente.ruc, doc.serie, doc.numero),
    };
  }

  /** cac:AdditionalDocumentReference: ID, DocumentTypeCode (catálogo 61), DocumentType e IssuerParty (comprobantes y guías). */
  private documentoRelacionado(relacionado: DocumentoRelacionadoGre, rucRemitente: string): NodoXml {
    const tipo = texto(relacionado.tipo);
    const serie = texto(relacionado.serie).toUpperCase();
    const numero = texto(relacionado.numero);
    const conSerie = DOCUMENTOS_RELACIONADOS_CON_SERIE.has(tipo);
    const id = serie ? `${serie}-${conSerie ? numero.replace(/^0+(?=\d)/, '') : numero}` : numero;
    const rucEmisor = texto(relacionado.rucEmisor) || rucRemitente;
    return el(
      'cac:AdditionalDocumentReference',
      null,
      el('cbc:ID', null, id),
      el('cbc:DocumentTypeCode', ATRIBUTOS_DOCUMENTO_RELACIONADO, tipo),
      el('cbc:DocumentType', null, CATALOGO_61_DOCUMENTOS_RELACIONADOS[tipo] ?? tipo),
      conSerie
        ? el(
            'cac:IssuerParty',
            null,
            el('cac:PartyIdentification', null, el('cbc:ID', { schemeID: '6', ...ATRIBUTOS_DOCUMENTO_IDENTIDAD }, rucEmisor)),
          )
        : null,
    );
  }

  /** cac:Party con la identificación (catálogo 06) y la razón social. */
  private parte(persona: PersonaGre): NodoXml {
    return el(
      'cac:Party',
      null,
      el(
        'cac:PartyIdentification',
        null,
        el('cbc:ID', { schemeID: texto(persona.tipoDoc), ...ATRIBUTOS_DOCUMENTO_IDENTIDAD }, texto(persona.numDoc)),
      ),
      el('cac:PartyLegalEntity', null, el('cbc:RegistrationName', null, texto(persona.nombre))),
    );
  }

  /**
   * cac:Shipment en el orden del XSD: ID, HandlingCode, HandlingInstructions, GrossWeightMeasure,
   * TotalTransportHandlingUnitQuantity, ShipmentStage, Delivery y TransportHandlingUnit (vehículo).
   */
  private envio(doc: DocumentoGre): NodoXml {
    const { envio } = doc;
    const publico = envio.modalidad === '01';
    const bultos = envio.numeroBultos;
    return el(
      'cac:Shipment',
      null,
      el('cbc:ID', null, ID_ENVIO_GRE),
      el('cbc:HandlingCode', ATRIBUTOS_MOTIVO_TRASLADO, envio.motivo),
      texto(envio.descripcionMotivo) ? el('cbc:HandlingInstructions', null, texto(envio.descripcionMotivo)) : null,
      el('cbc:GrossWeightMeasure', { unitCode: envio.unidadPeso }, formatearDecimal(envio.pesoBrutoTotal, DECIMALES_PESO, DECIMALES_PESO)),
      bultos !== undefined && bultos !== null ? el('cbc:TotalTransportHandlingUnitQuantity', null, String(bultos)) : null,
      this.etapa(doc, publico),
      el(
        'cac:Delivery',
        null,
        this.direccion('cac:DeliveryAddress', envio.llegada, envio.motivo, doc.remitente.ruc),
        el('cac:Despatch', null, this.direccion('cac:DespatchAddress', envio.partida, envio.motivo, doc.remitente.ruc)),
      ),
      !publico && doc.vehiculo ? this.vehiculo(doc.vehiculo) : null,
    );
  }

  /**
   * cac:ShipmentStage: TransportModeCode, TransitPeriod/StartDate, CarrierParty (público),
   * LoadingTransportEvent (público: fecha de entrega al transportista, dato 34 según la RS 000108-2026)
   * y DriverPerson (privado). En transporte público también va la fecha de inicio en TransitPeriod: hasta
   * la RS 000108-2026 ese era el único lugar de la fecha de entrega, así que se mantiene por compatibilidad.
   */
  private etapa(doc: DocumentoGre, publico: boolean): NodoXml {
    const { envio } = doc;
    const entrega = texto(envio.fechaEntregaTransportista) || envio.fechaInicioTraslado;
    return el(
      'cac:ShipmentStage',
      null,
      el('cbc:TransportModeCode', ATRIBUTOS_MODALIDAD_TRASLADO, envio.modalidad),
      el('cac:TransitPeriod', null, el('cbc:StartDate', null, envio.fechaInicioTraslado)),
      publico && doc.transportista ? this.transportista(doc.transportista) : null,
      publico ? el('cac:LoadingTransportEvent', null, el('cbc:OccurrenceDate', null, entrega)) : null,
      publico ? null : (doc.conductores ?? []).slice(0, MAXIMO_CONDUCTORES_GRE).map((c, i) => this.conductor(c, i)),
    );
  }

  /** cac:CarrierParty: RUC, razón social y número de registro MTC (CompanyID). */
  private transportista(transportista: TransportistaGre): NodoXml {
    const registroMtc = texto(transportista.registroMtc).toUpperCase();
    return el(
      'cac:CarrierParty',
      null,
      el(
        'cac:PartyIdentification',
        null,
        el('cbc:ID', { schemeID: '6', ...ATRIBUTOS_DOCUMENTO_IDENTIDAD }, texto(transportista.numDoc)),
      ),
      el(
        'cac:PartyLegalEntity',
        null,
        el('cbc:RegistrationName', null, texto(transportista.razonSocial)),
        registroMtc ? el('cbc:CompanyID', null, registroMtc) : null,
      ),
    );
  }

  /** cac:DriverPerson: documento, nombres, apellidos, tipo (Principal/Secundario) y licencia, en el orden del XSD. */
  private conductor(conductor: ConductorGre, indice: number): NodoXml {
    return el(
      'cac:DriverPerson',
      null,
      el('cbc:ID', { schemeID: texto(conductor.tipoDoc), ...ATRIBUTOS_DOCUMENTO_IDENTIDAD }, texto(conductor.numDoc)),
      el('cbc:FirstName', null, texto(conductor.nombres)),
      el('cbc:FamilyName', null, texto(conductor.apellidos)),
      el('cbc:JobTitle', null, indice === 0 ? TIPO_CONDUCTOR_PRINCIPAL : TIPO_CONDUCTOR_SECUNDARIO),
      el('cac:IdentityDocumentReference', null, el('cbc:ID', null, texto(conductor.licencia).toUpperCase())),
    );
  }

  /**
   * Punto de partida o llegada: ubigeo INEI, código de establecimiento (solo con el motivo 04, con el RUC
   * del remitente en listID) y dirección. Con otros motivos el código no se envía: no es obligatorio y
   * que SUNAT acepte '0000' (domicilio fiscal) en la GRE está [NO VERIFICADO].
   */
  private direccion(nombre: 'cac:DeliveryAddress' | 'cac:DespatchAddress', punto: DireccionGre, motivo: string, rucRemitente: string): NodoXml {
    const codigo = motivo === MOTIVO_GRE_TRASLADO_ESTABLECIMIENTOS ? texto(punto.codigoEstablecimiento) : '';
    return el(
      nombre,
      null,
      el('cbc:ID', ATRIBUTOS_UBIGEO, texto(punto.ubigeo)),
      codigo ? el('cbc:AddressTypeCode', { listID: rucRemitente, ...ATRIBUTOS_ESTABLECIMIENTO }, codigo) : null,
      el('cac:AddressLine', null, el('cbc:Line', null, texto(punto.direccion))),
    );
  }

  /** Vehículo principal (anexo N.° 14, datos 46 y 47): cac:TransportHandlingUnit/cac:TransportEquipment. */
  private vehiculo(vehiculo: VehiculoGre): NodoXml {
    const tarjeta = texto(vehiculo.tarjetaCirculacion).toUpperCase();
    return el(
      'cac:TransportHandlingUnit',
      null,
      el(
        'cac:TransportEquipment',
        null,
        el('cbc:ID', null, texto(vehiculo.placa)),
        tarjeta ? el('cac:ApplicableTransportMeans', null, el('cbc:RegistrationNationalityID', null, tarjeta)) : null,
      ),
    );
  }

  /** cac:DespatchLine: ID, DeliveredQuantity, OrderLineReference (obligatorio en el XSD) e Item. */
  private linea(item: ItemGre, indice: number): NodoXml {
    const codigoInterno = texto(item.codigoInterno);
    const codigoSunat = texto(item.codigoSunat);
    return el(
      'cac:DespatchLine',
      null,
      el('cbc:ID', null, indice + 1),
      el('cbc:DeliveredQuantity', { unitCode: texto(item.unidad), ...ATRIBUTOS_UNIDAD }, formatearDecimal(item.cantidad, DECIMALES_CANTIDAD)),
      el('cac:OrderLineReference', null, el('cbc:LineID', null, indice + 1)),
      el(
        'cac:Item',
        null,
        el('cbc:Description', null, texto(item.descripcion)),
        codigoInterno ? el('cac:SellersItemIdentification', null, el('cbc:ID', null, codigoInterno)) : null,
        codigoSunat ? el('cac:CommodityClassification', null, el('cbc:ItemClassificationCode', ATRIBUTOS_UNSPSC, codigoSunat)) : null,
      ),
    );
  }
}
