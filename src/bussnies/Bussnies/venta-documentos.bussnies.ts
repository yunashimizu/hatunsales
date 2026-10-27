import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { normalizarRol } from '../../config/roles.config';
import type { UsuarioToken } from '../../guards/usuario-actual.decorator';
import type { ComprobanteDetalleResponse } from '../../models/model/c-electronico/comprobante.response';
import { ESTADOS_GUIA } from '../../models/model/guia-remision.request';
import type { EstadoGuia } from '../../models/model/guia-remision.request';
import type { ListarVentasSinComprobanteRequest } from '../../models/model/venta/listar-ventas.request';
import type {
  AccionDocumento,
  ComprobanteDeVenta,
  GuiaDeVenta,
  NotaDeVenta,
  Paginado,
  VentaDocumentosResponse,
  VentaSinComprobante,
} from '../../models/model/venta/venta-documentos.response';
import { GuiaRemisionRepository } from '../../repository/Repository/guia-remision.repository';
import type { ProductoVendidoGuia } from '../../repository/Repository/guia-remision.repository';
import { esPrincipalVigente, VentaDocumentosRepository } from '../../repository/Repository/venta-documentos.repository';
import type {
  ComprobanteDeLaVenta,
  GuiaDeLaVenta,
  VentaDeDocumentos,
  VentaSinComprobanteGuardada,
} from '../../repository/Repository/venta-documentos.repository';
import { ETIQUETA_MOTIVO_NOTA_CREDITO } from '../../sunat/catalogos/sunat.catalogos';
import { EmisionDirecta } from '../../sunat/emision/emision.contrato';
import type { ModoEmision } from '../../sunat/emision/emision.contrato';
import { CATALOGO_20_MOTIVOS_TRASLADO, EmisionGre } from '../../sunat/gre';
import type { ModoEmisionGre } from '../../sunat/gre';
import type { AccionSunat, AmbienteFiscal, EstadoSunat } from '../../sunat/nucleo/documento-fiscal.types';
import { admiteGetStatusCdr, esDocumentoDeFactura } from '../../sunat/nucleo/reglas-envio';
import { esComprobantePrincipal, nombreTipoComprobante, tipoComprobanteSunat, TIPO_NOTA_CREDITO } from '../../util/fiscal/tipos-comprobante';
import { ComprobanteBussnies } from './comprobante.bussnies';
import { ESTADO_GUIA_TEXTO } from './guia-remision.bussnies';
import { clasificarParaAnular, esNotaEnCurso, motivoEmisionInactiva, NotaCreditoBussnies } from './nota-credito.bussnies';
import type { ResumenNotasOrigen } from './nota-credito.contrato';

/** Lo que Documentos dice que se puede hacer con un comprobante: se toma de su detalle, con sus mismas reglas. */
type AccionesDetalle = Pick<
  ComprobanteDetalleResponse,
  'puede_reintentar' | 'puede_recuperar_cdr' | 'puede_confirmar_manual' | 'puede_nota_credito' | 'puede_anular' | 'vencido' | 'fecha_limite_envio' | 'aviso'
>;

const ESTADOS_ACEPTADO: ReadonlySet<string> = new Set(['ACEPTADO', 'ACEPTADO_OBS']);
/** modo() no pudo leer la configuración: el ambiente que informa es el de respaldo (mismo criterio que las notas). */
const CODIGO_LECTURA_ERROR = 'FISCAL_LECTURA_ERROR';
/** Lo que responden las rutas de notas de crédito sin fase14 (503 NOTA_CREDITO_MIGRACION_PENDIENTE). */
const MENSAJE_SIN_FASE14 = 'Aplique sql/fase14_notas_credito_enlace.sql para habilitar las notas de crédito.';
/** Roles de POST /comprobante/:id/nota-credito y de las rutas que crean guías (caja solo consulta). */
const ROLES_NOTA_Y_GUIA: ReadonlySet<string> = new Set(['admin', 'vendedor']);

const permitido = (motivo?: string): AccionDocumento => (motivo ? { permitido: true, motivo } : { permitido: true });
const noPermitido = (motivo: string): AccionDocumento => ({ permitido: false, motivo });

