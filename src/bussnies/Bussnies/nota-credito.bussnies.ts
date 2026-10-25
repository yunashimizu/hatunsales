import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  NotaCreditoRepository,
  CabeceraComprobante,
  DescarteEnvio,
  ItemOrigen,
  LineaNotaVigente,
  NotaDeOrigen,
  NotaReclamada,
  OrigenNota,
  VentaDeNota,
} from '../../repository/Repository/nota-credito.repository';
import { VentaRepository } from '../../repository/Repository/venta.repository';
import { FiscalAuditoriaRepository } from '../../sunat/auditoria/fiscal-auditoria.repository';
import { EmisionDirecta } from '../../sunat/emision/emision.contrato';
import type { ModoEmision } from '../../sunat/emision/emision.contrato';
import { admiteGetStatusCdr } from '../../sunat/nucleo/reglas-envio';
import {
  ETIQUETA_MOTIVO_NOTA_CREDITO,
  esMotivoNotaCredito,
  motivoNotaCreditoValidoParaTipo,
} from '../../sunat/catalogos/sunat.catalogos';
import { calcularComprobante, redondear } from '../../util/fiscal/calculo-fiscal';
import { esComprobantePrincipal, tipoComprobanteSunat } from '../../util/fiscal/tipos-comprobante';
import {
  CODIGO_RECARGO_TARJETA,
  DESCRIPCION_RECARGO_TARJETA,
  repartirRecargoPorAfectacion,
} from '../../util/precios/recargo-tarjeta';
import type { ConsultarComprobanteRequest } from '../../models/model/c-electronico/comprobante.request';
import type { ComprobanteResponse } from '../../models/model/c-electronico/comprobante.response';
import type {
  AnularDocumentoRequest,
  EmitirNotaCreditoRequest,
  ItemNotaCreditoRequest,
} from '../../models/model/c-electronico/nota-credito.request';
import type {
  AnulacionDocumentoResponse,
  AnulacionVentaResponse,
  ConsultaAnulacionResponse,
  ContextoNotaCreditoResponse,
  EstadoAnulacion,
  MotivoNotaCreditoContexto,
  NotaAnulacionResponse,
  NotaCreditoEmitidaResponse,
} from '../../models/model/c-electronico/nota-credito.response';
import type { AnularVentaRequest } from '../../models/model/venta/anular-venta.request';
import { FORMA_MOTIVO_NOTA_CREDITO } from './comprobante.bussnies';
import { EmisorNotasCredito } from './nota-credito.contrato';
import type {
  EfectoNotaCredito,
  GestorNotasCredito,
  LineaNotaCredito,
  ResumenNotasOrigen,
  SolicitudEmisionNotaCredito,
} from './nota-credito.contrato';

/** Motivos que acreditan el comprobante completo (D8): solo sobre un comprobante sin notas vigentes. */
const MOTIVOS_TOTALES: ReadonlySet<string> = new Set(['01', '02', '06']);
/** Motivos cuyas líneas cuentan como unidades devueltas de cada ítem del origen. */
const MOTIVOS_POR_CANTIDAD: ReadonlySet<string> = new Set(['01', '02', '06', '07']);
/** 'ninguno' que igual baja la deuda si la venta fue al crédito (descuento, disminución de valor, otros). */
const MOTIVOS_QUE_BAJAN_DEUDA: ReadonlySet<string> = new Set(['05', '09', '10']);

/** Qué hace el sistema cuando SUNAT acepta la nota (D8). La de «Anular venta» lleva 'anular_venta'. */
export const EFECTO_POR_MOTIVO: Readonly<Record<string, EfectoNotaCredito>> = {
  '01': 'devolucion',
  '02': 'ninguno',
  '05': 'ninguno',
  '06': 'devolucion',
  '07': 'devolucion',
  '09': 'ninguno',
  '10': 'ninguno',
};

const AVISO_MOTIVO: Readonly<Record<string, string>> = {
  '01': 'Anula toda la operación: al aceptarse se reingresa lo vendido y baja la deuda. Para anular también la venta use «Anular venta».',
  '02': 'Deja sin efecto el comprobante por un error en el RUC: cuando SUNAT acepte la nota, emita aparte el comprobante correcto desde la venta.',
};

const ESTADOS_ACEPTADO: ReadonlySet<string> = new Set(['ACEPTADO', 'ACEPTADO_OBS']);
/** Envío de la nota sin respuesta definitiva todavía: otra nota del mismo origen debe esperar. */
const ESTADOS_NOTA_EN_CURSO: ReadonlySet<string> = new Set(['NO_ENVIADO', 'ENVIANDO', 'PENDIENTE_REENVIO']);
/** Estados SUNAT de un comprobante que nunca llegó a valer: se anula en el sistema (D9, rama a). */
const ESTADOS_SIN_VALIDEZ: ReadonlySet<string> = new Set(['RECHAZADO', 'ERROR_CONFIG', 'ANULADO']);
/** getStatusCdr: «El comprobante de pago electrónico no existe» (SUNAT no lo recibió). */
const CODIGO_CONSULTA_NO_EXISTE = '0011';

const DESCRIPCION_RECARGO_DEVOLUCION = `${DESCRIPCION_RECARGO_TARJETA} (devolucion proporcional)`;
const CODIGO_AJUSTE_NOTA = 'AJUSTE-NC';
const AVISO_BETA = 'Prueba SUNAT BETA: sin validez tributaria.';
const ACCION_AUDITORIA_DESCARTE = 'ENVIO_DESCARTADO_POR_ANULACION';
/** modo() no pudo leer la configuración: el ambiente que informa es el de respaldo, no el vigente. */
const CODIGO_LECTURA_ERROR = 'FISCAL_LECTURA_ERROR';

/**
 * El motivo de modo() está escrito para el POS («la venta se registra sin comprobante»): en una nota de
 * crédito o una anulación esa frase confunde, así que se quita y quedan la causa y qué hacer.
 */
export function motivoEmisionInactiva(modo: Extract<ModoEmision, { activo: false }>): string {
  return modo.motivo
    .replace(/[:;]?\s*(?:mientras tanto\s+)?(?:la venta se registra|las ventas se registran) sin comprobante(?: electrónico)?/gi, '')
    .trim();
}

// ── Cálculo de lo acreditable (funciones puras, PLAN V3 D8) ─────────────────

/** Una línea del origen con lo que todavía se puede acreditar de ella. */
export interface ItemAcreditable {
  item: ItemOrigen;
  esRecargo: boolean;
  cantidadAcreditada: number;
  cantidadDisponible: number;
  /** Con IGV; ya incluye la parte de las notas por monto (09/10) que le toca a su tramo de afectación. */
  importeDisponible: number;
}

export interface EstadoAcreditable {
  /** Total del origen menos las notas vigentes. */
  saldo: number;
  hayNotasVigentes: boolean;
  items: ItemAcreditable[];
  /** Saldo por tramo de afectación (1 gravado, 8 exonerado, 9 inafecto), para prorratear 09 y 10. */
  saldoPorTramo: Map<number, number>;
}

export interface PlanNota {
  motivo: string;
  efecto: EfectoNotaCredito;
  reingresar_stock: boolean;
  lineas: LineaNotaCredito[];
  /** Total con IGV, calculado con el mismo motor que la emisión. */
  total: number;
}

export interface SolicitudPlanNota {
  motivo: string;
  items?: ItemNotaCreditoRequest[];
  monto?: number;
  reingresar_stock?: boolean;
}

export type ClaseAnulacion = 'local' | 'nunca_enviado' | 'aceptado' | 'incierto';

function centimos(valor: number): number {
  return Math.round(redondear(Number(valor) || 0) * 100);
}

function soles(centimosValor: number): number {
  return centimosValor / 100;
}

/** Cantidades de comprobante (NUMERIC(10,2)) en centésimas enteras. */
function centesimas(valor: number): number {
  return Math.round((Number(valor) || 0) * 100);
}

function conDosDecimales(valor: number): boolean {
  return Math.abs(valor * 100 - Math.round(valor * 100)) < 1e-6;
}

/** Reparte `total` céntimos en proporción a `pesos` (resto mayor primero); siempre suma exactamente `total`. */
function repartirCentimos(total: number, pesos: number[]): number[] {
  const suma = pesos.reduce((a, b) => a + b, 0);
  if (total <= 0 || suma <= 0) return pesos.map(() => 0);
  const partes = pesos.map((peso, orden) => {
    const exacto = (total * peso) / suma;
    return { orden, entero: Math.floor(exacto), resto: exacto - Math.floor(exacto) };
  });
  let faltan = total - partes.reduce((a, p) => a + p.entero, 0);
  for (const parte of [...partes].sort((a, b) => b.resto - a.resto || a.orden - b.orden)) {
    if (faltan <= 0) break;
    parte.entero += 1;
    faltan -= 1;
  }
  return partes.map((p) => p.entero);
}

export function esRecargoTarjeta(item: Pick<ItemOrigen, 'codigo' | 'id_producto'>): boolean {
  return item.codigo === CODIGO_RECARGO_TARJETA && item.id_producto === null;
}

/** Vigente = cuenta para el saldo: no anulada, sin error y no rechazada por SUNAT (D8). */
export function esNotaVigente(nota: Pick<NotaDeOrigen, 'anulado' | 'estado' | 'estado_sunat'>): boolean {
  return !nota.anulado && nota.estado !== 'error' && nota.estado_sunat !== 'RECHAZADO';
}

export function esNotaEnCurso(nota: Pick<NotaDeOrigen, 'anulado' | 'estado' | 'estado_sunat'>): boolean {
  return esNotaVigente(nota) && ESTADOS_NOTA_EN_CURSO.has(nota.estado_sunat ?? 'NO_ENVIADO');
}

/** La nota anula el origen: total (01/02/06) o la de «Anular venta». */
function esNotaAnuladora(nota: Pick<NotaDeOrigen, 'motivo' | 'efecto'>): boolean {
  return nota.efecto === 'anular_venta' || MOTIVOS_TOTALES.has(nota.motivo ?? '');
}

/**
 * Saldo, unidades e importe disponibles de cada línea del origen con las notas VIGENTES. El importe
 * de una línea descuenta lo que la acreditó por ítem (07, 05 y los totales) y, además, la parte de las
 * notas por monto (09/10, sin ítem) que le toca a su tramo de afectación, repartida en proporción. Así
 * la suma de lo disponible de un tramo nunca supera el saldo del tramo.
 */
