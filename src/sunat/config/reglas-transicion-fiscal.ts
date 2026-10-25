import { ACCIONES_AUDITORIA_FISCAL, EventoAuditoriaFiscal } from '../auditoria/fiscal-auditoria.repository';
import { normalizarUsuarioSol, validarClaveSol } from '../seguridad/credenciales-sol.service';
import { CodigoFaltante, FALTANTES, ItemChecklist, problemasSeriesCpe, ResultadoPreparacion } from './checklist-activacion';
import type { ActualizarConfigFiscalDto } from './fiscal-config.dto';
import { FiscalConfigError } from './fiscal-errores';
import {
  AmbienteFiscal,
  AVISO_LEGAL_OSE,
  CLAVES_CONFIG_FISCAL,
  CLAVES_CONFIRMACIONES_ACTIVACION,
  CLAVES_EMISOR_FISCAL,
  CLAVES_GRE_FISCAL,
  CLAVES_SERIES_FISCALES,
  ConfigGreFiscal,
  ConfirmacionesActivacion,
  ConfirmacionNoOse,
  EmisorFiscal,
  ModoBoletas,
  ModoReglas2027,
  ProveedorFiscal,
  PuntoPartidaGre,
  SeriesFiscales,
  SnapshotConfigFiscal,
  TIPOS_SERIE_CPE,
  TipoSerieFiscal,
} from './fiscal-config.tipos';

/**
 * Reglas del PUT /fiscal/configuracion (funciones puras):
 * 1) el DTO se normaliza a «cambios»;
 * 2) se proyecta el estado FUTURO;
 * 3) se valida la transición contra el checklist del estado futuro (§5.3);
 * 4) se calculan las claves a guardar y los eventos de auditoría.
 */

type CamposEmisorEditables = Pick<
  EmisorFiscal,
  'razonSocial' | 'nombreComercial' | 'direccion' | 'ubigeo' | 'distrito' | 'provincia' | 'departamento' | 'codigoEstablecimiento'
>;

/** null en un campo de la partida = volver a tomarlo del emisor. */
type CambiosPartida = { [K in keyof PuntoPartidaGre]?: string | null };

export interface CambiosConfigFiscal {
  proveedor?: ProveedorFiscal;
  ambiente?: AmbienteFiscal;
  boletasModo?: ModoBoletas;
  envioEnLinea?: boolean;
  tareasActivas?: boolean;
  reglas2027?: ModoReglas2027;
  series?: Partial<SeriesFiscales>;
  emisor?: Partial<CamposEmisorEditables>;
  /** null = quitar. */
  codigoProductoDefecto?: string | null;
  solUsuario?: string;
  /** Nunca se registra ni se devuelve. */
  solClave?: string;
  confirmoNoOse?: boolean;
  gre?: { activa?: boolean; correlativoInicial?: number; partida?: CambiosPartida };
  /** Por serie; se combina con lo guardado (las series que no vienen quedan igual). */
  correlativoInicial?: Record<string, number>;
  certRucConfirmado?: boolean;
  confirmaciones?: Partial<ConfirmacionesActivacion>;
}

/** Nombres del API (snake_case) de las confirmaciones de D1.4. */
const CAMPOS_CONFIRMACIONES: ReadonlyArray<[keyof ConfirmacionesActivacion, string]> = [
  ['emisorElectronicoSol', 'emisor_electronico_sol'],
  ['certificadoEnSol', 'certificado_en_sol'],
  ['usuarioSolSecundario', 'usuario_sol_secundario'],
  ['rucHabido', 'ruc_habido'],
];

const vacioANull = (valor: string | null | undefined): string | null => {
  const limpio = (valor ?? '').trim();
  return limpio ? limpio : null;
};