function numeroFormateado(serie: string, numero: number): string {
  return `${serie}-${String(numero).padStart(8, '0')}`;
}

function numeroDe(c: Pick<ComprobanteDeLaVenta, 'serie' | 'numero'>): string {
  return numeroFormateado(c.serie, c.numero);
}

function estadoGuia(valor: string): EstadoGuia {
  return (ESTADOS_GUIA as readonly string[]).includes(valor) ? (valor as EstadoGuia) : 'legacy';
}

function nombreAmbiente(ambiente: string | null | undefined): string {
  if (ambiente === 'beta') return 'SUNAT BETA (pruebas)';
  if (ambiente === 'produccion') return 'PRODUCCIÓN';
  return 'otro ambiente';
}

/** El primer texto con contenido. */
function primerTexto(...valores: (string | null | undefined)[]): string | null {
  for (const valor of valores) {
    const limpio = valor?.trim();
    if (limpio) return limpio;
  }
  return null;
}

/** aaaa-mm-dd → dd/mm/aaaa para los avisos. */
function fechaLegible(fecha: string | null | undefined): string | null {
  const partes = /^(\d{4})-(\d{2})-(\d{2})/.exec(fecha ?? '');
  return partes ? `${partes[3]}/${partes[2]}/${partes[1]}` : null;
}

/** Cantidades de la guía en milésimas (admite 3 decimales): sin errores de coma flotante. */
function milesimas(cantidad: number): number {
  return Math.round(Number(cantidad) * 1000);
}

function mensajeDe(error: unknown): string {
  const e = error as { response?: { message?: unknown }; message?: unknown };
  const desdeRespuesta = e?.response?.message;
  if (Array.isArray(desdeRespuesta)) return desdeRespuesta.map(String).join(' | ');
  if (typeof desdeRespuesta === 'string' && desdeRespuesta.trim()) return desdeRespuesta;
  return typeof e?.message === 'string' && e.message.trim() ? e.message : 'error desconocido';
}

/**
 * Documentos de una venta (PLAN V3, D10): su factura o boleta, las notas de crédito y las guías enlazadas, qué
 * se puede hacer con ella y las ventas que se quedaron sin comprobante. Solo lee: cada acción la vuelve a
 * validar su propio negocio al ejecutarse. Las decisiones salen de las reglas que ya existen y aquí solo se
 * explican en palabras: las banderas de cada comprobante son las de Documentos (ComprobanteBussnies.obtenerDetalle),
 * el saldo y las notas en curso los da el negocio de notas de crédito, la anulación sigue las ramas de D9
 * (clasificarParaAnular), el tope de guías es el de G2 (GuiaRemisionRepository.productosVendidos) y la emisión
 * la decide EmisionDirecta.modo().
 */
@Injectable()
export class VentaDocumentosBussnies {

  private readonly logger = new Logger(VentaDocumentosBussnies.name);

  constructor(
    private readonly repo: VentaDocumentosRepository,
    private readonly comprobantes: ComprobanteBussnies,
    private readonly notas: NotaCreditoBussnies,
    private readonly guiasRepo: GuiaRemisionRepository,
    private readonly emision: EmisionDirecta,
    private readonly emisionGre: EmisionGre,
  ) {}

  // ── GET /venta/:id/documentos ────────────────────────────────

