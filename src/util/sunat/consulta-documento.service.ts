import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import axios from 'axios';
import { sunatConfig } from '../../config/sunat.config';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';

/**
 * Único punto de salida hacia ApiPeruDev (consulta DNI y RUC).
 *
 * El token se busca en este orden: variables de entorno, tabla `configuraciones`
 * (`sunat_token`). Así se puede configurar sin redeploy si hace falta.
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
  private tokenEnCache: { valor: string | null; expira: number } | null = null;

  constructor(private readonly config: ConfiguracionRepository) {}

  /** Devuelve null cuando el documento simplemente no existe en el padrón. */
  async consultarDni(dni: string): Promise<DatosPersona | null> {
    const payload = await this.pedir(sunatConfig.dniUrl, { dni }, 'DNI');
    const data = payload?.data;
    if (!payload?.success || !data) return null;

    const nombres = String(data.nombres ?? '').trim();
    const paterno = String(data.apellido_paterno ?? data.apellidoPaterno ?? '').trim();
    const materno = String(data.apellido_materno ?? data.apellidoMaterno ?? '').trim();
    const completo = String(data.nombre_completo ?? '').trim()
      || [nombres, paterno, materno].filter(Boolean).join(' ');

    if (!completo) return null;

    return {
      dni,
      nombres,
      apellido_paterno: paterno,
      apellido_materno: materno,
      nombre_completo: completo,
    };
  }

  async consultarRuc(ruc: string): Promise<DatosEmpresa | null> {
    const payload = await this.pedir(sunatConfig.rucUrl, { ruc }, 'RUC');
    const data = payload?.data;
    if (!payload?.success || !data) return null;

    const razon = String(
      data.nombre_o_razon_social
      ?? data.razonSocial
      ?? data.razon_social
      ?? '',
    ).trim();
    if (!razon) return null;

    const ubigeo = Array.isArray(data.ubigeo)
      ? String(data.ubigeo[data.ubigeo.length - 1] ?? data.ubigeo_sunat ?? '')
      : String(data.ubigeo ?? data.ubigeo_sunat ?? '');

    return {
      ruc,
      razon_social: razon,
      nombre_comercial: String(data.nombre_comercial ?? data.nombreComercial ?? '').trim(),
      telefonos: Array.isArray(data.telefonos) ? data.telefonos.join(',') : String(data.telefonos ?? ''),
      direccion: String(data.direccion_completa ?? data.direccion ?? '').trim(),
      departamento: String(data.departamento ?? ''),
      provincia: String(data.provincia ?? ''),
      distrito: String(data.distrito ?? ''),
      ubigeo,
      capital: String(data.capital ?? ''),
      estado: String(data.estado ?? ''),
      condicion: String(data.condicion ?? ''),
      tipo: String(data.tipo ?? ''),
      fecha_inscripcion: String(data.fecha_inscripcion ?? data.fechaInscripcion ?? ''),
      fecha_baja: String(data.fecha_baja ?? data.fechaBaja ?? ''),
    };
  }

  private async token(): Promise<string | null> {
    if (sunatConfig.token) return sunatConfig.token;

    if (this.tokenEnCache && this.tokenEnCache.expira > Date.now()) {
      return this.tokenEnCache.valor;
    }

    try {
      const valor = await this.config.obtener('sunat_token');
      this.tokenEnCache = { valor, expira: Date.now() + 60_000 };
      return valor;
    } catch {
      this.tokenEnCache = { valor: null, expira: Date.now() + 60_000 };
      return null;
    }
  }

  private async pedir(url: string, body: Record<string, string>, etiqueta: string): Promise<any | null> {
    const token = await this.token();
    if (!token) {
      throw new ServiceUnavailableException(
        'La consulta automática de documentos no está configurada. Agregue SUNAT_TOKEN en Railway o la clave sunat_token en configuraciones.',
      );
    }

    try {
      const { data } = await axios.post(url, body, {
        timeout: TIEMPO_LIMITE_MS,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
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
