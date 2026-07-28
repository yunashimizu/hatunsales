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
import { Marca } from 'src/models/DBModel/marca.entity';

function slugify(texto: string): string {
  return texto
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

@Controller('marca')
export class MarcaController {
  constructor(
    @InjectRepository(Marca, 'pgConnection')
    private readonly marcaRepo: Repository<Marca>,
    @InjectDataSource('pgConnection')
    private readonly dataSource: DataSource,
  ) {}

  /** Lectura pública: la tienda y el panel pueden listar marcas. */
  @Get()
  async listar() {
    const marcas = await this.marcaRepo.find({ order: { nombre: 'ASC' } });
    const conteos = await this.dataSource.query(
      `SELECT id_marca, COUNT(*)::int AS productos
         FROM productos
        WHERE id_marca IS NOT NULL
        GROUP BY id_marca`,
    );
    const mapa = new Map<number, number>(
      (conteos as any[]).map((c) => [Number(c.id_marca), Number(c.productos)]),
    );

    return marcas.map((m) => ({
      id_marca: m.id_marca,
      nombre: m.nombre,
      slug: m.slug,
      logo_url: m.logo_url,
      activo: m.activo !== false,
      creado_en: m.creado_en,
      productos: mapa.get(m.id_marca) ?? 0,
    }));
  }

  @Get(':id')
  async porId(@Param('id') id: string) {
    const marca = await this.marcaRepo.findOne({ where: { id_marca: Number(id) } });
    if (!marca) throw new NotFoundException('Marca no encontrada');
    return marca;
  }

  @Post()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  async crear(@Body() body: { nombre?: string; logo_url?: string; activo?: boolean }) {
    const nombre = (body?.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('El nombre es obligatorio');

    const slug = slugify(nombre) || `marca-${Date.now()}`;
    const guardado = await this.marcaRepo.save(
      this.marcaRepo.create({
        nombre,
        slug,
        logo_url: (body?.logo_url ?? '').trim() || null as any,
        activo: body?.activo !== false,
      }),
    );

    return {
      id_marca: guardado.id_marca,
      nombre: guardado.nombre,
      slug: guardado.slug,
      logo_url: guardado.logo_url,
      activo: guardado.activo !== false,
      productos: 0,
    };
  }

  @Put(':id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  async actualizar(
    @Param('id') id: string,
    @Body() body: { nombre?: string; logo_url?: string; activo?: boolean },
  ) {
    const marca = await this.marcaRepo.findOne({ where: { id_marca: Number(id) } });
    if (!marca) throw new NotFoundException('Marca no encontrada');

    if (body.nombre !== undefined) {
      const nombre = body.nombre.trim();
      if (!nombre) throw new BadRequestException('El nombre es obligatorio');
      marca.nombre = nombre;
      marca.slug = slugify(nombre) || marca.slug;
    }
    if (body.logo_url !== undefined) {
      marca.logo_url = body.logo_url.trim() || (null as any);
    }
    if (body.activo !== undefined) {
      marca.activo = Boolean(body.activo);
    }

    const guardado = await this.marcaRepo.save(marca);
    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM productos WHERE id_marca = $1`,
      [guardado.id_marca],
    );

    return {
      id_marca: guardado.id_marca,
      nombre: guardado.nombre,
      slug: guardado.slug,
      logo_url: guardado.logo_url,
      activo: guardado.activo !== false,
      productos: Number(total ?? 0),
    };
  }

  @Delete(':id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  async eliminar(@Param('id') id: string) {
    const idMarca = Number(id);
    const marca = await this.marcaRepo.findOne({ where: { id_marca: idMarca } });
    if (!marca) throw new NotFoundException('Marca no encontrada');

    const [{ total }] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM productos WHERE id_marca = $1`,
      [idMarca],
    );
    if (Number(total) > 0) {
      throw new ConflictException(
        `No se puede eliminar: hay ${total} producto(s) con esta marca. Cámbiales la marca antes.`,
      );
    }

    await this.marcaRepo.delete(idMarca);
    return { deleted: true, id_marca: idMarca };
  }
}
