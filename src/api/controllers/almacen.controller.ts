import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
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

@Controller('almacen')
export class AlmacenController {
  constructor(
    @InjectRepository(Almacen, 'pgConnection')
    private readonly almacenRepo: Repository<Almacen>,
    @InjectRepository(Sucursal, 'pgConnection')
    private readonly sucursalRepo: Repository<Sucursal>,
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {}

  /** Listado para el panel e inventario. */
  @Get()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  async listar() {
    const filas = await this.dataSource.query(
      `SELECT a.id_almacen, a.nombre, a.descripcion, a.id_sucursal,
              COALESCE(s.nombre, '') AS sucursal,
              COALESCE((SELECT COUNT(*)::int FROM inventario i WHERE i.id_almacen = a.id_almacen), 0) AS productos,
              COALESCE((SELECT SUM(i.stock)::int FROM inventario i WHERE i.id_almacen = a.id_almacen), 0) AS unidades
         FROM almacenes a
         LEFT JOIN sucursales s ON s.id_sucursal = a.id_sucursal
        ORDER BY a.nombre ASC`,
    );
    return filas;
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
    return {
      id_almacen: almacen.id_almacen,
      nombre: almacen.nombre,
      descripcion: almacen.descripcion,
      id_sucursal: almacen.sucursal?.id_sucursal ?? null,
      sucursal: almacen.sucursal?.nombre ?? '',
    };
  }

  @Post()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  async crear(@Body() body: { nombre?: string; descripcion?: string; id_sucursal?: number | null }) {
    const nombre = (body?.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('El nombre es obligatorio');

    const creado = this.almacenRepo.create({
      nombre,
      descripcion: (body?.descripcion ?? '').trim() || null as any,
      sucursal: body?.id_sucursal
        ? ({ id_sucursal: Number(body.id_sucursal) } as Sucursal)
        : null as any,
    });

    const guardado = await this.almacenRepo.save(creado);
    return this.porId(String(guardado.id_almacen));
  }

  @Put(':id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  async actualizar(
    @Param('id') id: string,
    @Body() body: { nombre?: string; descripcion?: string; id_sucursal?: number | null },
  ) {
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
