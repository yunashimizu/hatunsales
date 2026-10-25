-- =============================================================================
-- FASE 16 · Correcciones de operación: recepción idempotente, un cliente por cuenta
--           y un usuario por correo (sin distinguir mayúsculas)
-- PostgreSQL 12+ · idempotente · aditivo (no borra ni reescribe datos)
-- =============================================================================
-- Propósito (auditoría del 2026-10-21, paquete E-operaciones):
--   1) recepciones.clave_idempotencia + índice único parcial: un reintento de
--      "Confirmar recepción" (respuesta perdida, doble envío) devuelve la recepción ya
--      registrada en vez de crear otra y sumar el stock dos veces.
--   2) uq_clientes_usuario: una cuenta de la tienda (usuarios) tiene a lo sumo UN cliente.
--      POST /cliente/registro era público y permitía colgar un segundo cliente de la
--      cuenta de otra persona; la tienda resolvía uno al azar.
--   3) uq_usuarios_email_lower: un correo = una cuenta, sin distinguir mayúsculas (el login
--      ya compara con LOWER). Evita duplicados por doble clic en "Crear cuenta" o por un
--      correo antiguo guardado con mayúsculas.
--
-- Los índices únicos 2) y 3) SOLO se crean si no hay duplicados. Si los hay, el script
-- avisa (WARNING) con la consulta para verlos y no crea el índice: hay que revisar y
-- unificar esas filas a mano (este script nunca borra ni modifica datos) y volver a
-- correrlo.
--
-- Sin este script la API funciona igual que hoy:
--   * la recepción se confirma en una sola transacción (todo o nada), pero sin la columna
--     un reintento podría duplicarla (la API lo avisa una vez en el log);
--   * el registro de cuentas serializa por correo con un candado consultivo y busca sin
--     distinguir mayúsculas; el índice es la última defensa (también contra el alta de
--     usuarios desde el panel).
--
-- Orden: después de fase11 (ya aplicada). Independiente de fase12/13/14/15.
-- Cómo ejecutarlo (tarda menos de un segundo; las tablas son pequeñas):
--   psql "$DATABASE_PUBLIC_URL" -v ON_ERROR_STOP=1 -f sql/fase16_correcciones_operacion.sql
-- Sin BEGIN/COMMIT global: cada sentencia es atómica y el script se puede repetir.
-- Los índices de clientes y usuarios se crean sin CONCURRENTLY (no se puede dentro de un
-- bloque DO): bloquean escrituras en esas tablas solo los milisegundos que tarda.
-- Si una sentencia falla por lock_timeout (había una transacción larga), vuelva a correrlo.
--
-- Verificación posterior (al final del script hay un resumen con RAISE NOTICE):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'recepciones' AND column_name = 'clave_idempotencia';
--   SELECT indexname, indexdef FROM pg_indexes
--    WHERE indexname IN ('uq_recepciones_clave_idempotencia', 'uq_clientes_usuario', 'uq_usuarios_email_lower');
-- =============================================================================

SET lock_timeout = '5s';
SET statement_timeout = '120s';


-- 1) Recepción idempotente -------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.recepciones') IS NULL THEN
    RAISE NOTICE 'La tabla recepciones no existe todavía (la crea la API en la primera recepción): vuelva a correr este script después.';
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'recepciones' AND column_name = 'clave_idempotencia'
  ) THEN
    ALTER TABLE public.recepciones ADD COLUMN clave_idempotencia VARCHAR(80);
    RAISE NOTICE 'Columna recepciones.clave_idempotencia agregada.';
  END IF;
END $$;

DO $$
DECLARE
  v_repetidas integer;
