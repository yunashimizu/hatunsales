import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ACCIONES_AUDITORIA_FISCAL, FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import type { MaterialFirma } from '../certificado/material-firma';
import { FiscalConfigError } from '../config/fiscal-errores';
import type { ActorFiscal, AmbienteFiscal } from '../config/fiscal-config.tipos';
import { InterruptorEmisionFiscal } from '../config/interruptor-emision.service';
import { RelojFiscal } from '../config/reloj-fiscal';
import { TransaccionesFiscales } from '../config/transacciones-fiscales';
import { CredencialesSolService } from '../seguridad/credenciales-sol.service';
import { verificarCdr } from '../nucleo/cdr/verificar-cdr';
import { ClasificadorRespuestaSunat } from '../nucleo/clasificador-respuesta';
import type {
  ClasificacionRespuesta,
  DocumentoCpe,
  EstadoSunat,
  RespuestaSunat,
} from '../nucleo/documento-fiscal.types';
import { esErrorDeConfiguracion, esErrorNucleoFiscal } from '../nucleo/errores-nucleo';
import { EnvioCpePreparado, PreparadorEnvioCpe } from '../nucleo/preparador-envio-cpe';
import {
  admiteGetStatusCdr,
  esDocumentoDeFactura,
  fechaLimiteEnvioIndividual,
  usuarioSolCorrespondeAlEmisor,
} from '../nucleo/reglas-envio';
import { FabricaClienteSoapSunat, SunatSoapClient, TIMEOUT_POS_MS, TIMEOUT_WORKER_MS } from '../nucleo/soap/sunat-soap-client';
import {
  ConsultorTx,
  EventoEnvioCompletado,
  OyentesEnvioFiscal,
  ResultadoEmision,
  TIPOS_ARCHIVO_ENVIO,
  TipoArchivoEnvio,
} from './emision.contrato';
import {
  CierreEnvio,
  CODIGOS_REGISTRADO_CON_OTROS_DATOS,
  EnvioCerrado,
  EnvioRegistrado,
  ESPERA_REINTENTO_MINUTOS,
  MAXIMO_INTENTOS_AUTOMATICOS,
  NOMBRE_AMBIENTE,
  OrigenEnvio,
} from './emision.tipos';
import { EnvioFiscalRepository } from './envio-fiscal.repository';

/** Documento ya preparado en memoria (el negocio lo pasa para no releer el ZIP de la BD). */
export interface EnvioEnMemoria {
  ambiente: AmbienteFiscal;
  documento: DocumentoCpe;
  preparado: EnvioCpePreparado;
}

export interface ResultadoPruebaCredenciales {
  ok: boolean;
  /** statusCode o código del Fault de SUNAT, o el código local si no se llegó a consultar. */
  codigo: string | null;
  mensaje: string;
  /** Texto de SUNAT, si respondió. */
  detalle: string | null;
  consulta: { tipo: '01'; serie: string; numero: number };
  tiempo_ms: number;
}

/** Número que no existe en ninguna serie real: la consulta prueba las credenciales sin tocar nada (D1.4). */
export const NUMERO_PRUEBA_CREDENCIALES = 99_999_999;

/** Reintentos del guardado de la respuesta de SUNAT antes de rendirse con 503 (D5.3). */
const REINTENTOS_GUARDADO = 3;

const MENSAJES_CREDENCIAL_SOL: Readonly<Record<string, string>> = {
  '0101': 'SUNAT no aceptó el encabezado de seguridad: vuelva a registrar el usuario y la clave SOL.',
  '0102': 'SUNAT no reconoce el usuario o la clave SOL: revise el usuario secundario (sin el RUC) y su clave.',
  '0103': 'El usuario SOL no existe: registre el usuario secundario tal como figura en SOL.',
  '0104': 'La clave SOL es incorrecta: regístrela de nuevo.',
  '0105': 'El usuario secundario SOL no está activo: actívelo en SOL › Administración de usuarios secundarios.',
  '0106': 'El usuario secundario SOL no es válido: revíselo en SOL › Administración de usuarios secundarios.',
  '0109': 'El servicio de autenticación de SUNAT no está disponible: intente de nuevo en unos minutos.',
  '0110': 'SUNAT no pudo identificar el tipo de usuario: intente de nuevo en unos minutos.',
  '0111': 'El usuario secundario no tiene el perfil para enviar comprobantes electrónicos: asígneselo en SOL.',
  '0112': 'SUNAT exige un usuario SECUNDARIO: cree uno en SOL (no use el usuario principal).',
  '0113': 'El RUC no está afiliado como emisor electrónico: complete el alta en SOL (SEE - Del Contribuyente).',
  '0154': 'El RUC del usuario SOL no corresponde al emisor: use un usuario secundario del RUC del emisor.',
};

function esAceptado(estado: string): boolean {
  return estado === 'ACEPTADO' || estado === 'ACEPTADO_OBS';
}

function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Sin los bytes del CDR: en respuesta_json va solo el resumen (la respuesta cruda ya viene redactada). */
function resumen(respuesta: RespuestaSunat): Omit<RespuestaSunat, 'cdrZip' | 'cdrXml'> {
  return {
    tipo: respuesta.tipo,
    codigo: respuesta.codigo,
    descripcion: respuesta.descripcion,
    observaciones: respuesta.observaciones,
    ticket: respuesta.ticket,
    statusCode: respuesta.statusCode,
    httpStatus: respuesta.httpStatus,
    tiempoMs: respuesta.tiempoMs,
    raw: respuesta.raw,
    estadoComprobante: respuesta.estadoComprobante,
  };
}

