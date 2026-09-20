-- ============================================================================
-- Reparación del esquema de PROFORMAS (cotizaciones)
-- ----------------------------------------------------------------------------
-- Es el equivalente, para correr a mano, de lo que hace ProformaRepository
-- .asegurarSchema() al arrancar la API
-- (src/repository/Repository/proforma.repository.ts).
--
-- Se puede ejecutar tantas veces como haga falta: TODO es idempotente y no
-- borra ni reescribe datos de negocio. Lo único que modifica son filas
-- heredadas que quedaron SIN código.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/proformas_reparacion.sql
--
-- Orden de los pasos (importa):
--   1. Columnas e índices que faltan.
--   2. Secuencias de las PK alineadas a MAX(id)  → evita "duplicate key".
--   3. Backfill de códigos de las filas antiguas → ANTES de alinear la
--      numeración, porque el backfill escribe en `numero`.
--   4. Secuencia de numeración correlativa alineada a MAX(numero).
--   5. FK e índice de proformas_items.
--   6. Informe final.
--
-- Una proforma NO mueve inventario: este script no toca stock ni ventas.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- Que un bloqueo ajeno no deje la sesión colgada para siempre.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Columnas e índices
-- ─────────────────────────────────────────────────────────────────────────────

-- Una proforma puede no tener cliente ni empresa (solo un nombre a mano).
ALTER TABLE proformas ALTER COLUMN id_cliente DROP NOT NULL;
ALTER TABLE proformas ALTER COLUMN id_empresa DROP NOT NULL;

ALTER TABLE proformas ADD COLUMN IF NOT EXISTS codigo                  VARCHAR(32);
ALTER TABLE proformas ADD COLUMN IF NOT EXISTS estado                  VARCHAR(20) DEFAULT 'borrador';
ALTER TABLE proformas ADD COLUMN IF NOT EXISTS observaciones           TEXT;
ALTER TABLE proformas ADD COLUMN IF NOT EXISTS valida_hasta            DATE;
ALTER TABLE proformas ADD COLUMN IF NOT EXISTS id_almacen              INTEGER;
ALTER TABLE proformas ADD COLUMN IF NOT EXISTS cliente_nombre_snapshot VARCHAR(250);
ALTER TABLE proformas ADD COLUMN IF NOT EXISTS telefono_envio          VARCHAR(32);
ALTER TABLE proformas ADD COLUMN IF NOT EXISTS id_venta                INTEGER;
ALTER TABLE proformas ADD COLUMN IF NOT EXISTS enviada_wa_en           TIMESTAMPTZ;
ALTER TABLE proformas ADD COLUMN IF NOT EXISTS porcentaje_igv          NUMERIC DEFAULT 18;

ALTER TABLE proformas_items ADD COLUMN IF NOT EXISTS descripcion_snapshot VARCHAR(250);
ALTER TABLE proformas_items ADD COLUMN IF NOT EXISTS sku_snapshot         VARCHAR(80);

-- Índice ÚNICO PARCIAL: varias filas heredadas pueden tener codigo NULL, pero
-- dos proformas nunca pueden compartir el mismo código.
CREATE UNIQUE INDEX IF NOT EXISTS uq_proformas_codigo
  ON proformas (codigo) WHERE codigo IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_proformas_estado ON proformas (estado);


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Secuencias de las claves primarias alineadas a MAX(id)
--    Tras un restore o una carga manual la secuencia queda atrasada y el
--    siguiente INSERT revienta con "duplicate key value violates ..._pkey".
--    La secuencia SOLO se adelanta, nunca se retrocede: retrocederla podría
--    repetir un id que otra transacción ya tomó y todavía no confirmó.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  r           record;
  v_seq       text;
  v_max       bigint;
  v_ultimo    bigint;
  v_llamada   boolean;
  v_siguiente bigint;
BEGIN
  FOR r IN
    SELECT 'proformas'::text AS tabla, 'id_proforma'::text AS columna
    UNION ALL
    SELECT 'proformas_items', 'id_item'
  LOOP
    v_seq := pg_get_serial_sequence(r.tabla, r.columna);

    -- Columna con DEFAULT nextval('...') pero sin dependencia registrada.
    IF v_seq IS NULL THEN
      SELECT substring(column_default FROM 'nextval\(''([^'']+)''')
        INTO v_seq
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name   = r.tabla
         AND column_name  = r.columna;
    END IF;

    IF v_seq IS NULL THEN
      RAISE WARNING '%.% no usa secuencia; no hay nada que realinear', r.tabla, r.columna;
      CONTINUE;
    END IF;

    EXECUTE format('SELECT MAX(%I) FROM %I', r.columna, r.tabla) INTO v_max;
    EXECUTE format('SELECT last_value, is_called FROM %s', v_seq) INTO v_ultimo, v_llamada;
    v_siguiente := CASE WHEN v_llamada THEN v_ultimo + 1 ELSE v_ultimo END;

    IF v_max IS NULL THEN
      IF NOT v_llamada THEN
        PERFORM setval(v_seq, 1, false);   -- tabla vacía: la próxima fila será 1
      END IF;
    ELSIF v_siguiente <= v_max THEN
      PERFORM setval(v_seq, v_max, true);
      RAISE NOTICE 'Secuencia % adelantada a %', v_seq, v_max;
    END IF;
  END LOOP;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Backfill de códigos (filas heredadas con codigo NULL)
