import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ErrorCaja, mensajeScriptPendiente, SCRIPT_FASE11 } from '../dominio/errores-caja';

/**
 * Lee el catálogo UNA vez (una sola consulta a information_schema) para saber qué columnas y
 * tablas existen en ventas, caja y crédito. Nunca ejecuta DDL: si falta algo, la API degrada
 * y avisa en el log una sola vez ("Falta ejecutar sql/fase11_caja_arqueo_ventas.sql en Railway").
 *
 * Con todo presente la lectura queda fija; si falta algo se relee como máximo cada 60 s, así
 * la API detecta el script recién aplicado sin reiniciar.
 */

const TABLAS = [
  'ventas',
  'venta_pago',
  'venta_stock_salida',
  'aperturas_caja',
  'cierres_caja',
  'cajas',
  'movimientos_caja',
  'metodos_pago',
  'cuentas_bancarias',
  'cuentas_por_cobrar',
  'abonos_credito',
  'clientes',
  'empresas',
  'caja_arqueos',
  'caja_arqueo_denominaciones',
  'comprobantes',
  'comprobante_items',
  // fase19 (sql/fase19_control_venta_y_bitacora.sql): costo por línea, costo por ítem recibido y bitácora.
  'detalle_venta',
  'recepcion_items',
  'bitacora_acciones',
  // fase21 (sql/fase21_stock_y_pedidos.sql): rastro de los movimientos de stock y usuarios por local.
  'movimientos_inventario',
  'usuario_sucursal',
  // fase22 (sql/fase22_almacenes_direccion.sql): dirección, ubigeo y establecimiento del almacén (4.4).
  'almacenes',
] as const;

export type TablaCaja = (typeof TABLAS)[number];