/**
 * Motor de la emisión directa para BETA y PRODUCCIÓN: prepara (valida, XML, firma, ZIP), registra,
 * envía por SOAP con las credenciales del ambiente del envío, verifica el CDR contra el comprobante
 * (D4), guarda el resultado (D5.3), abre el interruptor si SUNAT rechaza la credencial o el
 * certificado (D5.4) y avisa a los oyentes. Nunca repite sendBill por su cuenta: los reenvíos son
 * siempre el MISMO ZIP y pasan por reintentar() (manual o desde la tarea), que en producción consulta
 * antes el CDR de las facturas y respeta los plazos (D5.1/D5.2).
 */
@Injectable()
export class SunatEmisionService {
  private readonly logger = new Logger(SunatEmisionService.name);

  constructor(
    private readonly envios: EnvioFiscalRepository,
    private readonly preparador: PreparadorEnvioCpe,
    private readonly clientes: FabricaClienteSoapSunat,
    private readonly clasificador: ClasificadorRespuestaSunat,
    private readonly credencialesSol: CredencialesSolService,
    private readonly interruptor: InterruptorEmisionFiscal,
    private readonly oyentes: OyentesEnvioFiscal,
    private readonly auditoria: FiscalAuditoriaRepository,
    private readonly transacciones: TransaccionesFiscales,
    private readonly reloj: RelojFiscal,
  ) {}

  /** Valida, arma el XML, firma y empaqueta. Sin red ni BD: un error aquí nunca quema número. */
  preparar(documento: DocumentoCpe, material: MaterialFirma, aplicarReglas2027: boolean | 'auto' = 'auto'): EnvioCpePreparado {
    try {
      return this.preparador.prepararComprobante(documento, material, {
        ahora: this.reloj.ahora(),
        hoy: this.reloj.ahora(),
        aplicarReglas2027,
      });
    } catch (error) {
      if (esErrorNucleoFiscal(error)) {
        throw new FiscalConfigError(
          esErrorDeConfiguracion(error) ? 'FISCAL_CONFIG_INVALIDA' : 'FISCAL_VALIDACION_CPE',
          error.message,
          error.detalle ? { ...error.detalle } : {},
        );
      }
      throw error;
    }
  }

  /** Dentro de la transacción del llamador: envío ENVIANDO + artefactos + datos fiscales del comprobante. */
  registrar(
    consultor: ConsultorTx,
    ambiente: AmbienteFiscal,
    documento: DocumentoCpe,
    preparado: EnvioCpePreparado,
    idComprobante: number | null,
    idUsuario: number | null,
  ): Promise<number> {
    return this.envios.registrar(consultor, {
      ambiente,
      documento,
      preparado,
      idComprobante,
      idUsuario,
      fechaLimiteEnvio: fechaLimiteEnvioIndividual(documento.tipo, documento.serie, documento.fechaEmision),
    });
  }

  /** Primer envío de un envío registrado (después del COMMIT del negocio). */
  async enviar(idEnvio: number, enMemoria?: EnvioEnMemoria): Promise<ResultadoEmision> {
    const envio = await this.envios.reclamarPrimerEnvio(idEnvio, !enMemoria);
    if (!envio) {
      const actual = await this.envios.leer(idEnvio);
      if (!actual) throw new FiscalConfigError('FISCAL_DOC_NO_ENCONTRADO', `No existe el envío ${idEnvio}.`);
      return this.resultadoActual(actual, 'El envío ya está en proceso o tiene respuesta de SUNAT; no se volvió a enviar.');
    }
    if (enMemoria && (enMemoria.ambiente !== envio.ambiente || enMemoria.preparado.nombreBase !== envio.nombre_base)) {
      throw new Error(`El documento preparado no corresponde al envío ${idEnvio} (${envio.nombre_base}, ${envio.ambiente}).`);
    }
    const documento = enMemoria?.documento ?? envio.datos?.documento;
    const zip = enMemoria ? enMemoria.preparado.zip.base64 : envio.zip?.toString('base64');
    if (!documento || !zip) {
      return this.cerrar(envio, documento ?? null, this.sinDatos(), 'envio');
    }
    return this.enviarZip(envio, documento, zip, 'envio', TIMEOUT_POS_MS);
  }

  /** Comprobante de prueba del panel (BETA): sin comprobante comercial, con su propio número. */
  async emitirPrueba(documento: DocumentoCpe, material: MaterialFirma, idUsuario: number | null): Promise<ResultadoEmision> {
    if (!material.ruc || material.ruc !== documento.emisor?.ruc) {
      throw new FiscalConfigError(
        'FISCAL_CERT_RUC_NO_COINCIDE',
        'El RUC del certificado y el del emisor de la prueba deben coincidir. Configure el emisor BETA en el panel.',
      );
    }
    const preparado = this.preparar(documento, material);
    const idEnvio = await this.transacciones.ejecutar((tx) => this.registrar(tx, 'beta', documento, preparado, null, idUsuario));
    return this.enviar(idEnvio, { ambiente: 'beta', documento, preparado });
  }

