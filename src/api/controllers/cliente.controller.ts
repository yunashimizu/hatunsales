import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ClienteBussnies } from '../../bussnies/Bussnies/cliente.bussnies';
import { CrearClienteRequest, ActualizarClienteRequest } from '../../models/model/cliente.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';

@Controller('cliente')
export class ClienteController {

  constructor(private readonly service: ClienteBussnies) {}

  // ── público — cualquier persona puede registrarse ────────────
  @Post('registro')
  registro(@Body() body: CrearClienteRequest) {
    return this.service.create(body);
  }

  // ── requiere token — solo personal interno ───────────────────
  @Get()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  getAll() {
    return this.service.getAll();
  }

  @Get(':id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  getById(@Param('id') id: string) {
    return this.service.getById(Number(id));
  }

  @Post()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  create(@Body() body: CrearClienteRequest) {
    return this.service.create(body);
  }

  @Post('sunat/dni/:dni')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  crearDesdeDni(@Param('dni') dni: string) {
    return this.service.crearDesdeSunatDni(dni);
  }

  @Post('sunat/ruc/:ruc')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  crearDesdeRuc(@Param('ruc') ruc: string) {
    return this.service.crearDesdeSunatRuc(ruc);
  }

  @Put(':id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin', 'vendedor')
  update(@Param('id') id: string, @Body() body: ActualizarClienteRequest) {
    return this.service.update(body, Number(id));
  }

  @Delete(':id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  delete(@Param('id') id: string) {
    return this.service.delete(Number(id));
  }
}