import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Optional,
  Param,
  ParseIntPipe,
  Post,
  Query,
  ServiceUnavailableException,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { DevolucionCajaService } from '../../caja/devolucion/devolucion-caja.service';
import { CATEGORIAS_GASTO, ETIQUETA_CATEGORIA_GASTO } from '../../caja/configuracion/control-caja';
import { relanzarHttp } from '../../caja/http/errores-caja.http';
import { CajaArqueoBussnies } from '../../bussnies/Bussnies/caja-arqueo.bussnies';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { UsuarioActual } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { PdfArqueoQuery, RegistrarArqueoRequest, TurnoQuery } from '../../models/model/caja-arqueo.request';
import { MovimientoCajaRequest } from '../../models/model/caja.request';

/**
 * Arqueo de caja (parcial y de cierre) e ingresos/egresos de efectivo del turno.
 * Mismos roles que operan la caja hoy (admin, caja y vendedor). Un usuario solo ve y arquea
 * su propio turno; un admin, cualquiera.
 *
 * Las rutas fijas ('arqueo/esperado') van antes de 'arqueo/:id'.
 */
@Controller('caja')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'caja', 'vendedor')
export class CajaArqueoController {
  constructor(
    private readonly service: CajaArqueoBussnies,
    /** Fase 7.1. Nest siempre lo inyecta; opcional para las pruebas que solo arman el arqueo. */
    @Optional() private readonly devoluciones?: DevolucionCajaService,
  ) {}

  /** Efectivo y medios esperados del turno (por defecto, el abierto del usuario). */
  @Get('arqueo/esperado')
  esperado(@Query() query: TurnoQuery, @UsuarioActual() usuario: UsuarioToken) {
    return this.service.esperado(usuario, query.id_apertura);
  }

  /** Historial de arqueos del turno. */
  @Get('arqueo')
  listar(@Query() query: TurnoQuery, @UsuarioActual() usuario: UsuarioToken) {
    return this.service.listar(usuario, query.id_apertura, query.limite ?? 50);
  }

  @Post('arqueo')
  @HttpCode(201)
  registrar(@Body() body: RegistrarArqueoRequest, @UsuarioActual() usuario: UsuarioToken) {
    return this.service.registrar(usuario, body);
  }

  @Get('arqueo/:id/pdf')
  @Header('Cache-Control', 'no-store')
  @Header('Access-Control-Expose-Headers', 'Content-Disposition')
  async pdf(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: PdfArqueoQuery,
    @UsuarioActual() usuario: UsuarioToken,
  ): Promise<StreamableFile> {
    const formato = query.formato ?? 'ticket';
    const { buffer, nombreArchivo } = await this.service.pdf(usuario, id, formato);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `inline; filename="${nombreArchivo}"`,
      length: buffer.length,
    });
  }

  @Get('arqueo/:id')
  obtener(@Param('id', ParseIntPipe) id: number, @UsuarioActual() usuario: UsuarioToken) {
    return this.service.obtener(usuario, id);
  }

  /** Fase 7.5: categorías del gasto de caja (lista cerrada) con su etiqueta. */
  @Get('gastos/categorias')
  categoriasGasto() {
    return { items: CATEGORIAS_GASTO.map((clave) => ({ clave, etiqueta: ETIQUETA_CATEGORIA_GASTO[clave] })) };
  }

  /**
   * Fase 7.1: cuánto efectivo se puede devolver de una venta con `reembolso_efectivo` (al anular o con nota de
   * crédito parcial), cuánto ya se devolvió y si la venta es de un turno abierto (entonces anular no lleva egreso).
   */
  @Get('devolucion/:id_venta')
  async devolucion(@Param('id_venta', ParseIntPipe) idVenta: number, @UsuarioActual() usuario: UsuarioToken) {
    if (!this.devoluciones) throw new ServiceUnavailableException('La devolución en efectivo no está disponible en este momento.');
    try {
      return await this.devoluciones.consultar(idVenta, usuario);
    } catch (error) {
      relanzarHttp(error);
    }
  }

  /** Ingresos y egresos de efectivo del turno. */
  @Get('movimientos')
  movimientos(@Query() query: TurnoQuery, @UsuarioActual() usuario: UsuarioToken) {
    return this.service.listarMovimientos(usuario, query.id_apertura, query.limite ?? 100);
  }

  @Post('movimientos')
  @HttpCode(201)
  registrarMovimiento(@Body() body: MovimientoCajaRequest, @UsuarioActual() usuario: UsuarioToken) {
    return this.service.registrarMovimiento(usuario, body);
  }
}
