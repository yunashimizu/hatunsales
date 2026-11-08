import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import { correoValido } from '../../correo/correo.config';
import { EnviadorCorreo } from '../../correo/enviador-correo.contrato';
import { ACCIONES_AUDITORIA_FISCAL, FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import { FiscalConfigService } from '../config/fiscal-config.service';
import { RelojFiscal } from '../config/reloj-fiscal';
import { EnvioFiscalRepository } from '../emision/envio-fiscal.repository';
import { AlertasFiscalesRepository } from './alertas-fiscales.repository';
import { AlertaParaCorreo, armarCorreoAlerta } from './plantilla-alerta-fiscal';

export const CLAVE_ALERTAS_CORREO = 'fiscal_alertas_correo';
/** Se avisa cuando faltan 30, 15, 7 o 1 días (o ya venció). */
export const UMBRALES_VENCIMIENTO_DIAS = [1, 7, 15, 30] as const;
/** Más de esta cantidad de envíos esperando a SUNAT desde hace más de 2 horas = cola atascada. */
export const COLA_ATASCADA_MINIMO = 20;
/** Hora de Lima (HH:mm) desde la que corre el aviso diario. */
export const HORA_ALERTAS_LIMA = '08:00';

export interface ResultadoAlertas {
  /** Situaciones que existen hoy. */
  detectadas: string[];
  /** Tipos enviados en este correo. */
  enviadas: string[];
  /** Ya avisadas hoy. */
  repetidas: string[];
  destinatario: string | null;
  motivo?: string;
}

export interface EstadoAlertasFiscales {
  /** Lo que se guardó en `fiscal_alertas_correo` (null = ninguno). */
  correo: string | null;
  /** A dónde llegan los avisos ahora: el guardado o el del emisor. */
  correo_efectivo: string | null;
  /** 'configurado' | 'emisor' | 'ninguno' */
  origen: 'configurado' | 'emisor' | 'ninguno';
}

/**
 * Avisos diarios por correo de la facturación electrónica (S7): certificado por vencer (30, 15, 7 y 1 días),
 * envíos que requieren revisión, lotes por liberar, comprobantes cuyo plazo vence hoy y cola atascada.
 * Un solo correo por vuelta, deduplicado por día y por tipo con la bitácora fiscal (FISCAL_ALERTA_ENVIADA).
 */
@Injectable()
export class AlertasFiscalesService {
  private readonly log = new Logger(AlertasFiscalesService.name);

  constructor(
    private readonly config: FiscalConfigService,
    private readonly certificados: CertificadoFiscalService,
    private readonly envios: EnvioFiscalRepository,
    private readonly repositorio: AlertasFiscalesRepository,
    private readonly auditoria: FiscalAuditoriaRepository,
    private readonly enviador: EnviadorCorreo,
    private readonly configuracion: ConfiguracionRepository,
    private readonly reloj: RelojFiscal,
  ) {}

  /** Qué situaciones existen ahora (sin enviar nada). */
  async detectar(): Promise<AlertaParaCorreo[]> {
    const snapshot = await this.config.snapshot();
    // Con otro proveedor (o sin emisión directa) no hay nada que vigilar.
    if ((await this.config.proveedorActivo()) !== 'sunat_directo') return [];
    const alertas: AlertaParaCorreo[] = [];

    const infos = await this.certificados.infoTodos();
    const cert = snapshot.ambiente === 'produccion' ? infos.produccion : (infos.beta ?? infos.produccion);
    if (cert) {
      const dias = cert.dias_para_vencer;
      const donde = cert.ambiente === 'produccion' ? 'de producción' : 'de pruebas (BETA)';
      if (cert.vencido || dias < 0) {
        alertas.push({
          tipo: 'certificado_vencido',
          titulo: `El certificado digital ${donde} está vencido`,
          detalle: 'Sin certificado vigente no se puede emitir. Renuévelo en SOL y súbalo en Facturación SUNAT › Certificado.',
          ruta: '/dashboard/facturacion-sunat',
        });
      } else {
        const umbral = UMBRALES_VENCIMIENTO_DIAS.find((u) => dias <= u);
        if (umbral !== undefined) {
          alertas.push({
            tipo: `certificado_${umbral}`,
            titulo: `El certificado digital ${donde} vence en ${dias === 0 ? 'menos de un día' : dias === 1 ? '1 día' : `${dias} días`}`,
            detalle: 'Renuévelo en SOL y súbalo en Facturación SUNAT › Certificado antes de que venza, o dejará de poder emitir.',
            ruta: '/dashboard/facturacion-sunat',
          });
        }
      }
    }

    const [contadores, plazos] = await Promise.all([
      this.repositorio.contadores(snapshot.ambiente),
      this.envios.contadores(snapshot.ambiente, this.reloj.fechaLima()),
    ]);
    if (contadores.excepcion > 0) {
      alertas.push({
        tipo: 'envios_revision',
        titulo: `${contadores.excepcion} comprobante(s) requieren revisión`,
        detalle: 'SUNAT no los recibió tras varios intentos. Abra Envíos a SUNAT y reintente, recupere la constancia o emita uno nuevo.',
        ruta: '/dashboard/facturacion-sunat',
      });
    }
    if (contadores.lotes_por_liberar > 0) {
      alertas.push({
        tipo: 'lotes_liberar',
        titulo: `${contadores.lotes_por_liberar} resumen(es) o baja(s) sin respuesta de SUNAT`,
        detalle: 'Llevan más de 7 días sin respuesta. Revíselos en Lotes y use «Liberar» para volver a intentarlo.',
        ruta: '/dashboard/facturacion-sunat',
      });
    }
    if (plazos.vencen_hoy > 0) {
      alertas.push({
        tipo: 'plazo_vence_hoy',
        titulo: `${plazos.vencen_hoy} comprobante(s) vencen hoy su plazo de envío a SUNAT`,
        detalle: 'Si hoy no llegan a SUNAT, después solo se pueden corregir con nota de crédito. Revíselos en Documentos.',
        ruta: '/dashboard/mantenimiento/doc',
      });
    }
    if (contadores.pendientes_antiguos > COLA_ATASCADA_MINIMO) {
      alertas.push({
        tipo: 'cola_atascada',
        titulo: `${contadores.pendientes_antiguos} comprobantes esperan a SUNAT hace más de 2 horas`,
        detalle: 'Puede ser una caída de SUNAT o un problema de conexión. El sistema sigue intentando; revise Envíos a SUNAT.',
        ruta: '/dashboard/facturacion-sunat',
      });
    }
    return alertas;
  }

  /** Detecta, descarta lo ya avisado hoy y manda UN correo con el resto. Nunca lanza por la bitácora. */
  async enviarDelDia(): Promise<ResultadoAlertas> {
    const hoy = this.reloj.fechaLima();
    const alertas = await this.detectar();
    const resultado: ResultadoAlertas = {
      detectadas: alertas.map((a) => a.tipo),
      enviadas: [],
      repetidas: [],
      destinatario: null,
    };
    if (!alertas.length) return resultado;

    const nuevas: AlertaParaCorreo[] = [];
    for (const alerta of alertas) {
      if (await this.auditoria.existeHoy(ACCIONES_AUDITORIA_FISCAL.ALERTA_ENVIADA, 'tipo', alerta.tipo, hoy)) {
        resultado.repetidas.push(alerta.tipo);
      } else {
        nuevas.push(alerta);
      }
    }
    if (!nuevas.length) return resultado;

    const destino = (await this.estado()).correo_efectivo;
    resultado.destinatario = destino;
    if (!destino) {
      resultado.motivo = 'No hay un correo para los avisos: escríbalo en Facturación SUNAT › Llave y alertas o configure el correo del emisor.';
      this.log.warn(`${nuevas.length} aviso(s) fiscal(es) sin enviar: ${resultado.motivo}`);
      return resultado;
    }

    const correo = armarCorreoAlerta(nuevas, this.urlPanel());
    await this.enviador.enviar({ para: destino, asunto: correo.asunto, html: correo.html, texto: correo.texto, adjuntos: [] });

    for (const alerta of nuevas) {
      resultado.enviadas.push(alerta.tipo);
      try {
        await this.auditoria.registrar({
          accion: ACCIONES_AUDITORIA_FISCAL.ALERTA_ENVIADA,
          entidad: 'alerta',
          id_entidad: alerta.tipo,
          detalle: { tipo: alerta.tipo, titulo: alerta.titulo, para: destino },
        });
      } catch (error: any) {
        this.log.warn(`No se pudo registrar el aviso «${alerta.tipo}» en la bitácora: ${error?.message ?? error}`);
      }
    }
    this.log.log(`Aviso fiscal enviado (${resultado.enviadas.join(', ')}).`);
    return resultado;
  }

  async estado(): Promise<EstadoAlertasFiscales> {
    const guardado = this.normalizar(await this.configuracion.obtener(CLAVE_ALERTAS_CORREO));
    if (guardado) return { correo: guardado, correo_efectivo: guardado, origen: 'configurado' };
    const emisor = this.normalizar((await this.configuracion.obtener('emisor_email')) ?? process.env.EMISOR_EMAIL ?? null);
    return { correo: null, correo_efectivo: emisor, origen: emisor ? 'emisor' : 'ninguno' };
  }

  /** Guarda (o borra con vacío) el correo de los avisos. Devuelve el estado nuevo. */
  async guardarCorreo(correo: string | null | undefined): Promise<EstadoAlertasFiscales> {
    const limpio = (correo ?? '').trim();
    if (limpio && !correoValido(limpio)) {
      throw new BadRequestException('Escriba un correo válido (por ejemplo, contabilidad@suempresa.pe).');
    }
    await this.configuracion.guardar(CLAVE_ALERTAS_CORREO, limpio.toLowerCase());
    return this.estado();
  }

  /** Base del panel: PANEL_URL o el primer origen de CORS_ORIGIN; vacío si no se conoce (el correo va sin enlaces). */
  private urlPanel(): string {
    const crudo = (process.env.PANEL_URL ?? process.env.CORS_ORIGIN ?? '').split(',')[0].trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(crudo) ? crudo : '';
  }

  private normalizar(valor: string | null): string | null {
    const limpio = (valor ?? '').trim();
    return limpio && correoValido(limpio) ? limpio : null;
  }
}
