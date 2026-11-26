import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Optional,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { JwtGuard } from 'src/guards/jwt.guard';
import { RolesGuard } from 'src/guards/roles.guard';
import { Roles } from 'src/guards/roles.decorator';
import { Almacen } from 'src/models/DBModel/almacen.entity';
import { Sucursal } from 'src/models/DBModel/sucursal.entity';
import { UsuarioActual } from 'src/guards/usuario-actual.decorator';
import type { UsuarioToken } from 'src/guards/usuario-actual.decorator';
import { LocalesUsuarioService } from 'src/stock/locales-usuario.service';
import { AlmacenDireccionService } from 'src/stock/almacen-direccion.service';

/** Cuerpo de alta y edición. Los tres campos de la Fase 4.4 son opcionales (vacío = quitar). */
interface CuerpoAlmacen {
  nombre?: string;
  descripcion?: string;
  id_sucursal?: number | null;
  direccion?: string | null;
  ubigeo?: string | null;
  codigo_establecimiento?: string | null;
}

const SIN_DIRECCION = { direccion: null, ubigeo: null, codigo_establecimiento: null };

@Controller('almacen')
export class AlmacenController {
  constructor(
    @InjectRepository(Almacen, 'pgConnection')
    private readonly almacenRepo: Repository<Almacen>,
    @InjectRepository(Sucursal, 'pgConnection')
    private readonly sucursalRepo: Repository<Sucursal>,
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
    /** Fase 8.5: un usuario atado a locales solo ve los almacenes de sus locales. */
    @Optional() private readonly locales?: LocalesUsuarioService,
    /** Fase 4.4 (fase22): dirección, ubigeo y establecimiento del almacén, y la partida para la guía. */
    @Optional() private readonly direcciones?: AlmacenDireccionService,
  ) {}

  /** Listado para el panel e inventario. */
  @Get()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  async listar(@UsuarioActual() usuario?: UsuarioToken) {
    const filas = await this.dataSource.query(
      `SELECT a.id_almacen, a.nombre, a.descripcion, a.id_sucursal,
              COALESCE(s.nombre, '') AS sucursal,
              COALESCE((SELECT COUNT(*)::int FROM inventario i WHERE i.id_almacen = a.id_almacen), 0) AS productos,
              COALESCE((SELECT SUM(i.stock)::int FROM inventario i WHERE i.id_almacen = a.id_almacen), 0) AS unidades
         FROM almacenes a
         LEFT JOIN sucursales s ON s.id_sucursal = a.id_sucursal
        ORDER BY a.nombre ASC`,
    );
    const visibles = this.locales ? await this.locales.filtrar(usuario, filas) : filas;
    // Fase 4.4: con fase22 cada fila trae además su dirección propia (sin fase22, en null).
    if (!this.direcciones) return visibles;
    const mapa = await this.direcciones.deAlmacenes((visibles as any[]).map((f) => Number(f.id_almacen)));
    return (visibles as any[]).map((f) => ({ ...f, ...(mapa.get(Number(f.id_almacen)) ?? SIN_DIRECCION) }));
  }

  @Get('sucursales')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  listarSucursales() {
    return this.sucursalRepo.find({ order: { nombre: 'ASC' } });
  }

  @Get(':id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  async porId(@Param('id') id: string) {
    const almacen = await this.almacenRepo.findOne({
      where: { id_almacen: Number(id) },
      relations: ['sucursal'],
    });
    if (!almacen) throw new NotFoundException('Almacén no encontrado');
    const base = {
      id_almacen: almacen.id_almacen,
      nombre: almacen.nombre,
      descripcion: almacen.descripcion,
      id_sucursal: almacen.sucursal?.id_sucursal ?? null,
      sucursal: almacen.sucursal?.nombre ?? '',
    };
    if (!this.direcciones) return base;
    // Fase 4.4: campos añadidos (null sin fase22) y si se pueden editar.
    const editable = await this.direcciones.disponible();
    const propia = (await this.direcciones.deAlmacenes([almacen.id_almacen])).get(almacen.id_almacen) ?? SIN_DIRECCION;
    return { ...base, ...propia, direccion_editable: editable };
  }

  /**
   * Fase 4.4: punto de partida que la guía de remisión propone para este almacén (la dirección propia; si no
   * tiene, la de su sucursal; si tampoco, la de la configuración fiscal). Solo datos para precargar: la
   * emisión de la guía no cambia.
   */
  @Get(':id/partida')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  partida(@Param('id') id: string) {
    if (!this.direcciones) throw new NotFoundException('No disponible');
    const idAlmacen = Number(id);
    if (!Number.isInteger(idAlmacen) || idAlmacen <= 0) throw new BadRequestException('Almacén no válido');
    return this.direcciones.partida(idAlmacen);
  }

  @Post()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  async crear(@Body() body: CuerpoAlmacen) {
    const nombre = (body?.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('El nombre es obligatorio');
    // Fase 4.4: validar (400) y comprobar fase22 (503) ANTES de crear nada.
    const direccion = this.direcciones ? await this.direcciones.preparar(body as any) : {};

    const creado = this.almacenRepo.create({
      nombre,
      descripcion: (body?.descripcion ?? '').trim() || null as any,
      sucursal: body?.id_sucursal
        ? ({ id_sucursal: Number(body.id_sucursal) } as Sucursal)
        : null as any,
    });

    const guardado = await this.almacenRepo.save(creado);
    if (this.direcciones) await this.direcciones.guardar(guardado.id_almacen, direccion);
    return this.porId(String(guardado.id_almacen));
  }

  @Put(':id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  async actualizar(
    @Param('id') id: string,
    @Body() body: CuerpoAlmacen,
  ) {
    // Fase 4.4: validar (400) y comprobar fase22 (503) antes de escribir nada.
    const direccion = this.direcciones ? await this.direcciones.preparar(body as any) : {};
    const almacen = await this.almacenRepo.findOne({
      where: { id_almacen: Number(id) },
      relations: ['sucursal'],
    });
    if (!almacen) throw new NotFoundException('Almacén no encontrado');

    if (body.nombre !== undefined) {
      const nombre = body.nombre.trim();
      if (!nombre) throw new BadRequestException('El nombre es obligatorio');
      almacen.nombre = nombre;
    }
    if (body.descripcion !== undefined) {
      almacen.descripcion = body.descripcion.trim() || (null as any);
    }
    if (body.id_sucursal !== undefined) {
      almacen.sucursal = body.id_sucursal
        ? ({ id_sucursal: Number(body.id_sucursal) } as Sucursal)
        : (null as any);
    }

    await this.almacenRepo.save(almacen);
    if (this.direcciones) await this.direcciones.guardar(almacen.id_almacen, direccion);
    return this.porId(id);
  }

  @Delete(':id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  async eliminar(@Param('id') id: string) {
    const idAlmacen = Number(id);
    const existe = await this.almacenRepo.findOne({ where: { id_almacen: idAlmacen } });
    if (!existe) throw new NotFoundException('Almacén no encontrado');

    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM inventario WHERE id_almacen = $1 AND COALESCE(stock, 0) > 0`,
      [idAlmacen],
    );
    if (Number(total) > 0) {
      throw new ConflictException(
        'No se puede eliminar: el almacén todavía tiene productos con stock. Transfiérelos o ajústelos antes.',
      );
    }

    // Limpia filas vacías de inventario para no dejar huérfanos.
    await this.dataSource.query(`DELETE FROM inventario WHERE id_almacen = $1`, [idAlmacen]);
    await this.almacenRepo.delete(idAlmacen);
    return { deleted: true, id_almacen: idAlmacen };
  }
}
