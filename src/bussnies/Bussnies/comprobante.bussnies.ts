import {
  Injectable,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  ComprobanteRepository,
  COLUMNAS_NOTA,
  DatosFiscalesComprobante,
  DatosListadoComprobante,
  FiltroComprobantes,
  FilaComprobanteNueva,
  FilaItemNueva,
  NumeroOcupadoError,
} from '../../repository/Repository/comprobante.repository';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { ReceptorBussnies, TOPE_BOLETA_SIN_DOCUMENTO } from './receptor.bussnies';
import { emisorConfig } from '../../config/emisor.config';
import {
  GenerarComprobanteRequest,
  ConsultarComprobanteRequest,
  ItemComprobanteRequest,
} from '../../models/model/c-electronico/comprobante.request';
import {
  ComprobanteResponse,
  CatalogoMotivosResponse,
  ComprobanteDetalleResponse,
  ComprobanteListadoResponse,
  MotivoNotaResponse,
  PreviewComprobanteResponse,
  ItemPreviewResponse,
} from '../../models/model/c-electronico/comprobante.response';
import { ReceptorResponse } from '../../models/model/receptor.response';
import { IComprobanteBussniees } from '../Ibussnies/IComprobanteBussniees';
import { Comprobante } from '../../models/DBModel/c-electronico/comprobante.entity';
import {
  calcularComprobante,
  ResumenFiscal,
  PORCENTAJE_IGV_POR_DEFECTO,
  redondear,
} from '../../util/fiscal/calculo-fiscal';
import { numeroALetras } from '../../util/fiscal/numero-letras';
import {
  TIPO_BOLETA,
  TIPO_DOC_RUC,
  TIPO_FACTURA,
  TIPO_NOTA_CREDITO,
  esComprobantePrincipal,
  nombreTipoComprobante,
  tipoComprobanteSunat,
} from '../../util/fiscal/tipos-comprobante';
import { esFechaYmd } from '../../util/fecha-lima';
import { construirLineaCpe, totalesCpeDesdeLineas } from '../../sunat/nucleo/linea-cpe';
import type {
  AfectacionCpe,
  AmbienteFiscal,
  DocumentoCpe,
  EmisorCpe,
  FormaPagoCpe,
  ReferenciaNotaCpe,
  TipoCpe,
  TotalesCpe,
} from '../../sunat/nucleo/documento-fiscal.types';
import { DocumentoCpeInvalidoError } from '../../sunat/nucleo/errores-nucleo';
import { fechaLima, horaLima } from '../../sunat/nucleo/fechas-fiscales';
import { admiteGetStatusCdr, fechaLimiteEnvioIndividual } from '../../sunat/nucleo/reglas-envio';
import {
  CATALOGO_10_MOTIVO_NOTA_DEBITO,
  ETIQUETA_MOTIVO_NOTA_CREDITO,
  esMotivoNotaCredito,
  etiquetaMotivoNotaDebito,
  motivoNotaCreditoValidoParaTipo,
  motivoNotaDebitoVigente,
} from '../../sunat/catalogos/sunat.catalogos';
import { CLAVES_SERIES_FISCALES, SERIES_FISCALES_POR_DEFECTO } from '../../sunat/config/fiscal-config.tipos';
import { EmisionDirecta } from '../../sunat/emision/emision.contrato';
import type {
  ArchivoEnvio,
  ContextoEmision,
  DocumentoPreparado,
  EnvioVista,
  ModoEmision,
  ResultadoEmision,
  SeriesEmision,
  TipoArchivoEnvio,
} from '../../sunat/emision/emision.contrato';
import { EmisorNotasCredito } from './nota-credito.contrato';
import type {
  GestorNotasCredito,
  LineaNotaCredito,
  ResumenNotasOrigen,
  SolicitudEmisionNotaCredito,
} from './nota-credito.contrato';
import type { AnularDocumentoRequest } from '../../models/model/c-electronico/nota-credito.request';
import type { AnulacionDocumentoResponse, ConsultaAnulacionResponse } from '../../models/model/c-electronico/nota-credito.response';
import { generarPdfComprobante } from '../../util/documentos/comprobante-pdf';
import type { DatosPdfComprobante, FormatoPdfComprobante } from '../../util/documentos/comprobante-pdf';
import { obtenerLogoEmisor } from '../../util/documentos/logo-emisor';

const MONEDAS: Record<number, { nombre: string; simbolo: string }> = {
  1: { nombre: 'SOLES', simbolo: 'S/' },
  2: { nombre: 'DOLARES AMERICANOS', simbolo: 'US$' },
  3: { nombre: 'EUROS', simbolo: '€' },
  4: { nombre: 'LIBRAS ESTERLINAS', simbolo: '£' },
};

/** Intentos de reservar número cuando otros cajeros se adelantan en la misma serie (PLAN V3, D2). */
export const MAXIMO_INTENTOS_NUMERO = 5;

const AVISO_BETA = 'Prueba SUNAT BETA: sin validez tributaria.';
const CLAVE_CODIGO_PRODUCTO_DEFECTO = 'fiscal_codigo_producto_defecto';

/**
 * Motivos de nota de crédito que se ofrecen y cómo se arma cada uno (PLAN V3, D8). No se ofrecen
 * 03 (corrección de descripción), 04 (descuento global: el UBL no lo modela), 08, 11, 12 ni 13.
 */
export const FORMA_MOTIVO_NOTA_CREDITO: Readonly<Record<string, MotivoNotaResponse['forma']>> = {
  '01': 'total',
  '02': 'total',
  '05': 'descuento_items',
  '06': 'total',
  '07': 'items',
  '09': 'monto',
  '10': 'monto',
};

const ESTADOS_ACEPTADO: ReadonlySet<string> = new Set(['ACEPTADO', 'ACEPTADO_OBS']);
/** Estados SUNAT de un envío que todavía puede terminar aceptado. */
const ESTADOS_EN_CURSO: ReadonlySet<string> = new Set(['NO_ENVIADO', 'ENVIANDO', 'PENDIENTE_REENVIO']);
const PATRON_ESTADO_SUNAT = /^[A-Z_]{2,30}$/;

/** Opciones internas de emisión (no viajan en el DTO HTTP). */
export interface OpcionesGenerar {
  /** Total que DEBE dar el comprobante (venta ya cobrada): si difiere, 400 sin reservar número. */
  totalExigido?: number;
}

/** Resultado de preparar un comprobante, compartido entre vista previa y emisión. */
interface ComprobantePreparado {
  receptor: ReceptorResponse;
  resumen: ResumenFiscal;
  items: ItemPreviewResponse[];
  serie: string;
  /** dd-mm-yyyy y HH:mm:ss de Lima, tomados del mismo instante. */
  fechaEmision: string;
  horaEmision: string;
  fechaVencimiento: string;
  idMoneda: number;
  importeEnLetras: string;
  observaciones: string;
  enviarCliente: boolean;
  /** Forma de pago pedida; el monto al crédito se valida al armar el documento. */
  credito: { monto: number } | null;
  advertencias: string[];
}

/** Lo que el motor necesita para numerar, guardar y registrar el envío de un comprobante. */
interface PlanRegistro {
  serie: string;
  piso: number;
  cuerpo: Omit<DocumentoCpe, 'numero'>;
  fila: Omit<FilaComprobanteNueva, 'numero'>;
  items: FilaItemNueva[];
  idUsuario: number | null;
  /** Candados y verificaciones que van ANTES del candado de la serie, en la misma transacción. */
  antesDeNumerar?: (consultor: EntityManager) => Promise<void>;
}

interface Registrado {
  idComprobante: number;
  idEnvio: number;
  numero: number;
  preparado: DocumentoPreparado;
}

/** Datos del comprobante guardado con los que se arma la respuesta de una emisión. */
interface BaseRespuesta {
  id_comprobante: number;
  id_tipo: number | undefined;
  serie: string;
  numero: number;
  id_venta: number | null;
  cadena_qr: string | null;
  codigo_hash: string | null;
  fecha_limite_envio: string | null;
  id_comprobante_modificado?: number | null;
  doc_modificado?: string | null;
}

interface AccionesComprobante {
  puede_reintentar: boolean;
  puede_recuperar_cdr: boolean;
  puede_confirmar_manual: boolean;
  puede_nota_credito: boolean;
  puede_anular: boolean;
  vencido: boolean;
}

interface EmisorDocumento {
  ruc: string;
  razonSocial: string;
  nombreComercial?: string | null;
  direccion: string;
  distrito?: string | null;
  provincia?: string | null;
  departamento?: string | null;
}

interface EmisorConfigurado {
  ruc: string;
  razon_social: string;
  nombre_comercial: string | null;
  direccion: string;
  ubicacion: string;
  logo_url: string;
  telefono: string | null;
  email: string | null;
}

/**
 * Motor de comprobantes electrónicos (factura, boleta y nota de crédito) sobre la emisión
 * directa a SUNAT. Solo habla con EmisionDirecta (emision.contrato.ts): no conoce
 * certificados, credenciales ni endpoints, y el ambiente (BETA o PRODUCCIÓN) lo decide el contexto.
 *
 * Cada comprobante se guarda en UNA transacción con su envío (PLAN V3, D3): o quedan los dos,
 * o ninguno. Recién después del COMMIT se llama a SUNAT; si el proceso cae a mitad, el envío
 * queda ENVIANDO con plazo de bloqueo y lo recupera la emisión (reintento seguro).
 */
@Injectable()
export class ComprobanteBussnies implements IComprobanteBussniees, EmisorNotasCredito {

  private readonly logger = new Logger(ComprobanteBussnies.name);

  /** Negocio de notas de crédito: se registra al iniciar (D9: anulación y saldo de cada comprobante). */
  private gestorNotas: GestorNotasCredito | null = null;

  constructor(
    private readonly repo: ComprobanteRepository,
    private readonly receptorBussnies: ReceptorBussnies,
    private readonly config: ConfiguracionRepository,
    private readonly emision: EmisionDirecta,
  ) {}

  registrarGestorNotas(gestor: GestorNotasCredito): void {
    this.gestorNotas = gestor;
  }

  // ── Vista previa ─────────────────────────────────────────────