/** Traduce el DTO (ya validado por class-validator) a cambios de dominio. */
export function cambiosDesdeDto(dto: ActualizarConfigFiscalDto, rucEmisor: string): CambiosConfigFiscal {
  const cambios: CambiosConfigFiscal = {};
  if (dto.proveedor !== undefined) cambios.proveedor = dto.proveedor;
  if (dto.ambiente !== undefined) cambios.ambiente = dto.ambiente;
  if (dto.boletas_modo !== undefined) cambios.boletasModo = dto.boletas_modo;
  if (dto.envio_en_linea !== undefined) cambios.envioEnLinea = dto.envio_en_linea;
  if (dto.tareas_activas !== undefined) cambios.tareasActivas = dto.tareas_activas;
  if (dto.aplicar_reglas_2027 !== undefined) cambios.reglas2027 = dto.aplicar_reglas_2027;
  if (dto.codigo_producto_defecto !== undefined) cambios.codigoProductoDefecto = vacioANull(dto.codigo_producto_defecto);
  if (dto.confirmo_no_ose !== undefined) cambios.confirmoNoOse = dto.confirmo_no_ose;
  if (dto.cert_ruc_confirmado !== undefined) cambios.certRucConfirmado = dto.cert_ruc_confirmado;

  if (dto.correlativo_inicial !== undefined && dto.correlativo_inicial !== null) {
    cambios.correlativoInicial = Object.fromEntries(
      Object.entries(dto.correlativo_inicial).map(([serie, numero]) => [serie.trim().toUpperCase(), Math.trunc(Number(numero))]),
    );
  }

  if (dto.confirmaciones) {
    const confirmaciones: Partial<ConfirmacionesActivacion> = {};
    for (const [campo, nombreApi] of CAMPOS_CONFIRMACIONES) {
      const valor = (dto.confirmaciones as Record<string, boolean | undefined>)[nombreApi];
      if (valor !== undefined) confirmaciones[campo] = valor;
    }
    if (Object.keys(confirmaciones).length) cambios.confirmaciones = confirmaciones;
  }

  if (dto.series) {
    const series: Partial<SeriesFiscales> = {};
    for (const tipo of Object.keys(CLAVES_SERIES_FISCALES) as TipoSerieFiscal[]) {
      const valor = dto.series[tipo];
      if (valor !== undefined && valor !== null) series[tipo] = String(valor).trim().toUpperCase();
    }
    if (Object.keys(series).length) cambios.series = series;
  }

  if (dto.emisor) {
    const e = dto.emisor;
    const emisor: Partial<CamposEmisorEditables> = {};
    if (e.razon_social !== undefined) emisor.razonSocial = e.razon_social.trim();
    if (e.nombre_comercial !== undefined) emisor.nombreComercial = e.nombre_comercial.trim();
    if (e.direccion !== undefined) emisor.direccion = e.direccion.trim();
    if (e.ubigeo !== undefined) emisor.ubigeo = e.ubigeo.trim();
    if (e.distrito !== undefined) emisor.distrito = e.distrito.trim();
    if (e.provincia !== undefined) emisor.provincia = e.provincia.trim();
    if (e.departamento !== undefined) emisor.departamento = e.departamento.trim();
    if (e.codigo_establecimiento !== undefined) emisor.codigoEstablecimiento = e.codigo_establecimiento.trim();
    if (Object.keys(emisor).length) cambios.emisor = emisor;
  }

  if (dto.sol) {
    cambios.solUsuario = normalizarUsuarioSol(dto.sol.usuario, rucEmisor);
    if (dto.sol.clave !== undefined && dto.sol.clave !== null && dto.sol.clave !== '') {
      cambios.solClave = validarClaveSol(dto.sol.clave);
    }
  }

  if (dto.gre) {
    const gre: NonNullable<CambiosConfigFiscal['gre']> = {};
    if (dto.gre.activa !== undefined) gre.activa = dto.gre.activa;
    if (dto.gre.correlativo_inicial !== undefined) gre.correlativoInicial = Math.trunc(dto.gre.correlativo_inicial);
    if (dto.gre.partida) {
      const p = dto.gre.partida;
      const partida: CambiosPartida = {};
      if (p.ubigeo !== undefined) partida.ubigeo = vacioANull(p.ubigeo);
      if (p.direccion !== undefined) partida.direccion = vacioANull(p.direccion);
      if (p.codigo_establecimiento !== undefined) partida.codigoEstablecimiento = vacioANull(p.codigo_establecimiento);
      if (Object.keys(partida).length) gre.partida = partida;
    }
    if (Object.keys(gre).length) cambios.gre = gre;
  }
  return cambios;
}