export function calcularAcreditable(origen: OrigenNota, notas: NotaDeOrigen[], lineas: LineaNotaVigente[]): EstadoAcreditable {
  const vigentes = notas.filter(esNotaVigente);
  const saldo = Math.max(0, centimos(origen.total) - vigentes.reduce((suma, n) => suma + centimos(n.total), 0));

  const cantidadPorItem = new Map<number, number>();
  const importePorItem = new Map<number, number>();
  const acreditadoPorTramo = new Map<number, number>();
  for (const linea of lineas) {
    acreditadoPorTramo.set(linea.tipo_de_igv, (acreditadoPorTramo.get(linea.tipo_de_igv) ?? 0) + centimos(linea.total));
    if (linea.id_item_origen === null) continue;
    importePorItem.set(linea.id_item_origen, (importePorItem.get(linea.id_item_origen) ?? 0) + centimos(linea.total));
    if (MOTIVOS_POR_CANTIDAD.has(linea.motivo ?? '')) {
      cantidadPorItem.set(linea.id_item_origen, (cantidadPorItem.get(linea.id_item_origen) ?? 0) + centesimas(linea.cantidad));
    }
  }

  const origenPorTramo = new Map<number, number>();
  for (const item of origen.items) {
    origenPorTramo.set(item.tipo_de_igv, (origenPorTramo.get(item.tipo_de_igv) ?? 0) + centimos(item.total));
  }

  const disponibles = origen.items.map((item) => Math.max(0, centimos(item.total) - (importePorItem.get(item.id_item) ?? 0)));
  const saldoPorTramo = new Map<number, number>();
  for (const [tramo, totalTramo] of origenPorTramo) {
    const saldoTramo = Math.max(0, totalTramo - (acreditadoPorTramo.get(tramo) ?? 0));
    saldoPorTramo.set(tramo, soles(saldoTramo));
    const indices = origen.items.map((item, i) => (item.tipo_de_igv === tramo ? i : -1)).filter((i) => i >= 0);
    const enTramo = indices.reduce((suma, i) => suma + disponibles[i], 0);
    const exceso = enTramo - saldoTramo;
    if (exceso <= 0) continue;
    const partes = repartirCentimos(exceso, indices.map((i) => disponibles[i]));
    indices.forEach((i, k) => {
      disponibles[i] = Math.max(0, disponibles[i] - partes[k]);
    });
  }

  const items = origen.items.map((item, i): ItemAcreditable => {
    const recargo = esRecargoTarjeta(item);
    const importe = disponibles[i];
    const cantidadOrigen = centesimas(item.cantidad);
    // El recargo es una sola línea de servicio: se acredita por importe, no por unidades.
    const disponible = recargo ? (importe > 0 ? cantidadOrigen : 0) : Math.max(0, cantidadOrigen - (cantidadPorItem.get(item.id_item) ?? 0));
    return {
      item,
      esRecargo: recargo,
      cantidadAcreditada: (cantidadOrigen - disponible) / 100,
      cantidadDisponible: disponible / 100,
      importeDisponible: soles(importe),
    };
  });

  return { saldo: soles(saldo), hayNotasVigentes: vigentes.length > 0, items, saldoPorTramo };
}

/** Motivos que el comprobante admite hoy (catálogo 09 filtrado por tipo de origen y por lo que queda). */
export function motivosDisponibles(tipoOrigen: '01' | '03', estado: EstadoAcreditable): MotivoNotaCreditoContexto[] {
  const productos = estado.items.filter((i) => !i.esRecargo);
  const hayUnidades = productos.some((i) => i.cantidadDisponible > 0 && i.importeDisponible > 0);
  const hayImporte = productos.some((i) => i.importeDisponible > 0);
  return Object.entries(FORMA_MOTIVO_NOTA_CREDITO)
    .filter(([codigo]) => esMotivoNotaCredito(codigo) && motivoNotaCreditoValidoParaTipo(codigo, tipoOrigen))
    .filter(([, forma]) => {
      if (estado.saldo <= 0) return false;
      if (forma === 'total') return !estado.hayNotasVigentes;
      if (forma === 'items') return hayUnidades;
      if (forma === 'descuento_items') return hayImporte;
      return true;
    })
    .map(([codigo, forma]) => {
      const efecto = EFECTO_POR_MOTIVO[codigo] ?? 'ninguno';
      return {
        codigo,
        nombre: ETIQUETA_MOTIVO_NOTA_CREDITO[codigo as keyof typeof ETIQUETA_MOTIVO_NOTA_CREDITO],
        forma,
        efecto,
        reingresar_stock: efecto === 'devolucion' ? true : null,
        aviso: AVISO_MOTIVO[codigo] ?? null,
      };
    })
    .sort((a, b) => a.codigo.localeCompare(b.codigo));
}

function lineaDesdeItem(item: ItemOrigen, cambios: Partial<LineaNotaCredito> = {}): LineaNotaCredito {
  return {
    id_item_origen: item.id_item,
    id_producto: item.id_producto ?? undefined,
    codigo: item.codigo ?? undefined,
    codigo_producto_sunat: item.codigo_producto_sunat ?? undefined,
    unidad_de_medida: item.unidad_de_medida,
    descripcion: item.descripcion,
    cantidad: item.cantidad,
    precio_unitario: item.precio_unitario,
    descuento: item.descuento,
    tipo_de_igv: item.tipo_de_igv,
    ...cambios,
  };
}

function totalDeLineas(lineas: LineaNotaCredito[], porcentajeIgv: number): number {
  if (!lineas.length) return 0;
  return calcularComprobante(
    lineas.map((l) => ({ cantidad: Number(l.cantidad) || 0, precio_unitario: l.precio_unitario ?? 0, descuento: l.descuento ?? 0, tipo_de_igv: l.tipo_de_igv })),
    porcentajeIgv,
  ).total;
}

function buscarAcreditable(estado: EstadoAcreditable, idItem: number, vistos: Set<number>): ItemAcreditable {
  const acreditable = estado.items.find((i) => i.item.id_item === Number(idItem));
  if (!acreditable) throw new BadRequestException(`El ítem ${idItem} no pertenece al comprobante que se corrige.`);
  if (vistos.has(acreditable.item.id_item)) {
    throw new BadRequestException(`«${acreditable.item.descripcion}» está repetido en la nota: indíquelo una sola vez.`);
  }
  if (acreditable.esRecargo) {
    throw new BadRequestException('El recargo por pago con tarjeta no se elige: se acredita solo, en proporción a lo devuelto.');
  }
  vistos.add(acreditable.item.id_item);
  return acreditable;
}

/** Devolución de unidades (07): cada línea acredita la parte proporcional de lo que queda de ella. */
function lineasDevolucion(estado: EstadoAcreditable, pedidos: ItemNotaCreditoRequest[]): { lineas: LineaNotaCredito[]; devuelto: number; agotados: Set<number> } {
  const vistos = new Set<number>();
  const agotados = new Set<number>();
  const lineas: LineaNotaCredito[] = [];
  let devuelto = 0;
  for (const pedido of pedidos) {
    const acreditable = buscarAcreditable(estado, pedido.id_item, vistos);
    const { item } = acreditable;
    const cantidad = Number(pedido.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      throw new BadRequestException(`Indique cuántas unidades de «${item.descripcion}» se devuelven.`);
    }
    if (!conDosDecimales(cantidad)) throw new BadRequestException(`La cantidad de «${item.descripcion}» admite hasta 2 decimales.`);
    if (centesimas(cantidad) > centesimas(acreditable.cantidadDisponible)) {
      throw new BadRequestException(
        `De «${item.descripcion}» quedan ${acreditable.cantidadDisponible} unidad(es) por devolver y se pidió ${cantidad}.`,
      );
    }
    if (acreditable.importeDisponible <= 0) throw new BadRequestException(`«${item.descripcion}» ya se acreditó por completo.`);

    const disponible = centimos(acreditable.importeDisponible);
    const todo = centesimas(cantidad) === centesimas(acreditable.cantidadDisponible);
    const bruto = centimos(item.precio_unitario * cantidad);
    const acreditado = Math.min(bruto, todo ? disponible : Math.round((disponible * cantidad) / acreditable.cantidadDisponible));
    lineas.push(lineaDesdeItem(item, { cantidad, descuento: soles(bruto - acreditado) }));
    devuelto += acreditado;
    if (todo || acreditado >= disponible) agotados.add(item.id_item);
  }
  return { lineas, devuelto, agotados };
}

/**
 * Recargo por tarjeta en una devolución (D8): una línea por cada recargo del origen, en proporción a lo
 * devuelto frente al total de productos. Si con esta nota ya no queda ningún producto por acreditar, va
 * todo lo que falta del recargo (así la última devolución cierra el saldo al céntimo).
 */
function lineasRecargo(estado: EstadoAcreditable, devuelto: number, agotados: Set<number>): LineaNotaCredito[] {
  const productos = estado.items.filter((i) => !i.esRecargo);
  const totalProductos = productos.reduce((suma, i) => suma + centimos(i.item.total), 0);
  const cierra = productos.every(
    (i) => agotados.has(i.item.id_item) || i.cantidadDisponible <= 0 || i.importeDisponible <= 0,
  );
  return estado.items
    .filter((i) => i.esRecargo && i.importeDisponible > 0)
    .map((recargo) => {
      const disponible = centimos(recargo.importeDisponible);
      const proporcional = totalProductos > 0 ? Math.round((centimos(recargo.item.total) * devuelto) / totalProductos) : 0;
      return { recargo, monto: cierra ? disponible : Math.min(disponible, proporcional) };
    })
    .filter(({ monto }) => monto > 0)
    .map(({ recargo, monto }) =>
      lineaDesdeItem(recargo.item, {
        descripcion: DESCRIPCION_RECARGO_DEVOLUCION,
        cantidad: 1,
        precio_unitario: soles(monto),
        descuento: 0,
        id_producto: undefined,
      }),
    );
}

/** Descuento por ítem (05, solo facturas): una línea de importe por cada ítem descontado. */
function lineasDescuento(estado: EstadoAcreditable, pedidos: ItemNotaCreditoRequest[]): LineaNotaCredito[] {
  const vistos = new Set<number>();
  return pedidos.map((pedido) => {
    const acreditable = buscarAcreditable(estado, pedido.id_item, vistos);
    const { item } = acreditable;
    const descuento = Number(pedido.descuento);
    if (!Number.isFinite(descuento) || descuento <= 0) {
      throw new BadRequestException(`Indique el descuento de «${item.descripcion}».`);
    }
    if (!conDosDecimales(descuento)) throw new BadRequestException(`El descuento de «${item.descripcion}» admite hasta 2 decimales.`);
    if (centimos(descuento) > centimos(acreditable.importeDisponible)) {
      throw new BadRequestException(
        `El descuento de «${item.descripcion}» no puede superar ${acreditable.importeDisponible.toFixed(2)} (lo que queda por acreditar de esa línea).`,
      );
    }
    return lineaDesdeItem(item, {
      descripcion: `DESCUENTO - ${item.descripcion}`,
      cantidad: 1,
      precio_unitario: redondear(descuento),
      descuento: 0,
    });
  });
}

