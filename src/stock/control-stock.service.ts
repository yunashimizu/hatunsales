import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfiguracionRepository } from '../repository/Repository/configuracion.repository';
import { BitacoraService } from '../bitacora/bitacora.service';
import { ACCIONES_BITACORA } from '../bitacora/bitacora.acciones';
import type { UsuarioToken } from '../guards/usuario-actual.decorator';
import {
  CambioControlStock,
  CLAVES_CONTROL_STOCK,
  ConfigControlStock,
  CONTROL_STOCK_POR_DEFECTO,
  configControlStockDesdeValores,
  validarCambioControlStock,
} from './control-stock';

/**
 * Configuración de la Fase 8 (claves en `configuraciones`, caché de 60 s de ConfiguracionRepository).
 * Las lecturas para la operación NUNCA lanzan: ante un fallo devuelven el valor por defecto, que es el
 * comportamiento de antes de la Fase 8 (nada vence, la guía repetida solo se informa).
 */
@Injectable()
export class ControlStockService {
  private readonly log = new Logger(ControlStockService.name);

  constructor(
    private readonly config: ConfiguracionRepository,
    @Optional() private readonly bitacora?: BitacoraService,
  ) {}

  /** Configuración vigente. Puede lanzar: es para la pantalla del admin. */
  async configuracion(): Promise<ConfigControlStock> {
    const valores = await this.config.obtenerVarias([
      CLAVES_CONTROL_STOCK.vencimientoPasarela,
      CLAVES_CONTROL_STOCK.vencimientoTransferencia,
      CLAVES_CONTROL_STOCK.guiaRepetida,
    ]);
    return configControlStockDesdeValores(valores);
  }

  /** Nunca lanza: ante un fallo, los valores por defecto. */
  async vigente(): Promise<ConfigControlStock> {
    try {
      return await this.configuracion();
    } catch (error) {
      this.log.warn(`No se pudo leer la configuración de stock; se usan los valores por defecto: ${(error as Error)?.message ?? error}`);
      return { ...CONTROL_STOCK_POR_DEFECTO };
    }
  }

  async horasVencimiento(): Promise<{ pasarela: number; transferencia: number }> {
    const c = await this.vigente();
    return { pasarela: c.pedido_vencimiento_horas_pasarela, transferencia: c.pedido_vencimiento_horas_transferencia };
  }

  async modoGuiaRepetida(): Promise<ConfigControlStock['recepcion_guia_repetida']> {
    return (await this.vigente()).recepcion_guia_repetida;
  }

  /** Guarda solo lo que cambió y lo anota en la bitácora (`configuracion.control_stock`). */
  async guardar(cambio: CambioControlStock, usuario?: UsuarioToken): Promise<ConfigControlStock> {
    let nuevo: Partial<ConfigControlStock>;
    try {
      nuevo = validarCambioControlStock(cambio ?? {});
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const antes = await this.configuracion();
    const despues: ConfigControlStock = { ...antes, ...nuevo };

    const cambios: [keyof ConfigControlStock, string][] = [
      ['pedido_vencimiento_horas_pasarela', CLAVES_CONTROL_STOCK.vencimientoPasarela],
      ['pedido_vencimiento_horas_transferencia', CLAVES_CONTROL_STOCK.vencimientoTransferencia],
      ['recepcion_guia_repetida', CLAVES_CONTROL_STOCK.guiaRepetida],
    ];
    let hubo = false;
    for (const [campo, clave] of cambios) {
      if (despues[campo] === antes[campo]) continue;
      await this.config.guardar(clave, String(despues[campo]));
      hubo = true;
    }
    if (hubo) {
      await this.bitacora?.registrarCon(() => ({
        accion: ACCIONES_BITACORA.CONFIGURACION_CONTROL_STOCK,
        id_usuario: usuario?.id_usuario ?? null,
        rol: usuario?.rol ?? null,
        entidad: 'configuracion',
        antes: { ...antes },
        despues: { ...despues },
      }));
    }
    return despues;
  }
}