  async documentos(idVenta: number, usuario?: UsuarioToken | null): Promise<VentaDocumentosResponse> {
    const venta = await this.repo.venta(idVenta);
    if (!venta) throw new NotFoundException({ message: `No existe la venta ${idVenta}.`, codigo: 'VENTA_NO_ENCONTRADA' });

    const [comprobantes, guias, modo, notasHabilitadas, vendidos] = await Promise.all([
      this.repo.comprobantes(idVenta),
      this.repo.guias(idVenta),
      this.emision.modo(),
      this.repo.notasCreditoHabilitadas(),
      this.opcional<ProductoVendidoGuia[] | null>(() => this.guiasRepo.productosVendidos(idVenta, null), `lo pendiente de guía de la venta ${idVenta}`, null),
    ]);
    const principales = comprobantes.filter((c) => esComprobantePrincipal(c.id_tipo));
    // Si hay más de uno vigente (ventas anteriores al índice único de fase12) cuenta el primero, como en la emisión.
    const vigentes = principales.filter(esPrincipalVigente).sort((a, b) => a.id_comprobante - b.id_comprobante);
    const principal = vigentes[0] ?? null;
    const sinAnular = principales.filter((c) => !c.anulado);
    const notas = comprobantes.filter((c) => c.id_tipo === TIPO_NOTA_CREDITO).sort((a, b) => a.id_comprobante - b.id_comprobante);
    const rol = normalizarRol(usuario?.rol);
    const guia = this.accionGuia(venta, vendidos, rol);

    const [detalles, resumenes, modoGre] = await Promise.all([
      this.detalles(sinAnular),
      this.opcional(() => this.notas.resumenes(sinAnular.map((c) => c.id_comprobante)), 'el saldo de notas de crédito de la venta', new Map<number, ResumenNotasOrigen>()),
      guia.permitido ? this.opcional<ModoEmisionGre | null>(() => this.emisionGre.modo(), 'el modo de la GRE', null) : Promise.resolve(null),
    ]);
    const detallePrincipal = principal ? detalles.get(principal.id_comprobante) ?? null : null;

    const acciones: VentaDocumentosResponse['acciones'] = {
      emitir_comprobante: this.accionEmitir(venta, principal, modo),
      nota_credito: this.accionNota(principal, detallePrincipal, principal ? resumenes.get(principal.id_comprobante) ?? null : null, notas, modo, notasHabilitadas, rol),
      guia: guia.permitido && modoGre && !modoGre.activo
        ? permitido(`Podrá guardar la guía como borrador y validarla, pero todavía no emitirla a SUNAT. ${modoGre.motivo}`)
        : guia,
      anular: this.accionAnular(venta, sinAnular, modo, resumenes, notasHabilitadas, rol),
    };

    return {
      venta: {
        id: venta.id_venta,
        fecha: venta.fecha,
        total: venta.total,
        estado: venta.estado,
        cliente: venta.cliente,
        pagos: venta.pagos,
        a_credito: venta.a_credito,
        saldo_cxc: venta.saldo_cxc,
      },
      comprobante: principal ? this.comprobanteDeVenta(principal, detalles) : null,
      comprobantes_anteriores: principales.filter((c) => c !== principal).map((c) => this.comprobanteDeVenta(c, detalles)),
      notas: notas.map((n) => this.notaDeVenta(n)),
      guias: guias.map((g) => this.guiaDeVenta(g)),
      acciones,
      avisos: [
        ...this.avisosComprobante(venta, principal, vigentes, sinAnular, detalles, modo, acciones.emitir_comprobante),
        ...this.avisosNotas(notas),
        ...this.avisosGuias(guias),
      ],
    };
  }

  // ── GET /venta/sin-comprobante ───────────────────────────────

  /**
   * Ventas activas sin factura ni boleta vigente, con el último motivo por el que no se emitió: el error de
   * su último comprobante o, si nunca tuvo uno, por qué la emisión no está activa ahora.
   */
  async sinComprobante(filtro: ListarVentasSinComprobanteRequest): Promise<Paginado<VentaSinComprobante>> {
    const [pagina, modo] = await Promise.all([this.repo.sinComprobante(filtro), this.emision.modo()]);
    const sinEmision = modo.activo ? null : motivoEmisionInactiva(modo);
    return {
      datos: pagina.filas.map((f) => ({
        id_venta: f.id_venta,
        fecha: f.fecha,
        total: f.total,
        cliente: f.cliente.nombre,
        documento_cliente: f.cliente.documento,
        ultimo_error: this.ultimoError(f.ultimo) ?? sinEmision,
      })),
      total: pagina.total,
      pagina: pagina.pagina,
      por_pagina: pagina.por_pagina,
    };
  }

  // ── Acciones ─────────────────────────────────────────────────

