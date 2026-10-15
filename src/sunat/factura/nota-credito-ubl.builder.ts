import { AfectacionIgv } from '../catalogos/sunat.catalogos';
import { construirXmlCpe } from '../nucleo/construir-xml-cpe';
import type { DocumentoCpe, ResultadoXmlCpe } from '../nucleo/documento-fiscal.types';
import { lineasDesdeItemsLegados } from './invoice-ubl.builder';

/**
 * Builder UBL 2.1 de Nota de Crédito (07, raíz CreditNote): referencia única
 * al comprobante modificado (cac:BillingReference) y motivo (catálogo 09) en
 * cac:DiscrepancyResponse. El XML lo arma ConstructorNotaCreditoUbl del núcleo;
 * esta clase adapta la API BETA heredada (precio SIN IGV).
 */

export interface NotaCreditoItemUblInput {
  descripcion: string;
  cantidad: number;
  unidadMedida: string;
  /** Valor unitario SIN IGV (formato heredado). */
  precioUnitario: number;
  afectacionIgv: AfectacionIgv;
  descuento?: number;
}

export interface NotaCreditoUblBuilderInput {
  serie: string;
  numero: number;
  fechaEmision: string;
  horaEmision: string;
  moneda: 'PEN' | 'USD';
  emisor: {
    ruc: string;
    razonSocial: string;
    direccion?: string;
    ubigeo?: string;
    distrito?: string;
    provincia?: string;
    departamento?: string;
    codigoEstablecimiento?: string;
  };
  cliente: {
    tipoDocumento: string;
    numeroDocumento: string;
    razonSocial: string;
  };
  documentoModificado: {
    tipoDocumento: '01' | '03';
    serie: string;
    numero: number;
  };
  motivo: string;
  sustento: string;
  items: NotaCreditoItemUblInput[];
}

export interface NotaCreditoUblBuilderResultado {
  xml: string;
  totalIgv: number;
  totalGeneral: number;
}

export class NotaCreditoUblBuilder {
  /** XML de un DocumentoCpe tipo 07 (flujo real). */
  buildDesdeDocumento(doc: DocumentoCpe): ResultadoXmlCpe {
    return construirXmlCpe(doc);
  }

  /** @deprecated API BETA heredada (precio SIN IGV). Use buildDesdeDocumento / construirXmlCpe. */
  build(input: NotaCreditoUblBuilderInput): NotaCreditoUblBuilderResultado {
    const { lineas, totales } = lineasDesdeItemsLegados(input.items);
    const doc: DocumentoCpe = {
      tipo: '07',
      serie: input.serie,
      numero: input.numero,
      fechaEmision: input.fechaEmision,
      horaEmision: input.horaEmision,
      moneda: input.moneda,
      emisor: {
        ruc: input.emisor.ruc,
        razonSocial: input.emisor.razonSocial,
        direccion: input.emisor.direccion ?? '',
        ubigeo: input.emisor.ubigeo ?? '',
        distrito: input.emisor.distrito ?? '',
        provincia: input.emisor.provincia ?? '',
        departamento: input.emisor.departamento ?? '',
        codigoEstablecimiento: input.emisor.codigoEstablecimiento ?? '0000',
      },
      cliente: {
        tipoDoc: input.cliente.tipoDocumento,
        numDoc: input.cliente.numeroDocumento,
        nombre: input.cliente.razonSocial,
      },
      lineas,
      totales,
      referencia: {
        tipoDoc: input.documentoModificado.tipoDocumento,
        serie: input.documentoModificado.serie,
        numero: input.documentoModificado.numero,
        motivo: input.motivo,
        sustento: input.sustento,
      },
    };
    return { xml: construirXmlCpe(doc).xml, totalIgv: totales.igv, totalGeneral: totales.total };
  }
}
