-- Series fiscales en configuraciones (idempotente).
-- Defaults alineados a Nubefact / catálogo HatunSales (BBB1 boleta, FFF1 factura).

INSERT INTO configuraciones (clave, valor)
VALUES
  ('serie_boleta', 'BBB1'),
  ('serie_factura', 'FFF1')
ON CONFLICT (clave) DO NOTHING;
