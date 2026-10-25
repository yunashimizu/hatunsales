import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { MAXIMO_RESULTADOS_UBIGEO, MINIMO_CARACTERES_BUSQUEDA_UBIGEO, UbigeoService } from '../../catalogos/ubigeo/ubigeo.service';
import { emisorConfig } from '../../config/emisor.config';
import {
  AnularGuiaRemisionRequest,
  ESTADOS_GUIA,
  EstadoGuia,
  GuardarGuiaRemisionRequest,
  ItemGuiaRequest,
  ListarGuiasRemisionRequest,
  MODALIDADES_GUIA,
  MOTIVOS_GUIA_HABILITADOS,
  TIPOS_DOCUMENTO_CONDUCTOR,
  TIPOS_DOCUMENTO_GUIA,
  UNIDADES_PESO_GUIA,
} from '../../models/model/guia-remision.request';
import {
  AccionesGuiaResponse,
  CatalogosGuiaResponse,
  ContextoVentaGuiaResponse,
  DestinatarioGuiaResponse,
  DocumentoRelacionadoGuiaResponse,
  GuiaRemisionResponse,
  GuiaRemisionResumenResponse,
  ListadoGuiasRemisionResponse,
  ObservacionGuiaResponse,
  OperacionGuiaResponse,
  PuntoGuiaResponse,
  TipoArchivoGuia,
  ValidacionGuiaResponse,
} from '../../models/model/guia-remision.response';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import {
  ArchivoGuia,
  CierreConsultaGuia,
  CierreEnvioGuia,
  ComprobanteRelacionadoGuia,
  DatosGuardarGuia,
  EnvioGuia,
  EnvioGuiaEnCursoError,
  EnvioParaConsulta,
  EnvioParaReenvio,
  FilaGuia,
  FilaItemGuia,
  GuiaRemisionRepository,
  ItemGuardarGuia,
  NumeroGuiaOcupadoError,
  ProductoVendidoGuia,
  VentaGuia,
} from '../../repository/Repository/guia-remision.repository';
import type { EjecutorSql } from '../../sunat/config/transacciones-fiscales';
import { normalizarUnidad, UNIDADES_CATALOGO_03 } from '../../sunat/catalogos/sunat.catalogos';
import { FiscalConfigService } from '../../sunat/config/fiscal-config.service';
import { aHttp } from '../../sunat/config/fiscal-errores';
import { RelojFiscal } from '../../sunat/config/reloj-fiscal';
import {
  CATALOGO_18_MODALIDAD_TRASLADO,
  CATALOGO_20_MOTIVOS_TRASLADO,
  CATALOGO_61_DOCUMENTOS_RELACIONADOS,
  EmisionGre,
  GreInvalidaError,
  normalizarPlacaGre,
  redactarSecretosGre,
  UNIDADES_PESO_GRE,
} from '../../sunat/gre';
import type {
  DireccionGre,
  DocumentoGre,
  GrePreparada,
  ModalidadTransporteGre,
  ModoEmisionGre,
  ObservacionCampoGre,
  ResultadoConsultaGre,
  ResultadoEnvioGre,
  ResultadoValidacionGre,
} from '../../sunat/gre';
import type { EmisorCpe } from '../../sunat/nucleo/documento-fiscal.types';
import { esFechaIso, fechaLima, horaLima } from '../../sunat/nucleo/fechas-fiscales';
import { generarGuiaRemisionPdf, DatosGuiaRemisionPdf } from '../../util/documentos/guia-remision-pdf';
import { obtenerLogoEmisor } from '../../util/documentos/logo-emisor';
import { TIPO_BOLETA, TIPO_FACTURA } from '../../util/fiscal/tipos-comprobante';
import { IGuiaRemisionBussniees } from '../Ibussnies/IGuiaRemisionBussniees';

export const ESTADO_GUIA_TEXTO: Readonly<Record<EstadoGuia, string>> = {
  legacy: 'Histórica (solo lectura)',
  borrador: 'Borrador',
  pendiente: 'Pendiente de envío',
  enviado: 'Enviada a SUNAT',
  aceptado: 'Aceptada',
  rechazado: 'Rechazada',
  anulado: 'Anulada',
};

const DESCRIPCION_MOTIVO: Readonly<Record<string, string>> = {
  '01': 'Entrega al comprador de lo vendido: la guía sale desde una venta.',
  '04': 'Mercadería que va a otro local de la empresa: el destinatario es la propia empresa.',
  '13': 'Cualquier otro traslado (reparación, préstamo…): describa el motivo.',
};

const DESCRIPCION_MODALIDAD: Readonly<Record<string, string>> = {
  '01': 'Lo traslada una empresa de transporte con RUC.',
  '02': 'Con vehículo y conductor propios.',
};

const NOMBRE_TIPO_DOCUMENTO: Readonly<Record<string, string>> = {
  '1': 'DNI',
  '4': 'Carné de extranjería',
  '6': 'RUC',
  '7': 'Pasaporte',
};

/** Espera entre consultas automáticas del ticket: 30 s, 1, 2 y 5 min, y luego cada 15 min. */
export const ESPERAS_CONSULTA_SEG: readonly number[] = [30, 60, 120, 300, 900];
/** Tope de consultas automáticas: después la consulta queda manual (con aviso en la guía). */
export const MAXIMO_CONSULTAS_AUTOMATICAS = 12;
/** «Directo a SUNAT»: con el ticket recibido, una consulta a los 2,5 s (SUNAT suele procesar la guía en segundos). */
export const ESPERA_CONSULTA_INMEDIATA_MS = 2_500;
/** Tope de esa consulta: con la espera, emitir no queda bloqueado más de ~8 s por ella. */
export const PLAZO_CONSULTA_INMEDIATA_MS = 5_500;
export const MENSAJE_GUIA_EN_PROCESO = 'SUNAT está procesando la guía; se consultará automáticamente.';
/** Sin tareas programadas nadie consultará solo: se pide hacerlo a mano. */
export const MENSAJE_GUIA_EN_PROCESO_MANUAL = 'SUNAT está procesando la guía: use «Consultar» en unos minutos para obtener la respuesta.';
/** Reintentos de la reserva de número cuando otra guía se adelantó (D2/D11). */
const MAXIMO_INTENTOS_NUMERO = 5;
/** Reintentos de guardar lo que SUNAT ya respondió si la BD falla (D5.3). */
const REINTENTOS_GUARDADO = 3;
/** «Ya registrada» en SUNAT: el número sí quedó tomado; hay que revisar en SOL antes de reenviar. */
const CODIGOS_YA_REGISTRADA = new Set(['1032', '1033']);

const MENSAJE_ARCHIVO: Readonly<Record<TipoArchivoGuia, string>> = {
  xml_firmado: 'La guía aún no tiene XML: se genera al emitirla.',
  zip: 'La guía aún no tiene el ZIP de envío: se genera al emitirla.',
  cdr_xml: 'SUNAT todavía no entregó la constancia (CDR) de esta guía.',
  cdr_zip: 'SUNAT todavía no entregó la constancia (CDR) de esta guía.',
};

/** Rutas del DocumentoGre (motor) → campos del formulario (cuerpo de POST/PUT), para marcar el error junto al campo. */
const CAMPOS_FORMULARIO: ReadonlyArray<readonly [RegExp, string]> = [
  [/^envio\.motivo$/, 'motivo_traslado'],
  [/^envio\.descripcionMotivo$/, 'descripcion_motivo'],
  [/^envio\.modalidad$/, 'modalidad_traslado'],
  [/^envio\.fechaInicioTraslado$/, 'fecha_inicio_traslado'],
  [/^envio\.fechaEntregaTransportista$/, 'fecha_entrega_transportista'],
  [/^envio\.pesoBrutoTotal$/, 'peso_bruto_total'],
  [/^envio\.unidadPeso$/, 'unidad_peso'],
  [/^envio\.numeroBultos$/, 'numero_bultos'],
  [/^envio\.(partida|llegada)\.codigoEstablecimiento$/, '$1.codigo_establecimiento'],
  [/^envio\.(partida|llegada)((?:\.ubigeo|\.direccion)?)$/, '$1$2'],
  [/^destinatario\.tipoDoc$/, 'destinatario.tipo_documento'],
  [/^destinatario\.numDoc$/, 'destinatario.numero_documento'],
  [/^destinatario\.nombre$/, 'destinatario.denominacion'],
  [/^transportista\.(?:tipoDoc|numDoc)$/, 'transportista.ruc'],
  [/^transportista\.razonSocial$/, 'transportista.razon_social'],
  [/^transportista\.registroMtc$/, 'transportista.registro_mtc'],
  [/^vehiculo\.tarjetaCirculacion$/, 'vehiculo.tarjeta_circulacion'],
  [/^conductores\[0\]\.tipoDoc$/, 'conductor.tipo_documento'],
  [/^conductores\[0\]\.numDoc$/, 'conductor.numero_documento'],
  [/^conductores\[0\]\.(nombres|apellidos|licencia)$/, 'conductor.$1'],
  [/^conductores.*$/, 'conductor'],
  [/^items\[(\d+)\]\.(cantidad|unidad|descripcion)$/, 'items[$1].$2'],
  [/^items\[(\d+)\].*$/, 'items[$1]'],
  [/^documentosRelacionados.*$/, 'documento_relacionado'],
  [/^remitente.*$/, 'emisor'],
  [/^(?:tipo|serie|numero|fechaEmision|horaEmision)$/, 'emision'],
];

export function campoFormularioGuia(campo: string): string {
  for (const [patron, reemplazo] of CAMPOS_FORMULARIO) {
    if (patron.test(campo)) return campo.replace(patron, reemplazo);
  }
  return campo;
}

function estadoDe(valor: string): EstadoGuia {
  return (ESTADOS_GUIA as readonly string[]).includes(valor) ? (valor as EstadoGuia) : 'legacy';
}

function numeroFormateado(serie: string | null, numero: number | null): string | null {
  return serie && numero ? `${serie}-${String(numero).padStart(8, '0')}` : null;
}

/** Cantidades en milésimas (la guía admite 3 decimales): sumas y comparaciones exactas, sin coma flotante. */
function milesimas(cantidad: number): number {
  return Math.round(Number(cantidad) * 1000);
}

function cantidadTexto(enMilesimas: number): string {
  return String(Number((enMilesimas / 1000).toFixed(3)));
}

function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(contenido: Buffer): string {
  return createHash('sha256').update(contenido).digest('hex');
}

function esUnicaIdempotencia(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string; driverError?: { code?: string; constraint?: string } };
  return (e?.driverError?.code ?? e?.code) === '23505'
    && (e?.driverError?.constraint ?? e?.constraint) === 'uq_guias_remision_idempotencia';
}

function pausa(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, ms));
}

/** El valor de `promesa`, o null si no llega en `ms` (la promesa sigue su curso: no se puede cancelar). */
async function conPlazo<T>(promesa: Promise<T>, ms: number): Promise<T | null> {
  let temporizador: NodeJS.Timeout | undefined;
  const vencido = new Promise<null>((resolver) => {
    temporizador = setTimeout(() => resolver(null), ms);
  });
  try {
    return await Promise.race([promesa, vencido]);
  } finally {
    clearTimeout(temporizador);
  }
}

