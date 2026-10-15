import { PLAZOS_ENVIO_DIAS } from '../catalogos/sunat.catalogos';
import { diasEntre, esFechaIso } from '../nucleo/fechas-fiscales';
import { CORRELATIVO_MAXIMO_RESUMEN, identificadorResumen } from '../nucleo/identificadores-cpe';
import { ResumenDiarioLineaInput, ResumenDiarioUblBuilder } from './resumen-diario-ubl.builder';

export interface EmitirResumenDiarioBetaDto {
  rucEmisor: string;
  razonSocialEmisor: string;
  fechaGeneracion: string; // yyyy-mm-dd: hoy, o hasta el 7mo dia calendario siguiente a fechaEmisionDocumentos
  fechaEmisionDocumentos: string; // yyyy-mm-dd: todas las lineas deben corresponder a esta misma fecha
  numeroCorrelativoResumen: number; // correlativo del día de GENERACIÓN (RC-YYYYMMDD-#####)
  lineas: ResumenDiarioLineaInput[];
}

export interface EmitirResumenDiarioBetaResult {
  ok: boolean;
  /** RC-<fecha de generación>-<correlativo>: igual al cbc:ID. */
  identificador: string;
  /** RUC-RC-…: nombre del .xml y del .zip (idéntico al cbc:ID con el RUC delante). */
  nombreArchivo: string;
  xml: string;
  mensaje: string;
}

const PLAZO_MAXIMO_DIAS_CALENDARIO = PLAZOS_ENVIO_DIAS.resumenDiario;

export class ResumenDiarioBetaService {
  private readonly builder = new ResumenDiarioUblBuilder();

  async emitirResumenDiarioBeta(dto: EmitirResumenDiarioBetaDto): Promise<EmitirResumenDiarioBetaResult> {
    this.validarDto(dto);

    // El ID lleva la fecha de GENERACIÓN (la de emisión va en ReferenceDate).
    const identificador = identificadorResumen('RC', dto.fechaGeneracion, dto.numeroCorrelativoResumen);

    const resultado = this.builder.build({
      identificador,
      fechaGeneracion: dto.fechaGeneracion,
      fechaEmisionDocumentos: dto.fechaEmisionDocumentos,
      emisor: { ruc: dto.rucEmisor, razonSocial: dto.razonSocialEmisor },
      lineas: dto.lineas,
    });

    return {
      ok: true,
      identificador,
      nombreArchivo: resultado.nombreBase,
      xml: resultado.xml,
      mensaje: 'Resumen Diario BETA preparado correctamente. Pendiente de firma, ZIP y envío (sendSummary) a SUNAT.',
    };
  }

  private validarDto(dto: EmitirResumenDiarioBetaDto): void {
    if (!dto.rucEmisor || !/^\d{11}$/.test(dto.rucEmisor)) {
      throw new Error('El RUC del emisor debe tener 11 dígitos');
    }
    if (!dto.lineas || dto.lineas.length === 0) {
      throw new Error('El resumen diario debe tener al menos una línea');
    }
    if (!esFechaIso(dto.fechaGeneracion) || !esFechaIso(dto.fechaEmisionDocumentos)) {
      throw new Error('Las fechas del resumen deben tener el formato yyyy-mm-dd');
    }
    if (!Number.isInteger(dto.numeroCorrelativoResumen) || dto.numeroCorrelativoResumen < 1 || dto.numeroCorrelativoResumen > CORRELATIVO_MAXIMO_RESUMEN) {
      throw new Error(`El correlativo del resumen debe ser un entero entre 1 y ${CORRELATIVO_MAXIMO_RESUMEN}`);
    }

    const diasTranscurridos = diasEntre(dto.fechaEmisionDocumentos, dto.fechaGeneracion);
    if (diasTranscurridos < 0) {
      throw new Error('La fecha de generación del resumen no puede ser anterior a la fecha de emisión de los documentos');
    }
    if (diasTranscurridos > PLAZO_MAXIMO_DIAS_CALENDARIO) {
      throw new Error(`El resumen diario debe enviarse dentro de los ${PLAZO_MAXIMO_DIAS_CALENDARIO} días calendario siguientes a la emisión (Anexo 05-A RS 097-2012/SUNAT); van ${diasTranscurridos} días`);
    }

    dto.lineas.forEach((linea, index) => {
      if (linea.serie?.[0]?.toUpperCase() !== 'B') {
        throw new Error(`Línea ${index + 1}: la serie de la boleta debe empezar con "B"`);
      }
    });
  }
}