/** Requisitos por capacidad: tabla → columnas que deben existir. */
const REQUISITOS = {
  idempotenciaVentas: { ventas: ['clave_idempotencia'] },
  ventaEstado: { ventas: ['estado'] },
  ventaEmpresa: { ventas: ['id_empresa'] },
  ventaDescuento: { ventas: ['total_descuento'] },
  ventaStockSalida: { venta_stock_salida: ['id_venta', 'id_producto', 'id_almacen', 'cantidad'] },
  ventaPagoExtendido: {
    venta_pago: ['referencia', 'monto_recibido', 'vuelto', 'id_cuenta_bancaria', 'voucher_pos', 'validacion', 'referencia_externa'],
  },
  cuentasBancarias: {
    cuentas_bancarias: ['id_cuenta', 'banco', 'alias', 'tipo_cuenta', 'numero_cuenta', 'cci', 'titular', 'moneda', 'activo', 'es_yape', 'orden'],
  },
  credito: {
    cuentas_por_cobrar: ['id_cxc', 'id_venta', 'id_cliente', 'id_empresa', 'monto_total', 'saldo', 'fecha_emision', 'fecha_vencimiento', 'estado'],
    abonos_credito: ['id_abono', 'id_cxc', 'id_metodo', 'monto', 'referencia', 'id_usuario', 'creado_en'],
    clientes: ['credito_activo', 'limite_credito', 'dias_credito'],
    empresas: ['credito_activo', 'limite_credito', 'dias_credito'],
  },
  movimientosPorTurno: { movimientos_caja: ['id_apertura', 'id_usuario'] },
  arqueo: {
    caja_arqueos: [
      'id_arqueo', 'id_apertura', 'id_caja', 'id_usuario', 'tipo', 'fecha', 'monto_inicial', 'efectivo_esperado',
      'efectivo_contado', 'diferencia', 'resumen_metodos', 'observacion', 'conteo_por_denominaciones',
      'clave_idempotencia', 'id_cierre', 'creado_en',
    ],
    caja_arqueo_denominaciones: ['id', 'id_arqueo', 'tipo', 'denominacion', 'cantidad', 'subtotal'],
    movimientos_caja: ['id_apertura', 'id_usuario'],
  },
  /** fase14: lo ya devuelto de cada salida de stock, para no reingresarlo dos veces. */
  ventaStockDevuelto: { venta_stock_salida: ['cantidad_devuelta'] },
  /** fase14: notas de crédito enlazadas por ítem y con efectos al aceptarse (D8). */
  notasCredito: {
    comprobantes: ['id_comprobante_modificado', 'nota_motivo', 'efecto_nota', 'reingresar_stock', 'efectos_aplicados', 'efectos_aplicados_en'],
    comprobante_items: ['id_item_origen'],
    venta_stock_salida: ['cantidad_devuelta'],
  },
  /** fase19: quién vendió y desde qué almacén (ventas.id_usuario, ventas.id_almacen). */
  ventaAutor: { ventas: ['id_usuario', 'id_almacen'] },
  /** fase19: costo unitario de cada línea al momento de vender. */
  ventaCosto: { detalle_venta: ['costo_unitario'] },
  /** fase19: precio de catálogo neto de cada línea al vender (rebaja en soles del reporte por vendedor). */
  ventaReferencia: { detalle_venta: ['precio_referencia'] },
  /** fase19: costo de compra de cada ítem recibido. */
  recepcionCosto: { recepcion_items: ['precio_compra'] },
  /** fase19: bitácora de acciones (quién hizo qué). */
  bitacora: {
    bitacora_acciones: [
      'id', 'fecha', 'id_usuario', 'rol', 'id_autorizador', 'id_almacen', 'accion', 'entidad', 'id_entidad',
      'antes', 'despues', 'motivo', 'ip',
    ],
  },
  /** fase20: el egreso que devuelve efectivo de una venta queda enlazado a ella (7.1, R14). */
  movimientoVenta: { movimientos_caja: ['id_apertura', 'id_venta'] },
  /** fase20: categoría del gasto de caja (7.5). */
  gastoCategoria: { movimientos_caja: ['categoria'] },
  /** fase20: número del comprobante del gasto de caja (7.5). */
  gastoComprobante: { movimientos_caja: ['nro_comprobante'] },
  /** fase20: marca de los cierres hechos por la tarea de turnos olvidados (7.4). */
  cierreAutomatico: { cierres_caja: ['automatico'] },
  /** fase21: quién movió el stock (movimientos_inventario.id_usuario, 8.1). */
  movimientoUsuario: { movimientos_inventario: ['id_usuario'] },
  /** fase21: en qué almacén se movió el stock (antes solo la sucursal, 8.1). */
  movimientoAlmacen: { movimientos_inventario: ['id_almacen'] },
  /** fase21: documento que originó el movimiento (venta, recepción, ajuste…; 8.1). */
  movimientoDocumento: { movimientos_inventario: ['tipo_documento', 'id_documento'] },
  /** Usuarios por local (8.5, D7). La tabla ya existe en producción; fase21 solo la crea si faltara. */
  usuarioSucursal: { usuario_sucursal: ['id_usuario', 'id_sucursal'] },
  /** fase22: dirección, ubigeo y código de establecimiento del almacén (punto de partida de la guía, 4.4). */
  almacenDireccion: { almacenes: ['direccion', 'ubigeo', 'codigo_establecimiento'] },
} satisfies Record<string, Partial<Record<TablaCaja, string[]>>>;

export type CapacidadCaja = keyof typeof REQUISITOS;

/** Qué hace la API cuando falta cada capacidad (para el aviso del log). */
const EFECTO_SI_FALTA: Record<CapacidadCaja, string> = {
  idempotenciaVentas: 'las ventas se registran sin clave de idempotencia (un doble clic puede duplicar)',
  ventaEstado: 'no se pueden anular ventas',
  ventaEmpresa: 'las ventas a empresas no guardan id_empresa',
  ventaDescuento: 'las ventas no guardan total_descuento',
  ventaStockSalida: 'las anulaciones devuelven el stock al almacén con más stock (modo antiguo)',
  ventaPagoExtendido: 'los pagos no guardan referencia, vuelto, voucher ni cuenta bancaria',
  cuentasBancarias: 'las cuentas bancarias del POS no están disponibles',
  credito: 'el crédito y las cuentas por cobrar no están disponibles',
  movimientosPorTurno: 'los ingresos y egresos de efectivo no están disponibles',
  arqueo: 'el arqueo de caja no está disponible (responde 503)',
  ventaStockDevuelto: 'anular una venta devuelve al almacén todo lo que salió, sin descontar devoluciones previas',
  notasCredito: 'las notas de crédito responden 503 y una venta con comprobante aceptado no se puede anular',
  ventaAutor: 'las ventas no guardan quién vendió ni desde qué almacén (el reporte por vendedor las muestra como «Sin registrar»)',
  ventaCosto: 'las ventas no guardan el costo de cada línea (la rentabilidad usa el precio de compra vigente)',
  ventaReferencia: 'las ventas no guardan el precio de catálogo de cada línea (el reporte por vendedor muestra la rebaja en soles como 0)',
  recepcionCosto: 'las recepciones no guardan el costo de cada ítem (solo actualizan el precio de compra del producto)',
  bitacora: 'la bitácora de acciones (pantalla Actividad) no guarda nada: los eventos solo van al log',
  movimientoVenta: 'la devolución en efectivo al anular o con nota de crédito (reembolso_efectivo) responde 503 sin anular nada; sin ese campo todo sigue igual',
  gastoCategoria: 'los gastos de caja se guardan sin categoría',
  gastoComprobante: 'los gastos de caja se guardan sin número de comprobante',
  cierreAutomatico: 'el cierre automático de turnos olvidados se marca solo en la observación y en la bitácora',
  movimientoUsuario: 'los movimientos de stock no guardan quién los hizo (el historial del producto muestra «sin registrar»)',
  movimientoAlmacen: 'los movimientos de stock guardan solo la sucursal, no el almacén',
  movimientoDocumento: 'los movimientos de stock no guardan el documento que los originó (venta, recepción, ajuste…)',
  usuarioSucursal: 'no se pueden asignar locales a los usuarios: todos venden, transfieren y ajustan en cualquier almacén (como antes)',
  almacenDireccion: 'los almacenes no guardan dirección propia: la guía propone la dirección de la sucursal o la partida de la configuración fiscal',
};