/** El mismo error HTTP (estado, mensaje y código) con el id de la guía que quedó guardada como borrador. */
function conGuiaGuardada(error: unknown, idGuia: number): unknown {
  const http = aHttp(error);
  if (!(http instanceof HttpException)) return error;
  const respuesta = http.getResponse();
  const cuerpo = typeof respuesta === 'object' && respuesta !== null ? respuesta : { message: respuesta };
  return new HttpException({ ...cuerpo, id_guia: idGuia }, http.getStatus(), { cause: error });
}

interface ContextoDocumento {
  emisor: EmisorCpe;
  serie: string;
  numero: number;
  fecha: string;
  hora: string;
  relacionado: ComprobanteRelacionadoGuia | null;
}

/** Lo que un borrador toma de la configuración antes de abrir la transacción. */
interface DefectosGuardado {
  /** Con el motivo 04 el destinatario es el propio emisor. */
  emisor: EmisorCpe | null;
  /** Punto de partida configurado (solo si el formulario no trajo la partida). */
  partida: DireccionGre | null;
}

/**
 * Negocio de la Guía de Remisión Electrónica remitente (PLAN V3, D10 y D11): borradores desde una venta
 * (con tope por producto) o sin venta (motivos 04 y 13), validación sin enviar, emisión con numeración
 * propia y consulta del ticket. El motor (EmisionGre) valida, arma, firma y habla con SUNAT; aquí se
 * reserva el número, se guarda TODO antes de enviar y se persiste cada resultado. «Directo a SUNAT»: emitir
 * envía en el acto y, con el ticket, consulta una vez enseguida para responder ya aceptada o rechazada.
 *
 * Candados (siempre en este orden, todos de transacción): 'gre-venta:<id_venta>' → fila de la guía
 * (FOR UPDATE) → 'gre:<serie>'. Una guía rechazada conserva su número y se reenvía con el mismo.
 */
@Injectable()
export class GuiaRemisionBussnies implements IGuiaRemisionBussniees {
  private readonly log = new Logger(GuiaRemisionBussnies.name);

  constructor(
    private readonly repo: GuiaRemisionRepository,
    private readonly config: ConfiguracionRepository,
    private readonly emisionGre: EmisionGre,
    private readonly fiscal: FiscalConfigService,
    private readonly reloj: RelojFiscal,
    private readonly ubigeos: UbigeoService,
  ) {}

  // ── Lectura ────────────────────────────────────────────────────────────────

  async listar(filtro: ListarGuiasRemisionRequest): Promise<ListadoGuiasRemisionResponse> {
    for (const [campo, valor] of [['desde', filtro.desde], ['hasta', filtro.hasta]] as const) {
      if (valor && !esFechaIso(valor)) {
        throw new BadRequestException({ message: `La fecha «${campo}» (${valor}) no existe en el calendario.`, codigo: 'VALIDACION' });
      }
    }
    if (filtro.desde && filtro.hasta && filtro.desde > filtro.hasta) {
      throw new BadRequestException({ message: 'La fecha «desde» no puede ser posterior a «hasta».', codigo: 'VALIDACION' });
    }
    const pagina = filtro.pagina ?? 1;
    const porPagina = Math.min(100, filtro.por_pagina ?? 20);
    const { filas, total } = await this.repo.listar({
      texto: filtro.texto,
      estado: filtro.estado,
      desde: filtro.desde,
      hasta: filtro.hasta,
      id_venta: filtro.id_venta,
      pagina,
      por_pagina: porPagina,
    });
    return { datos: filas.map((f) => this.resumen(f)), total, pagina, por_pagina: porPagina };
  }

  async obtener(idGuia: number): Promise<GuiaRemisionResponse> {
    const fila = await this.filaOError(idGuia);
    return this.detalle(fila, await this.repo.items(idGuia));
  }

  /** ¿Se puede emitir GRE ahora? (producción, GRE activada, credenciales API y SOL, certificado). Nunca lanza. */
  modo(): Promise<ModoEmisionGre> {
    return this.emisionGre.modo();
  }

  catalogos(): CatalogosGuiaResponse {
    const opcion = (codigo: string, nombre: string) => ({ codigo, nombre });
    return {
      motivos: MOTIVOS_GUIA_HABILITADOS.map((codigo) => ({
        ...opcion(codigo, CATALOGO_20_MOTIVOS_TRASLADO[codigo]),
        descripcion: DESCRIPCION_MOTIVO[codigo],
        requiere_venta: codigo === '01',
        requiere_descripcion: codigo === '13',
        requiere_establecimiento: codigo === '04',
      })),
      modalidades: MODALIDADES_GUIA.map((codigo) => ({ ...opcion(codigo, CATALOGO_18_MODALIDAD_TRASLADO[codigo]), descripcion: DESCRIPCION_MODALIDAD[codigo] })),
      unidades_peso: UNIDADES_PESO_GUIA.map((codigo) => opcion(codigo, UNIDADES_PESO_GRE[codigo])),
      tipos_documento_destinatario: TIPOS_DOCUMENTO_GUIA.map((codigo) => opcion(codigo, NOMBRE_TIPO_DOCUMENTO[codigo])),
      tipos_documento_conductor: TIPOS_DOCUMENTO_CONDUCTOR.map((codigo) => opcion(codigo, NOMBRE_TIPO_DOCUMENTO[codigo])),
      unidades_medida: Object.entries(UNIDADES_CATALOGO_03).map(([codigo, nombre]) => opcion(codigo, nombre)),
      documentos_relacionados: ['01', '03'].map((codigo) => opcion(codigo, CATALOGO_61_DOCUMENTOS_RELACIONADOS[codigo])),
      estados: ESTADOS_GUIA.map((codigo) => opcion(codigo, ESTADO_GUIA_TEXTO[codigo])),
      ubigeo: { minimo_caracteres: MINIMO_CARACTERES_BUSQUEDA_UBIGEO, maximo_resultados: MAXIMO_RESULTADOS_UBIGEO },
      hoy: this.reloj.fechaLima(),
    };
  }

  /** Precarga de una guía de venta: destinatario, lo pendiente de cada producto, partida, llegada y comprobante. */
  async contextoVenta(idVenta: number): Promise<ContextoVentaGuiaResponse> {
    const venta = await this.repo.venta(idVenta);
    if (!venta) throw new NotFoundException({ message: `La venta ${idVenta} no existe.`, codigo: 'VENTA_NO_ENCONTRADA' });
    const [vendidos, comprobante, almacenes, guias, partida] = await Promise.all([
      this.repo.productosVendidos(idVenta, null),
      this.repo.comprobantePrincipal(idVenta),
      this.repo.almacenesDeSalida(idVenta),
      this.repo.guiasDeVenta(idVenta),
      this.partidaConfigurada(),
    ]);
    const avisos: string[] = [];
    if (partida.aviso) avisos.push(partida.aviso);
    const almacen = almacenes.length === 1 ? almacenes[0] : null;
    if (almacenes.length > 1) avisos.push(`La venta salió de ${almacenes.length} almacenes: revise el punto de partida.`);
    const relacionado = this.relacionadoVigente(comprobante, avisos);
    if (!comprobante) {
      avisos.push('La venta aún no tiene factura ni boleta: la guía saldrá sin documento relacionado (en una venta SUNAT recomienda relacionarlo).');
    }
    const destinatario = this.destinatarioDeVenta(venta);
    if (!destinatario.numero_documento) {
      avisos.push('La venta no tiene un cliente con DNI o RUC: indique el documento de quien recibe los bienes.');
    }

    const items = vendidos.map((v) => {
      const pendiente = Math.max(0, milesimas(v.cantidad_vendida) - milesimas(v.cantidad_en_guias));
      return {
        id_producto: v.id_producto,
        id_venta_detalle: v.id_venta_detalle,
        codigo: v.codigo,
        descripcion: v.nombre ?? 'Producto',
        unidad: normalizarUnidad(v.unidad_medida).codigo,
        cantidad_vendida: v.cantidad_vendida,
        cantidad_en_guias: v.cantidad_en_guias,
        cantidad_pendiente: pendiente / 1000,
      };
    });
    const motivoNoPermitido =
      venta.estado === 'anulada'
        ? `La venta ${idVenta} está anulada: no se le pueden emitir guías.`
        : !items.length
          ? 'La venta no tiene productos para trasladar.'
          : items.every((i) => i.cantidad_pendiente <= 0)
            ? 'Todo lo vendido ya está en guías vigentes (borradores o emitidas): anule una para volver a usar sus cantidades.'
            : null;

    return {
      venta: {
        id_venta: venta.id_venta,
        fecha: venta.fecha,
        total: venta.total,
        estado: venta.estado,
        id_cliente: venta.id_cliente,
        id_empresa: venta.id_empresa,
      },
      permitido: motivoNoPermitido === null,
      motivo_no_permitido: motivoNoPermitido,
      destinatario,
      documento_relacionado: this.relacionado(relacionado),
      partida: this.punto(
        partida.punto?.ubigeo || null,
        partida.punto?.direccion || almacen?.direccion || null,
        partida.punto?.codigoEstablecimiento || null,
      ),
      llegada: this.llegadaDeVenta(venta),
      almacen,
      items,
      guias: guias.map((g) => {
        const estado = estadoDe(g.estado);
        return { id_guia: g.id_guia, numero_formateado: numeroFormateado(g.serie, g.numero), estado, estado_texto: ESTADO_GUIA_TEXTO[estado] };
      }),
      avisos,
    };
  }

  // ── Borrador y edición ─────────────────────────────────────────────────────

  async crear(dto: GuardarGuiaRemisionRequest, idUsuario: number | null): Promise<GuiaRemisionResponse> {
    const idVenta = dto.id_venta ?? null;
    this.exigirMotivoSegunVenta(dto.motivo_traslado, idVenta);
    const clave = dto.clave_idempotencia ?? null;
    if (clave) {
      const existente = await this.repo.buscarPorClave(clave);
      if (existente) return this.obtener(existente);
    }
    const defectos = await this.defectosGuardado(dto);
    const avisos: string[] = [];
    let idGuia: number;
    try {
      idGuia = await this.repo.transaccion(async (tx) => {
        const datos = await this.datosGuardado(tx, dto, idVenta, null, defectos, avisos);
        return this.repo.insertar(tx, datos, { idVenta, idUsuario, clave });
      });
    } catch (error) {
      // Dos POST con la misma clave a la vez: el segundo choca con el índice único y devuelve la guía del primero.
      if (clave && esUnicaIdempotencia(error)) {
        const existente = await this.repo.buscarPorClave(clave);
        if (existente) return this.obtener(existente);
      }
      throw error;
    }
    const guia = await this.obtener(idGuia);
    return { ...guia, avisos: [...avisos, ...guia.avisos] };
  }

