import { CATALOGO_20_MOTIVO_TRASLADO, CATALOGO_21_MODALIDAD_TRASLADO } from '../catalogos/sunat.catalogos';
import { GuiaRemisionItemUblInput, GuiaRemisionUblBuilder } from './guia-remision-ubl.builder';

export interface EmitirGuiaRemisionBetaDto {
  rucEmisor: string;
  razonSocialEmisor: string;
  destinatario: { tipoDocumento: string; numeroDocumento: string; razonSocial: string };
  serie: string;
  numero: number;
  fechaEmision: string;
  motivoTraslado: string;
  modalidadTraslado: string;
  pesoBrutoTotalKg: number;
  origenUbigeo: string;
  origenDireccion: string;
  destinoUbigeo: string;
  destinoDireccion: string;
  fechaInicioTraslado: string;
  transportista?: { ruc: string; razonSocial: string };
  vehiculoPlaca?: string;
  conductorNumeroDocumento?: string;
  conductorLicencia?: string;
  items: GuiaRemisionItemUblInput[];
}

export interface EmitirGuiaRemisionBetaResult {
  ok: boolean;
  xml: string;
  mensaje: string;
}

/** Serie de Guía de Remisión Remitente: letra T + 3 dígitos (ej. T001), según el catálogo de series de SUNAT. */
const SERIE_GUIA_REGEX = /^T\d{3}$/i;

const MOTIVOS_VALIDOS = Object.values(CATALOGO_20_MOTIVO_TRASLADO);
const MODALIDADES_VALIDAS = Object.values(CATALOGO_21_MODALIDAD_TRASLADO);

export class GuiaRemisionBetaService {
  private readonly builder = new GuiaRemisionUblBuilder();

  async emitirGuiaRemisionBeta(dto: EmitirGuiaRemisionBetaDto): Promise<EmitirGuiaRemisionBetaResult> {
    this.validarDto(dto);

    const resultado = this.builder.build({
      serie: dto.serie,
      numero: dto.numero,
      fechaEmision: dto.fechaEmision,
      emisor: { ruc: dto.rucEmisor, razonSocial: dto.razonSocialEmisor },
      destinatario: dto.destinatario,
      motivoTraslado: dto.motivoTraslado,
      modalidadTraslado: dto.modalidadTraslado,
      pesoBrutoTotalKg: dto.pesoBrutoTotalKg,
      origenUbigeo: dto.origenUbigeo,
      origenDireccion: dto.origenDireccion,
      destinoUbigeo: dto.destinoUbigeo,
      destinoDireccion: dto.destinoDireccion,
      fechaInicioTraslado: dto.fechaInicioTraslado,
      transportista: dto.transportista,
      vehiculoPlaca: dto.vehiculoPlaca,
      conductorNumeroDocumento: dto.conductorNumeroDocumento,
      conductorLicencia: dto.conductorLicencia,
      items: dto.items,
    });

    return {
      ok: true,
      xml: resultado.xml,
      mensaje: 'Guía de Remisión BETA preparada correctamente. Revisar contra la guía oficial de SUNAT antes de enviar en real.',
    };
  }

  private validarDto(dto: EmitirGuiaRemisionBetaDto): void {
    if (!dto.rucEmisor || dto.rucEmisor.length !== 11) {
      throw new Error('El RUC del emisor debe tener 11 dígitos');
    }
    if (!dto.serie || !SERIE_GUIA_REGEX.test(dto.serie)) {
      throw new Error('La serie debe tener formato T###');
    }
    if (!MOTIVOS_VALIDOS.includes(dto.motivoTraslado as any)) {
      throw new Error(`Motivo de traslado inválido: ${dto.motivoTraslado}`);
    }
    if (!MODALIDADES_VALIDAS.includes(dto.modalidadTraslado as any)) {
      throw new Error(`Modalidad de traslado inválida: ${dto.modalidadTraslado}`);
    }
    if (dto.modalidadTraslado === CATALOGO_21_MODALIDAD_TRASLADO.TRANSPORTE_PUBLICO && !dto.transportista) {
      throw new Error('El transporte público requiere los datos del transportista (RUC y razón social)');
    }
    if (dto.modalidadTraslado === CATALOGO_21_MODALIDAD_TRASLADO.TRANSPORTE_PRIVADO && !dto.vehiculoPlaca) {
      throw new Error('El transporte privado requiere la placa del vehículo');
    }
    if (!dto.pesoBrutoTotalKg || dto.pesoBrutoTotalKg <= 0) {
      throw new Error('El peso bruto total debe ser mayor a 0');
    }
    if (!dto.items || dto.items.length === 0) {
      throw new Error('La guía de remisión debe tener al menos una línea');
    }
  }
}
