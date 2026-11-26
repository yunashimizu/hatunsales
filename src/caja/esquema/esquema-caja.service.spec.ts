import { estadoCapacidades, SnapshotEsquema } from './esquema-caja.service';

/** Catálogo con fase9 (enlace de la nota) y, si se pide, las columnas de sql/fase14_notas_credito_enlace.sql. */
function snapshot(conFase14: boolean, sin: string[] = []): SnapshotEsquema {
  const columnas: Record<string, string[]> = {
    comprobantes: ['id_comprobante', 'id_comprobante_modificado', 'nota_motivo',
      ...(conFase14 ? ['efecto_nota', 'reingresar_stock', 'efectos_aplicados', 'efectos_aplicados_en'] : [])],
    comprobante_items: ['id_item', ...(conFase14 ? ['id_item_origen'] : [])],
    venta_stock_salida: ['id', 'id_venta', 'id_producto', 'id_almacen', 'cantidad', ...(conFase14 ? ['cantidad_devuelta'] : [])],
  };
  const mapa = new Map(Object.entries(columnas).map(([tabla, lista]) => [tabla, new Set(lista.filter((c) => !sin.includes(`${tabla}.${c}`)))]));
  return new SnapshotEsquema(mapa, Date.now());
}

describe('EsquemaCajaService: capacidades de fase14 (notas de crédito)', () => {
  it('sin fase14 las notas de crédito no están disponibles (responden 503) y la anulación no descuenta devoluciones', () => {
    const s = snapshot(false);
    expect(s.tiene('notasCredito')).toBe(false);
    expect(s.tiene('ventaStockDevuelto')).toBe(false);
    expect(s.faltantes('notasCredito')).toEqual(expect.arrayContaining(['comprobantes.efecto_nota', 'comprobante_items.id_item_origen', 'venta_stock_salida.cantidad_devuelta']));
  });

  it('con fase14 completa ambas capacidades quedan disponibles; si falta una sola columna, las notas siguen apagadas', () => {
    expect(snapshot(true).tiene('notasCredito')).toBe(true);
    expect(snapshot(true).tiene('ventaStockDevuelto')).toBe(true);
    expect(snapshot(true, ['comprobantes.efectos_aplicados_en']).faltantes('notasCredito')).toEqual(['comprobantes.efectos_aplicados_en']);
  });
});

describe('EsquemaCajaService: capacidades de fase19 (autor, costo y bitácora)', () => {
  const BITACORA = ['id', 'fecha', 'id_usuario', 'rol', 'id_autorizador', 'id_almacen', 'accion', 'entidad', 'id_entidad', 'antes', 'despues', 'motivo', 'ip'];

  function catalogo(conFase19: boolean, sin: string[] = []): SnapshotEsquema {
    const columnas: Record<string, string[]> = {
      ventas: ['id_venta', 'fecha', 'total', ...(conFase19 ? ['id_usuario', 'id_almacen'] : [])],
      detalle_venta: ['id_detalle', 'id_venta', 'id_producto', ...(conFase19 ? ['costo_unitario', 'precio_referencia'] : [])],
      recepcion_items: ['id_item', 'id_recepcion', ...(conFase19 ? ['precio_compra'] : [])],
      ...(conFase19 ? { bitacora_acciones: BITACORA } : {}),
    };
    const mapa = new Map(Object.entries(columnas).map(([tabla, lista]) => [tabla, new Set(lista.filter((c) => !sin.includes(`${tabla}.${c}`)))]));
    return new SnapshotEsquema(mapa, Date.now());
  }

  it('antes de correr fase19 ninguna de las cuatro capacidades está y se sabe qué falta', () => {
    const s = catalogo(false);
    for (const c of ['ventaAutor', 'ventaCosto', 'ventaReferencia', 'recepcionCosto', 'bitacora'] as const) expect(s.tiene(c)).toBe(false);
    expect(s.faltantes('ventaAutor')).toEqual(['ventas.id_usuario', 'ventas.id_almacen']);
    expect(s.faltantes('ventaCosto')).toEqual(['detalle_venta.costo_unitario']);
    expect(s.faltantes('ventaReferencia')).toEqual(['detalle_venta.precio_referencia']);
    expect(s.faltantes('recepcionCosto')).toEqual(['recepcion_items.precio_compra']);
    expect(s.faltantes('bitacora')).toEqual(['bitacora_acciones']);
    expect(s.completo()).toBe(false);
  });

  it('con fase19 aplicada las cuatro están; una columna suelta que falte apaga solo su capacidad', () => {
    const s = catalogo(true);
    for (const c of ['ventaAutor', 'ventaCosto', 'ventaReferencia', 'recepcionCosto', 'bitacora'] as const) expect(s.tiene(c)).toBe(true);
    const parcial = catalogo(true, ['ventas.id_almacen']);
    expect(parcial.tiene('ventaAutor')).toBe(false);
    expect(parcial.tiene('ventaCosto')).toBe(true);
    // La referencia es una capacidad aparte: sin esa columna el costo se sigue guardando.
    const sinReferencia = catalogo(true, ['detalle_venta.precio_referencia']);
    expect(sinReferencia.tiene('ventaReferencia')).toBe(false);
    expect(sinReferencia.tiene('ventaCosto')).toBe(true);
    expect(sinReferencia.faltantes('ventaReferencia')).toEqual(['detalle_venta.precio_referencia']);
  });
});

