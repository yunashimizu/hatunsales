import { Controller, Get, Post, Put, Body, Param, UseGuards } from '@nestjs/common';
import { ProformaBussnies } from '../../bussnies/Bussnies/proforma.bussnies';
import {
  CrearProformaRequest,
  EnviarCotizacionWaRequest,
  MarcarProformaRequest,
} from '../../models/model/proforma.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';

@Controller('proforma')
@UseGuards(JwtGuard, RolesGuard)
export class ProformaController {

  constructor(private readonly service: ProformaBussnies) {}

  @Get()
  @Roles('admin', 'vendedor', 'caja')
  getAll() {
    return this.service.getAll();
  }

  @Get('whatsapp/estado')
  @Roles('admin', 'vendedor', 'caja')
  whatsappEstado() {
    return this.service.whatsappEstado();
  }

  @Get(':id')
  @Roles('admin', 'vendedor', 'caja')
  getById(@Param('id') id: string) {
    return this.service.getById(Number(id));
  }

  @Post()
  @Roles('admin', 'vendedor', 'caja')
  create(@Body() body: CrearProformaRequest) {
    return this.service.create(body);
  }

  @Put(':id')
  @Roles('admin', 'vendedor', 'caja')
  marcar(@Param('id') id: string, @Body() body: MarcarProformaRequest) {
    return this.service.marcar(Number(id), body);
  }

  @Post('whatsapp/enviar')
  @Roles('admin', 'vendedor', 'caja')
  enviarWa(@Body() body: EnviarCotizacionWaRequest) {
    return this.service.enviarPorWhatsapp(body);
  }
}
