import { ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { BYTES_MAXIMOS_LECTURA } from '../util/storage/almacen.interface';
import type { ArchivoLeido } from '../util/storage/almacen.interface';
import { AlmacenesPorNombre } from './almacenes-por-nombre';
import { archivoDeImagen, CODIGO_NO_DISPONIBLE, MejoraFotosService } from './mejora-fotos.service';
import { FotoPorRevisar, ReprocesadoFotosRepository, TotalesFotos } from './reprocesado-fotos.repository';
import type { CodigoAccion, CodigoAviso } from './receta-mejora';
import { VERSION_MEJORA } from './umbrales-mejora';

/**
 * Fotos ya subidas (doc/PLAN_MEJORA_AUTOMATICA_DE_FOTOS.md §8, §9, tanda B3).
 *
 * Nada corre solo: no hay temporizador ni trabajo al arrancar; cada pasada la pide una persona. Hay
 * como máximo UNA pasada a la vez, va de a una foto con una pausa entre fotos, se puede detener y se
 * detiene sola tras varios fallos seguidos. El resultado vive en memoria (se pierde al reiniciar) y
 * está acotado: contadores y unos pocos ejemplos por motivo.
 *
 * La revisión (diagnóstico) no escribe nada y funciona sin sql/fase23. Mejorar y deshacer sí lo
 * necesitan. Cada foto se procesa por separado: lo hecho queda hecho si el servidor se reinicia, y al
 * volver a pedirlo sigue con las que faltan. Nunca se pisa una foto que ya tiene fila (en particular,
 * una en la que una persona eligió la original).
 */

export const LIMITE_REVISION = 200;
export const LIMITE_REVISION_MAXIMO = 500;
export const LIMITE_MEJORA = 200;
export const LIMITE_MEJORA_MAXIMO = 2_000;
export const MENSAJE_FALTA_SCRIPT =
  'Para mejorar las fotos primero hay que ejecutar sql/fase23_mejora_fotos.sql en la base de datos. La revisión sí funciona sin ese paso.';
export const EJEMPLOS_POR_CODIGO = 12;
export const FALLOS_SEGUIDOS_MAXIMOS = 10;
export const CODIGO_PASADA_EN_CURSO = 'YA_HAY_UNA_PASADA';

export type TipoPasada = 'diagnostico' | 'mejora';
export type MotivoFin = 'completada' | 'detenida' | 'fallos';

export interface EstadoPasada {
  en_curso: boolean;
  deteniendo: boolean;
  tipo: TipoPasada | null;
  procesadas: number;
  total: number;
  errores: number;
  /** Solo en las tandas de mejora. */
  mejoradas: number;
  sin_cambios: number;
  omitidas: number;
  /** Alguien las tocó mientras tanto: no se escribió nada. */
  saltadas: number;
  ultimo_error: string | null;
  iniciado_en: string | null;
  terminado_en: string | null;
  motivo_fin: MotivoFin | null;
}

export type CodigoEjemplo = CodigoAccion | CodigoAviso | 'SIN_CAMBIOS' | 'OMITIDA' | 'NO_LEIDA';

export interface EjemploRevision {
  codigo: CodigoEjemplo;
  id_imagen: number;
  id_producto: number;
  producto: string | null;
  url: string;
  ancho: number | null;
  alto: number | null;
}

export interface ResultadoRevision {
  /** Cuántas fotos se pensaban revisar en esta pasada. */
  total: number;
  /** Cuántas ya se miraron (= analizadas + no_leidas). */
  revisadas: number;
  analizadas: number;
  /** Se les haría alguna corrección. */
  mejorarian: number;
  /** Se quedarían tal cual. */
  sin_cambios: number;
  /** Animadas, con transparencia o demasiado grandes: no se mejoran. */
  omitidas: number;
  no_leidas: number;
  /** Muy chicas o borrosas: mejoran poco, lo ideal es otra foto (se solapa con las de arriba). */
  volver_a_fotografiar: number;
  por_accion: Partial<Record<CodigoAccion, number>>;
  por_aviso: Partial<Record<CodigoAviso, number>>;
  ejemplos: EjemploRevision[];
}

export interface RespuestaRevision extends ResultadoRevision {
  hay_revision: boolean;
  en_curso: boolean;
  /** Revisó todo lo que se propuso (no se detuvo antes). */
  completa: boolean;
  iniciado_en: string | null;
  terminado_en: string | null;
  motivo_fin: MotivoFin | null;
  ultimo_error: string | null;
}

export interface EstadoFotos {
  /** `true` si ya se corrió sql/fase23: sin eso se puede revisar, pero no mejorar. */
  disponible: boolean;
  /** El interruptor «Mejorar automáticamente lo que se suba». */
  activa: boolean;
  version: number;
  totales: TotalesFotos;
  lote: EstadoPasada;
}

function pasadaVacia(): EstadoPasada {
  return {
    en_curso: false, deteniendo: false, tipo: null, procesadas: 0, total: 0, errores: 0,
    mejoradas: 0, sin_cambios: 0, omitidas: 0, saltadas: 0, ultimo_error: null, iniciado_en: null, terminado_en: null, motivo_fin: null,
  };
}

function resultadoVacio(total = 0): ResultadoRevision {
  return {
    total, revisadas: 0, analizadas: 0, mejorarian: 0, sin_cambios: 0, omitidas: 0, no_leidas: 0,
    volver_a_fotografiar: 0, por_accion: {}, por_aviso: {}, ejemplos: [],
  };
}

const dormir = (ms: number) => new Promise<void>((resolver) => setTimeout(resolver, ms));

@Injectable()
export class ReprocesadoFotosService {
  private readonly logger = new Logger(ReprocesadoFotosService.name);
  private pasada: EstadoPasada = pasadaVacia();
  private revision: { resultado: ResultadoRevision; pasada: EstadoPasada } | null = null;
  /** Públicos solo para las pruebas: la pausa entre fotos y el trabajo en curso. */
  pausaMs = 250;
  trabajo: Promise<void> = Promise.resolve();

  constructor(
    private readonly repo: ReprocesadoFotosRepository,
    private readonly mejora: MejoraFotosService,
    private readonly almacenes: AlmacenesPorNombre,
  ) {}

  // ── Estado ─────────────────────────────────────────────────────────────────────────────

  async estado(): Promise<EstadoFotos> {
    const disponible = await this.mejora.disponible();
    return {
      disponible,
      activa: await this.mejora.interruptor(),
      version: VERSION_MEJORA,
      totales: await this.repo.totales(disponible),
      lote: { ...this.pasada },
    };
  }

  /** Pide parar: la pasada termina la foto que tiene entre manos y no empieza otra. */
  detener(): { detenido: boolean } {
    if (!this.pasada.en_curso) return { detenido: false };
    this.pasada.deteniendo = true;
    return { detenido: true };
  }

  // ── Revisión (no cambia nada) ──────────────────────────────────────────────────────────

  verRevision(): RespuestaRevision {
    if (!this.revision) {
      return {
        ...resultadoVacio(), hay_revision: false, en_curso: false, completa: false,
        iniciado_en: null, terminado_en: null, motivo_fin: null, ultimo_error: null,
      };
    }
    const { resultado, pasada } = this.revision;
    return {
      ...resultado,
      por_accion: { ...resultado.por_accion },
      por_aviso: { ...resultado.por_aviso },
      ejemplos: [...resultado.ejemplos],
      hay_revision: true,
      en_curso: pasada.en_curso,
      completa: pasada.motivo_fin === 'completada',
      iniciado_en: pasada.iniciado_en,
      terminado_en: pasada.terminado_en,
      motivo_fin: pasada.motivo_fin,
      ultimo_error: pasada.ultimo_error,
    };
  }

  /** Arranca la revisión y responde enseguida; el avance se consulta con `verRevision`. */
  async iniciarRevision(limite = LIMITE_REVISION): Promise<RespuestaRevision> {
    const { pasada, fotos } = await this.preparar('diagnostico', async () =>
      this.repo.pendientes(await this.mejora.disponible(), Math.min(limite, LIMITE_REVISION_MAXIMO)));
    const resultado = resultadoVacio(fotos.length);
    this.revision = { resultado, pasada };
    this.trabajo = this.recorrer(
      pasada,
      fotos,
      (foto) => this.revisarFoto(foto, resultado),
      (foto) => {
        resultado.no_leidas++;
        resultado.revisadas++;
        this.ejemplo(resultado, 'NO_LEIDA', foto);
      },
    );
    return this.verRevision();
  }

  private async revisarFoto(foto: FotoPorRevisar, r: ResultadoRevision): Promise<void> {
    const bytes = await this.leer(foto);
    if (!bytes) {
      r.no_leidas++;
      r.revisadas++;
      this.ejemplo(r, 'NO_LEIDA', foto);
      return;
    }
    const { analisis, receta } = await this.mejora.revisar(bytes.buffer);
    const medidas = { ancho: analisis.ancho, alto: analisis.alto };
    r.revisadas++;
    r.analizadas++;

    // Los avisos de tamaño valen también para las que no se pueden mejorar.
    for (const aviso of receta.avisos) {
      r.por_aviso[aviso] = (r.por_aviso[aviso] ?? 0) + 1;
      this.ejemplo(r, aviso, foto, medidas);
    }
    if (receta.avisos.includes('MUY_CHICA') || receta.avisos.includes('BORROSA')) r.volver_a_fotografiar++;

    if (receta.omitida) {
      r.omitidas++;
      this.ejemplo(r, 'OMITIDA', foto, medidas);
    } else if (receta.cambia) {
      r.mejorarian++;
      for (const accion of receta.acciones) {
        r.por_accion[accion] = (r.por_accion[accion] ?? 0) + 1;
        this.ejemplo(r, accion, foto, medidas);
      }
    } else {
      r.sin_cambios++;
      this.ejemplo(r, 'SIN_CAMBIOS', foto, medidas);
    }
  }

  private ejemplo(r: ResultadoRevision, codigo: CodigoEjemplo, foto: FotoPorRevisar, medidas?: { ancho: number; alto: number }): void {
    let cuantos = 0;
    for (const e of r.ejemplos) if (e.codigo === codigo) cuantos++;
    if (cuantos >= EJEMPLOS_POR_CODIGO) return;
    r.ejemplos.push({
      codigo,
      id_imagen: foto.id_imagen,
      id_producto: foto.id_producto,
      producto: foto.producto,
      url: foto.thumb_url || foto.url,
      ancho: medidas?.ancho ?? foto.width,
      alto: medidas?.alto ?? foto.height,
    });
  }

  // ── Mejorar por tandas y deshacer ──────────────────────────────────────────────────────

  /** Arranca una tanda sobre las fotos sin procesar y responde enseguida; el avance está en `estado`. */
  async iniciarMejora(limite = LIMITE_MEJORA, id_producto?: number): Promise<{ lote: EstadoPasada }> {
    const { pasada, fotos } = await this.preparar('mejora', async () => {
      await this.exigirTabla();
      return this.repo.pendientes(true, Math.min(limite, LIMITE_MEJORA_MAXIMO), id_producto);
    });
    this.trabajo = this.recorrer(
      pasada,
      fotos,
      (foto) => this.mejorarFoto(foto, pasada),
      async (foto, error) => {
        // Se anota en la foto para que la tanda siguiente no tropiece otra vez con ella.
        try {
          await this.mejora.anotarSinProcesar(foto.id_imagen, archivoDeImagen(foto as any), 'error', 'error', error);
        } catch (fallo: any) {
          this.logger.warn(`Foto ${foto.id_imagen}: no se pudo anotar el fallo (${fallo?.message ?? fallo})`);
        }
      },
    );
    return { lote: { ...pasada } };
  }

  private async mejorarFoto(foto: FotoPorRevisar, pasada: EstadoPasada): Promise<void> {
    // Entre la lista y este momento una persona pudo decidir sobre la foto.
    if (await this.repo.yaProcesada(foto.id_imagen)) {
      pasada.saltadas++;
      return;
    }
    const original = archivoDeImagen(foto as any);
    const bytes = await this.leer(foto);
    if (!bytes) {
      const anotada = await this.mejora.anotarSinProcesar(foto.id_imagen, original, 'omitida', 'no_legible');
      if (anotada) pasada.omitidas++;
      else pasada.saltadas++;
      return;
    }
    const { estado, error } = await this.mejora.mejorarExistente(foto.id_imagen, foto.id_producto, original, bytes, true);
    if (estado === 'mejorada') pasada.mejoradas++;
    else if (estado === 'sin_cambios') pasada.sin_cambios++;
    else if (estado === 'omitida') pasada.omitidas++;
    else if (estado === 'cambio') pasada.saltadas++;
    else throw new Error(error || 'No se pudo analizar la foto');
  }

  /** Todas las mejoradas (o las de un producto) vuelven a la original. Los archivos se conservan. */
  async deshacer(id_producto?: number): Promise<{ revertidas: number }> {
    if (this.pasada.en_curso && this.pasada.tipo === 'mejora') {
      throw new ConflictException({ codigo: CODIGO_PASADA_EN_CURSO, message: 'Detenga la mejora antes de deshacer' });
    }
    await this.exigirTabla();
    return { revertidas: await this.repo.deshacer(id_producto) };
  }

  private async exigirTabla(): Promise<void> {
    if (!(await this.mejora.disponible())) {
      throw new ServiceUnavailableException({ codigo: CODIGO_NO_DISPONIBLE, message: MENSAJE_FALTA_SCRIPT });
    }
  }

  // ── Común ──────────────────────────────────────────────────────────────────────────────

  /** Toma el turno y arma la lista de fotos; si algo falla, deja todo como estaba. */
  private async preparar(tipo: TipoPasada, listar: () => Promise<FotoPorRevisar[]>): Promise<{ pasada: EstadoPasada; fotos: FotoPorRevisar[] }> {
    const anterior = this.pasada;
    const pasada = this.tomarTurno(tipo);
    try {
      const fotos = await listar();
      pasada.total = fotos.length;
      return { pasada, fotos };
    } catch (error) {
      this.pasada = anterior;
      throw error;
    }
  }

  /**
   * Marca la pasada como tomada ANTES de cualquier espera: dos pulsaciones seguidas no pueden lanzar
   * dos pasadas.
   */
  private tomarTurno(tipo: TipoPasada): EstadoPasada {
    if (this.pasada.en_curso) {
      throw new ConflictException({
        codigo: CODIGO_PASADA_EN_CURSO,
        message: this.pasada.tipo === 'mejora'
          ? 'Ya se están mejorando fotos: espere a que termine o pulse «Detener»'
          : 'Ya se están revisando fotos: espere a que termine o pulse «Detener»',
      });
    }
    this.pasada = { ...pasadaVacia(), en_curso: true, tipo, iniciado_en: new Date().toISOString() };
    return this.pasada;
  }

  /** Lee la foto de su almacén; `null` si no se puede leer o pesa demasiado. */
  private async leer(foto: FotoPorRevisar): Promise<ArchivoLeido | null> {
    if ((foto.size ?? 0) > BYTES_MAXIMOS_LECTURA) return null;
    const bytes = await this.almacenes.leer(foto.proveedor, foto.clave_almacen ?? '', foto.url);
    return bytes && bytes.buffer.length <= BYTES_MAXIMOS_LECTURA ? bytes : null;
  }

  /** De a una, con pausa, detenible entre fotos. Nunca lanza. */
  private async recorrer(
    pasada: EstadoPasada,
    fotos: FotoPorRevisar[],
    hacer: (foto: FotoPorRevisar) => Promise<void>,
    alFallar: (foto: FotoPorRevisar, error: string) => void | Promise<void>,
  ): Promise<void> {
    let seguidos = 0;
    let motivo: MotivoFin = 'completada';
    try {
      for (let i = 0; i < fotos.length; i++) {
        if (i > 0) await dormir(this.pausaMs);
        if (pasada.deteniendo) {
          motivo = 'detenida';
          break;
        }
        try {
          await hacer(fotos[i]);
          seguidos = 0;
        } catch (error: any) {
          const texto = String(error?.message ?? error).slice(0, 300);
          this.logger.warn(`Foto ${fotos[i].id_imagen}: ${texto}`);
          pasada.errores++;
          pasada.ultimo_error = texto;
          seguidos++;
          await alFallar(fotos[i], texto);
        }
        pasada.procesadas++;
        if (seguidos >= FALLOS_SEGUIDOS_MAXIMOS) {
          motivo = 'fallos';
          break;
        }
      }
    } catch (error: any) {
      pasada.ultimo_error = String(error?.message ?? error).slice(0, 300);
      motivo = 'fallos';
    } finally {
      pasada.motivo_fin = motivo;
      pasada.terminado_en = new Date().toISOString();
      pasada.deteniendo = false;
      pasada.en_curso = false;
    }
  }
}
