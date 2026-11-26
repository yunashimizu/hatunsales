import { SnapshotEsquema } from '../caja/esquema/esquema-caja.service';
import { columnasDeIndice, EstadoSistemaService } from './estado-sistema.service';

describe('EstadoSistemaService (Fase 8.6)', () => {
  it('columnasDeIndice lee columnas y expresiones de pg_get_indexdef', () => {
    expect(columnasDeIndice('CREATE UNIQUE INDEX uq_x ON public.pedidos USING btree (id_cliente, clave_idempotencia) WHERE (clave_idempotencia IS NOT NULL)'))
      .toEqual(['id_cliente', 'clave_idempotencia']);
    expect(columnasDeIndice('CREATE UNIQUE INDEX uq_recepciones_proveedor_guia ON public.recepciones USING btree (id_proveedor, upper(btrim((nro_guia)::text))) WHERE (btrim((nro_guia)::text) <> \'\'::text)'))
      .toEqual(['id_proveedor', 'upper(btrim((nro_guia)::text))']);
    expect(columnasDeIndice('basura')).toEqual([]);
  });

  function armar(opciones: { conFase21: boolean; ck: boolean; indices: { nombre: string; tabla: string; valido: boolean; definicion: string }[] }) {
    const columnas: Record<string, string[]> = {
      movimientos_inventario: ['id_movimiento', ...(opciones.conFase21 ? ['id_usuario', 'id_almacen', 'tipo_documento', 'id_documento'] : [])],
      usuario_sucursal: ['id_usuario', 'id_sucursal'],
    };
    const snapshot = new SnapshotEsquema(new Map(Object.entries(columnas).map(([t, c]) => [t, new Set(c)])), Date.now());
    const esquema = { invalidar: jest.fn(), snapshot: jest.fn(async () => snapshot) };
    const dataSource = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM pg_constraint')) return opciones.ck ? [{ conname: 'ck_inventario_stock_no_negativo', tabla: 'inventario', convalidated: true }] : [];
        if (sql.includes('FROM pg_index')) return opciones.indices;
        return [];
      }),
    };
    return { servicio: new EstadoSistemaService(esquema as any, dataSource as any), esquema };
  }

  const indice = (nombre: string, tabla: string, cols: string, valido = true) =>
    ({ nombre, tabla, valido, definicion: `CREATE UNIQUE INDEX ${nombre} ON public.${tabla} USING btree (${cols})` });

  it('sin fase21 ni la restricción: dice qué falta, qué deja de funcionar y qué script lo crea; relee el catálogo', async () => {
    const { servicio, esquema } = armar({ conFase21: false, ck: false, indices: [] });

    const estado = await servicio.estado();

    expect(esquema.invalidar).toHaveBeenCalled();
    expect(estado.completo).toBe(false);
    const usuario = estado.capacidades.find((c) => c.capacidad === 'movimientoUsuario')!;
    expect(usuario).toMatchObject({ presente: false, script: 'sql/fase21_stock_y_pedidos.sql' });
    expect(estado.restricciones[0]).toMatchObject({ nombre: 'ck_inventario_stock_no_negativo', presente: false });
    expect(estado.restricciones[0].efecto_si_falta).toMatch(/stock negativo/);
    expect(estado.indices_unicos.every((i) => !i.presente)).toBe(true);
    // El índice opcional de guías no cuenta como faltante obligatorio.
    expect(estado.resumen.indices_faltantes).toBe(estado.indices_unicos.filter((i) => i.obligatorio).length);
  });

  it('con fase21, la restricción y los índices (aunque tengan otro nombre): las de fase21 presentes; un índice INVALID no protege', async () => {
    const { servicio } = armar({
      conFase21: true,
      ck: true,
      indices: [
        indice('uq_ventas_idempotencia', 'ventas', 'clave_idempotencia'),
        indice('uq_inventario_producto_almacen', 'inventario', 'id_producto, id_almacen', false),
      ],
    });

    const estado = await servicio.estado();

    for (const c of ['movimientoUsuario', 'movimientoAlmacen', 'movimientoDocumento', 'usuarioSucursal']) {
      expect(estado.capacidades.find((x) => x.capacidad === c)!.presente).toBe(true);
    }
    expect(estado.restricciones[0].presente).toBe(true);
    expect(estado.indices_unicos.find((i) => i.tabla === 'ventas')).toMatchObject({ presente: true, encontrado: 'uq_ventas_idempotencia' });
    expect(estado.indices_unicos.find((i) => i.tabla === 'inventario')).toMatchObject({ presente: false, invalido: true });
  });

  it('Fase 9.2: los únicos de datos limpios son opcionales y se reconocen por su expresión', async () => {
    const { servicio } = armar({
      conFase21: true,
      ck: true,
      indices: [
        indice('uq_proveedores_ruc', 'proveedores', 'btrim((ruc)::text)'),
        indice('otro_nombre_sku', 'productos', 'lower(btrim((sku)::text))'),
      ],
    });

    const estado = await servicio.estado();

    expect(estado.indices_unicos.find((i) => i.nombre === 'uq_proveedores_ruc')).toMatchObject({ presente: true, obligatorio: false });
    expect(estado.indices_unicos.find((i) => i.nombre === 'uq_productos_sku')).toMatchObject({ presente: true, encontrado: 'otro_nombre_sku' });
    for (const n of ['uq_clientes_dni', 'uq_empresas_ruc', 'uq_productos_codigo_barras']) {
      expect(estado.indices_unicos.find((i) => i.nombre === n)).toMatchObject({ presente: false, obligatorio: false });
    }
    // Ninguno de ellos cuenta como faltante obligatorio.
    expect(estado.resumen.indices_faltantes).toBe(estado.indices_unicos.filter((i) => i.obligatorio && !i.presente).length);
  });
});
