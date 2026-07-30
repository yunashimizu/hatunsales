-- Fase 6: política de stock web (exclusivo vs spillover)
-- Default: exclusivo cuando hay tienda_id_almacen (alineado al POS multi-sede).
-- Para volver al derrame legacy: UPDATE configuraciones SET valor = 'spillover' WHERE clave = 'tienda_stock_modo';

INSERT INTO configuraciones (clave, valor)
SELECT v.clave, v.valor
  FROM (VALUES
    ('tienda_stock_modo', 'exclusivo')
  ) AS v(clave, valor)
 WHERE NOT EXISTS (SELECT 1 FROM configuraciones c WHERE c.clave = v.clave);

-- Asegura que exista la clave del almacén de despacho web (valor vacío = spillover legacy)
INSERT INTO configuraciones (clave, valor)
SELECT v.clave, v.valor
  FROM (VALUES
    ('tienda_id_almacen', '')
  ) AS v(clave, valor)
 WHERE NOT EXISTS (SELECT 1 FROM configuraciones c WHERE c.clave = v.clave);
