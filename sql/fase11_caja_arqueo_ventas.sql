-- =============================================================================
-- FASE 11 · Caja: arqueo, movimientos de efectivo y ventas sin DDL en caliente
-- PostgreSQL 12+ · idempotente · aditivo (no borra ni reescribe datos)
-- =============================================================================
-- Diagnóstico del 2026-10-13 contra la BD de Railway (solo lectura):
--   * La API ejecutaba DDL en cada petición (GET /venta, GET /caja/sesion, dentro de la
--     transacción de venta, cuentas bancarias y crédito). Desde esta versión NO ejecuta
--     DDL nunca: al arrancar solo lee el catálogo y, si falta algo, degrada con el aviso
--     "Falta ejecutar sql/fase11_caja_arqueo_ventas.sql en Railway".
--   * Todo lo que ese código "aseguraba" YA EXISTE en producción (secciones 1 a 4):
--     ventas.estado/id_empresa/clave_idempotencia (+ índices), venta_stock_salida,
--     aperturas_caja.id_usuario/monto_inicial, cierres_caja.id_usuario/monto_conteo/
--     observacion, cuentas_bancarias, columnas de cobro de venta_pago, crédito/CxC e
--     índices del POS. En producción esas secciones no hacen nada (ni toman candados:
--     cada objeto se comprueba en el catálogo antes de crearlo). Sirven para entornos
--     nuevos.
--   * Lo NUEVO (secciones 5 a 7):
--       5) caja_arqueos + caja_arqueo_denominaciones (arqueo parcial y de cierre).
--          La tabla antigua arqueo_caja (0 filas, sin uso en el código, ligada a la caja
--          y no al turno, sin usuario, tipo, medios de pago ni denominaciones) se deja
--          intacta: no encaja con un arqueo por turno y no se borra nada.
--       6) movimientos_caja.id_apertura / id_usuario: ingresos y egresos de efectivo
--          ligados al turno (hoy la tabla solo tiene id_caja y 1 fila de prueba).
--       7) Índices para calcular el efectivo esperado del turno sin recorrer tablas.
--
-- Cómo ejecutarlo (en horario de poca venta; tarda menos de un segundo):
--   psql "$DATABASE_PUBLIC_URL" -v ON_ERROR_STOP=1 -f sql/fase11_caja_arqueo_ventas.sql
--   o DBeaver sobre la conexión de Railway en modo auto-commit.
-- Sin BEGIN/COMMIT global: cada sentencia es atómica y se puede repetir. Si alguna
-- falla por lock_timeout (había una transacción larga), vuelva a correr el script.
-- La API detecta el cambio sola en menos de un minuto (no hace falta reiniciar).
-- =============================================================================

SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- Ayudantes temporales (viven solo en esta sesión): comprueban el catálogo antes de
-- tocar una tabla, así en producción no se toma ningún candado si el objeto ya existe.
CREATE OR REPLACE FUNCTION pg_temp.agregar_columna(p_tabla text, p_columna text, p_definicion text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF to_regclass(format('public.%I', p_tabla)) IS NULL THEN
    RAISE WARNING 'La tabla % no existe: se omite la columna %.', p_tabla, p_columna;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = p_tabla AND column_name = p_columna
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN %I %s', p_tabla, p_columna, p_definicion);
    RAISE NOTICE 'Columna %.% agregada.', p_tabla, p_columna;
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.crear_indice(p_nombre text, p_tabla text, p_sql text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF to_regclass(format('public.%I', p_tabla)) IS NULL THEN
    RAISE WARNING 'La tabla % no existe: se omite el índice %.', p_tabla, p_nombre;
    RETURN;
  END IF;
  IF to_regclass(format('public.%I', p_nombre)) IS NULL THEN
    EXECUTE p_sql;
    RAISE NOTICE 'Índice % creado.', p_nombre;
  END IF;
END
$fn$;


-- 1) Ventas (ya existe en producción) -------------------------------------------
SELECT pg_temp.agregar_columna('ventas', 'estado', $$VARCHAR(20) DEFAULT 'activa'$$);
SELECT pg_temp.agregar_columna('ventas', 'id_empresa', 'INTEGER REFERENCES public.empresas(id_empresa)');
SELECT pg_temp.agregar_columna('ventas', 'origen', $$VARCHAR(20) DEFAULT 'mostrador'$$);
SELECT pg_temp.agregar_columna('ventas', 'total_descuento', 'NUMERIC(12, 2) DEFAULT 0');
-- Idempotencia de ventas: el POS manda clave_idempotencia (o la cabecera Idempotency-Key).
SELECT pg_temp.agregar_columna('ventas', 'clave_idempotencia', 'VARCHAR(80)');
SELECT pg_temp.crear_indice('idx_ventas_id_empresa', 'ventas',
  'CREATE INDEX idx_ventas_id_empresa ON public.ventas (id_empresa)');

-- Índice único parcial de la clave (en producción ya existe: uq_ventas_clave_idempotencia).
DO $$
DECLARE
  v_repetidas integer;
BEGIN
  IF to_regclass('public.uq_ventas_clave_idempotencia') IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT COUNT(*) INTO v_repetidas
    FROM (SELECT clave_idempotencia FROM public.ventas
           WHERE clave_idempotencia IS NOT NULL AND clave_idempotencia <> ''
           GROUP BY clave_idempotencia HAVING COUNT(*) > 1) d;
  IF v_repetidas > 0 THEN
    RAISE WARNING 'ventas tiene % claves de idempotencia repetidas: no se crea el índice único (la API igual serializa con un candado).', v_repetidas;
  ELSE
    CREATE UNIQUE INDEX uq_ventas_clave_idempotencia ON public.ventas (clave_idempotencia)
      WHERE clave_idempotencia IS NOT NULL AND clave_idempotencia <> '';
    RAISE NOTICE 'Índice uq_ventas_clave_idempotencia creado.';
  END IF;
END $$;

-- Salidas de stock por venta (para devolver al mismo almacén al anular).
CREATE TABLE IF NOT EXISTS public.venta_stock_salida (
  id          SERIAL PRIMARY KEY,
  id_venta    INTEGER NOT NULL REFERENCES public.ventas(id_venta) ON DELETE CASCADE,
  id_producto INTEGER NOT NULL,
  id_almacen  INTEGER NOT NULL,
  cantidad    NUMERIC(12, 3) NOT NULL
);
SELECT pg_temp.crear_indice('idx_venta_stock_salida_venta', 'venta_stock_salida',
  'CREATE INDEX idx_venta_stock_salida_venta ON public.venta_stock_salida (id_venta)');

-- Cobro: referencia, efectivo recibido, vuelto y datos de tarjeta/transferencia/Yape.
SELECT pg_temp.agregar_columna('venta_pago', 'referencia', 'VARCHAR(120)');
SELECT pg_temp.agregar_columna('venta_pago', 'monto_recibido', 'NUMERIC(12, 2)');
SELECT pg_temp.agregar_columna('venta_pago', 'vuelto', 'NUMERIC(12, 2)');
SELECT pg_temp.agregar_columna('venta_pago', 'id_cuenta_bancaria', 'INTEGER');
SELECT pg_temp.agregar_columna('venta_pago', 'voucher_pos', 'VARCHAR(80)');
SELECT pg_temp.agregar_columna('venta_pago', 'validacion', 'VARCHAR(40)');
SELECT pg_temp.agregar_columna('venta_pago', 'referencia_externa', 'VARCHAR(120)');

-- Índices de búsqueda del POS (antes los creaba la API en cada búsqueda).
SELECT pg_temp.crear_indice('idx_productos_estado', 'productos',
  'CREATE INDEX idx_productos_estado ON public.productos (estado)');
SELECT pg_temp.crear_indice('idx_productos_codigo_barras', 'productos',
  $$CREATE INDEX idx_productos_codigo_barras ON public.productos (codigo_barras) WHERE codigo_barras IS NOT NULL AND codigo_barras <> ''$$);
SELECT pg_temp.crear_indice('idx_productos_sku_lower', 'productos',
  'CREATE INDEX idx_productos_sku_lower ON public.productos (LOWER(sku))');
SELECT pg_temp.crear_indice('idx_productos_nombre_lower', 'productos',
  'CREATE INDEX idx_productos_nombre_lower ON public.productos (LOWER(nombre))');
SELECT pg_temp.crear_indice('idx_inventario_producto_almacen', 'inventario',
  'CREATE INDEX idx_inventario_producto_almacen ON public.inventario (id_producto, id_almacen)');


-- 2) Sesión de caja (ya existe en producción) ------------------------------------
SELECT pg_temp.agregar_columna('aperturas_caja', 'id_usuario', 'INTEGER');
SELECT pg_temp.agregar_columna('aperturas_caja', 'monto_inicial', 'NUMERIC(12, 2)');
SELECT pg_temp.agregar_columna('cierres_caja', 'id_usuario', 'INTEGER');
SELECT pg_temp.agregar_columna('cierres_caja', 'monto_conteo', 'NUMERIC(12, 2)');
SELECT pg_temp.agregar_columna('cierres_caja', 'observacion', 'TEXT');
SELECT pg_temp.crear_indice('idx_aperturas_caja_id_usuario', 'aperturas_caja',
  'CREATE INDEX idx_aperturas_caja_id_usuario ON public.aperturas_caja (id_usuario) WHERE id_usuario IS NOT NULL');