  /**
   * Calcula el comprobante completo sin emitirlo ni consumir número. Nunca falla porque la
   * emisión esté inactiva: lo informa en `advertencias` (la venta igual se puede registrar).
   */
  async previsualizar(dto: GenerarComprobanteRequest): Promise<PreviewComprobanteResponse> {
    this.validarSolicitud(dto, false);
    // La vista previa se pide en vivo desde el POS: las lecturas independientes van en paralelo.
    const [modo, { contexto, fallo }] = await Promise.all([this.emision.modo(), this.contextoOpcional()]);

    const serie = contexto ? this.serieDeTipo(contexto.series, dto.id_tipo) : await this.serieConfigurada(dto.id_tipo);
    const [preparado, numero, configurado] = await Promise.all([
      this.preparar(dto, { guardarReceptor: false, serie }),
      this.repo.siguienteNumero(serie, contexto?.correlativo_inicial?.[serie] ?? 1),
      this.emisorConfigurado(),
    ]);
    if (!modo.activo) {
      preparado.advertencias.unshift(`La emisión electrónica no está activa: ${modo.motivo}`);
    } else if (!contexto) {
      preparado.advertencias.unshift(`No se pudo leer la configuración de emisión: ${fallo}`);
    }

    const emisor = contexto ? this.vistaEmisor(contexto.emisor, configurado) : configurado;
    const moneda = MONEDAS[preparado.idMoneda] ?? MONEDAS[1];

    return {
      emisor: {
        ruc: emisor.ruc,
        razon_social: emisor.razon_social,
        direccion: emisor.direccion,
        ubicacion: emisor.ubicacion,
        logo_url: emisor.logo_url,
      },
      id_tipo: dto.id_tipo,
      tipo_nombre: nombreTipoComprobante(dto.id_tipo),
      serie,
      numero,
      numero_formateado: this.formatearNumero(serie, numero),
      fecha_de_emision: preparado.fechaEmision,
      fecha_de_vencimiento: preparado.fechaVencimiento,
      moneda: { id_moneda: preparado.idMoneda, ...moneda },
      receptor: preparado.receptor,
      items: preparado.items,
      porcentaje_igv: preparado.resumen.porcentaje_igv,
      totales: {
        gravada: preparado.resumen.total_gravada,
        exonerada: preparado.resumen.total_exonerada,
        inafecta: preparado.resumen.total_inafecta,
        descuento: preparado.resumen.total_descuento,
        igv: preparado.resumen.total_igv,
        total: preparado.resumen.total,
      },
      importe_en_letras: preparado.importeEnLetras,
      observaciones: dto.observaciones ?? '',
      advertencias: preparado.advertencias,
      proveedor_fiscal: 'sunat_directo',
      ambiente_fiscal: contexto?.ambiente ?? modo.ambiente,
      emision_activa: modo.activo,
      aviso: contexto?.aviso ?? null,
    };
  }

  // ── Emitir factura o boleta ──────────────────────────────────

  /**
   * Emite factura o boleta en el ambiente vigente. Serie del contexto (se ignoran `serie` y
   * `numero` del cliente), número = mayor entre MAX + 1 y el correlativo inicial de la serie.
   * Si el comprobante es de una venta, nunca deja dos principales vigentes para ella.
   */
  async generar(
    dto: GenerarComprobanteRequest,
    idUsuario: number | null = null,
    opciones: OpcionesGenerar = {},
  ): Promise<ComprobanteResponse> {
    this.validarSolicitud(dto, true);
    const modo = await this.emision.modo();
    if (!modo.activo) {
      throw new ServiceUnavailableException({
        message: `No se emitió el comprobante: la emisión electrónica no está activa (${modo.motivo}).`,
        codigo: modo.codigo,
      });
    }
    const idVenta = this.idPositivo(dto.id_venta);
    // Aviso rápido antes de buscar al cliente y firmar; la verificación que cuenta va dentro de la transacción.
    if (idVenta) await this.exigirVentaSinComprobante(idVenta);

    const contexto = await this.emision.contexto();
    const serie = this.serieDeTipo(contexto.series, dto.id_tipo);
    const preparado = await this.preparar(dto, { guardarReceptor: true, serie, totalExigido: opciones.totalExigido });
    const tipo: TipoCpe = dto.id_tipo === TIPO_FACTURA ? '01' : '03';
    const cuerpo = this.cuerpoCpe(preparado, contexto.emisor, tipo);
    const usuario = this.idPositivo(idUsuario);

    const registrado = await this.registrarConNumero({
      serie,
      piso: contexto.correlativo_inicial?.[serie] ?? 1,
      cuerpo,
      fila: this.filaComprobante(preparado, dto.id_tipo, contexto.ambiente, usuario, idVenta),
      items: this.filasItems(preparado.items),
      idUsuario: usuario,
      antesDeNumerar: idVenta
        ? async (tx) => {
            await this.repo.bloquear(tx, `cpe-venta:${idVenta}`);
            await this.exigirVentaSinComprobante(idVenta, tx);
          }
        : undefined,
    });

    return this.enviarYResponder(registrado, {
      id_comprobante: registrado.idComprobante,
      id_tipo: dto.id_tipo,
      serie,
      numero: registrado.numero,
      id_venta: idVenta,
      cadena_qr: registrado.preparado.preparado.cadenaQr,
      codigo_hash: registrado.preparado.preparado.digestValue,
      fecha_limite_envio: this.fechaLimite(tipo, serie, cuerpo.fechaEmision),
    }, contexto.aviso);
  }

  // ── Emitir nota de crédito (contrato EmisorNotasCredito) ─────

  /**
   * Emite la nota que arma el negocio de notas de crédito, con el receptor, la moneda y el % de
   * IGV del comprobante ORIGEN y la serie de nota del ambiente vigente. Orden fijo de candados:
   * nc:<origen> → validarEnTransaccion → comprobante:<serie>.
   */
  async emitirNotaCredito(solicitud: SolicitudEmisionNotaCredito): Promise<ComprobanteResponse> {
    const origen = await this.repo.buscarPorId(Number(solicitud.id_comprobante_origen));
    if (!origen) throw new NotFoundException('No existe el comprobante que se quiere corregir con la nota de crédito.');
    const numeroOrigen = this.formatearNumero(origen.serie, origen.numero);
    const tipoOrigen = tipoComprobanteSunat(origen.tipo?.id_tipo);
    if (tipoOrigen !== '01' && tipoOrigen !== '03') {
      throw new BadRequestException(`${numeroOrigen} no es una factura ni una boleta: solo a ellas se les emite nota de crédito.`);
    }

    const motivo = String(solicitud.motivo ?? '').trim();
    if (!esMotivoNotaCredito(motivo) || !FORMA_MOTIVO_NOTA_CREDITO[motivo]) {
      throw new BadRequestException(
        `El motivo "${motivo}" no está disponible para notas de crédito (se admiten ${Object.keys(FORMA_MOTIVO_NOTA_CREDITO).join(', ')}).`,
      );
    }
    if (!motivoNotaCreditoValidoParaTipo(motivo, tipoOrigen)) {
      throw new BadRequestException(
        `El motivo ${motivo} (${ETIQUETA_MOTIVO_NOTA_CREDITO[motivo]}) solo se puede usar sobre facturas, no sobre boletas.`,
      );
    }
    const sustento = this.limpiarTexto(solicitud.sustento);
    if (sustento.length < 3 || sustento.length > 250) {
      throw new BadRequestException('El sustento de la nota de crédito debe tener entre 3 y 250 caracteres.');
    }
    if (!Array.isArray(solicitud.lineas) || solicitud.lineas.length === 0) {
      throw new BadRequestException('La nota de crédito debe tener al menos una línea.');
    }

    const modo = await this.emision.modo();
    if (!modo.activo) {
      throw new ServiceUnavailableException({
        message: `No se emitió la nota de crédito: la emisión electrónica no está activa (${modo.motivo}).`,
        codigo: modo.codigo,
      });
    }
    this.exigirOrigenAdmisible(origen, modo.ambiente);
    if (!(await this.repo.tieneColumnas(...COLUMNAS_NOTA))) {
      throw new ServiceUnavailableException(
        'Aplique sql/fase9_sunat_directo.sql para guardar las notas de crédito enlazadas a su comprobante.',
      );
    }

    const contexto = await this.emision.contexto();
    if (contexto.ambiente !== origen.ambiente_fiscal) {
      throw new ConflictException({
        message: `${numeroOrigen} se emitió en ${this.nombreAmbiente(origen.ambiente_fiscal)} y el ambiente vigente es ${this.nombreAmbiente(contexto.ambiente)}: la nota no se puede emitir aquí.`,
        codigo: 'NOTA_CREDITO_NO_PERMITIDA',
      });
    }
    const serie = tipoOrigen === '01' ? contexto.series.nc_factura : contexto.series.nc_boleta;
    const preparado = await this.prepararNota(origen, solicitud.lineas, serie);

    const saldo = Number(solicitud.saldo_maximo);
    if (!Number.isFinite(saldo) || redondear(preparado.resumen.total) > redondear(saldo)) {
      throw new BadRequestException({
        message: `La nota de crédito suma ${this.monto(preparado.resumen.total)} y el saldo que todavía se puede acreditar de ${numeroOrigen} es ${this.monto(saldo)}. No se emitió.`,
        codigo: 'FISCAL_NOTA_EXCEDE_MONTO',
      });
    }

    const referencia: ReferenciaNotaCpe = {
      tipoDoc: tipoOrigen,
      serie: origen.serie,
      numero: Number(origen.numero),
      motivo,
      sustento,
    };
    const cuerpo = this.cuerpoCpe(preparado, contexto.emisor, '07', referencia);
    const idVenta = this.idPositivo(solicitud.id_venta) ?? this.idPositivo(origen.id_venta);
    const usuario = this.idPositivo(solicitud.id_usuario);
    const fila: Omit<FilaComprobanteNueva, 'numero'> = {
      ...this.filaComprobante(preparado, TIPO_NOTA_CREDITO, contexto.ambiente, usuario, idVenta),
      nota: {
        doc_modificado_tipo: tipoOrigen,
        doc_modificado_serie: origen.serie,
        doc_modificado_numero: Number(origen.numero),
        id_comprobante_modificado: origen.id_comprobante,
        nota_motivo: motivo,
        nota_sustento: sustento,
        efecto_nota: solicitud.efecto,
        reingresar_stock: solicitud.efecto === 'devolucion' && solicitud.reingresar_stock === true,
      },
    };

    const registrado = await this.registrarConNumero({
      serie,
      piso: contexto.correlativo_inicial?.[serie] ?? 1,
      cuerpo,
      fila,
      items: this.filasItems(preparado.items, solicitud.lineas.map((linea) => linea.id_item_origen ?? null)),
      idUsuario: usuario,
      antesDeNumerar: async (tx) => {
        await this.repo.bloquear(tx, `nc:${origen.id_comprobante}`);
        await solicitud.validarEnTransaccion(tx);
      },
    });

    return this.enviarYResponder(registrado, {
      id_comprobante: registrado.idComprobante,
      id_tipo: TIPO_NOTA_CREDITO,
      serie,
      numero: registrado.numero,
      id_venta: idVenta,
      cadena_qr: registrado.preparado.preparado.cadenaQr,
      codigo_hash: registrado.preparado.preparado.digestValue,
      fecha_limite_envio: this.fechaLimite('07', serie, cuerpo.fechaEmision),
      id_comprobante_modificado: origen.id_comprobante,
      doc_modificado: `${origen.serie}-${origen.numero}`,
    }, contexto.aviso);
  }

  // ── Reintento, recuperación y confirmación manual ────────────

  /** Reenvío seguro del mismo ZIP (o recuperación del CDR primero, si el documento lo admite). */
  async reintentar(id_comprobante: number): Promise<ComprobanteResponse> {
    const guardado = await this.comprobanteConEnvio(id_comprobante, 'reintentar');
    const resultado = await this.emision.reintentar(guardado.id_envio_ultimo as number);
    return this.respuestaDeGuardado(guardado, resultado);
  }

