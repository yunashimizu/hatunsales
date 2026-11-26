import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { EsquemaCajaService } from '../caja/esquema/esquema-caja.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { ACCIONES_BITACORA } from '../bitacora/bitacora.acciones';
import { normalizarRol } from '../config/roles.config';
import type { UsuarioToken } from '../guards/usuario-actual.decorator';
import { AsignacionLocal, LocalAsignado, LocalesUsuarioRepository } from './locales-usuario.repository';

/** 403 de la Fase 8.5: el front lo reconoce por este código. */
export const CODIGO_ALMACEN_FUERA_DE_LOCAL = 'ALMACEN_FUERA_DE_SUS_LOCALES';

/** Qué puede tocar un usuario. `restringido: false` = como antes de la Fase 8.5 (todos los almacenes). */
export type AlcanceLocales =
  | { restringido: false }
  | { restringido: true; almacenes: ReadonlySet<number> };

export type AccionEnAlmacen = 'vender' | 'ajustar' | 'transferir';

const VERBO: Record<AccionEnAlmacen, string> = {
  vender: 'vender desde',
  ajustar: 'ajustar el stock de',
  transferir: 'sacar stock de',
};

/** Roles que el panel puede atar a locales (el admin ve y hace todo; un cliente de la tienda no aplica). */
const ROLES_CON_LOCAL = new Set(['vendedor', 'caja', 'consulta']);

/**
 * Fase 8.5 (D7): cada usuario puede quedar atado a uno o más locales (`usuario_sucursal`).
 *
 * - **Admin ve y hace todo**, tenga o no locales asignados.
 * - **Sin ningún local asignado** el usuario conserva exactamente el comportamiento de hoy. Como la tabla está
 *   vacía en producción, nada cambia hasta que el dueño asigne.
 * - Sin la tabla (instalación nueva sin fase21) o si la lectura falla, nadie queda restringido (aviso en el log):
 *   la regla nunca frena una venta por un problema propio.
 */
@Injectable()
export class LocalesUsuarioService {
  private readonly log = new Logger(LocalesUsuarioService.name);

  constructor(
    private readonly repo: LocalesUsuarioRepository,
    private readonly esquema: EsquemaCajaService,
    @Optional() private readonly bitacora?: BitacoraService,
  ) {}

  async alcance(usuario?: UsuarioToken | null): Promise<AlcanceLocales> {
    const idUsuario = Number(usuario?.id_usuario);
    if (!usuario || !Number.isSafeInteger(idUsuario) || idUsuario <= 0) return { restringido: false };
    if (normalizarRol(usuario.rol) === 'admin') return { restringido: false };
    try {
      if (!(await this.esquema.tiene('usuarioSucursal'))) return { restringido: false };
      const almacenes = await this.repo.almacenesPermitidos(idUsuario);
      return almacenes === null ? { restringido: false } : { restringido: true, almacenes: new Set(almacenes) };
    } catch (error) {
      this.log.warn(`No se pudieron leer los locales del usuario ${idUsuario}; queda sin restricción: ${(error as Error)?.message ?? error}`);
      return { restringido: false };
    }
  }

  /** 403 con un mensaje claro si el almacén no es de los locales del usuario. Sin restricción no hace nada. */
  async exigirAlmacen(usuario: UsuarioToken | null | undefined, idAlmacen: number, accion: AccionEnAlmacen): Promise<void> {
    const alcance = await this.alcance(usuario);
    if (!alcance.restringido || alcance.almacenes.has(Number(idAlmacen))) return;
    throw await this.fueraDeLocal(idAlmacen, accion);
  }

  /** Lista de almacenes recortada a los locales del usuario (la misma lista si no está restringido). */
  async filtrar<T extends { id_almacen: unknown }>(usuario: UsuarioToken | null | undefined, lista: T[]): Promise<T[]> {
    const alcance = await this.alcance(usuario);
    if (!alcance.restringido) return lista;
    return lista.filter((a) => alcance.almacenes.has(Number(a.id_almacen)));
  }

  /**
   * Almacén de la venta. Sin restricción: el elegido o, si no vino, el por defecto (exactamente como hoy).
   * Restringido: el elegido debe ser de sus locales; si no eligió, el por defecto si es de los suyos, o su
   * único almacén. Con varios y ninguno elegido, 403: una venta sin almacén descontaría de cualquiera.
   */
  async almacenParaVenta(
    usuario: UsuarioToken | null | undefined,
    idAlmacen: number | undefined,
    porDefecto?: number,
  ): Promise<number | undefined> {
    const alcance = await this.alcance(usuario);
    if (!alcance.restringido) return idAlmacen ?? porDefecto;
    if (idAlmacen !== undefined && idAlmacen !== null) {
      if (alcance.almacenes.has(Number(idAlmacen))) return idAlmacen;
      throw await this.fueraDeLocal(idAlmacen, 'vender');
    }
    if (porDefecto !== undefined && alcance.almacenes.has(Number(porDefecto))) return porDefecto;
    if (alcance.almacenes.size === 1) return [...alcance.almacenes][0];
    throw new ForbiddenException({
      codigo: CODIGO_ALMACEN_FUERA_DE_LOCAL,
      message: alcance.almacenes.size
        ? 'Elija el almacén de la venta: su usuario está asignado a varios almacenes.'
        : 'Su usuario está asignado a un local sin almacenes. Pida a un administrador que revise sus locales en Usuarios.',
    });
  }

