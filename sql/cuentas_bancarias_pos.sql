-- Cuentas bancarias de la empresa + extras de cobro POS
-- Se aplica también al arrancar (CreditoRepository / CajaPagos).

CREATE TABLE IF NOT EXISTS cuentas_bancarias (
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

ALTER TABLE venta_pago ADD COLUMN IF NOT EXISTS id_cuenta_bancaria INTEGER;
ALTER TABLE venta_pago ADD COLUMN IF NOT EXISTS voucher_pos VARCHAR(80);
ALTER TABLE venta_pago ADD COLUMN IF NOT EXISTS validacion VARCHAR(40);
ALTER TABLE venta_pago ADD COLUMN IF NOT EXISTS referencia_externa VARCHAR(120);

-- Semilla opcional (solo si no hay cuentas)
INSERT INTO cuentas_bancarias (banco, alias, tipo_cuenta, numero_cuenta, titular, activo, orden)
SELECT 'BCP', 'Cuenta principal', 'corriente', '', 'Hatunsales S.A.C', TRUE, 1
WHERE NOT EXISTS (SELECT 1 FROM cuentas_bancarias LIMIT 1);