  /** PUT: reescribe un borrador o una guía rechazada (la rechazada conserva su número para reenviarla). */
  async actualizar(idGuia: number, dto: GuardarGuiaRemisionRequest): Promise<GuiaRemisionResponse> {
    const fila = await this.filaOError(idGuia);
    this.exigirEditable(fila);
    if (dto.id_venta !== undefined && dto.id_venta !== fila.id_venta) {
      throw new BadRequestException({
        message: 'La venta de una guía no se cambia: anule esta guía y cree otra desde la venta correcta.',
        codigo: 'GRE_VENTA_NO_EDITABLE',
      });
    }
    this.exigirMotivoSegunVenta(dto.motivo_traslado, fila.id_venta);
    const defectos = await this.defectosGuardado(dto);
    const avisos: string[] = [];
    await this.repo.transaccion(async (tx) => {
      if (fila.id_venta) await this.repo.bloquear(tx, `gre-venta:${fila.id_venta}`);
      const actual = await this.repo.obtener(idGuia, tx, true);
      if (!actual) throw this.noEncontrada(idGuia);
      this.exigirEditable(actual);
      const datos = await this.datosGuardado(tx, dto, fila.id_venta, idGuia, defectos, avisos);
      if (!(await this.repo.actualizar(tx, idGuia, datos))) {
        throw new ConflictException({ message: 'La guía cambió de estado mientras se guardaba: actualice la pantalla.', codigo: 'GRE_ESTADO_CAMBIO' });
      }
    });
    const guia = await this.obtener(idGuia);
    return { ...guia, avisos: [...avisos, ...guia.avisos] };
  }

  /** Solo borrador o rechazada, localmente. Una aceptada se da de baja en SUNAT Operaciones en Línea. */
  async anular(idGuia: number, dto: AnularGuiaRemisionRequest, idUsuario: number | null): Promise<GuiaRemisionResponse> {
    const fila = await this.filaOError(idGuia);
    this.exigirAnulable(fila);
    await this.repo.transaccion(async (tx) => {
      const actual = await this.repo.obtener(idGuia, tx, true);
      if (!actual) throw this.noEncontrada(idGuia);
      this.exigirAnulable(actual);
      const anulada = await this.repo.anular(tx, idGuia, {
        motivo: dto.motivo ?? null,
        fecha: this.reloj.ahora().toISOString(),
        id_usuario: idUsuario,
      });
      if (!anulada) {
        throw new ConflictException({ message: 'La guía cambió de estado mientras se anulaba: actualice la pantalla.', codigo: 'GRE_ESTADO_CAMBIO' });
      }
    });
    return this.obtener(idGuia);
  }

  // ── Validación y emisión ───────────────────────────────────────────────────

  /** «Validar sin enviar»: reglas del motor + ubigeos del catálogo INEI + topes de la venta. No cambia nada. */
  async validar(idGuia: number): Promise<ValidacionGuiaResponse> {
    const fila = await this.filaOError(idGuia);
    const estado = estadoDe(fila.estado);
    if (!this.acciones(estado, fila.envio).puede_validar) {
      const motivos: Partial<Record<EstadoGuia, string>> = {
        pendiente: 'La guía se está enviando a SUNAT en este momento: espere su resultado.',
        enviado: 'La guía ya fue enviada a SUNAT: no hay nada que validar.',
        aceptado: 'La guía ya fue aceptada por SUNAT: no hay nada que validar.',
        anulado: 'La guía está anulada: no hay nada que validar.',
        legacy: 'Las guías anteriores a la emisión electrónica son de solo lectura.',
      };
      throw new ConflictException({ message: motivos[estado], codigo: 'GRE_ESTADO_NO_PERMITE' });
    }
    const items = await this.repo.items(idGuia);
    const [emisor, gre, relacionado] = await Promise.all([
      this.fiscal.emisor(),
      this.fiscal.gre(),
      fila.id_venta ? this.repo.comprobantePrincipal(fila.id_venta) : Promise.resolve(null),
    ]);
    const ahora = this.reloj.ahora();
    const documento = this.documentoGre(fila, items, {
      emisor,
      serie: fila.serie ?? gre.serie,
      // Un borrador aún no tiene número: se valida con 1 (el real se asigna al emitir).
      numero: fila.numero ?? 1,
      fecha: fechaLima(ahora),
      hora: horaLima(ahora),
      relacionado: this.relacionadoVigente(relacionado, []),
    });
    return this.resultadoValidacion(this.emisionGre.validar(documento), await this.observacionesNegocio(fila, items, documento));
  }

  /**
   * «Emitir a SUNAT» desde el formulario (POST /guia-remision/emitir): guarda la guía y la emite en el acto.
   * Si la emisión no procede (400 por campo, 503 con la GRE inactiva, 409…), la guía queda como BORRADOR y
   * el error trae su id_guia para corregirla (PUT) y reintentar (POST /guia-remision/:id/emitir).
   */
  async crearYEmitir(dto: GuardarGuiaRemisionRequest, idUsuario: number | null): Promise<OperacionGuiaResponse> {
    const creada = await this.crear(dto, idUsuario);
    try {
      const operacion = await this.emitir(creada.id_guia, idUsuario);
      const avisos = Array.from(new Set([...creada.avisos, ...operacion.guia.avisos]));
      return { ...operacion, guia: { ...operacion.guia, avisos } };
    } catch (error) {
      throw conGuiaGuardada(error, creada.id_guia);
    }
  }

  /**
   * Emite (borrador), reenvía con el MISMO número (rechazada o pendiente tras un error de configuración)
   * o reintenta el MISMO ZIP (envío incierto). Solo con la GRE activa (si no, 503 con el motivo y sin
   * reservar número). Responde con lo que SUNAT ya dijo (ver `enviar`).
   */
  async emitir(idGuia: number, idUsuario: number | null): Promise<OperacionGuiaResponse> {
    const fila = await this.filaOError(idGuia);
    this.exigirEmitible(fila);
    const modo = await this.emisionGre.modo();
    if (!modo.activo) throw new ServiceUnavailableException({ message: modo.motivo, codigo: modo.codigo });
    if (estadoDe(fila.estado) === 'pendiente' && (fila.envio?.estado === 'PENDIENTE_REENVIO' || fila.envio?.estado === 'ENVIANDO')) {
      return this.reenviarMismoArchivo(fila);
    }
    return this.emitirNuevo(fila, idUsuario);
  }

  /** Consulta manual del ticket (la tarea consulta sola con espera creciente). */
  async consultar(idGuia: number): Promise<OperacionGuiaResponse> {
    const fila = await this.filaOError(idGuia);
    const estado = estadoDe(fila.estado);
    if (estado !== 'enviado' || fila.envio?.estado !== 'TICKET_PENDIENTE') {
      const motivo =
        estado === 'aceptado'
          ? 'La guía ya fue aceptada por SUNAT: no hay nada que consultar.'
          : estado === 'anulado' || estado === 'legacy'
            ? 'La guía no se envió a SUNAT desde este sistema.'
            : 'La guía no tiene un ticket de SUNAT pendiente: emítala primero.';
      throw new ConflictException({ message: motivo, codigo: 'GRE_SIN_TICKET' });
    }
    const operacion = await this.consultarEnvio(fila.envio.id_envio);
    if (!operacion) {
      throw new ConflictException({
        message: 'Ya se está consultando el ticket de esta guía: espere unos segundos y actualice.',
        codigo: 'GRE_CONSULTA_EN_CURSO',
      });
    }
    return operacion;
  }

  /** Envíos con el ticket pendiente cuyo turno llegó (para GreTicketsTarea). */
  candidatosConsulta(limite: number): Promise<number[]> {
    return this.repo.candidatosConsulta(limite);
  }

  /**
   * Reclama el envío (lease de 60 s, sin candados de sesión), consulta el ticket y guarda el resultado.
   * null si otro proceso lo está consultando o ya cambió de estado.
   */
  async consultarEnvio(idEnvio: number): Promise<OperacionGuiaResponse | null> {
    const reclamado = await this.repo.reclamarConsulta(idEnvio);
    if (!reclamado) return null;
    const { ticket, documento } = reclamado;
    const ruc = String(documento?.remitente?.ruc ?? '').trim();
    const serie = documento?.serie;
    const numero = Number(documento?.numero);
    let resultado: ResultadoConsultaGre;
    let sinDatos = false;
    if (!ticket || !ruc || !serie || !Number.isSafeInteger(numero)) {
      // Sin los datos del envío no se puede comprobar que la constancia sea de esta guía: no se consulta a ciegas.
      sinDatos = true;
      resultado = this.consultaSinDatos('Faltan el ticket o los datos del envío para comprobar la constancia: revise la guía en SUNAT Operaciones en Línea.');
    } else {
      try {
        resultado = await this.emisionGre.consultarTicket(ticket, { rucEmisor: ruc, serie, numero });
      } catch (error) {
        this.log.warn(`La consulta del ticket de la guía ${reclamado.id_guia} falló: ${redactarSecretosGre(mensajeDe(error))}`);
        resultado = this.consultaSinDatos(`No se pudo consultar a SUNAT (${redactarSecretosGre(mensajeDe(error))}). La guía sigue enviada: vuelva a consultar en unos minutos.`);
      }
    }
    const cierre = this.cierreConsulta(resultado, reclamado, sinDatos);
    await this.guardarConReintentos(
      () => this.repo.cerrarConsulta(idEnvio, reclamado.nombre_base, cierre),
      `consulta del ticket ${reclamado.ticket ?? ''}: ${resultado.estado}`,
    );
    return { guia: await this.obtener(reclamado.id_guia), resultado: this.resultadoOperacion(resultado, reclamado.ticket) };
  }

  // ── Descargas ──────────────────────────────────────────────────────────────

  /** Representación impresa: con QR solo si SUNAT la aceptó; si no, con la marca de su estado. */
  async pdf(idGuia: number): Promise<{ nombre: string; contenido: Buffer }> {
    const fila = await this.filaOError(idGuia);
    const guia = this.detalle(fila, await this.repo.items(idGuia));
    // El emisor con que se firmó la guía; si aún no se emitió, el de la configuración fiscal.
    const emisor = fila.payload.emision?.remitente ?? (await this.fiscal.emisor());
    const urlLogo = (await this.config.obtener('emisor_logo_url'))?.trim() || emisorConfig.logo_url;
    const logo = await obtenerLogoEmisor(urlLogo);
    const contenido = await generarGuiaRemisionPdf(this.datosPdf(guia, emisor, logo));
    const nombre = guia.numero_formateado ? `${emisor.ruc}-09-${guia.numero_formateado}.pdf` : `guia-borrador-${idGuia}.pdf`;
    return { nombre, contenido };
  }

  async archivo(idGuia: number, tipo: TipoArchivoGuia): Promise<ArchivoGuia> {
    await this.filaOError(idGuia);
    const archivo = await this.repo.archivo(idGuia, tipo);
    if (!archivo) throw new NotFoundException({ message: MENSAJE_ARCHIVO[tipo], codigo: 'GRE_ARCHIVO_NO_DISPONIBLE' });
    return archivo;
  }

  // ── Emisión (interno) ──────────────────────────────────────────────────────