  /** Las condiciones de VentaBussnies.emitirComprobanteDeVenta, más la emisión activa (sin ella no se emite). */
  private accionEmitir(venta: VentaDeDocumentos, principal: ComprobanteDeLaVenta | null, modo: ModoEmision): AccionDocumento {
    if (venta.estado === 'anulada') return noPermitido(`La venta ${venta.id_venta} está anulada: no se le emite comprobante.`);
    if (principal) {
      const enCurso = principal.estado === 'pendiente' ? ' (su envío a SUNAT está en curso)' : '';
      return noPermitido(`La venta ${venta.id_venta} ya tiene el comprobante ${numeroDe(principal)}${enCurso}. No se emite otro para no duplicarlo.`);
    }
    if (venta.cantidad_lineas <= 0) return noPermitido(`La venta ${venta.id_venta} no tiene productos registrados para emitir su comprobante.`);
    if (!modo.activo) return noPermitido(motivoEmisionInactiva(modo));
    return permitido();
  }

  /**
   * Lo decide puede_nota_credito del comprobante (aceptado en el ambiente vigente, emisión activa, saldo y sin
   * otra nota en envío); el motivo explica, con las palabras del asistente de notas, la primera causa.
   */
  private accionNota(
    principal: ComprobanteDeLaVenta | null,
    detalle: AccionesDetalle | null,
    resumen: ResumenNotasOrigen | null,
    notas: ComprobanteDeLaVenta[],
    modo: ModoEmision,
    notasHabilitadas: boolean,
    rol: string,
  ): AccionDocumento {
    if (!principal) return noPermitido('La venta no tiene factura ni boleta vigente: la nota de crédito se emite sobre ella.');
    if (!ROLES_NOTA_Y_GUIA.has(rol)) return noPermitido('Solo un administrador o un vendedor puede emitir notas de crédito.');
    if (!notasHabilitadas) return noPermitido(MENSAJE_SIN_FASE14);
    if (detalle?.puede_nota_credito) return permitido();

    const numero = numeroDe(principal);
    if (!detalle) return noPermitido(`No se pudo comprobar si ${numero} admite nota de crédito: ábralo en Documentos.`);
    if (principal.proveedor_fiscal !== 'sunat_directo') {
      return noPermitido(`${numero} se emitió con el sistema anterior: su nota de crédito no se emite desde aquí (la venta se anula en el sistema).`);
    }
    if (!modo.activo && modo.codigo === CODIGO_LECTURA_ERROR) return noPermitido(motivoEmisionInactiva(modo));
    if (principal.ambiente_fiscal !== modo.ambiente) {
      return noPermitido(
        `${numero} se emitió en ${nombreAmbiente(principal.ambiente_fiscal)} y el ambiente vigente es ${nombreAmbiente(modo.ambiente)}: se anula en el sistema, sin nota de crédito.`,
      );
    }
    if (!principal.aceptada_sunat || !ESTADOS_ACEPTADO.has(principal.estado_sunat ?? '')) {
      return noPermitido(`${numero} todavía no está aceptado por SUNAT: la nota de crédito solo se emite sobre comprobantes aceptados.`);
    }
    if (!modo.activo) return noPermitido(motivoEmisionInactiva(modo));
    const enCurso = notas.find((n) => n.id_comprobante_modificado === principal.id_comprobante && esNotaEnCurso(n));
    if (enCurso || resumen?.nota_en_curso) {
      return noPermitido(`La nota ${enCurso ? numeroDe(enCurso) : `de ${numero}`} todavía se está enviando a SUNAT: espere su resultado antes de emitir otra.`);
    }
    if (resumen && resumen.saldo <= 0) return noPermitido(`${numero} ya se acreditó por completo con notas de crédito.`);
    return noPermitido(`${numero} no admite una nota de crédito en este momento: revise su estado en Documentos.`);
  }

