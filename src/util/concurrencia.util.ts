/**
 * Ejecuta `fn` sobre cada elemento con, como máximo, `limite` tareas en vuelo a la vez.
 *
 * - Los resultados salen en el MISMO orden que los elementos de entrada, no en el orden
 *   en que terminaron.
 * - Ante un fallo no se lanzan tareas nuevas, pero se ESPERA a que terminen las que ya
 *   estaban en vuelo y recién entonces se rechaza con el PRIMER error. Así quien llama
 *   sabe exactamente qué llegó a hacerse (por ejemplo, qué archivos se subieron) y puede
 *   deshacerlo sin que quede nada ocurriendo en segundo plano.
 * - Con una lista vacía resuelve `[]` sin llamar a `fn`.
 */
export async function enParalelo<T, R>(
  items: readonly T[],
  limite: number,
  fn: (item: T, indice: number) => Promise<R>,
): Promise<R[]> {
  const resultados: R[] = new Array(items.length);
  if (!items.length) return resultados;

  const trabajadores = Math.max(1, Math.min(Math.floor(limite) || 1, items.length));
  let siguiente = 0;
  let falló = false;
  let primerError: unknown;

  const trabajador = async (): Promise<void> => {
    while (!falló && siguiente < items.length) {
      const indice = siguiente++;
      try {
        resultados[indice] = await fn(items[indice], indice);
      } catch (error) {
        if (!falló) {
          falló = true;
          primerError = error;
        }
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: trabajadores }, () => trabajador()));

  if (falló) throw primerError;
  return resultados;
}