  /** Pide a SUNAT la constancia (CDR) sin reenviar nada (getStatusCdr: producción, facturas y sus notas). */
  async recuperarCdr(id_comprobante: number): Promise<ComprobanteResponse> {
    const guardado = await this.comprobanteConEnvio(id_comprobante, 'consultar');
    const resultado = await this.emision.recuperarCdr(guardado.id_envio_ultimo as number);
    return this.respuestaDeGuardado(guardado, resultado);
  }

  /** El administrador verificó en SUNAT Operaciones en Línea que el comprobante fue aceptado (queda auditado). */
  async confirmarAceptado(id_comprobante: number, idUsuario: number, nota: string): Promise<ComprobanteResponse> {
    const texto = this.limpiarTexto(nota);
    if (texto.length < 5) {
      throw new BadRequestException('Explique en la nota qué verificó en SUNAT (mínimo 5 caracteres).');
    }
    const guardado = await this.comprobanteConEnvio(id_comprobante, 'confirmar');
    const resultado = await this.emision.confirmarAceptadoManual(guardado.id_envio_ultimo as number, idUsuario, texto);
    return this.respuestaDeGuardado(guardado, resultado);
  }

  // ── Consultar ────────────────────────────────────────────────

  /**
   * Estado guardado del comprobante. Si su envío quedó incierto y SUNAT permite consultarlo
   * (producción, factura o nota de factura), recupera además la constancia.
   */
  async consultar(dto: ConsultarComprobanteRequest): Promise<ComprobanteResponse> {
    const serie = String(dto?.serie ?? '').trim().toUpperCase();
    const numero = Number(dto?.numero);
    if (!serie || !Number.isInteger(numero) || numero <= 0) {
      throw new BadRequestException('Indique la serie y el número del comprobante a consultar.');
    }
    const guardado = await this.repo.buscarPorSerieNumero(serie, numero);
    if (!guardado || (dto.tipo_de_comprobante && guardado.tipo?.id_tipo !== Number(dto.tipo_de_comprobante))) {
      throw new NotFoundException(`No existe el comprobante ${this.formatearNumero(serie, numero)} en el sistema.`);
    }

    const local = this.mapComprobante(guardado);
    const tipo = tipoComprobanteSunat(guardado.tipo?.id_tipo);
    const consultable =
      guardado.proveedor_fiscal === 'sunat_directo'
      && !!guardado.id_envio_ultimo
      && guardado.ambiente_fiscal === 'produccion'
      && !!tipo
      && admiteGetStatusCdr(tipo, guardado.serie)
      && ESTADOS_EN_CURSO.has(guardado.estado_sunat ?? '');
    if (!consultable) return local;

    try {
      const resultado = await this.emision.recuperarCdr(guardado.id_envio_ultimo as number);
      return this.respuestaDeGuardado(guardado, resultado);
    } catch (error) {
      const mensaje = this.mensajeDe(error);
      this.logger.warn(`No se pudo recuperar el CDR de ${local.numero_formateado}: ${mensaje}`);
      return { ...local, error: `No se pudo consultar a SUNAT ahora (${mensaje}). Se muestra el estado guardado.` };
    }
  }

  // ── Anular (PLAN V3, D9: lo resuelve el negocio de notas de crédito) ──

  /**
   * Si tiene una venta activa, anula la venta; si no, anula el comprobante: con nota de crédito si
   * SUNAT ya lo aceptó, o en el sistema si nunca llegó a valer. Nunca lo borra.
   */
  async anular(dto: AnularDocumentoRequest, idUsuario: number | null = null): Promise<AnulacionDocumentoResponse> {
    return this.exigirGestorNotas().anularComprobante(dto, idUsuario);
  }

  async consultarAnulacion(dto: ConsultarComprobanteRequest): Promise<ConsultaAnulacionResponse> {
    return this.exigirGestorNotas().consultarAnulacion(dto);
  }

  /** Sin el negocio de notas registrado (motor probado en aislamiento) la anulación sigue el camino de «Anular venta». */
  private exigirGestorNotas(): GestorNotasCredito {
    if (this.gestorNotas) return this.gestorNotas;
    throw new ConflictException({
      message:
        'Un comprobante electrónico no se anula desde aquí: use «Anular venta» en Ventas. Si SUNAT ya lo aceptó se emite la nota de crédito que corresponde; si nunca se envió, se anula en el sistema.',
      codigo: 'FISCAL_ANULAR_REQUIERE_NC',
    });
  }

  // ── Catálogos ────────────────────────────────────────────────

  /** Motivos del catálogo SUNAT (09 y 10) que ofrece el sistema, con la forma de armar cada nota. */
  catalogoMotivos(hoy: string = fechaLima()): CatalogoMotivosResponse {
    const tipos = ['01', '03'] as const;
    const nota_credito = Object.entries(FORMA_MOTIVO_NOTA_CREDITO)
      .filter(([codigo]) => esMotivoNotaCredito(codigo))
      .map(([codigo, forma]) => ({
        codigo,
        nombre: ETIQUETA_MOTIVO_NOTA_CREDITO[codigo as keyof typeof ETIQUETA_MOTIVO_NOTA_CREDITO],
        forma,
        tipos: tipos.filter((tipo) => motivoNotaCreditoValidoParaTipo(codigo, tipo)),
      }))
      .sort((a, b) => a.codigo.localeCompare(b.codigo));
    const nota_debito = Object.values(CATALOGO_10_MOTIVO_NOTA_DEBITO)
      .filter((codigo) => motivoNotaDebitoVigente(codigo, hoy))
      .map((codigo) => ({
        codigo,
        nombre: etiquetaMotivoNotaDebito(codigo, hoy),
        forma: 'monto' as const,
        tipos: [...tipos],
      }))
      .sort((a, b) => a.codigo.localeCompare(b.codigo));
    return { nota_credito, nota_debito };
  }

  // ── Listados ─────────────────────────────────────────────────

  async listar(filtro: FiltroComprobantes) {
    this.validarFiltro(filtro);
    const resultado = await this.repo.listar(filtro);
    const principales = resultado.datos.filter((c) => esComprobantePrincipal(c.tipo?.id_tipo)).map((c) => c.id_comprobante);
    const [extras, modo, resumenes] = await Promise.all([
      this.repo.datosListado(resultado.datos.map((c) => c.id_comprobante)),
      this.emision.modo(),
      this.resumenesNotas(principales),
    ]);
    const hoy = fechaLima();
    return {
      ...resultado,
      datos: resultado.datos.map((c) =>
        this.mapListado(c, extras.get(c.id_comprobante) ?? null, modo, hoy, resumenes.get(c.id_comprobante) ?? null),
      ),
    };
  }

  /** Contador para badge de Documentos (CPE pendiente/error). */
  async monitorAtencion() {
    return this.repo.contarAtencion();
  }

  /** Comprobantes de la venta; el principal vigente va primero. */
  async listarPorVenta(id_venta: number): Promise<ComprobanteResponse[]> {
    const lista = await this.repo.listarPorVenta(id_venta);
    return lista.map((c) => this.mapComprobante(c));
  }

  async listarPorCliente(id_cliente: number): Promise<ComprobanteResponse[]> {
    const lista = await this.repo.listarPorCliente(id_cliente);
    return lista.map((c) => this.mapComprobante(c));
  }

  async obtenerPorId(id_comprobante: number): Promise<ComprobanteResponse> {
    const c = await this.repo.buscarPorId(id_comprobante);
    if (!c) throw new NotFoundException('Comprobante no encontrado');
    return this.mapComprobante(c);
  }

  /** Detalle completo, con líneas, totales, envío, notas y guías enlazadas, para reimprimir o revisar. */
  async obtenerDetalle(id_comprobante: number): Promise<ComprobanteDetalleResponse> {
    const c = await this.repo.buscarPorId(id_comprobante);
    if (!c) throw new NotFoundException('Comprobante no encontrado');

    const [fiscal, envio, notas, guias, configurado, modo, resumenes] = await Promise.all([
      this.repo.datosFiscales(id_comprobante),
      this.envioDe(c),
      this.opcional(() => this.repo.notasDe(id_comprobante), `notas de ${c.serie}-${c.numero}`, []),
      this.opcional(() => this.repo.guiasDe(id_comprobante), `guías de ${c.serie}-${c.numero}`, []),
      this.emisorConfigurado(),
      this.emision.modo(),
      this.resumenesNotas(esComprobantePrincipal(c.tipo?.id_tipo) ? [id_comprobante] : []),
    ]);
    const emisor = await this.emisorDelDocumento(c, fiscal, configurado);
    const hoy = fechaLima();

    const idTipo = c.tipo?.id_tipo;
    const idMoneda = Number(c.moneda?.id_moneda ?? 1);
    const fechaLimiteEnvio = fiscal?.fecha_limite_envio ?? null;
    const acciones = this.acciones(
      c,
      {
        accion: envio?.accion_sunat ?? null,
        envioLibre: envio ? this.envioLibre(envio) : null,
        fechaLimite: fechaLimiteEnvio,
      },
      modo,
      hoy,
      resumenes.get(id_comprobante) ?? null,
    );
    const formaPago = fiscal?.forma_pago === 'Credito' || fiscal?.forma_pago === 'Contado' ? fiscal.forma_pago : null;

    return {
      emisor,
      id_comprobante: c.id_comprobante,
      id_tipo: idTipo,
      tipo_nombre: nombreTipoComprobante(idTipo),
      serie: c.serie,
      numero: c.numero,
      numero_formateado: this.formatearNumero(c.serie, c.numero),
      fecha_de_emision: c.fecha_de_emision,
      fecha_de_vencimiento: c.fecha_de_vencimiento,
      hora_emision: fiscal?.hora_emision ?? fiscal?.hora_envio ?? null,
      moneda: { id_moneda: idMoneda, ...(MONEDAS[idMoneda] ?? MONEDAS[1]) },
      receptor: {
        tipo_documento: c.cliente_tipo_doc,
        numero_documento: c.cliente_numero_doc,
        denominacion: c.cliente_denominacion,
        direccion: c.cliente_direccion,
        email: c.cliente_email,
      },
      items: (c.items ?? []).map((i) => ({
        codigo: i.codigo,
        codigo_producto_sunat: i.codigo_producto_sunat ?? null,
        unidad_de_medida: i.unidad_de_medida,
        descripcion: i.descripcion,
        cantidad: Number(i.cantidad ?? 0),
        valor_unitario: Number(i.valor_unitario ?? 0),
        precio_unitario: Number(i.precio_unitario ?? 0),
        descuento: Number(i.descuento ?? 0),
        subtotal: Number(i.subtotal ?? 0),
        igv: Number(i.igv ?? 0),
        total: Number(i.total ?? 0),
        tipo_de_igv: Number(i.tipo_de_igv ?? 1),
      })),
      porcentaje_igv: Number(c.porcentaje_igv ?? PORCENTAJE_IGV_POR_DEFECTO),
      totales: {
        gravada: Number(c.total_gravada ?? 0),
        exonerada: Number(c.total_exonerada ?? 0),
        inafecta: Number(c.total_inafecta ?? 0),
        descuento: Number(c.total_descuento ?? 0),
        igv: Number(c.total_igv ?? 0),
        total: Number(c.total ?? 0),
      },
      importe_en_letras: c.importe_en_letras ?? numeroALetras(Number(c.total ?? 0), idMoneda),
      observaciones: c.observaciones ?? '',
      estado: this.estadoVisible(c),
      anulado: Boolean(c.anulado),
      motivo_anulacion: c.motivo_anulacion,
      enlace: c.enlace,
      enlace_pdf: c.enlace_pdf,
      cadena_qr: c.cadena_qr ?? null,
      codigo_hash: c.codigo_hash ?? null,
      sunat_description: c.sunat_description,
      sunat_responsecode: c.sunat_responsecode ?? null,
      sunat_observaciones: Array.isArray(c.sunat_observaciones) ? c.sunat_observaciones : [],
      error_mensaje: c.error_mensaje,
      proveedor_fiscal: c.proveedor_fiscal ?? null,
      ambiente_fiscal: c.ambiente_fiscal ?? null,
      estado_sunat: c.estado_sunat ?? null,
      aceptada_sunat: Boolean(c.aceptada_sunat),
      id_envio_ultimo: c.id_envio_ultimo ?? null,
      id_venta: c.id_venta ?? null,
      forma_pago: formaPago,
      cuotas: this.cuotasDe(fiscal?.cuotas),
      fecha_limite_envio: fechaLimiteEnvio,
      vencido: acciones.vencido,
      envio: envio
        ? {
            id_envio: envio.id_envio,
            estado: envio.estado,
            codigo: envio.codigo_sunat,
            mensaje: envio.mensaje_sunat,
            accion: envio.accion_sunat,
            intento: envio.intento ?? null,
          }
        : null,
      referencia: this.referenciaDe(idTipo, fiscal),
      notas: notas.map((n) => ({
        id_comprobante: n.id_comprobante,
        id_tipo: n.id_tipo,
        serie: n.serie,
        numero: n.numero,
        numero_formateado: this.formatearNumero(n.serie, n.numero),
        motivo: n.motivo,
        total: n.total,
        estado: n.anulado ? 'anulado' : n.estado === 'error' || n.estado === 'pendiente' ? n.estado : n.aceptada_sunat ? 'aceptado' : 'emitido',
        estado_sunat: n.estado_sunat,
        anulado: n.anulado,
      })),
      guias: guias.map((g) => ({
        id_guia: g.id_guia,
        serie: g.serie,
        numero: g.numero,
        numero_formateado: g.serie && g.numero ? this.formatearNumero(g.serie, g.numero) : null,
        estado: g.estado,
        fecha_emision: g.fecha_emision,
      })),
      archivos: [...(envio?.archivos ?? [])],
      aviso: c.proveedor_fiscal === 'sunat_directo' && c.ambiente_fiscal === 'beta' ? AVISO_BETA : null,
      puede_reintentar: acciones.puede_reintentar,
      puede_recuperar_cdr: acciones.puede_recuperar_cdr,
      puede_confirmar_manual: acciones.puede_confirmar_manual,
      puede_nota_credito: acciones.puede_nota_credito,
      puede_anular: acciones.puede_anular,
    };
  }

