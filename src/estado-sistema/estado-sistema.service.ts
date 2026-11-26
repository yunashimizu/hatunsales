import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EsquemaCajaService, EstadoCapacidad, estadoCapacidades } from '../caja/esquema/esquema-caja.service';
import { filasDe } from '../caja/bd/resultado-consulta';

/** Una restricción CHECK que el código da por hecha. */
export interface EstadoRestriccion {
  nombre: string;
  tabla: string;
  presente: boolean;
  efecto_si_falta: string;
  script: string;
}

/** Un índice único que el código da por hecho (se reconoce por sus columnas, no por el nombre). */
export interface EstadoIndiceUnico {
  nombre: string;
  tabla: string;
  columnas: string[];
  /** Existe un índice único VÁLIDO sobre esas columnas (con o sin condición WHERE). */
  presente: boolean;
  /** Nombre real del índice encontrado (puede diferir del sugerido). */
  encontrado: string | null;
  /** Hay un índice único sobre esas columnas, pero quedó INVALID (un CONCURRENTLY a medias): no protege. */
  invalido: boolean;
  /** false = opcional (p. ej. el de guías de fase21, comentado hasta revisar el diagnóstico). */
  obligatorio: boolean;
  efecto_si_falta: string;
  script: string;
}

export interface EstadoSistema {
  fecha: string;
  /** true si no falta nada obligatorio. */
  completo: boolean;
  resumen: { capacidades_faltantes: number; restricciones_faltantes: number; indices_faltantes: number };
  capacidades: EstadoCapacidad[];
  restricciones: EstadoRestriccion[];
  indices_unicos: EstadoIndiceUnico[];
}

const RESTRICCIONES: Omit<EstadoRestriccion, 'presente'>[] = [
  {
    nombre: 'ck_inventario_stock_no_negativo',
    tabla: 'inventario',
    efecto_si_falta:
      'la base acepta stock negativo: el código lo evita en sus caminos, pero si dos operaciones se cruzan o alguien edita a mano no hay red de seguridad',
    script: 'doc/migracion_tienda_v2.sql',
  },
];

