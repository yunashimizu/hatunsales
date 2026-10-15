import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import * as multer from 'multer';
import { JwtGuard } from '../../guards/jwt.guard';
import { Roles } from '../../guards/roles.decorator';
import { RolesGuard } from '../../guards/roles.guard';
import { UsuarioActual } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import type { ArchivoCertificado } from '../certificado/certificado-fiscal.service';
import { TAMANO_MAXIMO_CERTIFICADO } from '../certificado/certificado-fiscal.service';
import {
  ActualizarConfigFiscalDto,
  AmbienteConsultaDto,
  AmbienteRequeridoDto,
  AuditoriaConsultaDto,
  CertificadoPublicoConsultaDto,
  CredencialesGreDto,
  CredencialesSolDto,
  GenerarAutofirmadoDto,
  ProbarConexionDto,
  SubirCertificadoDto,
} from '../config/fiscal-config.dto';
import type { ActorFiscal } from '../config/fiscal-config.tipos';
import { ErroresFiscalesInterceptor } from './errores-fiscales.interceptor';
import { FiscalAdminBussnies } from './fiscal-admin.bussnies';

/** El .pfx se lee en memoria (nunca toca el disco) con límites estrictos. */
const OPCIONES_SUBIDA_CERTIFICADO = {
  storage: multer.memoryStorage(),
  limits: { fileSize: TAMANO_MAXIMO_CERTIFICADO, files: 1, fields: 6, fieldSize: 2048, parts: 8 },
};

function actorDe(usuario: UsuarioToken | undefined, req: Request): ActorFiscal {
  return {
    id_usuario: usuario?.id_usuario ?? null,
    nombre: usuario?.nombre ?? null,
    ip: (req.ip ?? req.socket?.remoteAddress ?? null) || null,
  };
}

/**
 * Administración de la facturación electrónica directa con SUNAT
 * (configuración, certificado digital, credenciales SOL y de la API de GRE,
 * prueba de conexión, estado y bitácora). Solo admin, salvo GET /fiscal/estado.
 */
@Controller('fiscal')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
@UseInterceptors(ErroresFiscalesInterceptor)
export class FiscalAdminController {
  constructor(private readonly fiscal: FiscalAdminBussnies) {}

  @Get('configuracion')
  @Header('Cache-Control', 'no-store')
  obtenerConfiguracion() {
    return this.fiscal.obtenerConfiguracion();
  }

  @Put('configuracion')
  @Header('Cache-Control', 'no-store')
  actualizarConfiguracion(
    @Body() dto: ActualizarConfigFiscalDto,
    @UsuarioActual() usuario: UsuarioToken | undefined,
    @Req() req: Request,
  ) {
    return this.fiscal.actualizarConfiguracion(dto, actorDe(usuario, req));
  }

  /** Sin ambiente: { beta, produccion }. Con ambiente: ese certificado o 404. */
  @Get('certificado')
  @Header('Cache-Control', 'no-store')
  certificados(@Query() consulta: AmbienteConsultaDto) {
    return consulta.ambiente ? this.fiscal.certificado(consulta.ambiente) : this.fiscal.certificados();
  }

  /** multipart/form-data: archivo (.pfx/.p12, ≤ 200 KB), clave, ambiente?, forzar?. */
  @Post('certificado')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(FileInterceptor('archivo', OPCIONES_SUBIDA_CERTIFICADO))
  subirCertificado(
    @UploadedFile() archivo: ArchivoCertificado | undefined,
    @Body() dto: SubirCertificadoDto,
    @UsuarioActual() usuario: UsuarioToken | undefined,
    @Req() req: Request,
  ) {
    return this.fiscal.subirCertificado(archivo, dto, actorDe(usuario, req));
  }

  @Delete('certificado')
  eliminarCertificado(
    @Query() consulta: AmbienteRequeridoDto,
    @UsuarioActual() usuario: UsuarioToken | undefined,
    @Req() req: Request,
  ) {
    return this.fiscal.eliminarCertificado(consulta.ambiente, actorDe(usuario, req));
  }

  /** Parte pública (.cer) para registrarla en SOL › «Actualización de certificado digital». */
  @Get('certificado/publico')
  async descargarCertificadoPublico(@Query() consulta: CertificadoPublicoConsultaDto): Promise<StreamableFile> {
    const archivo = await this.fiscal.descargarCertificadoPublico(consulta.ambiente, consulta.formato);
    return new StreamableFile(archivo.contenido, {
      type: archivo.mime,
      disposition: `attachment; filename="${archivo.nombreArchivo}"`,
      length: archivo.contenido.length,
    });
  }

  /** Solo con ambiente BETA (409 FISCAL_SOLO_BETA si no). */
  @Post('certificado/autofirmado')
  @HttpCode(HttpStatus.CREATED)
  generarCertificadoAutofirmado(
    @Body() dto: GenerarAutofirmadoDto,
    @UsuarioActual() usuario: UsuarioToken | undefined,
    @Req() req: Request,
  ) {
    return this.fiscal.generarCertificadoAutofirmado(dto, actorDe(usuario, req));
  }

  @Post('credenciales/sol')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  guardarCredencialesSol(
    @Body() dto: CredencialesSolDto,
    @UsuarioActual() usuario: UsuarioToken | undefined,
    @Req() req: Request,
  ) {
    return this.fiscal.guardarCredencialesSol(dto, actorDe(usuario, req));
  }

  @Delete('credenciales/sol')
  eliminarCredencialesSol(@UsuarioActual() usuario: UsuarioToken | undefined, @Req() req: Request) {
    return this.fiscal.eliminarCredencialesSol(actorDe(usuario, req));
  }

  /** client_id y client_secret de SOL › «Credenciales de API SUNAT» (GRE remitente). */
  @Post('credenciales/gre')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  guardarCredencialesGre(
    @Body() dto: CredencialesGreDto,
    @UsuarioActual() usuario: UsuarioToken | undefined,
    @Req() req: Request,
  ) {
    return this.fiscal.guardarCredencialesGre(dto, actorDe(usuario, req));
  }

  @Delete('credenciales/gre')
  eliminarCredencialesGre(@UsuarioActual() usuario: UsuarioToken | undefined, @Req() req: Request) {
    return this.fiscal.eliminarCredencialesGre(actorDe(usuario, req));
  }

  @Post('probar-conexion')
  @HttpCode(HttpStatus.OK)
  probarConexion(
    @Body() dto: ProbarConexionDto,
    @UsuarioActual() usuario: UsuarioToken | undefined,
    @Req() req: Request,
  ) {
    return this.fiscal.probarConexion(dto, actorDe(usuario, req));
  }

  /** Semáforo para el panel y el POS (sin secretos). */
  @Get('estado')
  @Roles('admin', 'vendedor', 'caja', 'consulta')
  estado() {
    return this.fiscal.estado();
  }

  @Get('auditoria')
  @Header('Cache-Control', 'no-store')
  auditoria(@Query() consulta: AuditoriaConsultaDto) {
    return this.fiscal.auditoria(consulta);
  }
}