  // ── Representación impresa y archivos ────────────────────────

  /** PDF A4 o ticket de 80 mm con QR y hash, armado con los datos guardados del comprobante. */
  async obtenerPdf(
    id_comprobante: number,
    formato: FormatoPdfComprobante = 'a4',
  ): Promise<{ nombre: string; contenido: Buffer }> {
    const detalle = await this.obtenerDetalle(id_comprobante);
    const datos = await this.datosPdf(detalle);
    try {
      const contenido = await generarPdfComprobante(datos, { formato });
      return { nombre: `${detalle.numero_formateado}${formato === 'ticket' ? '-ticket' : ''}.pdf`, contenido };
    } catch (error) {
      this.logger.error(`No se pudo generar el PDF de ${detalle.numero_formateado}: ${this.mensajeDe(error)}`);
      throw new InternalServerErrorException({
        message: `No se pudo generar el PDF de ${detalle.numero_formateado}. Intente de nuevo; si persiste, descargue el XML desde Documentos.`,
        codigo: 'COMPROBANTE_PDF_ERROR',
      });
    }
  }

  /** XML, ZIP o CDR del último envío del comprobante (lista cerrada de tipos). */
  async obtenerArchivo(id_comprobante: number, tipo: TipoArchivoEnvio): Promise<ArchivoEnvio> {
    const c = await this.repo.buscarPorId(id_comprobante);
    if (!c) throw new NotFoundException('Comprobante no encontrado');
    const numero = this.formatearNumero(c.serie, c.numero);
    if (c.proveedor_fiscal !== 'sunat_directo' || !c.id_envio_ultimo) {
      throw new NotFoundException(`${numero} no tiene archivos electrónicos guardados: no se emitió por envío directo a SUNAT.`);
    }
    const archivo = await this.emision.obtenerArchivo(c.id_envio_ultimo, tipo);
    if (!archivo) {
      throw new NotFoundException(
        tipo.startsWith('cdr')
          ? `${numero} todavía no tiene constancia (CDR) de SUNAT.`
          : `El archivo ${tipo} de ${numero} no está disponible.`,
      );
    }
    return archivo;
  }

  // ── Numeración y transacción única (PLAN V3, D2 y D3) ───────

  /**
   * Numeración optimista: arma y firma con el candidato FUERA de la transacción (un error de
   * validación nunca quema número) y dentro de ella vuelve a leer el siguiente bajo el candado de
   * la serie. Si otro cajero se adelantó, re-prepara con el siguiente (máximo 5 intentos).
   */
  private async registrarConNumero(plan: PlanRegistro): Promise<Registrado> {
    let numero = await this.repo.siguienteNumero(plan.serie, plan.piso);
    for (let intento = 1; ; intento++) {
      const preparado = await this.prepararDocumento({ ...plan.cuerpo, numero });
      try {
        const guardado = await this.repo.transaccion(async (tx) => {
          if (plan.antesDeNumerar) await plan.antesDeNumerar(tx);
          const idComprobante = await this.repo.reservarCorrelativo(tx, { ...plan.fila, numero }, plan.items, plan.piso);
          const idEnvio = await this.registrarEnvio(tx, preparado, idComprobante, plan.idUsuario);
          return { idComprobante, idEnvio };
        });
        return { ...guardado, numero, preparado };
      } catch (error) {
        if (!(error instanceof NumeroOcupadoError)) throw error;
        if (intento >= MAXIMO_INTENTOS_NUMERO) {
          throw new ConflictException({
            message: `No se pudo reservar un número libre en la serie ${plan.serie} tras ${MAXIMO_INTENTOS_NUMERO} intentos (muchas emisiones a la vez). No se emitió nada: vuelva a intentarlo en unos segundos.`,
            codigo: 'NUMERO_NO_DISPONIBLE',
          });
        }
        const siguiente = Math.max(error.siguiente, await this.repo.siguienteNumero(plan.serie, plan.piso));
        this.logger.warn(
          `Serie ${plan.serie}: el número ${numero} ya se usó; se vuelve a preparar con ${siguiente} (intento ${intento + 1}).`,
        );
        numero = siguiente;
      }
    }
  }

  /**
   * Un número que SUNAT ya recibió en este ambiente sin fila en comprobantes (p. ej. la prueba de
   * conexión del panel en BETA) también está ocupado: se revierte y se prueba con el siguiente.
   */
  private async registrarEnvio(
    consultor: EntityManager,
    preparado: DocumentoPreparado,
    idComprobante: number,
    idUsuario: number | null,
  ): Promise<number> {
    try {
      return await this.emision.registrarEnvio(consultor, preparado, idComprobante, idUsuario);
    } catch (error) {
      if ((error as { codigo?: unknown })?.codigo === 'FISCAL_NUMERO_OCUPADO') {
        const { serie, numero } = preparado.documento;
        throw new NumeroOcupadoError(serie, numero, numero + 1);
      }
      throw error;
    }
  }

  /** Valida, arma el XML, firma y empaqueta con la emisión; un rechazo del núcleo es un 400 sin efectos. */
  private async prepararDocumento(documento: DocumentoCpe): Promise<DocumentoPreparado> {
    try {
      return await this.emision.prepararDocumento(documento);
    } catch (error) {
      if (error instanceof DocumentoCpeInvalidoError) {
        throw new BadRequestException({
          message: `El comprobante no pasa las validaciones de SUNAT y no se emitió: ${error.errores.join(' | ')}`,
          codigo: 'FISCAL_VALIDACION_CPE',
          errores: [...error.errores],
        });
      }
      throw error;
    }
  }

  /**
   * Después del COMMIT: manda a SUNAT. Si la llamada falla el comprobante YA está guardado con su
   * envío en ENVIANDO (recuperable): se informa como pendiente para que nadie emita otro encima.
   */
  private async enviarYResponder(registrado: Registrado, base: BaseRespuesta, aviso: string | null): Promise<ComprobanteResponse> {
    try {
      const resultado = await this.emision.enviarRegistrado(registrado.idEnvio, registrado.preparado);
      return this.respuestaEmision(base, resultado, aviso);
    } catch (error) {
      const mensaje = this.mensajeDe(error);
      const numero = this.formatearNumero(base.serie, base.numero);
      this.logger.error(`${numero} quedó guardado (envío ${registrado.idEnvio}) pero el envío a SUNAT no terminó: ${mensaje}`);
      return {
        ...this.respuestaBase(base),
        aceptada_sunat: false,
        estado: 'pendiente',
        estado_sunat: 'ENVIANDO',
        id_envio_ultimo: registrado.idEnvio,
        ambiente_fiscal: registrado.preparado.ambiente,
        error: `${numero} quedó guardado, pero su envío a SUNAT no terminó (${mensaje}). Se reintentará o recuperará desde Documentos; no emita otro comprobante para la misma venta.`,
        aviso,
      };
    }
  }

  private async exigirVentaSinComprobante(idVenta: number, consultor?: EntityManager): Promise<void> {
    const vigente = await this.repo.principalVigenteDeVenta(idVenta, consultor);
    if (!vigente) return;
    const numero = this.formatearNumero(vigente.serie, vigente.numero);
    throw new ConflictException({
      message: `La venta ${idVenta} ya tiene el comprobante ${numero}${vigente.estado === 'pendiente' ? ' (su envío a SUNAT está en curso)' : ''}. No se emitió otro para no duplicarlo.`,
      codigo: 'VENTA_CON_COMPROBANTE',
      id_comprobante: vigente.id_comprobante,
    });
  }

