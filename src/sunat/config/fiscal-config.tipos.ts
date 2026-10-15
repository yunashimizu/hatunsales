/**
 * Tipos y claves de la configuración fiscal (proveedor, ambiente, series y
 * emisor). La fuente de verdad es la tabla `configuraciones`; las variables de
 * entorno antiguas (SUNAT_*) solo aportan valores por defecto.
 */

export const PROVEEDORES_FISCALES = ['nubefact', 'sunat_directo'] as const;
export type ProveedorFiscal = (typeof PROVEEDORES_FISCALES)[number];

export const AMBIENTES_FISCALES = ['beta', 'produccion'] as const;
export type AmbienteFiscal = (typeof AMBIENTES_FISCALES)[number];

export const MODOS_BOLETAS = ['individual', 'resumen'] as const;
export type ModoBoletas = (typeof MODOS_BOLETAS)[number];

export const MODOS_REGLAS_2027 = ['auto', 'true', 'false'] as const;
export type ModoReglas2027 = (typeof MODOS_REGLAS_2027)[number];

/** Series de SUNAT directo por tipo de documento (nombres iguales a los del API). */
export interface SeriesFiscales {
  factura: string;
  boleta: string;
  nc_factura: string;
  nc_boleta: string;
  nd_factura: string;
  nd_boleta: string;
  /** Guía de remisión electrónica remitente (tipo 09): T + 3 caracteres. */
  gre_remitente: string;
}
export type TipoSerieFiscal = keyof SeriesFiscales;

/** Series de factura, boleta y sus notas (comparten la tabla comprobantes y su índice serie+número). */
export const TIPOS_SERIE_CPE: readonly TipoSerieFiscal[] = [
  'factura', 'boleta', 'nc_factura', 'nc_boleta', 'nd_factura', 'nd_boleta',
];

/** Punto de partida por defecto de la GRE remitente (normalmente, el domicilio fiscal). */
export interface PuntoPartidaGre {
  /** Ubigeo INEI de 6 dígitos. */
  ubigeo: string;
  direccion: string;
  /** Código de establecimiento anexo registrado en SUNAT ('0000' = domicilio fiscal). */
  codigoEstablecimiento: string;
}

/** Configuración de la Guía de Remisión Electrónica Remitente (API REST de SUNAT). */
export interface ConfigGreFiscal {
  /** true = las GRE remitente se envían a SUNAT. false (por defecto) = como hoy, solo se guardan en el sistema. */
  activa: boolean;
  serie: string;
  /**
   * Primer número que usará el sistema en la serie si todavía no hay guías
   * suyas (para continuar una numeración usada antes, p. ej. en SEE-SOL).
   */
  correlativoInicial: number;
  partida: PuntoPartidaGre;
  /** true en cada campo que no se configuró y se toma del emisor. */
  partidaHeredada: Readonly<Record<keyof PuntoPartidaGre, boolean>>;
}

/** Mismos campos que EmisorCpe del núcleo (contrato §12.1 del diseño). */
export interface EmisorFiscal {
  ruc: string;
  razonSocial: string;
  nombreComercial?: string;
  direccion: string;
  ubigeo: string;
  distrito: string;
  provincia: string;
  departamento: string;
  codigoEstablecimiento: string;
}

/** Quién confirmó que la empresa no está en SEE-OSE (queda en configuraciones y en la auditoría). */
export interface ConfirmacionNoOse {
  id_usuario: number | null;
  nombre: string | null;
  fecha: string;
  ip?: string | null;
}

/** Foto inmutable de toda la configuración fiscal, leída de una sola consulta. */
export interface SnapshotConfigFiscal {
  readonly proveedor: ProveedorFiscal;
  readonly ambiente: AmbienteFiscal;
  readonly boletasModo: ModoBoletas;
  readonly envioEnLinea: boolean;
  readonly tareasActivas: boolean;
  readonly series: Readonly<SeriesFiscales>;
  readonly emisor: Readonly<EmisorFiscal>;
  readonly codigoProductoDefecto: string | null;
  readonly solUsuario: string | null;
  readonly confirmacionNoOse: Readonly<ConfirmacionNoOse> | null;
  readonly reglas2027: ModoReglas2027;
  readonly gre: Readonly<ConfigGreFiscal>;
}

/** Quién hace un cambio (para auditoría). */
export interface ActorFiscal {
  id_usuario: number | null;
  nombre: string | null;
  ip: string | null;
}

export const ACTOR_SISTEMA: ActorFiscal = { id_usuario: null, nombre: 'sistema', ip: null };

export const CLAVES_CONFIG_FISCAL = {
  proveedor: 'fiscal_proveedor',
  ambiente: 'fiscal_ambiente',
  boletasModo: 'fiscal_boletas_modo',
  envioEnLinea: 'fiscal_envio_en_linea',
  tareasActivas: 'fiscal_tareas_activas',
  solUsuario: 'fiscal_sol_usuario',
  codigoProductoDefecto: 'fiscal_codigo_producto_defecto',
  confirmacionNoOse: 'fiscal_confirmacion_no_ose',
  betaCorrelativo: 'fiscal_beta_correlativo',
  reglas2027: 'fiscal_aplicar_reglas_2027',
} as const;