/** Script que crea lo que falta, cuando no es el de caja (fase 11). */
const SCRIPT_POR_CAPACIDAD: Partial<Record<CapacidadCaja, string>> = {
  ventaStockDevuelto: 'sql/fase14_notas_credito_enlace.sql',
  notasCredito: 'sql/fase14_notas_credito_enlace.sql',
  ventaAutor: 'sql/fase19_control_venta_y_bitacora.sql',
  ventaCosto: 'sql/fase19_control_venta_y_bitacora.sql',
  ventaReferencia: 'sql/fase19_control_venta_y_bitacora.sql',
  recepcionCosto: 'sql/fase19_control_venta_y_bitacora.sql',
  bitacora: 'sql/fase19_control_venta_y_bitacora.sql',
  movimientoVenta: 'sql/fase20_caja_devoluciones.sql',
  gastoCategoria: 'sql/fase20_caja_devoluciones.sql',
  gastoComprobante: 'sql/fase20_caja_devoluciones.sql',
  cierreAutomatico: 'sql/fase20_caja_devoluciones.sql',
  movimientoUsuario: 'sql/fase21_stock_y_pedidos.sql',
  movimientoAlmacen: 'sql/fase21_stock_y_pedidos.sql',
  movimientoDocumento: 'sql/fase21_stock_y_pedidos.sql',
  usuarioSucursal: 'sql/fase21_stock_y_pedidos.sql',
  almacenDireccion: 'sql/fase22_almacenes_direccion.sql',
};


/** Una capacidad tal como la muestra «Estado del sistema» (8.6). */
export interface EstadoCapacidad {
  capacidad: CapacidadCaja;
  presente: boolean;
  /** 'tabla' o 'tabla.columna' que faltan (vacío si está presente). */
  faltan: string[];
  /** Qué deja de funcionar (o funciona a la antigua) mientras falte. */
  efecto_si_falta: string;
  /** Script que la crea. */
  script: string;
}

/** Todas las capacidades con su estado, en el orden en que se declararon. */
export function estadoCapacidades(s: SnapshotEsquema): EstadoCapacidad[] {
  return (Object.keys(REQUISITOS) as CapacidadCaja[]).map((capacidad) => {
    const faltan = s.faltantes(capacidad);
    return {
      capacidad,
      presente: faltan.length === 0,
      faltan,
      efecto_si_falta: EFECTO_SI_FALTA[capacidad],
      script: SCRIPT_POR_CAPACIDAD[capacidad] ?? SCRIPT_FASE11,
    };
  });
}

const RELECTURA_SI_FALTA_MS = 60_000;

export class SnapshotEsquema {
  constructor(
    private readonly columnasPorTabla: ReadonlyMap<string, ReadonlySet<string>>,
    readonly leidoEn: number,
  ) {}

  tieneTabla(tabla: TablaCaja): boolean {
    return (this.columnasPorTabla.get(tabla)?.size ?? 0) > 0;
  }

  tieneColumna(tabla: TablaCaja, columna: string): boolean {
    return this.columnasPorTabla.get(tabla)?.has(columna) ?? false;
  }