  /**
   * Reenvío seguro del MISMO ZIP (D5.1). En producción, las facturas y sus notas consultan antes su
   * CDR: si SUNAT ya lo tiene, se completa sin reenviar. Respeta plazos (D5.2) e interruptor (D5.4).
   */
  async reintentar(idEnvio: number, origen: 'reintento' | 'tarea' = 'reintento'): Promise<ResultadoEmision> {
    const actual = await this.envios.leer(idEnvio);
    if (!actual) throw new FiscalConfigError('FISCAL_DOC_NO_ENCONTRADO', `No existe el envío ${idEnvio}.`);
    this.exigirReintentable(actual);
    await this.exigirSinBloqueo(actual.ambiente);

    const envio = await this.envios.reclamarReintento(idEnvio);
    if (!envio) {
      throw new FiscalConfigError('FISCAL_ENVIO_EN_CURSO', 'Otro proceso está enviando este comprobante ahora mismo; actualice en unos segundos.');
    }
    const documento = envio.datos?.documento;
    if (!documento?.emisor?.ruc || !envio.zip) return this.cerrar(envio, documento ?? null, this.sinDatos(), origen);

    const timeout = origen === 'tarea' ? TIMEOUT_WORKER_MS : TIMEOUT_POS_MS;
    if (this.fueraDePlazo(envio)) return this.cerrarFueraDePlazo(envio, documento, origen, timeout);

    if (envio.ambiente === 'produccion' && admiteGetStatusCdr(documento.tipo, documento.serie)) {
      const consulta = await this.consultar(envio, documento, timeout);
      if (consulta instanceof FiscalConfigError) return this.cerrar(envio, documento, this.sinConsulta(envio, consulta.message), origen);
      if (consulta.tipo === 'CDR') return this.procesar(envio, documento, consulta, origen, 'consulta');
      if (consulta.tipo === 'ESTADO' && consulta.estadoComprobante && consulta.estadoComprobante !== 'NO_EXISTE' && consulta.estadoComprobante !== 'DESCONOCIDO') {
        return this.procesar(envio, documento, consulta, origen, 'consulta');
      }
      if (!(consulta.tipo === 'ESTADO' && consulta.estadoComprobante === 'NO_EXISTE')) {
        return this.conservarTrasConsulta(envio, documento, consulta, origen);
      }
      // SUNAT no lo tiene: se reenvía el mismo ZIP.
    }
    return this.enviarZip(envio, documento, envio.zip.toString('base64'), origen, timeout);
  }

