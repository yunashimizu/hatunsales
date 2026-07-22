import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { ProformaBussnies } from '../../bussnies/Bussnies/proforma.bussnies';
import { CrearProformaRequest } from '../../models/model/proforma.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';

@Controller('proforma')
export class ProformaController {

  constructor(private readonly service: ProformaBussnies) {}

  @Get()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  getAll() {
    return this.service.getAll();
  }

  @Post()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  create(@Body() body: CrearProformaRequest) {
    return this.service.create(body);
  }
}