  /** Venta activa con cantidades sin guía vigente (tope de G2). Emitirla exige además la GRE activa; el borrador no. */
  private accionGuia(venta: VentaDeDocumentos, vendidos: ProductoVendidoGuia[] | null, rol: string): AccionDocumento {
    if (venta.estado === 'anulada') return noPermitido(`La venta ${venta.id_venta} está anulada: no se le pueden emitir guías.`);
    if (!ROLES_NOTA_Y_GUIA.has(rol)) return noPermitido('Solo un administrador o un vendedor puede crear guías de remisión.');
    if (vendidos === null) return noPermitido('No se pudo comprobar lo que falta entregar de la venta: vuelva a intentarlo en unos segundos.');
    if (!vendidos.length) return noPermitido('La venta no tiene productos para trasladar.');
    if (vendidos.every((v) => milesimas(v.cantidad_vendida) - milesimas(v.cantidad_en_guias) <= 0)) {
      return noPermitido('Todo lo vendido ya está en guías vigentes (borradores o emitidas): anule una para volver a usar sus cantidades.');
    }
    return permitido();
  }

  /**
   * Solo un administrador anula. Refleja las ramas de D9 que aplicará NotaCreditoBussnies.anularVenta: sin
   * comprobante válido se anula en el sistema; con uno aceptado del ambiente vigente, con nota de crédito (si se
   * puede emitir); con un envío sin confirmar hay que consultar o verificar en SUNAT primero (se advierte).
   */
  private accionAnular(
    venta: VentaDeDocumentos,
    sinAnular: ComprobanteDeLaVenta[],
    modo: ModoEmision,
    resumenes: Map<number, ResumenNotasOrigen>,
    notasHabilitadas: boolean,
    rol: string,
  ): AccionDocumento {
    if (venta.estado === 'anulada') return noPermitido(`La venta ${venta.id_venta} ya está anulada.`);
    if (rol !== 'admin') return noPermitido('Solo un administrador puede anular la venta.');
    if (!sinAnular.length) return permitido();
    if (!modo.activo && modo.codigo === CODIGO_LECTURA_ERROR && sinAnular.some((c) => c.proveedor_fiscal === 'sunat_directo')) {
      return noPermitido(`No se puede anular ahora. ${motivoEmisionInactiva(modo)}`);
    }

    const clases = sinAnular.map((c) => ({ c, clase: clasificarParaAnular(c, modo.ambiente) }));
    const de = (clase: string) => clases.filter((x) => x.clase === clase).map((x) => x.c);
    const aceptados = de('aceptado');
    if (aceptados.length > 1) {
      return noPermitido(`La venta tiene más de un comprobante aceptado por SUNAT (${aceptados.map(numeroDe).join(', ')}): anúlelos uno por uno desde Documentos.`);
    }

    const inciertos = de('incierto');
    if (inciertos.length) {
      const verificar = inciertos.filter((c) => {
        const tipo = tipoComprobanteSunat(c.id_tipo);
        return !(c.ambiente_fiscal === 'produccion' && tipo && admiteGetStatusCdr(tipo, c.serie));
      });
      return permitido(verificar.length
        ? `El envío de ${verificar.map(numeroDe).join(', ')} a SUNAT quedó sin confirmar: al anular se le pedirá que verifique en SUNAT Operaciones en Línea si existe.`
        : `El envío de ${inciertos.map(numeroDe).join(', ')} a SUNAT quedó sin confirmar: al anular, primero se consultará su estado en SUNAT.`);
    }

    if (aceptados.length === 1) {
      const aceptado = aceptados[0];
      const numero = numeroDe(aceptado);
      const resumen = resumenes.get(aceptado.id_comprobante) ?? null;
      if (!notasHabilitadas) return noPermitido(`${numero} ya fue aceptado por SUNAT y solo se anula con una nota de crédito. ${MENSAJE_SIN_FASE14}`);
      if (resumen?.anulacion_en_curso) {
        return noPermitido(`La nota de crédito que anula ${numero} sigue en envío a SUNAT: la venta se anulará cuando SUNAT la acepte.`);
      }
      if (resumen?.nota_en_curso) {
        return noPermitido(`Una nota de crédito de ${numero} todavía se está enviando a SUNAT: espere su resultado antes de anular la venta.`);
      }
      if (resumen && resumen.saldo <= 0) return permitido(`${numero} ya está acreditado por completo con notas de crédito: la venta se anulará en el sistema.`);
      if (!modo.activo) {
        return noPermitido(
          `${numero} ya fue aceptado por SUNAT y solo se anula con una nota de crédito, que no se puede emitir ahora. ${motivoEmisionInactiva(modo)}`,
        );
      }
      return permitido(`Se emitirá una nota de crédito que anula ${numero}: la venta se anulará cuando SUNAT la acepte.`);
    }

    const advertencias = [
      ...de('local').map((c) =>
        `${numeroDe(c)} ${c.proveedor_fiscal !== 'sunat_directo' ? 'se emitió con el sistema anterior' : `se emitió en ${nombreAmbiente(c.ambiente_fiscal)}`}: no se anula en SUNAT desde aquí, se anulará en el sistema junto con la venta.`),
      ...de('nunca_enviado').map((c) => `${numeroDe(c)} nunca fue aceptado por SUNAT: se anulará en el sistema junto con la venta.`),
    ];
    return permitido(advertencias.join(' ') || undefined);
  }

