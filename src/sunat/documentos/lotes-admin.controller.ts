import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  StreamableFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtGuard } from '../../guards/jwt.guard';
import { Roles } from '../../guards/roles.decorator';
import { RolesGuard } from '../../guards/roles.guard';
import { ErroresFiscalesInterceptor } from '../admin/errores-fiscales.interceptor';
import { FiscalConfigError } from '../config/fiscal-errores';
import { FiscalEsquemaService } from '../config/fiscal-esquema.service';
import { descargaDeEnvio } from '../emision/descarga-envio';
import { LotesFiscales } from './lotes.contrato';
import { ListarLotesDto } from './lotes-admin.dto';

/**
 * Bajas (RA) y resúmenes (RC) a SUNAT para el administrador: listado, detalle, reintento (reenvía el mismo
 * ZIP o consulta el ticket) y descargas (XML firmado, ZIP y CDR). La baja se pide desde
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

  @Post('lotes/:id/reintentar')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async reintentar(@Param('id', ParseIntPipe) id: number) {
    await this.esquema.exigir('emision');
    return this.lotes.reintentar(id);
  }
}
