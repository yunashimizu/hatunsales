import { Dinero } from '../dominio/dinero';
import { ConteoEfectivo, DENOMINACIONES_PEN } from '../dominio/denominaciones';
import { EfectivoEsperado, EsperadoCaja, LineaMetodoEsperado } from '../dominio/esperado-caja';
import { describirDiferencia, LineaConciliada, ResultadoConciliacion } from '../dominio/conciliacion';
import { CategoriaMetodo } from '../dominio/metodo-pago';
import type { ArqueoGuardado, MovimientoGuardado, TurnoArqueo } from '../../repository/Irepository/ICajaArqueoRepository';
import type {
  ArqueoDetalleResponse,
  ArqueoResumenResponse,
  DenominacionValidaResponse,
  EfectivoEsperadoResponse,
  MedioConciliadoResponse,
  MetodoEsperadoResponse,
  MovimientoCajaResponse,
  TurnoArqueoResponse,
} from '../../models/model/caja-arqueo.response';

/**
 * Conversión entre el dominio (Dinero en céntimos) y lo que viaja por la API o se guarda en
 * caja_arqueos.resumen_metodos (números en soles con 2 decimales). Sin lógica de negocio.
 */
const CLAVES_RESERVADAS = new Set(['efectivo', 'credito', 'resumen']);