describe('EsquemaCajaService: capacidades de fase20 (caja y devoluciones)', () => {
  const CAPACIDADES = ['movimientoVenta', 'gastoCategoria', 'gastoComprobante', 'cierreAutomatico'] as const;

  function catalogo(conFase20: boolean, sin: string[] = []): SnapshotEsquema {
    const columnas: Record<string, string[]> = {
      movimientos_caja: ['id_movimiento', 'id_caja', 'tipo', 'monto', 'descripcion', 'fecha', 'id_apertura', 'id_usuario',
        ...(conFase20 ? ['id_venta', 'categoria', 'nro_comprobante'] : [])],
      cierres_caja: ['id_cierre', 'id_apertura', 'monto_final', 'fecha', 'id_usuario', 'monto_conteo', 'observacion',
        ...(conFase20 ? ['automatico'] : [])],
    };
    const mapa = new Map(Object.entries(columnas).map(([tabla, lista]) => [tabla, new Set(lista.filter((c) => !sin.includes(`${tabla}.${c}`)))]));
    return new SnapshotEsquema(mapa, Date.now());
  }

  it('sin fase20 (columna ausente) ninguna de las cuatro está y cada una dice qué columna falta', () => {
    const s = catalogo(false);
    for (const c of CAPACIDADES) expect(s.tiene(c)).toBe(false);
    expect(s.faltantes('movimientoVenta')).toEqual(['movimientos_caja.id_venta']);
    expect(s.faltantes('gastoCategoria')).toEqual(['movimientos_caja.categoria']);
    expect(s.faltantes('gastoComprobante')).toEqual(['movimientos_caja.nro_comprobante']);
    expect(s.faltantes('cierreAutomatico')).toEqual(['cierres_caja.automatico']);
    // Lo de fase11 no depende de fase20.
    expect(s.tiene('movimientosPorTurno')).toBe(true);
  });

  it('con fase20 (columna presente) las cuatro están; una columna suelta que falte apaga solo la suya', () => {
    const s = catalogo(true);
    for (const c of CAPACIDADES) expect(s.tiene(c)).toBe(true);
    const sinCategoria = catalogo(true, ['movimientos_caja.categoria']);
    expect(sinCategoria.tiene('gastoCategoria')).toBe(false);
    expect(sinCategoria.tiene('gastoComprobante')).toBe(true);
    expect(sinCategoria.tiene('movimientoVenta')).toBe(true);
    const sinVenta = catalogo(true, ['movimientos_caja.id_venta']);
    expect(sinVenta.tiene('movimientoVenta')).toBe(false);
    expect(sinVenta.tiene('cierreAutomatico')).toBe(true);
    // El enlace con la venta exige también el turno del movimiento (fase11).
    expect(catalogo(true, ['movimientos_caja.id_apertura']).faltantes('movimientoVenta')).toEqual(['movimientos_caja.id_apertura']);
  });
});

