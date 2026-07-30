-- Fase 5: ventas.id_empresa (PostgreSQL, idempotente)
ALTER TABLE ventas
  ADD COLUMN IF NOT EXISTS id_empresa INTEGER REFERENCES empresas(id_empresa);

CREATE INDEX IF NOT EXISTS idx_ventas_id_empresa ON ventas (id_empresa);

-- Backfill desde CxC cuando la venta no tiene empresa pero la cuenta sí
UPDATE ventas v
   SET id_empresa = cxc.id_empresa
  FROM cuentas_por_cobrar cxc
 WHERE cxc.id_venta = v.id_venta
   AND v.id_empresa IS NULL
   AND cxc.id_empresa IS NOT NULL;
