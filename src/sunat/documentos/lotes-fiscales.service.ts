import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ACCIONES_AUDITORIA_FISCAL, FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import type { MaterialFirma } from '../certificado/material-firma';
import { FiscalConfigError } from '../config/fiscal-errores';
import { FiscalConfigService } from '../config/fiscal-config.service';
import type { AmbienteFiscal, SnapshotConfigFiscal } from '../config/fiscal-config.tipos';
import { EMISOR_PRUEBA_BETA } from '../config/fiscal-tokens';
import type { EmisorPruebaBeta } from '../config/fiscal-tokens';
import { InterruptorEmisionFiscal } from '../config/interruptor-emision.service';
import { RelojFiscal } from '../config/reloj-fiscal';
import { TransaccionesFiscales } from '../config/transacciones-fiscales';
import { ArchivoEnvio, EventoEnvioCompletado, OyentesEnvioFiscal, TIPOS_ARCHIVO_ENVIO, TipoArchivoEnvio } from '../emision/emision.contrato';
import {
  CierreEnvio,
  ESPERA_REINTENTO_MINUTOS,
  MAXIMO_INTENTOS_AUTOMATICOS,
  NOMBRE_AMBIENTE,
  OrigenEnvio,
} from '../emision/emision.tipos';
import { EnvioFiscalRepository } from '../emision/envio-fiscal.repository';
import { SunatEmisionService } from '../emision/sunat-emision.service';
import { ClasificadorRespuestaSunat } from '../nucleo/clasificador-respuesta';
import type { ClasificacionRespuesta, DocumentoCpe, EstadoSunat, RespuestaSunat } from '../nucleo/documento-fiscal.types';
import { esErrorDeConfiguracion, esErrorNucleoFiscal } from '../nucleo/errores-nucleo';
import { identificadorResumen } from '../nucleo/identificadores-cpe';
import { PreparadorEnvioCpe } from '../nucleo/preparador-envio-cpe';
import type { LotePreparado } from '../nucleo/preparador-envio-cpe';
import type { SunatSoapClient } from '../nucleo/soap/sunat-soap-client';
import { bajaDentroDePlazo } from '../nucleo/ubl/constructor-comunicacion-baja';
import type { DatosComunicacionBaja } from '../nucleo/ubl/constructor-comunicacion-baja';
import type { DatosResumenDiario } from '../nucleo/ubl/constructor-resumen-diario';
import { tipoComprobanteSunat } from '../../util/fiscal/tipos-comprobante';
import { CabeceraBaja, LoteCerrado, LoteFiscalRepository, LoteRegistrado, PrefijoLote } from './lote-fiscal.repository';
import {
  FiltroLotes,
  LineaAceptadaSinAnular,
  LoteDeComprobante,
  LotesFiscales,
  LoteVista,
  ResultadoLote,
} from './lotes.contrato';

/** Espera entre consultas del ticket (minutos): la primera, a 1 min del envío, y luego 2, 5, 15, 30 y 60. */
export const ESPERA_TICKET_MINUTOS: readonly number[] = [1, 2, 5, 15, 30, 60];

/** Tras estas consultas sin respuesta de SUNAT el lote queda en EXCEPCION para consultarlo a mano. */
export const MAXIMO_CONSULTAS_TICKET = 12;

/** Largo máximo del motivo de la baja (LONGITUD_MAXIMA_MOTIVO del constructor de la comunicación de baja). */
export const LONGITUD_MAXIMA_MOTIVO_BAJA = 100;

const TIMEOUT_LOTE_MS = 30_000;

/** Reintentos del guardado de la respuesta de SUNAT antes de rendirse con 503. */
const REINTENTOS_GUARDADO = 3;

const CONDICION_ANULAR = 3 as const;

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

/** Motivo sin caracteres de control ni espacios repetidos; 1 a 100 caracteres. */
export function limpiarMotivoBaja(motivo: unknown): string {
  const limpio = String(motivo ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!limpio) throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', 'Indique el motivo de la baja (hasta 100 caracteres).');
  if (limpio.length > LONGITUD_MAXIMA_MOTIVO_BAJA) {
    throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', `El motivo de la baja admite hasta ${LONGITUD_MAXIMA_MOTIVO_BAJA} caracteres (tiene ${limpio.length}).`);
  }
  return limpio;
}

