import {
  ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { ALMACEN_ARCHIVOS } from '../util/storage/almacen.interface';
import type { AlmacenArchivos, ArchivoGuardado, ArchivoLeido } from '../util/storage/almacen.interface';
import { ConfiguracionRepository } from '../repository/Repository/configuracion.repository';
import { ProductoImagenRepository } from '../repository/Repository/producto-imagen.repository';
import type { ProductoImagen } from '../models/DBModel/producto-imagen.entity';
import { AlmacenesPorNombre } from './almacenes-por-nombre';
import { analizarImagen, AnalisisImagen } from './analizador-imagen';
import { LimitadorTareas } from './limitador-tareas';
import { mejorarImagen, ResultadoMejora } from './mejorador-imagen';
import { ArchivoFoto, FilaMejora, MejoraFotosRepository } from './mejora-fotos.repository';
import { CodigoAccion, CodigoAviso, decidirReceta, RecetaMejora } from './receta-mejora';
import { leerUmbrales, VERSION_MEJORA } from './umbrales-mejora';

/**
 * Mejora automática de fotos de producto (doc/PLAN_MEJORA_AUTOMATICA_DE_FOTOS.md §3, §6–§8, tanda B2).
 *
 * - `preparar` mide la foto y, si hace falta, devuelve una versión mejorada. Nunca lanza.
 * - Al subir o reemplazar, ProductoImagenBussnies guarda primero la ORIGINAL (como siempre), crea la
 *   fila apuntando a ella y recién después, con `publicarTrasSubida`, la cambia a la mejorada en una
 *   sola sentencia que también anota la original. Si eso falla, la foto queda en la original y el
 *   archivo mejorado se borra.
 * - Una foto a la vez (`LimitadorTareas(1)`) y un presupuesto de tiempo por petición: lo que no alcanza
 *   se publica como llegó y queda «pendiente» (sin fila), para «Mejorar ahora» o el lote de B3.
 */

export const CLAVE_MEJORA_AUTOMATICA = 'fotos_mejora_automatica';
/** Mejora acumulada que puede esperar una petición de subida (10 fotos × 0,5 s medidos = 5 s en la laptop). */
export const PRESUPUESTO_POR_PETICION_MS = 12_000;

export const CODIGO_NO_DISPONIBLE = 'MEJORA_FOTOS_NO_DISPONIBLE';

export type MotivoInforme = 'verificacion' | 'animada' | 'transparencia' | 'demasiado_grande' | 'sin_tabla' | 'apagada' | 'presupuesto' | 'no_legible' | 'error';

export interface InformeMejora {
  version: number;
  medidas?: {
    ancho: number; alto: number; agudeza: number; p1: number; p99: number; ruido: number | null;
    bloques: number | null; fondo: { L: number; uniformidad: number; tinte: number }; ocupacion: number;
  };
  acciones: CodigoAccion[];
  avisos: CodigoAviso[];
  receta?: unknown;
  despues?: { ancho: number; alto: number; agudeza: number; p99: number };
  verificacion?: unknown;
  ms?: { analisis: number; mejora: number };
  motivo?: MotivoInforme;
  /** Texto técnico del error, para el registro (no se muestra tal cual). */
  error?: string;
}

export interface PreparacionFoto {
  estado: 'mejorada' | 'sin_cambios' | 'omitida' | 'error';
  mejorada?: { buffer: Buffer; mime: 'image/jpeg'; ancho: number; alto: number };
  informe: InformeMejora;
}

export interface ArchivoParaMejorar {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

/** Resultado de procesar una foto recién subida: lo que `publicarTrasSubida` necesita. */
export interface ProcesadoFoto {
  estado: 'pendiente' | PreparacionFoto['estado'];
  informe?: InformeMejora;
  /** El archivo mejorado ya guardado en el almacén (solo con estado «mejorada»). */
  guardada?: ArchivoGuardado;
}

export interface Presupuesto {
  fin: number;
}

/** Cómo quedó una foto ya subida. `cambio`: alguien la tocó mientras tanto y no se escribió nada. */
export interface ResultadoExistente {
  estado: PreparacionFoto['estado'] | 'cambio';
  error?: string;
}

export interface MejoraFotoResumen {
  id_imagen: number;
  estado: 'mejorada' | 'sin_cambios' | 'original_elegido' | 'omitida' | 'error' | 'pendiente';
  publicada: 'mejorada' | 'original';
  url_original: string;
  url_mejorada: string | null;
  ancho_original: number | null;
  alto_original: number | null;
  acciones: CodigoAccion[];
  avisos: CodigoAviso[];
  version: number | null;
}

export interface ResumenMejoras {
  disponible: boolean;
  activa: boolean;
  version: number;
  mejoras: MejoraFotoResumen[];
}

const redondear = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** Del almacén al formato de la tabla. */
export function archivoDe(guardado: ArchivoGuardado): ArchivoFoto {
  return {
    proveedor: guardado.proveedor,
    url: guardado.url,
    clave: guardado.clave,
    thumb_url: guardado.thumb_url ?? null,
    mime: guardado.mime ?? null,
    size: guardado.size ?? null,
    ancho: guardado.width ?? null,
    alto: guardado.height ?? null,
  };
}

/** De la fila de productos_imagenes (el archivo publicado ahora) al formato de la tabla. */
export function archivoDeImagen(
  imagen: Pick<ProductoImagen, 'url' | 'thumb_url' | 'mime' | 'size' | 'width' | 'height' | 'clave_almacen' | 'proveedor'>,
): ArchivoFoto {
  return {
    proveedor: imagen.proveedor ?? '',
    url: imagen.url,
    clave: imagen.clave_almacen ?? '',
    thumb_url: imagen.thumb_url ?? null,
    mime: imagen.mime ?? null,
    size: imagen.size ?? null,
    ancho: imagen.width ?? null,
    alto: imagen.height ?? null,
  };
}

@Injectable()
export class MejoraFotosService {
  private readonly logger = new Logger(MejoraFotosService.name);
  private readonly limitador = new LimitadorTareas(1);
  private readonly umbrales = leerUmbrales();
  /** Público solo para que las pruebas lo acorten. */
  presupuestoPorPeticionMs = PRESUPUESTO_POR_PETICION_MS;

  constructor(
    private readonly repo: MejoraFotosRepository,
    private readonly config: ConfiguracionRepository,
    private readonly imagenes: ProductoImagenRepository,
    private readonly almacenes: AlmacenesPorNombre,
    @Inject(ALMACEN_ARCHIVOS) private readonly almacen: AlmacenArchivos,
  ) {}

  // ── Estado ─────────────────────────────────────────────────────────────────────────────

  async disponible(): Promise<boolean> {
    try {
      return await this.repo.disponible();
    } catch {
      return false;
    }
  }

  /** El interruptor «Mejorar automáticamente lo que se suba» (encendido si la clave no existe). */
  async interruptor(): Promise<boolean> {
    try {
      return await this.config.obtenerBooleano(CLAVE_MEJORA_AUTOMATICA, true);
    } catch {
      return true;
    }
  }

  async fijarInterruptor(activa: boolean): Promise<{ activa: boolean }> {
    await this.config.guardar(CLAVE_MEJORA_AUTOMATICA, activa ? '1' : '0');
    return { activa };
  }

  /** ¿Se mejora lo que se suba? Hace falta la tabla y el interruptor encendido. */
  async activa(): Promise<boolean> {
    return (await this.disponible()) && (await this.interruptor());
  }

  nuevoPresupuesto(): Presupuesto {
    return { fin: Date.now() + this.presupuestoPorPeticionMs };
  }

  // ── Núcleo ─────────────────────────────────────────────────────────────────────────────

  /** El trabajo pesado; aparte para que las pruebas lo sustituyan. */
  protected ejecutarMejora(buffer: Buffer): Promise<ResultadoMejora> {
    return mejorarImagen(buffer, this.umbrales);
  }

  /**
   * Mide la foto y, si lo necesita, devuelve la versión mejorada. Una a la vez. Nunca lanza: si algo
   * falla devuelve `{ estado: 'error' }` y quien llama publica la original.
   */
  preparar(archivo: ArchivoParaMejorar): Promise<PreparacionFoto> {
    return this.limitador.ejecutar(() => this.prepararAhora(archivo)).catch((error) => this.preparacionConError(archivo, error));
  }

  private async prepararAhora(archivo: ArchivoParaMejorar): Promise<PreparacionFoto> {
    try {
      const r = await this.ejecutarMejora(archivo.buffer);
      const informe = this.informeDe(r);
      if (r.estado === 'mejorada' && r.mejorada) {
        return { estado: 'mejorada', mejorada: { buffer: r.mejorada.buffer, mime: 'image/jpeg', ancho: r.mejorada.ancho, alto: r.mejorada.alto }, informe };
      }
      return { estado: r.estado === 'omitida' ? 'omitida' : 'sin_cambios', informe };
    } catch (error) {
      return this.preparacionConError(archivo, error);
    }
  }

  private preparacionConError(archivo: ArchivoParaMejorar, error: any): PreparacionFoto {
    const texto = String(error?.message ?? error).slice(0, 300);
    this.logger.warn(`No se pudo analizar «${archivo.originalname}»: ${texto}. Se publica la original.`);
    return { estado: 'error', informe: { version: VERSION_MEJORA, acciones: [], avisos: [], motivo: 'error', error: texto } };
  }

  private informeDe(r: ResultadoMejora): InformeMejora {
    const a = r.analisis, d = a.medidas;
    return {
      version: VERSION_MEJORA,
      medidas: d ? {
        ancho: a.ancho, alto: a.alto, agudeza: redondear(d.agudeza), p1: d.p1, p99: d.p99,
        ruido: d.ruido === null ? null : redondear(d.ruido, 2), bloques: d.bloques === null ? null : redondear(d.bloques, 2),
        fondo: { L: redondear(d.fondo.L, 1), uniformidad: redondear(d.fondo.uniformidad), tinte: d.fondo.tinte },
        ocupacion: redondear(d.ocupacion),
      } : undefined,
      acciones: r.receta.acciones,
      avisos: r.receta.avisos,
      receta: {
        recorte: r.receta.recorte, escala: redondear(r.receta.escala, 4), lineal: r.receta.lineal,
        suavizar: r.receta.suavizar, enfoque: r.receta.enfoque,
      },
      despues: r.despues && r.mejorada
        ? { ancho: r.mejorada.ancho, alto: r.mejorada.alto, agudeza: redondear(r.despues.agudeza), p99: r.despues.p99 }
        : undefined,
      verificacion: r.verificacion?.detalle,
      ms: r.ms,
      motivo: r.motivo,
    };
  }

  /**
   * Solo mide y decide qué haría, sin aplicar ni escribir nada (revisión de las fotos ya subidas). En
   * el mismo turno único que las subidas: nunca hay dos fotos en proceso a la vez. Puede lanzar.
   */
  revisar(buffer: Buffer): Promise<{ analisis: AnalisisImagen; receta: RecetaMejora }> {
    return this.limitador.ejecutar(async () => {
      const analisis = await analizarImagen(buffer, this.umbrales);
      return { analisis, receta: decidirReceta(analisis, this.umbrales) };
    });
  }

  // ── Subida y reemplazo (los llama ProductoImagenBussnies) ─────────────────────────────

  /**
   * Prepara una foto recién subida dentro del presupuesto de la petición y, si salió mejorada, guarda
   * el archivo mejorado en el almacén. Nunca lanza.
   */
  async procesarSubida(archivo: ArchivoParaMejorar, carpeta: string, presupuesto: Presupuesto): Promise<ProcesadoFoto> {
    const restante = presupuesto.fin - Date.now();
    if (restante <= 0) return { estado: 'pendiente' };

    // Si no alcanza el presupuesto la foto se publica como llegó; el trabajo sigue en la cola (ya ocupa
    // su turno) y su resultado se descarta.
    let temporizador: NodeJS.Timeout | undefined;
    const agotado = new Promise<null>((resolver) => { temporizador = setTimeout(() => resolver(null), restante); });
    const prep = await Promise.race([this.preparar(archivo), agotado]);
    clearTimeout(temporizador);
    if (!prep) return { estado: 'pendiente' };

    if (prep.estado !== 'mejorada' || !prep.mejorada) return { estado: prep.estado, informe: prep.informe };

    try {
      const guardada = await this.almacen.guardar({
        buffer: prep.mejorada.buffer,
        nombre_original: nombreMejorada(archivo.originalname),
        mime: prep.mejorada.mime,
        carpeta,
      });
      return { estado: 'mejorada', informe: prep.informe, guardada };
    } catch (error: any) {
      const texto = String(error?.message ?? error).slice(0, 300);
      this.logger.warn(`No se pudo guardar la versión mejorada de «${archivo.originalname}»: ${texto}`);
      return { estado: 'error', informe: { ...prep.informe, motivo: 'error', error: texto } };
    }
  }

  /**
   * Tras crear o actualizar la fila de la imagen (apuntando a la ORIGINAL), publica la mejorada o anota
   * el resultado. Nunca lanza.
   * @returns `publicada`: el archivo al que apunta ahora la imagen si cambió a la mejorada.
   *          `filaAlDia`: la tabla de mejora quedó coherente con la original nueva (si es `false`, quien
   *          reemplaza NO debe borrar los archivos viejos: una fila vieja todavía los nombra).
   */
  async publicarTrasSubida(
    id_imagen: number,
    original: ArchivoGuardado,
    procesado: ProcesadoFoto | undefined,
    habiaFila = false,
  ): Promise<{ publicada: ArchivoGuardado | null; filaAlDia: boolean }> {
    const orig = archivoDe(original);
    if (procesado?.estado === 'mejorada' && procesado.guardada) {
      let ok = false;
      try {
        ok = await this.repo.publicarMejorada(id_imagen, VERSION_MEJORA, orig, archivoDe(procesado.guardada), procesado.informe);
      } catch (error: any) {
        this.logger.warn(`No se pudo publicar la mejora de la imagen ${id_imagen}: ${error?.message ?? error}. Queda la original.`);
      }
      if (ok) return { publicada: procesado.guardada, filaAlDia: true };
      // La imagen sigue en la original: el archivo mejorado sobra.
      await this.borrar(procesado.guardada.proveedor, procesado.guardada.clave);
      return { publicada: null, filaAlDia: await this.quitarFilaVieja(id_imagen, habiaFila) };
    }
    if (procesado && procesado.estado !== 'pendiente') {
      try {
        const estado = procesado.estado === 'mejorada' ? 'error' : procesado.estado;
        if (await this.repo.registrar(id_imagen, estado, VERSION_MEJORA, orig, procesado.informe ?? {})) {
          return { publicada: null, filaAlDia: true };
        }
      } catch (error: any) {
        this.logger.warn(`No se pudo anotar la mejora de la imagen ${id_imagen}: ${error?.message ?? error}`);
      }
    }
    return { publicada: null, filaAlDia: await this.quitarFilaVieja(id_imagen, habiaFila) };
  }

  /** Una fila que nombra la original anterior ya no vale: se quita. */
  private async quitarFilaVieja(id_imagen: number, habiaFila: boolean): Promise<boolean> {
    if (!habiaFila) return true;
    try {
      await this.repo.eliminarFila(id_imagen);
      return true;
    } catch (error: any) {
      this.logger.warn(`No se pudo quitar la fila de mejora vieja de la imagen ${id_imagen}: ${error?.message ?? error}`);
      return false;
    }
  }

  /** La fila de mejora de una imagen, o `null` (sin tabla, sin fila o si la consulta falla). */
  async filaDe(id_imagen: number): Promise<FilaMejora | null> {
    if (!(await this.disponible())) return null;
    return this.repo.porImagen(id_imagen);
  }

  /** Borra un archivo en el almacén donde está. Nunca lanza. */
  async borrar(proveedor: string | null | undefined, clave: string | null | undefined): Promise<void> {
    if (!clave) return;
    try {
      await this.almacenes.resolver(proveedor).eliminar(clave);
    } catch (error: any) {
      this.logger.warn(`No se pudo borrar el archivo ${clave} del almacén: ${error?.message ?? error}`);
    }
  }

  // ── Endpoints por foto ─────────────────────────────────────────────────────────────────

  async resumen(id_producto: number): Promise<ResumenMejoras> {
    const [disponible, activa] = [await this.disponible(), await this.interruptor()];
    if (!disponible) return { disponible: false, activa, version: VERSION_MEJORA, mejoras: [] };
    const fotos = await this.repo.porProducto(id_producto);
    return {
      disponible: true,
      activa,
      version: VERSION_MEJORA,
      mejoras: fotos.map((f) => {
        const m = f.mejora;
        const informe = (m?.informe ?? {}) as Partial<InformeMejora>;
        return {
          id_imagen: f.id_imagen,
          estado: m?.estado ?? 'pendiente',
          publicada: m?.url_mejorada && f.url === m.url_mejorada ? 'mejorada' : 'original',
          url_original: m?.url_original ?? f.url,
          url_mejorada: m?.url_mejorada ?? null,
          ancho_original: m ? m.ancho_original : f.width,
          alto_original: m ? m.alto_original : f.height,
          acciones: Array.isArray(informe.acciones) ? informe.acciones : [],
          avisos: Array.isArray(informe.avisos) ? informe.avisos : [],
          version: m?.version ?? null,
        };
      }),
    };
  }

  /** «Usar la original»: idempotente, no borra nada. */
  async usarOriginal(id_producto: number, id_imagen: number): Promise<{ imagenes: ProductoImagen[]; mejoras: MejoraFotoResumen[] }> {
    const imagen = await this.imagenDelProducto(id_producto, id_imagen);
    const fila = await this.repo.porImagen(id_imagen);
    if (fila) {
      await this.repo.elegir(id_imagen, 'original');
    } else {
      // Nunca se procesó: se anota la elección para que el lote no la toque. La original es la actual.
      await this.repo.registrar(id_imagen, 'original_elegido', VERSION_MEJORA, archivoDeImagen(imagen), { version: VERSION_MEJORA, acciones: [], avisos: [] });
    }
    return this.respuesta(id_producto);
  }

  /**
   * «Usar la mejorada»: si ya hay archivo mejorado lo publica; si no, la mejora ahora desde la original
   * (si al medirla resulta que estaba bien, queda «sin_cambios» y se dice así).
   */
  async usarMejorada(id_producto: number, id_imagen: number): Promise<{ imagenes: ProductoImagen[]; mejoras: MejoraFotoResumen[] }> {
    const imagen = await this.imagenDelProducto(id_producto, id_imagen);
    const fila = await this.repo.porImagen(id_imagen);
    if (fila?.url_mejorada) {
      await this.repo.elegir(id_imagen, 'mejorada');
      return this.respuesta(id_producto);
    }

    // Se mejora ahora. La original es la de la fila (si la hay) o el archivo publicado.
    const original: ArchivoFoto = fila
      ? { proveedor: fila.proveedor_original, url: fila.url_original, clave: fila.clave_original, thumb_url: fila.thumb_original, mime: fila.mime_original, size: fila.size_original, ancho: fila.ancho_original, alto: fila.alto_original }
      : archivoDeImagen(imagen);
    if (fila && imagen.url !== fila.url_original) {
      throw new ConflictException('La foto cambió mientras tanto: recargue la galería e intente de nuevo');
    }
    const bytes = await this.almacenes.leer(original.proveedor, original.clave, original.url);
    if (!bytes) {
      throw new ConflictException({
        codigo: 'ORIGINAL_NO_LEGIBLE',
        message: `No se puede leer la foto original desde el almacén «${original.proveedor || 'desconocido'}»: suba la foto de nuevo para mejorarla`,
      });
    }
    const { estado } = await this.mejorarExistente(id_imagen, id_producto, original, bytes);
    if (estado === 'cambio') throw new ConflictException('La foto cambió mientras se mejoraba: recargue la galería e intente de nuevo');
    return this.respuesta(id_producto);
  }

  // ── Fotos ya subidas («Mejorar ahora» y las tandas) ───────────────────────────────────

  /**
   * Mejora (o anota que estaba bien) una foto ya subida cuyos bytes ya se leyeron. `original` es el
   * archivo publicado ahora. Con `soloSiNueva` (tandas) no pisa una fila existente. Puede lanzar si el
   * almacén o la base fallan; en ese caso la foto queda como estaba y no sobra ningún archivo.
   */
  async mejorarExistente(
    id_imagen: number,
    id_producto: number,
    original: ArchivoFoto,
    bytes: ArchivoLeido,
    soloSiNueva = false,
  ): Promise<ResultadoExistente> {
    const archivo = { buffer: bytes.buffer, mimetype: bytes.mime, originalname: `imagen-${id_imagen}` };
    const prep = await this.preparar(archivo);
    if (prep.estado === 'mejorada' && prep.mejorada) {
      const guardada = await this.almacen.guardar({
        buffer: prep.mejorada.buffer, nombre_original: nombreMejorada(archivo.originalname), mime: prep.mejorada.mime, carpeta: String(id_producto),
      });
      let ok = false;
      try {
        ok = await this.repo.publicarMejorada(id_imagen, VERSION_MEJORA, original, archivoDe(guardada), prep.informe, soloSiNueva);
      } finally {
        if (!ok) await this.borrar(guardada.proveedor, guardada.clave);
      }
      return { estado: ok ? 'mejorada' : 'cambio' };
    }
    const estado = prep.estado as Exclude<PreparacionFoto['estado'], 'mejorada'>;
    const ok = await this.repo.registrar(id_imagen, estado, VERSION_MEJORA, original, prep.informe, soloSiNueva);
    return { estado: ok ? estado : 'cambio', error: prep.informe.error };
  }

  /** Anota en una foto sin fila por qué no se pudo procesar; así las tandas no vuelven a intentarlo. */
  anotarSinProcesar(
    id_imagen: number,
    original: ArchivoFoto,
    estado: 'omitida' | 'error',
    motivo: MotivoInforme,
    error?: string,
  ): Promise<boolean> {
    const informe: InformeMejora = { version: VERSION_MEJORA, acciones: [], avisos: [], motivo, error };
    return this.repo.registrar(id_imagen, estado, VERSION_MEJORA, original, informe, true);
  }

  /** 503 si falta el script; 404 si la foto no es de ese producto (como el resto de las imágenes). */
  private async imagenDelProducto(id_producto: number, id_imagen: number): Promise<ProductoImagen> {
    if (!(await this.disponible())) {
      throw new ServiceUnavailableException({ codigo: CODIGO_NO_DISPONIBLE, message: 'Falta ejecutar sql/fase23_mejora_fotos.sql' });
    }
    const imagen = await this.imagenes.findOneById(id_imagen);
    if (!imagen || imagen.producto?.id_producto !== id_producto) throw new NotFoundException('Imagen no encontrada');
    return imagen;
  }

  private async respuesta(id_producto: number) {
    const [imagenes, resumen] = [await this.imagenes.findByProducto(id_producto), await this.resumen(id_producto)];
    return { imagenes, mejoras: resumen.mejoras };
  }
}

/** «taladro.png» → «taladro (mejorada).jpg». */
export function nombreMejorada(original: string): string {
  const base = (original || 'foto').replace(/\.[^.]+$/, '');
  return `${base} (mejorada).jpg`.slice(0, 200);
}
