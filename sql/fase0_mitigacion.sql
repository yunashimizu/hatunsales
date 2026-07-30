-- =============================================================================
-- FASE 0 — Mitigación HatunSales (PostgreSQL, idempotente)
-- Ejecutar en Railway / PG local UNA vez (o tras cada deploy si se desea).
-- No borra datos. Solo ADD IF NOT EXISTS / CREATE IF NOT EXISTS.
-- =============================================================================

-- Crédito / CxC
\i credito_cxc.sql

-- Índices POS + idempotencia ventas
\i pos_busqueda_indices.sql

-- Cuentas bancarias POS (si el archivo existe en el mismo directorio)
\i cuentas_bancarias_pos.sql