/**
 * Lotes fiscales: la comunicación de baja (RA) de una factura y el resumen diario con la condición 3
 * «anular» (RC) de una boleta, con que se anula un comprobante ya aceptado dentro de los 7 días de su
 * emisión SIN nota de crédito.
 *
 * Flujo: solicitarAnulacion() valida el comprobante y el plazo, arma y firma el XML con el correlativo del
 * día, lo registra (comprobante en BAJA_PENDIENTE) en una transacción y, tras el COMMIT, lo manda por
 * sendSummary. SUNAT responde un ticket: el lote queda TICKET_PENDIENTE y se consulta (getStatus) con una
 * espera creciente hasta que SUNAT entrega la constancia. Aceptado: el comprobante queda ANULADO y se avisa
 * a los oyentes (el negocio anula la venta). Rechazado: el comprobante vuelve a su estado anterior.
 * Nunca reenvía un ZIP por su cuenta fuera de reintentar() (manual o de la tarea).
 */
@Injectable()
export class LotesFiscalesService implements LotesFiscales {
  private readonly logger = new Logger(LotesFiscalesService.name);

  constructor(
    private readonly lotes: LoteFiscalRepository,
    private readonly envios: EnvioFiscalRepository,
    private readonly preparador: PreparadorEnvioCpe,
    private readonly emision: SunatEmisionService,
    private readonly clasificador: ClasificadorRespuestaSunat,
    private readonly certificados: CertificadoFiscalService,
    private readonly config: FiscalConfigService,
    @Inject(EMISOR_PRUEBA_BETA) private readonly emisorBeta: EmisorPruebaBeta,
    private readonly interruptor: InterruptorEmisionFiscal,
    private readonly oyentes: OyentesEnvioFiscal,
    private readonly auditoria: FiscalAuditoriaRepository,
    private readonly transacciones: TransaccionesFiscales,
    private readonly reloj: RelojFiscal,
  ) {}

  // ── Contrato LotesFiscales ───────────────────────────────────────────────

  async solicitarAnulacion(p: { id_comprobante: number; motivo: string; idUsuario: number | null }): Promise<ResultadoLote> {
    const motivo = limpiarMotivoBaja(p.motivo);
    const cabecera = await this.lotes.cabeceraComprobante(p.id_comprobante);
    if (!cabecera) throw new FiscalConfigError('FISCAL_DOC_NO_ENCONTRADO', `No existe el comprobante ${p.id_comprobante}.`);
    const numero = `${cabecera.serie}-${cabecera.numero}`;

    const snapshot = await this.config.snapshotFresco();
    const ambiente = snapshot.ambiente;
    await this.exigirAdmitido(cabecera, numero, ambiente);

    // El documento original (con su fecha de emisión, cliente y totales) se conserva en el envío del comprobante.
    const documento = cabecera.id_envio_ultimo ? (await this.envios.leer(cabecera.id_envio_ultimo))?.datos?.documento ?? null : null;
    if (!documento || documento.serie !== cabecera.serie || documento.numero !== cabecera.numero) {
      throw new FiscalConfigError(
        'FISCAL_DOC_NO_ENCONTRADO',
        'El comprobante no conserva su documento electrónico: anúlelo con una nota de crédito.',
      );
    }
    const hoy = this.reloj.fechaLima();
    if (!bajaDentroDePlazo(documento.fechaEmision, hoy)) {
      throw new FiscalConfigError('FISCAL_BAJA_FUERA_DE_PLAZO', 'Ya pasaron los 7 días: anúlelo con una nota de crédito.', {
        fecha_emision: documento.fechaEmision,
      });
    }

    const esFactura = documento.tipo === '01';
    const operacion = esFactura ? 'baja' : 'resumen';
    const prefijo: PrefijoLote = esFactura ? 'RA' : 'RC';
    const emisor = await this.emisorDe(ambiente, snapshot);
    if (documento.emisor?.ruc !== emisor.ruc) {
      throw new FiscalConfigError(
        'FISCAL_AMBIENTE_CAMBIO',
        `${numero} se emitió con el RUC ${documento.emisor?.ruc ?? '(sin dato)'} y el emisor de ${NOMBRE_AMBIENTE[ambiente]} es ${emisor.ruc}: se anula con una nota de crédito.`,
      );
    }
    const material = await this.materialDe(ambiente);
    this.exigirRucCertificado(ambiente, material, emisor.ruc, snapshot);

    // Un número que otra solicitud tomó a la vez (índice único) se reintenta una vez con el siguiente.
    let idEnvio = 0;
    let identificador = '';
    for (let vuelta = 0; ; vuelta++) {
      try {
        idEnvio = await this.transacciones.ejecutar(async (tx) => {
          const correlativo = await this.lotes.siguienteCorrelativo(tx, ambiente, prefijo, hoy);
          identificador = identificadorResumen(prefijo, hoy, correlativo);
          const lote = this.preparar(esFactura, identificador, hoy, documento, emisor, motivo, material);
          const id = await this.lotes.registrar(tx, {
            ambiente,
            operacion,
            lote,
            fechaReferencia: documento.fechaEmision,
            idUsuario: p.idUsuario,
            motivo,
            lineas: [
              { id_comprobante: cabecera.id_comprobante, serie: documento.serie, numero: documento.numero, tipo_documento: documento.tipo, condicion: CONDICION_ANULAR },
            ],
          });
          await this.auditoria.registrar(
            {
              accion: ACCIONES_AUDITORIA_FISCAL.BAJA_SOLICITADA,
              id_usuario: p.idUsuario,
              entidad: 'fiscal_envios',
              id_entidad: id,
              detalle: { operacion, identificador, comprobante: numero, id_comprobante: cabecera.id_comprobante, ambiente, motivo },
            },
            tx,
          );
          return id;
        });
        break;
      } catch (error) {
        if (vuelta === 0 && FiscalConfigError.es(error, 'FISCAL_NUMERO_OCUPADO')) continue;
        throw error;
      }
    }

    const lote = await this.lotes.reclamarPrimerEnvio(idEnvio);
    if (!lote) return this.resultadoActual(await this.leerOFallar(idEnvio));
    return this.transmitir(lote, 'envio');
  }

