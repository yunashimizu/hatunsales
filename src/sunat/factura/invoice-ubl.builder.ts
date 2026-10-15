import { AfectacionIgv } from '../catalogos/sunat.catalogos';
import { construirXmlCpe } from '../nucleo/construir-xml-cpe';
import { Dinero } from '../nucleo/decimal';
import type { DocumentoCpe, LineaCpe, ResultadoXmlCpe, TotalesCpe } from '../nucleo/documento-fiscal.types';
import { lineaCpeDesdeValorSinIgv } from '../nucleo/linea-cpe';

/**
 * Builder UBL 2.1 de Factura (01) y Boleta (03) (raíz Invoice).
 *
 * El XML lo arma el núcleo (src/sunat/nucleo): ConstructorFacturaBoletaUbl a
 * partir de un DocumentoCpe con las líneas YA calculadas por el negocio
 * (sin recalcular el IGV). Esta clase queda como adaptador de la API BETA
 * heredada, cuyo `precioUnitario` es el valor SIN IGV.
 */

export interface InvoiceItemUblInput {
  descripcion: string;
  cantidad: number;
  unidadMedida: string;
  /** Valor unitario SIN IGV (formato heredado de los DTO BETA). */
  precioUnitario: number;
  afectacionIgv: AfectacionIgv;
  /** Descuento sin IGV sobre la línea. */
  descuento?: number;
}

export interface InvoiceDireccionUblInput {
  direccion?: string;
  ubigeo?: string;
  distrito?: string;
  provincia?: string;
  departamento?: string;
}

export interface InvoiceEmisorUblInput extends InvoiceDireccionUblInput {
  ruc: string;
  razonSocial: string;
  nombreComercial?: string;
  codigoEstablecimiento?: string;
}

export interface InvoiceClienteUblInput {
  tipoDocumento: string; // catalogo 06: '1' DNI, '6' RUC, '0' sin documento
  numeroDocumento: string;
  razonSocial: string;
  direccion?: string;
}

export type FormaPago = 'Contado' | 'Credito';

export interface InvoiceUblBuilderInput {
  tipoDocumento: '01' | '03';
  serie: string;
  numero: number;
  fechaEmision: string;
  horaEmision: string;
  moneda: 'PEN' | 'USD';
  formaPago: FormaPago;
  emisor: InvoiceEmisorUblInput;
  cliente: InvoiceClienteUblInput;
  items: InvoiceItemUblInput[];
  /** Solo para la representación impresa (ya no se escribe como leyenda 1000). */
  observacion?: string;
}

export interface InvoiceUblBuilderResultado {
  xml: string;
  totalGravada: number;
  totalExonerada: number;
  totalInafecta: number;
  totalIgv: number;
  totalGeneral: number;
}

/** Tasa del IGV que asumían los DTO BETA heredados. */
const PORCENTAJE_IGV_LEGADO = 18;

/** Líneas y totales en el formato heredado: precio sin IGV, IGV = base × 18 % (exportación sumada a inafecto). */
export function lineasDesdeItemsLegados(items: readonly InvoiceItemUblInput[]): { lineas: LineaCpe[]; totales: TotalesCpe } {
  const lineas = items.map((item) =>
    lineaCpeDesdeValorSinIgv(
      {
        cantidad: Number(item.cantidad ?? 0),
        valorUnitario: Number(item.precioUnitario ?? 0),
        descuentoBase: Number(item.descuento ?? 0),
        afectacion: item.afectacionIgv as LineaCpe['afectacion'],
      },
      { unidad: item.unidadMedida, descripcion: item.descripcion },
      PORCENTAJE_IGV_LEGADO,
    ),
  );
  const suma = (filtro: (afectacion: string) => boolean, campo: 'valorVenta' | 'igv' | 'total' | 'descuentoBase') =>
    Dinero.suma(lineas.filter((l) => filtro(l.afectacion)).map((l) => l[campo])).aNumero();
  return {
    lineas,
    totales: {
      gravada: suma((a) => a === '10', 'valorVenta'),
      exonerada: suma((a) => a === '20', 'valorVenta'),
      inafecta: suma((a) => a === '30' || a === '40', 'valorVenta'),
      igv: suma(() => true, 'igv'),
      descuentos: suma(() => true, 'descuentoBase'),
      total: suma(() => true, 'total'),
    },
  };
}

export class InvoiceUblBuilder {
  /** XML de un DocumentoCpe (flujo real): ver construirXmlCpe del núcleo. */
  buildDesdeDocumento(doc: DocumentoCpe): ResultadoXmlCpe {
    return construirXmlCpe(doc);
  }

  /** @deprecated API BETA heredada (precio SIN IGV). Use buildDesdeDocumento / construirXmlCpe. */
  build(input: InvoiceUblBuilderInput): InvoiceUblBuilderResultado {
    const { lineas, totales } = lineasDesdeItemsLegados(input.items);
    const perceptorTipo = input.tipoDocumento === '01' ? '6' : input.cliente.tipoDocumento;

    const doc: DocumentoCpe = {
      tipo: input.tipoDocumento,
      serie: input.serie,
      numero: input.numero,
      fechaEmision: input.fechaEmision,
      horaEmision: input.horaEmision,
      moneda: input.moneda,
      emisor: {
        ruc: input.emisor.ruc,
        razonSocial: input.emisor.razonSocial,
        nombreComercial: input.emisor.nombreComercial,
        direccion: input.emisor.direccion ?? '',
        ubigeo: input.emisor.ubigeo ?? '',
        distrito: input.emisor.distrito ?? '',
        provincia: input.emisor.provincia ?? '',
        departamento: input.emisor.departamento ?? '',
        codigoEstablecimiento: input.emisor.codigoEstablecimiento ?? '0000',
      },
      cliente: {
        tipoDoc: perceptorTipo,
        numDoc: input.cliente.numeroDocumento,
        nombre: input.cliente.razonSocial,
        direccion: input.cliente.direccion,
      },
      lineas,
      totales,
      formaPago: input.formaPago === 'Credito' ? { tipo: 'Credito', montoPendiente: totales.total, cuotas: [] } : { tipo: 'Contado' },
      observaciones: input.observacion,
    };

    return {
      xml: construirXmlCpe(doc).xml,
      totalGravada: totales.gravada,
      totalExonerada: totales.exonerada,
      totalInafecta: totales.inafecta,
      totalIgv: totales.igv,
      totalGeneral: totales.total,
    };
  }
}
