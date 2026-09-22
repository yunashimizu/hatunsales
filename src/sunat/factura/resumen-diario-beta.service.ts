import { ResumenDiarioLineaInput, ResumenDiarioUblBuilder } from './resumen-diario-ubl.builder';

export interface EmitirResumenDiarioBetaDto {
  rucEmisor: string;
  razonSocialEmisor: string;
  fechaGeneracion: string; // yyyy-mm-dd: hoy, o hasta el 7mo dia calendario siguiente a fechaEmisionDocumentos
  fechaEmisionDocumentos: string; // yyyy-mm-dd: todas las lineas deben corresponder a esta misma fecha
  numeroCorrelativoResumen: number; // permite reenviar mas de un resumen del mismo dia (RC-YYYYMMDD-#####)
  lineas: ResumenDiarioLineaInput[];
}

export interface EmitirResumenDiarioBetaResult {
  ok: boolean;
  identificador: string;
  xml: string;
  mensaje: string;
}

const PLAZO_MAXIMO_DIAS_CALENDARIO = 7;

export class ResumenDiarioBetaService {
  private readonly builder = new ResumenDiarioUblBuilder();

  async emitirResumenDiarioBeta(dto: EmitirResumenDiarioBetaDto): Promise<EmitirResumenDiarioBetaResult> {
    this.validarDto(dto);

    const identificador = `RC-${dto.fechaEmisionDocumentos.replace(/-/g, '')}-${String(dto.numeroCorrelativoResumen).padStart(5, '0')}`;

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
      xml: resultado.xml,
      mensaje: 'Resumen Diario BETA preparado correctamente. Pendiente de firma, ZIP y envío (sendSummary) a SUNAT.',
    };
  }

  private validarDto(dto: EmitirResumenDiarioBetaDto): void {
    if (!dto.rucEmisor || dto.rucEmisor.length !== 11) {
      throw new Error('El RUC del emisor debe tener 11 dígitos');
    }
    if (!dto.lineas || dto.lineas.length === 0) {
      throw new Error('El resumen diario debe tener al menos una línea');
    }

    const fechaGeneracion = new Date(`${dto.fechaGeneracion}T00:00:00`);
    const fechaEmision = new Date(`${dto.fechaEmisionDocumentos}T00:00:00`);
    if (fechaGeneracion < fechaEmision) {
      throw new Error('La fecha de generación del resumen no puede ser anterior a la fecha de emisión de los documentos');
    }

    const diasTranscurridos = Math.floor((fechaGeneracion.getTime() - fechaEmision.getTime()) / (24 * 60 * 60 * 1000));
    if (diasTranscurridos > PLAZO_MAXIMO_DIAS_CALENDARIO) {
      throw new Error(`El resumen diario debe enviarse dentro de los ${PLAZO_MAXIMO_DIAS_CALENDARIO} días calendario siguientes a la emisión (Anexo 05-A RS 097-2012/SUNAT); van ${diasTranscurridos} días`);
    }

    dto.lineas.forEach((linea, index) => {
      if (linea.serie[0]?.toUpperCase() !== 'B') {
        throw new Error(`Línea ${index + 1}: la serie de la boleta debe empezar con "B"`);
      }
    });
  }
}
