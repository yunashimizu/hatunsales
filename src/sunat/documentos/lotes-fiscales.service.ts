import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ACCIONES_AUDITORIA_FISCAL, FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import type { MaterialFirma } from '../certificado/material-firma';
import { FiscalConfigError } from '../config/fiscal-errores';
import { FiscalConfigService } from '../config/fiscal-config.service';
import type { ActorFiscal, AmbienteFiscal, SnapshotConfigFiscal } from '../config/fiscal-config.tipos';
import { EMISOR_PRUEBA_BETA } from '../config/fiscal-tokens';
import type { EmisorPruebaBeta } from '../config/fiscal-tokens';
import { InterruptorEmisionFiscal } from '../config/interruptor-emision.service';
import { fechaEnLima, RelojFiscal } from '../config/reloj-fiscal';
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
import { diasEntre, esFechaIso, sumarDias } from '../nucleo/fechas-fiscales';
import { identificadorResumen } from '../nucleo/identificadores-cpe';
import { PreparadorEnvioCpe } from '../nucleo/preparador-envio-cpe';
import type { LotePreparado } from '../nucleo/preparador-envio-cpe';
import type { SunatSoapClient } from '../nucleo/soap/sunat-soap-client';
import { bajaDentroDePlazo } from '../nucleo/ubl/constructor-comunicacion-baja';
import type { DatosComunicacionBaja } from '../nucleo/ubl/constructor-comunicacion-baja';
import { MAXIMO_LINEAS_RESUMEN } from '../nucleo/ubl/constructor-resumen-diario';
import type { DatosResumenDiario, LineaResumenDiario } from '../nucleo/ubl/constructor-resumen-diario';
import { esDocumentoDeFactura, fechaLimiteEnvioIndividual } from '../nucleo/reglas-envio';
import { PLAZOS_ENVIO_DIAS } from '../catalogos/sunat.catalogos';
import { tipoComprobanteSunat } from '../../util/fiscal/tipos-comprobante';
import {
  CabeceraBaja,
  CandidatoResumen,
  ESTADOS_ADICION,
  LoteCerrado,
  LoteFiscalRepository,
  LoteLiberado,
  LoteRegistrado,
  PrefijoLote,
} from './lote-fiscal.repository';
import {
  FiltroLotes,
  LineaAceptadaSinAnular,
  LoteDeComprobante,
  LotesFiscales,
  LoteVista,
  PeticionResumenAdicion,
  ResultadoLote,
  ResultadoResumenAdicion,
} from './lotes.contrato';

/** Espera entre consultas del ticket (minutos): la primera, a 1 min del envío, y luego 2, 5, 15, 30 y 60. */
export const ESPERA_TICKET_MINUTOS: readonly number[] = [1, 2, 5, 15, 30, 60];

/** Tras estas consultas sin respuesta de SUNAT el lote pasa a la consulta lenta (ESPERA_TICKET_LENTA_MINUTOS). */
export const MAXIMO_CONSULTAS_TICKET = 12;

/** Espera entre consultas del ticket una vez agotadas las rápidas, hasta DIAS_CONSULTA_TICKET desde el registro (S4). */
export const ESPERA_TICKET_LENTA_MINUTOS = 120;

/** Días que se sigue consultando un ticket sin respuesta; al cumplirlos el lote queda EXCEPCION/LIBERAR. */
export const DIAS_CONSULTA_TICKET = 7;

/** Largo máximo del motivo de la baja (LONGITUD_MAXIMA_MOTIVO del constructor de la comunicación de baja). */
export const LONGITUD_MAXIMA_MOTIVO_BAJA = 100;

const TIMEOUT_LOTE_MS = 30_000;

/** Reintentos del guardado de la respuesta de SUNAT antes de rendirse con 503. */
const REINTENTOS_GUARDADO = 3;

const CONDICION_ANULAR = 3 as const;
const CONDICION_ADICIONAR = 1 as const;

function esAceptado(estado: string): boolean {
  return estado === 'ACEPTADO' || estado === 'ACEPTADO_OBS';
}

