/**
 * Cola en memoria con un máximo de trabajos a la vez. La mejora de fotos usa uno solo: la subida de
 * un lote manda 3 fotos al almacén en paralelo y, sin cola, serían 3 tuberías de píxeles juntas
 * (+61 MB cada una, medido) en un contenedor chico.
 *
 * Un trabajo que falla no detiene la cola: su promesa se rechaza y el siguiente arranca igual.
 */
export class LimitadorTareas {
  private enCurso = 0;
  private readonly espera: Array<() => void> = [];

  constructor(private readonly maximo = 1) {
    if (!Number.isInteger(maximo) || maximo < 1) throw new Error('El limitador necesita al menos 1 trabajo a la vez');
  }

  /** Trabajos corriendo ahora. */
  get activos(): number {
    return this.enCurso;
  }

  /** Trabajos esperando turno. */
  get enEspera(): number {
    return this.espera.length;
  }

  async ejecutar<T>(trabajo: () => Promise<T>): Promise<T> {
    if (this.enCurso >= this.maximo) {
      await new Promise<void>((liberar) => this.espera.push(liberar));
    } else {
      this.enCurso++;
    }
    try {
      return await trabajo();
    } finally {
      const siguiente = this.espera.shift();
      // El turno pasa directo al siguiente: `enCurso` no baja y nadie se cuela entre medias.
      if (siguiente) siguiente();
      else this.enCurso--;
    }
  }
}
