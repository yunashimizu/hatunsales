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
import { InterruptorEmisionFiscal } from '../config/interruptor-emision.service';
import { descargaDeEnvio } from './descarga-envio';
import { EmisionDirectaService } from './emision-directa.service';
import { ConfirmarAceptadoDto, ListarEnviosDto } from './envios-admin.dto';

/**
 * Envíos de factura, boleta y notas a SUNAT (BETA y PRODUCCIÓN) para el administrador: listado,
 * descargas (XML, XML firmado, ZIP y CDR), reintento seguro, recuperación del CDR, confirmación manual
 * de un resultado incierto, «Reanudar emisión» (interruptor D5.4) y la prueba de credenciales SOL de
 * producción (D1.4). Todo queda auditado; ninguna acción emite un comprobante nuevo.
 */
@Controller('fiscal')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
@UseInterceptors(ErroresFiscalesInterceptor)
export class EnviosAdminController {
  constructor(
    private readonly emision: EmisionDirectaService,
    private readonly interruptor: InterruptorEmisionFiscal,
    private readonly esquema: FiscalEsquemaService,
  ) {}

  @Get('envios')
  @Header('Cache-Control', 'private, no-store')
  async listar(@Query() filtro: ListarEnviosDto) {
    await this.esquema.exigir('emision');
    return this.emision.listarEnvios(filtro);
  }

  @Get('envios/:id')
  @Header('Cache-Control', 'private, no-store')
  async obtener(@Param('id', ParseIntPipe) id: number) {
    await this.esquema.exigir('emision');
    const envio = await this.emision.obtenerEnvio(id);
    if (!envio) throw new FiscalConfigError('FISCAL_DOC_NO_ENCONTRADO', `No existe el envío ${id}.`);
    return envio;
  }

  @Get('envios/:id/archivos/:tipo')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Access-Control-Expose-Headers', 'Content-Disposition')
  async archivo(@Param('id', ParseIntPipe) id: number, @Param('tipo') tipo: string): Promise<StreamableFile> {
    await this.esquema.exigir('emision');
    return descargaDeEnvio(this.emision, id, tipo);
  }

  @Post('envios/:id/reintentar')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async reintentar(@Param('id', ParseIntPipe) id: number) {
    await this.esquema.exigir('emision');
    return this.emision.reintentar(id);
  }

  @Post('envios/:id/recuperar-cdr')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async recuperarCdr(@Param('id', ParseIntPipe) id: number) {
    await this.esquema.exigir('emision');
    return this.emision.recuperarCdr(id);
  }

  @Post('envios/:id/confirmar-aceptado')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async confirmarAceptado(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConfirmarAceptadoDto,
    @UsuarioActual() usuario: UsuarioToken | undefined,
  ) {
    await this.esquema.exigir('emision', 'auditoria');
    if (!usuario?.id_usuario) {
      throw new FiscalConfigError('FISCAL_CONFIG_INVALIDA', 'No se pudo identificar al usuario que confirma: vuelva a iniciar sesión.');
    }
    return this.emision.confirmarAceptadoManual(id, usuario.id_usuario, dto.nota);
  }

  /** Limpia el interruptor del ambiente vigente (después de corregir la causa que indicó SUNAT). */
  @Post('emision/reanudar')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  reanudar(@UsuarioActual() usuario: UsuarioToken | undefined, @Req() req: Request) {
    return this.interruptor.reanudar(actorDe(usuario, req));
  }

  /** getStatusCdr de un comprobante inexistente con el usuario SOL de producción: no emite ni numera nada. */
  @Post('probar-credenciales-produccion')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  probarCredencialesProduccion(@UsuarioActual() usuario: UsuarioToken | undefined, @Req() req: Request) {
    return this.emision.probarCredencialesProduccion(actorDe(usuario, req));
  }
}