  estadoDeComprobante(idComprobante: number): Promise<LoteDeComprobante | null> {
    return this.lotes.loteDeComprobante(idComprobante);
  }

  listar(filtro: FiltroLotes): Promise<{ datos: LoteVista[]; total: number; pagina: number; por_pagina: number }> {
    return this.lotes.listar(filtro ?? {});
  }

  obtener(idEnvio: number): Promise<LoteVista | null> {
    return this.lotes.obtener(idEnvio);
  }

  async archivo(idEnvio: number, tipo: TipoArchivoEnvio): Promise<ArchivoEnvio | null> {
    if (!(TIPOS_ARCHIVO_ENVIO as readonly string[]).includes(tipo)) {
      throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', `Tipo de archivo no válido. Use: ${TIPOS_ARCHIVO_ENVIO.join(', ')}.`);
    }
    return this.lotes.archivo(idEnvio, tipo);
  }

  lineasAceptadasSinAnular(limite: number): Promise<LineaAceptadaSinAnular[]> {
    return this.lotes.lineasAceptadasSinAnular(limite);
  }

  /**
   * Según el estado: PENDIENTE_REENVIO (o ENVIANDO con el reclamo vencido) vuelve a enviar el MISMO ZIP;
   * TICKET_PENDIENTE (o EXCEPCION por consultas agotadas) consulta el ticket. Respeta el interruptor del
   * ambiente (FISCAL_EMISION_BLOQUEADA). `origen` distingue la tarea del reintento manual en el evento.
   */
  async reintentar(idEnvio: number, origen: Extract<OrigenEnvio, 'reintento' | 'tarea'> = 'reintento'): Promise<ResultadoLote> {
    const actual = await this.leerOFallar(idEnvio);
    const consulta = actual.estado === 'TICKET_PENDIENTE' || (actual.estado === 'EXCEPCION' && actual.accion === 'CONSULTAR_TICKET' && !!actual.sunat_ticket);
    const reenvio = actual.estado === 'PENDIENTE_REENVIO' || (actual.estado === 'ENVIANDO' && actual.libre);
    if (!consulta && !reenvio) {
      const motivo = actual.estado === 'ENVIANDO' ? 'se está enviando ahora mismo' : `su estado es ${actual.estado}`;
      throw new FiscalConfigError(
        'FISCAL_REENVIO_NO_PERMITIDO',
        `El lote ${actual.identificador} no está disponible para reintentar (${motivo}). Solo se reenvían los pendientes de reenvío y se consultan los que esperan la respuesta de SUNAT.`,
      );
    }
    await this.exigirSinBloqueo(actual.ambiente);
    return consulta ? this.consultarTicket(idEnvio, origen) : this.enviar(idEnvio, origen);
  }

  // ── Envío y consulta ─────────────────────────────────────────────────────