const INDICES: Omit<EstadoIndiceUnico, 'presente' | 'encontrado' | 'invalido'>[] = [
  {
    nombre: 'uq_ventas_clave_idempotencia', tabla: 'ventas', columnas: ['clave_idempotencia'], obligatorio: true,
    efecto_si_falta: 'dos reintentos simultáneos de un cobro en procesos distintos pueden registrar la venta dos veces (el candado por clave cubre la mayoría de los casos)',
    script: 'sql/fase11_caja_arqueo_ventas.sql',
  },
  {
    nombre: 'uq_inventario_producto_almacen', tabla: 'inventario', columnas: ['id_producto', 'id_almacen'], obligatorio: true,
    efecto_si_falta: 'puede haber dos filas de stock del mismo producto en un almacén: las ventas y los ajustes toman solo una y el stock mostrado no cuadra',
    script: 'doc/migracion_admin_v3.sql',
  },
  {
    nombre: 'uq_pedidos_idempotencia', tabla: 'pedidos', columnas: ['id_cliente', 'clave_idempotencia'], obligatorio: true,
    efecto_si_falta: 'un doble clic en «Comprar» puede crear dos pedidos web y reservar el stock dos veces',
    script: 'doc/migracion_tienda_v2.sql',
  },
  {
    nombre: 'uq_pedidos_venta', tabla: 'pedidos', columnas: ['id_venta'], obligatorio: true,
    efecto_si_falta: 'dos pedidos podrían quedar enlazados a la misma venta',
    script: 'doc/migracion_tienda_v2.sql',
  },
  {
    nombre: 'uq_pedido_pagos_externo', tabla: 'pedido_pagos', columnas: ['proveedor', 'referencia_externa'], obligatorio: true,
    efecto_si_falta: 'un reenvío del aviso de la pasarela puede registrar el mismo cobro dos veces',
    script: 'doc/migracion_tienda_v2.sql',
  },
  {
    nombre: 'uq_pedido_pagos_idempotencia', tabla: 'pedido_pagos', columnas: ['id_pedido', 'clave_idempotencia'], obligatorio: true,
    efecto_si_falta: 'un reintento del pago del cliente puede registrar el cobro dos veces',
    script: 'doc/migracion_tienda_v2.sql',
  },
  {
    nombre: 'uq_pasarela_eventos', tabla: 'pasarela_eventos', columnas: ['proveedor', 'referencia', 'tipo'], obligatorio: true,
    efecto_si_falta: 'los reenvíos de la pasarela se guardan repetidos en pasarela_eventos (no cambia el cobro)',
    script: 'doc/migracion_tienda_v2.sql',
  },
  {
    nombre: 'uq_recepciones_clave_idempotencia', tabla: 'recepciones', columnas: ['clave_idempotencia'], obligatorio: true,
    efecto_si_falta: 'dos envíos simultáneos de la misma recepción en procesos distintos pueden sumar el stock dos veces',
    script: 'sql/fase16_correcciones_operacion.sql',
  },
  {
    nombre: 'uq_caja_arqueos_clave', tabla: 'caja_arqueos', columnas: ['clave_idempotencia'], obligatorio: true,
    efecto_si_falta: 'un reintento del arqueo puede guardarlo dos veces',
    script: 'sql/fase11_caja_arqueo_ventas.sql',
  },
  {
    nombre: 'uq_configuraciones_clave', tabla: 'configuraciones', columnas: ['clave'], obligatorio: true,
    efecto_si_falta: 'una clave de configuración podría quedar repetida y leerse un valor viejo',
    script: 'sql/fase8_correcciones_esquema.sql',
  },
  {
    nombre: 'uq_comprobantes_serie_numero', tabla: 'comprobantes', columnas: ['serie', 'numero'], obligatorio: true,
    efecto_si_falta: 'dos comprobantes podrían salir con la misma serie y número',
    script: 'doc/migracion_admin_v3.sql',
  },
  {
    nombre: 'uq_recepciones_proveedor_guia', tabla: 'recepciones', columnas: ['id_proveedor', 'upper(btrim((nro_guia)::text))'], obligatorio: false,
    efecto_si_falta: 'una guía repetida del mismo proveedor se controla solo con la configuración recepcion_guia_repetida (avisar · bloquear); actívelo tras revisar sql/diagnostico_recepciones_duplicadas.sql',
    script: 'sql/fase21_stock_y_pedidos.sql (bloque 3, comentado)',
  },
  // Fase 9.2 (datos limpios): opcionales hasta que el diagnóstico de duplicados salga vacío.
  {
    nombre: 'uq_clientes_dni', tabla: 'clientes', columnas: ['dni'], obligatorio: false,
    efecto_si_falta: 'una segunda ficha con el mismo DNI solo la frena el candado de la API; actívelo tras revisar sql/diagnostico_duplicados.sql (bloque 1)',
    script: 'sql/fase18_concurrencia_e_indices.sql (bloque 3, comentado)',
  },
  {
    nombre: 'uq_empresas_ruc', tabla: 'empresas', columnas: ['ruc'], obligatorio: false,
    efecto_si_falta: 'una segunda empresa con el mismo RUC solo la frena el candado de la API; actívelo tras revisar sql/diagnostico_duplicados.sql (bloque 2)',
    script: 'sql/fase18_concurrencia_e_indices.sql (bloque 3, comentado)',
  },
  {
    nombre: 'uq_proveedores_ruc', tabla: 'proveedores', columnas: ['btrim((ruc)::text)'], obligatorio: false,
    efecto_si_falta: 'un RUC de proveedor repetido solo lo frena la API (409 PROVEEDOR_RUC_REPETIDO); actívelo tras revisar sql/diagnostico_duplicados.sql (bloque 3)',
    script: 'sql/indices_unicos_datos_limpios.sql (bloque A, comentado)',
  },
  {
    nombre: 'uq_productos_sku', tabla: 'productos', columnas: ['lower(btrim((sku)::text))'], obligatorio: false,
    efecto_si_falta: 'un SKU repetido solo lo frena la API al guardar el producto; actívelo tras revisar sql/diagnostico_duplicados.sql (bloque 4)',
    script: 'sql/indices_unicos_datos_limpios.sql (bloque B, comentado)',
  },
  {
    nombre: 'uq_productos_codigo_barras', tabla: 'productos', columnas: ['btrim((codigo_barras)::text)'], obligatorio: false,
    efecto_si_falta: 'un código de barras repetido solo lo frena la API al guardar el producto; actívelo tras revisar sql/diagnostico_duplicados.sql (bloque 5)',
    script: 'sql/indice_unico_codigo_barras.sql',
  },
];

