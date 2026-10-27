import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ComprobanteBussnies } from '../bussnies/Bussnies/comprobante.bussnies';
import type { ComprobanteDetalleResponse } from '../models/model/c-electronico/comprobante.response';
import { RepositorioConfigFiscal } from '../sunat/config/config-fiscal.repository';
import { ComprobanteCorreosRepository, CorreoFila, EstadoCorreo } from './comprobante-correos.repository';
import { correoValido, leerConfigCorreo } from './correo.config';
import { AdjuntoCorreo, EnviadorCorreo, ErrorEnvioCorreo } from './enviador-correo.contrato';
import { armarCorreoComprobante } from './plantilla-comprobante-correo';

export const CLAVE_CORREO_ENVIO_ACTIVO = 'correo_envio_activo';
const ESTADOS_ACEPTADOS = ['ACEPTADO', 'ACEPTADO_OBS'];

export type EstadoCorreoDetalle = EstadoCorreo | 'SIN_SOLICITAR';

/** Resumen que el controlador mezcla en el detalle del comprobante. */
export interface ResumenCorreoComprobante {
  estado: EstadoCorreoDetalle;
  destino: string | null;
  enviado_en: string | null;
  ultimo_error: string | null;
  motivo_omision: string | null;
  puede_reenviar: boolean;
}

export type DetalleParaCorreo = Pick<
  ComprobanteDetalleResponse,
  'id_comprobante' | 'enviar_cliente' | 'proveedor_fiscal' | 'estado_sunat' | 'anulado' | 'receptor'
>;

export type ResultadoProceso = 'ENVIADO' | 'PENDIENTE' | 'ERROR' | 'OMITIDO';

/** Cola de correos del comprobante: arma el mensaje, aplica la regla BETA, envía y deja el rastro en comprobante_correos. */
@Injectable()
export class CorreoComprobanteService {
  /** Espera antes del intento siguiente, por número de intento ya hecho (1, 5, 15, 60, 60 min). */
  static readonly ESPERAS_MINUTOS = [1, 5, 15, 60, 60];
  static readonly MAX_INTENTOS = 5;
  static readonly MAX_REENVIOS_POR_HORA = 3;

  private readonly log = new Logger(CorreoComprobanteService.name);
  private avisoSinTabla = false;

  constructor(
    private readonly repo: ComprobanteCorreosRepository,
    private readonly comprobantes: ComprobanteBussnies,
    private readonly config: RepositorioConfigFiscal,
    private readonly enviador: EnviadorCorreo,
  ) {}

  /** Interruptor general: clave `correo_envio_activo` = 'true' (apagado por defecto). */
  async activo(): Promise<boolean> {
    const valores = await this.config.leer([CLAVE_CORREO_ENVIO_ACTIVO]);
    return (valores[CLAVE_CORREO_ENVIO_ACTIVO] ?? '').trim().toLowerCase() === 'true';
  }

  /** ¿Existe la tabla? Si no, lo avisa una sola vez en el log (aplicar sql/fase17). */
  async tablaDisponible(): Promise<boolean> {
    const existe = await this.repo.tablaDisponible();
    if (!existe && !this.avisoSinTabla) {
      this.avisoSinTabla = true;
      this.log.warn('La tabla comprobante_correos no existe: aplique sql/fase17_comprobante_correos.sql. El envío de correos queda inactivo.');
    }
    return existe;
  }

  /** Reclama y envía un correo. null si otra réplica lo tomó o ya cambió de estado. */
  async procesar(idCorreo: number): Promise<ResultadoProceso | null> {
    const fila = await this.repo.reclamar(idCorreo);
    if (!fila) return null;
    try {
      return await this.enviarFila(fila);
    } catch (error) {
      const reintentable = error instanceof ErrorEnvioCorreo ? error.reintentable : true;
      const espera =
        reintentable && fila.intentos < CorreoComprobanteService.MAX_INTENTOS
          ? (CorreoComprobanteService.ESPERAS_MINUTOS[fila.intentos - 1] ?? 60)
          : null;
      const mensaje = error instanceof Error ? error.message : String(error);
      await this.repo.marcarError(fila.id_correo, mensaje, espera);
      this.log.warn(`Correo ${fila.id_correo} del comprobante ${fila.id_comprobante} falló (intento ${fila.intentos}): ${mensaje}`);
      return espera === null ? 'ERROR' : 'PENDIENTE';
    }
  }

