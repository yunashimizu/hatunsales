import { AlmacenLimitesMemoria, ConsumoLimite } from './almacen-limites';

const MINUTO = 60_000;
const consumo = (clave: string, limite: number, ventanaMs = MINUTO): ConsumoLimite => ({ clave, limite, ventanaMs });

describe('AlmacenLimitesMemoria (ventana deslizante)', () => {
  let almacen: AlmacenLimitesMemoria;
  const silencioso = { warn: jest.fn() };

  beforeEach(() => {
    almacen = new AlmacenLimitesMemoria(1_000, 0, silencioso);
  });

  afterEach(() => almacen.onModuleDestroy());

  it('permite hasta el límite y bloquea la siguiente con una espera positiva', () => {
    const t0 = 10 * MINUTO; // inicio exacto de una ventana
    for (let i = 0; i < 10; i++) expect(almacen.consumir([consumo('ip', 10)], t0 + i).permitido).toBe(true);
    const bloqueo = almacen.consumir([consumo('ip', 10)], t0 + 10);
    expect(bloqueo.permitido).toBe(false);
    expect(bloqueo.reintentarEnMs).toBeGreaterThan(0);
    expect(bloqueo.reintentarEnMs).toBeLessThanOrEqual(2 * MINUTO);
  });

  it('la espera informada es suficiente: al cumplirse vuelve a permitir', () => {
    const t0 = 20 * MINUTO + 30_000; // mitad de una ventana
    for (let i = 0; i < 5; i++) almacen.consumir([consumo('ip', 5)], t0);
    const bloqueo = almacen.consumir([consumo('ip', 5)], t0 + 1);
    expect(bloqueo.permitido).toBe(false);
    expect(almacen.consumir([consumo('ip', 5)], t0 + 1 + bloqueo.reintentarEnMs - 1_000).permitido).toBe(false);
    expect(almacen.consumir([consumo('ip', 5)], t0 + 1 + bloqueo.reintentarEnMs).permitido).toBe(true);
  });

  it('no deja pasar el doble en el borde de la ventana (a diferencia de una ventana fija)', () => {
    const fin = 31 * MINUTO - 100; // 100 ms antes del cambio de ventana
    for (let i = 0; i < 10; i++) almacen.consumir([consumo('ip', 10)], fin);
    // Recién empezada la ventana siguiente, el contador anterior todavía pesa casi completo.
    expect(almacen.consumir([consumo('ip', 10)], fin + 200).permitido).toBe(false);
  });

  it('los rechazos no cuentan ni alargan el bloqueo', () => {
    const t0 = 40 * MINUTO;
    for (let i = 0; i < 3; i++) almacen.consumir([consumo('ip', 3)], t0);
    for (let i = 0; i < 50; i++) expect(almacen.consumir([consumo('ip', 3)], t0 + 1).permitido).toBe(false);
    // Dos ventanas después ya no queda nada del contador.
    expect(almacen.consumir([consumo('ip', 3)], t0 + 2 * MINUTO).permitido).toBe(true);
  });

  it('con varias claves cuenta en todas solo si ninguna se pasa e indica cuál bloqueó', () => {
    const t0 = 50 * MINUTO;
    expect(almacen.consumir([consumo('ip', 5), consumo('cuenta', 1)], t0).permitido).toBe(true);
    const bloqueo = almacen.consumir([consumo('ip', 5), consumo('cuenta', 1)], t0 + 1);
    expect(bloqueo).toMatchObject({ permitido: false, indiceBloqueo: 1 });
    // La IP solo registró la primera petición: le quedan 4.
    for (let i = 0; i < 4; i++) expect(almacen.consumir([consumo('ip', 5)], t0 + 2).permitido).toBe(true);
    expect(almacen.consumir([consumo('ip', 5)], t0 + 3).permitido).toBe(false);
  });

  it('claves distintas son independientes', () => {
    const t0 = 60 * MINUTO;
    almacen.consumir([consumo('a', 1)], t0);
    expect(almacen.consumir([consumo('a', 1)], t0).permitido).toBe(false);
    expect(almacen.consumir([consumo('b', 1)], t0).permitido).toBe(true);
  });

  it('limpiar quita los contadores vencidos', () => {
    almacen.consumir([consumo('a', 5)], 0);
    almacen.consumir([consumo('b', 5)], 3 * MINUTO);
    expect(almacen.limpiar(3 * MINUTO)).toBe(1);
    expect(almacen.tamano).toBe(1);
  });

  it('respeta el máximo de claves descartando las más antiguas y avisa', () => {
    const chico = new AlmacenLimitesMemoria(1_000, 0, silencioso);
    for (let i = 0; i < 1_500; i++) chico.consumir([consumo(`ip-${i}`, 5)], 1_000);
    expect(chico.tamano).toBeLessThanOrEqual(1_000);
    expect(silencioso.warn).toHaveBeenCalled();
    chico.onModuleDestroy();
  });
});
