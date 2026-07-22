import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtGuard } from 'src/guards/jwt.guard';
import { RolesGuard } from 'src/guards/roles.guard';
import { Roles } from 'src/guards/roles.decorator';
import { Rol } from 'src/models/DBModel/role.entity';

@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
@Controller('rol')
export class RolController {
  constructor(
    @InjectRepository(Rol, 'pgConnection')
    private readonly rolRepo: Repository<Rol>,
  ) {}

  @Get()
  getAll() {
    return this.rolRepo.find({ order: { id_rol: 'ASC' } });
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.rolRepo.findOne({ where: { id_rol: Number(id) } });
  }
}
