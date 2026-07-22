import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { GuiaRemisionBussnies } from '../../bussnies/Bussnies/guia-remision.bussnies';
import { CrearGuiaRemisionRequest } from '../../models/model/guia-remision.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';

@Controller('guia-remision')
export class GuiaRemisionController {

  constructor(private readonly service: GuiaRemisionBussnies) {}

  @Get()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  getAll() {
    return this.service.getAll();
  }

  @Post()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  create(@Body() body: CrearGuiaRemisionRequest) {
    return this.service.create(body);
  }
}
