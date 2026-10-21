import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FiscalConfigError } from '../config/fiscal-errores';
import { RelojFiscal } from '../config/reloj-fiscal';
import { ClasificadorRespuestaSunat } from '../nucleo/clasificador-respuesta';
import type {
  DocumentoCpe,
  MaterialFirma,
} from '../nucleo/documento-fiscal.types';
import { esErrorNucleoFiscal } from '../nucleo/errores-nucleo';
import { PreparadorEnvioCpe } from '../nucleo/preparador-envio-cpe';
import type { EnvioCpePreparado } from '../nucleo/preparador-envio-cpe';
import { FabricaClienteSoapSunat } from '../nucleo/soap/sunat-soap-client';
import type {
  ResultadoEmisionBeta,
  TipoArchivoBeta,
} from './emision-beta.types';
import { EnvioBetaRepository } from './envio-beta.repository';

/** XML → firma verificable → ZIP → persistencia → SOAP BETA → CDR → persistencia. */
@Injectable()
export class SunatEmisionBetaService {
  private readonly logger = new Logger(SunatEmisionBetaService.name);
  constructor(
    private readonly repositorio: EnvioBetaRepository,
    private readonly preparador: PreparadorEnvioCpe,
    private readonly clientes: FabricaClienteSoapSunat,
    private readonly clasificador: ClasificadorRespuestaSunat,
    private readonly reloj: RelojFiscal,
  ) {}

  async emitir(
    doc: DocumentoCpe,
    material: MaterialFirma,
    idUsuario: number | null,
    idComprobante?: number,
    preparadoExistente?: EnvioCpePreparado,
  ): Promise<ResultadoEmisionBeta> {
    const preparado = preparadoExistente ?? (await this.preparar(doc, material));
    const cliente = this.clientes.crear({
      ambiente: 'beta',
      usuario: `${doc.emisor.ruc}MODDATOS`,
      clave: 'MODDATOS',
    });
    const id = await this.repositorio.registrarPreparado(
      doc,
      preparado,
      idUsuario,
      idComprobante,
    );
    return this.enviarGuardado(
      id,
      preparado.nombreBase,
      preparado.zip.base64,
      doc,
      preparado.digestValue,
      preparado.cadenaQr,
      cliente,
    );
  }

  async preparar(doc: DocumentoCpe, material: MaterialFirma): Promise<EnvioCpePreparado> {
    if (!material.ruc || material.ruc !== doc.emisor?.ruc) {
      throw new FiscalConfigError(
        'FISCAL_CERT_RUC_NO_COINCIDE',
        'El RUC del certificado y el emisor de la prueba deben coincidir. Configure el emisor BETA separado en el panel.',
      );
    }
    let preparado: ReturnType<PreparadorEnvioCpe['prepararComprobante']>;
    try {
      preparado = this.preparador.prepararComprobante(doc, material, {
        ahora: this.reloj.ahora(),
        hoy: this.reloj.ahora(),
      });
    } catch (error) {
      if (esErrorNucleoFiscal(error)) {
        throw new FiscalConfigError(
          'FISCAL_VALIDACION_CPE',
          error.message,
          error.detalle ? { ...error.detalle } : {},
        );
      }
      throw error;
    }
    return preparado;
  }

  async reintentar(id: number): Promise<ResultadoEmisionBeta> {
    const envio = await this.repositorio.tomarReenvio(id);
    if (!envio)
      throw new FiscalConfigError(
        'FISCAL_REENVIO_NO_PERMITIDO',
        'El envío no está disponible para un reintento seguro. Los envíos en curso, aceptados, rechazados o que requieren recuperar su CDR no se vuelven a enviar.',
      );
    const datos = envio.respuesta_json;
    if (!datos.documento?.emisor?.ruc)
      throw new FiscalConfigError(
        'FISCAL_CONFIG_INVALIDA',
        'El envío no conserva los datos necesarios para recuperarlo.',
      );
    const cliente = this.clientes.crear({
      ambiente: 'beta',
      usuario: `${datos.documento.emisor.ruc}MODDATOS`,
      clave: 'MODDATOS',
    });
    return this.enviarGuardado(
      id,
      envio.nombre_archivo.replace(/\.zip$/i, ''),
      envio.zip.toString('base64'),
      datos.documento,
      datos.digest,
      datos.cadena_qr,
      cliente,
    );
  }

  private async enviarGuardado(
    id: number,
    nombreBase: string,
    zipBase64: string,
    doc: DocumentoCpe,
    digest: string,
    cadenaQr: string,
    cliente: ReturnType<FabricaClienteSoapSunat['crear']>,
  ): Promise<ResultadoEmisionBeta> {
    const respuesta = await cliente.enviarComprobante(
      `${nombreBase}.zip`,
      zipBase64,
    );
    const decision = this.clasificador.clasificar(respuesta, {
      operacion: 'emitir',
      tipo: doc.tipo,
    });
    try {
      await this.repositorio.completar(id, nombreBase, respuesta, decision);
    } catch (error) {
      const e = error as {
        code?: string;
        driverError?: { code?: string };
        message?: string;
      };
      this.logger.error(
        `Envío BETA ${id}: no se pudo guardar la respuesta (${e.driverError?.code ?? e.code ?? 'BD'}): ${e.message ?? 'error desconocido'}`,
      );
      throw new ServiceUnavailableException({
        message:
          'SUNAT respondió, pero no se pudo guardar su respuesta. Revise este envío antes de repetir la prueba.',
        id_envio: id,
        ambiente: 'beta',
        estado_sunat: decision.estado,
        codigo_sunat: respuesta.codigo,
      });
    }
    const archivos: TipoArchivoBeta[] = ['xml_original', 'xml_firmado', 'zip'];
    if (respuesta.cdrXml) archivos.push('cdr_xml');
    if (respuesta.cdrZip) archivos.push('cdr_zip');
    return {
      ambiente: 'beta',
      id_envio: id,
      nombre_base: nombreBase,
      estado: decision.estado,
      aceptado:
        decision.estado === 'ACEPTADO' || decision.estado === 'ACEPTADO_OBS',
      codigo: respuesta.codigo,
      mensaje: respuesta.descripcion,
      observaciones: respuesta.observaciones,
      digest,
      cadena_qr: cadenaQr,
      archivos,
    };
  }
}
