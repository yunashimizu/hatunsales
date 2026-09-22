import { AfectacionIgv, CATALOGO_09_MOTIVO_NOTA_CREDITO, MotivoNotaCredito, motivoNotaCreditoValidoParaTipo } from '../catalogos/sunat.catalogos';
import { AfectacionIgvTipo } from './factura-beta.service';
import { NotaCreditoUblBuilder } from './nota-credito-ubl.builder';

export interface EmitirNotaCreditoItemBetaDto {
  descripcion: string;
  cantidad: number;
  unidadMedida: string;
  precioUnitario: number;
  afectacionIgv: AfectacionIgvTipo;
  descuento?: number;
}

export interface EmitirNotaCreditoBetaDto {
  rucEmisor: string;
  razonSocialEmisor: string;
  direccionEmisor: string;
  ubigeoEmisor: string;
  tipoDocumentoCliente: string;
  numeroDocumentoCliente: string;
  razonSocialCliente: string;
  serie: string;
  numero: number;
  fechaEmision: string;
  horaEmision: string;
  moneda: 'PEN' | 'USD';
  documentoModificado: {
    tipoDocumento: '01' | '03';
    serie: string;
    numero: number;
  };
  motivo: MotivoNotaCredito;
  sustento: string;
  items: EmitirNotaCreditoItemBetaDto[];
}

export interface EmitirNotaCreditoBetaResult {
  ok: boolean;
  estado: 'PENDIENTE' | 'VALIDADO' | 'FIRMADO' | 'ENVIANDO' | 'ACEPTADO' | 'RECHAZADO';
  xml: string;
  mensaje: string;
}

export class NotaCreditoBetaService {
  private readonly builder = new NotaCreditoUblBuilder();

  async emitirNotaCreditoBeta(dto: EmitirNotaCreditoBetaDto): Promise<EmitirNotaCreditoBetaResult> {
    this.validarDto(dto);

    const resultado = this.builder.build({
      serie: dto.serie,
      numero: dto.numero,
      fechaEmision: dto.fechaEmision,
      horaEmision: dto.horaEmision,
      moneda: dto.moneda,
      emisor: {
        ruc: dto.rucEmisor,
        razonSocial: dto.razonSocialEmisor,
        direccion: dto.direccionEmisor,
        ubigeo: dto.ubigeoEmisor,
      },
      cliente: {
        tipoDocumento: dto.tipoDocumentoCliente,
        numeroDocumento: dto.numeroDocumentoCliente,
        razonSocial: dto.razonSocialCliente,
      },
      documentoModificado: dto.documentoModificado,
      motivo: dto.motivo,
      sustento: dto.sustento,
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
      mensaje: 'Nota de Crédito BETA preparada correctamente. Pendiente de firma, ZIP y envío a SUNAT.',
    };
  }

  private validarDto(dto: EmitirNotaCreditoBetaDto): void {
    if (!dto.rucEmisor || dto.rucEmisor.length !== 11) {
      throw new Error('El RUC del emisor debe tener 11 dígitos');
    }
    if (!dto.documentoModificado?.serie || !dto.documentoModificado?.numero) {
      throw new Error('Debe indicarse el documento (serie y número) que la Nota de Crédito modifica');
    }

    const prefijoEsperado = dto.documentoModificado.tipoDocumento === '01' ? 'F' : 'B';
    if (!dto.serie || dto.serie.trim().toUpperCase()[0] !== prefijoEsperado) {
      throw new Error(`La serie de la Nota de Crédito debe empezar con "${prefijoEsperado}" porque modifica un documento tipo ${dto.documentoModificado.tipoDocumento}`);
    }

    if (!motivoNotaCreditoValidoParaTipo(dto.motivo, dto.documentoModificado.tipoDocumento)) {
      throw new Error(`El motivo ${dto.motivo} no se puede usar sobre una Boleta (motivos ${CATALOGO_09_MOTIVO_NOTA_CREDITO.DESCUENTO_GLOBAL}, ${CATALOGO_09_MOTIVO_NOTA_CREDITO.DESCUENTO_POR_ITEM} y ${CATALOGO_09_MOTIVO_NOTA_CREDITO.BONIFICACION} solo aplican a Factura)`);
    }

    if (!dto.items || dto.items.length === 0) {
      throw new Error('La Nota de Crédito debe tener al menos una línea');
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