export function hayCambios(cambios: CambiosConfigFiscal): boolean {
  return Object.keys(cambios).length > 0;
}

function proyectarGre(actual: ConfigGreFiscal, cambios: CambiosConfigFiscal['gre'], series: SeriesFiscales, emisor: EmisorFiscal): ConfigGreFiscal {
  const partidaCambios = cambios?.partida ?? {};
  const resolver = (campo: keyof PuntoPartidaGre): { valor: string; heredada: boolean } => {
    if (campo in partidaCambios) {
      const valor = partidaCambios[campo];
      return valor ? { valor, heredada: false } : { valor: emisor[campo], heredada: true };
    }
    // Sin cambio: lo propio se conserva; lo heredado sigue al emisor (que pudo cambiar en este mismo PUT).
    return actual.partidaHeredada[campo]
      ? { valor: emisor[campo], heredada: true }
      : { valor: actual.partida[campo], heredada: false };
  };
  const ubigeo = resolver('ubigeo');
  const direccion = resolver('direccion');
  const codigo = resolver('codigoEstablecimiento');
  return {
    activa: cambios?.activa ?? actual.activa,
    serie: series.gre_remitente,
    correlativoInicial: cambios?.correlativoInicial ?? actual.correlativoInicial,
    partida: { ubigeo: ubigeo.valor, direccion: direccion.valor, codigoEstablecimiento: codigo.valor },
    partidaHeredada: { ubigeo: ubigeo.heredada, direccion: direccion.heredada, codigoEstablecimiento: codigo.heredada },
  };
}

/** Estado que quedaría si se aplican los cambios. */
export function proyectarSnapshot(
  actual: SnapshotConfigFiscal,
  cambios: CambiosConfigFiscal,
  nuevaConfirmacion: ConfirmacionNoOse | null,
): SnapshotConfigFiscal {
  const series: SeriesFiscales = { ...actual.series, ...(cambios.series ?? {}) };
  const emisor: EmisorFiscal = { ...actual.emisor, ...(cambios.emisor ?? {}) };
  const confirmacion =
    cambios.confirmoNoOse === undefined ? actual.confirmacionNoOse : cambios.confirmoNoOse ? nuevaConfirmacion : null;
  return {
    proveedor: cambios.proveedor ?? actual.proveedor,
    ambiente: cambios.ambiente ?? actual.ambiente,
    boletasModo: cambios.boletasModo ?? actual.boletasModo,
    envioEnLinea: cambios.envioEnLinea ?? actual.envioEnLinea,
    tareasActivas: cambios.tareasActivas ?? actual.tareasActivas,
    series,
    emisor,
    codigoProductoDefecto:
      cambios.codigoProductoDefecto === undefined ? actual.codigoProductoDefecto : cambios.codigoProductoDefecto,
    solUsuario: cambios.solUsuario ?? actual.solUsuario,
    confirmacionNoOse: confirmacion,
    reglas2027: cambios.reglas2027 ?? actual.reglas2027,
    gre: proyectarGre(actual.gre, cambios.gre, series, emisor),
    posBetaActivo: actual.posBetaActivo,
    correlativoInicialCpe: { ...actual.correlativoInicialCpe, ...(cambios.correlativoInicial ?? {}) },
    correlativoInicialRevisado: actual.correlativoInicialRevisado || cambios.correlativoInicial !== undefined,
    certRucConfirmadoProduccion: cambios.certRucConfirmado ?? actual.certRucConfirmadoProduccion,
    confirmaciones: { ...actual.confirmaciones, ...(cambios.confirmaciones ?? {}) },
    bloqueos: actual.bloqueos,
  };
}

