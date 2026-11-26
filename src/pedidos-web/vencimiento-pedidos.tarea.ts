import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { PedidoRepository } from '../repository/Repository/tienda/pedido.repository';
import { PedidoBussnies } from '../bussnies/Bussnies/tienda/pedido.bussnies';
import { ControlStockService } from '../stock/control-stock.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { ACCIONES_BITACORA } from '../bitacora/bitacora.acciones';

/**
 * Tarea programada (Fase 8.2, D5): vence los pedidos web que siguen pendientes de pago después de
 * `pedido_vencimiento_horas_pasarela` / `pedido_vencimiento_horas_transferencia` (configuraciones; 0 = apagado,
 * que es el valor por defecto; sugerido 24 y 48). Libera su stock reservado y devuelve el uso del cupón.
 *
 * Mismo patrón que CierreAutomaticoTarea: un temporizador por proceso y, con varias réplicas, solo una busca
 * en cada vuelta (pg_try_advisory_xact_lock en PedidoRepository.pedidosVencidos). Aunque dos réplicas tomaran el
 * mismo pedido, la cancelación es el UPDATE condicional de siempre (PedidoBussnies.vencer → cancelarEnTx): solo
 * una lo cancela y devuelve; la otra recibe null y no toca nada.
 * PEDIDOS_VENCIMIENTO_INTERVALO_MIN (minutos, por defecto 15; 0 apaga el temporizador por completo).
 */
const MINUTOS_POR_DEFECTO = 15;
const RETRASO_INICIAL_MS = 150_000;
/** Pedidos que se vencen como máximo en una vuelta (los demás, en la siguiente). */
const POR_VUELTA = 50;

export function intervaloVencimientoPedidosMs(valor = process.env.PEDIDOS_VENCIMIENTO_INTERVALO_MIN): number {
  if (valor === undefined || valor.trim() === '') return MINUTOS_POR_DEFECTO * 60_000;
  const minutos = Number(valor);
  if (!Number.isFinite(minutos) || minutos <= 0) return 0;
  return Math.max(5, Math.min(minutos, 24 * 60)) * 60_000;
}

@Injectable()
export class VencimientoPedidosTarea implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(VencimientoPedidosTarea.name);
  private temporizador: NodeJS.Timeout | null = null;
  private primera: NodeJS.Timeout | null = null;
  private enCurso = false;

  constructor(
    private readonly repo: PedidoRepository,
    private readonly pedidos: PedidoBussnies,
    private readonly control: ControlStockService,
    @Optional() private readonly bitacora?: BitacoraService,
  ) {}

  onApplicationBootstrap(): void {
    const cada = intervaloVencimientoPedidosMs();
    if (!cada) {
      this.log.log('Tarea de vencimiento de pedidos web desactivada (PEDIDOS_VENCIMIENTO_INTERVALO_MIN=0).');
      return;
    }
    this.primera = setTimeout(() => void this.ejecutar(), RETRASO_INICIAL_MS);
    this.primera.unref?.();
    this.temporizador = setInterval(() => void this.ejecutar(), cada);
    this.temporizador.unref?.();
  }

  onModuleDestroy(): void {
    if (this.primera) clearTimeout(this.primera);
    if (this.temporizador) clearInterval(this.temporizador);
    this.primera = null;
    this.temporizador = null;
  }

  /** Una vuelta: devuelve cuántos pedidos venció (0 con las claves en 0, sin vencidos o si otra réplica la tomó). */
  async ejecutar(): Promise<number> {
    if (this.enCurso) return 0;
    this.enCurso = true;
    try {
      const horas = await this.control.horasVencimiento();
      if (!(horas.pasarela > 0) && !(horas.transferencia > 0)) return 0;
      const candidatos = await this.repo.pedidosVencidos(horas, POR_VUELTA);
      let vencidos = 0;
      for (const candidato of candidatos) {
        try {
          const resultado = await this.pedidos.vencer(candidato.id_pedido, candidato.horas);
          if (!resultado) continue; // Lo pagaron, lo cancelaron o lo venció otra réplica entre medias.
          vencidos += 1;
          // Después del COMMIT de la cancelación; nunca la deshace.
          await this.bitacora?.registrarCon(() => ({
            accion: ACCIONES_BITACORA.PEDIDO_VENCIDO,
            entidad: 'pedido',
            id_entidad: candidato.id_pedido,
            despues: {
              horas: candidato.horas,
              clase: candidato.clase,
              stock_devuelto: resultado.stock_devuelto,
              cupon_devuelto: resultado.cupon_devuelto,
              id_cupon: resultado.id_cupon,
            },
            motivo: `Sin pago en ${candidato.horas} h`,
          }));
        } catch (error: any) {
          // Un pedido que falla no frena a los demás; se reintenta en la próxima vuelta.
          this.log.warn(`No se pudo vencer el pedido ${candidato.id_pedido}: ${error?.message ?? error}`);
        }
      }
      if (vencidos > 0) this.log.log(`${vencidos} pedido(s) web vencidos sin pago (stock y cupón devueltos).`);
      return vencidos;
    } catch (error: any) {
      this.log.warn(`No se pudo revisar los pedidos web sin pagar: ${error?.message ?? error}`);
      return 0;
    } finally {
      this.enCurso = false;
    }
  }
}