/** Disminución en el valor (09) u otros conceptos (10): una línea de ajuste por tramo de afectación, prorrateada. */
function lineasMonto(estado: EstadoAcreditable, motivo: string, monto: number | undefined): LineaNotaCredito[] {
  const importe = Number(monto);
  if (!Number.isFinite(importe) || importe <= 0) throw new BadRequestException('Indique el monto que acredita la nota.');
  if (!conDosDecimales(importe)) throw new BadRequestException('El monto admite hasta 2 decimales.');
  if (centimos(importe) > centimos(estado.saldo)) {
    throw new BadRequestException(`El monto supera el saldo que todavía se puede acreditar (${estado.saldo.toFixed(2)}).`);
  }
  const tramos = repartirRecargoPorAfectacion(
    [...estado.saldoPorTramo].map(([tipo_de_igv, total]) => ({ tipo_de_igv, total })),
    importe,
  );
  const etiqueta = ETIQUETA_MOTIVO_NOTA_CREDITO[motivo as keyof typeof ETIQUETA_MOTIVO_NOTA_CREDITO];
  return tramos.map((tramo) => ({
    id_item_origen: null,
    codigo: CODIGO_AJUSTE_NOTA,
    unidad_de_medida: 'ZZ',
    descripcion: etiqueta,
    cantidad: 1,
    precio_unitario: tramo.monto,
    descuento: 0,
    tipo_de_igv: tramo.tipo_de_igv,
  }));
}

function exigirTotalCabe(total: number, estado: EstadoAcreditable): void {
  if (total <= 0) throw new BadRequestException('La nota de crédito debe acreditar un importe mayor a cero.');
  if (centimos(total) > centimos(estado.saldo)) {
    throw new BadRequestException({
      message: `La nota sumaría ${total.toFixed(2)} y lo que todavía se puede acreditar del comprobante es ${estado.saldo.toFixed(2)}. Ajuste las cantidades o el monto.`,
      codigo: 'FISCAL_NOTA_EXCEDE_MONTO',
    });
  }
}

/** Arma las líneas de la nota que pide el usuario (D8). Lanza 400/409 con mensajes para el asistente. */
export function planificarNota(origen: OrigenNota, estado: EstadoAcreditable, solicitud: SolicitudPlanNota): PlanNota {
  const motivo = String(solicitud.motivo ?? '').trim();
  const forma = FORMA_MOTIVO_NOTA_CREDITO[motivo];
  const efecto = EFECTO_POR_MOTIVO[motivo];
  if (!forma || !efecto) throw new BadRequestException(`El motivo "${motivo}" no está disponible para notas de crédito.`);
  const reingresar = efecto === 'devolucion' && solicitud.reingresar_stock !== false;

  let lineas: LineaNotaCredito[];
  if (forma === 'total') {
    if (estado.hayNotasVigentes) {
      throw new ConflictException({
        message: 'El comprobante ya tiene notas de crédito vigentes: los motivos 01, 02 y 06 solo se usan sobre un comprobante sin notas. Use la devolución por ítem (07) para lo que queda.',
        codigo: 'NOTA_CREDITO_TOTAL_NO_PERMITIDA',
      });
    }
    lineas = origen.items.map((item) => lineaDesdeItem(item));
  } else if (forma === 'items') {
    if (!solicitud.items?.length) throw new BadRequestException('Indique los ítems y las unidades que se devuelven.');
    const devolucion = lineasDevolucion(estado, solicitud.items);
    lineas = [...devolucion.lineas, ...lineasRecargo(estado, devolucion.devuelto, devolucion.agotados)];
  } else if (forma === 'descuento_items') {
    if (!solicitud.items?.length) throw new BadRequestException('Indique los ítems y el descuento de cada uno.');
    lineas = lineasDescuento(estado, solicitud.items);
  } else {
    lineas = lineasMonto(estado, motivo, solicitud.monto);
  }

  // El inventario se lleva en unidades enteras: una fracción no se puede reingresar.
  if (reingresar && origen.id_venta) {
    const fraccion = lineas.find((l) => l.id_producto !== undefined && !Number.isInteger(Number(l.cantidad)));
    if (fraccion) {
      throw new BadRequestException(
        `«${fraccion.descripcion}» se devolvería con ${fraccion.cantidad} unidades y el stock se lleva en unidades enteras. Devuelva unidades completas o indique reingresar_stock = false.`,
      );
    }
  }

  const total = totalDeLineas(lineas, origen.porcentaje_igv);
  exigirTotalCabe(total, estado);
  return { motivo, efecto, reingresar_stock: reingresar, lineas, total };
}

/**
 * Nota que anula el comprobante (D9, rama c): 01 TOTAL si no tiene notas vigentes; si ya las tiene, 07
 * con todo lo que queda (y el resto del recargo). null si ya no queda nada por acreditar.
 */
export function planificarAnulacion(origen: OrigenNota, estado: EstadoAcreditable): PlanNota | null {
  if (estado.saldo <= 0) return null;
  let motivo = '01';
  let lineas: LineaNotaCredito[];
  if (!estado.hayNotasVigentes) {
    lineas = origen.items.map((item) => lineaDesdeItem(item));
  } else {
    motivo = '07';
    const pedidos = estado.items
      .filter((i) => !i.esRecargo && i.cantidadDisponible > 0 && i.importeDisponible > 0)
      .map((i) => ({ id_item: i.item.id_item, cantidad: i.cantidadDisponible }));
    const devolucion = lineasDevolucion(estado, pedidos);
    lineas = [...devolucion.lineas, ...lineasRecargo(estado, devolucion.devuelto, devolucion.agotados)];
  }
  const total = totalDeLineas(lineas, origen.porcentaje_igv);
  if (total <= 0) return null;
  exigirTotalCabe(total, estado);
  return { motivo, efecto: 'anular_venta', reingresar_stock: false, lineas, total };
}

/** Mismas líneas (ítem de origen, cantidad, precio, descuento y afectación): la nota sigue cabiendo igual. */
function mismoPlan(a: PlanNota, b: PlanNota): boolean {
  if (a.motivo !== b.motivo || a.lineas.length !== b.lineas.length || centimos(a.total) !== centimos(b.total)) return false;
  return a.lineas.every((linea, i) => {
    const otra = b.lineas[i];
    return linea.id_item_origen === otra.id_item_origen
      && centesimas(Number(linea.cantidad)) === centesimas(Number(otra.cantidad))
      && centimos(linea.precio_unitario ?? 0) === centimos(otra.precio_unitario ?? 0)
      && centimos(linea.descuento ?? 0) === centimos(otra.descuento ?? 0)
      && linea.tipo_de_igv === otra.tipo_de_igv;
  });
}

/**
 * Qué rama de D9 le toca a un comprobante principal no anulado: 'local' (histórico, de BETA cuando rige
 * producción, o de otro ambiente), 'nunca_enviado' (sin envío, rechazado, error de configuración o
 * EXCEPCION por un error de formato 1xxx), 'aceptado' (aceptado en el ambiente vigente) o 'incierto'.
 */
export function clasificarParaAnular(c: CabeceraComprobante, ambienteVigente: string): ClaseAnulacion {
  if (c.proveedor_fiscal !== 'sunat_directo' || c.ambiente_fiscal !== ambienteVigente) return 'local';
  const estado = c.estado_sunat ?? 'NO_ENVIADO';
  if (c.aceptada_sunat && ESTADOS_ACEPTADO.has(estado)) return 'aceptado';
  if (!c.id_envio_ultimo || estado === 'NO_ENVIADO' || ESTADOS_SIN_VALIDEZ.has(estado)) return 'nunca_enviado';
  const codigo = Number(c.envio?.codigo);
  if (estado === 'EXCEPCION' && Number.isInteger(codigo) && codigo >= 100 && codigo <= 1999) return 'nunca_enviado';
  return 'incierto';
}

/** Resultado del trabajo sobre los comprobantes de una anulación (venta o comprobante suelto). */
interface ResultadoAnulacion {
  estado: EstadoAnulacion;
  nota?: NotaAnulacionResponse;
  comprobantes_anulados: { id_comprobante: number; numero_formateado: string }[];
  stock_devuelto: boolean;
  cxc_cerradas: number;
  venta_anulada: boolean;
  avisos: string[];
}

/** Comprobante de la venta que no hay que anular en SUNAT: se anula en el sistema junto con la venta. */
interface SinValidez {
  comprobante: CabeceraComprobante;
  /** Histórico o de otro ambiente (no se anula en SUNAT desde aquí); si no, nunca fue aceptado por SUNAT. */
  local: boolean;
}

type DecisionIncierto =
  | { clase: 'aceptado' }
  | { clase: 'nunca_enviado' }
  | { clase: 'descartar'; descarte: DescarteEnvio };

/** Lo que dejaron los efectos de una nota aceptada (para el log y las pruebas). */
export interface EfectosAplicados {
  id_nota: number;
  efecto: string;
  unidades_reingresadas: number;
  deuda_descontada: number;
  venta_anulada: boolean;
  origen_anulado: boolean;
}

/**
 * Negocio de las notas de crédito (PLAN V3, D8 y D9).
 *
 * Decide QUÉ se acredita (motivo, ítems, saldo, recargo, stock) y entrega la nota armada al motor de
 * comprobantes (EmisorNotasCredito), que la numera, firma, guarda y envía en una sola transacción. Los
 * efectos (stock, cuenta por cobrar, anulación de la venta) se aplican SOLO cuando SUNAT la acepta, una
 * sola vez, desde el oyente de envíos o el barrido de EfectosNotasTarea. También resuelve «Anular venta»
 * y la anulación desde Documentos con las ramas a/b/c/d de D9: nunca borra un comprobante.
 */
@Injectable()
export class NotaCreditoBussnies implements OnModuleInit, GestorNotasCredito {

  private readonly logger = new Logger(NotaCreditoBussnies.name);

