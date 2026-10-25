import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { BuscarDniRequest, BuscarRucEmpresaRequest, BuscarRucProveedorRequest } from '../../models/model/sunat.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { SunatBussnies } from 'src/bussnies/Bussnies/sunat.bussnies';

/**
 * Consultas de DNI (RENIEC) y RUC con la cuota de pago de ApiPeru: solo para el personal
 * del panel. Con solo JwtGuard, cualquier cliente registrado en la tienda podía consultar
 * datos personales de terceros.
 */
@Controller('sunat')
@UseGuards(JwtGuard, RolesGuard)
export class SunatController {

  constructor(private readonly SunatBussnies: SunatBussnies) {}

  // GET — solo consulta autocompletado
  @Get('dni/:dni')
  @Roles('admin', 'vendedor', 'caja')
  consultarDni(@Param('dni') dni: string) {
    return this.SunatBussnies.consultarDni(dni);
  }

  @Get('ruc/:ruc')
  @Roles('admin', 'vendedor', 'caja')
  consultarRuc(@Param('ruc') ruc: string) {
    return this.SunatBussnies.consultarRuc(ruc);
  }

  // POST — consulta y guarda en BD
  @Post('dni/cliente')
  @Roles('admin', 'vendedor', 'caja')
  guardarClienteDni(@Body() body: BuscarDniRequest) {
    return this.SunatBussnies.guardarClienteDni(body);
  }

  @Post('ruc/empresa')
  @Roles('admin')
  guardarEmpresaRuc(@Body() body: BuscarRucEmpresaRequest) {
    return this.SunatBussnies.guardarEmpresaRuc(body);
  }

  @Post('ruc/proveedor')
  @Roles('admin', 'vendedor')
  guardarProveedorRuc(@Body() body: BuscarRucProveedorRequest) {
    return this.SunatBussnies.guardarProveedorRuc(body);
  }
}
