import { Logger, OnModuleDestroy } from '@nestjs/common';

/** Una clave que se cuenta contra un límite en una ventana de tiempo. */
export interface ConsumoLimite {
  readonly clave: string;
  readonly limite: number;
  readonly ventanaMs: number;
}

export interface ResultadoLimite {
  readonly permitido: boolean;
  /** Milisegundos hasta que la petición entraría (0 si se permitió). */
  readonly reintentarEnMs: number;
  /** Posición, dentro de los consumos, de la clave que bloqueó (si se bloqueó). */
  readonly indiceBloqueo?: number;
}

/** Almacén de contadores (en memoria hoy; podría ser Redis con la misma interfaz). */
export interface AlmacenLimites {
  /**
   * Si ninguna clave supera su límite, cuenta la petición en todas; si alguna
   * lo supera, no cuenta nada (los rechazos no alargan el bloqueo).
   */
  consumir(consumos: readonly ConsumoLimite[], ahora: number): ResultadoLimite;
  /** Elimina contadores vencidos y devuelve cuántos quitó. */
  limpiar(ahora: number): number;
  readonly tamano: number;
}

interface Contador {
  inicio: number;
  actual: number;
  anterior: number;
  ventanaMs: number;
}

/**
 * Ventana deslizante aproximada (contador actual + contador anterior ponderado):
 * evita la ráfaga doble que permite una ventana fija en el borde del minuto y
 * usa memoria constante por clave. Es por instancia: con N réplicas el límite
 * efectivo por IP es N veces el configurado.
 */
export class AlmacenLimitesMemoria implements AlmacenLimites, OnModuleDestroy {
  private readonly contadores = new Map<string, Contador>();
  private readonly temporizador?: ReturnType<typeof setInterval>;
  private ultimoAvisoLleno = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly maxClaves = 50_000,
    intervaloLimpiezaMs = 60_000,
    private readonly logger: Pick<Logger, 'warn'> = new Logger('LimitePeticiones'),
  ) {
    if (intervaloLimpiezaMs > 0) {
      this.temporizador = setInterval(() => this.limpiar(Date.now()), intervaloLimpiezaMs);
      this.temporizador.unref?.();
    }
  }

  get tamano(): number {
    return this.contadores.size;
  }

  consumir(consumos: readonly ConsumoLimite[], ahora: number): ResultadoLimite {
    const contadores = consumos.map((consumo) => this.contadorDe(consumo, ahora));

    let espera = -1;
    let indiceBloqueo: number | undefined;
    contadores.forEach((contador, i) => {
      const { limite } = consumos[i];
      if (this.estimado(contador, ahora) + 1 > limite) {
        const ms = this.esperaMs(contador, limite, ahora);
        if (ms > espera) {
          espera = ms;
          indiceBloqueo = i;
        }
      }
    });
    if (indiceBloqueo !== undefined) {
      return { permitido: false, reintentarEnMs: Math.max(espera, 1), indiceBloqueo };
    }

    for (const contador of contadores) contador.actual += 1;
    return { permitido: true, reintentarEnMs: 0 };
  }

  limpiar(ahora: number): number {
    let quitados = 0;
    for (const [clave, contador] of this.contadores) {
      if (ahora - contador.inicio >= 2 * contador.ventanaMs) {
        this.contadores.delete(clave);
        quitados += 1;
      }
    }
    return quitados;
  }

  onModuleDestroy(): void {
    if (this.temporizador) clearInterval(this.temporizador);
  }

  private contadorDe(consumo: ConsumoLimite, ahora: number): Contador {
    const inicioVentana = Math.floor(ahora / consumo.ventanaMs) * consumo.ventanaMs;
    const existente = this.contadores.get(consumo.clave);
    if (!existente) {
      this.asegurarEspacio(ahora);
      const nuevo: Contador = { inicio: inicioVentana, actual: 0, anterior: 0, ventanaMs: consumo.ventanaMs };
      this.contadores.set(consumo.clave, nuevo);
      return nuevo;
    }
    if (existente.ventanaMs !== consumo.ventanaMs) {
      Object.assign(existente, { inicio: inicioVentana, actual: 0, anterior: 0, ventanaMs: consumo.ventanaMs });
    } else if (inicioVentana > existente.inicio) {
      const saltos = Math.round((inicioVentana - existente.inicio) / existente.ventanaMs);
      existente.anterior = saltos === 1 ? existente.actual : 0;
      existente.actual = 0;
      existente.inicio = inicioVentana;
    }
    return existente;
  }

  /** Peticiones estimadas en la ventana deslizante que termina en `ahora`. */
  private estimado(contador: Contador, ahora: number): number {
    const transcurrido = Math.max(0, ahora - contador.inicio);
    const pesoAnterior = Math.max(0, (contador.ventanaMs - transcurrido) / contador.ventanaMs);
    return contador.anterior * pesoAnterior + contador.actual;
  }

  /** Menor espera tras la cual una nueva petición cabría (si no llegan otras). */
  private esperaMs(contador: Contador, limite: number, ahora: number): number {
    const ventana = contador.ventanaMs;
    const restanteVentana = Math.max(0, ventana - (ahora - contador.inicio));
    const objetivo = limite - 1;

    if (contador.actual <= objetivo && contador.anterior > 0) {
      const t = restanteVentana - ((objetivo - contador.actual) * ventana) / contador.anterior;
      if (t <= restanteVentana) return Math.max(0, Math.ceil(t));
    }
    const enSiguiente = contador.actual > 0 ? ventana * (1 - objetivo / contador.actual) : 0;
    return Math.ceil(restanteVentana + Math.max(0, enSiguiente));
  }

  private asegurarEspacio(ahora: number): void {
    if (this.contadores.size < this.maxClaves) return;
    this.limpiar(ahora);
    if (this.contadores.size < this.maxClaves) return;

    // Lleno de claves vigentes: se descartan las más antiguas (el Map conserva el orden de inserción).
    const aQuitar = Math.max(1, Math.ceil(this.maxClaves * 0.01));
    let quitados = 0;
    for (const clave of this.contadores.keys()) {
      this.contadores.delete(clave);
      if (++quitados >= aQuitar) break;
    }
    if (ahora - this.ultimoAvisoLleno >= 60_000) {
      this.ultimoAvisoLleno = ahora;
      this.logger.warn(
        `Tabla de límites llena (${this.maxClaves} claves): se descartaron ${quitados} contadores antiguos. `
          + '¿Tráfico anómalo? Revise LIMITE_PETICIONES_MAX_CLAVES.',
      );
    }
  }
}