  private async emitirNuevo(fila: FilaGuia, idUsuario: number | null): Promise<OperacionGuiaResponse> {
    const items = await this.repo.items(fila.id_guia);
    if (!items.length) throw new BadRequestException({ message: 'La guía no tiene bienes: agréguelos antes de emitirla.', codigo: 'GRE_INVALIDA' });
    const [contexto, gre] = await Promise.all([this.emisionGre.contexto(), this.fiscal.gre()]);
    // Una guía rechazada (o pendiente tras un error de configuración) conserva su serie y su número (D11).
    const serie = fila.numero !== null && fila.serie ? fila.serie : contexto.serie;
    const relacionado = fila.id_venta
      ? this.relacionadoVigente(await this.repo.comprobantePrincipal(fila.id_venta), [])
      : null;
    let numero = fila.numero ?? (await this.repo.siguienteNumero(serie, gre.correlativoInicial));

    for (let intento = 1; ; intento += 1) {
      const ahora = this.reloj.ahora();
      const documento = this.documentoGre(fila, items, { emisor: contexto.emisor, serie, numero, fecha: fechaLima(ahora), hora: horaLima(ahora), relacionado });
      // Fuera de la transacción: si la guía no pasa la validación no se reserva ningún número.
      const validacion = this.resultadoValidacion(this.emisionGre.validar(documento), await this.observacionesNegocio(fila, items, documento));
      if (!validacion.valido) throw this.errorValidacion(validacion);
      const preparada = await this.preparar(documento);
      let idEnvio: number;
      try {
        idEnvio = await this.repo.transaccion((tx) => this.registrar(tx, fila, items, preparada, relacionado, idUsuario, gre.correlativoInicial));
      } catch (error) {
        if (error instanceof NumeroGuiaOcupadoError && fila.numero === null && intento < MAXIMO_INTENTOS_NUMERO) {
          numero = Math.max(error.siguiente, await this.repo.siguienteNumero(serie, gre.correlativoInicial));
          continue;
        }
        throw this.traducirErrorRegistro(error);
      }
      return this.enviar(fila.id_guia, idEnvio, preparada);
    }
  }

  /** Dentro de la transacción: candados, estado, envío en curso, tope de la venta y número; luego registra el envío. */
  private async registrar(
    tx: EjecutorSql,
    fila: FilaGuia,
    items: FilaItemGuia[],
    preparada: GrePreparada,
    relacionado: ComprobanteRelacionadoGuia | null,
    idUsuario: number | null,
    piso: number,
  ): Promise<number> {
    const { serie, numero } = preparada.documento;
    if (fila.id_venta) await this.repo.bloquear(tx, `gre-venta:${fila.id_venta}`);
    const actual = await this.repo.obtener(fila.id_guia, tx, true);
    if (!actual) throw this.noEncontrada(fila.id_guia);
    await this.repo.bloquear(tx, `gre:${serie}`);
    this.exigirEmitible(actual);
    if (actual.numero !== fila.numero || actual.estado !== fila.estado) {
      throw new ConflictException({ message: 'La guía cambió mientras se preparaba el envío: actualice la pantalla e intente de nuevo.', codigo: 'GRE_ESTADO_CAMBIO' });
    }
    // Anti doble envío: sin el índice de fase13 esta verificación (con la fila del envío bloqueada) protege igual.
    if (await this.repo.envioAbierto(tx, fila.id_guia)) throw new EnvioGuiaEnCursoError();
    if (fila.id_venta) {
      const venta = await this.repo.venta(fila.id_venta, tx);
      if (!venta || venta.estado === 'anulada') {
        throw new ConflictException({ message: `La venta ${fila.id_venta} está anulada: anule esta guía en lugar de emitirla.`, codigo: 'GRE_VENTA_ANULADA' });
      }
      this.exigirTope(items, await this.repo.productosVendidos(fila.id_venta, fila.id_guia, tx), fila.id_venta);
    }
    if (fila.numero === null) {
      const siguiente = await this.repo.siguienteNumero(serie, piso, tx);
      if (numero < siguiente) throw new NumeroGuiaOcupadoError(serie, numero, siguiente);
    }
    return this.repo.registrarEmision(tx, {
      idGuia: fila.id_guia,
      numeroAnterior: fila.numero,
      idComprobante: relacionado?.id_comprobante ?? null,
      idUsuario,
      preparada,
    });
  }

  private async preparar(documento: DocumentoGre): Promise<GrePreparada> {
    try {
      return await this.emisionGre.prepararDocumento(documento);
    } catch (error) {
      if (error instanceof GreInvalidaError) {
        throw this.errorValidacion({
          valido: false,
          errores: [...error.errores],
          advertencias: [...error.advertencias],
          por_campo: error.errores.map((mensaje) => ({ campo: '', campo_formulario: '', nivel: 'error' as const, mensaje })),
        });
      }
      throw error;
    }
  }

  private traducirErrorRegistro(error: unknown): unknown {
    if (error instanceof NumeroGuiaOcupadoError) {
      return new ConflictException({
        message: 'No se pudo reservar un número para la guía porque otras guías se emitieron al mismo tiempo: intente de nuevo.',
        codigo: 'GRE_NUMERO_OCUPADO',
      });
    }
    if (error instanceof EnvioGuiaEnCursoError) {
      return new ConflictException({ message: 'La guía ya tiene un envío a SUNAT en curso: espere su resultado.', codigo: 'GRE_ENVIO_EN_CURSO' });
    }
    return error;
  }

  /** Reintento del MISMO ZIP cuando el envío anterior quedó incierto (red, 5xx o el proceso cayó tras el COMMIT). */
  private async reenviarMismoArchivo(fila: FilaGuia): Promise<OperacionGuiaResponse> {
    const reclamado = await this.repo.reclamarReenvio(fila.id_guia);
    if (!reclamado) {
      throw new ConflictException({ message: 'Otro proceso está enviando esta guía a SUNAT: espere su resultado y actualice en unos minutos.', codigo: 'GRE_ENVIO_EN_CURSO' });
    }
    const preparada = this.preparadaGuardada(reclamado);
    if (!preparada) {
      const mensaje = 'No se encontró el archivo del envío anterior: vuelva a emitir la guía (se preparará de nuevo con el mismo número).';
      await this.guardarConReintentos(
        () =>
          this.repo.cerrarEnvio(reclamado.id_envio, {
            estadoEnvio: 'ERROR_CONFIG',
            estadoGuia: 'pendiente',
            ticket: null,
            codigo: null,
            mensaje,
            errorGuia: mensaje,
            respuesta: { operacion: 'envio', estado: 'ERROR_CONFIG', mensaje, fecha: this.reloj.ahora().toISOString() },
            proximoIntentoSeg: null,
          }),
        'archivo del envío anterior no disponible',
      );
      throw new ConflictException({ message: mensaje, codigo: 'GRE_ARCHIVO_NO_DISPONIBLE' });
    }
    return this.enviar(fila.id_guia, reclamado.id_envio, preparada);
  }

  /** Lo guardado del envío como GrePreparada: los mismos bytes del ZIP (y su SHA-256), nunca uno nuevo. */
  private preparadaGuardada(r: EnvioParaReenvio): GrePreparada | null {
    if (!r.zip || !r.documento || !r.xml_firmado || !r.nombre_base) return null;
    return {
      documento: r.documento,
      nombreBase: r.nombre_base,
      xml: r.xml ?? '',
      xmlFirmado: r.xml_firmado,
      zip: r.zip,
      zipBase64: r.zip.toString('base64'),
      sha256: sha256(r.zip),
      digestValue: r.digest,
      advertencias: r.advertencias,
    };
  }

  /**
   * Envía (fuera de la transacción) y guarda el resultado; nunca deja el envío sin cerrar si SUNAT respondió.
   * Con el ticket recibido consulta una vez enseguida: si SUNAT ya decidió, la respuesta dice aceptada o
   * rechazada (con el motivo); si no, la guía queda 'enviado' y la consulta automática la completa.
   */
  private async enviar(idGuia: number, idEnvio: number, preparada: GrePreparada): Promise<OperacionGuiaResponse> {
    let resultado: ResultadoEnvioGre;
    try {
      resultado = await this.emisionGre.enviar(preparada);
    } catch (error) {
      // El motor normaliza los errores de SUNAT; esto es un fallo inesperado: el resultado es incierto.
      const detalle = redactarSecretosGre(mensajeDe(error));
      this.log.warn(`El envío de la guía ${preparada.nombreBase} falló de forma inesperada: ${detalle}`);
      resultado = {
        estado: 'PENDIENTE_REENVIO',
        ticket: null,
        fechaRecepcion: null,
        codigo: null,
        errores: [],
        accion: 'REINTENTAR',
        mensaje: `El envío a SUNAT falló de forma inesperada (${detalle}). Vuelva a emitir: se reenviará el mismo archivo.`,
        httpStatus: null,
        crudo: null,
      };
    }
    const cierre = this.cierreEnvio(resultado);
    await this.guardarConReintentos(
      () => this.repo.cerrarEnvio(idEnvio, cierre),
      resultado.ticket ? `ticket ${resultado.ticket}` : `${resultado.estado}${resultado.codigo ? ` ${resultado.codigo}` : ''}`,
    );
    if (cierre.estadoEnvio !== 'TICKET_PENDIENTE') {
      return { guia: await this.obtener(idGuia), resultado: this.resultadoOperacion(resultado, resultado.ticket) };
    }
    const consultada = await this.consultaInmediata(idEnvio);
    // SUNAT ya decidió, o la consulta necesita a una persona (credenciales, constancia ajena): su mensaje es el que sirve.
    if (consultada && (consultada.resultado.estado !== 'TICKET_PENDIENTE' || consultada.guia.envio?.revision_manual)) {
      return consultada;
    }
    // Sin poder leer la configuración no se promete una consulta automática que quizá no ocurra.
    const automatica = await this.fiscal.tareasActivas().catch(() => false);
    const mensaje = automatica ? MENSAJE_GUIA_EN_PROCESO : MENSAJE_GUIA_EN_PROCESO_MANUAL;
    const actual = consultada ?? { guia: await this.obtener(idGuia), resultado: this.resultadoOperacion(resultado, resultado.ticket) };
    return { guia: actual.guia, resultado: { ...actual.resultado, mensaje } };
  }

  /**
   * Una sola consulta del ticket, a los 2,5 s y con plazo. null si SUNAT no respondió a tiempo: la consulta
   * sigue en segundo plano con su reclamo y guarda lo que llegue (si no, la tarea de tickets la retoma).
   */
  private async consultaInmediata(idEnvio: number): Promise<OperacionGuiaResponse | null> {
    await pausa(ESPERA_CONSULTA_INMEDIATA_MS);
    const consulta = this.consultarEnvio(idEnvio).catch((error: unknown) => {
      // La guía ya quedó enviada con su ticket: este fallo no convierte la emisión en un error.
      this.log.warn(`La consulta inmediata del ticket (envío ${idEnvio}) falló: ${redactarSecretosGre(mensajeDe(error))}`);
      return null;
    });
    return conPlazo(consulta, PLAZO_CONSULTA_INMEDIATA_MS);
  }