/** Errores de forma que no dependen del checklist (series repetidas, correlativo de una serie que no se usa). */
export function validarCambios(cambios: CambiosConfigFiscal, futuro: SnapshotConfigFiscal): void {
  if (cambios.correlativoInicial) {
    const configuradas = TIPOS_SERIE_CPE.map((tipo) => futuro.series[tipo]);
    const ajenas = Object.keys(cambios.correlativoInicial).filter((serie) => !configuradas.includes(serie));
    if (ajenas.length) {
      throw new FiscalConfigError(
        'FISCAL_CONFIG_INVALIDA',
        `El correlativo inicial solo se fija para las series configuradas (${configuradas.join(', ')}); ${ajenas.join(', ')} no lo está.`,
        { series: ajenas },
      );
    }
  }
  if (cambios.series) {
    const problemas = problemasSeriesCpe(futuro);
    if (problemas.length) {
      throw new FiscalConfigError(
        'FISCAL_CONFIG_INVALIDA',
        `Revise las series: ${problemas.join(' ')} Cada tipo de documento necesita su propia serie.`,
        { problemas },
      );
    }
  }
}

function noListo(
  mensaje: string,
  faltantes: readonly string[],
  checklist: 'cpe' | 'gre' | null,
  items: ItemChecklist[] = [],
): FiscalConfigError {
  return new FiscalConfigError('FISCAL_NO_LISTO', mensaje, {
    faltantes: [...faltantes],
    checklist,
    items: items.filter((i) => !i.ok).map(({ codigo, titulo, detalle, accion }) => ({ codigo, titulo, detalle, accion })),
  });
}

const FALTANTES_CERTIFICADO: readonly CodigoFaltante[] = [
  FALTANTES.claveMaestra,
  FALTANTES.migracion,
  FALTANTES.certificadoProduccion,
  FALTANTES.certificadoVencido,
  FALTANTES.certificadoAutofirmado,
  FALTANTES.certificadoClaveDebil,
  FALTANTES.rucCertificado,
];

/**
 * Reglas de transición (§5.3 del diseño + GRE + D1.4). Lanza FISCAL_NO_LISTO (409)
 * con los faltantes; devuelve advertencias no bloqueantes.
 *
 * 'sunat_directo' es la emisión de PRODUCCIÓN: exige el checklist cpe completo (certificado, SOL,
 * emisor, series, correlativo revisado, no OSE y las confirmaciones de SOL). 'nubefact' = sin
 * emisión electrónica: desactivarla siempre se permite.
 */
