import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import axios from 'axios';
import { sunatConfig } from '../../config/sunat.config';

/**
 * Único punto de salida hacia el servicio de consulta de DNI y RUC.
 *
 * Antes esta llamada estaba copiada en tres sitios distintos, cada uno con su
 * propio manejo de errores y sin tiempo límite, así que una caída del
 * proveedor dejaba peticiones colgadas.
 */

const TIEMPO_LIMITE_MS = 8000;

export interface DatosPersona {
  dni: string;
  nombres: string;
  apellido_paterno: string;
  apellido_materno: string;
  nombre_completo: string;
}

export interface DatosEmpresa {
  ruc: string;
  razon_social: string;
  nombre_comercial: string;
  telefonos: string;
  direccion: string;
  departamento: string;
  provincia: string;
  distrito: string;
  ubigeo: string;
  capital: string;
  estado: string;
  condicion: string;
  tipo: string;
  fecha_inscripcion: string;
  fecha_baja: string;
}

@Injectable()
export class ConsultaDocumentoService {

  private readonly logger = new Logger(ConsultaDocumentoService.name);

  get disponible(): boolean {
    return Boolean(sunatConfig.token);
  }

  /** Devuelve null cuando el documento simplemente no existe en el padrón. */
  async consultarDni(dni: string): Promise<DatosPersona | null> {
    const data = await this.pedir(`${sunatConfig.dniUrl}/${dni}`, 'DNI');
    if (!data || data.success === false || !data.nombres) return null;

    const nombres = String(data.nombres ?? '').trim();
    const paterno = String(data.apellidoPaterno ?? '').trim();
    const materno = String(data.apellidoMaterno ?? '').trim();

    return {
      dni,
      nombres,
      apellido_paterno: paterno,
      apellido_materno: materno,
      nombre_completo: [nombres, paterno, materno].filter(Boolean).join(' '),
    };
  }

  async consultarRuc(ruc: string): Promise<DatosEmpresa | null> {
    const data = await this.pedir(`${sunatConfig.rucUrl}/${ruc}`, 'RUC');
    if (!data || !data.razonSocial) return null;

    return {
      ruc,
      razon_social: String(data.razonSocial ?? '').trim(),
      nombre_comercial: String(data.nombreComercial ?? '').trim(),
      telefonos: Array.isArray(data.telefonos) ? data.telefonos.join(',') : String(data.telefonos ?? ''),
      direccion: String(data.direccion ?? '').trim(),
      departamento: String(data.departamento ?? ''),
      provincia: String(data.provincia ?? ''),
      distrito: String(data.distrito ?? ''),
      ubigeo: String(data.ubigeo ?? ''),
      capital: String(data.capital ?? ''),
      estado: String(data.estado ?? ''),
      condicion: String(data.condicion ?? ''),
      tipo: String(data.tipo ?? ''),
      fecha_inscripcion: String(data.fechaInscripcion ?? ''),
      fecha_baja: String(data.fechaBaja ?? ''),
    };
  }

  private async pedir(url: string, etiqueta: string): Promise<any | null> {
    if (!this.disponible) {
      throw new ServiceUnavailableException(
        'La consulta automática de documentos no está configurada. Ingrese los datos manualmente.',
      );
    }

    try {
      const { data } = await axios.get(url, {
        params: { token: sunatConfig.token },
        timeout: TIEMPO_LIMITE_MS,
      });
      return data;
    } catch (error: any) {
      // Un 404 significa que el documento no existe, no que el servicio falle.
      if (error?.response?.status === 404) return null;

      this.logger.warn(`Consulta de ${etiqueta} fallida: ${error?.message ?? 'error desconocido'}`);
      throw new ServiceUnavailableException(
        `No se pudo consultar el ${etiqueta} en este momento. Ingrese los datos manualmente.`,
      );
    }
  }
}