describe('EsquemaCajaService: capacidades de fase21 (rastro de movimientos y usuarios por local)', () => {
  const CAPACIDADES = ['movimientoUsuario', 'movimientoAlmacen', 'movimientoDocumento'] as const;

  function catalogo(conFase21: boolean, sin: string[] = [], conUsuarioSucursal = true): SnapshotEsquema {
    const columnas: Record<string, string[]> = {
      movimientos_inventario: ['id_movimiento', 'id_producto', 'tipo', 'cantidad', 'fecha', 'id_sucursal_origen', 'id_sucursal_destino', 'descripcion',
        ...(conFase21 ? ['id_usuario', 'id_almacen', 'tipo_documento', 'id_documento'] : [])],
      ...(conUsuarioSucursal ? { usuario_sucursal: ['id_usuario', 'id_sucursal'] } : {}),
    };
    const mapa = new Map(Object.entries(columnas).map(([tabla, lista]) => [tabla, new Set(lista.filter((c) => !sin.includes(`${tabla}.${c}`)))]));
    return new SnapshotEsquema(mapa, Date.now());
  }

  it('sin fase21 (columnas ausentes) ninguna de las tres está y cada una dice qué columna falta', () => {
    const s = catalogo(false);
    for (const c of CAPACIDADES) expect(s.tiene(c)).toBe(false);
    expect(s.faltantes('movimientoUsuario')).toEqual(['movimientos_inventario.id_usuario']);
    expect(s.faltantes('movimientoAlmacen')).toEqual(['movimientos_inventario.id_almacen']);
    expect(s.faltantes('movimientoDocumento')).toEqual(['movimientos_inventario.tipo_documento', 'movimientos_inventario.id_documento']);
    // La tabla usuario_sucursal ya existe en producción: no depende de fase21.
    expect(s.tiene('usuarioSucursal')).toBe(true);
  });

  it('con fase21 (columnas presentes) las tres están; una columna suelta que falte apaga solo la suya', () => {
    const s = catalogo(true);
    for (const c of CAPACIDADES) expect(s.tiene(c)).toBe(true);
    const sinAlmacen = catalogo(true, ['movimientos_inventario.id_almacen']);
    expect(sinAlmacen.tiene('movimientoAlmacen')).toBe(false);
    expect(sinAlmacen.tiene('movimientoUsuario')).toBe(true);
    expect(sinAlmacen.tiene('movimientoDocumento')).toBe(true);
    // El documento son dos columnas que van juntas.
    expect(catalogo(true, ['movimientos_inventario.id_documento']).tiene('movimientoDocumento')).toBe(false);
  });

  it('usuarioSucursal: sin la tabla (instalación nueva) no está y lo crea fase21', () => {
    const s = catalogo(true, [], false);
    expect(s.tiene('usuarioSucursal')).toBe(false);
    expect(s.faltantes('usuarioSucursal')).toEqual(['usuario_sucursal']);
  });

  it('estadoCapacidades (8.6): cada capacidad con presente, lo que falta, su efecto y su script', () => {
    const estado = estadoCapacidades(catalogo(false));
    const usuario = estado.find((e) => e.capacidad === 'movimientoUsuario')!;
    expect(usuario).toEqual({
      capacidad: 'movimientoUsuario',
      presente: false,
      faltan: ['movimientos_inventario.id_usuario'],
      efecto_si_falta: expect.stringContaining('quién'),
      script: 'sql/fase21_stock_y_pedidos.sql',
    });
    // Las de caja sin script propio apuntan a fase11; ninguna queda sin efecto ni script.
    expect(estado.find((e) => e.capacidad === 'arqueo')!.script).toBe('sql/fase11_caja_arqueo_ventas.sql');
    for (const e of estado) {
      expect(e.efecto_si_falta.length).toBeGreaterThan(10);
      expect(e.script).toMatch(/^sql\/.+\.sql$/);
    }
    expect(estadoCapacidades(catalogo(true)).find((e) => e.capacidad === 'movimientoDocumento')).toMatchObject({ presente: true, faltan: [] });
  });
});

describe('EsquemaCajaService: capacidad de fase22 (almacén con dirección, 4.4)', () => {
  function catalogo(conFase22: boolean, sin: string[] = []): SnapshotEsquema {
    const columnas: Record<string, string[]> = {
      almacenes: ['id_almacen', 'id_sucursal', 'nombre', 'descripcion',
        ...(conFase22 ? ['direccion', 'ubigeo', 'codigo_establecimiento'] : [])],
    };
    const mapa = new Map(Object.entries(columnas).map(([tabla, lista]) => [tabla, new Set(lista.filter((c) => !sin.includes(`${tabla}.${c}`)))]));
    return new SnapshotEsquema(mapa, Date.now());
  }

  it('sin fase22 (columnas ausentes) no está, dice qué falta, su efecto y su script', () => {
    const s = catalogo(false);
    expect(s.tiene('almacenDireccion')).toBe(false);
    expect(s.faltantes('almacenDireccion')).toEqual(['almacenes.direccion', 'almacenes.ubigeo', 'almacenes.codigo_establecimiento']);
    const estado = estadoCapacidades(s).find((e) => e.capacidad === 'almacenDireccion')!;
    expect(estado).toMatchObject({ presente: false, script: 'sql/fase22_almacenes_direccion.sql' });
    expect(estado.efecto_si_falta).toContain('sucursal');
  });

  it('con fase22 (columnas presentes) está; si falta una sola columna, no', () => {
    expect(catalogo(true).tiene('almacenDireccion')).toBe(true);
    expect(catalogo(true, ['almacenes.ubigeo']).faltantes('almacenDireccion')).toEqual(['almacenes.ubigeo']);
  });
});
