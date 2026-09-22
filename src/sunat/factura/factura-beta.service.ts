import { AfectacionIgv } from '../catalogos/sunat.catalogos';
import { FormaPago, InvoiceUblBuilder } from './invoice-ubl.builder';

export type AfectacionIgvTipo = 'gravado' | 'exonerado' | 'inafecto';

export interface EmitirFacturaItemBetaDto {
  descripcion: string;
  cantidad: number;
  unidadMedida: string;
  precioUnitario: number;
  afectacionIgv: AfectacionIgvTipo;
  descuento?: number;
}

export interface EmitirFacturaBetaDto {
  rucEmisor: string;
  razonSocialEmisor: string;
  direccionEmisor: string;
  ubigeoEmisor: string;
  rucCliente: string;
  razonSocialCliente: string;
  direccionCliente?: string;
  serie: string;
  numero: number;
  fechaEmision: string;
  horaEmision: string;
  moneda: 'PEN' | 'USD';
  tipoOperacion: '0101';
  items: EmitirFacturaItemBetaDto[];
  /** Contado por defecto: cubre el caso mas comun (POS/tienda). Se puede forzar 'Credito' para ventas a credito. */
  formaPago?: FormaPago;
}

export interface EmitirFacturaBetaResult {
  ok: boolean;
  estado: 'PENDIENTE' | 'VALIDADO' | 'FIRMADO' | 'ENVIANDO' | 'ACEPTADO' | 'RECHAZADO';
  xml: string;
  mensaje: string;
}

/** Serie de Factura: letra F + 3 digitos (ej. F001), tal como exige SUNAT (catalogo de series, distinto de la serie de Boleta que empieza con B). */
const SERIE_FACTURA_REGEX = /^F\d{3}$/i;

export class FacturaBetaService {
  private readonly builder = new InvoiceUblBuilder();

  async emitirFacturaBeta(dto: EmitirFacturaBetaDto): Promise<EmitirFacturaBetaResult> {
    this.validarDto(dto);

    const resultado = this.builder.build({
      tipoDocumento: '01',
      serie: dto.serie,
      numero: dto.numero,
      fechaEmision: dto.fechaEmision,
      horaEmision: dto.horaEmision,
      moneda: dto.moneda,
      formaPago: dto.formaPago ?? 'Contado',
      emisor: {
        ruc: dto.rucEmisor,
        razonSocial: dto.razonSocialEmisor,
        direccion: dto.direccionEmisor,
        ubigeo: dto.ubigeoEmisor,
      },
      cliente: {
        tipoDocumento: '6',
        numeroDocumento: dto.rucCliente,
        razonSocial: dto.razonSocialCliente,
        direccion: dto.direccionCliente,
      },
      items: dto.items.map((item) => ({
        descripcion: item.descripcion,
        cantidad: item.cantidad,
        unidadMedida: item.unidadMedida,
        precioUnitario: item.precioUnitario,
        afectacionIgv: this.mapperAfectacion(item.afectacionIgv),
        descuento: item.descuento,
      })),
    });

    return {
      ok: true,
      estado: 'PENDIENTE',
      xml: resultado.xml,
      mensaje: 'Factura BETA preparada correctamente. Pendiente de firma, ZIP y envío a SUNAT.',
    };
  }

  private validarDto(dto: EmitirFacturaBetaDto): void {
    if (!dto.rucEmisor || dto.rucEmisor.length !== 11) {
      throw new Error('El RUC del emisor debe tener 11 dígitos');
    }
    if (!dto.rucCliente || dto.rucCliente.length !== 11) {
      throw new Error('El RUC del cliente debe tener 11 dígitos');
    }
    if (!dto.serie || !SERIE_FACTURA_REGEX.test(dto.serie)) {
      throw new Error('La serie debe tener formato F###');
    }
    if (!dto.items || dto.items.length === 0) {
      throw new Error('La factura debe tener al menos una línea');
    }
  }

  private mapperAfectacion(tipo: AfectacionIgvTipo): AfectacionIgv {
    switch (tipo) {
      case 'gravado':
        return '10';
      case 'exonerado':
        return '20';
      case 'inafecto':
        return '30';
      default:
        return '10';
    }
  }
}
