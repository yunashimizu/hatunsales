/**
 * Caché en memoria con vencimiento y "single flight": si muchas peticiones piden
 * la misma clave a la vez con la caché fría, se hace UNA sola carga y todas
 * esperan la misma promesa. `invalidar()` descarta también las cargas en curso
 * iniciadas antes, para que un dato viejo no vuelva a entrar justo después de
 * un guardado.
 *
 * Es por instancia: entre varias instancias de la API la coherencia la da el
 * TTL corto (y, donde importa, una consulta liviana de versión).
 */
export class CacheTtl<V> {
  private readonly entradas = new Map<string, { valor: V; expira: number }>();
  private readonly enVuelo = new Map<string, { generacion: number; promesa: Promise<V> }>();
  private generacion = 0;

  /**
   * @param ttlMs vigencia fija, o función que la decide según el valor cargado
   * @param ahora reloj en milisegundos (inyectable en pruebas)
   */
  constructor(
    private readonly ttlMs: number | ((valor: V) => number),
    private readonly ahora: () => number = Date.now,
  ) {}

  async obtener(clave: string, cargar: () => Promise<V>): Promise<V> {
    const vigente = this.entradas.get(clave);
    if (vigente && vigente.expira > this.ahora()) return vigente.valor;

    const pendiente = this.enVuelo.get(clave);
    if (pendiente && pendiente.generacion === this.generacion) return pendiente.promesa;

    const generacion = this.generacion;
    // Promise.resolve().then(...) difiere la carga: `promesa` ya existe cuando corre `finally`.
    const promesa: Promise<V> = Promise.resolve()
      .then(cargar)
      .then((valor) => {
        if (generacion === this.generacion) {
          const ttl = typeof this.ttlMs === 'function' ? this.ttlMs(valor) : this.ttlMs;
          if (ttl > 0) this.entradas.set(clave, { valor, expira: this.ahora() + ttl });
        }
        return valor;
      })
      .finally(() => {
        if (this.enVuelo.get(clave)?.promesa === promesa) this.enVuelo.delete(clave);
      });

    this.enVuelo.set(clave, { generacion, promesa });
    return promesa;
  }

  /** Valor vigente sin cargar nada (o undefined). */
  leer(clave: string): V | undefined {
    const vigente = this.entradas.get(clave);
    return vigente && vigente.expira > this.ahora() ? vigente.valor : undefined;
  }

  /** Sin clave invalida todo. */
  invalidar(clave?: string): void {
    this.generacion += 1;
    if (clave === undefined) {
      this.entradas.clear();
      this.enVuelo.clear();
      return;
    }
    this.entradas.delete(clave);
    this.enVuelo.delete(clave);
  }
}
