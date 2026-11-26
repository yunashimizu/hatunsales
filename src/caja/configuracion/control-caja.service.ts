import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { BitacoraService } from '../../bitacora/bitacora.service';
import { ACCIONES_BITACORA } from '../../bitacora/bitacora.acciones';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import {
  CambioControlCaja,
  CLAVES_CONTROL_CAJA,
  ConfigControlCaja,
  CONTROL_CAJA_POR_DEFECTO,
  configControlCajaDesdeValores,
  validarCambioControlCaja,
} from './control-caja';

/**
 * Configuración de la Fase 7 (claves en `configuraciones`, caché de 60 s de ConfiguracionRepository).
 *
 * Las lecturas para la operación (`arqueoCiego`, `horasCierreAutomatico`, `modoAnulacionCredito`) NUNCA
 * lanzan: ante un fallo devuelven el valor por defecto, que es el comportamiento de antes de la Fase 7
 * (y para 7.2, `bloquear`, que es la regla que nace encendida).
 */
@Injectable()
export class ControlCajaService {
  private readonly log = new Logger(ControlCajaService.name);

  constructor(
    private readonly config: ConfiguracionRepository,
    @Optional() private readonly bitacora?: BitacoraService,
  ) {}

  /** Configuración vigente. Puede lanzar: es para la pantalla del admin. */
  async configuracion(): Promise<ConfigControlCaja> {
    const valores = await this.config.obtenerVarias([
      CLAVES_CONTROL_CAJA.anulacionCreditoConAbonos,
      CLAVES_CONTROL_CAJA.arqueoCiego,
      CLAVES_CONTROL_CAJA.cierreAutomaticoHoras,
      CLAVES_CONTROL_CAJA.creditoBloqueoMoraDias,
    ]);
    return configControlCajaDesdeValores(valores);
  }

  /** Nunca lanza: ante un fallo, los valores por defecto. */
  async vigente(): Promise<ConfigControlCaja> {
    try {
      return await this.configuracion();
    } catch (error) {
      this.log.warn(`No se pudo leer la configuración de caja; se usan los valores por defecto: ${(error as Error)?.message ?? error}`);
      return { ...CONTROL_CAJA_POR_DEFECTO };
    }
  }

  async arqueoCiego(): Promise<boolean> {
    return (await this.vigente()).arqueo_ciego;
  }

  async horasCierreAutomatico(): Promise<number> {
    return (await this.vigente()).caja_cierre_automatico_horas;
  }

  /** 9.4: días de gracia del bloqueo por mora (0 = apagado). Nunca lanza. */
  async diasBloqueoMora(): Promise<number> {
    return (await this.vigente()).credito_bloqueo_mora_dias;
  }

  async modoAnulacionCredito(): Promise<ConfigControlCaja['anulacion_credito_con_abonos']> {
    return (await this.vigente()).anulacion_credito_con_abonos;
  }

  /** Guarda solo lo que cambió y lo anota en la bitácora (`configuracion.control_caja`). */
  async guardar(cambio: CambioControlCaja, usuario?: UsuarioToken): Promise<ConfigControlCaja> {
    let nuevo: Partial<ConfigControlCaja>;
    try {
      nuevo = validarCambioControlCaja(cambio ?? {});
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const antes = await this.configuracion();
    const despues: ConfigControlCaja = { ...antes, ...nuevo };

    if (despues.anulacion_credito_con_abonos !== antes.anulacion_credito_con_abonos) {
      await this.config.guardar(CLAVES_CONTROL_CAJA.anulacionCreditoConAbonos, despues.anulacion_credito_con_abonos);
    }
    if (despues.arqueo_ciego !== antes.arqueo_ciego) {
      await this.config.guardar(CLAVES_CONTROL_CAJA.arqueoCiego, despues.arqueo_ciego ? 'true' : 'false');
    }
    if (despues.caja_cierre_automatico_horas !== antes.caja_cierre_automatico_horas) {
      await this.config.guardar(CLAVES_CONTROL_CAJA.cierreAutomaticoHoras, String(despues.caja_cierre_automatico_horas));
    }
    if (despues.credito_bloqueo_mora_dias !== antes.credito_bloqueo_mora_dias) {
      await this.config.guardar(CLAVES_CONTROL_CAJA.creditoBloqueoMoraDias, String(despues.credito_bloqueo_mora_dias));
    }

    const cambio_hecho =
      despues.anulacion_credito_con_abonos !== antes.anulacion_credito_con_abonos ||
      despues.arqueo_ciego !== antes.arqueo_ciego ||
      despues.caja_cierre_automatico_horas !== antes.caja_cierre_automatico_horas ||
      despues.credito_bloqueo_mora_dias !== antes.credito_bloqueo_mora_dias;
    if (cambio_hecho) {
      await this.bitacora?.registrarCon(() => ({
        accion: ACCIONES_BITACORA.CONFIGURACION_CONTROL_CAJA,
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