  columnas(tabla: TablaCaja): ReadonlySet<string> {
    return this.columnasPorTabla.get(tabla) ?? new Set<string>();
  }

  /** 'tabla' o 'tabla.columna' de lo que falta para la capacidad. */
  faltantes(capacidad: CapacidadCaja): string[] {
    const faltan: string[] = [];
    for (const [tabla, columnas] of Object.entries(REQUISITOS[capacidad]) as [TablaCaja, string[]][]) {
      if (!this.tieneTabla(tabla)) {
        faltan.push(tabla);
        continue;
      }
      for (const c of columnas) if (!this.tieneColumna(tabla, c)) faltan.push(`${tabla}.${c}`);
    }
    return faltan;
  }

  tiene(capacidad: CapacidadCaja): boolean {
    return this.faltantes(capacidad).length === 0;
  }

  completo(): boolean {
    return (Object.keys(REQUISITOS) as CapacidadCaja[]).every((c) => this.tiene(c));
  }
}

@Injectable()
export class EsquemaCajaService implements OnApplicationBootstrap {
  private readonly log = new Logger(EsquemaCajaService.name);
  private actual: SnapshotEsquema | null = null;
  private enCurso: Promise<SnapshotEsquema> | null = null;
  private readonly avisados = new Set<string>();

  constructor(
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {}

  /** Precarga sin bloquear el arranque ni tumbar la API si la BD tarda. */
  onApplicationBootstrap(): void {
    void this.snapshot()
      .then((s) => this.avisarFaltantes(s))
      .catch((e) => this.log.warn(`No se pudo leer el catálogo al arrancar: ${(e as Error)?.message ?? e}`));
  }

  async snapshot(): Promise<SnapshotEsquema> {
    const actual = this.actual;
    if (actual && (actual.completo() || Date.now() - actual.leidoEn < RELECTURA_SI_FALTA_MS)) return actual;
    if (!this.enCurso) {
      this.enCurso = this.leer()
        .then((s) => {
          const antes = this.actual;
          this.actual = s;
          if (antes) this.avisarFaltantes(s);
          return s;
        })
        .catch((e) => {
          if (this.actual) return this.actual;
          throw e;
        })
        .finally(() => {
          this.enCurso = null;
        });
    }
    return this.enCurso;
  }

  async tiene(capacidad: CapacidadCaja): Promise<boolean> {
    const s = await this.snapshot();
    const ok = s.tiene(capacidad);
    if (!ok) this.avisarUnaVez(capacidad, s);
    return ok;
  }

  /** Lanza 503 "Falta ejecutar sql/… en Railway" si falta la capacidad. */
  async exigir(capacidad: CapacidadCaja): Promise<SnapshotEsquema> {
    const s = await this.snapshot();
    const faltan = s.faltantes(capacidad);
    if (faltan.length) {
      this.avisarUnaVez(capacidad, s);
      throw ErrorCaja.esquemaPendiente(`falta ${faltan.slice(0, 3).join(', ')}${faltan.length > 3 ? '…' : ''}`);
    }
    return s;
  }

  /** Fuerza otra lectura del catálogo en la próxima consulta. */
  invalidar(): void {
    this.actual = null;
  }

  private avisarFaltantes(s: SnapshotEsquema): void {
    for (const capacidad of Object.keys(REQUISITOS) as CapacidadCaja[]) {
      if (!s.tiene(capacidad)) this.avisarUnaVez(capacidad, s);
    }
  }

  private avisarUnaVez(capacidad: CapacidadCaja, s: SnapshotEsquema): void {
    if (this.avisados.has(capacidad)) return;
    this.avisados.add(capacidad);
    this.log.warn(
      `${mensajeScriptPendiente(SCRIPT_POR_CAPACIDAD[capacidad])}: falta ${s.faltantes(capacidad).join(', ')}. Mientras tanto ${EFECTO_SI_FALTA[capacidad]}.`,
    );
  }

  private async leer(): Promise<SnapshotEsquema> {
    const filas: { table_name: string; column_name: string }[] = await this.dataSource.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name::text = ANY($1::text[])`,
      [[...TABLAS]],
    );
    const mapa = new Map<string, Set<string>>();
    for (const f of filas) {
      const set = mapa.get(f.table_name) ?? new Set<string>();
      set.add(f.column_name);
      mapa.set(f.table_name, set);
    }
    return new SnapshotEsquema(mapa, Date.now());
  }
}