-- Modo de caja: blando = no bloquea cobros; estricto = exige caja abierta.
INSERT INTO public.configuraciones (clave, valor)
SELECT v.clave, v.valor
  FROM (VALUES ('caja_modo', 'blando'), ('caja_estricto_bypass_admin', 'false')) AS v(clave, valor)
 WHERE NOT EXISTS (SELECT 1 FROM public.configuraciones c WHERE c.clave = v.clave);


-- 3) Cuentas bancarias del POS (ya existe en producción) -------------------------
CREATE TABLE IF NOT EXISTS public.cuentas_bancarias (
  id_cuenta       SERIAL PRIMARY KEY,
  banco           VARCHAR(80) NOT NULL,
  alias           VARCHAR(80),
  tipo_cuenta     VARCHAR(40) DEFAULT 'ahorros',
  numero_cuenta   VARCHAR(40),
  cci             VARCHAR(30),
  titular         VARCHAR(120),
  moneda          VARCHAR(3) DEFAULT 'PEN',
  activo          BOOLEAN DEFAULT TRUE,
  es_yape         BOOLEAN DEFAULT FALSE,
  orden           INTEGER DEFAULT 0,
  creado_en       TIMESTAMPTZ DEFAULT NOW()
);


-- 4) Crédito y cuentas por cobrar (ya existe en producción) ----------------------
SELECT pg_temp.agregar_columna('clientes', 'credito_activo', 'BOOLEAN DEFAULT FALSE');
SELECT pg_temp.agregar_columna('clientes', 'limite_credito', 'NUMERIC(12, 2) DEFAULT 0');
SELECT pg_temp.agregar_columna('clientes', 'dias_credito', 'INTEGER DEFAULT 15');
SELECT pg_temp.agregar_columna('empresas', 'credito_activo', 'BOOLEAN DEFAULT FALSE');
SELECT pg_temp.agregar_columna('empresas', 'limite_credito', 'NUMERIC(12, 2) DEFAULT 0');
SELECT pg_temp.agregar_columna('empresas', 'dias_credito', 'INTEGER DEFAULT 15');