  private async enviarFila(fila: CorreoFila): Promise<ResultadoProceso> {
    const idComprobante = fila.id_comprobante;
    const detalle = await this.comprobantes.obtenerDetalle(idComprobante);

    if (detalle.proveedor_fiscal !== 'sunat_directo') return this.omitir(fila, 'sin comprobante electrónico');
    if (detalle.anulado || detalle.estado_sunat === 'RECHAZADO' || detalle.estado_sunat === 'ANULADO') {
      return this.omitir(fila, 'comprobante rechazado o anulado');
    }
    if (!ESTADOS_ACEPTADOS.includes(detalle.estado_sunat ?? '')) {
      throw new ErrorEnvioCorreo('El comprobante todavía no fue aceptado por SUNAT.', true);
    }

    // Regla BETA: nunca se escribe a un cliente real desde el ambiente de pruebas.
    const esBeta = detalle.ambiente_fiscal === 'beta';
    let destino = fila.destino;
    if (esBeta) {
      destino = leerConfigCorreo().destinoPruebas;
      if (!destino) return this.omitir(fila, 'ambiente beta sin correo de pruebas');
    }
    if (!correoValido(destino)) return this.omitir(fila, 'correo del cliente no válido');
    destino = destino.trim();

    const pdf = await this.comprobantes.obtenerPdf(idComprobante, 'a4');
    const adjuntos: AdjuntoCorreo[] = [{ nombre: pdf.nombre, mime: 'application/pdf', contenido: pdf.contenido }];
    try {
      const xml = await this.comprobantes.obtenerArchivo(idComprobante, 'xml_firmado');
      adjuntos.push({ nombre: xml.nombre, mime: xml.mime || 'application/xml', contenido: xml.contenido });
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      this.log.warn(`Comprobante ${idComprobante} sin XML firmado: se envía solo el PDF.`);
    }

    const armado = armarCorreoComprobante({
      tipoNombre: detalle.tipo_nombre,
      numeroFormateado: detalle.numero_formateado,
      fechaEmision: detalle.fecha_de_emision,
      total: detalle.totales.total,
      simboloMoneda: detalle.moneda.simbolo,
      monedaNombre: detalle.moneda.nombre,
      receptor: detalle.receptor.denominacion || null,
      emisor: detalle.emisor,
      esBeta,
    });
    const resultado = await this.enviador.enviar({
      para: destino,
      asunto: armado.asunto,
      html: armado.html,
      texto: armado.texto,
      adjuntos,
      remitenteNombre: leerConfigCorreo().remitenteNombre ?? detalle.emisor.razon_social,
    });
    await this.repo.marcarEnviado(fila.id_correo, resultado.id_mensaje, esBeta ? destino : null);
    return 'ENVIADO';
  }

  private async omitir(fila: CorreoFila, motivo: string): Promise<ResultadoProceso> {
    await this.repo.marcarOmitido(fila.id_correo, motivo);
    return 'OMITIDO';
  }

