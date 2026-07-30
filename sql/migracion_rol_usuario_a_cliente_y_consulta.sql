-- =============================================================================
-- Migración roles: persona(s) con rol "usuario" (id 2) → cliente (id 5)
-- Luego el rol id 2 se renombra a "consulta" (solo lectura catálogo).
--
-- CUIDADO DE NOMBRES:
--   - Tabla de cuentas:  usuarios   (plural)
--   - Rol antiguo id 2:  usuario    (singular, nombre del rol)
--   - Rol tienda:        cliente    (id 5)
--
-- Idempotente / seguro de re-ejecutar.
-- Aplicar en LOCAL y en NUBE (Railway) cuando apruebes.
-- =============================================================================

BEGIN;

-- 0) Verificación previa (revisar salida antes de commit si corres a mano)
-- SELECT u.id_usuario, u.email, u.id_rol, r.nombre
--   FROM usuarios u
--   JOIN roles r ON r.id_rol = u.id_rol
--  WHERE u.id_rol IN (2, 5);

-- 1) Mover cuentas que tenían el ROL "usuario" (id_rol = 2) → cliente (5)
--    No toca el nombre de la tabla. Solo cambia id_rol.
UPDATE usuarios
   SET id_rol = 5
 WHERE id_rol = 2;

-- 2) Renombrar el rol id 2: usuario → consulta (queda libre para staff solo-lectura)
UPDATE roles
   SET nombre = 'consulta'
 WHERE id_rol = 2
   AND LOWER(TRIM(nombre)) IN ('usuario', 'consulta');

-- Si por alguna razón el rol 2 no existe, no inventamos filas aquí.
-- Crear consulta solo si faltara (no debería):
INSERT INTO roles (id_rol, nombre)
SELECT 2, 'consulta'
 WHERE NOT EXISTS (SELECT 1 FROM roles WHERE id_rol = 2);

-- Asegurar nombre consulta en id 2
UPDATE roles SET nombre = 'consulta' WHERE id_rol = 2;

COMMIT;

-- 3) Verificación posterior
-- SELECT id_rol, nombre FROM roles ORDER BY id_rol;
-- SELECT id_rol, COUNT(*) FROM usuarios GROUP BY id_rol ORDER BY id_rol;
--
-- Esperado:
--   1 admin, 2 consulta (0 usuarios al inicio), 3 vendedor, 4 caja, 5 cliente
--   El/los que estaban en 2 ahora en 5.