  constructor(
    private readonly repo: NotaCreditoRepository,
    private readonly ventas: VentaRepository,
    private readonly emisor: EmisorNotasCredito,
    private readonly emision: EmisionDirecta,
    private readonly auditoria: FiscalAuditoriaRepository,
  ) {}

  /** El motor de comprobantes delega aquí la anulación desde Documentos y el saldo de cada comprobante. */
  onModuleInit(): void {
    this.emisor.registrarGestorNotas?.(this);
  }

  // ── Contexto del asistente ───────────────────────────────────

  async contexto(idComprobante: number): Promise<ContextoNotaCreditoResponse> {
    await this.exigirEsquema();
    const origen = await this.repo.origen(idComprobante);
    if (!origen) throw new NotFoundException('No existe el comprobante que se quiere corregir con la nota de crédito.');

    const [modo, notas, lineas, venta] = await Promise.all([
      this.emision.modo(),
      this.repo.notasDeOrigen(idComprobante),
      this.repo.lineasVigentes(idComprobante),
      origen.id_venta ? this.repo.ventaDeNota(origen.id_venta) : Promise.resolve(null),
    ]);
    const tipo = tipoComprobanteSunat(origen.id_tipo);
    const estado = calcularAcreditable(origen, notas, lineas);
    const enCurso = notas.find(esNotaEnCurso);
    const motivoNoPermitido =
      this.motivoNoAdmitido(origen, modo)?.mensaje
      ?? (enCurso ? `La nota ${this.numero(enCurso.serie, enCurso.numero)} todavía se está enviando a SUNAT: espere su resultado antes de emitir otra.` : null)
      ?? (estado.saldo <= 0 ? `${this.numeroDe(origen)} ya se acreditó por completo con notas de crédito.` : null);

    return {
      permitido: !motivoNoPermitido,
      ...(motivoNoPermitido ? { motivo_no_permitido: motivoNoPermitido } : {}),
      origen: {
        id: origen.id_comprobante,
        tipo: tipo ?? '',
        serie: origen.serie,
        numero: origen.numero,
        numero_formateado: this.numeroDe(origen),
        fecha: origen.fecha_de_emision,
        cliente: {
          tipo_documento: origen.cliente_tipo_doc,
          numero_documento: origen.cliente_numero_doc,
          denominacion: origen.cliente_denominacion,
        },
        moneda: origen.id_moneda === 2 ? 'USD' : 'PEN',
        total: origen.total,
        ambiente_fiscal: origen.ambiente_fiscal,
        estado_sunat: origen.estado_sunat,
      },
      saldo: estado.saldo,
      items: estado.items.map((i) => ({
        id_item: i.item.id_item,
        id_producto: i.item.id_producto,
        codigo: i.item.codigo,
        descripcion: i.item.descripcion,
        unidad: i.item.unidad_de_medida,
        tipo_de_igv: i.item.tipo_de_igv,
        cantidad_origen: i.item.cantidad,
        cantidad_acreditada: i.cantidadAcreditada,
        cantidad_disponible: i.cantidadDisponible,
        precio_unitario: i.item.precio_unitario,
        descuento_unitario: i.item.cantidad > 0 ? redondear(i.item.descuento / i.item.cantidad, 4) : 0,
        total_origen: i.item.total,
        importe_disponible: i.importeDisponible,
        es_recargo: i.esRecargo,
      })),
      motivos: tipo === '01' || tipo === '03' ? motivosDisponibles(tipo, estado) : [],
      notas_previas: notas.map((n) => ({
        id: n.id_comprobante,
        serie: n.serie,
        numero: n.numero,
        numero_formateado: this.numero(n.serie, n.numero),
        motivo: n.motivo,
        total: n.total,
        estado_sunat: n.estado_sunat,
        vigente: esNotaVigente(n),
        en_curso: esNotaEnCurso(n),
      })),
      ...(venta
        ? {
            venta: {
              id: venta.id_venta,
              estado: venta.estado,
              a_credito: venta.a_credito,
              saldo_cxc: venta.saldo_cxc,
              pagada_al_contado: venta.contado > 0,
            },
          }
        : {}),
      avisos: this.avisosDeContexto(origen, notas, venta),
    };
  }

  // ── Emitir ───────────────────────────────────────────────────

  async emitir(idComprobante: number, dto: EmitirNotaCreditoRequest, idUsuario: number | null): Promise<NotaCreditoEmitidaResponse> {
    await this.exigirEsquema();
    const motivo = String(dto?.motivo ?? '').trim();
    if (!FORMA_MOTIVO_NOTA_CREDITO[motivo] || !esMotivoNotaCredito(motivo)) {
      throw new BadRequestException(
        `El motivo "${motivo}" no está disponible para notas de crédito (se admiten ${Object.keys(FORMA_MOTIVO_NOTA_CREDITO).join(', ')}).`,
      );
    }
    const sustento = this.limpiar(dto?.sustento);
    if (sustento.length < 3 || sustento.length > 250) {
      throw new BadRequestException('El sustento de la nota de crédito debe tener entre 3 y 250 caracteres.');
    }

    const origen = await this.repo.origen(idComprobante);
    if (!origen) throw new NotFoundException('No existe el comprobante que se quiere corregir con la nota de crédito.');
    const tipo = tipoComprobanteSunat(origen.id_tipo);
    if (tipo === '01' || tipo === '03') {
      if (!motivoNotaCreditoValidoParaTipo(motivo, tipo)) {
        throw new BadRequestException(
          `El motivo ${motivo} (${ETIQUETA_MOTIVO_NOTA_CREDITO[motivo as keyof typeof ETIQUETA_MOTIVO_NOTA_CREDITO]}) solo se puede usar sobre facturas, no sobre boletas.`,
        );
      }
    }
    const modo = await this.emision.modo();
    this.exigirAdmitido(origen, modo);

    const [notas, lineas, venta] = await Promise.all([
      this.repo.notasDeOrigen(idComprobante),
      this.repo.lineasVigentes(idComprobante),
      origen.id_venta ? this.repo.ventaDeNota(origen.id_venta) : Promise.resolve(null),
    ]);
    this.exigirSinNotaEnCurso(origen, notas);
    const solicitud: SolicitudPlanNota = { motivo, items: dto.items, monto: dto.monto, reingresar_stock: dto.reingresar_stock };
    const estado = calcularAcreditable(origen, notas, lineas);
    const plan = planificarNota(origen, estado, solicitud);

    // Se emite en el acto: la respuesta ya trae lo que dijo SUNAT (aceptada, rechazada o en envío).
    const respuesta = await this.emitirPlan(origen, plan, sustento, idUsuario, (o, e) => planificarNota(o, e, solicitud));
    const efectosAplicados = respuesta.aceptada_sunat === true && !!respuesta.id_comprobante
      && (await this.efectosSinFallar(respuesta.id_comprobante, respuesta.numero_formateado ?? ''));
    return {
      ...respuesta,
      // Si el envío no terminó (caída tras el COMMIT) el motor no trae acción ni observaciones de SUNAT.
      accion_sunat: respuesta.accion_sunat ?? null,
      sunat_observaciones: respuesta.sunat_observaciones ?? [],
      efecto: plan.efecto,
      efectos_aplicados: efectosAplicados,
      avisos: this.avisosDeEmision(origen, plan, venta, respuesta, efectosAplicados),
    };
  }

  // ── Efectos al aceptarse (D8) ────────────────────────────────

  /**
   * Aplica UNA vez los efectos de una nota aceptada: reclama la nota (efectos_aplicados = true) en la
   * MISMA transacción que mueve stock, deuda y anulación; si algo falla se revierte todo y el barrido lo
   * reintenta. null si no había nada que aplicar (no aceptada, ya aplicada o sin la migración).
   */
  async aplicarEfectos(idNota: number): Promise<EfectosAplicados | null> {
    if (!(await this.repo.esquemaListo())) return null;
    const resultado = await this.repo.transaccion(async (tx) => {
      const nota = await this.repo.reclamarEfectos(tx, idNota);
      if (!nota) return null;
      return this.efectosDe(tx, nota);
    });
    if (resultado) {
      this.logger.log(
        `Efectos de la nota ${idNota} aplicados (${resultado.efecto}): ${resultado.unidades_reingresadas} unidad(es) reingresadas, `
          + `deuda -${resultado.deuda_descontada.toFixed(2)}${resultado.venta_anulada ? ', venta anulada' : ''}${resultado.origen_anulado ? ', comprobante origen anulado' : ''}.`,
      );
    }
    return resultado;
  }

  /** Notas aceptadas cuyos efectos siguen pendientes (las recorre el barrido). */
  async notasConEfectosPendientes(limite: number): Promise<number[]> {
    if (!(await this.repo.esquemaListo())) return [];
    return this.repo.notasConEfectosPendientes(limite);
  }

  /** GestorNotasCredito: saldo acreditable y notas en curso por comprobante (acciones de Documentos). */
  resumenes(idsOrigen: number[]): Promise<Map<number, ResumenNotasOrigen>> {
    return this.repo.resumenes(idsOrigen);
  }

  // ── Anular venta y anular comprobante (D9) ───────────────────

  async anularVenta(idVenta: number, dto: AnularVentaRequest = {}, idUsuario: number | null = null): Promise<AnulacionVentaResponse> {
    const venta = await this.repo.ventaDeNota(idVenta);
    if (!venta) throw new NotFoundException(`No existe la venta ${idVenta}`);
    if (venta.estado.trim().toLowerCase() === 'anulada') {
      return {
        estado: 'anulada',
        id_venta: idVenta,
        anulada: true,
        ya_anulada: true,
        comprobantes_anulados: [],
        stock_devuelto: false,
        cxc_cerradas: 0,
        avisos: [`La venta ${idVenta} ya estaba anulada.`],
      };
    }
    const comprobantes = (await this.repo.principalesDeVenta(idVenta)).filter((c) => !c.anulado);
    const resultado = await this.anularDocumentos(comprobantes, venta, dto, idUsuario);
    return {
      estado: resultado.estado,
      id_venta: idVenta,
      anulada: resultado.estado === 'anulada',
      ...(resultado.nota ? { nota: resultado.nota } : {}),
      comprobantes_anulados: resultado.comprobantes_anulados,
      stock_devuelto: resultado.stock_devuelto,
      cxc_cerradas: resultado.cxc_cerradas,
      avisos: resultado.avisos,
    };
  }

