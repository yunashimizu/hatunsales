-- Crédito / cuentas por cobrar + mejoras de cobro POS
-- Ejecutar en PostgreSQL (Railway) una vez.

-- Cobro: referencia y vuelto en cada pago de venta
ALTER TABLE venta_pago
  ADD COLUMN IF NOT EXISTS referencia VARCHAR(120);

ALTER TABLE venta_pago
  ADD COLUMN IF NOT EXISTS monto_recibido NUMERIC(12, 2);

ALTER TABLE venta_pago
  ADD COLUMN IF NOT EXISTS vuelto NUMERIC(12, 2);

-- Línea de crédito por cliente
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS credito_activo BOOLEAN DEFAULT FALSE;

ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS limite_credito NUMERIC(12, 2) DEFAULT 0;

ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS dias_credito INTEGER DEFAULT 15;

-- Línea de crédito por empresa
ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS credito_activo BOOLEAN DEFAULT FALSE;

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS limite_credito NUMERIC(12, 2) DEFAULT 0;

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS dias_credito INTEGER DEFAULT 15;

-- Cuentas por cobrar
CREATE TABLE IF NOT EXISTS cuentas_por_cobrar (
  id_cxc              SERIAL PRIMARY KEY,
  id_venta            INTEGER NOT NULL REFERENCES ventas(id_venta),
  id_cliente          INTEGER REFERENCES clientes(id_cliente),
  id_empresa          INTEGER REFERENCES empresas(id_empresa),
  monto_total         NUMERIC(12, 2) NOT NULL,
  saldo               NUMERIC(12, 2) NOT NULL,
  fecha_emision       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fecha_vencimiento   DATE NOT NULL,
  estado              VARCHAR(20) NOT NULL DEFAULT 'pendiente',
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cxc_estado ON cuentas_por_cobrar(estado);
CREATE INDEX IF NOT EXISTS idx_cxc_cliente ON cuentas_por_cobrar(id_cliente);
CREATE INDEX IF NOT EXISTS idx_cxc_empresa ON cuentas_por_cobrar(id_empresa);
CREATE INDEX IF NOT EXISTS idx_cxc_venta ON cuentas_por_cobrar(id_venta);

CREATE TABLE IF NOT EXISTS abonos_credito (
  id_abono    SERIAL PRIMARY KEY,
  id_cxc      INTEGER NOT NULL REFERENCES cuentas_por_cobrar(id_cxc) ON DELETE CASCADE,
  id_metodo   INTEGER REFERENCES metodos_pago(id_metodo),
  monto       NUMERIC(12, 2) NOT NULL,
  referencia  VARCHAR(120),
  id_usuario  INTEGER,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Métodos de mostrador (idempotente)
INSERT INTO metodos_pago (nombre, tipo, descripcion, activo, orden)
SELECT 'Efectivo', 'efectivo', 'Pago en efectivo en caja', TRUE, 1
WHERE NOT EXISTS (
  SELECT 1 FROM metodos_pago WHERE LOWER(TRIM(nombre)) = 'efectivo'
);

INSERT INTO metodos_pago (nombre, tipo, descripcion, activo, orden)
SELECT 'Crédito', 'credito', 'Venta a crédito (cuentas por cobrar)', TRUE, 90
WHERE NOT EXISTS (
  SELECT 1 FROM metodos_pago
   WHERE LOWER(TRIM(tipo)) = 'credito'
      OR LOWER(TRIM(nombre)) IN ('crédito', 'credito')
);