  private cierreEnvio(r: ResultadoEnvioGre): CierreEnvioGuia {
    const mensaje = redactarSecretosGre(r.mensaje);
    const respuesta = {
      operacion: 'envio',
      estado: r.estado,
      codigo: r.codigo,
      mensaje,
      ticket: r.ticket,
      fecha_recepcion: r.fechaRecepcion,
      http_status: r.httpStatus ?? null,
      accion: r.accion,
      errores: r.errores,
      crudo: r.crudo ? redactarSecretosGre(r.crudo) : null,
      fecha: this.reloj.ahora().toISOString(),
    };
    const base = { ticket: null, codigo: r.codigo, mensaje, respuesta, proximoIntentoSeg: null };
    if ((r.estado === 'TICKET_PENDIENTE' || r.estado === 'ACEPTADA') && r.ticket) {
      return { ...base, estadoEnvio: 'TICKET_PENDIENTE', estadoGuia: 'enviado', ticket: r.ticket, errorGuia: null, proximoIntentoSeg: ESPERAS_CONSULTA_SEG[0] };
    }
    if (r.estado === 'RECHAZADA') {
      // 422 antes del ticket: el número NO se consume; se corrige y se reenvía con el mismo (D11).
      return { ...base, estadoEnvio: 'RECHAZADO', estadoGuia: 'rechazado', errorGuia: mensaje };
    }
    if (r.estado === 'ERROR_CONFIG') {
      return { ...base, estadoEnvio: 'ERROR_CONFIG', estadoGuia: 'pendiente', errorGuia: mensaje };
    }
    // PENDIENTE_REENVIO (o una respuesta sin ticket): incierto; «Emitir» reenvía el MISMO ZIP.
    return { ...base, estadoEnvio: 'PENDIENTE_REENVIO', estadoGuia: 'pendiente', errorGuia: mensaje };
  }

  private cierreConsulta(r: ResultadoConsultaGre, reclamado: EnvioParaConsulta, sinDatos: boolean): CierreConsultaGuia {
    const mensaje = redactarSecretosGre(r.mensaje);
    const consultas = reclamado.consultas + 1;
    const ultima = {
      estado: r.estado,
      codigo: r.codigo,
      mensaje,
      http_status: r.httpStatus ?? null,
      accion: r.accion,
      errores: r.errores,
      observaciones: r.observaciones ?? [],
      cdr_no_corresponde: r.cdrNoCorresponde ?? null,
      crudo: r.crudo ? redactarSecretosGre(r.crudo) : null,
      fecha: this.reloj.ahora().toISOString(),
    };
    const respuestaGuia = { operacion: 'consulta', ...ultima };
    const sinArchivos = { observaciones: null, cdr: null, cadenaQr: null, codigoHash: null };

    if (r.estado === 'ACEPTADA' && r.cdr) {
      const observaciones = r.observaciones?.length ? r.observaciones : null;
      return {
        estadoEnvio: observaciones ? 'ACEPTADO_OBS' : 'ACEPTADO',
        estadoGuia: 'aceptado',
        codigo: r.codigo,
        mensaje,
        errorGuia: null,
        observaciones,
        cdr: { xml: r.cdr.xml, zip: r.cdr.zip },
        cadenaQr: r.cdr.enlaceQr ?? null,
        codigoHash: reclamado.digest,
        // Cerrado: ya no queda nada que revisar a mano (aunque una consulta anterior lo haya pedido).
        respuestaEnvio: { consultas, revision_manual: false, ultima_consulta: ultima },
        respuestaGuia,
        proximoIntentoSeg: null,
      };
    }
    if (r.estado === 'RECHAZADA') {
      // El número se conserva para corregir y reenviar; si SUNAT dice que ya estaba registrada, hay que mirar SOL.
      const yaRegistrada = r.errores.some((e) => CODIGOS_YA_REGISTRADA.has(String(e.codigo).trim().padStart(4, '0')));
      return {
        ...sinArchivos,
        estadoEnvio: 'RECHAZADO',
        estadoGuia: 'rechazado',
        codigo: r.codigo,
        mensaje,
        errorGuia: mensaje,
        cdr: r.cdr ? { xml: r.cdr.xml, zip: r.cdr.zip } : null,
        respuestaEnvio: { consultas, revision_manual: false, ultima_consulta: ultima },
        respuestaGuia: { ...respuestaGuia, ya_registrada: yaRegistrada },
        proximoIntentoSeg: null,
      };
    }
    // Sigue en proceso (98, sin respuesta, credenciales) o la constancia no corresponde: la guía queda 'enviado'.
    // La consulta automática se detiene cuando hace falta una persona; con credenciales rechazadas, además,
    // porque repetir una clave mala puede bloquear el usuario SOL. Se decide en cada consulta: tras corregir
    // la causa, «Consultar» la reanuda.
    const noCorresponde = Boolean(r.cdrNoCorresponde);
    const errorConfig = r.estado === 'ERROR_CONFIG';
    const agotado = consultas >= MAXIMO_CONSULTAS_AUTOMATICAS;
    const revisionManual = sinDatos || noCorresponde || errorConfig || agotado;
    const errorGuia = sinDatos || noCorresponde || errorConfig
      ? mensaje
      : agotado
        ? `${mensaje} SUNAT no entregó la constancia tras ${consultas} consultas: la consulta automática se detuvo; use «Consultar» más tarde o revise la guía en SUNAT Operaciones en Línea.`
        : null;
    return {
      ...sinArchivos,
      estadoEnvio: 'TICKET_PENDIENTE',
      estadoGuia: 'enviado',
      codigo: r.codigo,
      mensaje,
      errorGuia,
      respuestaEnvio: { consultas, revision_manual: revisionManual, ultima_consulta: ultima },
      respuestaGuia,
      proximoIntentoSeg: revisionManual ? null : ESPERAS_CONSULTA_SEG[Math.min(consultas, ESPERAS_CONSULTA_SEG.length - 1)],
    };
  }

  private consultaSinDatos(mensaje: string): ResultadoConsultaGre {
    return { estado: 'TICKET_PENDIENTE', codigo: null, mensaje, errores: [], accion: 'CONSULTAR_TICKET', cdr: null, httpStatus: null, crudo: null };
  }

  private resultadoOperacion(r: ResultadoEnvioGre | ResultadoConsultaGre, ticket: string | null): OperacionGuiaResponse['resultado'] {
    return { estado: r.estado, codigo: r.codigo, mensaje: redactarSecretosGre(r.mensaje), ticket: ticket ?? null, errores: r.errores };
  }

  /** D5.3: lo que SUNAT ya respondió se intenta guardar hasta 3 veces antes de responder 503 (el envío queda recuperable). */
  private async guardarConReintentos(guardar: () => Promise<boolean>, resumen: string): Promise<void> {
    for (let intento = 1; intento <= REINTENTOS_GUARDADO; intento += 1) {
      try {
        // false: otro proceso ya cerró el envío; vale lo que guardó (la respuesta lee el estado real de la guía).
        if (!(await guardar())) this.log.warn(`El resultado de SUNAT (${resumen}) no se guardó: otro proceso ya había cerrado el envío.`);
        return;
      } catch (error) {
        this.log.warn(`No se pudo guardar el resultado de SUNAT (${resumen}), intento ${intento}: ${mensajeDe(error)}`);
      }
    }
    throw new ServiceUnavailableException({
      message: `SUNAT respondió (${resumen}), pero no se pudo guardar el resultado en la base de datos. Anote este dato y vuelva a intentarlo en un minuto.`,
      codigo: 'GRE_RESULTADO_NO_GUARDADO',
    });
  }

  // ── Documento GRE y validación ─────────────────────────────────────────────

  /** La guía guardada como DocumentoGre del motor (solo los datos de transporte de su modalidad). */
  private documentoGre(fila: FilaGuia, items: FilaItemGuia[], c: ContextoDocumento): DocumentoGre {
    const form = fila.payload.formulario ?? {};
    const motivo = fila.motivo_traslado_codigo ?? '';
    const modalidad = (fila.modalidad_traslado ?? '') as ModalidadTransporteGre;
    const documento: DocumentoGre = {
      tipo: '09',
      serie: c.serie,
      numero: c.numero,
      fechaEmision: c.fecha,
      horaEmision: c.hora,
      remitente: c.emisor,
      // Con el motivo 04 el destinatario es el propio remitente (anexo N.° 12, campos 8 y 9).
      destinatario:
        motivo === '04'
          ? { tipoDoc: '6', numDoc: c.emisor.ruc, nombre: c.emisor.razonSocial }
          : { tipoDoc: fila.destinatario_tipo_doc ?? '', numDoc: fila.destinatario_numero_doc ?? '', nombre: fila.destinatario_denominacion ?? '' },
      envio: {
        motivo,
        descripcionMotivo: form.descripcion_motivo ?? undefined,
        modalidad,
        fechaInicioTraslado: fila.fecha_inicio_traslado ?? '',
        fechaEntregaTransportista: modalidad === '01' ? form.fecha_entrega_transportista ?? undefined : undefined,
        pesoBrutoTotal: fila.peso_bruto_total ?? 0,
        unidadPeso: fila.unidad_peso ?? 'KGM',
        numeroBultos: fila.numero_bultos ?? undefined,
        partida: { ubigeo: fila.origen_ubigeo ?? '', direccion: fila.direccion_origen ?? '', codigoEstablecimiento: form.partida_codigo_establecimiento ?? undefined },
        llegada: { ubigeo: fila.destino_ubigeo ?? '', direccion: fila.direccion_destino ?? '', codigoEstablecimiento: form.llegada_codigo_establecimiento ?? undefined },
      },
      items: items.map((i) => ({
        cantidad: i.cantidad,
        unidad: i.unidad_medida ?? '',
        descripcion: i.descripcion,
        codigoInterno: i.codigo ? i.codigo.slice(0, 30) : undefined,
        codigoSunat: i.codigo_sunat && /^\d{8}$/.test(i.codigo_sunat) ? i.codigo_sunat : undefined,
      })),
      observaciones: fila.observaciones ?? undefined,
    };
    if (modalidad === '01') {
      documento.transportista = {
        tipoDoc: '6',
        numDoc: fila.transportista_ruc ?? '',
        razonSocial: fila.transportista_denominacion ?? '',
        registroMtc: form.registro_mtc ?? undefined,
      };
    }
    if (modalidad === '02') {
      documento.vehiculo = { placa: normalizarPlacaGre(fila.placa_principal), tarjetaCirculacion: form.tarjeta_circulacion ?? undefined };
      const conductor = {
        tipoDoc: fila.conductor_tipo_doc ?? '',
        numDoc: fila.conductor_numero_doc ?? '',
        nombres: form.conductor_nombres ?? '',
        apellidos: form.conductor_apellidos ?? '',
        licencia: fila.conductor_licencia ?? '',
      };
      // Sin ningún dato del conductor el motor pide «al menos un conductor» (un mensaje en vez de cinco).
      documento.conductores = Object.values(conductor).some(Boolean) ? [conductor] : [];
    }
    const relacionado = this.relacionado(c.relacionado);
    if (relacionado) documento.documentosRelacionados = [{ tipo: relacionado.tipo, serie: relacionado.serie, numero: String(relacionado.numero) }];
    return documento;
  }