  /** POST /comprobante/anular: D9 sobre el comprobante; si tiene una venta activa, se anula la venta. */
  async anularComprobante(dto: AnularDocumentoRequest, idUsuario: number | null): Promise<AnulacionDocumentoResponse> {
    const id = await this.idComprobanteDe(dto);
    const comprobante = await this.repo.origen(id);
    if (!comprobante) throw new NotFoundException('No existe el comprobante que se quiere anular.');
    const numero = this.numeroDe(comprobante);
    if (!esComprobantePrincipal(comprobante.id_tipo)) {
      throw new BadRequestException(
        `${numero} es una nota: las notas no se anulan desde aquí. Si SUNAT la rechazó no tiene efecto; si fue aceptada, corrija con un nuevo comprobante.`,
      );
    }
    const base = { id_comprobante: comprobante.id_comprobante, numero_formateado: numero, numero: comprobante.numero, id_venta: comprobante.id_venta };
    const venta = comprobante.id_venta ? await this.repo.ventaDeNota(comprobante.id_venta) : null;
    if (comprobante.anulado) {
      const aviso = `${numero} ya estaba anulado.`;
      return { ...base, estado: 'anulada', aceptada_sunat: true, sunat_description: aviso, venta_estado: venta?.estado ?? null, avisos: [aviso] };
    }

    const opciones = { motivo: dto.motivo, confirmar_verificado_sol: dto.confirmar_verificado_sol, existe_en_sunat: dto.existe_en_sunat, nota: dto.nota };
    // Con la venta activa se anula la venta completa; si ya estaba anulada (anulación antigua), solo el comprobante.
    const ventaActiva = venta && venta.estado.trim().toLowerCase() !== 'anulada' ? venta : null;
    const resultado = ventaActiva
      ? await this.anularDocumentos(
          (await this.repo.principalesDeVenta(ventaActiva.id_venta)).filter((c) => !c.anulado),
          ventaActiva,
          opciones,
          idUsuario,
        )
      : await this.anularDocumentos([comprobante], null, opciones, idUsuario);

    const ventaEstado = !venta ? null : (resultado.venta_anulada || !ventaActiva) ? 'anulada' : venta.estado;
    return {
      ...base,
      estado: resultado.estado,
      aceptada_sunat: resultado.estado === 'anulada',
      sunat_description: resultado.avisos[0],
      venta_estado: ventaEstado,
      ...(resultado.nota ? { nota: resultado.nota } : {}),
      avisos: resultado.avisos,
    };
  }

  /** POST /comprobante/consultar-anulacion: estado de la anulación del comprobante, sin llamar a SUNAT. */
  async consultarAnulacion(dto: ConsultarComprobanteRequest): Promise<ConsultaAnulacionResponse> {
    const serie = String(dto?.serie ?? '').trim().toUpperCase();
    const numeroDoc = Number(dto?.numero);
    if (!serie || !Number.isInteger(numeroDoc) || numeroDoc <= 0) {
      throw new BadRequestException('Indique la serie y el número del comprobante a consultar.');
    }
    const id = await this.repo.idPorSerieNumero(serie, numeroDoc, dto.tipo_de_comprobante ? Number(dto.tipo_de_comprobante) : undefined);
    const comprobante = id ? await this.repo.origen(id) : null;
    if (!comprobante) throw new NotFoundException(`No existe el comprobante ${this.numero(serie, numeroDoc)} en el sistema.`);
    const numero = this.numeroDe(comprobante);
    const base = { id_comprobante: comprobante.id_comprobante, numero_formateado: numero, numero: comprobante.numero };

    const anuladora = [...(await this.repo.notasDeOrigen(comprobante.id_comprobante))]
      .reverse()
      .find((n) => esNotaAnuladora(n) && (esNotaVigente(n) || n.estado_sunat === 'RECHAZADO'));
    if (comprobante.anulado) {
      const aviso = anuladora ? `${numero} está anulado con la nota ${this.numero(anuladora.serie, anuladora.numero)}.` : `${numero} está anulado.`;
      return { ...base, estado: 'anulada', aceptada_sunat: true, sunat_description: aviso, ...(anuladora ? { nota: this.notaDeOrigenARespuesta(anuladora) } : {}), avisos: [aviso] };
    }
    if (!anuladora) {
      const aviso = `${numero} no tiene una anulación registrada.`;
      return { ...base, estado: 'sin_anulacion', aceptada_sunat: false, sunat_description: aviso, avisos: [aviso] };
    }

    const notaNumero = this.numero(anuladora.serie, anuladora.numero);
    if (anuladora.aceptada_sunat && ESTADOS_ACEPTADO.has(anuladora.estado_sunat ?? '')) {
      // Si el oyente no alcanzó a aplicar los efectos (caída), se aplican ahora: es idempotente.
      if (anuladora.efectos_aplicados || (await this.efectosSinFallar(anuladora.id_comprobante, notaNumero))) {
        const aviso = `SUNAT aceptó la nota ${notaNumero}: ${numero} quedó anulado.`;
        return { ...base, estado: 'anulada', aceptada_sunat: true, sunat_description: aviso, nota: this.notaDeOrigenARespuesta(anuladora), avisos: [aviso] };
      }
      const aviso = this.avisoEfectosPendientes(notaNumero);
      return { ...base, estado: 'anulacion_en_curso', aceptada_sunat: false, sunat_description: aviso, nota: this.notaDeOrigenARespuesta(anuladora), avisos: [aviso] };
    }
    if (anuladora.estado_sunat === 'RECHAZADO') {
      const aviso = `SUNAT rechazó la nota ${notaNumero}${anuladora.mensaje ? ` (${anuladora.mensaje})` : ''}: ${numero} sigue vigente.`;
      return { ...base, estado: 'anulacion_rechazada', aceptada_sunat: false, sunat_description: aviso, nota: this.notaDeOrigenARespuesta(anuladora), avisos: [aviso] };
    }
    const aviso = `La nota ${notaNumero} sigue en envío a SUNAT: ${numero} se anulará cuando la acepte. Revise su estado en Documentos.`;
    return { ...base, estado: 'anulacion_en_curso', aceptada_sunat: false, sunat_description: aviso, nota: this.notaDeOrigenARespuesta(anuladora), avisos: [aviso] };
  }

  // ── D9: ramas a/b/c/d ────────────────────────────────────────

  /**
   * Anula una venta (con sus facturas/boletas) o un comprobante suelto. Primero resuelve los envíos
   * inciertos (d); si queda un comprobante aceptado del ambiente vigente, lo anula con nota de crédito
   * (c) y la venta se anula cuando SUNAT la acepte; si no, anula todo en el sistema (a/b), en una sola
   * transacción.
   */
  private async anularDocumentos(
    comprobantes: CabeceraComprobante[],
    venta: VentaDeNota | null,
    dto: AnularVentaRequest,
    idUsuario: number | null,
  ): Promise<ResultadoAnulacion> {
    const modo = await this.emision.modo();
    // Sin leer la configuración no se sabe el ambiente vigente: anular en el sistema un comprobante que
    // SUNAT sí aceptó dejaría la venta anulada y el comprobante vigente en SUNAT. No se toca nada.
    if (!modo.activo && modo.codigo === CODIGO_LECTURA_ERROR && comprobantes.some((c) => c.proveedor_fiscal === 'sunat_directo')) {
      throw new ServiceUnavailableException({ message: `No se anuló nada. ${motivoEmisionInactiva(modo)}`, codigo: modo.codigo });
    }
    const descartes: DescarteEnvio[] = [];
    const aceptados: CabeceraComprobante[] = [];
    const sinValidez: SinValidez[] = [];
    const avisos: string[] = [];

    for (const c of comprobantes) {
      let clase = clasificarParaAnular(c, modo.ambiente);
      if (clase === 'incierto') {
        const decision = await this.resolverIncierto(c, venta, dto, idUsuario);
        if (decision.clase === 'descartar') {
          descartes.push(decision.descarte);
          avisos.push(`${this.numeroDe(c)} no existe en SUNAT: se descartó su envío (no se volverá a enviar) y se anuló en el sistema.`);
          continue;
        }
        clase = decision.clase;
      }
      if (clase === 'aceptado') aceptados.push(c);
      else sinValidez.push({ comprobante: c, local: clase === 'local' });
    }

    if (aceptados.length > 1) {
      throw new ConflictException({
        message: `La venta tiene más de un comprobante aceptado por SUNAT (${aceptados.map((c) => this.numeroDe(c)).join(', ')}): anúlelos uno por uno desde Documentos.`,
        codigo: 'ANULACION_VARIOS_ACEPTADOS',
      });
    }
    if (aceptados.length === 1) {
      return this.anularConNota(aceptados[0], venta, dto, idUsuario, sinValidez, descartes);
    }
    return this.anularEnSistema(comprobantes, venta, dto, descartes, [...avisos, ...sinValidez.map((s) => this.avisoSinValidez(s, true))], idUsuario);
  }

  /** Ramas a/b (y d resuelta como inexistente): todo en el sistema, en UNA transacción, sin tocar SUNAT. */
  private async anularEnSistema(
    comprobantes: CabeceraComprobante[],
    venta: VentaDeNota | null,
    dto: AnularVentaRequest,
    descartes: DescarteEnvio[],
    avisos: string[],
    idUsuario: number | null,
  ): Promise<ResultadoAnulacion> {
    const motivo = this.limpiar(dto.motivo) || (venta ? `Venta ${venta.id_venta} anulada` : 'Anulado en el sistema');
    const resultado = await this.repo.transaccion(async (tx) => {
      for (const descarte of descartes) {
        if (!(await this.repo.descartarEnvio(tx, descarte))) {
          throw new ConflictException({
            message: 'El comprobante se está enviando a SUNAT en este momento: espere unos segundos y vuelva a anular.',
            codigo: 'ANULACION_ENVIO_EN_CURSO',
            id_comprobante: descarte.id_comprobante,
          });
        }
        await this.auditoria.registrar(
          { accion: ACCION_AUDITORIA_DESCARTE, id_usuario: idUsuario, entidad: 'fiscal_envios', id_entidad: descarte.id_envio, detalle: descarte.detalle },
          tx,
        );
      }
      const anulacion = venta
        ? await this.anularVentaEn(tx, venta.id_venta, `Devolución por venta ${venta.id_venta} anulada`)
        : { stock_devuelto: false, cxc_cerradas: 0, ya_anulada: false };
      const anulados = await this.repo.marcarAnulados(tx, comprobantes.map((c) => c.id_comprobante), motivo);
      return { anulacion, anulados };
    });

    // Primero el resultado (lo que la pantalla muestra como título); sin venta, el aviso del comprobante ya lo es.
    const titular = !venta
      ? []
      : [comprobantes.length
          ? `La venta ${venta.id_venta} quedó anulada.`
          : `La venta ${venta.id_venta} no tenía comprobante electrónico: se anuló en el sistema.`];
    return {
      estado: 'anulada',
      comprobantes_anulados: resultado.anulados.map((c) => ({ id_comprobante: c.id_comprobante, numero_formateado: this.numero(c.serie, c.numero) })),
      stock_devuelto: resultado.anulacion.stock_devuelto,
      cxc_cerradas: resultado.anulacion.cxc_cerradas,
      venta_anulada: !!venta,
      avisos: [...titular, ...avisos, ...this.avisoDevolucionDinero(venta, true)],
    };
  }

