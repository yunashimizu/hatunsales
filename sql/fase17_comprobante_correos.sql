-- =============================================================================
-- FASE 17 · Cola de correos del comprobante (enviar el comprobante al cliente)
-- PostgreSQL 12+ · idempotente · aditivo (no borra ni reescribe datos)
-- =============================================================================
-- Propósito:
--   Crea la tabla comprobante_correos: una fila por correo que se debe enviar (o se omitió) con el
--   PDF y el XML firmado de un comprobante aceptado por SUNAT. La tarea periódica de la API
--   "siembra" las filas automáticas a partir de comprobantes.enviar_cliente y las envía con
--   reintentos; el personal puede pedir reenvíos manuales desde Documentos.
--
--   * estado: PENDIENTE, ENVIANDO, ENVIADO, ERROR u OMITIDO.
--   * origen: 'automatico' (sembrado por la tarea, a lo sumo UNO por comprobante) o 'manual'.
--   * uq_comprobante_correos_abierto: nunca dos envíos abiertos (PENDIENTE/ENVIANDO) del mismo comprobante.
--   * uq_comprobante_correos_automatico: a lo sumo una fila automática por comprobante.
--
-- Sin este script la API funciona igual que hoy: detecta la ausencia de la tabla (to_regclass), lo
-- avisa una vez en el log y la tarea de correos no hace nada.
--
-- Orden: después de fase16. Independiente de las demás.
-- Cómo ejecutarlo (menos de un segundo):
--   psql "$DATABASE_PUBLIC_URL" -v ON_ERROR_STOP=1 -f sql/fase17_comprobante_correos.sql
-- Sin BEGIN/COMMIT global: cada sentencia es atómica y el script se puede repetir.
-- Si una sentencia falla por lock_timeout (había una transacción larga), vuelva a correrlo.
--
-- Verificación posterior (al final del script hay un resumen con RAISE NOTICE):
--   SELECT indexname FROM pg_indexes WHERE tablename = 'comprobante_correos';
-- =============================================================================

SET lock_timeout = '5s';
SET statement_timeout = '120s';


-- 1) Tabla -------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.comprobantes') IS NULL THEN
    RAISE NOTICE 'La tabla comprobantes no existe todavía: vuelva a correr este script después.';
    RETURN;
  END IF;
  IF to_regclass('public.comprobante_correos') IS NULL THEN
    CREATE TABLE public.comprobante_correos (
      id_correo            BIGSERIAL PRIMARY KEY,
      id_comprobante       INTEGER      NOT NULL REFERENCES public.comprobantes (id_comprobante),
      destino              VARCHAR(254),
      estado               VARCHAR(10)  NOT NULL
                             CHECK (estado IN ('PENDIENTE', 'ENVIANDO', 'ENVIADO', 'ERROR', 'OMITIDO')),
      origen               VARCHAR(10)  NOT NULL
                             CHECK (origen IN ('automatico', 'manual')),
      intentos             INTEGER      NOT NULL DEFAULT 0,
      proximo_intento_en   TIMESTAMPTZ,
      bloqueado_hasta      TIMESTAMPTZ,
      ultimo_error         TEXT,
      id_mensaje_proveedor VARCHAR(120),
      motivo_omision       VARCHAR(200),
      id_usuario           INTEGER,
      creado_en            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      actualizado_en       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      enviado_en           TIMESTAMPTZ
    );
    RAISE NOTICE 'Tabla comprobante_correos creada.';
  END IF;
END $$;


-- 2) Índices -----------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.comprobante_correos') IS NULL THEN
    RETURN;
  END IF;
  IF to_regclass('public.uq_comprobante_correos_abierto') IS NULL THEN
    CREATE UNIQUE INDEX uq_comprobante_correos_abierto
        ON public.comprobante_correos (id_comprobante)
     WHERE estado IN ('PENDIENTE', 'ENVIANDO');
    RAISE NOTICE 'Índice uq_comprobante_correos_abierto creado.';
  END IF;
  IF to_regclass('public.uq_comprobante_correos_automatico') IS NULL THEN
    CREATE UNIQUE INDEX uq_comprobante_correos_automatico
        ON public.comprobante_correos (id_comprobante)
     WHERE origen = 'automatico';
    RAISE NOTICE 'Índice uq_comprobante_correos_automatico creado.';
  END IF;
  IF to_regclass('public.ix_comprobante_correos_estado') IS NULL THEN
    CREATE INDEX ix_comprobante_correos_estado
        ON public.comprobante_correos (estado, proximo_intento_en);
    RAISE NOTICE 'Índice ix_comprobante_correos_estado creado.';
  END IF;
END $$;


-- Resumen --------------------------------------------------------------------------
DO $$
DECLARE
  v_nombre text;
BEGIN
  RAISE NOTICE 'comprobante_correos: %',
    CASE WHEN to_regclass('public.comprobante_correos') IS NULL THEN 'FALTA' ELSE 'OK' END;
  FOREACH v_nombre IN ARRAY ARRAY['uq_comprobante_correos_abierto', 'uq_comprobante_correos_automatico', 'ix_comprobante_correos_estado'] LOOP
    RAISE NOTICE '%: %', v_nombre,
      CASE WHEN to_regclass('public.' || v_nombre) IS NULL THEN 'FALTA (ver avisos anteriores)' ELSE 'OK' END;
  END LOOP;
END $$;
