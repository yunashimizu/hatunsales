import { Controller, Get, Header, HttpStatus, Res } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { SaludBussnies } from '../../bussnies/Bussnies/salud.bussnies';
import { SaludResponse } from '../../models/model/salud.response';

/**
 * GET /salud, sin autenticación ni límite de peticiones: 200 si la BD responde
 * `SELECT 1` en menos de 3 s, 503 si no. Pensado para un monitor externo (cada
 * 1-5 min). El healthcheck de Railway sigue en "/" (railway.json).
 */
@ApiTags('Salud')
@Controller('salud')
export class SaludController {
  constructor(private readonly saludBussnies: SaludBussnies) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: SaludResponse })
  @ApiServiceUnavailableResponse({ type: SaludResponse, description: 'La base de datos no respondió' })
  async estado(@Res({ passthrough: true }) res: Response): Promise<SaludResponse> {
    const salud = await this.saludBussnies.estado();
    res.status(salud.estado === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return salud;
  }
}