  /**
   * Rama c: el comprobante está aceptado en el ambiente vigente. Se emite la nota que lo anula con
   * efecto 'anular_venta': stock, deuda, la venta y sus otros comprobantes (los que nunca valieron) se
   * anulan recién cuando SUNAT la acepte. Si ya hay una anulación en curso o aceptada de ese comprobante,
   * se informa en lugar de emitir otra.
   */
  private async anularConNota(
    aceptado: CabeceraComprobante,
    venta: VentaDeNota | null,
    dto: AnularVentaRequest,
    idUsuario: number | null,
    otros: SinValidez[],
    descartes: DescarteEnvio[],
  ): Promise<ResultadoAnulacion> {
    await this.exigirEsquema();
    const numero = this.numeroDe(aceptado);
    if (descartes.length) {
      throw new ConflictException({
        message: `La venta tiene el comprobante aceptado ${numero} y otro cuyo envío quedó sin confirmar: anúlelos por separado desde Documentos.`,
        codigo: 'ANULACION_MIXTA',
      });
    }
    const origen = await this.repo.origen(aceptado.id_comprobante);
    if (!origen) throw new NotFoundException(`No existe el comprobante ${numero}.`);
    const notas = await this.repo.notasDeOrigen(origen.id_comprobante);
    const vacio = { comprobantes_anulados: [], stock_devuelto: false, cxc_cerradas: 0 };
    const queSeAnula = venta ? `la venta ${venta.id_venta}` : numero;

    const previa = [...notas].reverse().find((n) => n.efecto === 'anular_venta' && esNotaVigente(n));
    if (previa) {
      const respuesta = this.notaDeOrigenARespuesta(previa);
      if (previa.aceptada_sunat && ESTADOS_ACEPTADO.has(previa.estado_sunat ?? '')) {
        if (previa.efectos_aplicados || (await this.efectosSinFallar(previa.id_comprobante, respuesta.numero_formateado))) {
          return { ...vacio, estado: 'anulada', nota: respuesta, venta_anulada: !!venta, avisos: [`${numero} ya se anuló con la nota ${respuesta.numero_formateado}.`] };
        }
        return { ...vacio, estado: 'anulacion_en_curso', nota: respuesta, venta_anulada: false, avisos: [this.avisoEfectosPendientes(respuesta.numero_formateado)] };
      }
      return {
        ...vacio,
        estado: 'anulacion_en_curso',
        nota: respuesta,
        venta_anulada: false,
        avisos: [`La nota ${respuesta.numero_formateado} que anula ${numero} sigue en envío a SUNAT: ${queSeAnula} se anulará cuando la acepte.`],
      };
    }
    // Antes de decidir nada: si otra nota sigue en envío, el saldo todavía puede cambiar (si SUNAT la rechaza,
    // el comprobante vuelve a tener saldo y no se podría haber anulado en el sistema).
    this.exigirSinNotaEnCurso(origen, notas);

    const lineas = await this.repo.lineasVigentes(origen.id_comprobante);
    const plan = planificarAnulacion(origen, calcularAcreditable(origen, notas, lineas));
    if (!plan) {
      // Ya estaba acreditado por completo con notas aceptadas: no hace falta otra nota.
      return this.anularEnSistema(
        [aceptado, ...otros.map((o) => o.comprobante)],
        venta,
        dto,
        [],
        [`${numero} ya estaba acreditado por completo con notas de crédito: se anuló en el sistema.`, ...otros.map((o) => this.avisoSinValidez(o, true))],
        idUsuario,
      );
    }
    const modo = await this.emision.modo();
    if (!modo.activo) {
      throw new ServiceUnavailableException({
        message: `No se anuló: ${numero} ya fue aceptado por SUNAT y solo se anula con una nota de crédito, que no se puede emitir ahora. ${motivoEmisionInactiva(modo)}`,
        codigo: modo.codigo,
      });
    }
    this.exigirAdmitido(origen, modo);

    const motivo = this.limpiar(dto.motivo).slice(0, 250);
    const sustento = motivo.length >= 3 ? motivo : venta ? `Anulación de la venta ${venta.id_venta}` : `Anulación de ${numero}`;
    const respuesta = await this.emitirPlan(origen, plan, sustento, idUsuario, (o, e) => planificarAnulacion(o, e));
    const nota = this.notaDeRespuesta(respuesta, plan);

    if (respuesta.aceptada_sunat) {
      if (await this.efectosSinFallar(nota.id_comprobante, nota.numero_formateado)) {
        return {
          ...vacio,
          estado: 'anulada',
          nota,
          venta_anulada: !!venta,
          avisos: [
            `SUNAT aceptó la nota ${nota.numero_formateado}: ${venta ? `la venta ${venta.id_venta} quedó anulada` : `${numero} quedó anulado`}.`,
            ...otros.map((o) => this.avisoSinValidez(o, true)),
            ...this.avisoDevolucionDinero(venta, true),
          ],
        };
      }
      return { ...vacio, estado: 'anulacion_en_curso', nota, venta_anulada: false, avisos: [this.avisoEfectosPendientes(nota.numero_formateado)] };
    }
    if (respuesta.estado === 'pendiente') {
      return {
        ...vacio,
        estado: 'anulacion_en_curso',
        nota,
        venta_anulada: false,
        avisos: [
          `Se emitió la nota ${nota.numero_formateado}: ${queSeAnula} se anulará cuando SUNAT la acepte. Revise su estado en Documentos.`,
          ...otros.map((o) => this.avisoSinValidez(o, false)),
          ...this.avisoDevolucionDinero(venta, false),
        ],
      };
    }
    return {
      ...vacio,
      estado: 'anulacion_rechazada',
      nota,
      venta_anulada: false,
      avisos: [`SUNAT no aceptó la nota ${nota.numero_formateado}${respuesta.error ? ` (${respuesta.error})` : ''}: ${venta ? `la venta ${venta.id_venta} sigue activa` : `${numero} sigue vigente`}. Corrija el problema y vuelva a anular.`],
    };
  }

  /**
   * Rama d: el envío del comprobante quedó sin resultado. Una factura (o nota de factura) de producción
   * se consulta primero a SUNAT (getStatusCdr): aceptada → rama c; rechazada → rama a; inexistente → se
   * descarta el envío y rama a. Si la consulta no es posible (boleta, BETA) o SUNAT dejó la confirmación
   * al administrador, se exige confirmar_verificado_sol con lo que encontró en SUNAT Operaciones en Línea.
   */
  private async resolverIncierto(
    c: CabeceraComprobante,
    venta: VentaDeNota | null,
    dto: AnularVentaRequest,
    idUsuario: number | null,
  ): Promise<DecisionIncierto> {
    const numero = this.numeroDe(c);
    const idEnvio = c.id_envio_ultimo;
    if (!idEnvio) return { clase: 'nunca_enviado' };
    const tipo = tipoComprobanteSunat(c.id_tipo);

    if (c.ambiente_fiscal === 'produccion' && tipo && admiteGetStatusCdr(tipo, c.serie)) {
      const consulta = await this.emision.recuperarCdr(idEnvio);
      if (consulta.aceptado) return { clase: 'aceptado' };
      if (consulta.estado === 'RECHAZADO') return { clase: 'nunca_enviado' };
      if (consulta.estado === 'PENDIENTE_REENVIO' && consulta.codigo === CODIGO_CONSULTA_NO_EXISTE) {
        return { clase: 'descartar', descarte: this.descarte(c, venta, idUsuario, 'consulta_sunat', null) };
      }
      if (consulta.accion !== 'RECUPERAR_CDR') {
        throw new ConflictException({
          message: `No se pudo confirmar en SUNAT el estado de ${numero}${consulta.mensaje ? ` (${consulta.mensaje})` : ''}. Vuelva a intentar la anulación en unos minutos.`,
          codigo: 'ANULACION_ESTADO_INCIERTO',
          id_comprobante: c.id_comprobante,
        });
      }
    }

    if (dto.confirmar_verificado_sol !== true) {
      throw new ConflictException({
        message: `El envío de ${numero} a SUNAT quedó sin confirmar. Verifique en SUNAT Operaciones en Línea si el comprobante existe y vuelva a anular indicando lo que encontró.`,
        codigo: 'ANULACION_REQUIERE_VERIFICACION_SOL',
        id_comprobante: c.id_comprobante,
      });
    }
    const nota = this.limpiar(dto.nota);
    if (nota.length < 5) throw new BadRequestException('Explique en la nota qué verificó en SUNAT Operaciones en Línea (mínimo 5 caracteres).');
    if (typeof dto.existe_en_sunat !== 'boolean') {
      throw new BadRequestException(`Indique si encontró ${numero} en SUNAT Operaciones en Línea (existe_en_sunat: true o false).`);
    }
    if (!idUsuario) throw new BadRequestException('No se pudo identificar al administrador que verificó el comprobante.');
    if (dto.existe_en_sunat) {
      await this.emision.confirmarAceptadoManual(idEnvio, idUsuario, nota);
      return { clase: 'aceptado' };
    }
    return { clase: 'descartar', descarte: this.descarte(c, venta, idUsuario, 'verificado_sol', nota) };
  }

  private descarte(
    c: CabeceraComprobante,
    venta: VentaDeNota | null,
    idUsuario: number | null,
    origen: 'consulta_sunat' | 'verificado_sol',
    nota: string | null,
  ): DescarteEnvio {
    const mensaje = origen === 'consulta_sunat'
      ? 'Descartado: SUNAT no tiene registrado el comprobante y la venta se anuló. No se volverá a enviar.'
      : 'Descartado: el administrador verificó en SUNAT Operaciones en Línea que el comprobante no existe y lo anuló. No se volverá a enviar.';
    return {
      id_envio: c.id_envio_ultimo as number,
      id_comprobante: c.id_comprobante,
      mensaje,
      detalle: {
        id_comprobante: c.id_comprobante,
        comprobante: this.numeroDe(c),
        id_venta: venta?.id_venta ?? c.id_venta,
        origen,
        nota,
        id_usuario: idUsuario,
        fecha: new Date().toISOString(),
      },
    };
  }

