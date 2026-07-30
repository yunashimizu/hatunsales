-- Fase 7: caja por usuario + monitor CPE (PostgreSQL, idempotente)

-- Quién abrió la caja (para preferir esa apertura al cobrar)
ALTER TABLE aperturas_caja
  ADD COLUMN IF NOT EXISTS id_usuario INTEGER;

CREATE INDEX IF NOT EXISTS idx_aperturas_caja_id_usuario
  ON aperturas_caja (id_usuario)
  WHERE id_usuario IS NOT NULL;