  /** Reenvío del MISMO ZIP de un lote PENDIENTE_REENVIO o ENVIANDO sin reclamo vigente. */
  async enviar(idEnvio: number, origen: OrigenEnvio = 'reintento'): Promise<ResultadoLote> {
    const lote = await this.lotes.reclamarEnvio(idEnvio);
    if (!lote) {
      throw new FiscalConfigError('FISCAL_ENVIO_EN_CURSO', 'Otro proceso está enviando este lote ahora mismo; actualice en unos segundos.');
    }
    return this.transmitir(lote, origen);
  }

  /** getStatus del ticket de un lote TICKET_PENDIENTE: guarda la constancia o programa la siguiente consulta. */
  async consultarTicket(idEnvio: number, origen: OrigenEnvio = 'reintento'): Promise<ResultadoLote> {
    const lote = await this.lotes.reclamarConsulta(idEnvio);
    if (!lote) {
      throw new FiscalConfigError('FISCAL_ENVIO_EN_CURSO', 'Otro proceso está consultando este lote ahora mismo, o ya no espera la respuesta de SUNAT; actualice en unos segundos.');
    }
    const ticket = lote.sunat_ticket as string;
    let cliente: SunatSoapClient;
    try {
      cliente = await this.emision.clienteSoap(lote.ambiente, this.rucDe(lote), TIMEOUT_LOTE_MS);
    } catch (error) {
      if (!FiscalConfigError.es(error)) throw error;
      return this.reprogramarConsulta(lote, `No se consultó a SUNAT: ${error.message}`, origen);
    }
    const respuesta = await cliente.consultarTicket(ticket);
    const decision = this.clasificador.clasificar(respuesta, { operacion: lote.operacion, etapa: 'consulta_ticket', ambiente: lote.ambiente });
    if (decision.bloqueaEmision) await this.abrirInterruptor(lote, respuesta, decision);

    const json: Record<string, unknown> = { consulta_ticket: resumen(respuesta) };
    if (esAceptado(decision.estado) || decision.estado === 'RECHAZADO' || decision.estado === 'EXCEPCION') {
      // Aceptado, rechazado o descartado por SUNAT (ticket inválido, fuera de plazo…): respuesta definitiva.
      const cierre: CierreEnvio = {
        estado: decision.estado,
        accion: decision.accion,
        mensaje: decision.mensajeUsuario,
        sunat: this.datosSunat(respuesta),
        json: { ...json, clasificacion: { estado: decision.estado, accion: decision.accion, mensajeUsuario: decision.mensajeUsuario } },
        cdr: respuesta.cdrXml || respuesta.cdrZip ? { xml: respuesta.cdrXml, zip: respuesta.cdrZip } : null,
        proximoIntentoMin: null,
      };
      return this.cerrar(lote, cierre, origen);
    }
    // SUNAT sigue procesando (98), falla transitoria o de red: el ticket sigue vigente, no se reenvía nada.
    return this.reprogramarConsulta(lote, decision.mensajeUsuario, origen);
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  /** Manda el ZIP ya reclamado (primer envío o reintento) con las credenciales de SU ambiente. */
  private async transmitir(lote: LoteRegistrado, origen: OrigenEnvio): Promise<ResultadoLote> {
    if (!lote.zip) {
      const mensaje = 'El lote no conserva su ZIP firmado: no se puede enviar. Solicite la baja de nuevo.';
      return this.cerrar(lote, this.excepcion(mensaje), origen);
    }
    const bloqueo = await this.interruptor.leer(lote.ambiente);
    if (bloqueo) {
      // No se llama a SUNAT con una credencial que ya rechazó: se enviará cuando se reanude.
      const mensaje = `La emisión en ${NOMBRE_AMBIENTE[lote.ambiente]} está detenida: ${bloqueo.motivo} El lote se enviará cuando se reanude.`;
      return this.cerrar(lote, this.pendiente(mensaje, 0), origen);
    }
    let cliente: SunatSoapClient;
    try {
      cliente = await this.emision.clienteSoap(lote.ambiente, this.rucDe(lote), TIMEOUT_LOTE_MS);
    } catch (error) {
      if (!FiscalConfigError.es(error)) throw error;
      return this.cerrar(lote, this.pendienteConEspera(lote, `No se envió a SUNAT: ${error.message}`), origen);
    }
    const respuesta = await cliente.enviarResumen(lote.nombre_archivo, lote.zip.toString('base64'));
    const decision = this.clasificador.clasificar(respuesta, { operacion: lote.operacion, etapa: 'envio', ambiente: lote.ambiente });
    if (decision.bloqueaEmision) await this.abrirInterruptor(lote, respuesta, decision);

    if (respuesta.tipo === 'TICKET' && decision.estado === 'TICKET_PENDIENTE' && respuesta.ticket) {
      await this.guardarTicket(lote, respuesta.ticket, decision.mensajeUsuario, ESPERA_TICKET_MINUTOS[0]);
      return {
        id_envio: lote.id_envio,
        operacion: lote.operacion,
        identificador: lote.identificador,
        estado: 'TICKET_PENDIENTE',
        aceptado: false,
        ticket: respuesta.ticket,
        mensaje: decision.mensajeUsuario,
        codigo: null,
      };
    }
    return this.cerrar(lote, this.cierreDeEnvio(lote, decision, respuesta), origen);
  }

  /** Cierre de un envío que no dio ticket (rechazo, excepción, credencial, red): misma política de reintentos que la emisión. */
  private cierreDeEnvio(lote: LoteRegistrado, decision: ClasificacionRespuesta, respuesta: RespuestaSunat): CierreEnvio {
    let estado: EstadoSunat = decision.estado;
    let accion = decision.accion;
    let mensaje = decision.mensajeUsuario;
    // Un Fault de credencial significa que SUNAT no procesó el lote: se reenviará al reanudar.
    if (respuesta.tipo === 'FAULT' && decision.bloqueaEmision) {
      estado = 'PENDIENTE_REENVIO';
      accion = 'REINTENTAR';
      mensaje = `${decision.mensajeUsuario} La emisión quedó detenida y este lote se enviará cuando se reanude.`;
    }
    // Sin ticket no hay nada que consultar, y «recuperar el CDR» no existe para un lote: o se reintenta o se descarta.
    if (estado === 'TICKET_PENDIENTE') {
      estado = 'PENDIENTE_REENVIO';
      accion = 'REINTENTAR';
      mensaje = 'SUNAT no devolvió el ticket del lote; se volverá a enviar.';
    } else if (estado === 'PENDIENTE_REENVIO' && accion !== 'REINTENTAR') {
      estado = 'EXCEPCION';
      accion = 'NINGUNA';
    }
    let proximoIntentoMin: number | null = null;
    if (estado === 'PENDIENTE_REENVIO') {
      if (decision.bloqueaEmision) {
        proximoIntentoMin = 0;
      } else if (lote.intento >= MAXIMO_INTENTOS_AUTOMATICOS) {
        estado = 'EXCEPCION';
        accion = 'NINGUNA';
        mensaje = `Se intentó ${lote.intento} veces sin una respuesta válida de SUNAT: revise manualmente el lote. Última respuesta: ${decision.mensajeUsuario}`;
      } else {
        proximoIntentoMin = this.esperaMinutos(lote.intento);
      }
    }
    return {
      estado,
      accion,
      mensaje,
      sunat: this.datosSunat(respuesta),
      json: {
        respuesta: resumen(respuesta),
        clasificacion: { estado, accion, mensajeUsuario: mensaje, bloqueaEmision: decision.bloqueaEmision === true },
      },
      cdr: respuesta.cdrXml || respuesta.cdrZip ? { xml: respuesta.cdrXml, zip: respuesta.cdrZip } : null,
      proximoIntentoMin,
    };
  }

  /**
   * Una consulta sin respuesta definitiva: el ticket sigue vigente y se vuelve a consultar con una espera
   * creciente. Tras MAXIMO_CONSULTAS_TICKET consultas el lote queda en EXCEPCION (con la acción
   * CONSULTAR_TICKET: el comprobante sigue en BAJA_PENDIENTE porque SUNAT pudo haberlo procesado).
   */
  private async reprogramarConsulta(lote: LoteRegistrado, mensaje: string, origen: OrigenEnvio): Promise<ResultadoLote> {
    const ticket = lote.sunat_ticket as string;
    const consultas = lote.intento - 1; // el primer intento fue el envío; esta consulta es la número `consultas`
    if (consultas >= MAXIMO_CONSULTAS_TICKET) {
      const final = `SUNAT no resolvió el ticket ${ticket} tras ${consultas} consultas; consulte de nuevo manualmente. Última respuesta: ${mensaje}`;
      const cierre: CierreEnvio = {
        estado: 'EXCEPCION',
        accion: 'CONSULTAR_TICKET',
        mensaje: final,
        sunat: null,
        json: { clasificacion: { estado: 'EXCEPCION', accion: 'CONSULTAR_TICKET', mensajeUsuario: final } },
        proximoIntentoMin: null,
      };
      return this.cerrar(lote, cierre, origen);
    }
    const espera = ESPERA_TICKET_MINUTOS[Math.min(Math.max(lote.intento - 1, 0), ESPERA_TICKET_MINUTOS.length - 1)];
    await this.guardarTicket(lote, ticket, mensaje, espera);
    return {
      id_envio: lote.id_envio,
      operacion: lote.operacion,
      identificador: lote.identificador,
      estado: 'TICKET_PENDIENTE',
      aceptado: false,
      ticket,
      mensaje,
      codigo: null,
    };
  }

  /** Guarda el ticket con hasta 3 reintentos de BD: sin él no se podría consultar el resultado (queda en el log). */
  private async guardarTicket(lote: LoteRegistrado, ticket: string, mensaje: string, esperaMin: number): Promise<void> {
    for (let intento = 0; ; intento++) {
      try {
        await this.lotes.guardarTicket(lote.id_envio, ticket, mensaje, esperaMin);
        return;
      } catch (error) {
        if (intento >= REINTENTOS_GUARDADO) {
          this.logger.error(
            `Lote ${lote.id_envio} (${lote.identificador}): SUNAT dio el ticket ${ticket} pero no se pudo guardar: ${mensajeDe(error)}. `
              + 'Consúltelo en SUNAT con ese número.',
          );
          throw new ServiceUnavailableException({
            message: 'SUNAT recibió el lote, pero no se pudo guardar su ticket. Revise el lote antes de repetirlo.',
            codigo: 'FISCAL_SUNAT_NO_DISPONIBLE',
            id_envio: lote.id_envio,
            identificador: lote.identificador,
          });
        }
        this.logger.warn(`Lote ${lote.id_envio}: reintento ${intento + 1} del guardado del ticket (${mensajeDe(error)}).`);
        await this.esperar(250 * 2 ** intento);
      }
    }
  }

  /** Guarda el cierre con hasta 3 reintentos de BD; luego avisa a los oyentes. */
  private async cerrar(lote: LoteRegistrado, cierre: CierreEnvio, origen: OrigenEnvio): Promise<ResultadoLote> {
    let cerrado: LoteCerrado | null = null;
    for (let intento = 0; ; intento++) {
      try {
        cerrado = await this.lotes.completar(lote.id_envio, lote.ambiente, lote.nombre_base, cierre);
        break;
      } catch (error) {
        if (intento >= REINTENTOS_GUARDADO) {
          this.logger.error(`Lote ${lote.id_envio} (${lote.ambiente}): no se pudo guardar la respuesta de SUNAT: ${mensajeDe(error)}`);
          throw new ServiceUnavailableException({
            message: 'SUNAT respondió, pero no se pudo guardar su respuesta. El lote quedó pendiente y se puede consultar de nuevo; revíselo antes de repetirlo.',
            codigo: 'FISCAL_SUNAT_NO_DISPONIBLE',
            id_envio: lote.id_envio,
            ambiente: lote.ambiente,
            estado_sunat: cierre.estado,
          });
        }
        this.logger.warn(`Lote ${lote.id_envio}: reintento ${intento + 1} del guardado de la respuesta (${mensajeDe(error)}).`);
        await this.esperar(250 * 2 ** intento);
      }
    }
    if (!cerrado) {
      // Otro proceso lo cerró antes (p. ej. ya quedó aceptado): no se pisa su resultado.
      return this.resultadoActual((await this.lotes.leer(lote.id_envio)) ?? lote);
    }
    const evento: EventoEnvioCompletado = {
      id_envio: lote.id_envio,
      id_comprobante: cerrado.id_comprobante,
      ambiente: lote.ambiente,
      tipo_documento: cerrado.tipo_documento || lote.tipo_documento,
      estado: cierre.estado,
      aceptado: esAceptado(cierre.estado),
      origen,
      operacion: cerrado.operacion,
    };
    await this.oyentes.notificar(evento);
    return {
      id_envio: lote.id_envio,
      operacion: lote.operacion,
      identificador: lote.identificador,
      estado: cierre.estado,
      aceptado: esAceptado(cierre.estado),
      ticket: lote.sunat_ticket,
      mensaje: cierre.mensaje,
      codigo: cierre.sunat?.codigo || lote.codigo_sunat || null,
    };
  }

  /** XML firmado de la baja (factura) o del resumen con la condición 3 (boleta). */
  private preparar(
    esFactura: boolean,
    identificador: string,
    hoy: string,
    documento: DocumentoCpe,
    emisor: { ruc: string; razonSocial: string },
    motivo: string,
    material: MaterialFirma,
  ): LotePreparado {
    try {
      const base = {
        identificador,
        fechaGeneracion: hoy,
        fechaEmisionDocumentos: documento.fechaEmision,
        emisor: { ruc: emisor.ruc, razonSocial: emisor.razonSocial },
      };
      const opciones = { ahora: this.reloj.ahora() };
      if (esFactura) {
        const datos: DatosComunicacionBaja = {
          ...base,
          lineas: [{ numeroLinea: 1, tipoDocumento: '01', serie: documento.serie, numero: documento.numero, motivo }],
        };
        return this.preparador.prepararComunicacionBaja(datos, material, opciones);
      }
      const datos: DatosResumenDiario = {
        ...base,
        lineas: [
          {
            numeroLinea: 1,
            tipoDocumento: '03',
            serie: documento.serie,
            numero: documento.numero,
            tipoDocumentoCliente: documento.cliente.tipoDoc,
            numeroDocumentoCliente: documento.cliente.numDoc,
            gravada: documento.totales.gravada,
            exonerada: documento.totales.exonerada,
            inafecta: documento.totales.inafecta,
            gratuita: 0,
            igv: documento.totales.igv,
            porcentajeIgv: documento.lineas.find((l) => l.afectacion === '10')?.porcentajeIgv ?? documento.lineas[0]?.porcentajeIgv,
            total: documento.totales.total,
            estado: CONDICION_ANULAR,
            moneda: documento.moneda,
            fechaEmision: documento.fechaEmision,
          },
        ],
      };
      return this.preparador.prepararResumenDiario(datos, material, opciones);
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

  /** Reglas del comprobante para anularlo sin nota (antes de leer su documento). */
  private async exigirAdmitido(c: CabeceraBaja, numero: string, ambiente: AmbienteFiscal): Promise<void> {
    const tipo = tipoComprobanteSunat(c.id_tipo);
    if (tipo !== '01' && tipo !== '03') {
      throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', `${numero} no es una factura ni una boleta: solo a ellas se les da de baja.`);
    }
    if (c.proveedor_fiscal !== 'sunat_directo') {
      throw new FiscalConfigError('FISCAL_DOC_OTRO_PROVEEDOR', `${numero} se emitió con el sistema anterior: no se da de baja desde aquí (la venta se anula en el sistema).`);
    }
    if (c.ambiente_fiscal !== ambiente) {
      throw new FiscalConfigError(
        'FISCAL_AMBIENTE_CAMBIO',
        `${numero} se emitió en ${NOMBRE_AMBIENTE[c.ambiente_fiscal === 'produccion' ? 'produccion' : 'beta']} y el ambiente vigente es ${NOMBRE_AMBIENTE[ambiente]}: se anula en el sistema, sin baja.`,
        { ambiente },
      );
    }
    if (c.anulado) throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', `${numero} ya está anulado.`);
    const lote = await this.lotes.loteDeComprobante(c.id_comprobante);
    if (lote || c.estado_sunat === 'BAJA_PENDIENTE') {
      throw new FiscalConfigError(
        'FISCAL_ENVIO_EN_CURSO',
        `${numero} ya tiene una baja en SUNAT${lote ? ` (${lote.identificador}, ${lote.estado})` : ''}: espere su resultado.`,
        lote ? { id_envio: lote.id_envio } : {},
      );
    }
    if (!c.aceptada_sunat || !['ACEPTADO', 'ACEPTADO_OBS'].includes(c.estado_sunat ?? '')) {
      throw new FiscalConfigError(
        'FISCAL_CONFIG_INVALIDA',
        `${numero} todavía no está aceptado por SUNAT (estado ${c.estado_sunat ?? 'sin enviar'}): la baja solo se pide sobre comprobantes aceptados.`,
      );
    }
  }

  /** BETA: el emisor de pruebas del panel. PRODUCCIÓN: el emisor real configurado. */
  private async emisorDe(ambiente: AmbienteFiscal, snapshot: SnapshotConfigFiscal): Promise<{ ruc: string; razonSocial: string }> {
    const emisor = ambiente === 'beta' ? await this.emisorBeta.obtenerEmisor() : snapshot.emisor;
    return { ruc: emisor.ruc, razonSocial: emisor.razonSocial };
  }

  private materialDe(ambiente: AmbienteFiscal): Promise<MaterialFirma> {
    return ambiente === 'beta' ? this.certificados.obtenerMaterialFirmaBeta() : this.certificados.obtenerMaterialFirma('produccion');
  }

  /** El certificado debe ser del emisor; si su RUC no se puede leer, en producción vale la confirmación del administrador. */
  private exigirRucCertificado(ambiente: AmbienteFiscal, material: MaterialFirma, rucEmisor: string, snapshot: SnapshotConfigFiscal): void {
    if (material.ruc) {
      if (material.ruc !== rucEmisor) {
        throw new FiscalConfigError(
          'FISCAL_CERT_RUC_NO_COINCIDE',
          `El certificado de ${NOMBRE_AMBIENTE[ambiente]} es del RUC ${material.ruc} y el emisor es ${rucEmisor}: SUNAT rechazaría la firma.`,
        );
      }
      return;
    }
    if (ambiente === 'beta') {
      throw new FiscalConfigError('FISCAL_CERT_RUC_NO_COINCIDE', 'No se pudo leer el RUC del certificado BETA: use un certificado de prueba con el RUC del emisor BETA.');
    }
    if (!snapshot.certRucConfirmadoProduccion) {
      throw new FiscalConfigError(
        'FISCAL_CERT_RUC_SIN_CONFIRMAR',
        `No se pudo leer el RUC dentro del certificado de producción. Confirme en Facturación SUNAT que pertenece a ${rucEmisor} antes de firmar.`,
      );
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

  private async abrirInterruptor(lote: LoteRegistrado, respuesta: RespuestaSunat, decision: ClasificacionRespuesta): Promise<void> {
    try {
      await this.interruptor.abrir(
        lote.ambiente,
        { codigo: respuesta.codigo, motivo: decision.mensajeUsuario },
        { id_envio: lote.id_envio, tipo_documento: lote.tipo_documento },
      );
      this.logger.warn(`Emisión de ${lote.ambiente} detenida por SUNAT (${respuesta.codigo}) en el lote ${lote.id_envio}.`);
    } catch (error) {
      this.logger.error(`No se pudo detener la emisión de ${lote.ambiente} tras el código ${respuesta.codigo}: ${mensajeDe(error)}`);
    }
  }

  /** RUC del emisor: es el primer tramo del nombre del archivo (RUC-RA-YYYYMMDD-N). */
  private rucDe(lote: LoteRegistrado): string {
    return lote.nombre_base.split('-')[0];
  }

  private async leerOFallar(idEnvio: number): Promise<LoteRegistrado> {
    const lote = await this.lotes.leer(idEnvio);
    if (!lote) throw new FiscalConfigError('FISCAL_DOC_NO_ENCONTRADO', `No existe el lote ${idEnvio}.`);
    return lote;
  }

  /** Resultado de un lote que no se tocó (otro proceso lo tiene o ya tiene respuesta). */
  private resultadoActual(lote: LoteRegistrado): ResultadoLote {
    return {
      id_envio: lote.id_envio,
      operacion: lote.operacion,
      identificador: lote.identificador,
      estado: lote.estado,
      aceptado: esAceptado(lote.estado),
      ticket: lote.sunat_ticket,
      mensaje: 'El lote ya está en proceso o tiene respuesta de SUNAT; no se volvió a enviar.',
      codigo: lote.codigo_sunat,
    };
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

  private pendienteConEspera(lote: LoteRegistrado, mensaje: string): CierreEnvio {
    if (lote.intento >= MAXIMO_INTENTOS_AUTOMATICOS) {
      return this.excepcion(`Se intentó ${lote.intento} veces sin poder enviar el lote: revíselo manualmente. ${mensaje}`);
    }
    return this.pendiente(mensaje, this.esperaMinutos(lote.intento));
  }

  private pendiente(mensaje: string, proximoIntentoMin: number): CierreEnvio {
    return {
      estado: 'PENDIENTE_REENVIO',
      accion: 'REINTENTAR',
      mensaje,
      sunat: null,
      json: { clasificacion: { estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', mensajeUsuario: mensaje } },
      proximoIntentoMin,
    };
  }

  private excepcion(mensaje: string): CierreEnvio {
    return {
      estado: 'EXCEPCION',
      accion: 'NINGUNA',
      mensaje,
      sunat: null,
      json: { clasificacion: { estado: 'EXCEPCION', accion: 'NINGUNA', mensajeUsuario: mensaje } },
      proximoIntentoMin: null,
    };
  }

  /** Pausa entre reintentos del guardado (se reemplaza en los specs). */
  protected esperar(ms: number): Promise<void> {
    return new Promise((resolver) => setTimeout(resolver, ms));
  }
}