  /** Reglas que el motor no conoce: ubigeos del catálogo INEI, venta anulada y tope por producto. */
  private async observacionesNegocio(fila: FilaGuia, items: FilaItemGuia[], documento: DocumentoGre): Promise<ObservacionCampoGre[]> {
    const observaciones: ObservacionCampoGre[] = [];
    for (const [punto, etiqueta] of [['partida', 'Punto de partida'], ['llegada', 'Punto de llegada']] as const) {
      const ubigeo = documento.envio[punto].ubigeo;
      if (/^\d{6}$/.test(ubigeo) && !this.ubigeos.existe(ubigeo)) {
        observaciones.push({
          campo: `envio.${punto}.ubigeo`,
          nivel: 'error',
          mensaje: `${etiqueta}: el ubigeo ${ubigeo} no existe en el catálogo de distritos del INEI; búsquelo por el nombre del distrito.`,
        });
      }
    }
    if (fila.id_venta) {
      const venta = await this.repo.venta(fila.id_venta);
      if (!venta || venta.estado === 'anulada') {
        observaciones.push({ campo: 'venta', nivel: 'error', mensaje: `La venta ${fila.id_venta} está anulada: anule esta guía en lugar de emitirla.` });
      } else {
        observaciones.push(...this.observacionesTope(items, await this.repo.productosVendidos(fila.id_venta, fila.id_guia), fila.id_venta));
      }
    }
    return observaciones;
  }

  private resultadoValidacion(motor: ResultadoValidacionGre, negocio: ObservacionCampoGre[]): ValidacionGuiaResponse {
    const porCampo: ObservacionCampoGre[] = motor.porCampo ?? [
      ...motor.errores.map((mensaje) => ({ campo: '', nivel: 'error' as const, mensaje })),
      ...motor.advertencias.map((mensaje) => ({ campo: '', nivel: 'advertencia' as const, mensaje })),
    ];
    // El motor ya marca un ubigeo mal formado: no se repite el aviso del catálogo para el mismo campo.
    const conError = new Set(porCampo.filter((o) => o.nivel === 'error').map((o) => o.campo));
    const todas = [...porCampo, ...negocio.filter((o) => !(o.campo.endsWith('.ubigeo') && conError.has(o.campo)))];
    const por_campo: ObservacionGuiaResponse[] = todas.map((o) => ({ ...o, campo_formulario: campoFormularioGuia(o.campo) }));
    const errores = todas.filter((o) => o.nivel === 'error').map((o) => o.mensaje);
    return {
      valido: errores.length === 0,
      errores,
      advertencias: todas.filter((o) => o.nivel === 'advertencia').map((o) => o.mensaje),
      por_campo,
    };
  }

  private errorValidacion(v: ValidacionGuiaResponse): BadRequestException {
    const primeros = v.errores.slice(0, 3).join(' | ');
    return new BadRequestException({
      message: `La guía tiene ${v.errores.length} error(es) que impiden emitirla: ${primeros}${v.errores.length > 3 ? ' | …' : ''}`,
      codigo: 'GRE_INVALIDA',
      errores: v.errores,
      advertencias: v.advertencias,
      por_campo: v.por_campo,
    });
  }

  // ── Guardado (interno) ─────────────────────────────────────────────────────

  /** Con venta: solo 01. Sin venta: solo 04 y 13 (D10). */
  private exigirMotivoSegunVenta(motivo: string, idVenta: number | null): void {
    if (idVenta && motivo !== '01') {
      throw new BadRequestException({
        message: 'Una guía de una venta usa el motivo 01 (venta). Para los motivos 04 y 13 cree la guía sin venta.',
        codigo: 'GRE_MOTIVO_NO_VALIDO',
      });
    }
    if (!idVenta && motivo === '01') {
      throw new BadRequestException({
        message: 'Con el motivo 01 (venta) indique la venta que sustenta el traslado (id_venta).',
        codigo: 'GRE_MOTIVO_NO_VALIDO',
      });
    }
  }

  private async defectosGuardado(dto: GuardarGuiaRemisionRequest): Promise<DefectosGuardado> {
    for (const [campo, valor] of [
      ['fecha_inicio_traslado', dto.fecha_inicio_traslado],
      ['fecha_entrega_transportista', dto.fecha_entrega_transportista],
    ] as const) {
      if (valor && !esFechaIso(valor)) {
        throw new BadRequestException({ message: `${campo}: la fecha ${valor} no existe en el calendario.`, codigo: 'VALIDACION' });
      }
    }
    const [emisor, partida] = await Promise.all([
      dto.motivo_traslado === '04' ? this.fiscal.emisor() : Promise.resolve(null),
      dto.partida ? Promise.resolve(null) : this.fiscal.gre().then((gre) => gre.partida),
    ]);
    return { emisor, partida };
  }

  /** Normaliza el formulario y, con venta, verifica (bajo el candado de la venta) productos y topes. */
  private async datosGuardado(
    tx: EjecutorSql,
    dto: GuardarGuiaRemisionRequest,
    idVenta: number | null,
    idGuiaExcluir: number | null,
    defectos: DefectosGuardado,
    avisos: string[],
  ): Promise<DatosGuardarGuia> {
    let venta: VentaGuia | null = null;
    let items: ItemGuardarGuia[];
    let relacionado: ComprobanteRelacionadoGuia | null = null;
    let idAlmacen: number | null = null;
    if (idVenta) {
      await this.repo.bloquear(tx, `gre-venta:${idVenta}`);
      venta = await this.repo.venta(idVenta, tx);
      if (!venta) throw new NotFoundException({ message: `La venta ${idVenta} no existe.`, codigo: 'VENTA_NO_ENCONTRADA' });
      if (venta.estado === 'anulada') {
        throw new ConflictException({ message: `La venta ${idVenta} está anulada: no se le pueden emitir guías.`, codigo: 'GRE_VENTA_ANULADA' });
      }
      const vendidos = await this.repo.productosVendidos(idVenta, idGuiaExcluir, tx);
      items = this.itemsDeVenta(dto.items, vendidos, idVenta, avisos);
      relacionado = this.relacionadoVigente(await this.repo.comprobantePrincipal(idVenta, tx), avisos);
      const almacenes = await this.repo.almacenesDeSalida(idVenta);
      idAlmacen = almacenes.length === 1 ? almacenes[0].id_almacen : null;
    } else {
      const ids = Array.from(new Set(dto.items.map((i) => i.id_producto)));
      const productos = new Map((await this.repo.productos(ids, tx)).map((p) => [p.id_producto, p]));
      const faltan = ids.filter((id) => !productos.has(id));
      if (faltan.length) {
        throw new BadRequestException({ message: `Producto(s) que no existen en el catálogo: ${faltan.join(', ')}.`, codigo: 'GRE_PRODUCTO_NO_EXISTE', productos: faltan });
      }
      items = dto.items.map((i) => {
        const p = productos.get(i.id_producto)!;
        return {
          id_producto: i.id_producto,
          id_venta_detalle: null,
          codigo: p.codigo,
          descripcion: i.descripcion ?? p.nombre ?? 'Producto',
          unidad_medida: this.unidad(i.unidad, p.unidad_medida, p.nombre, avisos),
          cantidad: i.cantidad,
        };
      });
    }

    const motivo = dto.motivo_traslado;
    const destinatario: DestinatarioGuiaResponse =
      motivo === '04' && defectos.emisor
        ? { tipo_documento: '6', numero_documento: defectos.emisor.ruc, denominacion: defectos.emisor.razonSocial, direccion: dto.llegada?.direccion ?? null }
        : dto.destinatario
          ? {
              tipo_documento: dto.destinatario.tipo_documento ?? null,
              numero_documento: dto.destinatario.numero_documento ?? null,
              denominacion: dto.destinatario.denominacion ?? null,
              direccion: dto.destinatario.direccion ?? null,
            }
          : venta
            ? this.destinatarioDeVenta(venta)
            : { tipo_documento: null, numero_documento: null, denominacion: null, direccion: null };
    const partida = dto.partida
      ? { ubigeo: dto.partida.ubigeo ?? null, direccion: dto.partida.direccion ?? null, codigo: dto.partida.codigo_establecimiento ?? null }
      : { ubigeo: defectos.partida?.ubigeo || null, direccion: defectos.partida?.direccion || null, codigo: defectos.partida?.codigoEstablecimiento || null };
    const sugerida = venta ? this.llegadaDeVenta(venta) : null;
    const llegada = dto.llegada
      ? { ubigeo: dto.llegada.ubigeo ?? null, direccion: dto.llegada.direccion ?? null, codigo: dto.llegada.codigo_establecimiento ?? null }
      : { ubigeo: sugerida?.ubigeo ?? null, direccion: sugerida?.direccion ?? null, codigo: null };
    const conductor = dto.conductor;
    const nombreConductor = [conductor?.nombres, conductor?.apellidos].filter(Boolean).join(' ') || null;

    return {
      id_comprobante: relacionado?.id_comprobante ?? null,
      id_empresa: venta?.id_empresa ?? null,
      id_cliente: venta?.id_cliente ?? null,
      id_almacen_origen: idAlmacen,
      motivo_traslado_codigo: motivo,
      motivo_traslado_texto: CATALOGO_20_MOTIVOS_TRASLADO[motivo] ?? motivo,
      modalidad_traslado: dto.modalidad_traslado,
      fecha_inicio_traslado: dto.fecha_inicio_traslado ?? null,
      direccion_origen: partida.direccion,
      origen_ubigeo: partida.ubigeo,
      direccion_destino: llegada.direccion,
      destino_ubigeo: llegada.ubigeo,
      peso_bruto_total: dto.peso_bruto_total ?? null,
      unidad_peso: dto.unidad_peso ?? 'KGM',
      numero_bultos: dto.numero_bultos ?? null,
      destinatario_tipo_doc: destinatario.tipo_documento,
      destinatario_numero_doc: destinatario.numero_documento,
      destinatario_denominacion: destinatario.denominacion,
      destinatario_direccion: destinatario.direccion,
      placa_principal: dto.vehiculo?.placa ? normalizarPlacaGre(dto.vehiculo.placa) : null,
      marca_vehiculo: dto.vehiculo?.marca ?? null,
      conductor_nombre: nombreConductor,
      conductor_tipo_doc: conductor?.tipo_documento ?? null,
      conductor_numero_doc: conductor?.numero_documento ?? null,
      conductor_licencia: conductor?.licencia ?? null,
      transportista_ruc: dto.transportista?.ruc ?? null,
      transportista_denominacion: dto.transportista?.razon_social ?? null,
      observaciones: dto.observaciones ?? null,
      formulario: {
        descripcion_motivo: dto.descripcion_motivo ?? null,
        fecha_entrega_transportista: dto.fecha_entrega_transportista ?? null,
        partida_codigo_establecimiento: partida.codigo,
        llegada_codigo_establecimiento: llegada.codigo,
        registro_mtc: dto.transportista?.registro_mtc ?? null,
        tarjeta_circulacion: dto.vehiculo?.tarjeta_circulacion ?? null,
        conductor_nombres: conductor?.nombres ?? null,
        conductor_apellidos: conductor?.apellidos ?? null,
      },
      items,
    };
  }

