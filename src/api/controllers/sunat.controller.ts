import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { BuscarDniRequest, BuscarRucEmpresaRequest, BuscarRucProveedorRequest } from '../../models/model/sunat.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { SunatBussnies } from 'src/bussnies/Bussnies/sunat.bussnies';

@Controller('sunat')
@UseGuards(JwtGuard)
export class SunatController {

  constructor(private readonly SunatBussnies: SunatBussnies) {}

  // GET — solo consulta autocompletado
  @Get('dni/:dni')
  consultarDni(@Param('dni') dni: string) {
    return this.SunatBussnies.consultarDni(dni);
  }

  @Get('ruc/:ruc')
  consultarRuc(@Param('ruc') ruc: string) {
    return this.SunatBussnies.consultarRuc(ruc);
  }

  // POST — consulta y guarda en BD
  @Post('dni/cliente')
  @UseGuards(RolesGuard)
  @Roles('admin', 'vendedor', 'caja')
  guardarClienteDni(@Body() body: BuscarDniRequest) {
    return this.SunatBussnies.guardarClienteDni(body);
  }

  @Post('ruc/empresa')
  @UseGuards(RolesGuard)
  @Roles('admin')
  guardarEmpresaRuc(@Body() body: BuscarRucEmpresaRequest) {
    return this.SunatBussnies.guardarEmpresaRuc(body);
  }

  @Post('ruc/proveedor')
  @UseGuards(RolesGuard)
  @Roles('admin')
  guardarProveedorRuc(@Body() body: BuscarRucProveedorRequest) {
    return this.SunatBussnies.guardarProveedorRuc(body);
  }
}