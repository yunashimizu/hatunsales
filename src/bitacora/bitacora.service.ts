import { Injectable, Logger } from '@nestjs/common';
import { EsquemaCajaService } from '../caja/esquema/esquema-caja.service';
import { sanitizarDetalle } from '../sunat/auditoria/fiscal-auditoria.repository';
import { AccionBitacora } from './bitacora.acciones';
import { BitacoraRepository, FilaBitacoraNueva, FiltroBitacora, RegistroBitacora } from './bitacora.repository';

/** Lo que una operación anota en la bitácora. Todo es opcional salvo la acción. */
export interface EventoBitacora {
  accion: AccionBitacora;
  /** Quien hizo la acción (null: el sistema o un pedido web). */
  id_usuario?: number | null;
  rol?: string | null;
  /** Administrador que autorizó (B2). */
  id_autorizador?: number | null;
  id_almacen?: number | null;
  /** 'venta', 'producto', 'comprobante', 'apertura_caja'… */
  entidad?: string | null;
  id_entidad?: number | string | null;
  antes?: Record<string, unknown> | null;
  despues?: Record<string, unknown> | null;
  motivo?: string | null;
  ip?: string | null;
}

export interface PaginaBitacora {
  registros: RegistroBitacora[];
  /** Cursor para la página siguiente (`antes_de`); null si no hay más. */
  siguiente: number | null;
  /** false mientras falte sql/fase19 (la pantalla avisa en lugar de mostrar una lista vacía sin explicación). */
  disponible: boolean;
}

const MAX_JSON = 8_000;
const MAX_MOTIVO = 500;
const LIMITE_POR_DEFECTO = 50;
const LIMITE_MAXIMO = 200;

function texto(valor: unknown, largo: number): string | null {
  const limpio = String(valor ?? '').trim();
  return limpio ? limpio.slice(0, largo) : null;
}

function entero(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isSafeInteger(n) ? n : null;
}

/** JSON sin secretos y acotado; un objeto vacío o ausente es null. */
function json(valor: Record<string, unknown> | null | undefined): string | null {
  if (!valor || typeof valor !== 'object' || !Object.keys(valor).length) return null;
  const serializado = JSON.stringify(sanitizarDetalle(valor));
  return serializado.length > MAX_JSON
    ? JSON.stringify({ resumen: `${serializado.slice(0, MAX_JSON - 100)}…`, recortado: true })
    : serializado;
}

/**
 * Bitácora de acciones (Fase 6.3): quién hizo qué, con el antes y el después.
 *
 * Regla de oro: **nunca hace fallar la operación principal**. Si falta sql/fase19 o el INSERT falla,
 * deja un aviso en el log y sigue. Quien llama la invoca DESPUÉS de confirmar su transacción (lo
 * anotado nunca describe algo que se revirtió) y puede esperarla con `await` sin try/catch.
 */
@Injectable()
export class BitacoraService {
  private readonly log = new Logger(BitacoraService.name);

  constructor(
    private readonly repo: BitacoraRepository,
    private readonly esquema: EsquemaCajaService,
  ) {}

  /**
   * ¿Existe la tabla? Para no hacer lecturas previas (el «antes» de un cambio) que no se van a guardar.
   * Usa la lectura del catálogo ya cacheada (EsquemaCajaService): no consulta por petición. Nunca lanza.
   */
  async disponible(): Promise<boolean> {
    try {
      return await this.esquema.tiene('bitacora');
    } catch {
      return false;
    }
  }

  /** Anota un evento. Nunca lanza. */
  async registrar(evento: EventoBitacora): Promise<void> {
    await this.registrarVarios([evento]);
  }

  /**
   * Anota lo que devuelva `fabrica` (un evento, varios, o nada). Es la forma que usan las operaciones ya
   * confirmadas: el evento se arma DENTRO de esta llamada, así que si armarlo lanza (un dato inesperado
   * en un `.map`, una propiedad nula…) el error queda en el log y la operación responde igual. Nunca lanza.
   */
  async registrarCon(
    fabrica: () => EventoBitacora | readonly (EventoBitacora | null | undefined)[] | null | undefined,
  ): Promise<void> {
    let eventos: EventoBitacora[];
    try {
      const resultado = fabrica();
      const lista = Array.isArray(resultado) ? resultado : [resultado];
      eventos = lista.filter((e): e is EventoBitacora => !!e);
    } catch (error) {
      this.log.warn(`No se pudo armar el evento de la bitácora: ${(error as Error)?.message ?? error}`);
      return;
    }
    if (eventos.length) await this.registrarVarios(eventos);
  }

  /** Anota varios eventos con un solo INSERT (p. ej. una fila por línea rebajada, B2). Nunca lanza. */
  async registrarVarios(eventos: EventoBitacora[]): Promise<void> {
    let validos: EventoBitacora[];
    try {
      validos = (Array.isArray(eventos) ? eventos : []).filter((e) => e && e.accion);
    } catch {
      return;
    }
    if (!validos.length) return;
    try {
      if (!(await this.esquema.tiene('bitacora'))) {
        for (const e of validos) {
          this.log.log(`Bitácora (sin tabla): ${e.accion} por usuario ${e.id_usuario ?? 'sistema'} sobre ${e.entidad ?? '-'} ${e.id_entidad ?? ''}`.trim());
        }
        return;
      }
      await this.repo.insertar(validos.map((e) => this.aFila(e)));
    } catch (error) {
      this.log.warn(
        `No se pudo anotar en la bitácora ${validos.map((e) => e.accion).join(', ')}: ${(error as Error)?.message ?? error}`,
      );
    }
  }

  /** Pantalla «Actividad»: lo más reciente primero, por cursor. */
  async listar(filtro: Omit<FiltroBitacora, 'limite'> & { limite?: number }): Promise<PaginaBitacora> {
    if (!(await this.esquema.tiene('bitacora'))) return { registros: [], siguiente: null, disponible: false };
    const limite = Math.min(LIMITE_MAXIMO, Math.max(1, Math.trunc(Number(filtro.limite) || LIMITE_POR_DEFECTO)));
    const registros = await this.repo.listar({ ...filtro, limite });
    const ultimo = registros[registros.length - 1];
    return { registros, siguiente: registros.length === limite && ultimo ? ultimo.id : null, disponible: true };
  }

  private aFila(e: EventoBitacora): FilaBitacoraNueva {
    return {
      id_usuario: entero(e.id_usuario),
      rol: texto(e.rol, 30),
      id_autorizador: entero(e.id_autorizador),
      id_almacen: entero(e.id_almacen),
      accion: String(e.accion).slice(0, 60),
      entidad: texto(e.entidad, 40),
      id_entidad: entero(e.id_entidad),
      antes: json(e.antes),
      despues: json(e.despues),
      motivo: texto(e.motivo, MAX_MOTIVO),
      ip: texto(e.ip, 60),
    };
  }
}