  // ── Emisión compartida ───────────────────────────────────────

  /**
   * Entrega la nota al motor. validarEnTransaccion vuelve a leer, con el candado nc:<origen> tomado,
   * las notas y lo acreditado, y rehace el plan: si otra nota se registró entretanto (en curso, o el
   * plan ya no da lo mismo) responde 409 sin reservar número.
   */
  private emitirPlan(
    origen: OrigenNota,
    plan: PlanNota,
    sustento: string,
    idUsuario: number | null,
    replanificar: (origen: OrigenNota, estado: EstadoAcreditable) => PlanNota | null,
  ): Promise<ComprobanteResponse> {
    const numeroOrigen = this.numeroDe(origen);
    const solicitud: SolicitudEmisionNotaCredito = {
      id_comprobante_origen: origen.id_comprobante,
      id_venta: origen.id_venta,
      motivo: plan.motivo,
      sustento,
      lineas: plan.lineas,
      saldo_maximo: plan.total,
      id_usuario: idUsuario,
      efecto: plan.efecto,
      reingresar_stock: plan.reingresar_stock,
      // Lecturas en serie: dentro de una transacción nunca van en paralelo (PLAN V3, D3).
      validarEnTransaccion: async (tx) => {
        const fresco = await this.repo.origen(origen.id_comprobante, tx);
        if (!fresco || fresco.anulado) {
          throw new ConflictException({ message: `${numeroOrigen} se anuló mientras se preparaba la nota: no se emitió.`, codigo: 'NOTA_CREDITO_NO_PERMITIDA' });
        }
        const notas = await this.repo.notasDeOrigen(origen.id_comprobante, tx);
        this.exigirSinNotaEnCurso(fresco, notas);
        const lineas = await this.repo.lineasVigentes(origen.id_comprobante, tx);
        let rehecho: PlanNota | null;
        try {
          rehecho = replanificar(fresco, calcularAcreditable(fresco, notas, lineas));
        } catch (error) {
          rehecho = null;
          this.logger.warn(`La nota sobre ${numeroOrigen} ya no cabe con los datos actuales: ${this.mensajeDe(error)}`);
        }
        if (!rehecho || !mismoPlan(plan, rehecho)) {
          throw new ConflictException({
            message: `Mientras se preparaba la nota, otra nota de crédito de ${numeroOrigen} cambió lo que se puede acreditar. Revise el saldo y vuelva a intentarlo.`,
            codigo: 'NOTA_CREDITO_SALDO_CAMBIO',
          });
        }
      },
    };
    return this.emisor.emitirNotaCredito(solicitud);
  }

  /**
   * Efectos de una nota que SUNAT ya aceptó. Normalmente el oyente de envíos ya los aplicó; se vuelven a
   * pedir (idempotente) por si falló, sin tumbar la respuesta: la nota existe en SUNAT y el barrido lo
   * reintentará. true si quedaron aplicados (ahora o antes).
   */
  private async efectosSinFallar(idNota: number, numero: string): Promise<boolean> {
    try {
      await this.aplicarEfectos(idNota);
      return true;
    } catch (error) {
      this.logger.error(`La nota ${numero} fue aceptada pero sus efectos no se aplicaron todavía: ${this.mensajeDe(error)}`);
      return false;
    }
  }

  private async efectosDe(tx: EntityManager, nota: NotaReclamada): Promise<EfectosAplicados> {
    const numero = this.numero(nota.serie, nota.numero);
    const resultado: EfectosAplicados = {
      id_nota: nota.id_comprobante,
      efecto: nota.efecto,
      unidades_reingresadas: 0,
      deuda_descontada: 0,
      venta_anulada: false,
      origen_anulado: false,
    };

    if (nota.efecto === 'anular_venta') {
      if (nota.id_venta) {
        const anulacion = await this.anularVentaEn(tx, nota.id_venta, `Anulación de la venta ${nota.id_venta} con la nota de crédito ${numero}`);
        resultado.venta_anulada = !anulacion.ya_anulada;
      }
      // Con la venta anulada no queda vigente ninguno de sus comprobantes: el origen y los que nunca valieron.
      const deLaVenta = nota.id_venta
        ? (await this.repo.principalesDeVenta(nota.id_venta, tx)).filter((c) => !c.anulado).map((c) => c.id_comprobante)
        : [];
      const ids = [...new Set([...(nota.id_origen ? [nota.id_origen] : []), ...deLaVenta])];
      const anulados = await this.repo.marcarAnulados(tx, ids, `Anulado con la nota de crédito ${numero}`);
      resultado.origen_anulado = anulados.some((c) => c.id_comprobante === nota.id_origen);
      return resultado;
    }

    const venta = nota.id_venta ? await this.ventas.bloquearVenta(tx, nota.id_venta) : null;
    if (nota.efecto === 'devolucion' && venta && nota.id_venta) {
      const lineas = await this.repo.lineasDeNota(tx, nota.id_comprobante);
      const productos = lineas
        .filter((l) => l.id_producto !== null && l.codigo !== CODIGO_RECARGO_TARJETA)
        .map((l) => ({ id_producto: l.id_producto as number, cantidad: l.cantidad }));
      const reingresadas = await this.ventas.devolverStockParcial(tx, nota.id_venta, productos, {
        reingresar: nota.reingresar_stock,
        descripcion: `Devolución por nota de crédito ${numero}`,
      });
      resultado.unidades_reingresadas = reingresadas.reduce((suma, r) => suma + r.cantidad, 0);
    }
    if (venta && nota.id_venta && (nota.efecto === 'devolucion' || MOTIVOS_QUE_BAJAN_DEUDA.has(nota.motivo ?? ''))) {
      resultado.deuda_descontada = (await this.ventas.ajustarCxcPorNota(tx, nota.id_venta, nota.total)).descontado;
    }
    // 02 deja sin efecto el comprobante: queda anulado para que la venta reciba el correcto.
    if (nota.motivo === '02' && nota.id_origen) {
      resultado.origen_anulado = (
        await this.repo.marcarAnulados(tx, [nota.id_origen], `Anulado por error en el RUC con la nota de crédito ${numero}`)
      ).length > 0;
    }
    return resultado;
  }

  private async anularVentaEn(
    tx: EntityManager,
    idVenta: number,
    descripcion: string,
  ): Promise<{ stock_devuelto: boolean; cxc_cerradas: number; ya_anulada: boolean }> {
    try {
      return await this.ventas.anularVentaCompleta(idVenta, { consultor: tx, descripcion });
    } catch (error) {
      if ((error as Error)?.message === 'VENTA_NO_ENCONTRADA') throw new NotFoundException(`No existe la venta ${idVenta}`);
      throw error;
    }
  }

  // ── Validaciones ─────────────────────────────────────────────

  private async exigirEsquema(): Promise<void> {
    if (!(await this.repo.esquemaListo())) {
      throw new ServiceUnavailableException({
        message: 'Aplique sql/fase14_notas_credito_enlace.sql para habilitar las notas de crédito.',
        codigo: 'NOTA_CREDITO_MIGRACION_PENDIENTE',
      });
    }
  }

  /** Por qué el comprobante no admite nota de crédito (D8), o null si la admite. */
  private motivoNoAdmitido(origen: CabeceraComprobante, modo: ModoEmision): { mensaje: string; emisionInactiva: boolean } | null {
    const numero = this.numeroDe(origen);
    const tipo = tipoComprobanteSunat(origen.id_tipo);
    const rechazo = (mensaje: string) => ({ mensaje, emisionInactiva: false });
    if (tipo !== '01' && tipo !== '03') return rechazo(`${numero} no es una factura ni una boleta: solo a ellas se les emite nota de crédito.`);
    if (origen.anulado) return rechazo(`${numero} está anulado: no admite notas de crédito.`);
    if (origen.proveedor_fiscal !== 'sunat_directo') {
      return rechazo(`${numero} se emitió con el sistema anterior: su nota de crédito no se emite desde aquí (la venta se anula en el sistema).`);
    }
    // Sin leer la configuración, el ambiente que informa modo() es el de respaldo: no se compara con el del comprobante.
    if (!modo.activo && modo.codigo === CODIGO_LECTURA_ERROR) return { mensaje: motivoEmisionInactiva(modo), emisionInactiva: true };
    if (origen.ambiente_fiscal !== modo.ambiente) {
      return rechazo(
        `${numero} se emitió en ${this.nombreAmbiente(origen.ambiente_fiscal)} y el ambiente vigente es ${this.nombreAmbiente(modo.ambiente)}: se anula en el sistema, sin nota de crédito.`,
      );
    }
    if (!origen.aceptada_sunat || !ESTADOS_ACEPTADO.has(origen.estado_sunat ?? '')) {
      return rechazo(
        `${numero} todavía no está aceptado por SUNAT (estado ${origen.estado_sunat ?? 'sin enviar'}): la nota de crédito solo se emite sobre comprobantes aceptados.`,
      );
    }
    if (!modo.activo) return { mensaje: motivoEmisionInactiva(modo), emisionInactiva: true };
    return null;
  }

  /** 409 si el comprobante no admite nota; 503 (sin reservar número ni dejar filas) si la emisión no está activa. */
  private exigirAdmitido(origen: CabeceraComprobante, modo: ModoEmision): void {
    const motivo = this.motivoNoAdmitido(origen, modo);
    if (!motivo) return;
    if (motivo.emisionInactiva && !modo.activo) {
      throw new ServiceUnavailableException({ message: `No se emitió la nota de crédito. ${motivo.mensaje}`, codigo: modo.codigo });
    }
    throw new ConflictException({ message: motivo.mensaje, codigo: 'NOTA_CREDITO_NO_PERMITIDA' });
  }

  private exigirSinNotaEnCurso(origen: CabeceraComprobante, notas: NotaDeOrigen[]): void {
    const enCurso = notas.find(esNotaEnCurso);
    if (!enCurso) return;
    throw new ConflictException({
      message: `La nota ${this.numero(enCurso.serie, enCurso.numero)} de ${this.numeroDe(origen)} todavía se está enviando a SUNAT: espere su resultado antes de emitir otra.`,
      codigo: 'NOTA_CREDITO_EN_CURSO',
      id_comprobante: enCurso.id_comprobante,
    });
  }