BEGIN
  IF to_regclass('public.recepciones') IS NULL
     OR to_regclass('public.uq_recepciones_clave_idempotencia') IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT COUNT(*) INTO v_repetidas
    FROM (SELECT clave_idempotencia FROM public.recepciones
           WHERE clave_idempotencia IS NOT NULL
           GROUP BY clave_idempotencia HAVING COUNT(*) > 1) d;
  IF v_repetidas > 0 THEN
    RAISE WARNING 'recepciones tiene % claves de idempotencia repetidas: no se crea uq_recepciones_clave_idempotencia (la API igual serializa con un candado por clave).', v_repetidas;
  ELSE
    CREATE UNIQUE INDEX uq_recepciones_clave_idempotencia
        ON public.recepciones (clave_idempotencia)
     WHERE clave_idempotencia IS NOT NULL;
    RAISE NOTICE 'Índice uq_recepciones_clave_idempotencia creado.';
  END IF;
END $$;


-- 2) Un cliente por cuenta de la tienda ------------------------------------------
-- Para ver los duplicados:
--   SELECT id_usuario, array_agg(id_cliente ORDER BY id_cliente) AS clientes
--     FROM clientes WHERE id_usuario IS NOT NULL
--    GROUP BY id_usuario HAVING COUNT(*) > 1;
DO $$
DECLARE
  v_repetidas integer;
BEGIN
  IF to_regclass('public.clientes') IS NULL
     OR to_regclass('public.uq_clientes_usuario') IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT COUNT(*) INTO v_repetidas
    FROM (SELECT id_usuario FROM public.clientes
           WHERE id_usuario IS NOT NULL
           GROUP BY id_usuario HAVING COUNT(*) > 1) d;
  IF v_repetidas > 0 THEN
    RAISE WARNING '% cuentas tienen más de un cliente: no se crea uq_clientes_usuario. Revise con la consulta de la cabecera de la sección 2, deje un solo cliente por cuenta y vuelva a correr el script.', v_repetidas;
  ELSE
    CREATE UNIQUE INDEX uq_clientes_usuario ON public.clientes (id_usuario) WHERE id_usuario IS NOT NULL;
    RAISE NOTICE 'Índice uq_clientes_usuario creado.';
  END IF;
END $$;


-- 3) Un usuario por correo (sin distinguir mayúsculas) ---------------------------
-- Los correos vacíos no cuentan (cuentas antiguas sin correo).
-- Para ver los duplicados:
--   SELECT lower(email) AS correo, array_agg(id_usuario ORDER BY id_usuario) AS usuarios
--     FROM usuarios WHERE email IS NOT NULL AND btrim(email) <> ''
--    GROUP BY lower(email) HAVING COUNT(*) > 1;
DO $$
DECLARE
  v_repetidas integer;
BEGIN
  IF to_regclass('public.usuarios') IS NULL
     OR to_regclass('public.uq_usuarios_email_lower') IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT COUNT(*) INTO v_repetidas
    FROM (SELECT lower(email) FROM public.usuarios
           WHERE email IS NOT NULL AND btrim(email) <> ''
           GROUP BY lower(email) HAVING COUNT(*) > 1) d;
  IF v_repetidas > 0 THEN
    RAISE WARNING '% correos están repetidos (sin distinguir mayúsculas): no se crea uq_usuarios_email_lower. Revise con la consulta de la cabecera de la sección 3, unifique o cambie esos correos y vuelva a correr el script.', v_repetidas;
  ELSE
    CREATE UNIQUE INDEX uq_usuarios_email_lower
        ON public.usuarios (lower(email))
     WHERE email IS NOT NULL AND btrim(email) <> '';
    RAISE NOTICE 'Índice uq_usuarios_email_lower creado.';
  END IF;
END $$;


-- Resumen --------------------------------------------------------------------------
DO $$
DECLARE
  v_nombre text;
BEGIN
  RAISE NOTICE 'recepciones.clave_idempotencia: %',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'recepciones' AND column_name = 'clave_idempotencia'
    ) THEN 'OK' ELSE 'FALTA' END;
  FOREACH v_nombre IN ARRAY ARRAY['uq_recepciones_clave_idempotencia', 'uq_clientes_usuario', 'uq_usuarios_email_lower'] LOOP
    RAISE NOTICE '%: %', v_nombre,
      CASE WHEN to_regclass('public.' || v_nombre) IS NULL THEN 'FALTA (ver avisos anteriores)' ELSE 'OK' END;
  END LOOP;
END $$;
