import { LimitadorTareas } from './limitador-tareas';

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('LimitadorTareas(1) · una tubería de píxeles a la vez', () => {
  it('dos trabajos lanzados a la vez nunca se solapan', async () => {
    const limitador = new LimitadorTareas(1);
    let enCurso = 0, maximo = 0;
    const orden: string[] = [];
    const trabajo = (nombre: string) => limitador.ejecutar(async () => {
      enCurso++;
      maximo = Math.max(maximo, enCurso);
      orden.push(`${nombre}:inicio`);
      await esperar(20);
      orden.push(`${nombre}:fin`);
      enCurso--;
      return nombre;
    });

    const resultados = await Promise.all([trabajo('a'), trabajo('b'), trabajo('c')]);

    expect(resultados).toEqual(['a', 'b', 'c']);
    expect(maximo).toBe(1);
    expect(orden).toEqual(['a:inicio', 'a:fin', 'b:inicio', 'b:fin', 'c:inicio', 'c:fin']);
    expect(limitador.activos).toBe(0);
    expect(limitador.enEspera).toBe(0);
  });

  it('un trabajo que falla no detiene la cola', async () => {
    const limitador = new LimitadorTareas(1);
    const malo = limitador.ejecutar(async () => { throw new Error('foto rota'); });
    const bueno = limitador.ejecutar(async () => 'ok');

    await expect(malo).rejects.toThrow('foto rota');
    await expect(bueno).resolves.toBe('ok');
    expect(limitador.activos).toBe(0);
  });

  it('con 2 deja correr dos a la vez y no más', async () => {
    const limitador = new LimitadorTareas(2);
    let enCurso = 0, maximo = 0;
    await Promise.all(Array.from({ length: 5 }, () => limitador.ejecutar(async () => {
      enCurso++;
      maximo = Math.max(maximo, enCurso);
      await esperar(10);
      enCurso--;
    })));
    expect(maximo).toBe(2);
  });

  it('rechaza un máximo inválido', () => {
    expect(() => new LimitadorTareas(0)).toThrow();
  });
});