export function validarTransicion(
  actual: SnapshotConfigFiscal,
  futuro: SnapshotConfigFiscal,
  preparacion: ResultadoPreparacion,
): { advertencias: string[] } {
  const cpe = preparacion.checklist.cpe;
  const gre = preparacion.checklist.gre;

  // Pasar a producción exige un certificado de producción vigente y no autofirmado.
  if (futuro.ambiente === 'produccion' && actual.ambiente !== 'produccion') {
    const faltantes = cpe.faltantes.filter((f) => FALTANTES_CERTIFICADO.includes(f));
    if (faltantes.length) {
      throw noListo(
        'Para pasar a producción primero suba el certificado digital de producción (vigente y emitido por una entidad autorizada).',
        faltantes,
        'cpe',
        cpe.items.filter((i) => FALTANTES_CERTIFICADO.includes(i.codigo)),
      );
    }
  }

  // Emisión de producción (factura, boleta y notas): solo con el ambiente de producción y todo listo, incluso si ya estaba activa.
  if (futuro.proveedor === 'sunat_directo') {
    if (futuro.ambiente !== 'produccion') {
      throw noListo(
        'La emisión de producción (SUNAT directo) solo se activa con el ambiente de producción: las ventas reales nunca van a SUNAT BETA. '
          + 'Para hacer pruebas use el ambiente BETA con la emisión de prueba del POS.',
        ['ambiente_produccion'],
        'cpe',
      );
    }
    if (!cpe.listo) {
      throw noListo(
        actual.proveedor === 'sunat_directo'
          ? 'Ese cambio dejaría la emisión de producción sin lo necesario para emitir. Complete lo que falta o desactive la emisión electrónica.'
          : 'Todavía no se puede activar la emisión de producción. Complete lo que falta en la lista.',
        cpe.faltantes,
        'cpe',
        cpe.items,
      );
    }
  }

  // GRE remitente electrónica: mismas exigencias, con su propio checklist.
  if (futuro.gre.activa) {
    if (futuro.ambiente !== 'produccion') {
      throw noListo('La guía de remisión electrónica solo se activa con el ambiente de producción.', ['ambiente_produccion'], 'gre');
    }
    if (!gre.listo) {
      throw noListo(
        actual.gre.activa
          ? 'Ese cambio dejaría la guía de remisión electrónica sin lo necesario para emitir. Complete lo que falta o desactívela.'
          : 'Todavía no se puede activar la guía de remisión electrónica. Complete lo que falta en la lista.',
        gre.faltantes,
        'gre',
        gre.items,
      );
    }
  }

  const advertencias: string[] = [];
  if (futuro.proveedor === 'sunat_directo' && actual.proveedor !== 'sunat_directo') {
    advertencias.push(
      'Desde ahora las ventas se emiten directo a SUNAT (producción). Para detenerla al instante, desactive la emisión electrónica.',
    );
  }
  if (actual.proveedor === 'sunat_directo' && futuro.proveedor !== 'sunat_directo') {
    advertencias.push(
      'La emisión electrónica de producción quedó desactivada: las ventas nuevas se registran sin comprobante y quedan en «ventas sin comprobante».',
    );
  }
  return { advertencias };
}

/** Claves de `configuraciones` que se escriben (solo las que vinieron en el PUT). */
export function paresParaGuardar(cambios: CambiosConfigFiscal, futuro: SnapshotConfigFiscal): Record<string, string> {
  const pares: Record<string, string> = {};
  const c = CLAVES_CONFIG_FISCAL;
  if (cambios.proveedor !== undefined) pares[c.proveedor] = futuro.proveedor;
  if (cambios.ambiente !== undefined) pares[c.ambiente] = futuro.ambiente;
  if (cambios.boletasModo !== undefined) pares[c.boletasModo] = futuro.boletasModo;
  if (cambios.envioEnLinea !== undefined) pares[c.envioEnLinea] = String(futuro.envioEnLinea);
  if (cambios.tareasActivas !== undefined) pares[c.tareasActivas] = String(futuro.tareasActivas);
  if (cambios.reglas2027 !== undefined) pares[c.reglas2027] = futuro.reglas2027;
  if (cambios.codigoProductoDefecto !== undefined) pares[c.codigoProductoDefecto] = futuro.codigoProductoDefecto ?? '';
  if (cambios.solUsuario !== undefined) pares[c.solUsuario] = futuro.solUsuario ?? '';
  if (cambios.confirmoNoOse !== undefined) {
    pares[c.confirmacionNoOse] = futuro.confirmacionNoOse ? JSON.stringify(futuro.confirmacionNoOse) : '';
  }
  if (cambios.correlativoInicial !== undefined) pares[c.correlativoInicialCpe] = JSON.stringify(futuro.correlativoInicialCpe);
  if (cambios.certRucConfirmado !== undefined) pares[c.certRucConfirmadoProduccion] = futuro.certRucConfirmadoProduccion ? 'true' : '';
  for (const campo of Object.keys(cambios.confirmaciones ?? {}) as Array<keyof ConfirmacionesActivacion>) {
    pares[CLAVES_CONFIRMACIONES_ACTIVACION[campo]] = futuro.confirmaciones[campo] ? 'true' : '';
  }

  for (const [tipo, serie] of Object.entries(cambios.series ?? {})) {
    pares[CLAVES_SERIES_FISCALES[tipo as TipoSerieFiscal]] = serie as string;
  }

  const e = cambios.emisor ?? {};
  const ce = CLAVES_EMISOR_FISCAL;
  if (e.razonSocial !== undefined) pares[ce.razonSocial] = futuro.emisor.razonSocial;
  if (e.nombreComercial !== undefined) pares[ce.nombreComercial] = futuro.emisor.nombreComercial ?? '';
  if (e.direccion !== undefined) pares[ce.direccion] = futuro.emisor.direccion;
  if (e.ubigeo !== undefined) pares[ce.ubigeo] = futuro.emisor.ubigeo;
  if (e.distrito !== undefined) pares[ce.distrito] = futuro.emisor.distrito;
  if (e.provincia !== undefined) pares[ce.provincia] = futuro.emisor.provincia;
  if (e.departamento !== undefined) pares[ce.departamento] = futuro.emisor.departamento;
  if (e.codigoEstablecimiento !== undefined) pares[ce.codigoEstablecimiento] = futuro.emisor.codigoEstablecimiento;
  // La pantalla /configuracion/fiscal y los PDF usan «DISTRITO - PROVINCIA - DEPARTAMENTO».
  if (e.distrito !== undefined || e.provincia !== undefined || e.departamento !== undefined) {
    const { distrito, provincia, departamento } = futuro.emisor;
    if (distrito && provincia && departamento) pares[ce.ubicacion] = `${distrito} - ${provincia} - ${departamento}`;
  }

  const g = cambios.gre;
  const cg = CLAVES_GRE_FISCAL;
  if (g?.activa !== undefined) pares[cg.activa] = String(futuro.gre.activa);
  if (g?.correlativoInicial !== undefined) pares[cg.correlativoInicial] = String(futuro.gre.correlativoInicial);
  if (g?.partida) {
    if ('ubigeo' in g.partida) pares[cg.partidaUbigeo] = g.partida.ubigeo ?? '';
    if ('direccion' in g.partida) pares[cg.partidaDireccion] = g.partida.direccion ?? '';
    if ('codigoEstablecimiento' in g.partida) pares[cg.partidaCodigoEstablecimiento] = g.partida.codigoEstablecimiento ?? '';
  }
  return pares;
}