  /** Solo factura o boleta aceptada por SUNAT, emitida por envío directo en el ambiente vigente y no anulada (PLAN D8). */
  private exigirOrigenAdmisible(origen: Comprobante, ambienteVigente: AmbienteFiscal): void {
    const numero = this.formatearNumero(origen.serie, origen.numero);
    const rechazo = (message: string) => new ConflictException({ message, codigo: 'NOTA_CREDITO_NO_PERMITIDA' });
    if (origen.anulado) throw rechazo(`${numero} está anulado: no admite notas de crédito.`);
    if (origen.proveedor_fiscal !== 'sunat_directo') {
      throw rechazo(`${numero} se emitió con el sistema anterior: su nota de crédito no se emite desde aquí (la venta se anula en el sistema).`);
    }
    if (origen.ambiente_fiscal !== ambienteVigente) {
      throw rechazo(
        `${numero} se emitió en ${this.nombreAmbiente(origen.ambiente_fiscal)} y el ambiente vigente es ${this.nombreAmbiente(ambienteVigente)}: se anula en el sistema, sin nota de crédito.`,
      );
    }
    if (!origen.aceptada_sunat || !ESTADOS_ACEPTADO.has(origen.estado_sunat ?? '')) {
      throw rechazo(
        `${numero} todavía no está aceptado por SUNAT (estado ${origen.estado_sunat ?? 'sin enviar'}): la nota de crédito solo se emite sobre comprobantes aceptados.`,
      );
    }
  }

  private async comprobanteConEnvio(id_comprobante: number, accion: string): Promise<Comprobante> {
    const guardado = await this.repo.buscarPorId(id_comprobante);
    if (!guardado) throw new NotFoundException('Comprobante no encontrado');
    if (guardado.proveedor_fiscal !== 'sunat_directo' || !guardado.id_envio_ultimo) {
      throw new BadRequestException(
        `${this.formatearNumero(guardado.serie, guardado.numero)} no tiene un envío electrónico a SUNAT que se pueda ${accion} (es histórico o nunca se envió). No se consultará ni reenviará a un proveedor externo.`,
      );
    }
    return guardado;
  }

  // ── Preparación compartida ───────────────────────────────────

  private validarSolicitud(dto: GenerarComprobanteRequest, emitir: boolean): void {
    if (dto?.id_tipo !== TIPO_FACTURA && dto?.id_tipo !== TIPO_BOLETA) {
      throw new BadRequestException(
        'Aquí solo se emiten facturas y boletas. Las notas de crédito se emiten desde el comprobante que corrigen.',
      );
    }
    if (emitir && dto.enviar_sunat === false) {
      throw new BadRequestException(
        'La emisión electrónica siempre envía el comprobante a SUNAT; no se puede guardar como si ya estuviera emitido.',
      );
    }
    if (Number(dto.descuento_global ?? 0) !== 0) {
      throw new BadRequestException(
        'La emisión electrónica no admite descuentos globales sin distribuirlos en las líneas. Aplique el descuento por producto.',
      );
    }
    const moneda = Number(dto.id_moneda ?? 1);
    if (moneda !== 1 && moneda !== 2) {
      throw new BadRequestException('La emisión electrónica solo admite soles (PEN) o dólares (USD).');
    }
  }

  private async preparar(
    dto: GenerarComprobanteRequest,
    opciones: { guardarReceptor: boolean; serie: string; totalExigido?: number },
  ): Promise<ComprobantePreparado> {
    if (!Array.isArray(dto.items) || dto.items.length === 0) {
      throw new BadRequestException('El comprobante debe tener al menos un producto');
    }

    const advertencias: string[] = [];
    const receptor = await this.resolverReceptor(dto, opciones.guardarReceptor);
    if (receptor.advertencia) advertencias.push(receptor.advertencia);

    const porcentajeIgv = await this.config.obtenerNumero('tienda_igv_porcentaje', PORCENTAJE_IGV_POR_DEFECTO);
    const codigoDefecto = await this.codigoProductoDefecto();
    const resumen = calcularComprobante(
      dto.items.map((item) => this.aLineaFiscal(item, porcentajeIgv)),
      porcentajeIgv,
    );

    if (resumen.total <= 0) {
      throw new BadRequestException('El total del comprobante debe ser mayor a cero');
    }
    if (opciones.totalExigido !== undefined && redondear(resumen.total) !== redondear(opciones.totalExigido)) {
      const diferencia = redondear(resumen.total - opciones.totalExigido);
      throw new BadRequestException({
        message: `El comprobante sumaría ${this.monto(resumen.total)} y la venta se cobró por ${this.monto(opciones.totalExigido)} (diferencia ${this.monto(diferencia)}). No se emitió para no declarar a SUNAT un importe distinto al cobrado.`,
        codigo: 'COMPROBANTE_TOTAL_DISTINTO',
      });
    }

    this.validar(dto, receptor, resumen);

    const idMoneda = Number(dto.id_moneda ?? 1);
    // Fecha y hora salen del mismo instante (hora de Perú, no la del servidor en UTC).
    const instante = new Date();
    const fechaEmision = this.fechaGuardada(fechaLima(instante));
    const fechaVencimiento = dto.fecha_de_vencimiento?.trim()
      ? this.normalizarFecha(dto.fecha_de_vencimiento, fechaEmision)
      : fechaEmision;

    return {
      receptor,
      resumen,
      items: this.armarItems(dto.items, resumen, codigoDefecto),
      serie: opciones.serie,
      fechaEmision,
      horaEmision: horaLima(instante),
      fechaVencimiento,
      idMoneda,
      importeEnLetras: numeroALetras(resumen.total, idMoneda),
      observaciones: dto.observaciones ?? '',
      enviarCliente: dto.enviar_cliente ?? false,
      credito: this.esCredito(dto) ? { monto: Number(dto.monto_credito ?? 0) } : null,
      advertencias,
    };
  }

  /** La nota usa el receptor, la moneda y el % de IGV del ORIGEN, y el mismo cálculo que factura y boleta. */
  private async prepararNota(origen: Comprobante, lineas: LineaNotaCredito[], serie: string): Promise<ComprobantePreparado> {
    const idMoneda = Number(origen.moneda?.id_moneda ?? 1);
    if (idMoneda !== 1 && idMoneda !== 2) {
      throw new BadRequestException('La nota de crédito solo se emite en soles (PEN) o dólares (USD), como su comprobante.');
    }
    const porcentajeIgv = Number(origen.porcentaje_igv ?? PORCENTAJE_IGV_POR_DEFECTO);
    const resumen = calcularComprobante(
      lineas.map((linea) => this.aLineaFiscal(linea, porcentajeIgv)),
      porcentajeIgv,
    );
    if (resumen.total <= 0) {
      throw new BadRequestException('El total de la nota de crédito debe ser mayor a cero.');
    }

    const tipoDocumento = Number(origen.cliente_tipo_doc);
    const receptor: ReceptorResponse = {
      origen: 'base',
      tipo: tipoDocumento === TIPO_DOC_RUC ? 'empresa' : 'cliente',
      id_cliente: origen.cliente?.id_cliente,
      tipo_documento: tipoDocumento,
      numero_documento: origen.cliente_numero_doc,
      denominacion: origen.cliente_denominacion,
      direccion: origen.cliente_direccion ?? '',
      email: origen.cliente_email ?? '',
      telefono: '',
      admite_factura: tipoDocumento === TIPO_DOC_RUC,
    };

    const instante = new Date();
    const fechaEmision = this.fechaGuardada(fechaLima(instante));
    return {
      receptor,
      resumen,
      items: this.armarItems(lineas, resumen, await this.codigoProductoDefecto()),
      serie,
      fechaEmision,
      horaEmision: horaLima(instante),
      fechaVencimiento: fechaEmision,
      idMoneda,
      importeEnLetras: numeroALetras(resumen.total, idMoneda),
      observaciones: '',
      enviarCliente: false,
      credito: null,
      advertencias: [],
    };
  }

  /**
   * Arma el cuerpo del DocumentoCpe (sin número) con el emisor del ambiente. Comprueba que lo que
   * declara el XML cuadre al céntimo con lo calculado para la venta y valida el crédito.
   */
  private cuerpoCpe(
    preparado: ComprobantePreparado,
    emisor: EmisorCpe,
    tipo: TipoCpe,
    referencia?: ReferenciaNotaCpe,
  ): Omit<DocumentoCpe, 'numero'> {
    const receptor = preparado.receptor;
    const porcentajeIgv = preparado.resumen.porcentaje_igv;
    const lineas = preparado.items.map((item) =>
      construirLineaCpe(
        {
          cantidad: item.cantidad,
          precioUnitario: item.precio_unitario,
          subtotal: item.subtotal,
          igv: item.igv,
          total: item.total,
          afectacion: this.afectacionCpe(item.tipo_de_igv),
          descuento: item.descuento,
        },
        {
          unidad: item.unidad_de_medida,
          descripcion: item.descripcion,
          codigoInterno: item.codigo,
          codigoSunat: item.codigo_producto_sunat || undefined,
        },
        porcentajeIgv,
      ),
    );
    const totales = totalesCpeDesdeLineas(lineas);
    this.exigirCuadre(totales, preparado.resumen);

    const fechaEmision = this.fechaIso(preparado.fechaEmision);
    const formaPago = referencia ? undefined : this.formaPagoCpe(preparado, totales, fechaEmision);

    return {
      tipo,
      serie: preparado.serie,
      fechaEmision,
      horaEmision: preparado.horaEmision,
      fechaVencimiento: formaPago?.tipo === 'Credito' ? this.fechaIso(preparado.fechaVencimiento) : undefined,
      moneda: preparado.idMoneda === 2 ? 'USD' : 'PEN',
      emisor,
      cliente: {
        tipoDoc: String(receptor.tipo_documento),
        numDoc: receptor.numero_documento,
        nombre: receptor.denominacion,
        direccion: receptor.direccion || undefined,
      },
      lineas,
      totales,
      formaPago,
      leyendaMontoLetras: preparado.importeEnLetras,
      observaciones: preparado.observaciones || undefined,
      referencia,
    };
  }

  private exigirCuadre(totales: TotalesCpe, resumen: ResumenFiscal): void {
    const esperados = {
      gravada: resumen.total_gravada,
      exonerada: resumen.total_exonerada,
      inafecta: resumen.total_inafecta,
      igv: resumen.total_igv,
      total: resumen.total,
    };
    for (const clave of Object.keys(esperados) as (keyof typeof esperados)[]) {
      if (redondear(totales[clave]) !== redondear(esperados[clave])) {
        throw new BadRequestException(
          `Los totales que se declararían a SUNAT no coinciden con los calculados para la venta (${clave}). No se reservó número ni se envió nada.`,
        );
      }
    }
  }

  /** Contado, o crédito con una cuota que vence en la fecha de vencimiento de la venta. */
  private formaPagoCpe(preparado: ComprobantePreparado, totales: TotalesCpe, fechaEmisionIso: string): FormaPagoCpe {
    if (!preparado.credito) return { tipo: 'Contado' };
    const fechaVencimientoIso = this.fechaIso(preparado.fechaVencimiento);
    if (fechaVencimientoIso <= fechaEmisionIso) {
      throw new BadRequestException(
        'Para emitir una venta al crédito, indique una fecha de vencimiento posterior a la emisión.',
      );
    }
    const montoCredito = redondear(preparado.credito.monto);
    if (!Number.isFinite(montoCredito) || montoCredito <= 0 || montoCredito > totales.total) {
      throw new BadRequestException('El monto al crédito de la venta no es válido para el comprobante.');
    }
    return {
      tipo: 'Credito',
      montoPendiente: montoCredito,
      cuotas: [{ numero: 1, monto: montoCredito, fechaPago: fechaVencimientoIso }],
    };
  }