export function codigoArqueo(idArqueo: number): string {
  return `AQ-${String(idArqueo).padStart(6, '0')}`;
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function num(valor: unknown): number {
  if (typeof valor === 'number' && Number.isFinite(valor)) return Dinero.desdeNumeroRedondeado(valor).aNumero();
  return Dinero.desdeBd(valor ?? 0).aNumero();
}

function numONull(valor: unknown): number | null {
  return valor === null || valor === undefined ? null : num(valor);
}

export function turnoResponse(t: TurnoArqueo): TurnoArqueoResponse {
  return {
    id_apertura: t.id_apertura,
    id_caja: t.id_caja,
    caja_nombre: t.caja_nombre,
    sucursal_nombre: t.sucursal_nombre,
    id_usuario: t.id_usuario,
    usuario_nombre: t.usuario_nombre,
    fecha_apertura: iso(t.fecha_apertura),
    monto_inicial: t.monto_inicial.aNumero(),
    abierta: t.abierta,
    fecha_cierre: iso(t.fecha_cierre),
  };
}

export function metodoEsperadoResponse(l: LineaMetodoEsperado): MetodoEsperadoResponse {
  return {
    clave: l.clave,
    id_metodo: l.id_metodo,
    nombre: l.nombre,
    categoria: l.categoria,
    ventas: l.ventas.aNumero(),
    abonos: l.abonos.aNumero(),
    esperado: l.esperado.aNumero(),
    operaciones: l.operaciones,
  };
}

export function efectivoResponse(e: EfectivoEsperado): EfectivoEsperadoResponse {
  return {
    monto_inicial: e.monto_inicial.aNumero(),
    ventas: e.ventas.aNumero(),
    abonos: e.abonos.aNumero(),
    ingresos: e.ingresos.aNumero(),
    egresos: e.egresos.aNumero(),
    vueltos_entregados: e.vueltos_entregados.aNumero(),
    esperado: e.esperado.aNumero(),
    operaciones_ventas: e.operaciones_ventas,
    operaciones_abonos: e.operaciones_abonos,
    cantidad_ingresos: e.cantidad_ingresos,
    cantidad_egresos: e.cantidad_egresos,
    metodos: e.metodos.map(metodoEsperadoResponse),
  };
}

export function denominacionesValidas(): DenominacionValidaResponse[] {
  return DENOMINACIONES_PEN.map((d) => ({ tipo: d.tipo, denominacion: d.valor.aNumero(), etiqueta: d.etiqueta }));
}

function lineaConciliadaJson(l: LineaConciliada) {
  return {
    clave: l.clave,
    id_metodo: l.id_metodo,
    nombre: l.nombre,
    categoria: l.categoria,
    esperado: l.esperado.aNumero(),
    declarado: l.declarado ? l.declarado.aNumero() : null,
    diferencia: l.diferencia ? l.diferencia.aNumero() : null,
    estado: l.estado,
    mensaje: l.mensaje,
  };
}

/** Documento que se guarda en caja_arqueos.resumen_metodos (foto del turno al momento del arqueo). */
export function resumenMetodosJson(
  esperado: EsperadoCaja,
  conciliacion: ResultadoConciliacion,
  tolerancia: Dinero,
): Record<string, unknown> {
  const { metodos: metodosEfectivo, ...desglose } = efectivoResponse(esperado.efectivo);
  const json: Record<string, unknown> = {
    efectivo: {
      ...lineaConciliadaJson(conciliacion.efectivo),
      desglose,
      metodos: metodosEfectivo,
    },
  };
  for (const medio of conciliacion.otros_medios) {
    const base = esperado.otros_medios.find((m) => m.clave === medio.clave);
    json[medio.clave] = {
      ...lineaConciliadaJson(medio),
      ventas: base ? base.ventas.aNumero() : 0,
      abonos: base ? base.abonos.aNumero() : 0,
      operaciones: base ? base.operaciones : 0,
    };
  }
  if (esperado.credito.operaciones > 0) {
    json.credito = {
      nombre: 'Crédito',
      categoria: 'credito',
      esperado: esperado.credito.ventas.aNumero(),
      operaciones: esperado.credito.operaciones,
      estado: 'informativo',
      mensaje: 'Ventas al crédito: no es dinero recibido',
    };
  }
  json.resumen = {
    hay_diferencia: conciliacion.hay_diferencia,
    texto: conciliacion.resumen,
    tolerancia: tolerancia.aNumero(),
    total_cobrado: esperado.total_cobrado.aNumero(),
    ventas_web: { total: esperado.ventas_web.total.aNumero(), cantidad: esperado.ventas_web.cantidad },
    ventas_anuladas: { total: esperado.ventas_anuladas.total.aNumero(), cantidad: esperado.ventas_anuladas.cantidad },
  };
  return json;
}

function resumenGuardado(a: ArqueoGuardado): Record<string, any> {
  const r = a.resumen_metodos?.resumen;
  return r && typeof r === 'object' ? r : {};
}

export function arqueoResumenResponse(a: ArqueoGuardado): ArqueoResumenResponse {
  const r = resumenGuardado(a);
  const tolerancia = Dinero.desdeNumeroRedondeado(Number(r.tolerancia ?? 0) || 0);
  const d = describirDiferencia(a.diferencia, tolerancia);
  return {
    id_arqueo: a.id_arqueo,
    codigo: codigoArqueo(a.id_arqueo),
    tipo: a.tipo,
    fecha: a.fecha.toISOString(),
    id_apertura: a.id_apertura,
    id_usuario: a.id_usuario,
    usuario_nombre: a.usuario_nombre,
    efectivo_esperado: a.efectivo_esperado.aNumero(),
    efectivo_contado: a.efectivo_contado.aNumero(),
    diferencia: a.diferencia.aNumero(),
    estado: d.estado,
    mensaje: d.mensaje,
    hay_diferencia: typeof r.hay_diferencia === 'boolean' ? r.hay_diferencia : !d.dentroDeTolerancia,
    id_cierre: a.id_cierre,
  };
}

function medioGuardado(clave: string, m: any): MedioConciliadoResponse {
  return {
    clave,
    id_metodo: m?.id_metodo != null ? Number(m.id_metodo) : null,
    nombre: String(m?.nombre ?? clave),
    categoria: (m?.categoria ?? 'otro') as CategoriaMetodo,
    esperado: num(m?.esperado),
    declarado: numONull(m?.declarado),
    diferencia: numONull(m?.diferencia),
    estado: m?.estado ?? 'sin_declarar',
    mensaje: String(m?.mensaje ?? 'Sin declarar'),
  };
}

export function arqueoDetalleResponse(a: ArqueoGuardado, turno: TurnoArqueo | null): ArqueoDetalleResponse {
  const r = resumenGuardado(a);
  const efectivoJson = a.resumen_metodos?.efectivo ?? {};
  const desglose = efectivoJson.desglose ?? {};
  const conteo = ConteoEfectivo.desdeGuardado(a.denominaciones);
  const credito = a.resumen_metodos?.credito;

  const medios = Object.entries(a.resumen_metodos ?? {})
    .filter(([clave]) => !CLAVES_RESERVADAS.has(clave))
    .map(([clave, m]) => medioGuardado(clave, m))
    .sort((x, y) => y.esperado - x.esperado || x.nombre.localeCompare(y.nombre, 'es'));

  return {
    ...arqueoResumenResponse(a),
    id_caja: a.id_caja,
    caja_nombre: turno?.caja_nombre ?? (a.id_caja != null ? `Caja ${a.id_caja}` : 'Caja'),
    sucursal_nombre: turno?.sucursal_nombre ?? null,
    cajero_id: turno?.id_usuario ?? null,
    cajero_nombre: turno?.usuario_nombre ?? null,
    fecha_apertura: iso(turno?.fecha_apertura ?? null),
    turno_abierto: turno?.abierta ?? false,
    monto_inicial: a.monto_inicial.aNumero(),
    efectivo: {
      monto_inicial: a.monto_inicial.aNumero(),
      ventas: num(desglose.ventas),
      abonos: num(desglose.abonos),
      ingresos: num(desglose.ingresos),
      egresos: num(desglose.egresos),
      vueltos_entregados: num(desglose.vueltos_entregados),
      esperado: a.efectivo_esperado.aNumero(),
      operaciones_ventas: Number(desglose.operaciones_ventas ?? 0),
      operaciones_abonos: Number(desglose.operaciones_abonos ?? 0),
      cantidad_ingresos: Number(desglose.cantidad_ingresos ?? 0),
      cantidad_egresos: Number(desglose.cantidad_egresos ?? 0),
    },
    conteo_por_denominaciones: a.conteo_por_denominaciones,
    denominaciones: conteo.catalogoCompleto().map((l) => ({
      tipo: l.tipo,
      denominacion: l.denominacion.aNumero(),
      etiqueta: l.etiqueta,
      cantidad: l.cantidad,
      subtotal: l.subtotal.aNumero(),
    })),
    total_billetes: conteo.totalBilletes().aNumero(),
    total_monedas: conteo.totalMonedas().aNumero(),
    medios,
    credito: { ventas: num(credito?.esperado), operaciones: Number(credito?.operaciones ?? 0) },
    ventas_web: { total: num(r.ventas_web?.total), cantidad: Number(r.ventas_web?.cantidad ?? 0) },
    ventas_anuladas: { total: num(r.ventas_anuladas?.total), cantidad: Number(r.ventas_anuladas?.cantidad ?? 0) },
    tolerancia: num(r.tolerancia),
    resumen: String(r.texto ?? describirDiferencia(a.diferencia).mensaje),
    observacion: a.observacion,
    creado_en: a.creado_en.toISOString(),
  };
}

export function movimientoResponse(m: MovimientoGuardado): MovimientoCajaResponse {
  return {
    id_movimiento: m.id_movimiento,
    id_apertura: m.id_apertura,
    id_caja: m.id_caja,
    tipo: m.tipo,
    monto: m.monto.aNumero(),
    descripcion: m.descripcion,
    fecha: m.fecha.toISOString(),
    id_usuario: m.id_usuario,
    usuario_nombre: m.usuario_nombre,
  };
}