CREATE TABLE IF NOT EXISTS public.cuentas_por_cobrar (
  id_cxc              SERIAL PRIMARY KEY,
  id_venta            INTEGER NOT NULL REFERENCES public.ventas(id_venta),
  id_cliente          INTEGER REFERENCES public.clientes(id_cliente),
  id_empresa          INTEGER REFERENCES public.empresas(id_empresa),
  monto_total         NUMERIC(12, 2) NOT NULL,
  saldo               NUMERIC(12, 2) NOT NULL,
  fecha_emision       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fecha_vencimiento   DATE NOT NULL,
  estado              VARCHAR(20) NOT NULL DEFAULT 'pendiente',
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SELECT pg_temp.crear_indice('idx_cxc_estado', 'cuentas_por_cobrar',
  'CREATE INDEX idx_cxc_estado ON public.cuentas_por_cobrar (estado)');
SELECT pg_temp.crear_indice('idx_cxc_cliente', 'cuentas_por_cobrar',
  'CREATE INDEX idx_cxc_cliente ON public.cuentas_por_cobrar (id_cliente)');
SELECT pg_temp.crear_indice('idx_cxc_empresa', 'cuentas_por_cobrar',
  'CREATE INDEX idx_cxc_empresa ON public.cuentas_por_cobrar (id_empresa)');
SELECT pg_temp.crear_indice('idx_cxc_venta', 'cuentas_por_cobrar',
  'CREATE INDEX idx_cxc_venta ON public.cuentas_por_cobrar (id_venta)');

CREATE TABLE IF NOT EXISTS public.abonos_credito (
  id_abono    SERIAL PRIMARY KEY,
  id_cxc      INTEGER NOT NULL REFERENCES public.cuentas_por_cobrar(id_cxc) ON DELETE CASCADE,
  id_metodo   INTEGER REFERENCES public.metodos_pago(id_metodo),
  monto       NUMERIC(12, 2) NOT NULL,
  referencia  VARCHAR(120),
  id_usuario  INTEGER,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.metodos_pago (nombre, tipo, descripcion, activo, orden)
SELECT 'Efectivo', 'efectivo', 'Pago en efectivo en caja', TRUE, 1
 WHERE NOT EXISTS (
   SELECT 1 FROM public.metodos_pago
    WHERE LOWER(TRIM(nombre)) = 'efectivo' OR LOWER(TRIM(COALESCE(tipo, ''))) = 'efectivo'
 );
INSERT INTO public.metodos_pago (nombre, tipo, descripcion, activo, orden)
SELECT 'Crédito', 'credito', 'Venta a crédito (cuentas por cobrar)', TRUE, 90
 WHERE NOT EXISTS (
   SELECT 1 FROM public.metodos_pago
    WHERE LOWER(TRIM(COALESCE(tipo, ''))) = 'credito' OR LOWER(TRIM(nombre)) IN ('crédito', 'credito')
 );


-- 5) Arqueo de caja (NUEVO) ------------------------------------------------------
-- Un turno (apertura) puede tener varios arqueos parciales y de cierre; el cierre del
-- turno toma el último de tipo 'cierre' y lo enlaza en id_cierre. Montos en soles con
-- 2 decimales; la API calcula todo en céntimos enteros y nunca confía en totales del cliente.
CREATE TABLE IF NOT EXISTS public.caja_arqueos (
  id_arqueo                  SERIAL PRIMARY KEY,
  id_apertura                INTEGER NOT NULL REFERENCES public.aperturas_caja(id_apertura),
  id_caja                    INTEGER REFERENCES public.cajas(id_caja),
  id_usuario                 INTEGER REFERENCES public.usuarios(id_usuario) ON DELETE SET NULL,
  tipo                       VARCHAR(10) NOT NULL,
  fecha                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  monto_inicial              NUMERIC(12, 2) NOT NULL DEFAULT 0,
  efectivo_esperado          NUMERIC(12, 2) NOT NULL,
  efectivo_contado           NUMERIC(12, 2) NOT NULL,
  diferencia                 NUMERIC(12, 2) NOT NULL,
  -- {"efectivo": {...}, "<id_metodo>": {"nombre", "categoria", "esperado", "declarado", "diferencia"}}
  resumen_metodos            JSONB NOT NULL DEFAULT '{}'::jsonb,
  observacion                TEXT,
  conteo_por_denominaciones  BOOLEAN NOT NULL DEFAULT TRUE,
  clave_idempotencia         VARCHAR(80),
  id_cierre                  INTEGER REFERENCES public.cierres_caja(id_cierre),
  creado_en                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_caja_arqueos_tipo CHECK (tipo IN ('parcial', 'cierre')),
  CONSTRAINT ck_caja_arqueos_contado CHECK (efectivo_contado >= 0),
  CONSTRAINT ck_caja_arqueos_diferencia CHECK (diferencia = efectivo_contado - efectivo_esperado),
  CONSTRAINT ck_caja_arqueos_observacion CHECK (observacion IS NULL OR length(observacion) <= 500)
);
SELECT pg_temp.crear_indice('ix_caja_arqueos_apertura', 'caja_arqueos',
  'CREATE INDEX ix_caja_arqueos_apertura ON public.caja_arqueos (id_apertura, id_arqueo DESC)');
SELECT pg_temp.crear_indice('uq_caja_arqueos_clave', 'caja_arqueos',
  'CREATE UNIQUE INDEX uq_caja_arqueos_clave ON public.caja_arqueos (clave_idempotencia) WHERE clave_idempotencia IS NOT NULL');

-- Conteo por denominación (billetes 200/100/50/20/10; monedas 5/2/1/0.50/0.20/0.10).
CREATE TABLE IF NOT EXISTS public.caja_arqueo_denominaciones (
  id            SERIAL PRIMARY KEY,
  id_arqueo     INTEGER NOT NULL REFERENCES public.caja_arqueos(id_arqueo) ON DELETE CASCADE,
  tipo          VARCHAR(10) NOT NULL,
  denominacion  NUMERIC(8, 2) NOT NULL,
  cantidad      INTEGER NOT NULL,
  subtotal      NUMERIC(12, 2) NOT NULL,
  CONSTRAINT ck_caja_arqueo_den_tipo CHECK (tipo IN ('billete', 'moneda')),
  CONSTRAINT ck_caja_arqueo_den_valor CHECK (denominacion > 0),
  CONSTRAINT ck_caja_arqueo_den_cantidad CHECK (cantidad >= 0),
  CONSTRAINT ck_caja_arqueo_den_subtotal CHECK (subtotal = denominacion * cantidad),
  CONSTRAINT uq_caja_arqueo_den UNIQUE (id_arqueo, denominacion)
);


-- 6) Ingresos y egresos de efectivo ligados al turno (NUEVO) ---------------------
SELECT pg_temp.agregar_columna('movimientos_caja', 'id_apertura',
  'INTEGER REFERENCES public.aperturas_caja(id_apertura)');
