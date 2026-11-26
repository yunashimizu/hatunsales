import { BadRequestException, Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { BitacoraService } from '../../bitacora/bitacora.service';
import { ACCIONES_BITACORA, ETIQUETA_ACCION_BITACORA } from '../../bitacora/bitacora.acciones';
import { ConsultarBitacoraRequest } from '../../models/model/bitacora.request';

/** Pantalla «Actividad» (Fase 6.3): solo lectura y solo para el administrador. */
@Controller('bitacora')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
export class BitacoraController {
  constructor(private readonly bitacora: BitacoraService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  listar(@Query() consulta: ConsultarBitacoraRequest) {
    if (consulta.desde && consulta.hasta && consulta.desde > consulta.hasta) {
      throw new BadRequestException('La fecha de inicio no puede ser posterior a la fecha de fin');
    }
    return this.bitacora.listar(consulta);
  }

  /** Catálogo de acciones con su nombre legible, para el filtro. */
  @Get('acciones')
  acciones() {
    return Object.values(ACCIONES_BITACORA).map((accion) => ({ accion, etiqueta: ETIQUETA_ACCION_BITACORA[accion] }));
  }
}
