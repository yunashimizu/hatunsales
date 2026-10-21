import { Injectable } from '@nestjs/common';
import { FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import { RepositorioConfigFiscal } from '../config/config-fiscal.repository';
import { FiscalConfigError } from '../config/fiscal-errores';
import { FiscalConfigService } from '../config/fiscal-config.service';
import { CLAVES_CONFIG_FISCAL } from '../config/fiscal-config.tipos';
import type { ActorFiscal } from '../config/fiscal-config.tipos';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import { TransaccionesFiscales } from '../config/transacciones-fiscales';
import { EmisorBetaService } from './emisor-beta.service';
import { SunatEmisionBetaService } from './sunat-emision-beta.service';
import type { ResultadoEmisionBeta } from './emision-beta.types';
import type { DocumentoCpe } from '../nucleo/documento-fiscal.types';
import type { MaterialFirma } from '../certificado/material-firma';
import type { EnvioCpePreparado } from '../nucleo/preparador-envio-cpe';

export const CLAVE_POS_BETA_ACTIVO = 'fiscal_beta_pos_directo';

export interface PosBetaPreparado {
  documento: DocumentoCpe;
  material: MaterialFirma;
  preparado: EnvioCpePreparado;
}

@Injectable()
export class PosBetaService {
  constructor(
    private readonly repo: RepositorioConfigFiscal,
    private readonly fiscal: FiscalConfigService,
    private readonly esquema: FiscalEsquemaService,
    private readonly emisor: EmisorBetaService,
    private readonly certificados: CertificadoFiscalService,
    private readonly emision: SunatEmisionBetaService,
    private readonly auditoria: FiscalAuditoriaRepository,
    private readonly transacciones: TransaccionesFiscales,
  ) {}

  async estado() {
    const [valor, ambiente, emisor, certificado] = await Promise.all([
      this.repo.leer([CLAVE_POS_BETA_ACTIVO]),
      this.fiscal.ambiente(),
      this.emisor.obtenerEmisor(),
      this.certificados.infoActivo('beta'),
    ]);
    const habilitado = valor[CLAVE_POS_BETA_ACTIVO] === 'true';
    const esquemaListo = await this.esquema.tiene('emision', 'secretos');
    const certificadoListo =
      !!certificado &&
      !certificado.vencido &&
      certificado.ruc === emisor.ruc;
    const activo = habilitado && ambiente === 'beta';

    return {
      habilitado,
      activo,
      ambiente,
      listo: esquemaListo && certificadoListo,
      ruc_emisor_beta: emisor.ruc,
      ruc_certificado_beta: certificado?.ruc ?? null,
      advertencia:
        'Solo emite comprobantes de prueba en SUNAT BETA usando el emisor BETA configurado. No tiene validez tributaria ni reemplaza la emisión real.',
    };
  }

  async cambiarEstado(activo: boolean, actor: ActorFiscal) {
    if (activo) {
      await this.esquema.exigir('emision', 'secretos', 'auditoria');
      if ((await this.fiscal.ambiente()) !== 'beta') {
        throw new FiscalConfigError(
          'FISCAL_SOLO_BETA',
          'La emisión comercial de prueba solo se puede activar con el ambiente fiscal BETA.',
        );
      }
      const emisor = await this.emisor.obtenerEmisor();
      const material = await this.certificados.obtenerMaterialFirmaBeta();
      if (!material.ruc || material.ruc !== emisor.ruc) {
        throw new FiscalConfigError(
          'FISCAL_CERT_RUC_NO_COINCIDE',
          'El certificado BETA debe pertenecer al mismo RUC del emisor BETA.',
        );
      }
    }

    await this.transacciones.ejecutar(async (tx) => {
      await this.repo.guardar({ [CLAVE_POS_BETA_ACTIVO]: String(activo) }, tx);
      await this.auditoria.registrar(
        {
          accion: activo ? 'POS_BETA_ACTIVADO' : 'POS_BETA_DESACTIVADO',
          id_usuario: actor.id_usuario,
          entidad: 'fiscal_beta_pos',
          detalle: { activo },
          ip: actor.ip,
        },
        tx,
      );
    });
    return this.estado();
  }

  async activoEnBeta(): Promise<boolean> {
    const valor = await this.repo.leer([CLAVE_POS_BETA_ACTIVO]);
    if (valor[CLAVE_POS_BETA_ACTIVO] !== 'true') return false;
    return (await this.fiscal.ambiente()) === 'beta';
  }

  async emisorParaDocumento() {
    const emisor = await this.emisor.obtenerEmisor();
    return {
      ruc: emisor.ruc,
      razonSocial: emisor.razonSocial,
      nombreComercial: emisor.nombreComercial,
      direccion: emisor.direccion,
      ubigeo: emisor.ubigeo,
      distrito: emisor.distrito,
      provincia: emisor.provincia,
      departamento: emisor.departamento,
      codigoEstablecimiento: emisor.codigoEstablecimiento,
    };
  }

  async siguienteCorrelativo(): Promise<number> {
    return this.fiscal.siguienteCorrelativoBeta();
  }

  async siguienteCorrelativoVista(): Promise<number> {
    const valores = await this.repo.leer([CLAVES_CONFIG_FISCAL.betaCorrelativo]);
    const actual = Number(valores[CLAVES_CONFIG_FISCAL.betaCorrelativo] ?? 0);
    return Number.isSafeInteger(actual) && actual >= 0 ? actual + 1 : 1;
  }

  async prepararDocumento(documento: DocumentoCpe): Promise<PosBetaPreparado> {
    if (!(await this.activoEnBeta())) {
      throw new FiscalConfigError(
        'FISCAL_SOLO_BETA',
        'La emisión comercial SUNAT BETA está desactivada.',
      );
    }
    await this.esquema.exigir('emision', 'secretos');
    const emisor = await this.emisor.obtenerEmisor();
    const material = await this.certificados.obtenerMaterialFirmaBeta();
    if (!material.ruc || material.ruc !== emisor.ruc || documento.emisor.ruc !== emisor.ruc) {
      throw new FiscalConfigError(
        'FISCAL_CERT_RUC_NO_COINCIDE',
        'El RUC del certificado BETA, el emisor BETA y el documento deben coincidir.',
      );
    }
    const preparado = await this.emision.preparar(documento, material);
    return { documento, material, preparado };
  }

  emitirPreparado(
    datos: PosBetaPreparado,
    idComprobante: number,
    idUsuario: number | null,
  ): Promise<ResultadoEmisionBeta> {
    return this.emision.emitir(
      datos.documento,
      datos.material,
      idUsuario,
      idComprobante,
      datos.preparado,
    );
  }

  reintentar(idEnvio: number): Promise<ResultadoEmisionBeta> {
    return this.emision.reintentar(idEnvio);
  }
}
