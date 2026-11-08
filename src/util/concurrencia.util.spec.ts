import { enParalelo } from './concurrencia.util';

/** Promesa que se resuelve o rechaza desde fuera, para controlar el orden en que terminan las tareas. */
function pendiente<T = void>() {
  let resolver!: (v: T) => void;
  let rechazar!: (e: unknown) => void;
  const promesa = new Promise<T>((res, rej) => {
    resolver = res;
    rechazar = rej;
  });
  return { promesa, resolver, rechazar };
}

const turno = () => new Promise<void>((r) => setImmediate(r));

describe('enParalelo', () => {
  it('con una lista vacía resuelve [] sin llamar a la función', async () => {
    const fn = jest.fn();
    await expect(enParalelo([], 3, fn)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('devuelve los resultados en el orden de entrada aunque terminen al revés', async () => {
    const esperas = [pendiente<string>(), pendiente<string>(), pendiente<string>()];
    const salida = enParalelo(['a', 'b', 'c'], 3, (_item, i) => esperas[i].promesa);

    // Terminan en el orden inverso al de entrada.
    esperas[2].resolver('C');
    esperas[0].resolver('A');
    esperas[1].resolver('B');

    await expect(salida).resolves.toEqual(['A', 'B', 'C']);
  });

  it('entrega a la función el elemento y su índice', async () => {
    const visto: Array<[string, number]> = [];
    await enParalelo(['x', 'y'], 2, async (item, i) => {
      visto.push([item, i]);
    });
    expect(visto).toEqual([['x', 0], ['y', 1]]);
  });

  it('nunca hay más tareas en vuelo que el límite', async () => {
    let enVuelo = 0;
    let maximo = 0;
    const resultados = await enParalelo([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      enVuelo++;
      maximo = Math.max(maximo, enVuelo);
      await turno();
      enVuelo--;
      return n * 2;
    });

    expect(maximo).toBe(3);
    expect(resultados).toEqual([2, 4, 6, 8, 10, 12, 14]);
  });

  it('con menos elementos que el límite lanza todos a la vez', async () => {
    let enVuelo = 0;
    let maximo = 0;
    await enParalelo([1, 2], 5, async () => {
      enVuelo++;
      maximo = Math.max(maximo, enVuelo);
      await turno();
      enVuelo--;
    });
    expect(maximo).toBe(2);
  });

  it('ante un fallo espera a las que estaban en vuelo y rechaza con el primer error', async () => {
    const esperas = [pendiente<string>(), pendiente<string>(), pendiente<string>()];
    const iniciadas: number[] = [];
    let rechazo: unknown;
    let liquidada = false;

    const salida = enParalelo([0, 1, 2, 3, 4], 3, (_n, i) => {
      iniciadas.push(i);
      return esperas[i]?.promesa ?? Promise.resolve('no debería llegar');
    }).catch((e) => {
      rechazo = e;
      liquidada = true;
    });

    await turno();
    expect(iniciadas).toEqual([0, 1, 2]);

    esperas[1].rechazar(new Error('primero'));
    await turno();
    // Todavía quedan dos en vuelo: no se rechaza todavía.
    expect(liquidada).toBe(false);

    esperas[0].rechazar(new Error('segundo'));
    await turno();
    expect(liquidada).toBe(false);

    esperas[2].resolver('ok');
    await salida;

    expect((rechazo as Error).message).toBe('primero');
    // Tras el fallo no se lanzó ninguna tarea nueva.
    expect(iniciadas).toEqual([0, 1, 2]);
  });
});