  /**
   * Reenvío manual desde Documentos. Valida, aplica el límite (3 por comprobante y hora), crea la fila
   * `manual` y la procesa en el acto. Devuelve la fila resultante.
   */
  async reenviar(idComprobante: number, destino: string | undefined, idUsuario: number | null): Promise<CorreoFila> {
    if (!(await this.tablaDisponible())) {
      throw new ServiceUnavailableException('El envío de correos no está disponible: falta aplicar la tabla comprobante_correos.');
    }
    if (!(await this.activo())) {
      throw new ConflictException('El envío de correos está desactivado (correo_envio_activo).');
    }
    const detalle = await this.comprobantes.obtenerDetalle(idComprobante);
    if (!this.puedeReenviar(detalle)) {
      throw new BadRequestException('Solo se puede enviar por correo un comprobante electrónico aceptado por SUNAT y no anulado.');
    }
    const elegido = (destino ?? '').trim() || (detalle.receptor?.email ?? '').trim();
    if (!elegido) throw new BadRequestException('Indique el correo de destino: el comprobante no tiene uno registrado.');
    if (!correoValido(elegido)) throw new BadRequestException('El correo de destino no es válido.');

    if ((await this.repo.reenviosUltimaHora(idComprobante)) >= CorreoComprobanteService.MAX_REENVIOS_POR_HORA) {
      throw new HttpException(
        `Se alcanzó el máximo de ${CorreoComprobanteService.MAX_REENVIOS_POR_HORA} reenvíos por hora para este comprobante. Intente más tarde.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const idCorreo = await this.repo.crearManual(idComprobante, elegido, idUsuario);
    if (idCorreo === null) throw new ConflictException('Este comprobante ya tiene un envío de correo en curso.');

    await this.procesar(idCorreo);
    const fila = await this.repo.obtener(idCorreo);
    if (!fila) throw new NotFoundException('No se encontró el correo creado.');
    return fila;
  }

  async historial(idComprobante: number): Promise<CorreoFila[]> {
    if (!(await this.tablaDisponible())) return [];
    return this.repo.historial(idComprobante);
  }

  /** Resumen para el detalle: el último correo registrado o, sin filas, el estado derivado de `enviar_cliente`. */
  async estadoResumen(detalle: DetalleParaCorreo): Promise<ResumenCorreoComprobante> {
    const puedeReenviar = this.puedeReenviar(detalle);
    let fila: CorreoFila | null = null;
    try {
      if (await this.repo.tablaDisponible()) fila = await this.repo.ultimo(detalle.id_comprobante);
    } catch (error) {
      this.log.warn(`No se pudo leer el correo del comprobante ${detalle.id_comprobante}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (fila) {
      return {
        estado: fila.estado,
        destino: fila.destino,
        enviado_en: fila.enviado_en,
        ultimo_error: fila.ultimo_error,
        motivo_omision: fila.motivo_omision,
        puede_reenviar: puedeReenviar,
      };
    }
    const destino = (detalle.receptor?.email ?? '').trim() || null;
    if (!detalle.enviar_cliente) {
      return { estado: 'SIN_SOLICITAR', destino, enviado_en: null, ultimo_error: null, motivo_omision: null, puede_reenviar: puedeReenviar };
    }
    // Sin fila, el estado se deriva igual que lo decidiría la siembra de la tarea: lo que nunca se va a enviar
    // se muestra como OMITIDO con su motivo, no como un «Pendiente» que no termina.
    const omitido = (motivo: string, reenviar: boolean): ResumenCorreoComprobante => ({
      estado: 'OMITIDO', destino, enviado_en: null, ultimo_error: null, motivo_omision: motivo, puede_reenviar: reenviar,
    });
    if (detalle.proveedor_fiscal !== 'sunat_directo') return omitido('sin comprobante electrónico', false);
    if (detalle.anulado || detalle.estado_sunat === 'RECHAZADO' || detalle.estado_sunat === 'ANULADO') {
      return omitido('comprobante rechazado o anulado', false);
    }
    if (!destino) return omitido('el cliente no tiene correo', puedeReenviar);
    if (!correoValido(destino)) return omitido('correo del cliente no válido', puedeReenviar);
    return { estado: 'PENDIENTE', destino, enviado_en: null, ultimo_error: null, motivo_omision: null, puede_reenviar: puedeReenviar };
  }

  private puedeReenviar(d: Pick<DetalleParaCorreo, 'proveedor_fiscal' | 'estado_sunat' | 'anulado'>): boolean {
    return d.proveedor_fiscal === 'sunat_directo' && ESTADOS_ACEPTADOS.includes(d.estado_sunat ?? '') && !d.anulado;
  }
}