export const CLAVES_SERIES_FISCALES: Readonly<Record<TipoSerieFiscal, string>> = {
  factura: 'fiscal_serie_factura',
  boleta: 'fiscal_serie_boleta',
  nc_factura: 'fiscal_serie_nc_factura',
  nc_boleta: 'fiscal_serie_nc_boleta',
  nd_factura: 'fiscal_serie_nd_factura',
  nd_boleta: 'fiscal_serie_nd_boleta',
  gre_remitente: 'fiscal_serie_gre_remitente',
};

/** Claves de la GRE remitente (no secretas; las credenciales API van cifradas en fiscal_secretos). */
export const CLAVES_GRE_FISCAL = {
  activa: 'fiscal_gre_activa',
  correlativoInicial: 'fiscal_gre_correlativo_inicial',
  partidaUbigeo: 'fiscal_gre_partida_ubigeo',
  partidaDireccion: 'fiscal_gre_partida_direccion',
  partidaCodigoEstablecimiento: 'fiscal_gre_partida_codigo_establecimiento',
} as const;

/** Claves del emisor (las cuatro primeras ya existen y las usa /configuracion/fiscal). */
export const CLAVES_EMISOR_FISCAL = {
  ruc: 'emisor_ruc',
  razonSocial: 'emisor_razon_social',
  direccion: 'emisor_direccion',
  ubicacion: 'emisor_ubicacion',
  nombreComercial: 'emisor_nombre_comercial',
  ubigeo: 'emisor_ubigeo',
  distrito: 'emisor_distrito',
  provincia: 'emisor_provincia',
  departamento: 'emisor_departamento',
  codigoEstablecimiento: 'emisor_codigo_establecimiento',
} as const;

/** Todas las claves que forman el snapshot: se leen con una sola consulta. */
export const CLAVES_SNAPSHOT_FISCAL: readonly string[] = [
  ...Object.values(CLAVES_CONFIG_FISCAL),
  ...Object.values(CLAVES_SERIES_FISCALES),
  ...Object.values(CLAVES_EMISOR_FISCAL),
  ...Object.values(CLAVES_GRE_FISCAL),
];

export const SERIES_FISCALES_POR_DEFECTO: Readonly<SeriesFiscales> = {
  factura: 'F001',
  boleta: 'B001',
  nc_factura: 'FC01',
  nc_boleta: 'BC01',
  nd_factura: 'FD01',
  nd_boleta: 'BD01',
  gre_remitente: 'T001',
};

/** Factura y sus notas empiezan con F; boleta y sus notas con B; la GRE remitente con T (4 caracteres). */
export const PATRON_SERIE: Readonly<Record<TipoSerieFiscal, RegExp>> = {
  factura: /^F[A-Z0-9]{3}$/,
  boleta: /^B[A-Z0-9]{3}$/,
  nc_factura: /^F[A-Z0-9]{3}$/,
  nc_boleta: /^B[A-Z0-9]{3}$/,
  nd_factura: /^F[A-Z0-9]{3}$/,
  nd_boleta: /^B[A-Z0-9]{3}$/,
  gre_remitente: /^T[A-Z0-9]{3}$/,
};

export const CODIGO_ESTABLECIMIENTO_POR_DEFECTO = '0000';
export const PATRON_UBIGEO = /^\d{6}$/;
export const PATRON_CODIGO_ESTABLECIMIENTO = /^\d{4}$/;
export const CORRELATIVO_MAXIMO = 99_999_999;

/**
 * Aviso legal (RS 117-2017/SUNAT arts. 11.1 y 12.2, texto de la RS 239-2018):
 * quien está en SEE-OSE, o es principal contribuyente o agente de retención o
 * percepción del IGV, no puede emitir por SEE-Del Contribuyente.
 */
export const AVISO_LEGAL_OSE = {
  titulo: 'Antes de activar SUNAT directo',
  texto:
    'Si HatunSales tiene registrado un OSE en SOL (por ejemplo, NUBEFACT como OSE), o es principal '
    + 'contribuyente o agente de retención o percepción del IGV, no puede emitir por SEE - Del Contribuyente '
    + '(RS 117-2017/SUNAT, arts. 11.1 y 12.2, y RS 239-2018/SUNAT). Revíselo en SOL y en la Consulta RUC '
    + 'antes de activar. Si aplica alguna de esas condiciones, siga emitiendo con Nubefact.',
  confirmacion:
    'Confirmo que HatunSales NO tiene un OSE registrado en SOL y no es principal contribuyente ni agente '
    + 'de retención o percepción del IGV.',
  normas: ['RS 117-2017/SUNAT', 'RS 239-2018/SUNAT'],
} as const;