  // ── Avisos ───────────────────────────────────────────────────

  /** Ambiente de prueba, venta sin comprobante, duplicados, envío sin respuesta o fuera de plazo y acciones no leídas. */
  private avisosComprobante(
    venta: VentaDeDocumentos,
    principal: ComprobanteDeLaVenta | null,
    vigentes: ComprobanteDeLaVenta[],
    sinAnular: ComprobanteDeLaVenta[],
    detalles: Map<number, AccionesDetalle | null>,
    modo: ModoEmision,
    emitir: AccionDocumento,
  ): string[] {
    const avisos: string[] = [];
    const detalle = principal ? detalles.get(principal.id_comprobante) ?? null : null;
    if (detalle?.aviso) avisos.push(detalle.aviso);

    if (!principal && venta.estado !== 'anulada') {
      avisos.push(emitir.permitido
        ? 'La venta no tiene comprobante electrónico vigente: emítalo con «Emitir comprobante».'
        : `La venta no tiene comprobante electrónico vigente. ${emitir.motivo ?? ''}`.trim());
    }
    if (vigentes.length > 1) {
      avisos.push(`La venta tiene más de un comprobante vigente (${vigentes.map(numeroDe).join(', ')}): anule desde Documentos el que sobra.`);
    }

    if (principal && detalle?.vencido) {
      const tipo = tipoComprobanteSunat(principal.id_tipo);
      const limite = fechaLegible(detalle.fecha_limite_envio);
      const hasta = limite ? ` (vencía el ${limite})` : '';
      avisos.push(tipo && esDocumentoDeFactura(tipo, principal.serie)
        ? `Venció el plazo para enviar ${numeroDe(principal)} a SUNAT${hasta}: emita un comprobante nuevo.`
        : `Venció el plazo de envío individual de ${numeroDe(principal)}${hasta}: informe la boleta en SUNAT con el resumen diario.`);
    } else if (principal && principal.estado === 'pendiente') {
      const siguiente = detalle?.puede_confirmar_manual
        ? 'verifique en SUNAT Operaciones en Línea si existe y confírmelo en Documentos'
        : detalle?.puede_recuperar_cdr
          ? 'recupere la constancia (CDR) desde Documentos'
          : detalle?.puede_reintentar
            ? 'reintente el envío desde Documentos'
            : 'espere unos minutos y vuelva a revisar';
      avisos.push(`${numeroDe(principal)} todavía no tiene la respuesta de SUNAT: ${siguiente}.`);
    }

    // Un comprobante con error cuyo envío quedó en revisión pudo llegar a SUNAT: otro encima podría duplicarlo.
    for (const c of sinAnular) {
      if (c === principal || c.estado !== 'error' || clasificarParaAnular(c, modo.ambiente) !== 'incierto') continue;
      const detalleError = primerTexto(c.error_mensaje, c.mensaje_envio);
      avisos.push(
        `${numeroDe(c)} quedó en revisión${detalleError ? ` (${detalleError})` : ''}: verifique en SUNAT Operaciones en Línea que no exista antes de emitir otro comprobante.`,
      );
    }
    for (const c of sinAnular) {
      if (detalles.get(c.id_comprobante) === null) avisos.push(`No se pudieron leer las acciones de ${numeroDe(c)}: ábralo en Documentos.`);
    }
    return avisos;
  }

