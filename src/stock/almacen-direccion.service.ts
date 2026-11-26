import { BadRequestException, HttpException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { EsquemaCajaService } from '../caja/esquema/esquema-caja.service';
import { FiscalConfigService } from '../sunat/config/fiscal-config.service';
import { filasDe } from '../caja/bd/resultado-consulta';

/**
 * Fase 4.4 (sql/fase22_almacenes_direccion.sql): dirección, ubigeo y código de establecimiento del almacén,
 * y la «partida» que la guía de remisión propone para un almacén. NO toca la emisión de la guía: solo da
 * datos para que el panel precargue el formulario.
 *
 * Sin fase22 (capacidad `almacenDireccion`): las lecturas devuelven esos campos en null y `editable: false`;
 * guardar una dirección propia con valor responde 503 sin escribir nada; mandarlos vacíos se ignora.
 */

export interface DireccionAlmacen {
  direccion: string | null;
  ubigeo: string | null;
  codigo_establecimiento: string | null;
}

/** De dónde salió la partida propuesta. */
export type OrigenPartida = 'almacen' | 'sucursal' | 'configuracion' | 'ninguno';

export interface PartidaAlmacen extends DireccionAlmacen {
  id_almacen: number;
  almacen: string;
  id_sucursal: number | null;
  sucursal: string | null;
  origen: OrigenPartida;
  /** true si hay dirección, ubigeo y código de establecimiento (la guía no pide nada más del punto de partida). */
  completa: boolean;
  /** false sin fase22: el almacén no puede guardar dirección propia. */
  direccion_propia_disponible: boolean;
}

export const CODIGO_DIRECCION_NO_DISPONIBLE = 'ALMACEN_DIRECCION_NO_DISPONIBLE';

const CAMPOS = ['direccion', 'ubigeo', 'codigo_establecimiento'] as const;

/** Valida lo que llegó (solo las claves presentes). Vacío → null. Lanza 400 con un mensaje claro. */
export function validarDireccionAlmacen(body: Record<string, unknown> | null | undefined): Partial<DireccionAlmacen> {
  const salida: Partial<DireccionAlmacen> = {};
  for (const campo of CAMPOS) {
    const crudo = body?.[campo];
    if (crudo === undefined) continue;
    const texto = crudo === null ? '' : String(crudo).trim();
    if (!texto) {
      salida[campo] = null;
      continue;
    }
    if (campo === 'direccion' && texto.length > 200) {
      throw new BadRequestException('La dirección del almacén admite hasta 200 caracteres.');
    }
    if (campo === 'ubigeo' && !/^\d{6}$/.test(texto)) {
      throw new BadRequestException('El ubigeo del almacén debe tener 6 dígitos.');
    }
    if (campo === 'codigo_establecimiento' && !/^\d{4}$/.test(texto)) {
      throw new BadRequestException('El código de establecimiento debe tener 4 dígitos (0000 si es el domicilio fiscal).');
    }
    salida[campo] = texto;
  }
  return salida;
}

function textoONulo(valor: unknown): string | null {
  const t = String(valor ?? '').trim();
  return t ? t : null;
}

@Injectable()
export class AlmacenDireccionService {
  private readonly log = new Logger(AlmacenDireccionService.name);

  constructor(
    @InjectDataSource('pgConnection') private readonly dataSource: DataSource,
    @Optional() private readonly esquema?: EsquemaCajaService,
    @Optional() private readonly fiscal?: FiscalConfigService,
  ) {}

  /** ¿Está fase22? Nunca lanza (ante un fallo, no). */
  async disponible(): Promise<boolean> {
    try {
      return this.esquema ? await this.esquema.tiene('almacenDireccion') : false;
    } catch {
      return false;
    }
  }

  /**
   * Valida y comprueba ANTES de escribir nada (para el alta, que guarda el almacén primero). Devuelve lo
   * que habrá que guardar (vacío si no hay nada o si sin fase22 todo llegó vacío).
   */
  async preparar(body: Record<string, unknown> | null | undefined): Promise<Partial<DireccionAlmacen>> {
    const cambios = validarDireccionAlmacen(body);
    if (!Object.keys(cambios).length) return cambios;
    if (await this.disponible()) return cambios;
    if (Object.values(cambios).some((v) => v !== null)) {
      throw new HttpException(
        {
          codigo: CODIGO_DIRECCION_NO_DISPONIBLE,
          message:
            'Falta ejecutar sql/fase22_almacenes_direccion.sql en la base de datos: el almacén todavía no puede guardar su dirección. No se guardó ningún cambio.',
        },
        503,
      );
    }
    return {};
  }

  async guardar(idAlmacen: number, cambios: Partial<DireccionAlmacen>, manager?: EntityManager): Promise<void> {
    const claves = CAMPOS.filter((c) => cambios[c] !== undefined);
    if (!claves.length) return;
    const sets = claves.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await (manager ?? this.dataSource).query(
      `UPDATE almacenes SET ${sets} WHERE id_almacen = $1`,
      [idAlmacen, ...claves.map((c) => cambios[c] ?? null)],
    );
  }

  /** Dirección propia de varios almacenes (null en todo sin fase22). */
  async deAlmacenes(ids: number[]): Promise<Map<number, DireccionAlmacen>> {
    const mapa = new Map<number, DireccionAlmacen>();
    if (!ids.length || !(await this.disponible())) return mapa;
    const filas = filasDe<any>(await this.dataSource.query(
      `SELECT id_almacen, direccion, ubigeo, codigo_establecimiento FROM almacenes WHERE id_almacen = ANY($1::int[])`,
      [ids],
    ));
    for (const f of filas) {
      mapa.set(Number(f.id_almacen), {
        direccion: textoONulo(f.direccion),
        ubigeo: textoONulo(f.ubigeo),
        codigo_establecimiento: textoONulo(f.codigo_establecimiento),
      });
    }
    return mapa;
  }

  /**
   * Punto de partida propuesto para la guía desde este almacén:
   *   1) la dirección propia del almacén (con su ubigeo y código, si los tiene);
   *   2) si no tiene, la dirección de su sucursal (ubigeo y código en null: la sucursal no los guarda);
   *   3) si tampoco, la partida por defecto de la configuración fiscal (la que la guía usa hoy).
   * Nunca mezcla fuentes entre dirección y ubigeo, para no proponer un ubigeo de otro distrito.
   */
  async partida(idAlmacen: number): Promise<PartidaAlmacen> {
    const propia = await this.disponible();
    const filas = filasDe<any>(await this.dataSource.query(
      `SELECT a.id_almacen, COALESCE(a.nombre, '') AS almacen, a.id_sucursal, s.nombre AS sucursal,
              s.direccion AS direccion_sucursal
              ${propia ? ', a.direccion, a.ubigeo, a.codigo_establecimiento' : ''}
         FROM almacenes a
         LEFT JOIN sucursales s ON s.id_sucursal = a.id_sucursal
        WHERE a.id_almacen = $1`,
      [idAlmacen],
    ));
    const f = filas[0];
    if (!f) throw new NotFoundException('Almacén no encontrado');

    const base = {
      id_almacen: Number(f.id_almacen),
      almacen: String(f.almacen ?? ''),
      id_sucursal: f.id_sucursal == null ? null : Number(f.id_sucursal),
      sucursal: textoONulo(f.sucursal),
      direccion_propia_disponible: propia,
    };
    const armar = (origen: OrigenPartida, d: DireccionAlmacen): PartidaAlmacen => ({
      ...base,
      ...d,
      origen,
      completa: !!(d.direccion && d.ubigeo && d.codigo_establecimiento),
    });

    const direccionPropia = propia ? textoONulo(f.direccion) : null;
    if (direccionPropia) {
      return armar('almacen', {
        direccion: direccionPropia,
        ubigeo: textoONulo(f.ubigeo),
        codigo_establecimiento: textoONulo(f.codigo_establecimiento),
      });
    }
    const direccionSucursal = textoONulo(f.direccion_sucursal);
    if (direccionSucursal) {
      return armar('sucursal', { direccion: direccionSucursal, ubigeo: null, codigo_establecimiento: null });
    }
    const config = await this.partidaConfigurada();
    if (config?.direccion) return armar('configuracion', config);
    return armar('ninguno', { direccion: null, ubigeo: null, codigo_establecimiento: null });
  }

  /** Partida por defecto de la configuración fiscal (null si no se puede leer). Nunca lanza. */
  private async partidaConfigurada(): Promise<DireccionAlmacen | null> {
    if (!this.fiscal) return null;
    try {
      const p = (await this.fiscal.gre()).partida;
      return {
        direccion: textoONulo(p?.direccion),
        ubigeo: textoONulo(p?.ubigeo),
        codigo_establecimiento: textoONulo(p?.codigoEstablecimiento),
      };
    } catch (error) {
      this.log.warn(`No se pudo leer la partida de la configuración fiscal: ${(error as Error)?.message ?? error}`);
      return null;
    }
  }
}