  /** Crédito por el campo tipado; sin él, por el texto de condiciones con o sin tilde. */
  private esCredito(dto: GenerarComprobanteRequest): boolean {
    if (dto.forma_pago) return dto.forma_pago === 'Credito';
    const texto = (dto.condiciones_de_pago ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    return texto.includes('credito');
  }

  /**
   * El frontend envía el precio de venta, que ya incluye IGV. Si por
   * compatibilidad llegara solo el valor unitario sin impuesto, se le agrega.
   */
  private aLineaFiscal(item: ItemComprobanteRequest, porcentajeIgv: number) {
    const precioConIgv = item.precio_unitario ?? (
      item.valor_unitario !== undefined
        ? redondear(item.valor_unitario * (1 + porcentajeIgv / 100))
        : 0
    );

    return {
      cantidad: Number(item.cantidad) || 0,
      precio_unitario: precioConIgv,
      descuento: item.descuento ?? 0,
      tipo_de_igv: item.tipo_de_igv,
    };
  }

  /** Sin código SUNAT en el producto se usa el configurado por defecto; si tampoco hay, se omite del XML. */
  private armarItems(entradas: ItemComprobanteRequest[], resumen: ResumenFiscal, codigoDefecto: string): ItemPreviewResponse[] {
    return entradas.map((entrada, indice) => {
      const linea = resumen.lineas[indice];
      return {
        id_producto: entrada.id_producto,
        codigo: entrada.codigo?.trim() || String(entrada.id_producto ?? indice + 1),
        codigo_producto_sunat: (entrada.codigo_producto_sunat ?? '').replace(/\s+/g, '') || codigoDefecto,
        unidad_de_medida: entrada.unidad_de_medida?.trim().toUpperCase() || 'NIU',
        descripcion: this.limpiarTexto(entrada.descripcion),
        cantidad: linea.cantidad,
        valor_unitario: linea.valor_unitario,
        precio_unitario: linea.precio_unitario,
        descuento: linea.descuento,
        subtotal: linea.subtotal,
        igv: linea.igv,
        total: linea.total,
        tipo_de_igv: linea.tipo_de_igv,
      };
    });
  }

  private async codigoProductoDefecto(): Promise<string> {
    return (await this.config.obtenerTexto(CLAVE_CODIGO_PRODUCTO_DEFECTO, '')).replace(/\s+/g, '');
  }

  private filaComprobante(
    preparado: ComprobantePreparado,
    idTipo: number,
    ambiente: AmbienteFiscal,
    idUsuario: number | null,
    idVenta: number | null,
  ): Omit<FilaComprobanteNueva, 'numero'> {
    const { receptor, resumen } = preparado;
    return {
      id_venta: idVenta,
      id_cliente: receptor.id_cliente ?? null,
      id_tipo: idTipo,
      id_moneda: preparado.idMoneda,
      serie: preparado.serie,
      cliente_tipo_doc: Number(receptor.tipo_documento),
      cliente_numero_doc: receptor.numero_documento,
      cliente_denominacion: receptor.denominacion,
      cliente_direccion: receptor.direccion ?? null,
      cliente_email: receptor.email ?? null,
      fecha_de_emision: preparado.fechaEmision,
      fecha_de_vencimiento: preparado.fechaVencimiento,
      porcentaje_igv: resumen.porcentaje_igv,
      total_gravada: resumen.total_gravada,
      total_exonerada: resumen.total_exonerada,
      total_inafecta: resumen.total_inafecta,
      total_descuento: resumen.total_descuento,
      total_igv: resumen.total_igv,
      total: resumen.total,
      importe_en_letras: preparado.importeEnLetras,
      observaciones: preparado.observaciones,
      enviar_cliente: preparado.enviarCliente,
      ambiente_fiscal: ambiente,
      id_usuario: idUsuario,
    };
  }

  private filasItems(items: ItemPreviewResponse[], origenes: (number | null)[] = []): FilaItemNueva[] {
    return items.map((item, indice) => ({
      id_producto: item.id_producto ?? null,
      unidad_de_medida: item.unidad_de_medida,
      codigo: item.codigo,
      codigo_producto_sunat: item.codigo_producto_sunat || null,
      descripcion: item.descripcion,
      cantidad: item.cantidad,
      valor_unitario: item.valor_unitario,
      precio_unitario: item.precio_unitario,
      descuento: item.descuento,
      subtotal: item.subtotal,
      tipo_de_igv: item.tipo_de_igv,
      igv: item.igv,
      total: item.total,
      id_item_origen: origenes[indice] ?? null,
    }));
  }

  private async resolverReceptor(
    dto: GenerarComprobanteRequest,
    guardar: boolean,
  ): Promise<ReceptorResponse> {
    const documento = (dto.documento ?? dto.ruc ?? dto.dni ?? '').toString().replace(/\D/g, '');

    // 00000000 es el consumidor final: no se busca ni se consulta como si fuera un DNI.
    if (documento && !/^0+$/.test(documento)) return this.receptorBussnies.buscarPorDocumento(documento, guardar);
    if (dto.id_empresa) return this.receptorBussnies.porIdEmpresa(dto.id_empresa);
    if (dto.id_cliente) return this.receptorBussnies.porIdCliente(dto.id_cliente);

    // Sin documento solo se puede emitir boleta a consumidor final.
    if (dto.id_tipo === TIPO_BOLETA) return this.receptorBussnies.consumidorFinal();

    throw new BadRequestException(
      'Indique el DNI o RUC del cliente, o selecciónelo de la lista',
    );
  }

  private validar(
    dto: GenerarComprobanteRequest,
    receptor: ReceptorResponse,
    resumen: ResumenFiscal,
  ): void {
    if (dto.id_tipo === TIPO_FACTURA && Number(receptor.tipo_documento) !== TIPO_DOC_RUC) {
      throw new BadRequestException(
        'Una factura solo puede emitirse a un RUC. Para una persona con DNI use boleta.',
      );
    }

    const anonimo = receptor.origen === 'generico' || /^0*$/.test(String(receptor.numero_documento ?? ''));
    if (dto.id_tipo === TIPO_BOLETA && anonimo && resumen.total > TOPE_BOLETA_SIN_DOCUMENTO) {
      throw new BadRequestException(
        `Por encima de S/ ${TOPE_BOLETA_SIN_DOCUMENTO} SUNAT exige identificar al comprador. Ingrese su DNI o RUC.`,
      );
    }

    if (!String(receptor.denominacion ?? '').trim()) {
      throw new BadRequestException('Indique el nombre o razón social del cliente: el comprobante no puede salir sin él.');
    }
  }

  // ── Respuestas ───────────────────────────────────────────────

  private respuestaBase(base: BaseRespuesta): ComprobanteResponse {
    return {
      id_comprobante: base.id_comprobante,
      tipo_de_comprobante: base.id_tipo,
      serie: base.serie,
      numero: base.numero,
      numero_formateado: this.formatearNumero(base.serie, base.numero),
      cadena_qr: base.cadena_qr ?? undefined,
      codigo_hash: base.codigo_hash ?? undefined,
      proveedor_fiscal: 'sunat_directo',
      fecha_limite_envio: base.fecha_limite_envio,
      id_venta: base.id_venta,
      ...(base.id_comprobante_modificado
        ? { id_comprobante_modificado: base.id_comprobante_modificado, doc_modificado: base.doc_modificado ?? null }
        : {}),
    };
  }

  /** «emitido» solo si SUNAT aceptó; «pendiente» si el envío puede terminar aceptado; si no, «error». */
  private respuestaEmision(base: BaseRespuesta, resultado: ResultadoEmision, aviso: string | null): ComprobanteResponse {
    const aceptado = resultado.aceptado === true;
    const estado = aceptado ? 'emitido' : ESTADOS_EN_CURSO.has(resultado.estado) ? 'pendiente' : 'error';
    const archivos = [...(resultado.archivos ?? [])];
    return {
      ...this.respuestaBase(base),
      aceptada_sunat: aceptado,
      sunat_description: resultado.mensaje ?? undefined,
      sunat_responsecode: resultado.codigo ?? undefined,
      sunat_observaciones: resultado.observaciones ?? [],
      cadena_qr: resultado.cadena_qr || base.cadena_qr || undefined,
      codigo_hash: resultado.digest || base.codigo_hash || undefined,
      estado,
      error: aceptado
        ? undefined
        : resultado.mensaje || 'SUNAT no confirmó la aceptación del comprobante. Revíselo en Documentos.',
      ambiente_fiscal: resultado.ambiente,
      estado_sunat: resultado.estado,
      id_envio_ultimo: resultado.id_envio,
      accion_sunat: resultado.accion ?? null,
      archivos,
      archivos_beta: archivos,
      aviso,
      fecha_limite_envio: resultado.fecha_limite_envio ?? base.fecha_limite_envio,
    };
  }

  private respuestaDeGuardado(c: Comprobante, resultado: ResultadoEmision): ComprobanteResponse {
    const tipo = tipoComprobanteSunat(c.tipo?.id_tipo);
    const fechaEmision = this.fechaIsoOpcional(c.fecha_de_emision);
    return this.respuestaEmision(
      {
        id_comprobante: c.id_comprobante,
        id_tipo: c.tipo?.id_tipo,
        serie: c.serie,
        numero: c.numero,
        id_venta: c.id_venta ?? null,
        cadena_qr: c.cadena_qr ?? null,
        codigo_hash: c.codigo_hash ?? null,
        fecha_limite_envio: tipo && fechaEmision ? this.fechaLimite(tipo, c.serie, fechaEmision) : null,
      },
      resultado,
      resultado.ambiente === 'beta' ? AVISO_BETA : null,
    );
  }

  // ── Auxiliares de lectura ────────────────────────────────────

  private async contextoOpcional(): Promise<{ contexto: ContextoEmision | null; fallo: string | null }> {
    try {
      return { contexto: await this.emision.contexto(), fallo: null };
    } catch (error) {
      return { contexto: null, fallo: this.mensajeDe(error) };
    }
  }

  private serieDeTipo(series: SeriesEmision, idTipo: number): string {
    return idTipo === TIPO_FACTURA ? series.factura : series.boleta;
  }

  /** Serie configurada para producción: solo para la vista previa cuando no hay contexto de emisión. */
  private async serieConfigurada(idTipo: number): Promise<string> {
    const clave = idTipo === TIPO_FACTURA ? CLAVES_SERIES_FISCALES.factura : CLAVES_SERIES_FISCALES.boleta;
    const defecto = idTipo === TIPO_FACTURA ? SERIES_FISCALES_POR_DEFECTO.factura : SERIES_FISCALES_POR_DEFECTO.boleta;
    return (await this.config.obtenerTexto(clave, defecto)).trim().toUpperCase() || defecto;
  }

  private async envioDe(c: Comprobante): Promise<EnvioVista | null> {
    if (c.proveedor_fiscal !== 'sunat_directo' || !c.id_envio_ultimo) return null;
    const idEnvio = c.id_envio_ultimo;
    return this.opcional(() => this.emision.obtenerEnvio(idEnvio), `envío ${idEnvio}`, null);
  }

  /** Para piezas accesorias del detalle: si fallan, el detalle igual se muestra (queda en el log). */
  private async opcional<T>(leer: () => Promise<T>, que: string, respaldo: T): Promise<T> {
    try {
      return await leer();
    } catch (error) {
      this.logger.warn(`No se pudo leer ${que}: ${this.mensajeDe(error)}`);
      return respaldo;
    }
  }

  private envioLibre(envio: EnvioVista): boolean {
    if (!envio.bloqueado_hasta) return true;
    const hasta = new Date(envio.bloqueado_hasta).getTime();
    return !Number.isFinite(hasta) || hasta < Date.now();
  }

  /** Emisor real del documento: el con que se firmó (envío guardado), el del ambiente vigente o el configurado. */
  private async emisorDelDocumento(
    c: Comprobante,
    fiscal: DatosFiscalesComprobante | null,
    configurado: EmisorConfigurado,
  ): Promise<ComprobanteDetalleResponse['emisor']> {
    const guardado = this.emisorDeJson(fiscal?.emisor_envio ?? null);
    if (guardado) return this.vistaEmisor(guardado, configurado);
    if (c.proveedor_fiscal === 'sunat_directo') {
      const { contexto } = await this.contextoOpcional();
      if (contexto && contexto.ambiente === c.ambiente_fiscal) return this.vistaEmisor(contexto.emisor, configurado);
    }
    return configurado;
  }

  private emisorDeJson(json: Record<string, unknown> | null): EmisorDocumento | null {
    if (!json || typeof json.ruc !== 'string' || !json.ruc.trim()) return null;
    const texto = (valor: unknown): string | null => (typeof valor === 'string' && valor.trim() ? valor : null);
    return {
      ruc: json.ruc,
      razonSocial: texto(json.razonSocial) ?? '',
      nombreComercial: texto(json.nombreComercial),
      direccion: texto(json.direccion) ?? '',
      distrito: texto(json.distrito),
      provincia: texto(json.provincia),
      departamento: texto(json.departamento),
    };
  }

  private vistaEmisor(emisor: EmisorDocumento, configurado: EmisorConfigurado): EmisorConfigurado {
    const ubicacion = [emisor.distrito, emisor.provincia, emisor.departamento].filter(Boolean).join(' - ');
    return {
      ruc: emisor.ruc,
      razon_social: emisor.razonSocial,
      nombre_comercial: emisor.nombreComercial ?? null,
      direccion: emisor.direccion,
      ubicacion: ubicacion || (emisor.ruc === configurado.ruc ? configurado.ubicacion : ''),
      logo_url: configurado.logo_url,
      telefono: configurado.telefono,
      email: configurado.email,
    };
  }

  private async emisorConfigurado(): Promise<EmisorConfigurado> {
    const valores = await this.config.obtenerVarias([
      'emisor_ruc',
      'emisor_razon_social',
      'emisor_nombre_comercial',
      'emisor_direccion',
      'emisor_ubicacion',
      'emisor_logo_url',
      'emisor_telefono',
      'emisor_email',
    ]);

    return {
      ruc: valores.emisor_ruc ?? emisorConfig.ruc,
      razon_social: valores.emisor_razon_social ?? emisorConfig.razon_social,
      nombre_comercial: valores.emisor_nombre_comercial ?? null,
      direccion: valores.emisor_direccion ?? emisorConfig.direccion,
      ubicacion: valores.emisor_ubicacion ?? emisorConfig.ubicacion,
      logo_url: valores.emisor_logo_url ?? emisorConfig.logo_url,
      telefono: valores.emisor_telefono ?? (emisorConfig.telefono || null),
      email: valores.emisor_email ?? (emisorConfig.email || null),
    };
  }

  private referenciaDe(idTipo: number | undefined, fiscal: DatosFiscalesComprobante | null): ComprobanteDetalleResponse['referencia'] {
    if (!fiscal?.doc_modificado_serie || !fiscal.doc_modificado_numero) return null;
    const motivo = fiscal.nota_motivo;
    const descripcion = !motivo
      ? null
      : idTipo === TIPO_NOTA_CREDITO
        ? ETIQUETA_MOTIVO_NOTA_CREDITO[motivo as keyof typeof ETIQUETA_MOTIVO_NOTA_CREDITO] ?? null
        : etiquetaMotivoNotaDebito(motivo, fechaLima());
    return {
      id_comprobante: fiscal.id_comprobante_modificado,
      tipo: fiscal.doc_modificado_tipo ?? '',
      serie: fiscal.doc_modificado_serie,
      numero: fiscal.doc_modificado_numero,
      numero_formateado: this.formatearNumero(fiscal.doc_modificado_serie, fiscal.doc_modificado_numero),
      motivo,
      motivo_descripcion: descripcion,
      sustento: fiscal.nota_sustento,
    };
  }

  private cuotasDe(valor: unknown): ComprobanteDetalleResponse['cuotas'] {
    if (!Array.isArray(valor)) return [];
    return valor
      .map((cuota, indice) => {
        const c = (cuota ?? {}) as Record<string, unknown>;
        return {
          numero: Number(c.numero ?? indice + 1),
          monto: Number(c.monto ?? 0),
          fecha_pago: String(c.fechaPago ?? c.fecha_pago ?? ''),
        };
      })
      .filter((c) => Number.isFinite(c.monto) && c.monto > 0 && !!c.fecha_pago);
  }

  /**
   * Qué se puede hacer con el comprobante. Son indicaciones para la pantalla: cada acción la
   * vuelve a validar la emisión (p. ej. el reintento solo reclama envíos realmente libres) o el negocio
   * de notas (saldo y notas en curso). Sin `resumen` de notas (no se pudo leer) rige la regla básica.
   */
  private acciones(
    c: Comprobante,
    datos: { accion: string | null; envioLibre: boolean | null; fechaLimite: string | null },
    modo: ModoEmision,
    hoy: string,
    resumen: ResumenNotasOrigen | null = null,
  ): AccionesComprobante {
    const idTipo = c.tipo?.id_tipo;
    const tipo = tipoComprobanteSunat(idTipo);
    const estadoSunat = c.estado_sunat ?? '';
    const directo = c.proveedor_fiscal === 'sunat_directo' && !!c.id_envio_ultimo && !c.anulado;
    const aceptado = Boolean(c.aceptada_sunat) && ESTADOS_ACEPTADO.has(estadoSunat);
    const incierto = estadoSunat === 'ENVIANDO' && datos.envioLibre !== false;
    const pendienteReenvio = estadoSunat === 'PENDIENTE_REENVIO';
    const recuperar = datos.accion === 'RECUPERAR_CDR';
    const consultaCdr = c.ambiente_fiscal === 'produccion' && !!tipo && admiteGetStatusCdr(tipo, c.serie);
    const vencido =
      !c.anulado && !aceptado && !!datos.fechaLimite && datos.fechaLimite < hoy && ESTADOS_EN_CURSO.has(estadoSunat);
    // D8: origen que admite nota de crédito; si además le queda saldo, anularlo exige emitir una.
    const admiteNota =
      !c.anulado
      && esComprobantePrincipal(idTipo)
      && c.proveedor_fiscal === 'sunat_directo'
      && aceptado
      && c.ambiente_fiscal === modo.ambiente;
    const conSaldo = resumen === null || resumen.saldo > 0;
    const notaEnCurso = resumen?.nota_en_curso === true;

    return {
      puede_reintentar: directo && !aceptado && !vencido && ((pendienteReenvio && !recuperar) || incierto),
      puede_recuperar_cdr: directo && !aceptado && consultaCdr && (pendienteReenvio || incierto || recuperar),
      puede_confirmar_manual: directo && !aceptado && recuperar,
      // Se emite en el acto: hace falta la emisión activa, saldo por acreditar y ninguna otra nota en envío.
      puede_nota_credito: admiteNota && modo.activo && conSaldo && !notaEnCurso,
      // D9: también sin venta (nota de crédito o anulación en el sistema), salvo con una nota en envío (el saldo
      // puede cambiar) o si hace falta una nota de crédito y la emisión no está activa.
      puede_anular: !c.anulado && esComprobantePrincipal(idTipo) && !notaEnCurso && !(admiteNota && conSaldo && !modo.activo),
      vencido,
    };
  }

  /** Saldo y notas en curso por comprobante; si no se pueden leer, las acciones usan la regla básica. */
  private async resumenesNotas(ids: number[]): Promise<Map<number, ResumenNotasOrigen>> {
    const gestor = this.gestorNotas;
    if (!gestor || !ids.length) return new Map();
    return this.opcional(() => gestor.resumenes(ids), 'el saldo de notas de crédito', new Map<number, ResumenNotasOrigen>());
  }

  private validarFiltro(filtro: FiltroComprobantes): void {
    if (filtro.estado_sunat && !PATRON_ESTADO_SUNAT.test(filtro.estado_sunat)) {
      throw new BadRequestException('El estado SUNAT del filtro no es válido.');
    }
    if (filtro.ambiente && filtro.ambiente !== 'beta' && filtro.ambiente !== 'produccion') {
      throw new BadRequestException('El ambiente del filtro debe ser beta o produccion.');
    }
    for (const [campo, valor] of [['desde', filtro.desde], ['hasta', filtro.hasta]] as const) {
      if (valor && !esFechaYmd(valor)) {
        throw new BadRequestException(`La fecha "${campo}" debe tener el formato AAAA-MM-DD y existir en el calendario.`);
      }
    }
  }

  // ── Representación impresa ───────────────────────────────────

  private async datosPdf(detalle: ComprobanteDetalleResponse): Promise<DatosPdfComprobante> {
    const logo = await obtenerLogoEmisor(detalle.emisor.logo_url);
    const porcentaje = Number(detalle.porcentaje_igv);
    const letras = detalle.importe_en_letras ?? '';
    return {
      emisor: {
        ruc: detalle.emisor.ruc,
        razonSocial: detalle.emisor.razon_social,
        nombreComercial: detalle.emisor.nombre_comercial ?? null,
        direccion: detalle.emisor.direccion,
        ubicacion: detalle.emisor.ubicacion || null,
        telefono: detalle.emisor.telefono ?? null,
        email: detalle.emisor.email ?? null,
        logo,
      },
      tipo: tipoComprobanteSunat(detalle.id_tipo) ?? '03',
      serie: detalle.serie,
      numero: detalle.numero,
      fechaEmision: this.fechaImpresa(detalle.fecha_de_emision),
      horaEmision: detalle.hora_emision,
      fechaVencimiento: detalle.forma_pago === 'Credito' ? this.fechaImpresa(detalle.fecha_de_vencimiento) : null,
      moneda: detalle.moneda.id_moneda === 2 ? 'USD' : 'PEN',
      cliente: {
        tipoDoc: String(detalle.receptor.tipo_documento ?? '0'),
        numDoc: detalle.receptor.numero_documento ?? '',
        nombre: detalle.receptor.denominacion ?? '',
        direccion: detalle.receptor.direccion || null,
      },
      referencia: detalle.referencia
        ? {
            tipoDoc: detalle.referencia.tipo,
            serie: detalle.referencia.serie,
            numero: detalle.referencia.numero,
            motivo: detalle.referencia.motivo ?? '',
            motivoDescripcion: detalle.referencia.motivo_descripcion,
            sustento: detalle.referencia.sustento ?? '',
          }
        : null,
      items: detalle.items.map((item) => {
        // Mismos valores unitarios que declaró el XML (valor sin IGV antes del descuento, precio final con IGV).
        const linea = construirLineaCpe(
          {
            cantidad: item.cantidad,
            precioUnitario: item.precio_unitario,
            subtotal: item.subtotal,
            igv: item.igv,
            total: item.total,
            afectacion: this.afectacionCpe(item.tipo_de_igv ?? 1),
            descuento: item.descuento,
          },
          { unidad: item.unidad_de_medida, descripcion: item.descripcion },
          porcentaje,
        );
        return {
          codigo: item.codigo ?? null,
          unidad: item.unidad_de_medida || 'NIU',
          descripcion: item.descripcion ?? '',
          cantidad: item.cantidad,
          valorUnitario: linea.valorUnitario,
          precioUnitario: linea.precioVentaUnitario,
          descuento: item.descuento,
          importe: item.total,
        };
      }),
      totales: {
        gravada: detalle.totales.gravada,
        exonerada: detalle.totales.exonerada,
        inafecta: detalle.totales.inafecta,
        descuentos: detalle.totales.descuento,
        igv: detalle.totales.igv,
        porcentajeIgv: porcentaje,
        total: detalle.totales.total,
      },
      importeEnLetras: /^SON\b/i.test(letras) ? letras : `SON: ${letras}`,
      formaPago: detalle.forma_pago
        ? {
            tipo: detalle.forma_pago,
            cuotas: detalle.cuotas.map((cuota) => ({
              numero: cuota.numero,
              monto: cuota.monto,
              fechaPago: this.fechaImpresa(cuota.fecha_pago),
            })),
          }
        : null,
      observaciones: detalle.observaciones || null,
      medioPago: null,
      cadenaQr: detalle.cadena_qr,
      codigoHash: detalle.codigo_hash,
      ambiente:
        detalle.proveedor_fiscal === 'sunat_directo' && (detalle.ambiente_fiscal === 'beta' || detalle.ambiente_fiscal === 'produccion')
          ? detalle.ambiente_fiscal
          : null,
      avisoEstado: this.avisoEstadoImpreso(detalle),
    };
  }

  private avisoEstadoImpreso(detalle: ComprobanteDetalleResponse): string | null {
    if (detalle.anulado) return 'COMPROBANTE ANULADO';
    if (detalle.aceptada_sunat) return null;
    if (detalle.proveedor_fiscal !== 'sunat_directo') return 'COMPROBANTE NO CONFIRMADO POR SUNAT';
    if (detalle.estado_sunat === 'RECHAZADO') return 'RECHAZADO POR SUNAT - SIN VALIDEZ';
    if (ESTADOS_EN_CURSO.has(detalle.estado_sunat ?? '')) return 'PENDIENTE DE CONFIRMACIÓN DE SUNAT';
    return 'NO ACEPTADO POR SUNAT';
  }

  // ── Auxiliares ───────────────────────────────────────────────

  /** Afectación del catálogo 07 desde el tipo de IGV del sistema (ya normalizado por calculo-fiscal: 1, 8 o 9). */
  private afectacionCpe(tipoIgv: number): AfectacionCpe {
    if (tipoIgv === 8) return '20';
    if (tipoIgv === 9) return '30';
    return '10';
  }

  private fechaLimite(tipo: TipoCpe, serie: string, fechaEmisionIso: string): string | null {
    try {
      return fechaLimiteEnvioIndividual(tipo, serie, fechaEmisionIso);
    } catch (error) {
      this.logger.warn(`No se pudo calcular el plazo de envío de ${serie}: ${this.mensajeDe(error)}`);
      return null;
    }
  }

  private nombreAmbiente(ambiente: string | null | undefined): string {
    if (ambiente === 'beta') return 'SUNAT BETA (pruebas)';
    if (ambiente === 'produccion') return 'PRODUCCIÓN';
    return 'otro ambiente';
  }

  private idPositivo(valor: unknown): number | null {
    const numero = Number(valor);
    return Number.isInteger(numero) && numero > 0 ? numero : null;
  }

  private monto(valor: number): string {
    return `S/ ${redondear(Number(valor) || 0).toFixed(2)}`;
  }

  private mensajeDe(error: unknown): string {
    const e = error as { response?: { message?: unknown }; message?: unknown };
    const desdeRespuesta = e?.response?.message;
    if (Array.isArray(desdeRespuesta)) return desdeRespuesta.map(String).join(' | ');
    if (typeof desdeRespuesta === 'string' && desdeRespuesta.trim()) return desdeRespuesta;
    return typeof e?.message === 'string' && e.message.trim() ? e.message : 'error desconocido';
  }

  private formatearNumero(serie: string, numero: number): string {
    return `${serie}-${String(numero).padStart(8, '0')}`;
  }

  private limpiarTexto(texto: string): string {
    return (texto ?? '')
      .toString()
      .replace(/"/g, "''")
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /** yyyy-mm-dd → dd-mm-yyyy (formato en que se guardan las fechas del comprobante). */
  private fechaGuardada(fechaIso: string): string {
    const [anio, mes, dia] = fechaIso.split('-');
    return `${dia}-${mes}-${anio}`;
  }

  private fechaIso(fecha: string): string {
    const iso = this.fechaIsoOpcional(fecha);
    if (!iso) throw new BadRequestException('La fecha del comprobante no tiene un formato válido para SUNAT.');
    return iso;
  }

  private fechaIsoOpcional(fecha: string | null | undefined): string | null {
    const texto = String(fecha ?? '').trim();
    const partes = texto.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (partes) return `${partes[3]}-${partes[2]}-${partes[1]}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) return texto;
    return null;
  }

  /** dd/mm/yyyy para la representación impresa. */
  private fechaImpresa(fecha: string | null | undefined): string {
    const iso = this.fechaIsoOpcional(fecha);
    if (!iso) return String(fecha ?? '');
    const [anio, mes, dia] = iso.split('-');
    return `${dia}/${mes}/${anio}`;
  }

  private normalizarFecha(fecha: string, respaldo: string): string {
    const texto = (fecha ?? '').trim();
    if (/^\d{2}-\d{2}-\d{4}$/.test(texto)) return texto;
    if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) return this.fechaGuardada(texto);
    return respaldo;
  }

  private estadoVisible(c: Comprobante): string {
    if (c.anulado) return 'anulado';
    if (c.estado === 'error' || c.estado === 'pendiente') return c.estado;
    return c.aceptada_sunat ? 'aceptado' : 'emitido';
  }

  // ── Mappers ──────────────────────────────────────────────────

  private mapComprobante(c: Comprobante): ComprobanteResponse {
    return {
      id_comprobante: c.id_comprobante,
      tipo_de_comprobante: c.tipo?.id_tipo,
      serie: c.serie,
      numero: c.numero,
      numero_formateado: this.formatearNumero(c.serie, c.numero),
      enlace: c.enlace,
      enlace_pdf: c.enlace_pdf,
      enlace_xml: c.enlace_xml,
      enlace_cdr: c.enlace_cdr,
      aceptada_sunat: c.aceptada_sunat,
      sunat_description: c.sunat_description,
      sunat_responsecode: c.sunat_responsecode,
      sunat_observaciones: Array.isArray(c.sunat_observaciones) ? c.sunat_observaciones : undefined,
      cadena_qr: c.cadena_qr,
      codigo_hash: c.codigo_hash,
      anulado: c.anulado,
      estado: this.estadoVisible(c),
      error: c.estado === 'error' ? c.error_mensaje || c.sunat_description || undefined : undefined,
      proveedor_fiscal: c.proveedor_fiscal ?? undefined,
      ambiente_fiscal: c.ambiente_fiscal ?? undefined,
      estado_sunat: c.estado_sunat ?? undefined,
      id_envio_ultimo: c.id_envio_ultimo ?? undefined,
      id_venta: c.id_venta ?? null,
      aviso: c.proveedor_fiscal === 'sunat_directo' && c.ambiente_fiscal === 'beta' ? AVISO_BETA : null,
    };
  }

  private mapListado(
    c: Comprobante,
    extra: DatosListadoComprobante | null,
    modo: ModoEmision,
    hoy: string,
    resumen: ResumenNotasOrigen | null,
  ): ComprobanteListadoResponse {
    const idMoneda = Number(c.moneda?.id_moneda ?? 1);
    const acciones = this.acciones(
      c,
      { accion: extra?.envio_accion ?? null, envioLibre: extra?.envio_libre ?? null, fechaLimite: extra?.fecha_limite_envio ?? null },
      modo,
      hoy,
      resumen,
    );
    return {
      id_comprobante: c.id_comprobante,
      id_tipo: c.tipo?.id_tipo,
      tipo_nombre: nombreTipoComprobante(c.tipo?.id_tipo),
      serie: c.serie,
      numero: c.numero,
      numero_formateado: this.formatearNumero(c.serie, c.numero),
      fecha_de_emision: c.fecha_de_emision,
      creado_en: c.creado_en,
      cliente_numero_doc: c.cliente_numero_doc,
      cliente_denominacion: c.cliente_denominacion,
      moneda_simbolo: (MONEDAS[idMoneda] ?? MONEDAS[1]).simbolo,
      total: Number(c.total ?? 0),
      estado: this.estadoVisible(c),
      aceptada_sunat: Boolean(c.aceptada_sunat),
      anulado: Boolean(c.anulado),
      sunat_description: c.sunat_description,
      error_mensaje: c.error_mensaje,
      enlace: c.enlace,
      enlace_pdf: c.enlace_pdf,
      proveedor_fiscal: c.proveedor_fiscal,
      ambiente_fiscal: c.ambiente_fiscal,
      estado_sunat: c.estado_sunat,
      id_envio_ultimo: c.id_envio_ultimo,
      accion_sunat: extra?.envio_accion ?? null,
      id_venta: c.id_venta ?? null,
      id_comprobante_modificado: extra?.id_comprobante_modificado ?? null,
      doc_modificado:
        extra?.doc_modificado_serie && extra.doc_modificado_numero
          ? `${extra.doc_modificado_serie}-${extra.doc_modificado_numero}`
          : null,
      fecha_limite_envio: extra?.fecha_limite_envio ?? null,
      vencido: acciones.vencido,
      puede_reintentar: acciones.puede_reintentar,
      puede_recuperar_cdr: acciones.puede_recuperar_cdr,
      puede_confirmar_manual: acciones.puede_confirmar_manual,
      puede_nota_credito: acciones.puede_nota_credito,
      puede_anular: acciones.puede_anular,
    };
  }
}
