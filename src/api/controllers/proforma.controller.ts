import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Logger,
  Param,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ProformaBussnies } from '../../bussnies/Bussnies/proforma.bussnies';
import {
  CrearProformaRequest,
  EnviarCotizacionWaRequest,
  MarcarProformaRequest,
} from '../../models/model/proforma.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { CodigoError, cuerpoError } from '../../util/errores-operativos';

const TIPO_PDF = 'application/pdf';
const TIPO_EXCEL = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@Controller('proforma')
@UseGuards(JwtGuard, RolesGuard)
export class ProformaController {

  private readonly log = new Logger(ProformaController.name);

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

  // Las rutas con sufijo van ANTES de @Get(':id') para que Nest no las tome
  // como un id.
  @Get(':id/pdf')
  @Roles('admin', 'vendedor', 'caja')
  async pdf(@Param('id') id: string, @Res() res: Response) {
    try {
      const { buffer, nombreArchivo } = await this.service.generarPdf(this.idValido(id));
      return this.responderArchivo(res, buffer, nombreArchivo, TIPO_PDF);
    } catch (error) {
      return this.responderError(res, error, 'No se pudo generar el PDF de la proforma');
    }
  }

  @Get(':id/excel')
  @Roles('admin', 'vendedor', 'caja')
  async excel(@Param('id') id: string, @Res() res: Response) {
    try {
      const { buffer, nombreArchivo } = await this.service.generarExcel(this.idValido(id));
      return this.responderArchivo(res, buffer, nombreArchivo, TIPO_EXCEL);
    } catch (error) {
      return this.responderError(res, error, 'No se pudo generar el Excel de la proforma');
    }
  }

  @Get(':id')
  @Roles('admin', 'vendedor', 'caja')
  getById(@Param('id') id: string) {
    return this.service.getById(this.idValido(id));
  }

  @Post()
  @Roles('admin', 'vendedor', 'caja')
  create(@Body() body: CrearProformaRequest) {
    return this.service.create(body);
  }

  @Put(':id')
  @Roles('admin', 'vendedor', 'caja')
  marcar(@Param('id') id: string, @Body() body: MarcarProformaRequest) {
    return this.service.marcar(this.idValido(id), body);
  }

  @Post('whatsapp/enviar')
  @Roles('admin', 'vendedor', 'caja')
  enviarWa(@Body() body: EnviarCotizacionWaRequest) {
    return this.service.enviarPorWhatsapp(body);
  }

  /** El id de la ruta debe ser un entero positivo. */
  private idValido(valor: string): number {
    const id = Number(valor);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestException(
        cuerpoError(
          CodigoError.COTIZACION_NO_ENCONTRADA,
          `"${valor}" no es un número de cotización válido`,
        ),
      );
    }
    return id;
  }

  private responderArchivo(res: Response, buffer: Buffer, nombreArchivo: string, tipo: string) {
    res.setHeader('Content-Type', tipo);
    res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
    res.setHeader('Content-Length', String(buffer.length));
    // El nombre viaja en la cabecera aunque el navegador no la vea por CORS.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buffer);
  }

  /**
   * En las rutas con @Res los filtros de Nest no se aplican: el error se
   * escribe aquí como JSON {codigo, message} con su propio estado, que es lo
   * que el front lee con normalizarErrorBlob().
   */
  private responderError(res: Response, error: unknown, respaldo: string) {
    if (error instanceof HttpException) {
      const estado = error.getStatus();
      const cuerpo = error.getResponse();
      return res
        .status(estado)
        .json(typeof cuerpo === 'string' ? { message: cuerpo } : cuerpo);
    }
    this.log.error(
      `${respaldo}: ${(error as any)?.message ?? error}`,
      (error as any)?.stack,
    );
    return res
      .status(500)
      .json(cuerpoError(CodigoError.COTIZACION_DOCUMENTO_ERROR, respaldo));
  }
}
