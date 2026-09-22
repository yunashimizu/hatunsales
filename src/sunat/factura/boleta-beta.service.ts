import { AfectacionIgv } from '../catalogos/sunat.catalogos';
import { AfectacionIgvTipo, EmitirFacturaItemBetaDto } from './factura-beta.service';
import { FormaPago, InvoiceUblBuilder } from './invoice-ubl.builder';

export interface EmitirBoletaBetaDto {
  rucEmisor: string;
  razonSocialEmisor: string;
  direccionEmisor: string;
  ubigeoEmisor: string;
  /** Catalogo 06: '1' DNI, '6' RUC, '0' sin documento (venta menor). Boleta admite cliente natural, a diferencia de Factura. */
  tipoDocumentoCliente: '0' | '1' | '4' | '6' | '7';
  numeroDocumentoCliente: string;
  denominacionCliente: string;
  direccionCliente?: string;
  serie: string;
  numero: number;
  fechaEmision: string;
  horaEmision: string;
  moneda: 'PEN' | 'USD';
  items: EmitirFacturaItemBetaDto[];
  formaPago?: FormaPago;
}

export interface EmitirBoletaBetaResult {
  ok: boolean;
  estado: 'PENDIENTE' | 'VALIDADO' | 'FIRMADO' | 'ENVIANDO' | 'ACEPTADO' | 'RECHAZADO';
  xml: string;
  mensaje: string;
}

/** Serie de Boleta: letra B + 3 digitos (ej. B001), distinta de la de Factura (F###). */
const SERIE_BOLETA_REGEX = /^B\d{3}$/i;

const LONGITUD_ESPERADA_POR_TIPO_DOC: Record<string, number | null> = {
  '0': null, // sin documento: SUNAT no exige numero para ventas menores
  '1': 8, // DNI
  '4': null, // Carnet de extranjeria: longitud variable
  '6': 11, // RUC
  '7': null, // Pasaporte: longitud variable
};

export class BoletaBetaService {
  private readonly builder = new InvoiceUblBuilder();

  async emitirBoletaBeta(dto: EmitirBoletaBetaDto): Promise<EmitirBoletaBetaResult> {
    this.validarDto(dto);

    const resultado = this.builder.build({
      tipoDocumento: '03',
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
        tipoDocumento: dto.tipoDocumentoCliente,
        numeroDocumento: dto.numeroDocumentoCliente || '00000000',
        razonSocial: dto.denominacionCliente,
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
      mensaje: 'Boleta BETA preparada correctamente. Pendiente de firma, ZIP y envío a SUNAT.',
    };
  }

  private validarDto(dto: EmitirBoletaBetaDto): void {
    if (!dto.rucEmisor || dto.rucEmisor.length !== 11) {
      throw new Error('El RUC del emisor debe tener 11 dígitos');
    }
    if (!dto.serie || !SERIE_BOLETA_REGEX.test(dto.serie)) {
      throw new Error('La serie debe tener formato B###');
    }
    if (!dto.items || dto.items.length === 0) {
      throw new Error('La boleta debe tener al menos una línea');
    }

    const longitudEsperada = LONGITUD_ESPERADA_POR_TIPO_DOC[dto.tipoDocumentoCliente];
    if (longitudEsperada && dto.numeroDocumentoCliente?.length !== longitudEsperada) {
      throw new Error(`El número de documento del cliente debe tener ${longitudEsperada} dígitos para el tipo ${dto.tipoDocumentoCliente}`);
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