/** Columnas de un índice tal como las escribe pg_get_indexdef: `… USING btree (a, b) WHERE …` → ['a', 'b']. */
export function columnasDeIndice(definicion: string): string[] {
  const inicio = definicion.indexOf('USING ');
  const abre = definicion.indexOf('(', inicio >= 0 ? inicio : 0);
  if (abre < 0) return [];
  let nivel = 0;
  let cierra = -1;
  for (let i = abre; i < definicion.length; i++) {
    if (definicion[i] === '(') nivel++;
    else if (definicion[i] === ')') {
      nivel--;
      if (nivel === 0) {
        cierra = i;
        break;
      }
    }
  }
  if (cierra < 0) return [];
  const partes: string[] = [];
  let actual = '';
  nivel = 0;
  for (const c of definicion.slice(abre + 1, cierra)) {
    if (c === '(') nivel++;
    if (c === ')') nivel--;
    if (c === ',' && nivel === 0) {
      partes.push(actual);
      actual = '';
    } else actual += c;
  }
  partes.push(actual);
  return partes.map((p) => p.trim().replace(/"/g, '').toLowerCase()).filter(Boolean);
}

/**
 * Fase 8.6: «Estado del sistema» para el admin. Todas las capacidades de esquema (presente o no, qué deja de
 * funcionar si falta y qué script la crea), la restricción de stock no negativo y los índices únicos que el código
 * da por hechos. Es lo que hace seguro desplegar el back sin haber corrido todavía el SQL del mismo día.
 * Ruta aparte y protegida (`GET sistema/estado`, solo admin): `/salud` sigue siendo pública y no cambia.
 */
@Injectable()
export class EstadoSistemaService {
  constructor(
    private readonly esquema: EsquemaCajaService,
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {}

  async estado(): Promise<EstadoSistema> {
    // Relee el catálogo: la pantalla debe mostrar lo de ahora, no lo de hace un minuto.
    this.esquema.invalidar();
    const [snapshot, restricciones, indices] = await Promise.all([
      this.esquema.snapshot(),
      this.restricciones(),
      this.indicesUnicos(),
    ]);
    const capacidades = estadoCapacidades(snapshot);
    const resumen = {
      capacidades_faltantes: capacidades.filter((c) => !c.presente).length,
      restricciones_faltantes: restricciones.filter((r) => !r.presente).length,
      indices_faltantes: indices.filter((i) => i.obligatorio && !i.presente).length,
    };
    return {
      fecha: new Date().toISOString(),
      completo: resumen.capacidades_faltantes + resumen.restricciones_faltantes + resumen.indices_faltantes === 0,
      resumen,
      capacidades,
      restricciones,
      indices_unicos: indices,
    };
  }

  private async restricciones(): Promise<EstadoRestriccion[]> {
    const filas = filasDe<{ conname: string; tabla: string; convalidated: unknown }>(await this.dataSource.query(
      `SELECT c.conname, t.relname AS tabla, c.convalidated
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public' AND c.conname = ANY($1::text[])`,
      [RESTRICCIONES.map((r) => r.nombre)],
    ));
    return RESTRICCIONES.map((r) => ({
      ...r,
      presente: filas.some((f) => f.conname === r.nombre && f.tabla === r.tabla),
    }));
  }

  private async indicesUnicos(): Promise<EstadoIndiceUnico[]> {
    const tablas = [...new Set(INDICES.map((i) => i.tabla))];
    const filas = filasDe<{ nombre: string; tabla: string; valido: unknown; definicion: string }>(await this.dataSource.query(
      `SELECT ci.relname AS nombre, ct.relname AS tabla, i.indisvalid AS valido, pg_get_indexdef(i.indexrelid) AS definicion
         FROM pg_index i
         JOIN pg_class ci ON ci.oid = i.indexrelid
         JOIN pg_class ct ON ct.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = ct.relnamespace
        WHERE n.nspname = 'public' AND i.indisunique AND ct.relname = ANY($1::text[])`,
      [tablas],
    ));
    const esValido = (v: unknown) => v === true || v === 't';
    return INDICES.map((esperado) => {
      const clave = esperado.columnas.join(',');
      const coinciden = filas.filter((f) => f.tabla === esperado.tabla && columnasDeIndice(f.definicion).join(',') === clave);
      const valido = coinciden.find((f) => esValido(f.valido));
      return {
        ...esperado,
        presente: !!valido,
        encontrado: valido?.nombre ?? null,
        invalido: !valido && coinciden.length > 0,
      };
    });
  }
}
