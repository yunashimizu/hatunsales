-- Fase C0: apertura/cierre de caja (modo blando por defecto)
-- PostgreSQL, idempotente. No borra datos existentes.

-- Quién abrió (preferencia al cobrar)
ALTER TABLE aperturas_caja
  ADD COLUMN IF NOT EXISTS id_usuario INTEGER;

CREATE INDEX IF NOT EXISTS idx_aperturas_caja_id_usuario
  ON aperturas_caja (id_usuario)
  WHERE id_usuario IS NOT NULL;

-- Columnas opcionales (si ya existen, no hace nada)
ALTER TABLE aperturas_caja ADD COLUMN IF NOT EXISTS monto_inicial NUMERIC(12, 2);
ALTER TABLE cierres_caja ADD COLUMN IF NOT EXISTS id_usuario INTEGER;
ALTER TABLE cierres_caja ADD COLUMN IF NOT EXISTS monto_conteo NUMERIC(12, 2);
ALTER TABLE cierres_caja ADD COLUMN IF NOT EXISTS observacion TEXT;

-- Config: blando = no bloquea cobros; estricto = exige apertura (código C4, off por defecto)
INSERT INTO configuraciones (clave, valor)
SELECT v.clave, v.valor
  FROM (VALUES
    ('caja_modo', 'blando'),
    ('caja_estricto_bypass_admin', 'false')
  ) AS v(clave, valor)
 WHERE NOT EXISTS (SELECT 1 FROM configuraciones c WHERE c.clave = v.clave);