type Diferencias = Record<string, { de: unknown; a: unknown }>;

function diferencias(pares: Array<[string, unknown, unknown]>): Diferencias {
  const resultado: Diferencias = {};
  for (const [campo, de, a] of pares) {
    if (JSON.stringify(de) !== JSON.stringify(a)) resultado[campo] = { de: de ?? null, a: a ?? null };
  }
  return resultado;
}

/** Eventos de auditoría de los cambios reales (sin secretos); el servicio agrega usuario e IP. */
export function eventosAuditoria(
  actual: SnapshotConfigFiscal,
  futuro: SnapshotConfigFiscal,
  cambios: CambiosConfigFiscal,
): EventoAuditoriaFiscal[] {
  const eventos: EventoAuditoriaFiscal[] = [];
  const A = ACCIONES_AUDITORIA_FISCAL;
  const agregar = (accion: string, detalle: Record<string, unknown>) =>
    eventos.push({ accion, entidad: 'configuraciones', id_entidad: 'fiscal', detalle });

  if (futuro.proveedor !== actual.proveedor) agregar(A.PROVEEDOR_CAMBIADO, { de: actual.proveedor, a: futuro.proveedor });
  if (futuro.ambiente !== actual.ambiente) agregar(A.AMBIENTE_CAMBIADO, { de: actual.ambiente, a: futuro.ambiente });

  const operacion = diferencias([
    ['boletas_modo', actual.boletasModo, futuro.boletasModo],
    ['envio_en_linea', actual.envioEnLinea, futuro.envioEnLinea],
    ['tareas_activas', actual.tareasActivas, futuro.tareasActivas],
    ['aplicar_reglas_2027', actual.reglas2027, futuro.reglas2027],
    ['codigo_producto_defecto', actual.codigoProductoDefecto, futuro.codigoProductoDefecto],
  ]);
  if (Object.keys(operacion).length) agregar(A.CONFIG_OPERACION, { cambios: operacion });

  const series = diferencias(
    (Object.keys(CLAVES_SERIES_FISCALES) as TipoSerieFiscal[]).map((t) => [t, actual.series[t], futuro.series[t]]),
  );
  if (Object.keys(series).length) agregar(A.SERIES, { cambios: series });

  const emisor = diferencias([
    ['razon_social', actual.emisor.razonSocial, futuro.emisor.razonSocial],
    ['nombre_comercial', actual.emisor.nombreComercial ?? '', futuro.emisor.nombreComercial ?? ''],
    ['direccion', actual.emisor.direccion, futuro.emisor.direccion],
    ['ubigeo', actual.emisor.ubigeo, futuro.emisor.ubigeo],
    ['distrito', actual.emisor.distrito, futuro.emisor.distrito],
    ['provincia', actual.emisor.provincia, futuro.emisor.provincia],
    ['departamento', actual.emisor.departamento, futuro.emisor.departamento],
    ['codigo_establecimiento', actual.emisor.codigoEstablecimiento, futuro.emisor.codigoEstablecimiento],
  ]);
  if (Object.keys(emisor).length) agregar(A.CONFIG_EMISOR, { cambios: emisor });

  if (cambios.solUsuario !== undefined || cambios.solClave !== undefined) {
    agregar(A.CRED_SOL_ACTUALIZADA, {
      usuario: { de: actual.solUsuario, a: futuro.solUsuario },
      clave_actualizada: cambios.solClave !== undefined,
    });
  }

  if (cambios.confirmoNoOse === true) {
    agregar(A.CONFIRMACION_NO_OSE, { declaracion: AVISO_LEGAL_OSE.confirmacion, normas: [...AVISO_LEGAL_OSE.normas] });
  } else if (cambios.confirmoNoOse === false && actual.confirmacionNoOse) {
    agregar(A.CONFIRMACION_NO_OSE_RETIRADA, { confirmada_el: actual.confirmacionNoOse.fecha });
  }

  const gre = diferencias([
    ['activa', actual.gre.activa, futuro.gre.activa],
    ['correlativo_inicial', actual.gre.correlativoInicial, futuro.gre.correlativoInicial],
    ['partida_ubigeo', actual.gre.partida.ubigeo, futuro.gre.partida.ubigeo],
    ['partida_direccion', actual.gre.partida.direccion, futuro.gre.partida.direccion],
    ['partida_codigo_establecimiento', actual.gre.partida.codigoEstablecimiento, futuro.gre.partida.codigoEstablecimiento],
  ]);
  if (Object.keys(gre).length) agregar(A.CONFIG_GRE, { cambios: gre });

  const confirmaciones = diferencias(
    CAMPOS_CONFIRMACIONES.map(([campo, nombreApi]) => [nombreApi, actual.confirmaciones[campo], futuro.confirmaciones[campo]]),
  );
  if (Object.keys(confirmaciones).length) agregar(A.CONFIRMACIONES_ACTIVACION, { cambios: confirmaciones });

  if (futuro.certRucConfirmadoProduccion !== actual.certRucConfirmadoProduccion) {
    agregar(A.CERT_RUC_CONFIRMADO, {
      de: actual.certRucConfirmadoProduccion,
      a: futuro.certRucConfirmadoProduccion,
      ruc_emisor: futuro.emisor.ruc,
    });
  }

  if (cambios.correlativoInicial) {
    const correlativos = diferencias(
      Object.keys(cambios.correlativoInicial).map((serie) => [
        serie,
        actual.correlativoInicialCpe[serie] ?? 1,
        futuro.correlativoInicialCpe[serie],
      ]),
    );
    // También se audita guardarlo sin cambios: deja constancia de que el administrador lo revisó.
    agregar(A.CORRELATIVO_INICIAL_CPE, { cambios: correlativos, revisado: true });
  }

  return eventos;
}
