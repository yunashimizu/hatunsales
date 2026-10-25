import { BadRequestException, Controller, Get, Header, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { JwtGuard } from '../../guards/jwt.guard';
import { Roles } from '../../guards/roles.decorator';
import { RolesGuard } from '../../guards/roles.guard';
import { MAXIMO_RESULTADOS_UBIGEO, MINIMO_CARACTERES_BUSQUEDA_UBIGEO, UbigeoService } from './ubigeo.service';
import type { Ubigeo } from './ubigeo.service';

export class BuscarUbigeoRequest {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'Indique el distrito, la provincia o el código de ubigeo a buscar (parámetro q).' })
  @MinLength(MINIMO_CARACTERES_BUSQUEDA_UBIGEO, {
    message: `Escriba al menos ${MINIMO_CARACTERES_BUSQUEDA_UBIGEO} letras o dígitos para buscar el ubigeo.`,
  })
  @MaxLength(80, { message: 'La búsqueda de ubigeo admite hasta 80 caracteres.' })
  q!: string;
}

/**
 * Catálogo INEI de distritos para los puntos de partida y llegada de la GRE (y cualquier formulario que
 * pida un ubigeo). Es estático: el navegador puede guardarlo una hora.
 */
@Controller('ubigeo')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'vendedor', 'caja')
export class UbigeoController {
  constructor(private readonly ubigeos: UbigeoService) {}

  /** GET /ubigeo?q=lurin → hasta 20 distritos. */
  @Get()
  @Header('Cache-Control', 'private, max-age=3600')
  buscar(@Query() filtro: BuscarUbigeoRequest): Ubigeo[] {
    return this.ubigeos.buscar(filtro.q, MAXIMO_RESULTADOS_UBIGEO);
  }

  @Get(':codigo')
  @Header('Cache-Control', 'private, max-age=3600')
  obtener(@Param('codigo') codigo: string): Ubigeo {
    const limpio = String(codigo ?? '').trim();
    if (!/^\d{6}$/.test(limpio)) {
      throw new BadRequestException({ message: 'El ubigeo debe tener 6 dígitos (código INEI del distrito).', codigo: 'UBIGEO_INVALIDO' });
    }
    const ubigeo = this.ubigeos.obtener(limpio);
    if (!ubigeo) {
      throw new NotFoundException({ message: `El ubigeo ${limpio} no existe en el catálogo de distritos del INEI.`, codigo: 'UBIGEO_NO_ENCONTRADO' });
    }
    return ubigeo;
  }
}
