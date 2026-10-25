import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { NotaCreditoBussnies } from '../../bussnies/Bussnies/nota-credito.bussnies';
import { EmitirNotaCreditoRequest } from '../../models/model/c-electronico/nota-credito.request';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';
import { UsuarioActual } from '../../guards/usuario-actual.decorator';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';

/**
 * Nota de crédito sobre una factura o boleta aceptada (PLAN V3, D8). Comparte el prefijo /comprobante
 * con ComprobanteController: sus rutas (:id/nota-credito/…) tienen más segmentos que :id, :id/detalle o
 * :id/pdf, así que ninguna de esas las tapa aunque ese controlador se registre antes.
 */
@Controller('comprobante')
@UseGuards(JwtGuard, RolesGuard)
export class NotaCreditoController {

  constructor(private readonly notas: NotaCreditoBussnies) {}

  /** Lo que el asistente necesita: motivos admitidos, saldo, ítems disponibles, notas previas y avisos. */
  @Get(':id/nota-credito/contexto')
  @Roles('admin', 'vendedor', 'caja')
  contexto(@Param('id', ParseIntPipe) id: number) {
    return this.notas.contexto(id);
  }

  /**
   * Emite la nota y la envía a SUNAT en el acto: 200 con el resultado (estado 'emitido' | 'pendiente' |
   * 'error' si SUNAT la rechazó). Stock y deuda se mueven recién cuando SUNAT la acepta. 409 si otra nota
   * del comprobante está en curso; 503 si la emisión no está activa (sin reservar número).
   */
  @Post(':id/nota-credito')
  @Roles('admin', 'vendedor')
  @HttpCode(200)
  emitir(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: EmitirNotaCreditoRequest,
    @UsuarioActual() usuario: UsuarioToken,
  ) {
    return this.notas.emitir(id, body, usuario?.id_usuario ?? null);
  }
}
