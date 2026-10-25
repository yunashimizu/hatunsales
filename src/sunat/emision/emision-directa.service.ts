import { Injectable, Logger } from '@nestjs/common';
import { ACCIONES_AUDITORIA_FISCAL, FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import type { MaterialFirma } from '../certificado/material-firma';
import { RepositorioConfigFiscal } from '../config/config-fiscal.repository';
import { CodigoFiscal, FiscalConfigError } from '../config/fiscal-errores';
import { FiscalConfigService } from '../config/fiscal-config.service';
import {
  ActorFiscal,
  AmbienteFiscal,
  CLAVES_CONFIG_FISCAL,
  EmisorFiscal,
  SnapshotConfigFiscal,
} from '../config/fiscal-config.tipos';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import { defectosDesdeEntorno, leerAmbiente } from '../config/snapshot-config-fiscal';
import { TransaccionesFiscales } from '../config/transacciones-fiscales';
import type { DocumentoCpe } from '../nucleo/documento-fiscal.types';
import { usuarioSolCorrespondeAlEmisor } from '../nucleo/reglas-envio';
import { CredencialesSolService } from '../seguridad/credenciales-sol.service';
import {
  ArchivoEnvio,
  ConsultorTx,
  ContextoEmision,
  DocumentoPreparado,
  EmisionDirecta,
  EnvioVista,
  FiltroEnvios,
  ModoEmision,
  ResultadoEmision,
  SeriesEmision,
  TIPOS_ARCHIVO_ENVIO,
  TipoArchivoEnvio,
} from './emision.contrato';
import { AVISO_BETA, NOMBRE_AMBIENTE, SERIES_BETA } from './emision.tipos';
import { EmisorBetaService } from './emisor-beta.service';
import { EnvioFiscalRepository } from './envio-fiscal.repository';
import { ResultadoPruebaCredenciales, SunatEmisionService } from './sunat-emision.service';

/** Estado del interruptor «emisión de prueba del POS en SUNAT BETA» (GET/PUT /fiscal/beta/pos). */
export interface EstadoPosBeta {
  habilitado: boolean;
  activo: boolean;
  ambiente: AmbienteFiscal;
  listo: boolean;
  ruc_emisor_beta: string;
  ruc_certificado_beta: string | null;
  advertencia: string;
}

function inactivo(ambiente: AmbienteFiscal, codigo: CodigoFiscal, motivo: string): ModoEmision {
  return { activo: false, ambiente, codigo, motivo };
}

/** Las 6 series de comprobante configuradas (sin la de la GRE). */
function seriesDe(snapshot: SnapshotConfigFiscal): SeriesEmision {
  const { factura, boleta, nc_factura, nc_boleta, nd_factura, nd_boleta } = snapshot.series;
  return { factura, boleta, nc_factura, nc_boleta, nd_factura, nd_boleta };
}

function copiaEmisor(emisor: EmisorFiscal): EmisorFiscal {
  return { ...emisor, nombreComercial: emisor.nombreComercial ?? '' };
}

/**
 * Emisión directa de factura, boleta y notas, igual en BETA y PRODUCCIÓN (contrato EmisionDirecta).
 *
 * - BETA: emite solo con el interruptor «POS en prueba BETA» encendido, con el emisor y el certificado
 *   de pruebas, series FB01/BB01/… y credenciales públicas RUC+MODDATOS.
 * - PRODUCCIÓN: emite solo con el proveedor 'sunat_directo' (la activación exige el checklist completo),
 *   con el emisor real, el certificado de producción y el usuario secundario SOL.
 * - Nunca se mezclan: todo sale del ambiente leído en ESTA petición (sin caché) y registrarEnvio
 *   comprueba que no cambió entre preparar y guardar.
 */
@Injectable()
export class EmisionDirectaService implements EmisionDirecta {
  private readonly logger = new Logger(EmisionDirectaService.name);

  constructor(
    private readonly config: FiscalConfigService,
    private readonly configuraciones: RepositorioConfigFiscal,
    private readonly esquema: FiscalEsquemaService,
    private readonly emisorBeta: EmisorBetaService,
    private readonly certificados: CertificadoFiscalService,
    private readonly credencialesSol: CredencialesSolService,
    private readonly emision: SunatEmisionService,
    private readonly envios: EnvioFiscalRepository,
    private readonly auditoria: FiscalAuditoriaRepository,
    private readonly transacciones: TransaccionesFiscales,
  ) {}

  // ── Interruptor de la emisión de prueba del POS (/fiscal/beta/pos) ───────

  async estado(): Promise<EstadoPosBeta> {
    const [snapshot, emisor, certificado, esquemaListo] = await Promise.all([
      this.config.snapshotFresco(),
      this.emisorBeta.obtenerEmisor(),
      this.certificados.infoActivo('beta'),
      this.esquema.tiene('emision', 'secretos'),
    ]);
    const certificadoListo = !!certificado && !certificado.vencido && certificado.ruc === emisor.ruc;
    return {
      habilitado: snapshot.posBetaActivo,
      activo: snapshot.posBetaActivo && snapshot.ambiente === 'beta',
      ambiente: snapshot.ambiente,
      listo: esquemaListo && certificadoListo,
      ruc_emisor_beta: emisor.ruc,
      ruc_certificado_beta: certificado?.ruc ?? null,
      advertencia:
        'Solo emite comprobantes de prueba en SUNAT BETA usando el emisor BETA configurado. No tiene validez tributaria ni reemplaza la emisión real.',
    };
  }

  async cambiarEstado(activo: boolean, actor: ActorFiscal): Promise<EstadoPosBeta> {
    if (activo) {
      await this.esquema.exigir('emision', 'secretos', 'auditoria');
      if ((await this.config.snapshotFresco()).ambiente !== 'beta') {
        throw new FiscalConfigError('FISCAL_SOLO_BETA', 'La emisión comercial de prueba solo se puede activar con el ambiente fiscal BETA.');
      }
      const emisor = await this.emisorBeta.obtenerEmisor();
      const material = await this.certificados.obtenerMaterialFirmaBeta();
      if (!material.ruc || material.ruc !== emisor.ruc) {
        throw new FiscalConfigError('FISCAL_CERT_RUC_NO_COINCIDE', 'El certificado BETA debe pertenecer al mismo RUC del emisor BETA.');
      }
    }
    await this.transacciones.ejecutar(async (tx) => {
      await this.configuraciones.guardar({ [CLAVES_CONFIG_FISCAL.posBetaActivo]: String(activo) }, tx);
      await this.auditoria.registrar(
        {
          accion: activo ? ACCIONES_AUDITORIA_FISCAL.POS_BETA_ACTIVADO : ACCIONES_AUDITORIA_FISCAL.POS_BETA_DESACTIVADO,
          id_usuario: actor.id_usuario,
          entidad: 'fiscal_beta_pos',
          detalle: { activo, usuario: actor.nombre },
          ip: actor.ip,
        },
        tx,
      );
    });
    this.config.invalidar();
    return this.estado();
  }

  // ── Contrato EmisionDirecta ──────────────────────────────────────────────

  async modo(): Promise<ModoEmision> {
    return (await this.leerEstado()).modo;
  }

  async contexto(): Promise<ContextoEmision> {
    const { snapshot, modo } = await this.leerEstado();
    if (!modo.activo || !snapshot) {
      const { codigo, motivo } = modo as Extract<ModoEmision, { activo: false }>;
      throw new FiscalConfigError(codigo as CodigoFiscal, motivo);
    }
    if (modo.ambiente === 'beta') {
      const [emisor, correlativo] = await Promise.all([
        this.emisorBeta.obtenerEmisor(),
        this.envios.primerosLibresBeta(Object.values(SERIES_BETA)),
      ]);
      return { ambiente: 'beta', emisor: copiaEmisor(emisor), series: { ...SERIES_BETA }, aviso: AVISO_BETA, correlativo_inicial: correlativo };
    }
    const series = seriesDe(snapshot);
    const correlativo: Record<string, number> = {};
    for (const serie of Object.values(series) as string[]) {
      const inicial = snapshot.correlativoInicialCpe[serie];
      if (inicial) correlativo[serie] = inicial;
    }
    return { ambiente: 'produccion', emisor: copiaEmisor(snapshot.emisor), series, aviso: null, correlativo_inicial: correlativo };
  }

  /**
   * Valida, arma, firma y empaqueta con el material del ambiente. Antes de cualquier efecto aplica las
   * guardas de D1: RUC del certificado (o su confirmación) y, en producción, usuario SOL del emisor.
   */
  async prepararDocumento(documento: DocumentoCpe): Promise<DocumentoPreparado> {
    const { snapshot, modo } = await this.leerEstado();
    if (!modo.activo || !snapshot) {
      const { codigo, motivo } = modo as Extract<ModoEmision, { activo: false }>;
      throw new FiscalConfigError(codigo as CodigoFiscal, motivo);
    }
    const ambiente = modo.ambiente;
    await this.esquema.exigir('emision', 'secretos');

    const emisor = ambiente === 'beta' ? await this.emisorBeta.obtenerEmisor() : snapshot.emisor;
    const series = ambiente === 'beta' ? SERIES_BETA : seriesDe(snapshot);
    if (documento?.emisor?.ruc !== emisor.ruc || !Object.values(series).includes(documento.serie)) {
      throw new FiscalConfigError(
        'FISCAL_AMBIENTE_CAMBIO',
        `El comprobante no corresponde al ambiente vigente (${NOMBRE_AMBIENTE[ambiente]}: emisor ${emisor.ruc}, series `
          + `${Object.values(series).join(', ')}). Vuelva a emitirlo: no se reservó ningún número.`,
        { ambiente },
      );
    }

    const material: MaterialFirma =
      ambiente === 'beta' ? await this.certificados.obtenerMaterialFirmaBeta() : await this.certificados.obtenerMaterialFirma('produccion');
    this.exigirRucCertificado(ambiente, material, emisor.ruc, snapshot);
    if (ambiente === 'produccion') {
      const credenciales = await this.credencialesSol.obtener('produccion');
      if (!usuarioSolCorrespondeAlEmisor(credenciales.usuario, emisor.ruc)) {
        throw new FiscalConfigError(
          'FISCAL_SOL_RUC_NO_COINCIDE',
          `El usuario SOL registrado no es del RUC emisor ${emisor.ruc}: SUNAT rechazaría el envío. Registre un usuario secundario de ese RUC.`,
        );
      }
    }

    const reglas2027 = snapshot.reglas2027 === 'auto' ? 'auto' : snapshot.reglas2027 === 'true';
    const preparado = this.emision.preparar(documento, material, reglas2027);
    return { ambiente, documento, material, preparado };
  }

  async registrarEnvio(consultor: ConsultorTx, preparado: DocumentoPreparado, idComprobante: number, idUsuario: number | null): Promise<number> {
    const vigente = await this.ambienteVigente(consultor);
    if (vigente !== preparado.ambiente) {
      throw new FiscalConfigError(
        'FISCAL_AMBIENTE_CAMBIO',
        `El ambiente fiscal cambió a ${NOMBRE_AMBIENTE[vigente]} mientras se preparaba este comprobante de ${NOMBRE_AMBIENTE[preparado.ambiente]}. `
          + 'No se guardó nada: vuelva a emitirlo con el ambiente vigente.',
        { ambiente_preparado: preparado.ambiente, ambiente_vigente: vigente },
      );
    }
    if (!Number.isSafeInteger(idComprobante) || idComprobante <= 0) {
      throw new Error(`registrarEnvio necesita el id del comprobante recién insertado (recibió ${String(idComprobante)}).`);
    }
    return this.emision.registrar(consultor, preparado.ambiente, preparado.documento, preparado.preparado, idComprobante, idUsuario);
  }

  enviarRegistrado(idEnvio: number, preparado?: DocumentoPreparado): Promise<ResultadoEmision> {
    return this.emision.enviar(
      idEnvio,
      preparado ? { ambiente: preparado.ambiente, documento: preparado.documento, preparado: preparado.preparado } : undefined,
    );
  }

  async emitirPreparado(preparado: DocumentoPreparado, idComprobante: number, idUsuario: number | null): Promise<ResultadoEmision> {
    const idEnvio = await this.transacciones.ejecutar((tx) => this.registrarEnvio(tx, preparado, idComprobante, idUsuario));
    return this.enviarRegistrado(idEnvio, preparado);
  }

  reintentar(idEnvio: number): Promise<ResultadoEmision> {
    return this.emision.reintentar(idEnvio, 'reintento');
  }

  recuperarCdr(idEnvio: number): Promise<ResultadoEmision> {
    return this.emision.recuperarCdr(idEnvio);
  }

  confirmarAceptadoManual(idEnvio: number, idUsuario: number, nota: string): Promise<ResultadoEmision> {
    return this.emision.confirmarAceptadoManual(idEnvio, idUsuario, nota);
  }

  async obtenerArchivo(idEnvio: number, tipo: TipoArchivoEnvio): Promise<ArchivoEnvio | null> {
    if (!(TIPOS_ARCHIVO_ENVIO as readonly string[]).includes(tipo)) {
      throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', `Tipo de archivo no válido. Use: ${TIPOS_ARCHIVO_ENVIO.join(', ')}.`);
    }
    return this.envios.archivo(idEnvio, tipo);
  }

  listarEnvios(filtro: FiltroEnvios): Promise<{ datos: EnvioVista[]; total: number; pagina: number; por_pagina: number }> {
    return this.envios.listar(filtro ?? {});
  }

  obtenerEnvio(idEnvio: number): Promise<EnvioVista | null> {
    return this.envios.obtener(idEnvio);
  }

  // ── Panel ────────────────────────────────────────────────────────────────

  /** D1.4: prueba el usuario secundario SOL de producción con una consulta que no emite nada. */
  async probarCredencialesProduccion(actor: ActorFiscal): Promise<ResultadoPruebaCredenciales> {
    const snapshot = await this.config.snapshotFresco();
    return this.emision.probarCredencialesProduccion(snapshot.emisor.ruc, snapshot.series.factura, actor);
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  /** Una lectura fresca por petición (nada de caché para decidir si se emite). Nunca lanza. */
  private async leerEstado(): Promise<{ snapshot: SnapshotConfigFiscal | null; modo: ModoEmision }> {
    let ambiente: AmbienteFiscal = defectosDesdeEntorno().ambiente;
    try {
      const snapshot = await this.config.snapshotFresco();
      ambiente = snapshot.ambiente;
      return { snapshot, modo: await this.modoDe(snapshot) };
    } catch (error) {
      this.logger.error(`No se pudo leer la configuración fiscal: ${error instanceof Error ? error.message : String(error)}`);
      return {
        snapshot: null,
        modo: inactivo(
          ambiente,
          'FISCAL_LECTURA_ERROR',
          'No se pudo leer la configuración de facturación electrónica: la venta se registra sin comprobante. Intente emitirlo en unos segundos.',
        ),
      };
    }
  }

  private async modoDe(snapshot: SnapshotConfigFiscal): Promise<ModoEmision> {
    const ambiente = snapshot.ambiente;
    const esquema = await this.esquema.estado();
    if (!esquema.verificado) {
      return inactivo(ambiente, 'FISCAL_LECTURA_ERROR', 'No se pudo verificar la base de datos fiscal: la venta se registra sin comprobante. Intente de nuevo en unos segundos.');
    }
    if (!esquema.grupos.emision || !esquema.grupos.secretos) {
      return inactivo(
        ambiente,
        'FISCAL_MIGRACION_PENDIENTE',
        'Falta aplicar sql/fase9_sunat_directo.sql en la base de datos: las ventas se registran sin comprobante electrónico.',
      );
    }
    if (ambiente === 'beta' && !snapshot.posBetaActivo) {
      return inactivo(
        ambiente,
        'FISCAL_BETA_POS_APAGADO',
        'La emisión de prueba en SUNAT BETA está apagada: la venta se registra sin comprobante. Actívela en Facturación SUNAT para probar.',
      );
    }
    if (ambiente === 'produccion' && snapshot.proveedor !== 'sunat_directo') {
      return inactivo(
        ambiente,
        'FISCAL_EMISION_INACTIVA',
        'La emisión electrónica de producción no está activada: la venta se registra sin comprobante. Actívela en Facturación SUNAT cuando la lista de requisitos esté completa.',
      );
    }
    const bloqueo = snapshot.bloqueos[ambiente];
    if (bloqueo) {
      return inactivo(
        ambiente,
        'FISCAL_EMISION_BLOQUEADA',
        `La emisión está detenida: ${bloqueo.motivo} Corrija la causa y reanúdela desde Facturación SUNAT; mientras tanto las ventas se registran sin comprobante.`,
      );
    }
    return { activo: true, ambiente };
  }

  /** D1: el certificado debe ser del emisor; si su RUC no se puede leer, en producción vale la confirmación del administrador. */
  private exigirRucCertificado(ambiente: AmbienteFiscal, material: MaterialFirma, rucEmisor: string, snapshot: SnapshotConfigFiscal): void {
    if (material.ruc) {
      if (material.ruc !== rucEmisor) {
        throw new FiscalConfigError(
          'FISCAL_CERT_RUC_NO_COINCIDE',
          `El certificado de ${NOMBRE_AMBIENTE[ambiente]} es del RUC ${material.ruc} y el emisor es ${rucEmisor}: SUNAT rechazaría la firma. `
            + 'Suba el certificado del emisor o corrija el RUC.',
        );
      }
      return;
    }
    if (ambiente === 'beta') {
      throw new FiscalConfigError(
        'FISCAL_CERT_RUC_NO_COINCIDE',
        'No se pudo leer el RUC del certificado BETA: use un certificado de prueba con el RUC del emisor BETA (puede generarlo en el panel).',
      );
    }
    if (!snapshot.certRucConfirmadoProduccion) {
      throw new FiscalConfigError(
        'FISCAL_CERT_RUC_SIN_CONFIRMAR',
        `No se pudo leer el RUC dentro del certificado de producción. Confirme en Facturación SUNAT que pertenece a ${rucEmisor} antes de emitir.`,
      );
    }
  }

  /** Dentro de la transacción del negocio: el ambiente que hay AHORA en configuraciones. */
  private async ambienteVigente(consultor: ConsultorTx): Promise<AmbienteFiscal> {
    const valores = await this.configuraciones.leer([CLAVES_CONFIG_FISCAL.ambiente], consultor);
    return leerAmbiente(valores[CLAVES_CONFIG_FISCAL.ambiente], defectosDesdeEntorno().ambiente);
  }
}
