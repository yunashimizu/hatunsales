import { RITMO_MAXIMO_MS, RITMO_MINIMO_POR_OMISION_MS, RitmoPeticiones, ritmoMinimoDesdeEntorno } from './ritmo-peticiones';

function crear(minimoMs: number, inicio = 1_000) {
  let ahora = inicio;
  // La espera no mueve el reloj: así varias llamadas simultáneas ven la misma hora, como en tiempo real.
  const esperar = jest.fn().mockResolvedValue(undefined);
  const ritmo = new RitmoPeticiones(minimoMs, () => ahora, esperar);
  return {
    ritmo,
    esperar,
    avanzar: (ms: number) => {
      ahora += ms;
    },
  };
}

describe('RitmoPeticiones', () => {
  it('la primera petición a un servicio sale sin esperar', async () => {
    const { ritmo, esperar } = crear(300);

    await ritmo.turno('e-beta.sunat.gob.pe');

    expect(esperar).not.toHaveBeenCalled();
  });

  it('una segunda petición pegada espera lo que falte para completar el mínimo', async () => {
    const { ritmo, esperar, avanzar } = crear(300);

    await ritmo.turno('e-beta.sunat.gob.pe');
    avanzar(40);
    await ritmo.turno('e-beta.sunat.gob.pe');

    expect(esperar).toHaveBeenCalledTimes(1);
    expect(esperar).toHaveBeenCalledWith(260);
  });

  it('si ya pasó el mínimo no espera', async () => {
    const { ritmo, esperar, avanzar } = crear(300);

    await ritmo.turno('e-beta.sunat.gob.pe');
    avanzar(300);
    await ritmo.turno('e-beta.sunat.gob.pe');

    expect(esperar).not.toHaveBeenCalled();
  });

  it('varias peticiones simultáneas quedan escalonadas cada mínimo', async () => {
    const { ritmo, esperar } = crear(300);

    await Promise.all([ritmo.turno('e-beta.sunat.gob.pe'), ritmo.turno('e-beta.sunat.gob.pe'), ritmo.turno('e-beta.sunat.gob.pe')]);

    expect(esperar.mock.calls.map(([ms]) => ms)).toEqual([300, 600]);
  });

  it('cada servicio lleva su propio ritmo', async () => {
    const { ritmo, esperar } = crear(300);

    await ritmo.turno('e-beta.sunat.gob.pe');
    await ritmo.turno('api-cpe.sunat.gob.pe');

    expect(esperar).not.toHaveBeenCalled();
  });

  it('con mínimo 0 nunca espera', async () => {
    const { ritmo, esperar } = crear(0);

    await ritmo.turno('e-beta.sunat.gob.pe');
    await ritmo.turno('e-beta.sunat.gob.pe');

    expect(esperar).not.toHaveBeenCalled();
  });
});

describe('ritmoMinimoDesdeEntorno', () => {
  const original = process.env.SUNAT_RITMO_MIN_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.SUNAT_RITMO_MIN_MS;
    else process.env.SUNAT_RITMO_MIN_MS = original;
  });

  it('usa 300 ms por omisión', () => {
    delete process.env.SUNAT_RITMO_MIN_MS;
    expect(ritmoMinimoDesdeEntorno()).toBe(RITMO_MINIMO_POR_OMISION_MS);
  });

  it('acepta 0 para desactivarlo y limita el máximo', () => {
    process.env.SUNAT_RITMO_MIN_MS = '0';
    expect(ritmoMinimoDesdeEntorno()).toBe(0);
    process.env.SUNAT_RITMO_MIN_MS = '999999';
    expect(ritmoMinimoDesdeEntorno()).toBe(RITMO_MAXIMO_MS);
  });

  it('ignora un valor que no es número', () => {
    process.env.SUNAT_RITMO_MIN_MS = 'rápido';
    expect(ritmoMinimoDesdeEntorno()).toBe(RITMO_MINIMO_POR_OMISION_MS);
  });
});