  /** Productos de la venta con el tope por producto: lo vendido menos lo que ya llevan las demás guías vigentes. */
  private itemsDeVenta(itemsDto: ItemGuiaRequest[], vendidos: ProductoVendidoGuia[], idVenta: number, avisos: string[]): ItemGuardarGuia[] {
    const porProducto = new Map(vendidos.map((v) => [v.id_producto, v]));
    const ajenos = Array.from(new Set(itemsDto.filter((i) => !porProducto.has(i.id_producto)).map((i) => i.id_producto)));
    if (ajenos.length) {
      throw new BadRequestException({
        message: `Producto(s) que no están en la venta ${idVenta}: ${ajenos.join(', ')}. Una guía de venta solo lleva lo vendido.`,
        codigo: 'GRE_PRODUCTO_FUERA_DE_VENTA',
        productos: ajenos,
      });
    }
    this.exigirTope(itemsDto, vendidos, idVenta);
    return itemsDto.map((i) => {
      const v = porProducto.get(i.id_producto)!;
      return {
        id_producto: i.id_producto,
        id_venta_detalle: v.id_venta_detalle,
        codigo: v.codigo,
        descripcion: i.descripcion ?? v.nombre ?? 'Producto',
        unidad_medida: this.unidad(i.unidad, v.unidad_medida, v.nombre, avisos),
        cantidad: i.cantidad,
      };
    });
  }

  /** 409 si por algún producto la guía supera lo pendiente de la venta (lo vendido menos las otras guías vigentes). */
  private exigirTope(items: Array<{ id_producto: number; cantidad: number }>, vendidos: ProductoVendidoGuia[], idVenta: number): void {
    const excedidos = this.excedidos(items, vendidos);
    if (!excedidos.length) return;
    const detalle = excedidos.map((e) =>
      `${e.descripcion} (vendido ${cantidadTexto(e.vendido)}, en otras guías ${cantidadTexto(e.enGuias)}, en esta ${cantidadTexto(e.solicitado)}; pendiente ${cantidadTexto(Math.max(0, e.vendido - e.enGuias))})`,
    );
    throw new ConflictException({
      message: `Las cantidades superan lo pendiente de guía en la venta ${idVenta}: ${detalle.join('; ')}.`,
      codigo: 'GRE_CANTIDAD_EXCEDE_VENTA',
      detalle: excedidos.map((e) => ({
        id_producto: e.id_producto,
        descripcion: e.descripcion,
        cantidad_vendida: e.vendido / 1000,
        cantidad_en_guias: e.enGuias / 1000,
        cantidad_solicitada: e.solicitado / 1000,
        cantidad_pendiente: Math.max(0, e.vendido - e.enGuias) / 1000,
      })),
    });
  }

  private observacionesTope(items: FilaItemGuia[], vendidos: ProductoVendidoGuia[], idVenta: number): ObservacionCampoGre[] {
    const porProducto = new Map(vendidos.map((v) => [v.id_producto, v]));
    const excedidos = new Map(this.excedidos(items, vendidos).map((e) => [e.id_producto, e]));
    return items.flatMap((item, i): ObservacionCampoGre[] => {
      if (!porProducto.has(item.id_producto)) {
        return [{ campo: `items[${i}]`, nivel: 'error', mensaje: `Ítem ${i + 1}: el producto ${item.descripcion} no está en la venta ${idVenta}.` }];
      }
      const e = excedidos.get(item.id_producto);
      if (!e) return [];
      return [{
        campo: `items[${i}].cantidad`,
        nivel: 'error',
        mensaje: `Ítem ${i + 1} (${item.descripcion}): supera lo pendiente de la venta (vendido ${cantidadTexto(e.vendido)}, en otras guías ${cantidadTexto(e.enGuias)}, pendiente ${cantidadTexto(Math.max(0, e.vendido - e.enGuias))}).`,
      }];
    });
  }

  private excedidos(items: Array<{ id_producto: number; cantidad: number }>, vendidos: ProductoVendidoGuia[]) {
    const pedido = new Map<number, number>();
    for (const item of items) pedido.set(item.id_producto, (pedido.get(item.id_producto) ?? 0) + milesimas(item.cantidad));
    return vendidos.flatMap((v) => {
      const solicitado = pedido.get(v.id_producto) ?? 0;
      const vendido = milesimas(v.cantidad_vendida);
      const enGuias = milesimas(v.cantidad_en_guias);
      return solicitado > 0 && enGuias + solicitado > vendido
        ? [{ id_producto: v.id_producto, descripcion: v.nombre ?? `Producto ${v.id_producto}`, vendido, enGuias, solicitado }]
        : [];
    });
  }

  /** Unidad del catálogo 03: la elegida en el formulario o la del producto normalizada (con aviso si no se reconoce). */
  private unidad(elegida: string | undefined, delProducto: string | null, nombre: string | null, avisos: string[]): string {
    if (elegida) return elegida;
    const { codigo, advertencia } = normalizarUnidad(delProducto);
    if (advertencia) avisos.push(`${nombre ?? 'Producto'}: ${advertencia}`);
    return codigo;
  }

  // ── Estados y respuestas ───────────────────────────────────────────────────

  private exigirEditable(fila: FilaGuia): void {
    const estado = estadoDe(fila.estado);
    if (estado === 'borrador' || estado === 'rechazado') return;
    const motivos: Partial<Record<EstadoGuia, string>> = {
      legacy: 'Las guías anteriores a la emisión electrónica son de solo lectura.',
      anulado: 'La guía está anulada: no se puede editar.',
      aceptado: 'La guía ya fue aceptada por SUNAT: no se puede modificar.',
      enviado: 'La guía ya fue enviada a SUNAT: espere su resultado (consulte el ticket).',
      pendiente: 'La guía está en proceso de envío a SUNAT: no se puede editar.',
    };
    throw new ConflictException({ message: motivos[estado], codigo: 'GRE_ESTADO_NO_PERMITE' });
  }

  private exigirEmitible(fila: FilaGuia): void {
    const estado = estadoDe(fila.estado);
    if (estado === 'borrador' || estado === 'rechazado') return;
    if (estado === 'pendiente') {
      if (fila.envio?.en_curso) {
        throw new ConflictException({
          message: 'La guía se está enviando a SUNAT en este momento: espere su resultado (si el envío se interrumpió, podrá reintentarlo en unos minutos).',
          codigo: 'GRE_ENVIO_EN_CURSO',
        });
      }
      if (fila.envio?.estado === 'TICKET_PENDIENTE') {
        throw new ConflictException({ message: 'SUNAT ya recibió la guía: use «Consultar» para obtener la respuesta.', codigo: 'GRE_YA_ENVIADA' });
      }
      return;
    }
    const motivos: Partial<Record<EstadoGuia, string>> = {
      enviado: `La guía ya fue enviada a SUNAT${fila.sunat_ticket ? ` (ticket ${fila.sunat_ticket})` : ''}: use «Consultar» para obtener la respuesta.`,
      aceptado: 'La guía ya fue aceptada por SUNAT.',
      anulado: 'La guía está anulada: no se puede emitir.',
      legacy: 'Las guías anteriores a la emisión electrónica son de solo lectura.',
    };
    throw new ConflictException({ message: motivos[estado], codigo: estado === 'enviado' ? 'GRE_YA_ENVIADA' : 'GRE_ESTADO_NO_PERMITE' });
  }

  private exigirAnulable(fila: FilaGuia): void {
    const estado = estadoDe(fila.estado);
    if (estado === 'borrador' || estado === 'rechazado') return;
    const motivos: Partial<Record<EstadoGuia, string>> = {
      aceptado: 'La guía ya fue aceptada por SUNAT: la baja de una guía aceptada se hace en SUNAT Operaciones en Línea.',
      enviado: 'La guía está en proceso en SUNAT: espere su resultado (consulte el ticket) antes de anularla.',
      pendiente: 'La guía está en proceso de envío a SUNAT: espere su resultado antes de anularla.',
      anulado: 'La guía ya está anulada.',
      legacy: 'Las guías anteriores a la emisión electrónica son de solo lectura.',
    };
    throw new ConflictException({ message: motivos[estado], codigo: 'GRE_ESTADO_NO_PERMITE' });
  }

  private acciones(estado: EstadoGuia, envio: EnvioGuia | null): AccionesGuiaResponse {
    const ninguna: AccionesGuiaResponse = { puede_editar: false, puede_validar: false, puede_emitir: false, puede_consultar: false, puede_anular: false };
    switch (estado) {
      case 'borrador':
      case 'rechazado':
        return { puede_editar: true, puede_validar: true, puede_emitir: true, puede_consultar: false, puede_anular: true };
      case 'pendiente': {
        const disponible = !envio?.en_curso && envio?.estado !== 'TICKET_PENDIENTE';
        return { ...ninguna, puede_validar: disponible, puede_emitir: disponible };
      }
      case 'enviado':
        return { ...ninguna, puede_consultar: true };
      default:
        return ninguna;
    }
  }

  private async filaOError(idGuia: number): Promise<FilaGuia> {
    const fila = await this.repo.obtener(idGuia);
    if (!fila) throw this.noEncontrada(idGuia);
    return fila;
  }

  private noEncontrada(idGuia: number): NotFoundException {
    return new NotFoundException({ message: `La guía ${idGuia} no existe.`, codigo: 'GRE_NO_ENCONTRADA' });
  }

  private punto(ubigeo: string | null, direccion: string | null, codigo: string | null | undefined): PuntoGuiaResponse {
    return { ubigeo, ubigeo_texto: this.ubigeos.textoLegible(ubigeo), direccion, codigo_establecimiento: codigo ?? null };
  }

  private relacionado(comprobante: ComprobanteRelacionadoGuia | null): DocumentoRelacionadoGuiaResponse | null {
    if (!comprobante) return null;
    const tipo = comprobante.id_tipo === TIPO_FACTURA ? '01' : comprobante.id_tipo === TIPO_BOLETA ? '03' : null;
    if (!tipo) return null;
    return {
      id_comprobante: comprobante.id_comprobante,
      tipo,
      tipo_texto: CATALOGO_61_DOCUMENTOS_RELACIONADOS[tipo],
      serie: comprobante.serie,
      numero: comprobante.numero,
      numero_formateado: `${comprobante.serie}-${String(comprobante.numero).padStart(8, '0')}`,
    };
  }

  /** Un comprobante de pruebas BETA no existe en SUNAT producción: no se relaciona en una guía real. */
  private relacionadoVigente(comprobante: ComprobanteRelacionadoGuia | null, avisos: string[]): ComprobanteRelacionadoGuia | null {
    if (comprobante?.ambiente_fiscal === 'beta') {
      avisos.push(`El comprobante ${comprobante.serie}-${comprobante.numero} es de pruebas (SUNAT BETA): no se relaciona en la guía.`);
      return null;
    }
    return comprobante;
  }

  private destinatarioDeVenta(venta: VentaGuia): DestinatarioGuiaResponse {
    const ruc = venta.empresa?.ruc?.replace(/\D/g, '') ?? '';
    if (venta.empresa && ruc.length === 11) {
      return { tipo_documento: '6', numero_documento: ruc, denominacion: venta.empresa.razon_social, direccion: venta.empresa.direccion };
    }
    const dni = venta.cliente?.dni?.replace(/\D/g, '') ?? '';
    if (venta.cliente && dni) {
      // dni es numérico en la BD: un DNI que empieza con 0 se guardó sin él.
      return { tipo_documento: '1', numero_documento: dni.padStart(8, '0'), denominacion: venta.cliente.nombre, direccion: venta.cliente.direccion };
    }
    return {
      tipo_documento: null,
      numero_documento: null,
      denominacion: venta.cliente?.nombre ?? venta.empresa?.razon_social ?? null,
      direccion: venta.cliente?.direccion ?? venta.empresa?.direccion ?? null,
    };
  }

