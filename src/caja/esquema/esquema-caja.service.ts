import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ErrorCaja, mensajeScriptPendiente } from '../dominio/errores-caja';

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
};

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
      `${mensajeScriptPendiente()}: falta ${s.faltantes(capacidad).join(', ')}. Mientras tanto ${EFECTO_SI_FALTA[capacidad]}.`,
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
