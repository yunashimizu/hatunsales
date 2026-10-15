import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
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
  constructor(private readonly service: CajaArqueoBussnies) {}

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