--    numero = id_proforma, serie = 'COT', codigo = 'COT-000001'.
--    Si ese código ya lo tiene otra fila, la fila se deja como está y se avisa:
--    jamás se pisa un código que ya se le envió a un cliente.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  r        record;
  v_codigo text;
BEGIN
  FOR r IN SELECT id_proforma FROM proformas WHERE codigo IS NULL ORDER BY id_proforma LOOP
    v_codigo := 'COT-' || CASE
      WHEN length(r.id_proforma::text) >= 6 THEN r.id_proforma::text
      ELSE lpad(r.id_proforma::text, 6, '0')
    END;

    IF EXISTS (SELECT 1 FROM proformas WHERE codigo = v_codigo) THEN
      RAISE WARNING 'Proforma %: el código % ya existe; se deja sin código', r.id_proforma, v_codigo;
      CONTINUE;
    END IF;

    BEGIN
      UPDATE proformas
         SET numero = r.id_proforma,
             serie  = 'COT',
             codigo = v_codigo
       WHERE id_proforma = r.id_proforma
         AND codigo IS NULL;
    EXCEPTION WHEN unique_violation THEN
      -- Carrera con otra sesión que acaba de tomar ese mismo código.
      RAISE WARNING 'Proforma %: el código % ya existe; se deja sin código', r.id_proforma, v_codigo;
    END;
  END LOOP;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Numeración correlativa por secuencia
--    El número lo reparte la secuencia, no un MAX(numero)+1: así dos ventas
--    simultáneas nunca reciben el mismo correlativo.
--    Se ignoran los números >= 1000000, que son timestamps heredados.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS proformas_numero_seq;

DO $$
DECLARE
  v_max       bigint;
  v_ultimo    bigint;
  v_llamada   boolean;
  v_siguiente bigint;
BEGIN
  SELECT MAX(numero) INTO v_max
    FROM proformas
   WHERE numero > 0 AND numero < 1000000;

  SELECT last_value, is_called INTO v_ultimo, v_llamada FROM proformas_numero_seq;
  v_siguiente := CASE WHEN v_llamada THEN v_ultimo + 1 ELSE v_ultimo END;

  IF v_max IS NOT NULL AND v_siguiente <= v_max THEN
    PERFORM setval('proformas_numero_seq', v_max, true);
    RAISE NOTICE 'proformas_numero_seq adelantada a %', v_max;
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Integridad de los ítems
--    La FK se crea NOT VALID para que ítems huérfanos antiguos no impidan
--    crearla; igualmente protege todo lo nuevo. Después se intenta validar.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid  = 'proformas_items'::regclass
       AND confrelid = 'proformas'::regclass
       AND contype   = 'f'
  ) THEN
    ALTER TABLE proformas_items
      ADD CONSTRAINT fk_proformas_items_proforma
      FOREIGN KEY (id_proforma) REFERENCES proformas (id_proforma)
      ON DELETE CASCADE
      NOT VALID;
    RAISE NOTICE 'FK fk_proformas_items_proforma creada (NOT VALID)';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'proformas_items'::regclass
       AND conname  = 'fk_proformas_items_proforma'
       AND NOT convalidated
  ) THEN
    BEGIN
      ALTER TABLE proformas_items VALIDATE CONSTRAINT fk_proformas_items_proforma;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE WARNING 'Hay ítems de proforma huérfanos; la FK queda NOT VALID (protege solo filas nuevas)';
    END;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_proformas_items_id_proforma
  ON proformas_items (id_proforma);


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Informe: proformas que siguen sin código (su correlativo ya estaba en uso)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_pendientes text;
BEGIN
  SELECT string_agg(id_proforma::text, ', ' ORDER BY id_proforma)
    INTO v_pendientes
    FROM proformas
   WHERE codigo IS NULL;

  IF v_pendientes IS NOT NULL THEN
    RAISE WARNING 'Proformas que siguen sin código: %', v_pendientes;
  ELSE
    RAISE NOTICE 'Todas las proformas tienen código.';
  END IF;
END $$;

COMMIT;

-- Comprobación rápida después de correrlo:
--   SELECT id_proforma, serie, numero, codigo, estado, total FROM proformas ORDER BY id_proforma;
--   SELECT last_value, is_called FROM proformas_numero_seq;
