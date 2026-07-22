import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtGuard } from 'src/guards/jwt.guard';
import { RolesGuard } from 'src/guards/roles.guard';
import { Roles } from 'src/guards/roles.decorator';
import { Categoria } from 'src/models/DBModel/categoria.entity';

@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'vendedor', 'caja')
@Controller('categoria')
export class CategoriaController {
  constructor(
    @InjectRepository(Categoria, 'pgConnection')
    private readonly categoriaRepo: Repository<Categoria>,
  ) {}

  @Get()
  getAll() {
    return this.categoriaRepo.find({ order: { id_categoria: 'ASC' } });
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.categoriaRepo.findOne({ where: { id_categoria: Number(id) } });
  }

  @Post()
  create(@Body() body: Partial<Categoria>) {
    return this.categoriaRepo.save(this.categoriaRepo.create(body));
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: Partial<Categoria>) {
    await this.categoriaRepo.update(Number(id), body);
    return this.categoriaRepo.findOne({ where: { id_categoria: Number(id) } });
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.categoriaRepo.delete(Number(id));
    return { deleted: true, id: Number(id) };
  }
}