/** yyyy-mm-dd → dd/mm. */
function fechaCorta(iso: string): string {
  const [, mes, dia] = /^\d{4}-(\d{2})-(\d{2})/.exec(iso) ?? [];
  return mes && dia ? `${dia}/${mes}` : iso;
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

  /**
   * Resumen diario de adición (S2): arma, firma y registra UN resumen con las boletas y notas de boleta elegibles de
   * `fecha_emision` (ver LoteFiscalRepository.candidatosResumen) y lo manda a SUNAT. null si no hay nada que informar.
   */
  async crearResumenAdicion(p: PeticionResumenAdicion): Promise<ResultadoResumenAdicion | null> {
    const fecha = p.fecha_emision;
    if (!esFechaIso(fecha)) throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', 'Indique la fecha de emisión de las boletas con el formato aaaa-mm-dd.');
    const hoy = this.reloj.fechaLima();
    const dias = diasEntre(fecha, hoy);
    if (dias < 0) throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', 'La fecha de emisión no puede ser posterior a hoy.');
    if (dias > PLAZOS_ENVIO_DIAS.resumenDiario) {
      throw new FiscalConfigError(
        'FISCAL_RESUMEN_FUERA_DE_PLAZO',
        `Ya pasaron los ${PLAZOS_ENVIO_DIAS.resumenDiario} días desde el ${fechaCorta(fecha)}: esas boletas ya no se pueden informar en un resumen diario. Si el cliente reclama alguna, anúlela con una nota de crédito.`,
        { fecha_emision: fecha },
      );
    }

    const snapshot = await this.config.snapshotFresco();
    const ambiente = snapshot.ambiente;
    await this.exigirSinBloqueo(ambiente);
    const candidatos = await this.lotes.candidatosResumen({
      ambiente,
      hoy,
      fecha,
      ids: p.ids_comprobantes,
      // La tarea no insiste con lo que SUNAT ya rechazó; una persona sí puede volver a pedirlo.
      soloSinRechazo: p.origen === 'tarea',
      limite: MAXIMO_LINEAS_RESUMEN + 1,
    });
    if (!candidatos.length) return null;

    const emisor = await this.emisorDe(ambiente, snapshot);
    const lineas: LineaResumenDiario[] = [];
    const incluidos: CandidatoResumen[] = [];
    let omitidos = 0;
    for (const candidato of candidatos.slice(0, MAXIMO_LINEAS_RESUMEN)) {
      const documento = (await this.envios.leer(candidato.id_envio_ultimo))?.datos?.documento ?? null;
      const linea = documento && documento.emisor?.ruc === emisor.ruc ? this.lineaDeAdicion(documento, candidato, lineas.length + 1, fecha) : null;
      if (!linea) {
        omitidos += 1;
        this.logger.warn(`${candidato.serie}-${candidato.numero} no entra al resumen del ${fecha}: no conserva su documento o no es de este emisor.`);
        continue;
      }
      lineas.push(linea);
      incluidos.push(candidato);
    }
    const pendientes = Math.max(0, candidatos.length - MAXIMO_LINEAS_RESUMEN);
    if (!lineas.length) {
      throw new FiscalConfigError(
        'FISCAL_RESUMEN_NO_PERMITIDO',
        'Las boletas de esa fecha no conservan su documento electrónico: no se pueden informar en un resumen.',
        { omitidos },
      );
    }
    const material = await this.materialDe(ambiente);
    this.exigirRucCertificado(ambiente, material, emisor.ruc, snapshot);

    const motivo = `Resumen diario de boletas del ${fecha}`;
    let idEnvio = 0;
    let identificador = '';
    for (let vuelta = 0; ; vuelta++) {
      try {
        idEnvio = await this.transacciones.ejecutar(async (tx) => {
          const correlativo = await this.lotes.siguienteCorrelativo(tx, ambiente, 'RC', hoy);
          identificador = identificadorResumen('RC', hoy, correlativo);
          const lote = this.prepararAdicion(identificador, hoy, fecha, lineas, emisor, material);
          const id = await this.lotes.registrar(tx, {
            ambiente,
            operacion: 'resumen',
            lote,
            fechaReferencia: fecha,
            idUsuario: p.actor?.id_usuario ?? null,
            motivo,
            lineas: incluidos.map((c, i) => ({
              id_comprobante: c.id_comprobante,
              serie: lineas[i].serie,
              numero: lineas[i].numero,
              tipo_documento: lineas[i].tipoDocumento,
              condicion: CONDICION_ADICIONAR,
            })),
          });
          await this.auditoria.registrar(
            {
              accion: ACCIONES_AUDITORIA_FISCAL.RESUMEN_SOLICITADO,
              id_usuario: p.actor?.id_usuario ?? null,
              entidad: 'fiscal_envios',
              id_entidad: id,
              detalle: {
                usuario: p.actor?.nombre ?? null,
                origen: p.origen,
                identificador,
                fecha_emision: fecha,
                comprobantes: incluidos.length,
                ids_comprobantes: incluidos.slice(0, 50).map((c) => c.id_comprobante),
                ambiente,
              },
              ip: p.actor?.ip ?? null,
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

    const reclamado = await this.lotes.reclamarPrimerEnvio(idEnvio);
    const resultado = reclamado ? await this.transmitir(reclamado, 'envio') : this.resultadoActual(await this.leerOFallar(idEnvio));
    return { ...resultado, fecha_emision: fecha, comprobantes: lineas.length, pendientes, omitidos };
  }

  async resumirComprobante(p: { id_comprobante: number; actor: ActorFiscal | null }): Promise<ResultadoResumenAdicion> {
    const cabecera = await this.lotes.cabeceraComprobante(p.id_comprobante);
    if (!cabecera) throw new FiscalConfigError('FISCAL_DOC_NO_ENCONTRADO', `No existe el comprobante ${p.id_comprobante}.`);
    const numero = `${cabecera.serie}-${cabecera.numero}`;
    const tipo = tipoComprobanteSunat(cabecera.id_tipo);
    const no = (mensaje: string) => new FiscalConfigError('FISCAL_RESUMEN_NO_PERMITIDO', mensaje);
    if (!tipo || esDocumentoDeFactura(tipo, cabecera.serie)) {
      throw no(`${numero} no es una boleta ni una nota de boleta: solo ellas se informan en un resumen diario.`);
    }
    if (cabecera.proveedor_fiscal !== 'sunat_directo') {
      throw new FiscalConfigError('FISCAL_DOC_OTRO_PROVEEDOR', `${numero} se emitió con el sistema anterior: no se informa desde aquí.`);
    }
    const snapshot = await this.config.snapshotFresco();
    if (cabecera.ambiente_fiscal !== snapshot.ambiente) {
      throw new FiscalConfigError(
        'FISCAL_AMBIENTE_CAMBIO',
        `${numero} se emitió en ${NOMBRE_AMBIENTE[cabecera.ambiente_fiscal === 'produccion' ? 'produccion' : 'beta']} y el ambiente vigente es ${NOMBRE_AMBIENTE[snapshot.ambiente]}: no se informa desde aquí.`,
        { ambiente: snapshot.ambiente },
      );
    }
    if (cabecera.anulado) throw no(`${numero} ya está anulado.`);
    if (cabecera.aceptada_sunat || ['ACEPTADO', 'ACEPTADO_OBS'].includes(cabecera.estado_sunat ?? '')) {
      throw no(`${numero} ya lo aceptó SUNAT: no hace falta informarlo en un resumen (y SUNAT lo rechazaría como repetido).`);
    }
    const estado = cabecera.estado_sunat ?? '';
    if (['TICKET_PENDIENTE', 'BAJA_PENDIENTE', 'ENVIANDO'].includes(estado)) {
      throw new FiscalConfigError('FISCAL_ENVIO_EN_CURSO', `${numero} ya está en proceso con SUNAT (${estado === 'TICKET_PENDIENTE' ? 'en un resumen' : 'envío o baja en curso'}): espere su resultado.`);
    }
    if (!ESTADOS_ADICION.includes(estado)) throw no(`${numero} no está en un estado que admita el resumen (${estado || 'sin estado'}).`);
    const hoy = this.reloj.fechaLima();
    const fecha = cabecera.fecha_de_emision;
    if (!esFechaIso(fecha)) throw no(`${numero} no tiene una fecha de emisión válida.`);
    if (diasEntre(fecha, hoy) > PLAZOS_ENVIO_DIAS.resumenDiario) {
      throw new FiscalConfigError(
        'FISCAL_RESUMEN_FUERA_DE_PLAZO',
        `Ya pasaron los ${PLAZOS_ENVIO_DIAS.resumenDiario} días desde la emisión de ${numero}: no se puede informar en un resumen. Si el cliente lo reclama, anúlelo con una nota de crédito y emita uno nuevo.`,
        { fecha_emision: fecha },
      );
    }
    if (estado !== 'POR_RESUMIR' && hoy <= fechaLimiteEnvioIndividual(tipo, cabecera.serie, fecha)) {
      throw no(`${numero} todavía está dentro del plazo de envío individual: use «Reintentar» (informarlo en un resumen a la vez podría duplicarlo en SUNAT).`);
    }
    const resultado = await this.crearResumenAdicion({
      fecha_emision: fecha,
      ids_comprobantes: [p.id_comprobante],
      actor: p.actor,
      origen: 'comprobante',
    });
    if (!resultado) throw no(`${numero} ya no está disponible para el resumen: actualice la pantalla y revíselo.`);
    return resultado;
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
   * TICKET_PENDIENTE (o EXCEPCION con el ticket sin resolver: «Consultar ahora») consulta el ticket. Respeta el interruptor del
   * ambiente (FISCAL_EMISION_BLOQUEADA). `origen` distingue la tarea del reintento manual en el evento.
   */
  async reintentar(idEnvio: number, origen: Extract<OrigenEnvio, 'reintento' | 'tarea'> = 'reintento'): Promise<ResultadoLote> {
    const actual = await this.leerOFallar(idEnvio);
    const consulta =
      actual.estado === 'TICKET_PENDIENTE'
      || (actual.estado === 'EXCEPCION' && (actual.accion === 'CONSULTAR_TICKET' || actual.accion === 'LIBERAR') && !!actual.sunat_ticket);
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

  /**
   * «Liberar» (S4, solo administrador): SUNAT no resolvió el ticket en 7 días y el administrador suelta el lote.
   * Cada comprobante vuelve a su estado anterior (para pedir la baja de nuevo con otro identificador) y queda
   * en la bitácora con el usuario, en la misma transacción. No llama a SUNAT.
   */
  async liberar(idEnvio: number, actor: ActorFiscal): Promise<ResultadoLote> {
    if (!actor?.id_usuario) {
      throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', 'No se pudo identificar al administrador que libera el lote: vuelva a iniciar sesión.');
    }
    const actual = await this.leerOFallar(idEnvio);
    const sinResolver = actual.estado === 'EXCEPCION' && (actual.accion === 'CONSULTAR_TICKET' || actual.accion === 'LIBERAR');
    if (!sinResolver) {
      throw new FiscalConfigError(
        'FISCAL_LIBERAR_NO_PERMITIDO',
        `El lote ${actual.identificador} no se puede liberar (su estado es ${actual.estado}). Solo se liberan los lotes cuya respuesta SUNAT no llegó a tiempo.`,
      );
    }
    const mensaje =
      `Lote liberado por el administrador: SUNAT no respondió el ticket ${actual.sunat_ticket ?? ''}. `
      + 'Los comprobantes volvieron a su estado anterior: si todavía está dentro de los 7 días de la emisión, pida la baja de nuevo; si no, anúlelos con una nota de crédito.';
    const fecha = this.reloj.ahora().toISOString();
    const liberado = await this.lotes.liberar(
      idEnvio,
      mensaje,
      {
        clasificacion: { estado: 'EXCEPCION', accion: 'LIBERADO', mensajeUsuario: mensaje },
        liberado: { id_usuario: actor.id_usuario, fecha, accion_previa: actual.accion, ticket: actual.sunat_ticket },
      },
      async (tx, resultado) => {
        await this.auditoria.registrar(
          {
            accion: ACCIONES_AUDITORIA_FISCAL.LOTE_LIBERADO,
            id_usuario: actor.id_usuario,
            entidad: 'fiscal_envios',
            id_entidad: idEnvio,
            detalle: {
              usuario: actor.nombre,
              identificador: resultado.identificador,
              operacion: resultado.operacion,
              ticket: actual.sunat_ticket,
              accion_previa: actual.accion,
              ids_comprobantes: resultado.ids_comprobantes,
              ambiente: actual.ambiente,
            },
            ip: actor.ip,
          },
          tx,
        );
      },
    );
    if (!liberado) {
      throw new FiscalConfigError(
        'FISCAL_ENVIO_EN_CURSO',
        'El lote se está consultando ahora mismo o cambió de estado; actualice la vista y revíselo de nuevo.',
      );
    }
    return {
      id_envio: idEnvio,
      operacion: liberado.operacion,
      identificador: liberado.identificador,
      estado: 'EXCEPCION',
      aceptado: false,
      ticket: actual.sunat_ticket,
      mensaje,
      codigo: actual.codigo_sunat,
    };
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
   * creciente. Tras MAXIMO_CONSULTAS_TICKET consultas no se rinde: sigue en TICKET_PENDIENTE y consulta cada
   * ESPERA_TICKET_LENTA_MINUTOS hasta DIAS_CONSULTA_TICKET días desde el registro del lote. Recién entonces
   * queda en EXCEPCION con la acción LIBERAR (el comprobante sigue en BAJA_PENDIENTE porque SUNAT pudo haberlo
   * procesado) y el administrador decide: consultar otra vez o «Liberar».
   */
  private async reprogramarConsulta(lote: LoteRegistrado, mensaje: string, origen: OrigenEnvio): Promise<ResultadoLote> {
    const ticket = lote.sunat_ticket as string;
    const consultas = lote.intento - 1; // el primer intento fue el envío; esta consulta es la número `consultas`
    let espera: number;
    let mensajeGuardado = mensaje;
    if (consultas >= MAXIMO_CONSULTAS_TICKET) {
      const limite = this.limiteConsultaTicket(lote);
      if (limite !== null && this.reloj.ahora().getTime() >= limite.getTime()) {
        const final =
          `SUNAT no resolvió el ticket ${ticket} en ${DIAS_CONSULTA_TICKET} días. Consúltelo de nuevo o libere el lote: `
          + `el comprobante volverá a su estado anterior. Última respuesta: ${mensaje}`;
        const cierre: CierreEnvio = {
          estado: 'EXCEPCION',
          accion: 'LIBERAR',
          mensaje: final,
          sunat: null,
          json: { clasificacion: { estado: 'EXCEPCION', accion: 'LIBERAR', mensajeUsuario: final } },
          proximoIntentoMin: null,
        };
        return this.cerrar(lote, cierre, origen);
      }
      espera = ESPERA_TICKET_LENTA_MINUTOS;
      mensajeGuardado = `SUNAT sigue sin responder; se consultará cada 2 horas hasta el ${this.fechaLimiteTicket(lote)}. Última respuesta: ${mensaje}`;
    } else {
      espera = ESPERA_TICKET_MINUTOS[Math.min(Math.max(lote.intento - 1, 0), ESPERA_TICKET_MINUTOS.length - 1)];
    }
    await this.guardarTicket(lote, ticket, mensajeGuardado, espera);
    return {
      id_envio: lote.id_envio,
      operacion: lote.operacion,
      identificador: lote.identificador,
      estado: 'TICKET_PENDIENTE',
      aceptado: false,
      ticket,
      mensaje: mensajeGuardado,
      codigo: null,
    };
  }

  /** Instante en que se cumplen los 7 días de consulta (desde el registro del lote); null si no se conoce. */
  private limiteConsultaTicket(lote: LoteRegistrado): Date | null {
    const creado = lote.creado_en ? new Date(lote.creado_en) : null;
    if (!creado || Number.isNaN(creado.getTime())) return null;
    return new Date(creado.getTime() + DIAS_CONSULTA_TICKET * 24 * 60 * 60 * 1000);
  }

  /** dd/mm del último día de consulta, para el mensaje. */
  private fechaLimiteTicket(lote: LoteRegistrado): string {
    const creado = lote.creado_en ? new Date(lote.creado_en) : this.reloj.ahora();
    const limite = sumarDias(fechaEnLima(Number.isNaN(creado.getTime()) ? this.reloj.ahora() : creado), DIAS_CONSULTA_TICKET);
    const [, mes, dia] = /^\d{4}-(\d{2})-(\d{2})/.exec(limite) ?? [];
    return mes && dia ? `${dia}/${mes}` : limite;
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

  /** La línea del resumen (condición 1) de una boleta o nota de boleta, desde el documento que se firmó; null si no corresponde. */
  private lineaDeAdicion(documento: DocumentoCpe, candidato: CandidatoResumen, numeroLinea: number, fecha: string): LineaResumenDiario | null {
    const tipo = documento.tipo;
    if ((tipo !== '03' && tipo !== '07' && tipo !== '08') || documento.fechaEmision !== fecha) return null;
    if (documento.serie !== candidato.serie || documento.numero !== candidato.numero || !/^B/i.test(documento.serie)) return null;
    let modificado: LineaResumenDiario['documentoModificado'];
    if (tipo !== '03') {
      const referencia = documento.referencia;
      if (!referencia || referencia.tipoDoc !== '03') return null;
      modificado = { tipoDocumento: '03', serie: referencia.serie, numero: referencia.numero };
    }
    return {
      numeroLinea,
      tipoDocumento: tipo,
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
      estado: CONDICION_ADICIONAR,
      documentoModificado: modificado,
      moneda: documento.moneda,
      fechaEmision: documento.fechaEmision,
    };
  }

  /** XML firmado del resumen diario con las boletas a adicionar (condición 1). */
  private prepararAdicion(
    identificador: string,
    hoy: string,
    fechaEmision: string,
    lineas: LineaResumenDiario[],
    emisor: { ruc: string; razonSocial: string },
    material: MaterialFirma,
  ): LotePreparado {
    try {
      const datos: DatosResumenDiario = {
        identificador,
        fechaGeneracion: hoy,
        fechaEmisionDocumentos: fechaEmision,
        emisor: { ruc: emisor.ruc, razonSocial: emisor.razonSocial },
        lineas,
      };
      return this.preparador.prepararResumenDiario(datos, material, { ahora: this.reloj.ahora() });
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
