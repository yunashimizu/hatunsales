import { Body, Controller, Get, Header, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { MejoraFotosService } from '../../fotos/mejora-fotos.service';
import { ReprocesadoFotosService } from '../../fotos/reprocesado-fotos.service';
import {
  ConfigurarFotosRequest, DeshacerFotosRequest, MejorarFotosRequest, RevisarFotosRequest,
} from '../../models/model/fotos-mejora.request';

/**
 * Fotos ya subidas: revisión y tandas (doc/PLAN_MEJORA_AUTOMATICA_DE_FOTOS.md §7.2, tanda B3).
 * Solo administrador. Nada se ejecuta sin una de estas peticiones.
 */
@Controller('fotos-mejora')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
export class FotosMejoraController {
  constructor(
    private readonly fotos: ReprocesadoFotosService,
    private readonly mejora: MejoraFotosService,
  ) {}

  /** Cuántas fotos hay en cada estado y cómo va la pasada en curso. */
  @Get('estado')
  @Header('Cache-Control', 'no-store')
  estado() {
    return this.fotos.estado();
  }

  /** «Revisar sin cambiar nada»: arranca y responde enseguida. */
  @Post('diagnostico')
  @HttpCode(202)
  revisar(@Body() cuerpo: RevisarFotosRequest) {
    return this.fotos.iniciarRevision(cuerpo?.limite);
  }

  /** Avance y resultado de la última revisión (en memoria). */
  @Get('diagnostico')
  @Header('Cache-Control', 'no-store')
  verRevision() {
    return this.fotos.verRevision();
  }

  /** Mejora una tanda de las fotos que faltan. Necesita sql/fase23. */
  @Post('reprocesar')
  @HttpCode(202)
  mejorar(@Body() cuerpo: MejorarFotosRequest) {
    return this.fotos.iniciarMejora(cuerpo?.limite, cuerpo?.id_producto);
  }

  /** Vuelve las mejoradas a la original. No borra archivos. */
  @Post('deshacer')
  @HttpCode(200)
  deshacer(@Body() cuerpo: DeshacerFotosRequest) {
    return this.fotos.deshacer(cuerpo?.id_producto);
  }

  /** El interruptor «Mejorar automáticamente lo que se suba». */
  @Put('config')
  configurar(@Body() cuerpo: ConfigurarFotosRequest) {
    return this.mejora.fijarInterruptor(cuerpo.activa);
  }

  /** Detiene la pasada en curso (termina la foto que está haciendo). */
  @Post('detener')
  @HttpCode(200)
  detener() {
    return this.fotos.detener();
  }
}
