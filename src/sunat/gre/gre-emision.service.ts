import { Injectable, Logger } from '@nestjs/common';
import { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import { FiscalConfigError } from '../config/fiscal-errores';
import { FiscalConfigService } from '../config/fiscal-config.service';
import type { SnapshotConfigFiscal } from '../config/fiscal-config.tipos';
import { RelojFiscal } from '../config/reloj-fiscal';
import { esRucValido } from '../nucleo/documentos-identidad';
import { PATRON_SERIE_GUIA } from '../nucleo/identificadores-cpe';
import { usuarioSolCorrespondeAlEmisor } from '../nucleo/reglas-envio';
import type { DiagnosticoSecreto } from '../seguridad/boveda-secretos.service';
import { CredencialesGre, CredencialesGreService } from '../seguridad/credenciales-gre.service';
import { CredencialesSolService } from '../seguridad/credenciales-sol.service';
import { consultaSinRespuesta, envioSinRespuesta } from './clasificador-gre';
import {
  ContextoGre,
  EmisionGre,
  GreEsperada,
  GrePreparada,
  ModoEmisionGre,
  ResultadoConsultaGre,
  ResultadoEnvioGre,
} from './gre.contrato';
import { ClienteRestGre } from './gre-rest-client';
import type { DocumentoGre, ResultadoValidacionGre } from './gre.tipos';
import { PreparadorGre } from './preparador-gre';
import { validarDocumentoGre } from './validaciones-gre';

/** Motivo legible de un secreto que no se puede usar (mismo criterio que el checklist del panel). */
function problemaSecreto(diagnostico: DiagnosticoSecreto, que: string, codigoFalta: string): { codigo: string; motivo: string } {
  switch (diagnostico) {
    case 'sin_esquema':
      return { codigo: 'FISCAL_MIGRACION_PENDIENTE', motivo: 'Falta aplicar la migración fiscal (sql/fase9_sunat_directo.sql) en la base de datos.' };
    case 'sin_cifrado':
      return { codigo: 'FISCAL_CLAVE_MAESTRA_NO_CONFIGURADA', motivo: `Hay ${que} guardado(s), pero falta FISCAL_SECRET_KEY en el servidor para leerlos.` };
    case 'ilegible':
      return { codigo: 'FISCAL_SECRETO_ILEGIBLE', motivo: `No se pudo descifrar ${que}: vuelva a registrarlo(s) en el panel de facturación.` };
    default:
      return { codigo: codigoFalta, motivo: `Registre ${que} en el panel de facturación.` };
  }
}

function mensajeDeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Motor de la GRE remitente para Nest (implementa el contrato EmisionGre). Puro respecto a la BD de
 * guías: no guarda nada; el negocio (G2) reserva el número, guarda el ZIP antes de enviar y persiste el
 * resultado. Solo habla con SUNAT en PRODUCCIÓN con la GRE activada: la GRE no tiene BETA aislado.
 */
@Injectable()
export class GreEmisionService implements EmisionGre {
  private readonly logger = new Logger(GreEmisionService.name);

  constructor(
    private readonly config: FiscalConfigService,
    private readonly certificado: CertificadoFiscalService,
    private readonly credencialesGre: CredencialesGreService,
    private readonly credencialesSol: CredencialesSolService,
    private readonly reloj: RelojFiscal,
    private readonly preparador: PreparadorGre,
    private readonly cliente: ClienteRestGre,
  ) {}

  /**
   * Activo solo con ambiente producción + GRE activada en el panel + emisión no detenida por el interruptor
   * + credenciales API (client_id/secret) + usuario y clave SOL + certificado de producción usable. Nunca
   * lanza: si algo falta lo explica con un código y un motivo.
   */
  async modo(): Promise<ModoEmisionGre> {
    try {
      const snapshot = await this.config.snapshot();
      if (snapshot.ambiente !== 'produccion') {
        return {
          activo: false,
          codigo: 'GRE_SIN_BETA',
          motivo: 'La GRE no tiene ambiente de pruebas en SUNAT: solo se puede validar sin enviar. Para emitirla, el ambiente fiscal debe ser producción y la GRE debe estar activada en el panel.',
        };
      }
      if (!snapshot.gre.activa) {
        return {
          activo: false,
          codigo: 'GRE_DESACTIVADA',
          motivo: 'La guía de remisión electrónica está desactivada en el panel de facturación: por ahora solo se puede validar sin enviar.',
        };
      }
      const bloqueo = snapshot.bloqueos?.produccion ?? null;
      if (bloqueo) {
        return {
          activo: false,
          codigo: 'FISCAL_EMISION_BLOQUEADA',
          motivo: `La emisión en producción está detenida (${bloqueo.codigo}: ${bloqueo.motivo}). Corrija la causa o use «Reanudar emisión» en el panel.`,
        };
      }
      if (!esRucValido(snapshot.emisor.ruc) || !snapshot.emisor.razonSocial?.trim()) {
        return { activo: false, codigo: 'FISCAL_CONFIG_INVALIDA', motivo: 'Complete el RUC y la razón social del emisor en el panel de facturación.' };
      }

      const [diagnosticoGre, diagnosticoSol, certificado] = await Promise.all([
        this.credencialesGre.diagnostico(),
        this.credencialesSol.diagnosticoClave(),
        this.certificado.infoActivo('produccion'),
      ]);
      if (diagnosticoGre !== 'ok') {
        return { activo: false, ...problemaSecreto(diagnosticoGre, 'el client_id y el client_secret de «Credenciales de API SUNAT»', 'FISCAL_CREDENCIALES_GRE_FALTAN') };
      }
      if (!snapshot.solUsuario) {
        return { activo: false, codigo: 'FISCAL_CREDENCIALES_SOL_FALTAN', motivo: 'Registre el usuario secundario SOL en el panel de facturación.' };
      }
      if (diagnosticoSol !== 'ok') {
        return { activo: false, ...problemaSecreto(diagnosticoSol, 'la clave del usuario secundario SOL', 'FISCAL_CREDENCIALES_SOL_FALTAN') };
      }
      const problemaCertificado = this.problemaCertificado(certificado, snapshot);
      if (problemaCertificado) return { activo: false, ...problemaCertificado };
      return { activo: true };
    } catch (error) {
      return { activo: false, codigo: 'FISCAL_LECTURA_ERROR', motivo: `No se pudo leer la configuración fiscal: ${mensajeDeError(error)}` };
    }
  }

  /** Emisor, serie de la GRE y punto de partida por defecto. Lanza FiscalConfigError si el emisor o la serie no permiten emitir. */
  async contexto(): Promise<ContextoGre> {
    const [emisor, snapshot] = await Promise.all([this.config.emisor(), this.config.snapshot()]);
    if (!esRucValido(emisor.ruc) || !emisor.razonSocial?.trim()) {
      throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', 'Complete el RUC y la razón social del emisor en el panel de facturación antes de emitir guías.');
    }
    const serie = snapshot.series.gre_remitente;
    if (!PATRON_SERIE_GUIA.test(serie)) {
      throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', `La serie de la GRE («${serie}») debe empezar con T y tener 4 caracteres (p. ej. T001).`);
    }
    const partida = snapshot.gre.partida;
    return {
      emisor,
      serie,
      partidaPorDefecto: { ubigeo: partida.ubigeo, direccion: partida.direccion, codigoEstablecimiento: partida.codigoEstablecimiento },
    };
  }

  validar(documento: DocumentoGre): ResultadoValidacionGre {
    return validarDocumentoGre(documento, { hoy: this.reloj.fechaLima() });
  }

  /**
   * Guardas duras ANTES de cualquier efecto (PLAN V3, D1.3): el remitente es el emisor configurado, el
   * certificado de producción es de ese RUC (o, si no trae RUC legible, el administrador lo confirmó en el
   * panel) y el usuario SOL empieza con ese RUC. Luego valida, arma, firma y empaqueta (sin red).
   */
  async prepararDocumento(documento: DocumentoGre): Promise<GrePreparada> {
    const snapshot = await this.config.snapshot();
    const rucRemitente = String(documento?.remitente?.ruc ?? '').trim();
    if (rucRemitente !== snapshot.emisor.ruc) {
      throw new FiscalConfigError(
        'FISCAL_CONFIG_INVALIDA',
        `El remitente de la guía (RUC ${rucRemitente || 'vacío'}) no es el emisor configurado (${snapshot.emisor.ruc}).`,
      );
    }
    const material = await this.certificado.obtenerMaterialFirma('produccion');
    const rucCertificado = String(material.ruc ?? '').trim();
    if (rucCertificado && rucCertificado !== rucRemitente) {
      throw new FiscalConfigError(
        'FISCAL_CERT_RUC_NO_COINCIDE',
        `El certificado digital de producción es del RUC ${rucCertificado} y la guía es de ${rucRemitente}: suba el certificado del emisor.`,
      );
    }
    if (!rucCertificado && !snapshot.certRucConfirmadoProduccion) {
      throw new FiscalConfigError(
        'FISCAL_CERT_RUC_SIN_CONFIRMAR',
        `No se pudo leer el RUC dentro del certificado de producción: confirme en el panel de facturación que pertenece a ${rucRemitente} antes de emitir.`,
      );
    }
    const sol = await this.certificado.obtenerCredencialesSol('produccion');
    if (!usuarioSolCorrespondeAlEmisor(sol.usuario, rucRemitente)) {
      throw new FiscalConfigError(
        'FISCAL_SOL_RUC_NO_COINCIDE',
        `El usuario SOL registrado no pertenece al RUC ${rucRemitente}: registre un usuario secundario SOL del emisor.`,
      );
    }
    return this.preparador.preparar(documento, material, { ahora: this.reloj.ahora(), hoy: this.reloj.fechaLima() });
  }

  /** Envía solo con la GRE activa en producción. Nunca lanza: todo problema vuelve como resultado normalizado. */
  async enviar(preparada: GrePreparada): Promise<ResultadoEnvioGre> {
    const modo = await this.modo();
    if (!modo.activo) return envioSinRespuesta('invalido', `No se envió la guía a SUNAT: ${modo.motivo}`);

    let credenciales: CredencialesGre;
    try {
      const rucRemitente = String(preparada.documento.remitente.ruc).trim();
      credenciales = await this.certificado.obtenerCredencialesGre('produccion');
      if (!usuarioSolCorrespondeAlEmisor(credenciales.usuarioSol, rucRemitente) || !preparada.nombreBase.startsWith(`${rucRemitente}-`)) {
        return envioSinRespuesta('invalido', `No se envió la guía: el usuario SOL o el archivo no corresponden al RUC ${rucRemitente}.`);
      }
    } catch (error) {
      return envioSinRespuesta('invalido', `No se envió la guía: ${mensajeDeError(error)}`);
    }
    const resultado = await this.cliente.enviarGre(credenciales, preparada);
    this.registrar('envío', preparada.nombreBase, resultado);
    return resultado;
  }

  /** Consulta el ticket (lectura, se puede repetir). Nunca lanza. No consulta con la emisión de producción detenida. */
  async consultarTicket(ticket: string, esperada?: GreEsperada): Promise<ResultadoConsultaGre> {
    let credenciales: CredencialesGre;
    try {
      const bloqueo = (await this.config.snapshot()).bloqueos?.produccion ?? null;
      if (bloqueo) {
        return consultaSinRespuesta(
          'invalido',
          `No se consultó a SUNAT: la emisión en producción está detenida (${bloqueo.codigo}: ${bloqueo.motivo}). Corrija la causa o use «Reanudar emisión» en el panel.`,
        );
      }
      credenciales = await this.certificado.obtenerCredencialesGre('produccion');
    } catch (error) {
      return consultaSinRespuesta('invalido', `No se pudo consultar el ticket: ${mensajeDeError(error)}`);
    }
    const resultado = await this.cliente.consultarTicket(credenciales, ticket, esperada);
    this.registrar('consulta', esperada ? `${esperada.serie}-${esperada.numero}` : `ticket ${ticket}`, resultado);
    return resultado;
  }

  private problemaCertificado(
    certificado: Awaited<ReturnType<CertificadoFiscalService['infoActivo']>>,
    snapshot: SnapshotConfigFiscal,
  ): { codigo: string; motivo: string } | null {
    if (!certificado) {
      return { codigo: 'FISCAL_CERT_NO_CARGADO', motivo: 'No hay certificado digital de producción: súbalo en el panel de facturación para firmar las guías.' };
    }
    if (certificado.vencido) {
      return { codigo: 'FISCAL_CERT_VENCIDO', motivo: 'El certificado digital de producción está vencido: suba uno vigente.' };
    }
    if (certificado.autofirmado) {
      return { codigo: 'FISCAL_CERT_AUTOFIRMADO', motivo: 'El certificado de producción es autofirmado: SUNAT lo rechazaría. Suba el certificado digital del emisor.' };
    }
    if (certificado.ruc && certificado.ruc !== snapshot.emisor.ruc) {
      return {
        codigo: 'FISCAL_CERT_RUC_NO_COINCIDE',
        motivo: `El certificado de producción es del RUC ${certificado.ruc} y el emisor es ${snapshot.emisor.ruc}: suba el certificado del emisor.`,
      };
    }
    if (!certificado.ruc && !snapshot.certRucConfirmadoProduccion) {
      return {
        codigo: 'FISCAL_CERT_RUC_SIN_CONFIRMAR',
        motivo: `No se pudo leer el RUC dentro del certificado de producción: confirme en el panel que pertenece a ${snapshot.emisor.ruc}.`,
      };
    }
    return null;
  }

  /** Deja rastro operativo sin secretos (el resultado ya viene saneado). */
  private registrar(operacion: string, referencia: string, resultado: ResultadoEnvioGre | ResultadoConsultaGre): void {
    if (resultado.estado === 'ERROR_CONFIG' || resultado.estado === 'PENDIENTE_REENVIO') {
      this.logger.warn(`GRE ${operacion} ${referencia}: ${resultado.estado}${resultado.codigo ? ` (${resultado.codigo})` : ''} - ${resultado.mensaje}`);
    }
  }
}