  private async idComprobanteDe(dto: AnularDocumentoRequest): Promise<number> {
    const id = Number(dto?.id_comprobante);
    if (Number.isInteger(id) && id > 0) return id;
    const serie = String(dto?.serie ?? '').trim().toUpperCase();
    const numeroDoc = Number(dto?.numero);
    if (!serie || !Number.isInteger(numeroDoc) || numeroDoc <= 0) {
      throw new BadRequestException('Indique el comprobante a anular (id_comprobante, o serie y número).');
    }
    const encontrado = await this.repo.idPorSerieNumero(serie, numeroDoc, dto.tipo_de_comprobante ? Number(dto.tipo_de_comprobante) : undefined);
    if (!encontrado) throw new NotFoundException(`No existe el comprobante ${this.numero(serie, numeroDoc)} en el sistema.`);
    return encontrado;
  }

  // ── Avisos ───────────────────────────────────────────────────

  private avisosDeContexto(origen: OrigenNota, notas: NotaDeOrigen[], venta: VentaDeNota | null): string[] {
    const avisos: string[] = [];
    if (origen.ambiente_fiscal === 'beta') avisos.push(AVISO_BETA);
    for (const nota of notas.filter((n) => n.estado_sunat === 'RECHAZADO')) {
      avisos.push(`SUNAT rechazó la nota ${this.numero(nota.serie, nota.numero)}${nota.mensaje ? ` (${nota.mensaje})` : ''}: no se aplicó nada y puede emitir otra.`);
    }
    if (!venta) return avisos;
    if (venta.estado.trim().toLowerCase() === 'anulada') {
      avisos.push(`La venta ${venta.id_venta} ya está anulada: la nota no moverá stock ni la deuda.`);
      return avisos;
    }
    if (venta.saldo_cxc > 0) {
      avisos.push(`La venta ${venta.id_venta} debe ${this.monto(venta.saldo_cxc, origen)}: cuando SUNAT acepte la nota, la deuda baja en el total de la nota (hasta ese saldo).`);
    }
    if (venta.contado > 0) {
      avisos.push('Si la nota supera lo que el cliente debe, registre en Caja la devolución del dinero cuando SUNAT la acepte: la caja no se mueve sola.');
    }
    return avisos;
  }

  /**
   * Avisos de una nota recién emitida. El primero es siempre el resultado de SUNAT (lo que la pantalla
   * muestra al instante); los demás dicen qué pasó (o qué pasará al aceptarse) con el stock, la deuda y la caja.
   */
  private avisosDeEmision(
    origen: OrigenNota,
    plan: PlanNota,
    venta: VentaDeNota | null,
    respuesta: ComprobanteResponse,
    efectosAplicados: boolean,
  ): string[] {
    const numero = respuesta.numero_formateado ?? '';
    const aceptada = respuesta.aceptada_sunat === true;
    const pendiente = !aceptada && respuesta.estado === 'pendiente';
    const hecho = aceptada && efectosAplicados;
    const avisos: string[] = [];
    if (aceptada) {
      avisos.push(efectosAplicados ? `SUNAT aceptó la nota ${numero}.` : this.avisoEfectosPendientes(numero));
    } else if (pendiente) {
      avisos.push(`La nota ${numero} quedó en envío a SUNAT: sus efectos se aplicarán cuando la acepte. Revise su estado en Documentos.`);
    } else {
      const motivo = String(respuesta.error ?? '').replace(/[.\s]+$/, '');
      avisos.push(`SUNAT no aceptó la nota ${numero}${motivo ? `: ${motivo}` : ''}. No se aplicó nada: corrija el problema y emita otra nota.`);
    }
    if (respuesta.aviso) avisos.push(respuesta.aviso);
    if (!aceptada && !pendiente) return avisos;

    if (plan.motivo === '02') {
      avisos.push(hecho ? `${this.numeroDe(origen)} quedó anulado por el error en el RUC: emita el comprobante correcto desde la venta.` : AVISO_MOTIVO['02']);
    }
    if (!venta || venta.estado.trim().toLowerCase() === 'anulada') return avisos;
    if (plan.efecto === 'devolucion') {
      if (!plan.reingresar_stock) avisos.push('Lo devuelto no se reingresa al almacén (reingresar_stock = false).');
      else avisos.push(hecho ? 'Las unidades devueltas volvieron al almacén de donde salieron.' : 'Al aceptarse la nota, las unidades devueltas vuelven al almacén de donde salieron.');
    }
    if (plan.efecto === 'devolucion' || MOTIVOS_QUE_BAJAN_DEUDA.has(plan.motivo)) {
      const baja = Math.min(centimos(venta.saldo_cxc), centimos(plan.total));
      if (baja > 0) {
        const monto = this.monto(soles(baja), origen);
        avisos.push(hecho ? `La deuda de la venta ${venta.id_venta} bajó ${monto}.` : `Al aceptarse la nota, la deuda de la venta ${venta.id_venta} baja ${monto}.`);
      }
      const devolver = centimos(plan.total) - baja;
      if (devolver > 0 && venta.contado > 0) {
        const monto = this.monto(soles(devolver), origen);
        avisos.push(hecho
          ? `Registre en Caja la devolución de ${monto} al cliente (la caja no se mueve sola).`
          : `Registre en Caja la devolución de ${monto} al cliente cuando SUNAT acepte la nota (la caja no se mueve sola).`);
      }
    }
    return avisos;
  }

  /** SUNAT aceptó, pero stock/deuda/anulación fallaron: el barrido de 5 minutos (o repetir la acción) los completa. */
  private avisoEfectosPendientes(numeroNota: string): string {
    return `SUNAT aceptó la nota ${numeroNota}, pero el stock, la deuda y la anulación todavía no se actualizaron: se reintentará en unos minutos (o vuelva a pedirlo).`;
  }

  /** Comprobante de la venta que no valió en SUNAT: se anula ya (ramas a/b) o junto con la venta cuando SUNAT acepte la nota (c). */
  private avisoSinValidez(sinValidez: SinValidez, ahora: boolean): string {
    const c = sinValidez.comprobante;
    if (sinValidez.local) {
      return ahora ? this.avisoLocal(c) : `${this.numeroDe(c)} no se anula en SUNAT desde aquí: se anulará en el sistema junto con la venta.`;
    }
    return `${this.numeroDe(c)} nunca fue aceptado por SUNAT: ${ahora ? 'se anuló en el sistema' : 'se anulará en el sistema junto con la venta'}.`;
  }

  /** La caja no se mueve sola: lo cobrado al contado se devuelve a mano (las ventas se cobran en soles). */
  private avisoDevolucionDinero(venta: VentaDeNota | null, yaAnulada: boolean): string[] {
    if (!venta || venta.contado <= 0) return [];
    const monto = this.monto(venta.contado, { id_moneda: 1 });
    return [yaAnulada
      ? `La venta se cobró ${monto} al contado: registre en Caja la devolución que corresponda al cliente (la caja no se mueve sola).`
      : `Cuando SUNAT acepte la nota, registre en Caja la devolución que corresponda de lo cobrado al contado (${monto}); la caja no se mueve sola.`];
  }

  private avisoLocal(c: CabeceraComprobante): string {
    const origen = c.proveedor_fiscal !== 'sunat_directo'
      ? 'se emitió con el sistema anterior'
      : `se emitió en ${this.nombreAmbiente(c.ambiente_fiscal)}`;
    return `${this.numeroDe(c)} ${origen}: no se anula en SUNAT desde aquí (se anuló en el sistema).`;
  }

  // ── Respuestas ───────────────────────────────────────────────

  private notaDeRespuesta(respuesta: ComprobanteResponse, plan: PlanNota): NotaAnulacionResponse {
    return {
      id_comprobante: Number(respuesta.id_comprobante),
      serie: String(respuesta.serie ?? ''),
      numero: Number(respuesta.numero),
      numero_formateado: respuesta.numero_formateado ?? this.numero(String(respuesta.serie ?? ''), Number(respuesta.numero)),
      motivo: plan.motivo,
      total: plan.total,
      estado: respuesta.estado ?? 'pendiente',
      estado_sunat: respuesta.estado_sunat ?? null,
      aceptada_sunat: respuesta.aceptada_sunat === true,
      ...(respuesta.error ? { error: respuesta.error } : {}),
    };
  }

  private notaDeOrigenARespuesta(nota: NotaDeOrigen): NotaAnulacionResponse {
    const aceptada = nota.aceptada_sunat && ESTADOS_ACEPTADO.has(nota.estado_sunat ?? '');
    return {
      id_comprobante: nota.id_comprobante,
      serie: nota.serie,
      numero: nota.numero,
      numero_formateado: this.numero(nota.serie, nota.numero),
      motivo: nota.motivo ?? '',
      total: nota.total,
      estado: aceptada ? 'emitido' : esNotaEnCurso(nota) ? 'pendiente' : 'error',
      estado_sunat: nota.estado_sunat,
      aceptada_sunat: aceptada,
      ...(nota.estado_sunat === 'RECHAZADO' && nota.mensaje ? { error: nota.mensaje } : {}),
    };
  }

  // ── Auxiliares ───────────────────────────────────────────────

  private numero(serie: string, numero: number): string {
    return `${serie}-${String(numero).padStart(8, '0')}`;
  }

  private numeroDe(c: Pick<CabeceraComprobante, 'serie' | 'numero'>): string {
    return this.numero(c.serie, c.numero);
  }

  private monto(valor: number, origen: Pick<OrigenNota, 'id_moneda'>): string {
    return `${origen.id_moneda === 2 ? 'US$' : 'S/'} ${redondear(valor).toFixed(2)}`;
  }

  private nombreAmbiente(ambiente: string | null | undefined): string {
    if (ambiente === 'beta') return 'SUNAT BETA (pruebas)';
    if (ambiente === 'produccion') return 'PRODUCCIÓN';
    return 'otro ambiente';
  }

  private limpiar(texto: unknown): string {
    return String(texto ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  private mensajeDe(error: unknown): string {
    const e = error as { response?: { message?: unknown }; message?: unknown };
    const desdeRespuesta = e?.response?.message;
    if (Array.isArray(desdeRespuesta)) return desdeRespuesta.map(String).join(' | ');
    if (typeof desdeRespuesta === 'string' && desdeRespuesta.trim()) return desdeRespuesta;
    return typeof e?.message === 'string' && e.message.trim() ? e.message : 'error desconocido';
  }
}
