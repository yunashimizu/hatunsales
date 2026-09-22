import { FiscalStatusMapper } from '../fiscal/fiscal-status.mapper';

export interface CdrParseResult {
  codigo: string;
  descripcion: string;
  observaciones: string[];
  estado: 'ACEPTADO' | 'ACEPTADO_CON_OBSERVACIONES' | 'RECHAZADO' | 'ERROR_TRANSPORTE' | 'ESTADO_DESCONOCIDO';
  rawXml: string;
}

export class CdrParserService {
  parse(xml: string): CdrParseResult {
    if (!xml || !xml.includes('ApplicationResponse')) {
      return {
        codigo: 'ERROR',
        descripcion: 'No se pudo interpretar la CDR de SUNAT.',
        observaciones: ['La respuesta no contiene un ApplicationResponse válido.'],
        estado: 'ESTADO_DESCONOCIDO',
        rawXml: xml,
      };
    }

    const codigoMatch = xml.match(/<cbc:ResponseCode>([^<]+)<\/cbc:ResponseCode>|<ResponseCode>([^<]+)<\/ResponseCode>/i);
    const descripcionMatch = xml.match(/<cbc:Description>([^<]+)<\/cbc:Description>|<Description>([^<]+)<\/Description>/i);
    const notesMatches = [...xml.matchAll(/<(?:cbc|cac):?Note>([^<]+)<\/(?:cbc|cac):?Note>/gi)];

    const codigo = (codigoMatch?.[1] ?? codigoMatch?.[2] ?? 'ERROR').trim();
    const descripcion = (descripcionMatch?.[1] ?? descripcionMatch?.[2] ?? 'Respuesta no reconocida por Sunat.').trim();
    const observaciones = notesMatches.map((match) => match[1].trim()).filter(Boolean);

    let estado: CdrParseResult['estado'] = 'ESTADO_DESCONOCIDO';

    // codigo '0' con Notes: SUNAT acepta el documento pero deja observaciones
    // (confirmado contra un CDR real de Beta: código 0 + 5 <cbc:Note> de
    // formato de dirección) — no es un rechazo, así que va antes que RECHAZADO,
    // pero tampoco es "sin nada que corregir".
    if (codigo === '0' && observaciones.length === 0) estado = 'ACEPTADO';
    else if (codigo === '0' || codigo === '2001' || codigo === '2002' || codigo === '2003' || codigo === '2004' || observaciones.length > 0) {
      estado = 'ACEPTADO_CON_OBSERVACIONES';
    } else if (codigo.startsWith('1') || codigo.startsWith('2') || codigo.startsWith('3') || codigo.startsWith('4')) {
      estado = 'RECHAZADO';
    }

    const mappedEstado = FiscalStatusMapper.normalizar(estado) as CdrParseResult['estado'];
    return {
      codigo,
      descripcion,
      observaciones,
      estado: mappedEstado,
      rawXml: xml,
    };
  }
}