  /** Notas en envío (la que anula la venta lo dice), aceptadas con efectos pendientes y rechazadas. */
  private avisosNotas(notas: ComprobanteDeLaVenta[]): string[] {
    const avisos: string[] = [];
    for (const n of notas) {
      const numero = numeroDe(n);
      if (esNotaEnCurso(n)) {
        avisos.push(n.efecto_nota === 'anular_venta'
          ? `La nota de crédito ${numero} que anula la venta sigue en envío a SUNAT: la venta se anulará cuando SUNAT la acepte.`
          : `La nota de crédito ${numero} todavía se está enviando a SUNAT: espere su resultado.`);
      } else if (!n.anulado && n.aceptada_sunat && ESTADOS_ACEPTADO.has(n.estado_sunat ?? '') && n.efecto_nota && n.efectos_aplicados === false) {
        avisos.push(`SUNAT aceptó la nota ${numero}, pero el stock, la deuda y la anulación todavía no se actualizaron: se reintentará en unos minutos.`);
      } else if (n.estado_sunat === 'RECHAZADO') {
        const motivo = primerTexto(n.error_mensaje, n.sunat_description);
        avisos.push(`SUNAT rechazó la nota ${numero}${motivo ? ` (${motivo})` : ''}: no se aplicó nada y puede emitir otra.`);
      }
    }
    return avisos;
  }

  /** Guías que todavía esperan a SUNAT, rechazadas o en borrador. */
  private avisosGuias(guias: GuiaDeLaVenta[]): string[] {
    const avisos: string[] = [];
    let borradores = 0;
    for (const g of guias) {
      const estado = estadoGuia(g.estado);
      const nombre = g.serie && g.numero ? numeroFormateado(g.serie, g.numero) : `n.º ${g.id_guia}`;
      if (estado === 'borrador') borradores += 1;
      else if (estado === 'enviado') avisos.push(`SUNAT todavía está procesando la guía ${nombre}: revise su resultado en Guías («Consultar»).`);
      else if (estado === 'pendiente') avisos.push(`La guía ${nombre} quedó pendiente de envío a SUNAT: vuelva a emitirla desde Guías.`);
      else if (estado === 'rechazado') avisos.push(`SUNAT rechazó la guía ${nombre}: corríjala y vuelva a emitirla desde Guías.`);
    }
    if (borradores === 1) avisos.push('Hay una guía en borrador: todavía no se emitió a SUNAT.');
    if (borradores > 1) avisos.push(`Hay ${borradores} guías en borrador: todavía no se emitieron a SUNAT.`);
    return avisos;
  }

  // ── Respuestas ───────────────────────────────────────────────

  private comprobanteDeVenta(c: ComprobanteDeLaVenta, detalles: Map<number, AccionesDetalle | null>): ComprobanteDeVenta {
    // Un anulado no tiene acciones (no se le lee el detalle); si el detalle no se pudo leer, tampoco se ofrecen.
    const acciones = detalles.get(c.id_comprobante) ?? null;
    return {
      id_comprobante: c.id_comprobante,
      id_tipo: c.id_tipo,
      tipo_nombre: nombreTipoComprobante(c.id_tipo),
      serie: c.serie,
      numero: c.numero,
      numero_formateado: numeroDe(c),
      fecha_de_emision: c.fecha_de_emision,
      total: c.total,
      estado: c.estado ?? 'emitido',
      anulado: c.anulado,
      estado_sunat: (c.estado_sunat as EstadoSunat | null) ?? null,
      ambiente_fiscal: c.ambiente_fiscal === 'beta' || c.ambiente_fiscal === 'produccion' ? (c.ambiente_fiscal as AmbienteFiscal) : null,
      accion_sunat: (c.envio?.accion as AccionSunat | null | undefined) ?? null,
      mensaje: c.anulado ? primerTexto(c.motivo_anulacion) : primerTexto(c.error_mensaje, c.mensaje_envio, c.sunat_description),
      puede_reintentar: acciones?.puede_reintentar === true,
      puede_recuperar_cdr: acciones?.puede_recuperar_cdr === true,
      puede_confirmar_manual: acciones?.puede_confirmar_manual === true,
      puede_nota_credito: acciones?.puede_nota_credito === true,
      puede_anular: acciones?.puede_anular === true,
    };
  }

