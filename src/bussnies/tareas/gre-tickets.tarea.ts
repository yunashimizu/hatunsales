import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { FiscalConfigService } from '../../sunat/config/fiscal-config.service';
import { EmisionGre } from '../../sunat/gre/gre.contrato';
import { GuiaRemisionBussnies } from '../Bussnies/guia-remision.bussnies';

/** Primera vuelta: entre 60 y 120 s después de arrancar (el azar separa a las réplicas). */
const RETRASO_INICIAL_MS = 60_000;
const DISPERSION_INICIAL_MS = 60_000;

/**
 * Consulta sola los tickets de las GRE enviadas a SUNAT (PLAN V3, D11). Cada 30 s mira si a alguna le toca
 * su turno según la espera creciente que fija el negocio (30 s, 1, 2, 5 y luego 15 min; tras el tope de
 * consultas la deja para revisión manual) y consulta hasta 10 por vuelta.
 *
 * Solo corre con fiscal_tareas_activas, la GRE activada en producción y EmisionGre.modo() activo. Varias
 * réplicas: cada envío se reclama por separado (FOR UPDATE SKIP LOCKED + plazo de 60 s en bloqueado_hasta),
 * así dos instancias nunca consultan el mismo; no se usan candados de sesión. La configuración se lee del
 * caché y el modo (credenciales y certificado) solo cuando hay tickets por consultar.
 */
@Injectable()
export class GreTicketsTarea implements OnApplicationBootstrap, OnModuleDestroy {
  static readonly INTERVALO_MS = 30_000;
  static readonly GUIAS_POR_VUELTA = 10;

  private readonly log = new Logger(GreTicketsTarea.name);
  private temporizador: NodeJS.Timeout | null = null;
  private primera: NodeJS.Timeout | null = null;
  private enCurso = false;

  constructor(
    private readonly config: FiscalConfigService,
    private readonly emisionGre: EmisionGre,
    private readonly guias: GuiaRemisionBussnies,
  ) {}

  onApplicationBootstrap(): void {
    const retraso = RETRASO_INICIAL_MS + Math.floor(Math.random() * DISPERSION_INICIAL_MS);
    this.primera = setTimeout(() => void this.ejecutar(), retraso);
    this.primera.unref?.();
    this.temporizador = setInterval(() => void this.ejecutar(), GreTicketsTarea.INTERVALO_MS);
    this.temporizador.unref?.();
  }

  onModuleDestroy(): void {
    if (this.primera) clearTimeout(this.primera);
    if (this.temporizador) clearInterval(this.temporizador);
    this.primera = null;
    this.temporizador = null;
  }

  /** Una vuelta: devuelve cuántos tickets consultó (0 si no le tocaba o si otra réplica los tomó). */
  async ejecutar(): Promise<number> {
    if (this.enCurso) return 0;
    this.enCurso = true;
    try {
      if (!(await this.config.tareasActivas()) || !(await this.config.greActiva())) return 0;
      const candidatos = await this.guias.candidatosConsulta(GreTicketsTarea.GUIAS_POR_VUELTA);
      if (!candidatos.length) return 0;
      const modo = await this.emisionGre.modo();
      if (!modo.activo) return 0;

      let consultados = 0;
      for (const idEnvio of candidatos) {
        try {
          // null: otra réplica (o una consulta manual) lo tomó primero, o ya cambió de estado.
          if (await this.guias.consultarEnvio(idEnvio)) consultados += 1;
        } catch (error) {
          this.log.warn(`No se pudo consultar el ticket del envío ${idEnvio}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (consultados > 0) this.log.log(`${consultados} ticket(s) de guías de remisión consultados en SUNAT.`);
      return consultados;
    } catch (error) {
      this.log.warn(`La tarea de tickets de guías no pudo completar la vuelta: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    } finally {
      this.enCurso = false;
    }
  }
}
