-- Secuencia de códigos internos EAN-13 (L5.1 del plan del lector).
-- Los productos sin código de fábrica reciben «2» + 11 dígitos de esta secuencia + dígito verificador.
-- POST /producto/codigo-interno la usa; sin esta secuencia responde 500 «Falta correr sql/codigo_interno_secuencia.sql».
-- Es idempotente: puede correrse más de una vez.
CREATE SEQUENCE IF NOT EXISTS productos_codigo_interno_seq START 1;