  private notaDeVenta(n: ComprobanteDeLaVenta): NotaDeVenta {
    const motivo = n.nota_motivo;
    return {
      id_comprobante: n.id_comprobante,
      serie: n.serie,
      numero: n.numero,
      numero_formateado: numeroDe(n),
      motivo,
      motivo_nombre: motivo ? ETIQUETA_MOTIVO_NOTA_CREDITO[motivo as keyof typeof ETIQUETA_MOTIVO_NOTA_CREDITO] ?? null : null,
      total: n.total,
      estado: n.estado ?? 'emitido',
      anulado: n.anulado,
      estado_sunat: (n.estado_sunat as EstadoSunat | null) ?? null,
      efecto: n.efecto_nota,
      efectos_aplicados: n.efectos_aplicados,
      doc_modificado: n.doc_modificado_serie && n.doc_modificado_numero ? numeroFormateado(n.doc_modificado_serie, n.doc_modificado_numero) : null,
    };
  }

  private guiaDeVenta(g: GuiaDeLaVenta): GuiaDeVenta {
    const estado = estadoGuia(g.estado);
    return {
      id_guia: g.id_guia,
      serie: g.serie,
      numero: g.numero,
      numero_formateado: g.serie && g.numero ? numeroFormateado(g.serie, g.numero) : null,
      estado,
      estado_texto: ESTADO_GUIA_TEXTO[estado],
      fecha_emision: g.fecha_emision,
      motivo: g.motivo_codigo,
      // Las guías anteriores a la GRE directa solo guardaban el motivo como texto libre.
      motivo_nombre: (g.motivo_codigo ? CATALOGO_20_MOTIVOS_TRASLADO[g.motivo_codigo] : undefined) ?? g.motivo_texto,
    };
  }

  /** Por qué el último comprobante de una venta sin comprobante vigente no sirvió. null si nunca tuvo uno. */
  private ultimoError(ultimo: VentaSinComprobanteGuardada['ultimo']): string | null {
    if (!ultimo) return null;
    const numero = numeroFormateado(ultimo.serie, ultimo.numero);
    if (ultimo.anulado) return ultimo.mensaje ? `${numero} se anuló: ${ultimo.mensaje}` : `${numero} se anuló.`;
    return ultimo.mensaje ? `${numero}: ${ultimo.mensaje}` : `${numero} no fue aceptado por SUNAT.`;
  }

  // ── Auxiliares ───────────────────────────────────────────────

  /**
   * Banderas de Documentos de cada factura o boleta no anulada (una venta tiene una, rara vez dos o tres): null
   * si no se pudo leer el detalle; entonces no se ofrecen sus acciones y se avisa.
   */
  private async detalles(comprobantes: ComprobanteDeLaVenta[]): Promise<Map<number, AccionesDetalle | null>> {
    const leidos = await Promise.all(
      comprobantes.map((c) =>
        this.opcional<AccionesDetalle | null>(
          async () => {
            const d = await this.comprobantes.obtenerDetalle(c.id_comprobante);
            return {
              puede_reintentar: d.puede_reintentar,
              puede_recuperar_cdr: d.puede_recuperar_cdr,
              puede_confirmar_manual: d.puede_confirmar_manual,
              puede_nota_credito: d.puede_nota_credito,
              puede_anular: d.puede_anular,
              vencido: d.vencido,
              fecha_limite_envio: d.fecha_limite_envio,
              aviso: d.aviso,
            };
          },
          `las acciones de ${numeroDe(c)}`,
          null,
        ),
      ),
    );
    return new Map(comprobantes.map((c, i) => [c.id_comprobante, leidos[i]]));
  }

  /** Para las piezas que no son la venta ni sus documentos: si fallan, el panel se muestra igual (queda en el log). */
  private async opcional<T>(leer: () => Promise<T>, que: string, respaldo: T): Promise<T> {
    try {
      return await leer();
    } catch (error) {
      this.logger.warn(`No se pudo leer ${que}: ${mensajeDe(error)}`);
      return respaldo;
    }
  }
}
