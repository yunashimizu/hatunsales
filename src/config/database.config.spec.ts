import { opcionesPoolPostgres } from './database.config';

describe('opcionesPoolPostgres: conexiones inactivas del pool (R13)', () => {
  const original = process.env.DB_IDLE_MS;

  afterEach(() => {
    if (original === undefined) delete process.env.DB_IDLE_MS;
    else process.env.DB_IDLE_MS = original;
  });

  it('por defecto mantiene 5 minutos una conexión inactiva, con keepAlive', () => {
    delete process.env.DB_IDLE_MS;
    const opciones = opcionesPoolPostgres();
    expect(opciones.idleTimeoutMillis).toBe(300_000);
    expect(opciones.keepAlive).toBe(true);
  });

  it('DB_IDLE_MS lo cambia (p. ej. desde Railway)', () => {
    process.env.DB_IDLE_MS = '120000';
    expect(opcionesPoolPostgres().idleTimeoutMillis).toBe(120_000);
  });

  it('un valor vacío o no numérico usa el valor por defecto', () => {
    process.env.DB_IDLE_MS = '  ';
    expect(opcionesPoolPostgres().idleTimeoutMillis).toBe(300_000);
    process.env.DB_IDLE_MS = 'cinco';
    expect(opcionesPoolPostgres().idleTimeoutMillis).toBe(300_000);
  });

  it('respeta los límites de 1 s a 1 h', () => {
    process.env.DB_IDLE_MS = '10';
    expect(opcionesPoolPostgres().idleTimeoutMillis).toBe(1_000);
    process.env.DB_IDLE_MS = '99999999';
    expect(opcionesPoolPostgres().idleTimeoutMillis).toBe(3_600_000);
  });
});