  /**
   * Solo consulta el CDR (getStatusCdr; producción y facturas o sus notas). Un CDR recuperado tras
   * 1033/2109 no se acepta solo aunque coincida: queda para la confirmación manual del administrador (D4).
   */
  async recuperarCdr(idEnvio: number): Promise<ResultadoEmision> {
    const actual = await this.envios.leer(idEnvio);
    if (!actual) throw new FiscalConfigError('FISCAL_DOC_NO_ENCONTRADO', `No existe el envío ${idEnvio}.`);
    const documento = actual.datos?.documento;
    if (actual.ambiente === 'beta') {
      throw new FiscalConfigError(
        'FISCAL_CONSULTA_NO_DISPONIBLE',
        'SUNAT no ofrece la consulta de constancias (CDR) en BETA: verifique el envío y, si corresponde, confírmelo manualmente.',
      );
    }
    if (!documento || !admiteGetStatusCdr(documento.tipo, documento.serie)) {
      throw new FiscalConfigError(
        'FISCAL_CONSULTA_NO_DISPONIBLE',
        'SUNAT solo entrega por consulta la constancia de facturas y de sus notas (series F). Para boletas y sus notas '
          + 'verifique el comprobante en SUNAT Operaciones en Línea y confírmelo manualmente.',
      );
    }
    if (!['PENDIENTE_REENVIO', 'ENVIANDO', 'EXCEPCION'].includes(actual.estado)) {
      throw new FiscalConfigError(
        'FISCAL_CONSULTA_NO_DISPONIBLE',
        `El envío ya tiene una respuesta definitiva de SUNAT (${actual.estado}); no hace falta consultarlo.`,
      );
    }
    await this.exigirSinBloqueo(actual.ambiente);

    const envio = await this.envios.reclamarConsulta(idEnvio);
    if (!envio) {
      throw new FiscalConfigError('FISCAL_ENVIO_EN_CURSO', 'El comprobante se está enviando o consultando ahora mismo; actualice en unos segundos.');
    }
    const consulta = await this.consultar(envio, documento, TIMEOUT_POS_MS);
    if (consulta instanceof FiscalConfigError) return this.cerrar(envio, documento, this.sinConsulta(envio, consulta.message), 'recuperacion');
    if (consulta.tipo === 'CDR') return this.procesar(envio, documento, consulta, 'recuperacion', 'consulta');
    if (consulta.tipo === 'ESTADO' && consulta.estadoComprobante === 'NO_EXISTE') {
      if (this.fueraDePlazo(envio)) return this.cerrar(envio, documento, this.cierrePlazo(envio, documento), 'recuperacion');
      const mensaje = 'SUNAT no tiene registrado este comprobante: puede reenviarlo (se manda el mismo XML firmado).';
      return this.cerrar(
        envio,
        documento,
        {
          estado: 'PENDIENTE_REENVIO',
          accion: 'REINTENTAR',
          mensaje,
          sunat: this.datosSunat(consulta),
          json: { consulta: resumen(consulta), clasificacion: { estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', mensajeUsuario: mensaje } },
          proximoIntentoMin: 0,
        },
        'recuperacion',
      );
    }
    if (consulta.tipo === 'ESTADO' && (consulta.estadoComprobante === 'ACEPTADO' || consulta.estadoComprobante === 'RECHAZADO' || consulta.estadoComprobante === 'DE_BAJA')) {
      return this.procesar(envio, documento, consulta, 'recuperacion', 'consulta');
    }
    return this.conservarTrasConsulta(envio, documento, consulta, 'recuperacion');
  }

  /**
   * El administrador verificó en SUNAT Operaciones en Línea un envío de resultado incierto: queda
   * ACEPTADO con su usuario, su nota y la evidencia en fiscal_auditoria (misma transacción). No llama a SUNAT.
   */
  async confirmarAceptadoManual(idEnvio: number, idUsuario: number, nota: string): Promise<ResultadoEmision> {
    const texto = String(nota ?? '').trim();
    if (texto.length < 5 || texto.length > 300) {
      throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', 'La nota debe tener entre 5 y 300 caracteres: indique qué verificó en SUNAT.');
    }
    const actual = await this.envios.leer(idEnvio);
    if (!actual) throw new FiscalConfigError('FISCAL_DOC_NO_ENCONTRADO', `No existe el envío ${idEnvio}.`);
    const incierto = (actual.estado === 'PENDIENTE_REENVIO' && actual.accion === 'RECUPERAR_CDR') || (actual.estado === 'ENVIANDO' && actual.libre);
    if (!incierto) {
      throw new FiscalConfigError(
        'FISCAL_CONFIRMACION_NO_PERMITIDA',
        'Solo se confirma a mano un envío cuyo resultado quedó incierto (SUNAT indicó que ya lo había recibido o no respondió). '
          + `Este está en ${actual.estado}.`,
      );
    }
    const evidencia = {
      estado_anterior: actual.estado,
      accion_anterior: actual.accion,
      codigo_sunat: actual.codigo_sunat,
      intento: actual.intento,
      identificador: actual.nombre_base,
      ambiente: actual.ambiente,
      tipo_documento: actual.tipo_documento,
      id_comprobante: actual.id_comprobante,
    };
    const mensaje = 'Aceptado: confirmado manualmente por el administrador tras verificarlo en SUNAT.';
    const fecha = this.reloj.ahora().toISOString();
    const cerrado = await this.transacciones.ejecutar(async (tx) => {
      const fila = await this.envios.marcarAceptadoManual(tx, idEnvio, mensaje, {
        clasificacion: { estado: 'ACEPTADO', accion: 'NINGUNA', mensajeUsuario: mensaje },
        confirmacion_manual: { id_usuario: idUsuario, nota: texto, fecha, evidencia },
      });
      if (!fila) return null;
      await this.auditoria.registrar(
        {
          accion: ACCIONES_AUDITORIA_FISCAL.ENVIO_CONFIRMADO_MANUAL,
          id_usuario: idUsuario,
          entidad: 'fiscal_envios',
          id_entidad: idEnvio,
          detalle: { nota: texto, evidencia },
        },
        tx,
      );
      return fila;
    });
    if (!cerrado) {
      throw new FiscalConfigError('FISCAL_CONFIRMACION_NO_PERMITIDA', 'El envío cambió de estado mientras se confirmaba: actualice la vista y revíselo de nuevo.');
    }
    const cierre: CierreEnvio = { estado: 'ACEPTADO', accion: 'NINGUNA', mensaje, sunat: null, json: {}, proximoIntentoMin: null };
    await this.avisar(actual, cerrado, 'ACEPTADO', 'manual');
    return this.resultado(actual, actual.datos?.documento ?? null, cierre, cerrado.archivos);
  }

  /**
   * D1.4: getStatusCdr de un comprobante que no existe (factura, serie configurada, 99999999) con las
   * credenciales SOL de PRODUCCIÓN. 0011 = credenciales y perfil correctos. Nunca envía ni numera nada.
   */
  async probarCredencialesProduccion(rucEmisor: string, serieFactura: string, actor: ActorFiscal): Promise<ResultadoPruebaCredenciales> {
    const inicio = this.reloj.ms();
    const consulta = { tipo: '01' as const, serie: serieFactura, numero: NUMERO_PRUEBA_CREDENCIALES };
    let resultado: Omit<ResultadoPruebaCredenciales, 'consulta' | 'tiempo_ms'>;
    try {
      const cliente = await this.cliente('produccion', rucEmisor, TIMEOUT_POS_MS);
      const respuesta = await cliente.consultarCdr(rucEmisor, '01', serieFactura, NUMERO_PRUEBA_CREDENCIALES);
      resultado = this.interpretarPruebaCredenciales(respuesta, rucEmisor);
    } catch (error) {
      if (!(error instanceof FiscalConfigError)) throw error;
      resultado = { ok: false, codigo: error.codigo, mensaje: error.message, detalle: null };
    }
    const tiempo = this.reloj.ms() - inicio;
    try {
      await this.auditoria.registrar({
        accion: ACCIONES_AUDITORIA_FISCAL.PRUEBA_CREDENCIALES_PRODUCCION,
        id_usuario: actor.id_usuario,
        entidad: 'fiscal',
        id_entidad: 'sol_produccion',
        detalle: { usuario: actor.nombre, ok: resultado.ok, codigo: resultado.codigo, consulta },
        ip: actor.ip,
      });
    } catch (error) {
      this.logger.warn(`No se pudo auditar la prueba de credenciales SOL: ${mensajeDe(error)}`);
    }
    return { ...resultado, consulta, tiempo_ms: tiempo };
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  /** Manda el ZIP ya reclamado (primer envío o reintento) con las credenciales de SU ambiente. */
  private async enviarZip(
    envio: EnvioRegistrado,
    documento: DocumentoCpe,
    zipBase64: string,
    origen: OrigenEnvio,
    timeoutMs: number,
  ): Promise<ResultadoEmision> {
    const bloqueo = await this.interruptor.leer(envio.ambiente);
    if (bloqueo) {
      // No se llama a SUNAT con una credencial que ya rechazó: se enviará cuando se reanude.
      const mensaje = `La emisión en ${NOMBRE_AMBIENTE[envio.ambiente]} está detenida: ${bloqueo.motivo} El comprobante se enviará cuando se reanude.`;
      return this.cerrar(envio, documento, this.pendiente(mensaje, null, 0), origen);
    }
    let cliente: SunatSoapClient;
    try {
      cliente = await this.cliente(envio.ambiente, documento.emisor.ruc, timeoutMs);
    } catch (error) {
      if (!(error instanceof FiscalConfigError)) throw error;
      return this.cerrar(envio, documento, this.pendienteConEspera(envio, `No se envió a SUNAT: ${error.message}`), origen);
    }
    const respuesta = await cliente.enviarComprobante(envio.nombre_archivo, zipBase64);
    return this.procesar(envio, documento, respuesta, origen, 'envio');
  }

  /** Clasifica, verifica el CDR, guarda (con reintentos), abre el interruptor si corresponde y avisa. */
  private async procesar(
    envio: EnvioRegistrado,
    documento: DocumentoCpe,
    respuesta: RespuestaSunat,
    origen: OrigenEnvio,
    etapa: 'envio' | 'consulta',
  ): Promise<ResultadoEmision> {
    const decision = this.clasificador.clasificar(respuesta, {
      operacion: etapa === 'envio' ? 'emitir' : 'consulta',
      tipo: documento.tipo,
      ambiente: envio.ambiente,
      serie: documento.serie,
    });
    const otrosDatos = CODIGOS_REGISTRADO_CON_OTROS_DATOS.has(respuesta.codigo);
    const json: Record<string, unknown> = { [etapa === 'envio' ? 'respuesta' : 'consulta']: resumen(respuesta) };
    if (otrosDatos) json.registrado_con_otros_datos = true;

    let cierre: CierreEnvio;
    const verificacion = respuesta.cdrXml
      ? verificarCdr(respuesta.cdrXml, {
          rucEmisor: documento.emisor.ruc,
          tipo: documento.tipo,
          serie: documento.serie,
          numero: documento.numero,
          nombreBase: envio.nombre_base,
          tipoDocReceptor: documento.cliente?.tipoDoc ?? null,
          numDocReceptor: documento.cliente?.numDoc ?? null,
        })
      : null;
    if (verificacion && !verificacion.coincide) {
      // D4: un CDR que no es de este comprobante no decide nada; se guarda para auditoría.
      const mensaje = `La constancia (CDR) no corresponde al comprobante enviado: ${verificacion.motivo ?? 'datos distintos'}`;
      const accion = envio.ambiente === 'produccion' && admiteGetStatusCdr(documento.tipo, documento.serie) ? 'RECUPERAR_CDR' : 'NINGUNA';
      cierre = {
        estado: 'EXCEPCION',
        accion,
        mensaje,
        sunat: { codigo: respuesta.codigo, descripcion: mensaje, observaciones: respuesta.observaciones ?? [], tiempoMs: respuesta.tiempoMs },
        json: {
          ...json,
          verificacion_cdr: { coincide: false, motivo: verificacion.motivo ?? null, codigo_cdr: verificacion.codigo },
          clasificacion: { estado: 'EXCEPCION', accion, mensajeUsuario: mensaje },
        },
        cdr: { xml: respuesta.cdrXml, zip: respuesta.cdrZip },
        proximoIntentoMin: null,
      };
    } else if (etapa === 'consulta' && esAceptado(decision.estado) && (envio.registrado_con_otros_datos || otrosDatos)) {
      // D4: tras 1033/2109 el número ya existía con otros datos; el administrador confirma tras compararlo.
      const mensaje =
        `SUNAT devolvió la constancia de ${documento.serie}-${documento.numero} (código ${respuesta.codigo}), pero antes indicó que ese número `
        + 'se había registrado con otros datos. Descargue la constancia, compárela con su comprobante y, si es el suyo, confírmelo como aceptado.';
      cierre = {
        estado: 'PENDIENTE_REENVIO',
        accion: 'RECUPERAR_CDR',
        mensaje,
        sunat: this.datosSunat(respuesta),
        json: { ...json, clasificacion: { estado: 'PENDIENTE_REENVIO', accion: 'RECUPERAR_CDR', mensajeUsuario: mensaje } },
        cdr: respuesta.cdrXml ? { xml: respuesta.cdrXml, zip: respuesta.cdrZip } : null,
        proximoIntentoMin: null,
      };
    } else {
      cierre = this.desdeDecision(envio, decision, respuesta, json);
    }

    if (decision.bloqueaEmision) await this.abrirInterruptor(envio, respuesta, decision);
    return this.cerrar(envio, documento, cierre, origen);
  }

  private desdeDecision(
    envio: EnvioRegistrado,
    decision: ClasificacionRespuesta,
    respuesta: RespuestaSunat,
    json: Record<string, unknown>,
  ): CierreEnvio {
    let estado: EstadoSunat = decision.estado;
    let accion = decision.accion;
    let mensaje = decision.mensajeUsuario;
    // Un Fault de credencial (D5.4) significa que SUNAT no procesó el documento: se reenviará al reanudar.
    if (respuesta.tipo === 'FAULT' && decision.bloqueaEmision) {
      estado = 'PENDIENTE_REENVIO';
      accion = 'REINTENTAR';
      mensaje = `${decision.mensajeUsuario} La emisión quedó detenida y este comprobante se enviará cuando se reanude.`;
    }
    let proximoIntentoMin: number | null = null;
    if (estado === 'PENDIENTE_REENVIO' && accion === 'REINTENTAR') {
      if (decision.bloqueaEmision) {
        proximoIntentoMin = 0;
      } else if (envio.intento >= MAXIMO_INTENTOS_AUTOMATICOS) {
        estado = 'EXCEPCION';
        accion = 'NINGUNA';
        mensaje = `Se intentó ${envio.intento} veces sin una respuesta válida de SUNAT: revise manualmente el comprobante. Última respuesta: ${decision.mensajeUsuario}`;
      } else {
        proximoIntentoMin = this.esperaMinutos(envio.intento);
      }
    }
    return {
      estado,
      accion,
      mensaje,
      sunat: this.datosSunat(respuesta),
      json: { ...json, clasificacion: { estado, accion, mensajeUsuario: mensaje, bloqueaEmision: decision.bloqueaEmision === true } },
      cdr: respuesta.cdrXml || respuesta.cdrZip ? { xml: respuesta.cdrXml, zip: respuesta.cdrZip } : null,
      proximoIntentoMin,
    };
  }

  /** Consulta sin resultado definitivo: el envío conserva su situación (y su código anterior) con el mensaje. */
  private async conservarTrasConsulta(
    envio: EnvioRegistrado,
    documento: DocumentoCpe,
    consulta: RespuestaSunat,
    origen: OrigenEnvio,
  ): Promise<ResultadoEmision> {
    const decision = this.clasificador.clasificar(consulta, {
      operacion: 'consulta',
      tipo: documento.tipo,
      ambiente: envio.ambiente,
      serie: documento.serie,
    });
    if (decision.bloqueaEmision) await this.abrirInterruptor(envio, consulta, decision);
    const cierre = this.sinConsulta(envio, `No se pudo confirmar el estado en SUNAT: ${decision.mensajeUsuario}`);
    return this.cerrar(envio, documento, { ...cierre, json: { ...cierre.json, consulta: resumen(consulta) } }, origen);
  }

  /** Mantiene RECUPERAR_CDR y EXCEPCION; lo demás queda pendiente de reintento con espera. */
  private sinConsulta(envio: EnvioRegistrado, mensaje: string): CierreEnvio {
    const anterior = envio.estado_anterior ?? envio.estado;
    if (anterior === 'EXCEPCION' || (anterior === 'PENDIENTE_REENVIO' && envio.accion === 'RECUPERAR_CDR')) {
      const estado = anterior as EstadoSunat;
      const accion = (envio.accion as CierreEnvio['accion']) ?? 'NINGUNA';
      return { estado, accion, mensaje, sunat: null, json: { clasificacion: { estado, accion, mensajeUsuario: mensaje } }, proximoIntentoMin: null };
    }
    return this.pendienteConEspera(envio, mensaje);
  }

  private pendienteConEspera(envio: EnvioRegistrado, mensaje: string): CierreEnvio {
    if (envio.intento >= MAXIMO_INTENTOS_AUTOMATICOS) {
      const final = `Se intentó ${envio.intento} veces sin poder confirmar el envío: revise manualmente el comprobante. ${mensaje}`;
      return { estado: 'EXCEPCION', accion: 'NINGUNA', mensaje: final, sunat: null, json: { clasificacion: { estado: 'EXCEPCION', accion: 'NINGUNA', mensajeUsuario: final } }, proximoIntentoMin: null };
    }
    return this.pendiente(mensaje, null, this.esperaMinutos(envio.intento));
  }

  private pendiente(mensaje: string, sunat: CierreEnvio['sunat'], proximoIntentoMin: number): CierreEnvio {
    return {
      estado: 'PENDIENTE_REENVIO',
      accion: 'REINTENTAR',
      mensaje,
      sunat,
      json: { clasificacion: { estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', mensajeUsuario: mensaje } },
      proximoIntentoMin,
    };
  }

  /** El envío no conserva el documento o su ZIP: no se puede reenviar ni verificar. */
  private sinDatos(): CierreEnvio {
    const mensaje = 'El envío no conserva el documento o su ZIP firmado: no se puede reenviar. Emita un comprobante nuevo.';
    return { estado: 'EXCEPCION', accion: 'EMITIR_NUEVO', mensaje, sunat: null, json: { clasificacion: { estado: 'EXCEPCION', accion: 'EMITIR_NUEVO', mensajeUsuario: mensaje } }, proximoIntentoMin: null };
  }

  private fueraDePlazo(envio: EnvioRegistrado): boolean {
    return !!envio.fecha_limite_envio && this.reloj.fechaLima() > envio.fecha_limite_envio;
  }

  /** D5.2: pasado el plazo no se reenvía por sendBill. Las facturas de producción consultan antes su CDR. */
  private async cerrarFueraDePlazo(
    envio: EnvioRegistrado,
    documento: DocumentoCpe,
    origen: OrigenEnvio,
    timeoutMs: number,
  ): Promise<ResultadoEmision> {
    if (envio.ambiente === 'produccion' && admiteGetStatusCdr(documento.tipo, documento.serie)) {
      const consulta = await this.consultar(envio, documento, timeoutMs);
      if (!(consulta instanceof FiscalConfigError)) {
        const definitiva =
          consulta.tipo === 'CDR'
          || (consulta.tipo === 'ESTADO' && ['ACEPTADO', 'RECHAZADO', 'DE_BAJA'].includes(consulta.estadoComprobante ?? ''));
        if (definitiva) return this.procesar(envio, documento, consulta, origen, 'consulta');
      }
    }
    return this.cerrar(envio, documento, this.cierrePlazo(envio, documento), origen);
  }

  private cierrePlazo(envio: EnvioRegistrado, documento: DocumentoCpe): CierreEnvio {
    const limite = envio.fecha_limite_envio ?? '';
    const deFactura = esDocumentoDeFactura(documento.tipo, documento.serie);
    const mensaje = deFactura
      ? `Fuera de plazo: emita un comprobante nuevo. El plazo para enviar ${documento.serie}-${documento.numero} a SUNAT venció el ${limite}.`
      : `Fuera del plazo de envío individual: informe la boleta por resumen diario en SUNAT (el envío individual de ${documento.serie}-${documento.numero} venció el ${limite}).`;
    const accion = deFactura ? 'EMITIR_NUEVO' : 'NINGUNA';
    return { estado: 'EXCEPCION', accion, mensaje, sunat: null, json: { clasificacion: { estado: 'EXCEPCION', accion, mensajeUsuario: mensaje } }, proximoIntentoMin: null };
  }

  /** getStatusCdr con las credenciales de producción; un problema de credenciales vuelve como error (no se lanza). */
  private async consultar(envio: EnvioRegistrado, documento: DocumentoCpe, timeoutMs: number): Promise<RespuestaSunat | FiscalConfigError> {
    try {
      const cliente = await this.cliente(envio.ambiente, documento.emisor.ruc, timeoutMs);
      return await cliente.consultarCdr(documento.emisor.ruc, documento.tipo, documento.serie, documento.numero);
    } catch (error) {
      if (error instanceof FiscalConfigError) return error;
      throw error;
    }
  }

  /** BETA: RUC del emisor de la prueba + MODDATOS. PRODUCCIÓN: el usuario secundario SOL del panel. */
  private async cliente(ambiente: AmbienteFiscal, rucEmisor: string, timeoutMs: number): Promise<SunatSoapClient> {
    const credenciales =
      ambiente === 'beta'
        ? { usuario: `${rucEmisor}${CredencialesSolService.SUFIJO_BETA}`, clave: CredencialesSolService.CLAVE_BETA }
        : await this.credencialesSol.obtener('produccion');
    if (!usuarioSolCorrespondeAlEmisor(credenciales.usuario, rucEmisor)) {
      throw new FiscalConfigError(
        'FISCAL_SOL_RUC_NO_COINCIDE',
        `El usuario SOL registrado no es del RUC emisor ${rucEmisor}: SUNAT rechazaría el envío (0154). Registre un usuario secundario de ese RUC.`,
      );
    }
    try {
      return this.clientes.crear({ ambiente, usuario: credenciales.usuario, clave: credenciales.clave, timeoutMs });
    } catch (error) {
      if (esErrorNucleoFiscal(error)) throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', error.message);
      throw error;
    }
  }

  /** Guarda el cierre con hasta 3 reintentos de BD (D5.3); luego avisa a los oyentes. */
  private async cerrar(
    envio: EnvioRegistrado,
    documento: DocumentoCpe | null,
    cierre: CierreEnvio,
    origen: OrigenEnvio,
  ): Promise<ResultadoEmision> {
    let cerrado: EnvioCerrado | null = null;
    for (let intento = 0; ; intento++) {
      try {
        cerrado = await this.envios.completar(envio.id_envio, envio.ambiente, envio.nombre_base, cierre);
        break;
      } catch (error) {
        const e = error as { code?: string; driverError?: { code?: string } };
        if (intento >= REINTENTOS_GUARDADO) {
          this.logger.error(
            `Envío ${envio.id_envio} (${envio.ambiente}): no se pudo guardar la respuesta de SUNAT (${e.driverError?.code ?? e.code ?? 'BD'}): ${mensajeDe(error)}`,
          );
          throw new ServiceUnavailableException({
            message: 'SUNAT respondió, pero no se pudo guardar su respuesta. El envío quedó pendiente y se puede recuperar; revíselo antes de repetirlo.',
            codigo: 'FISCAL_SUNAT_NO_DISPONIBLE',
            id_envio: envio.id_envio,
            ambiente: envio.ambiente,
            estado_sunat: cierre.estado,
            codigo_sunat: cierre.sunat?.codigo ?? null,
          });
        }
        this.logger.warn(`Envío ${envio.id_envio}: reintento ${intento + 1} del guardado de la respuesta (${mensajeDe(error)}).`);
        await this.esperar(250 * 2 ** intento);
      }
    }
    if (!cerrado) {
      // Otro proceso lo cerró antes (p. ej. ya quedó aceptado): no se pisa su resultado.
      const actual = await this.envios.leer(envio.id_envio);
      return this.resultadoActual(actual ?? envio, 'El envío ya tenía un resultado de SUNAT; se conservó.');
    }
    await this.avisar(envio, cerrado, cierre.estado, origen);
    return this.resultado(envio, documento, cierre, [...cerrado.archivos, ...(cierre.cdr?.xml ? ['cdr_xml'] : []), ...(cierre.cdr?.zip?.length ? ['cdr_zip'] : [])]);
  }

  private async avisar(envio: EnvioRegistrado, cerrado: EnvioCerrado, estado: EstadoSunat, origen: OrigenEnvio): Promise<void> {
    const evento: EventoEnvioCompletado = {
      id_envio: envio.id_envio,
      id_comprobante: cerrado.id_comprobante,
      ambiente: envio.ambiente,
      tipo_documento: cerrado.tipo_documento || envio.tipo_documento,
      estado,
      aceptado: esAceptado(estado),
      origen,
    };
    await this.oyentes.notificar(evento);
  }

  private async abrirInterruptor(envio: EnvioRegistrado, respuesta: RespuestaSunat, decision: ClasificacionRespuesta): Promise<void> {
    try {
      await this.interruptor.abrir(
        envio.ambiente,
        { codigo: respuesta.codigo, motivo: decision.mensajeUsuario },
        { id_envio: envio.id_envio, tipo_documento: envio.tipo_documento },
      );
      this.logger.warn(`Emisión de ${envio.ambiente} detenida por SUNAT (${respuesta.codigo}) en el envío ${envio.id_envio}.`);
    } catch (error) {
      this.logger.error(`No se pudo detener la emisión de ${envio.ambiente} tras el código ${respuesta.codigo}: ${mensajeDe(error)}`);
    }
  }

  private async exigirSinBloqueo(ambiente: AmbienteFiscal): Promise<void> {
    const bloqueo = await this.interruptor.leer(ambiente);
    if (bloqueo) {
      throw new FiscalConfigError(
        'FISCAL_EMISION_BLOQUEADA',
        `La emisión en ${NOMBRE_AMBIENTE[ambiente]} está detenida: ${bloqueo.motivo} Corrija la causa y reanúdela desde Facturación SUNAT antes de reintentar.`,
        { bloqueo },
      );
    }
  }

  private exigirReintentable(envio: EnvioRegistrado): void {
    if (envio.estado === 'PENDIENTE_REENVIO' && envio.accion !== 'RECUPERAR_CDR') return;
    if (envio.estado === 'ENVIANDO' && envio.libre) return;
    const motivo =
      envio.estado === 'ENVIANDO'
        ? 'se está enviando ahora mismo'
        : envio.accion === 'RECUPERAR_CDR'
          ? 'SUNAT indicó que ya lo había recibido: recupere su constancia o confírmelo manualmente'
          : `su estado es ${envio.estado}`;
    throw new FiscalConfigError(
      'FISCAL_REENVIO_NO_PERMITIDO',
      `El envío no está disponible para un reintento seguro (${motivo}). Solo se reenvían los pendientes de reenvío y los que quedaron sin respuesta.`,
    );
  }

  private esperaMinutos(intento: number): number {
    const indice = Math.min(Math.max(intento, 1), ESPERA_REINTENTO_MINUTOS.length) - 1;
    return ESPERA_REINTENTO_MINUTOS[indice];
  }

  private datosSunat(respuesta: RespuestaSunat): CierreEnvio['sunat'] {
    return {
      codigo: respuesta.codigo,
      descripcion: respuesta.descripcion,
      observaciones: respuesta.observaciones ?? [],
      tiempoMs: respuesta.tiempoMs,
    };
  }

  private interpretarPruebaCredenciales(
    respuesta: RespuestaSunat,
    rucEmisor: string,
  ): Omit<ResultadoPruebaCredenciales, 'consulta' | 'tiempo_ms'> {
    const base = { codigo: respuesta.codigo || null, detalle: respuesta.descripcion || null };
    if (respuesta.tipo === 'CDR' || (respuesta.tipo === 'ESTADO' && ['NO_EXISTE', 'ACEPTADO', 'RECHAZADO', 'DE_BAJA'].includes(respuesta.estadoComprobante ?? ''))) {
      return {
        ...base,
        ok: true,
        mensaje: 'Credenciales SOL de producción correctas: SUNAT aceptó el usuario secundario y respondió la consulta (no se envió ni numeró ningún comprobante).',
      };
    }
    if (respuesta.tipo === 'FAULT' && MENSAJES_CREDENCIAL_SOL[respuesta.codigo]) {
      return { ...base, ok: false, mensaje: MENSAJES_CREDENCIAL_SOL[respuesta.codigo].replace('del RUC del emisor', `del RUC ${rucEmisor}`) };
    }
    if (respuesta.tipo === 'TRANSPORTE') {
      return { ...base, ok: false, mensaje: `No se pudo conectar con SUNAT (${respuesta.codigo}): revise la conexión del servidor e intente de nuevo.` };
    }
    if (respuesta.tipo === 'ESTADO' && respuesta.codigo === '0012') {
      return { ...base, ok: false, mensaje: `SUNAT indica que el comprobante consultado no pertenece al usuario: revise que el usuario SOL sea del RUC ${rucEmisor}.` };
    }
    return { ...base, ok: false, mensaje: `SUNAT respondió ${respuesta.codigo}: ${respuesta.descripcion}. Revise el usuario secundario y su perfil en SOL.` };
  }

  /** Resultado de un envío que no se tocó (otro proceso lo tiene o ya tiene respuesta). */
  private resultadoActual(envio: EnvioRegistrado, mensaje: string): ResultadoEmision {
    const estado = (envio.estado || 'ENVIANDO') as EstadoSunat;
    const cierre: CierreEnvio = { estado, accion: (envio.accion as CierreEnvio['accion']) ?? 'NINGUNA', mensaje, sunat: null, json: {}, proximoIntentoMin: null };
    return this.resultado(envio, envio.datos?.documento ?? null, cierre, []);
  }

  private resultado(envio: EnvioRegistrado, documento: DocumentoCpe | null, cierre: CierreEnvio, archivos: string[]): ResultadoEmision {
    const presentes = new Set(['xml_original', 'xml_firmado', 'zip', ...archivos]);
    return {
      ambiente: envio.ambiente,
      id_envio: envio.id_envio,
      nombre_base: envio.nombre_base,
      estado: cierre.estado,
      aceptado: esAceptado(cierre.estado),
      codigo: cierre.sunat?.codigo ?? envio.codigo_sunat ?? null,
      mensaje: cierre.mensaje,
      observaciones: cierre.sunat?.observaciones ?? [],
      digest: envio.datos?.digest ?? '',
      cadena_qr: envio.datos?.cadena_qr ?? '',
      accion: cierre.accion,
      archivos: TIPOS_ARCHIVO_ENVIO.filter((tipo: TipoArchivoEnvio) => presentes.has(tipo)),
      id_comprobante: envio.id_comprobante,
      serie: documento?.serie,
      numero: documento?.numero,
      fecha_limite_envio: envio.fecha_limite_envio,
    };
  }

  /** Pausa entre reintentos del guardado (se reemplaza en los specs). */
  protected esperar(ms: number): Promise<void> {
    return new Promise((resolver) => setTimeout(resolver, ms));
  }
}
