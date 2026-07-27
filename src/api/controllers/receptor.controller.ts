import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { ReceptorBussnies } from '../../bussnies/Bussnies/receptor.bussnies';
import { ReceptorRepository } from '../../repository/Repository/receptor.repository';

/**
 * Búsqueda del receptor de un comprobante. Un solo endpoint sirve para DNI y
 * para RUC: el backend deduce el tipo por la cantidad de dígitos.
 */
@Controller('receptor')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'vendedor', 'caja')
export class ReceptorController {

  constructor(
    private readonly receptor: ReceptorBussnies,
    private readonly repo: ReceptorRepository,
  ) {}

  /** Sugerencias mientras se escribe, solo contra la base local. */
  @Get('sugerencias')
  sugerencias(@Query('q') q: string, @Query('limite') limite?: string) {
    return this.receptor.autocompletar(q ?? '', Number(limite) || 8);
  }

  @Get('consumidor-final')
  consumidorFinal() {
    return this.receptor.consumidorFinal();
  }

  /** Busca y registra el documento. Es el que usa el punto de venta. */
  @Get('buscar/:documento')
  buscar(@Param('documento') documento: string) {
    return this.receptor.buscarPorDocumento(documento, true);
  }

  /** Igual que el anterior pero sin guardar nada, para vistas de solo lectura. */
  @Get('consultar/:documento')
  consultar(@Param('documento') documento: string) {
    return this.receptor.buscarPorDocumento(documento, false);
  }

  @Get('cliente/:id')
  porCliente(@Param('id') id: string) {
    return this.receptor.porIdCliente(Number(id));
  }

  @Get('empresa/:id')
  porEmpresa(@Param('id') id: string) {
    return this.receptor.porIdEmpresa(Number(id));
  }

  @Get('empresas')
  listarEmpresas(@Query('limite') limite?: string) {
    return this.repo.listarEmpresas(Number(limite) || 200);
  }

  @Put('cliente/:id')
  actualizarCliente(@Param('id') id: string, @Body() body: Record<string, any>) {
    return this.repo.actualizarCliente(Number(id), this.soloCamposCliente(body));
  }

  @Put('empresa/:id')
  actualizarEmpresa(@Param('id') id: string, @Body() body: Record<string, any>) {
    return this.repo.actualizarEmpresa(Number(id), this.soloCamposEmpresa(body));
  }

  private soloCamposCliente(body: Record<string, any>) {
    const permitidos = ['nombre', 'apellido_paterno', 'apellido_materno', 'telefono', 'email', 'direccion'];
    return this.filtrar(body, permitidos);
  }

  private soloCamposEmpresa(body: Record<string, any>) {
    const permitidos = ['razon_social', 'nombre_comercial', 'telefonos', 'direccion', 'departamento', 'provincia', 'distrito'];
    return this.filtrar(body, permitidos);
  }

  private filtrar(body: Record<string, any>, permitidos: string[]) {
    return Object.fromEntries(
      Object.entries(body ?? {}).filter(([clave, valor]) => permitidos.includes(clave) && valor !== undefined),
    );
  }
}