  // ── Pantalla de Usuarios (solo admin) ─────────────────────────

  async localesDe(idUsuario: number): Promise<{ id_usuario: number; disponible: boolean; aplica: boolean; locales: LocalAsignado[] }> {
    const usuario = await this.repo.usuario(idUsuario);
    if (!usuario) throw new NotFoundException('Usuario no encontrado');
    const disponible = await this.disponible();
    return {
      id_usuario: idUsuario,
      disponible,
      // El admin no queda atado aunque tenga locales; un rol que no es del personal no aplica.
      aplica: ROLES_CON_LOCAL.has(normalizarRol(usuario.rol)),
      locales: disponible ? await this.repo.localesDe(idUsuario) : [],
    };
  }

  async todas(): Promise<{ disponible: boolean; asignaciones: AsignacionLocal[] }> {
    const disponible = await this.disponible();
    return { disponible, asignaciones: disponible ? await this.repo.todas() : [] };
  }

  /** Reemplaza los locales del usuario. `[]` = sin restricción (vuelve al comportamiento de antes). */
  async guardar(idUsuario: number, idsSucursal: unknown, admin?: UsuarioToken) {
    if (!(await this.disponible())) {
      throw new ServiceUnavailableException({
        codigo: 'LOCALES_NO_DISPONIBLE',
        message: 'Falta la tabla usuario_sucursal: aplique sql/fase21_stock_y_pedidos.sql para asignar locales.',
      });
    }
    if (!Array.isArray(idsSucursal)) throw new BadRequestException('Envíe «id_sucursales» como una lista de locales (vacía para quitar la restricción).');
    const ids = [...new Set(idsSucursal.map((v) => Number(v)))];
    if (ids.some((v) => !Number.isSafeInteger(v) || v <= 0)) throw new BadRequestException('Hay un local no válido en la lista.');
    if (ids.length > 200) throw new BadRequestException('Demasiados locales en la lista.');

    const usuario = await this.repo.usuario(idUsuario);
    if (!usuario) throw new NotFoundException('Usuario no encontrado');
    const rol = normalizarRol(usuario.rol);
    if (ids.length && !ROLES_CON_LOCAL.has(rol)) {
      throw new BadRequestException(
        rol === 'admin'
          ? 'Un administrador ve y hace todo: no se le asignan locales.'
          : 'Solo el personal (vendedor, caja o consulta) se asigna a locales.',
      );
    }
    const existentes = await this.repo.sucursalesExistentes(ids);
    const faltante = ids.find((v) => !existentes.has(v));
    if (faltante !== undefined) throw new BadRequestException(`El local ${faltante} no existe.`);

    const antes = await this.repo.reemplazar(idUsuario, ids.sort((a, b) => a - b));
    await this.bitacora?.registrarCon(() => ({
      accion: ACCIONES_BITACORA.USUARIO_LOCALES,
      id_usuario: admin?.id_usuario ?? null,
      rol: admin?.rol ?? null,
      entidad: 'usuario',
      id_entidad: idUsuario,
      antes: { id_sucursales: antes },
      despues: { id_sucursales: ids },
    }));
    return this.localesDe(idUsuario);
  }

  private async disponible(): Promise<boolean> {
    try {
      return await this.esquema.tiene('usuarioSucursal');
    } catch {
      return false;
    }
  }

  private async fueraDeLocal(idAlmacen: number, accion: AccionEnAlmacen): Promise<ForbiddenException> {
    let donde = `el almacén ${idAlmacen}`;
    try {
      const almacen = await this.repo.almacen(Number(idAlmacen));
      if (almacen) donde = `el almacén «${almacen.nombre}»${almacen.sucursal ? ` (local ${almacen.sucursal})` : ''}`;
    } catch {
      // El mensaje sale con el número.
    }
    return new ForbiddenException({
      codigo: CODIGO_ALMACEN_FUERA_DE_LOCAL,
      id_almacen: Number(idAlmacen),
      message: `No puede ${VERBO[accion]} ${donde}: su usuario no está asignado a ese local. Elija un almacén de su local o pida a un administrador que lo asigne.`,
    });
  }
}
