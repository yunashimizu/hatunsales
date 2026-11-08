import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  StreamableFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtGuard } from '../../guards/jwt.guard';
import { Roles } from '../../guards/roles.decorator';
import { RolesGuard } from '../../guards/roles.guard';
import { UsuarioActual } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import { actorDe } from '../admin/actor-fiscal';
import { ErroresFiscalesInterceptor } from '../admin/errores-fiscales.interceptor';
import { FiscalConfigError } from '../config/fiscal-errores';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import { RelojFiscal } from '../config/reloj-fiscal';
import { descargaDeEnvio } from '../emision/descarga-envio';
import { LotesFiscales } from './lotes.contrato';
import { CrearResumenDto, ListarLotesDto } from './lotes-admin.dto';

/**
 * Bajas (RA) y resúmenes (RC) a SUNAT para el administrador: listado, detalle, reintento (reenvía el mismo
 * ZIP o consulta el ticket), «Liberar» un lote sin respuesta y descargas (XML firmado, ZIP y CDR). La baja se pide desde
 * POST /comprobante/anular con `sin_nota: true`, no desde aquí.
 */
@Controller('fiscal')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
@UseInterceptors(ErroresFiscalesInterceptor)
export class LotesAdminController {
  constructor(
    private readonly lotes: LotesFiscales,
    private readonly esquema: FiscalEsquemaService,
    private readonly reloj: RelojFiscal,
  ) {}

  @Get('lotes')
  @Header('Cache-Control', 'private, no-store')
  async listar(@Query() filtro: ListarLotesDto) {
    await this.esquema.exigir('emision');
    return this.lotes.listar(filtro);
  }

  @Get('lotes/:id')
  @Header('Cache-Control', 'private, no-store')
  async obtener(@Param('id', ParseIntPipe) id: number) {
    await this.esquema.exigir('emision');
    const lote = await this.lotes.obtener(id);
    if (!lote) throw new FiscalConfigError('FISCAL_DOC_NO_ENCONTRADO', `No existe el lote ${id}.`);
    return lote;
  }

  @Get('lotes/:id/archivos/:tipo')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Access-Control-Expose-Headers', 'Content-Disposition')
  async archivo(@Param('id', ParseIntPipe) id: number, @Param('tipo') tipo: string): Promise<StreamableFile> {
    await this.esquema.exigir('emision');
    return descargaDeEnvio({ obtenerArchivo: (idEnvio, tipoArchivo) => this.lotes.archivo(idEnvio, tipoArchivo) }, id, tipo);
  }

  /**
   * «Enviar resumen del día»: informa a SUNAT, en un resumen diario (RC, condición 1), las boletas y notas de boleta de
   * una fecha de emisión que esperan resumen (sin fecha, las de hoy). Solo administrador; queda auditado con el usuario.
   * 409 FISCAL_RESUMEN_NO_PERMITIDO si no hay nada que informar; 409 FISCAL_RESUMEN_FUERA_DE_PLAZO pasados los 7 días.
   */
  @Post('lotes/resumen')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async crearResumen(@Body() cuerpo: CrearResumenDto, @UsuarioActual() usuario: UsuarioToken | undefined, @Req() req: Request) {
    await this.esquema.exigir('emision', 'auditoria');
    const fecha = cuerpo?.fecha || this.reloj.fechaLima();
    const resultado = await this.lotes.crearResumenAdicion({ fecha_emision: fecha, actor: actorDe(usuario, req), origen: 'manual' });
    if (!resultado) {
      throw new FiscalConfigError(
        'FISCAL_RESUMEN_NO_PERMITIDO',
        `No hay boletas por informar del ${fecha.slice(8, 10)}/${fecha.slice(5, 7)}: todas ya fueron aceptadas o están en un resumen en proceso.`,
        { fecha_emision: fecha },
      );
    }
    return resultado;
  }

  @Post('lotes/:id/reintentar')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async reintentar(@Param('id', ParseIntPipe) id: number) {
    await this.esquema.exigir('emision');
    return this.lotes.reintentar(id);
  }

  /**
   * «Liberar»: suelta un lote cuyo ticket SUNAT no resolvió (S4). Solo administrador; queda auditado con
   * el usuario y los comprobantes vuelven a su estado anterior.
   */
  @Post('lotes/:id/liberar')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async liberar(@Param('id', ParseIntPipe) id: number, @UsuarioActual() usuario: UsuarioToken | undefined, @Req() req: Request) {
    await this.esquema.exigir('emision', 'auditoria');
    return this.lotes.liberar(id, actorDe(usuario, req));
  }
}