SELECT pg_temp.agregar_columna('movimientos_caja', 'id_usuario', 'INTEGER');
SELECT pg_temp.crear_indice('ix_movimientos_caja_apertura', 'movimientos_caja',
  'CREATE INDEX ix_movimientos_caja_apertura ON public.movimientos_caja (id_apertura) WHERE id_apertura IS NOT NULL');

-- Montos positivos en filas nuevas (NOT VALID: no revisa la fila histórica).
DO $$
BEGIN
  IF to_regclass('public.movimientos_caja') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_movimientos_caja_monto_positivo') THEN
    ALTER TABLE public.movimientos_caja
      ADD CONSTRAINT ck_movimientos_caja_monto_positivo CHECK (monto > 0) NOT VALID;
    RAISE NOTICE 'Constraint ck_movimientos_caja_monto_positivo agregado.';
  END IF;
END $$;


-- 7) Índices para el efectivo esperado del turno (NUEVO) -------------------------
SELECT pg_temp.crear_indice('ix_cierres_caja_apertura', 'cierres_caja',
  'CREATE INDEX ix_cierres_caja_apertura ON public.cierres_caja (id_apertura)');
SELECT pg_temp.crear_indice('ix_aperturas_caja_caja', 'aperturas_caja',
  'CREATE INDEX ix_aperturas_caja_caja ON public.aperturas_caja (id_caja, fecha DESC)');
SELECT pg_temp.crear_indice('ix_ventas_caja_fecha', 'ventas',
  'CREATE INDEX ix_ventas_caja_fecha ON public.ventas (id_caja, fecha) WHERE id_caja IS NOT NULL');
SELECT pg_temp.crear_indice('ix_abonos_credito_usuario_fecha', 'abonos_credito',
  'CREATE INDEX ix_abonos_credito_usuario_fecha ON public.abonos_credito (id_usuario, creado_en) WHERE id_usuario IS NOT NULL');


-- Verificación ---------------------------------------------------------------------
-- Debe listar las 2 tablas nuevas y las 2 columnas nuevas de movimientos_caja.
SELECT table_name, column_name
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND ((table_name IN ('caja_arqueos', 'caja_arqueo_denominaciones') AND column_name IN ('id_arqueo', 'id'))
     OR (table_name = 'movimientos_caja' AND column_name IN ('id_apertura', 'id_usuario'))
     OR (table_name = 'ventas' AND column_name = 'clave_idempotencia'))
 ORDER BY table_name, column_name;
