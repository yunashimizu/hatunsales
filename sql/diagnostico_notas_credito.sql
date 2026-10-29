-- Diagnóstico de notas de crédito (por qué se ve o no se ve el botón «Nota de crédito»).
-- SOLO SELECT: no modifica nada. Córrelo completo (psql -f o DBeaver) en la base que usa
-- la API y revisa cada bloque. Lo ejecuta el usuario; los agentes no se conectan a la base.
-- Los bloques usan to_jsonb(...) para no fallar si falta alguna columna: lo que falte sale NULL.
--
-- El botón «Nota de crédito» se habilita solo si se cumplen TODAS estas condiciones
-- (comprobante.bussnies.ts › acciones y venta-documentos.bussnies.ts › accionNota):
--   1. fase14 aplicada (bloque 1: todo en true).                          Si no: 503 / «Aplique fase14».
--   2. El comprobante es factura o boleta, NO anulado, emitido con
--      proveedor_fiscal = 'sunat_directo' (bloque 3).                    Los de 'nubefact' se anulan en el sistema.
--   3. SUNAT lo aceptó (aceptada_sunat y estado ACEPTADO/ACEPTADO_OBS).    Si no: «todavía no está aceptado».
--   4. Su ambiente_fiscal es el ambiente vigente (bloque 2).               Si no: «se anula en el sistema».
--   5. La emisión está activa (bloque 2): en BETA con fiscal_beta_pos_directo = 'true' y sin
--      bloqueo; en producción con fiscal_proveedor = 'sunat_directo' y sin bloqueo.
--   6. Le queda saldo y no hay otra nota en envío (bloque 5).
--   7. El usuario es administrador o vendedor.


-- 1) ¿Está aplicada fase14 (y lo que necesita de fase9)? Cada fila debe decir presente = true.
WITH requeridas(tabla, columna, script) AS (
  VALUES
    ('comprobantes',       'proveedor_fiscal',          'fase9'),
    ('comprobantes',       'ambiente_fiscal',           'fase9'),
    ('comprobantes',       'estado_sunat',              'fase9'),
    ('comprobantes',       'id_envio_ultimo',           'fase9'),
    ('comprobantes',       'id_comprobante_modificado', 'fase9'),
    ('comprobantes',       'doc_modificado_tipo',       'fase9'),
    ('comprobantes',       'doc_modificado_serie',      'fase9'),
    ('comprobantes',       'doc_modificado_numero',     'fase9'),
    ('comprobantes',       'nota_motivo',               'fase9'),
    ('comprobantes',       'nota_sustento',             'fase9'),
    ('comprobantes',       'efecto_nota',               'fase14'),
    ('comprobantes',       'reingresar_stock',          'fase14'),
    ('comprobantes',       'efectos_aplicados',         'fase14'),
    ('comprobantes',       'efectos_aplicados_en',      'fase14'),
    ('comprobante_items',  'id_item_origen',            'fase14'),
    ('venta_stock_salida', 'cantidad_devuelta',         'fase14 (tabla de fase4)')
)
SELECT r.tabla, r.columna, r.script,
       EXISTS (SELECT 1 FROM information_schema.columns c
                WHERE c.table_schema = current_schema()
                  AND c.table_name = r.tabla AND c.column_name = r.columna) AS presente
  FROM requeridas r
 ORDER BY presente, r.tabla, r.columna;

-- 1b) Restricciones e índices de fase14 (los tres CHECK/FK y los tres índices deben existir).
SELECT 'restriccion' AS tipo, n.nombre,
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = n.nombre) AS presente
  FROM (VALUES ('comprobante_items_id_item_origen_fkey'),
               ('comprobantes_efecto_nota_ck'),
               ('venta_stock_salida_cantidad_devuelta_ck')) AS n(nombre)
UNION ALL
SELECT 'indice', n.nombre,
       to_regclass(format('%I.%I', current_schema(), n.nombre)) IS NOT NULL
  FROM (VALUES ('ix_comprobante_items_origen'),
               ('ix_comprobantes_nc_efectos_pendientes'),
               ('uq_comprobantes_nc_total')) AS n(nombre)
 ORDER BY 1, 2;


-- 2) Configuración fiscal que decide si la emisión está activa.
--    Sin datos sensibles: no se lista el usuario SOL ni secretos.
SELECT clave, valor
  FROM configuraciones
 WHERE clave IN ('fiscal_proveedor', 'fiscal_ambiente', 'fiscal_beta_pos_directo',
                 'fiscal_envio_en_linea', 'fiscal_tareas_activas',
                 'fiscal_serie_factura', 'fiscal_serie_boleta',
                 'fiscal_serie_nc_factura', 'fiscal_serie_nc_boleta',
                 'fiscal_emision_bloqueada_beta', 'fiscal_emision_bloqueada_produccion')
 ORDER BY clave;
-- Lectura rápida: si fiscal_ambiente = 'beta' y fiscal_beta_pos_directo no es 'true' → emisión APAGADA
-- (no hay botón). Si fiscal_ambiente = 'produccion' y fiscal_proveedor = 'nubefact' → emisión INACTIVA.
-- Las series fiscal_serie_nc_factura (empieza con F) y fiscal_serie_nc_boleta (empieza con B) deben existir.