  /** Llegada sugerida: la dirección del cliente; con empresa, su ubigeo (por nombres, que son más fiables que el código guardado). */
  private llegadaDeVenta(venta: VentaGuia): PuntoGuiaResponse {
    if (venta.empresa) {
      const e = venta.empresa;
      const ubigeo = this.ubigeos.porNombres(e.departamento, e.provincia, e.distrito) ?? this.ubigeos.obtener(e.ubigeo);
      return this.punto(ubigeo?.codigo ?? null, e.direccion, null);
    }
    return this.punto(null, venta.cliente?.direccion ?? null, null);
  }

  /** Partida configurada en el panel (EmisionGre.contexto); si no se puede leer, se sigue con la del almacén y un aviso. */
  private async partidaConfigurada(): Promise<{ punto: DireccionGre | null; aviso: string | null }> {
    try {
      return { punto: (await this.emisionGre.contexto()).partidaPorDefecto, aviso: null };
    } catch (error) {
      return { punto: null, aviso: `No se pudo leer el punto de partida del panel de facturación (${mensajeDe(error)}): se propone la dirección del almacén.` };
    }
  }

  private resumen(f: FilaGuia): GuiaRemisionResumenResponse {
    const estado = estadoDe(f.estado);
    return {
      id_guia: f.id_guia,
      id_venta: f.id_venta,
      id_comprobante: f.id_comprobante,
      serie: f.serie,
      numero: f.numero,
      numero_formateado: numeroFormateado(f.serie, f.numero),
      estado,
      estado_texto: ESTADO_GUIA_TEXTO[estado],
      solo_lectura: estado === 'legacy',
      fecha_emision: f.fecha_emision,
      fecha_inicio_traslado: f.fecha_inicio_traslado,
      motivo_traslado: f.motivo_traslado_codigo,
      motivo_traslado_texto: f.motivo_traslado_codigo ? (CATALOGO_20_MOTIVOS_TRASLADO[f.motivo_traslado_codigo] ?? null) : null,
      modalidad_traslado: f.modalidad_traslado,
      modalidad_traslado_texto:
        f.modalidad_traslado === '01' || f.modalidad_traslado === '02' ? CATALOGO_18_MODALIDAD_TRASLADO[f.modalidad_traslado] : null,
      destinatario: {
        tipo_documento: f.destinatario_tipo_doc,
        numero_documento: f.destinatario_numero_doc,
        denominacion: f.destinatario_denominacion,
        direccion: f.destinatario_direccion,
      },
      llegada: this.punto(f.destino_ubigeo, f.direccion_destino, f.payload.formulario?.llegada_codigo_establecimiento),
      documento_relacionado: this.relacionado(f.comprobante),
      sunat_ticket: f.sunat_ticket,
      error_mensaje: f.error_mensaje,
      creado_en: f.creado_en,
      acciones: this.acciones(estado, f.envio),
    };
  }

  private detalle(f: FilaGuia, items: FilaItemGuia[]): GuiaRemisionResponse {
    const form = f.payload.formulario ?? {};
    const hayConductor = [f.conductor_tipo_doc, f.conductor_numero_doc, f.conductor_nombre, f.conductor_licencia].some(Boolean);
    return {
      ...this.resumen(f),
      hora_emision: f.payload.emision?.hora ?? null,
      descripcion_motivo: form.descripcion_motivo ?? null,
      fecha_entrega_transportista: form.fecha_entrega_transportista ?? null,
      peso_bruto_total: f.peso_bruto_total,
      unidad_peso: f.unidad_peso,
      numero_bultos: f.numero_bultos,
      partida: this.punto(f.origen_ubigeo, f.direccion_origen, form.partida_codigo_establecimiento),
      transportista:
        f.transportista_ruc || f.transportista_denominacion || form.registro_mtc
          ? { ruc: f.transportista_ruc, razon_social: f.transportista_denominacion, registro_mtc: form.registro_mtc ?? null }
          : null,
      vehiculo:
        f.placa_principal || f.marca_vehiculo || form.tarjeta_circulacion
          ? { placa: f.placa_principal, tarjeta_circulacion: form.tarjeta_circulacion ?? null, marca: f.marca_vehiculo }
          : null,
      conductor: hayConductor
        ? {
            tipo_documento: f.conductor_tipo_doc,
            numero_documento: f.conductor_numero_doc,
            // Las guías anteriores solo guardaban el nombre completo.
            nombres: form.conductor_nombres ?? (form.conductor_apellidos ? null : f.conductor_nombre),
            apellidos: form.conductor_apellidos ?? null,
            licencia: f.conductor_licencia,
          }
        : null,
      items: items.map((i) => ({
        id_item: i.id_item,
        id_producto: i.id_producto,
        id_venta_detalle: i.id_venta_detalle,
        codigo: i.codigo,
        descripcion: i.descripcion,
        unidad: i.unidad_medida ?? 'NIU',
        cantidad: i.cantidad,
        orden: i.orden,
      })),
      observaciones: f.observaciones,
      sunat: { ticket: f.sunat_ticket, codigo: f.sunat_responsecode, descripcion: f.sunat_description, cadena_qr: f.cadena_qr, codigo_hash: f.codigo_hash },
      envio: f.envio
        ? {
            id_envio: f.envio.id_envio,
            estado: f.envio.estado,
            codigo: f.envio.codigo,
            mensaje: f.envio.mensaje,
            intento: f.envio.intento,
            consultas: f.envio.consultas,
            en_curso: f.envio.en_curso,
            revision_manual: f.envio.revision_manual,
            proximo_intento_en: f.envio.proximo_intento_en,
            actualizado_en: f.envio.actualizado_en,
          }
        : null,
      archivos: f.envio?.archivos ?? [],
      anulacion: f.payload.anulacion ? { motivo: f.payload.anulacion.motivo ?? null, fecha: f.payload.anulacion.fecha } : null,
      avisos: this.avisos(f, items),
    };
  }

  private avisos(f: FilaGuia, items: FilaItemGuia[]): string[] {
    const estado = estadoDe(f.estado);
    const avisos: string[] = [];
    if (estado === 'legacy') avisos.push('Guía registrada antes de la emisión electrónica: solo lectura.');
    if (!items.length && estado !== 'legacy') avisos.push('La guía no tiene bienes registrados.');
    if (estado === 'rechazado' && f.numero) {
      avisos.push(`SUNAT rechazó la guía: corrija los datos y vuelva a emitirla; se reenviará con el mismo número ${numeroFormateado(f.serie, f.numero)}.`);
    }
    if (estado === 'pendiente' && f.envio && !f.envio.en_curso) {
      if (f.envio.estado === 'PENDIENTE_REENVIO' || f.envio.estado === 'ENVIANDO') {
        avisos.push('El último envío quedó sin respuesta segura de SUNAT: use «Emitir» para reenviar el mismo archivo.');
      } else if (f.envio.estado === 'ERROR_CONFIG') {
        avisos.push('No se pudo enviar a SUNAT por la configuración: corríjala en el panel de facturación y vuelva a emitir (se conserva el número).');
      }
    }
    if (estado === 'enviado' && f.envio?.revision_manual) {
      avisos.push('La consulta automática del ticket se detuvo: use «Consultar» o revise la guía en SUNAT Operaciones en Línea.');
    }
    if (estado === 'aceptado' && !f.cadena_qr) {
      avisos.push('SUNAT no entregó el enlace del código QR en la constancia: la representación impresa sale sin QR.');
    }
    return avisos;
  }

  private datosPdf(g: GuiaRemisionResponse, emisor: EmisorCpe, logo: Buffer | null): DatosGuiaRemisionPdf {
    return {
      emisor: {
        ruc: emisor.ruc,
        razonSocial: emisor.razonSocial,
        nombreComercial: emisor.nombreComercial || null,
        direccion: emisor.direccion || null,
        ubicacion: [emisor.distrito, emisor.provincia, emisor.departamento].filter(Boolean).join(' - ') || null,
        logo,
      },
      estado: g.estado,
      numero: g.numero_formateado,
      idGuia: g.id_guia,
      fechaEmision: g.fecha_emision,
      horaEmision: g.hora_emision,
      fechaInicioTraslado: g.fecha_inicio_traslado,
      fechaEntregaTransportista: g.fecha_entrega_transportista,
      motivo: g.motivo_traslado ? { codigo: g.motivo_traslado, nombre: g.motivo_traslado_texto ?? g.motivo_traslado } : null,
      descripcionMotivo: g.descripcion_motivo,
      modalidad: g.modalidad_traslado ? { codigo: g.modalidad_traslado, nombre: g.modalidad_traslado_texto ?? g.modalidad_traslado } : null,
      pesoBrutoTotal: g.peso_bruto_total,
      unidadPeso: g.unidad_peso,
      numeroBultos: g.numero_bultos,
      destinatario: {
        tipoDoc: g.destinatario.tipo_documento,
        tipoDocTexto: g.destinatario.tipo_documento ? (NOMBRE_TIPO_DOCUMENTO[g.destinatario.tipo_documento] ?? null) : null,
        numDoc: g.destinatario.numero_documento,
        nombre: g.destinatario.denominacion,
      },
      partida: { direccion: g.partida.direccion, ubigeo: g.partida.ubigeo_texto, codigoEstablecimiento: g.partida.codigo_establecimiento },
      llegada: { direccion: g.llegada.direccion, ubigeo: g.llegada.ubigeo_texto, codigoEstablecimiento: g.llegada.codigo_establecimiento },
      transportista: g.modalidad_traslado === '01' && g.transportista
        ? { ruc: g.transportista.ruc, razonSocial: g.transportista.razon_social, registroMtc: g.transportista.registro_mtc }
        : null,
      vehiculo: g.modalidad_traslado === '02' && g.vehiculo
        ? { placa: g.vehiculo.placa, tarjetaCirculacion: g.vehiculo.tarjeta_circulacion, marca: g.vehiculo.marca }
        : null,
      conductor: g.modalidad_traslado === '02' && g.conductor
        ? {
            tipoDocTexto: g.conductor.tipo_documento ? (NOMBRE_TIPO_DOCUMENTO[g.conductor.tipo_documento] ?? g.conductor.tipo_documento) : null,
            numDoc: g.conductor.numero_documento,
            nombre: [g.conductor.nombres, g.conductor.apellidos].filter(Boolean).join(' ') || null,
            licencia: g.conductor.licencia,
          }
        : null,
      documentoRelacionado: g.documento_relacionado
        ? { tipo: g.documento_relacionado.tipo_texto, numero: g.documento_relacionado.numero_formateado }
        : null,
      items: g.items.map((i) => ({ codigo: i.codigo, descripcion: i.descripcion, unidad: i.unidad, cantidad: i.cantidad })),
      observaciones: g.observaciones,
      cadenaQr: g.estado === 'aceptado' ? g.sunat.cadena_qr : null,
    };
  }
}