-- 3) Facturas y boletas por quién las emitió y en qué ambiente. Solo las filas con
--    proveedor sunat_directo, aceptada = true y ambiente = el vigente (bloque 2) admiten nota.
SELECT COALESCE(x.j ->> 'proveedor_fiscal', '(sin dato)')  AS proveedor_fiscal,
       COALESCE(x.j ->> 'ambiente_fiscal',  '(sin dato)')  AS ambiente_fiscal,
       COALESCE(x.j ->> 'estado_sunat',     '(sin dato)')  AS estado_sunat,
       COALESCE(c.aceptada_sunat, false)                   AS aceptada_sunat,
       COALESCE(c.anulado, false)                          AS anulado,
       count(*)                                            AS comprobantes
  FROM comprobantes c
 CROSS JOIN LATERAL (SELECT to_jsonb(c) AS j) x
 WHERE c.id_tipo IN (1, 2)
 GROUP BY 1, 2, 3, 4, 5
 ORDER BY comprobantes DESC;


-- 4) Notas de crédito que ya existen, por estado y efecto.
SELECT COALESCE(x.j ->> 'nota_motivo', '(sin motivo)')              AS motivo,
       COALESCE(x.j ->> 'estado_sunat', '(sin dato)')               AS estado_sunat,
       COALESCE(x.j ->> 'efecto_nota', '(sin efecto: histórica)')   AS efecto_nota,
       COALESCE((x.j ->> 'efectos_aplicados')::boolean, false)      AS efectos_aplicados,
       count(*)                                                     AS notas,
       round(sum(c.total)::numeric, 2)                              AS total
  FROM comprobantes c
 CROSS JOIN LATERAL (SELECT to_jsonb(c) AS j) x
 WHERE c.id_tipo = 7
 GROUP BY 1, 2, 3, 4
 ORDER BY notas DESC;


-- 5) Notas con problemas: deben dar CERO filas.
-- 5a) Aceptadas por SUNAT cuyos efectos (stock, cuenta por cobrar, anulación de venta) quedaron pendientes.
--     Las retoma sola la tarea de cada 5 minutos si fiscal_tareas_activas = 'true'.
SELECT c.id_comprobante, c.serie, c.numero, x.j ->> 'nota_motivo' AS motivo,
       x.j ->> 'efecto_nota' AS efecto_nota, c.estado_sunat, c.creado_en
  FROM comprobantes c
 CROSS JOIN LATERAL (SELECT to_jsonb(c) AS j) x
 WHERE c.id_tipo = 7
   AND COALESCE((x.j ->> 'efectos_aplicados')::boolean, false) = false
   AND x.j ->> 'efecto_nota' IS NOT NULL
   AND x.j ->> 'efecto_nota' <> 'ninguno'
   AND c.estado_sunat IN ('ACEPTADO', 'ACEPTADO_OBS')
 ORDER BY c.id_comprobante;

-- 5b) Notas todavía sin respuesta definitiva de SUNAT (bloquean emitir otra nota del mismo comprobante).
SELECT c.id_comprobante, c.serie, c.numero, c.estado, c.estado_sunat,
       x.j ->> 'id_comprobante_modificado' AS id_origen, c.creado_en
  FROM comprobantes c
 CROSS JOIN LATERAL (SELECT to_jsonb(c) AS j) x
 WHERE c.id_tipo = 7
   AND COALESCE(c.anulado, false) = false
   AND COALESCE(c.estado, '') <> 'error'
   AND COALESCE(c.estado_sunat, 'NO_ENVIADO') IN ('NO_ENVIADO', 'ENVIANDO', 'PENDIENTE_REENVIO')
 ORDER BY c.id_comprobante;

-- 5c) Comprobantes con más de una nota TOTAL vigente (motivos 01, 02, 06). Si salen filas,
--     fase14 no puede crear uq_comprobantes_nc_total: anule (anulado = true) la que sobre.
SELECT x.j ->> 'id_comprobante_modificado'                  AS id_origen,
       array_agg(c.id_comprobante ORDER BY c.id_comprobante) AS notas,
       array_agg(c.serie || '-' || c.numero ORDER BY c.id_comprobante) AS numeros
  FROM comprobantes c
 CROSS JOIN LATERAL (SELECT to_jsonb(c) AS j) x
 WHERE c.id_tipo = 7
   AND x.j ->> 'nota_motivo' IN ('01', '02', '06')
   AND COALESCE(c.anulado, false) = false
   AND COALESCE(c.estado, '') <> 'error'
   AND COALESCE(c.estado_sunat, '') <> 'RECHAZADO'
 GROUP BY 1
HAVING count(*) > 1;

-- 5d) Líneas de nota sin ítem de origen (solo deben ser las de los motivos por monto 09 y 10).
SELECT n.id_comprobante, n.serie, n.numero, to_jsonb(n) ->> 'nota_motivo' AS motivo, count(*) AS lineas_sin_origen
  FROM comprobantes n
  JOIN comprobante_items i ON i.id_comprobante = n.id_comprobante
 WHERE n.id_tipo = 7
   AND to_jsonb(i) ->> 'id_item_origen' IS NULL
   AND COALESCE(to_jsonb(n) ->> 'nota_motivo', '') NOT IN ('09', '10')
   AND COALESCE(to_jsonb(n) ->> 'efecto_nota', '') <> ''
 GROUP BY n.id_comprobante, n.serie, n.numero, to_jsonb(n) ->> 'nota_motivo'
 ORDER BY n.id_comprobante;
