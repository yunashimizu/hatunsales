import { emisorConfig } from '../../config/emisor.config';
import {
  AMBIENTES_FISCALES,
  AmbienteFiscal,
  BloqueoEmision,
  CLAVES_BLOQUEO_EMISION,
  CLAVES_CONFIG_FISCAL,
  CLAVES_CONFIRMACIONES_ACTIVACION,
  CLAVES_EMISOR_FISCAL,
  CLAVES_GRE_FISCAL,
  CLAVES_SERIES_FISCALES,
  CODIGO_ESTABLECIMIENTO_POR_DEFECTO,
  ConfigGreFiscal,
  ConfirmacionesActivacion,
  ConfirmacionNoOse,
  CORRELATIVO_MAXIMO,
  EmisorFiscal,
  MODOS_BOLETAS,
  MODOS_REGLAS_2027,
  PATRON_CODIGO_ESTABLECIMIENTO,
  PATRON_SERIE,
  PATRON_SERIE_CPE,
  PATRON_UBIGEO,
  PROVEEDORES_FISCALES,
  SERIES_FISCALES_POR_DEFECTO,
  SeriesFiscales,
  SnapshotConfigFiscal,
  TipoSerieFiscal,
} from './fiscal-config.tipos';

/**
 * Convierte las filas crudas de `configuraciones` en un SnapshotConfigFiscal
 * tipado y siempre válido (función pura). Lo que falte o esté mal escrito cae
 * en un valor por defecto seguro: nunca activa SUNAT directo por accidente.
 */

/** Valores por defecto heredados de variables de entorno (las SUNAT_* antiguas y EMISOR_*). */
export interface DefectosEntornoFiscal {
  ambiente: AmbienteFiscal;
  serieFactura: string;
  serieBoleta: string;
  serieGuia: string;
  emisor: { ruc: string; razonSocial: string; direccion: string; ubicacion: string };
}

export function defectosDesdeEntorno(env: NodeJS.ProcessEnv = process.env): DefectosEntornoFiscal {
  return {
    ambiente: (env.SUNAT_FISCAL_ENVIRONMENT ?? '').trim().toLowerCase() === 'produccion' ? 'produccion' : 'beta',
    serieFactura: (env.SUNAT_SERIE_FACTURA ?? '').trim().toUpperCase() || SERIES_FISCALES_POR_DEFECTO.factura,
    serieBoleta: (env.SUNAT_SERIE_BOLETA ?? '').trim().toUpperCase() || SERIES_FISCALES_POR_DEFECTO.boleta,
    serieGuia: (env.SUNAT_SERIE_GUIA ?? '').trim().toUpperCase() || SERIES_FISCALES_POR_DEFECTO.gre_remitente,
    emisor: {
      ruc: emisorConfig.ruc,
      razonSocial: emisorConfig.razon_social,
      direccion: emisorConfig.direccion,
      ubicacion: emisorConfig.ubicacion,
    },
  };
}

type Valores = Readonly<Record<string, string | null | undefined>>;

function texto(valores: Valores, clave: string): string | null {
  const valor = valores[clave];
  if (valor === null || valor === undefined) return null;
  const limpio = String(valor).trim();
  return limpio ? limpio : null;
}

function opcion<T extends string>(valor: string | null, opciones: readonly T[], porDefecto: T): T {
  const normalizado = (valor ?? '').toLowerCase() as T;
  return opciones.includes(normalizado) ? normalizado : porDefecto;
}

function booleano(valor: string | null, porDefecto: boolean): boolean {
  if (valor === null) return porDefecto;
  const normalizado = valor.toLowerCase();
  if (['true', '1', 'si', 'sí', 'on'].includes(normalizado)) return true;
  if (['false', '0', 'no', 'off'].includes(normalizado)) return false;
  return porDefecto;
}

/** 'LURIN - LIMA - LIMA' → distrito, provincia, departamento. */
export function partirUbicacion(ubicacion: string | null): { distrito: string; provincia: string; departamento: string } {
  const partes = (ubicacion ?? '').split(/\s*-\s*/).map((p) => p.trim()).filter(Boolean);
  if (partes.length !== 3) return { distrito: '', provincia: '', departamento: '' };
  const [distrito, provincia, departamento] = partes;
  return { distrito, provincia, departamento };
}

export function serieValida(tipo: TipoSerieFiscal, serie: string | null | undefined): boolean {
  return !!serie && PATRON_SERIE[tipo].test(serie);
}

/** Entero dentro de [minimo, maximo]; cualquier otra cosa cae en el valor por defecto. */
function entero(valor: string | null, porDefecto: number, minimo: number, maximo: number): number {
  if (valor === null || !/^\d{1,9}$/.test(valor)) return porDefecto;
  const numero = Number(valor);
  return numero >= minimo && numero <= maximo ? numero : porDefecto;
}

function leerSeries(valores: Valores, defectos: DefectosEntornoFiscal): SeriesFiscales {
  const base: SeriesFiscales = {
    ...SERIES_FISCALES_POR_DEFECTO,
    factura: serieValida('factura', defectos.serieFactura) ? defectos.serieFactura : SERIES_FISCALES_POR_DEFECTO.factura,
    boleta: serieValida('boleta', defectos.serieBoleta) ? defectos.serieBoleta : SERIES_FISCALES_POR_DEFECTO.boleta,
    gre_remitente: serieValida('gre_remitente', defectos.serieGuia)
      ? defectos.serieGuia
      : SERIES_FISCALES_POR_DEFECTO.gre_remitente,
  };
  const series = { ...base };
  for (const tipo of Object.keys(CLAVES_SERIES_FISCALES) as TipoSerieFiscal[]) {
    const valor = texto(valores, CLAVES_SERIES_FISCALES[tipo])?.toUpperCase() ?? null;
    if (serieValida(tipo, valor)) series[tipo] = valor!;
  }
  return series;
}

function leerEmisor(valores: Valores, defectos: DefectosEntornoFiscal): EmisorFiscal {
  const ubicacion = partirUbicacion(texto(valores, CLAVES_EMISOR_FISCAL.ubicacion) ?? defectos.emisor.ubicacion);
  const codigo = texto(valores, CLAVES_EMISOR_FISCAL.codigoEstablecimiento);
  return {
    ruc: texto(valores, CLAVES_EMISOR_FISCAL.ruc) ?? defectos.emisor.ruc,
    razonSocial: texto(valores, CLAVES_EMISOR_FISCAL.razonSocial) ?? defectos.emisor.razonSocial,
    nombreComercial: texto(valores, CLAVES_EMISOR_FISCAL.nombreComercial) ?? '',
    direccion: texto(valores, CLAVES_EMISOR_FISCAL.direccion) ?? defectos.emisor.direccion,
    ubigeo: texto(valores, CLAVES_EMISOR_FISCAL.ubigeo) ?? '',
    distrito: texto(valores, CLAVES_EMISOR_FISCAL.distrito) ?? ubicacion.distrito,
    provincia: texto(valores, CLAVES_EMISOR_FISCAL.provincia) ?? ubicacion.provincia,
    departamento: texto(valores, CLAVES_EMISOR_FISCAL.departamento) ?? ubicacion.departamento,
    codigoEstablecimiento: codigo && PATRON_CODIGO_ESTABLECIMIENTO.test(codigo) ? codigo : CODIGO_ESTABLECIMIENTO_POR_DEFECTO,
  };
}

/**
 * GRE remitente: el punto de partida por defecto es el del emisor (domicilio
 * fiscal) mientras no se configure otro desde el panel.
 */
function leerGre(valores: Valores, series: SeriesFiscales, emisor: EmisorFiscal): ConfigGreFiscal {
  const ubigeo = texto(valores, CLAVES_GRE_FISCAL.partidaUbigeo);
  const direccion = texto(valores, CLAVES_GRE_FISCAL.partidaDireccion);
  const codigo = texto(valores, CLAVES_GRE_FISCAL.partidaCodigoEstablecimiento);
  const ubigeoPropio = !!ubigeo && PATRON_UBIGEO.test(ubigeo);
  const codigoPropio = !!codigo && PATRON_CODIGO_ESTABLECIMIENTO.test(codigo);

  return {
    activa: booleano(texto(valores, CLAVES_GRE_FISCAL.activa), false),
    serie: series.gre_remitente,
    correlativoInicial: entero(texto(valores, CLAVES_GRE_FISCAL.correlativoInicial), 1, 1, CORRELATIVO_MAXIMO),
    partida: Object.freeze({
      ubigeo: ubigeoPropio ? ubigeo! : emisor.ubigeo,
      direccion: direccion ?? emisor.direccion,
      codigoEstablecimiento: codigoPropio ? codigo! : emisor.codigoEstablecimiento,
    }),
    partidaHeredada: Object.freeze({
      ubigeo: !ubigeoPropio,
      direccion: !direccion,
      codigoEstablecimiento: !codigoPropio,
    }),
  };
}

/** Ambiente guardado o, si no es válido, el que dan las variables de entorno. */
export function leerAmbiente(valor: string | null | undefined, porDefecto: AmbienteFiscal): AmbienteFiscal {
  const limpio = (valor ?? '').trim();
  return opcion(limpio ? limpio : null, AMBIENTES_FISCALES, porDefecto);
}

/**
 * Correlativo inicial por serie (D2): {"F001": 120}. Solo series de comprobante con enteros de 1 a
 * CORRELATIVO_MAXIMO; una entrada mal escrita se ignora (esa serie empieza en MAX + 1, como siempre).
 */
export function leerCorrelativoInicialCpe(valor: string | null | undefined): Record<string, number> {
  if (!valor) return {};
  let dato: unknown;
  try {
    dato = JSON.parse(valor);
  } catch {
    return {};
  }
  if (!dato || typeof dato !== 'object' || Array.isArray(dato)) return {};
  const resultado: Record<string, number> = {};
  for (const [clave, numero] of Object.entries(dato as Record<string, unknown>)) {
    const serie = clave.trim().toUpperCase();
    const entero = typeof numero === 'string' && /^\d{1,9}$/.test(numero.trim()) ? Number(numero) : numero;
    if (PATRON_SERIE_CPE.test(serie) && Number.isSafeInteger(entero) && (entero as number) >= 1 && (entero as number) <= CORRELATIVO_MAXIMO) {
      resultado[serie] = entero as number;
    }
  }
  return resultado;
}

const MOTIVO_BLOQUEO_DESCONOCIDO =
  'La emisión quedó detenida por un rechazo de SUNAT a la credencial SOL o al certificado. Revise ambos y reanude la emisión desde el panel.';

/**
 * Interruptor del ambiente (D5.4). Vacío o un «false» explícito = emisión normal. Cualquier otro valor
 * cuenta como detenido (ante la duda no se llama a SUNAT con una credencial que ya rechazó).
 */
export function leerBloqueoEmision(valor: string | null | undefined): BloqueoEmision | null {
  const limpio = (valor ?? '').trim();
  if (!limpio || ['false', '0', 'no', 'off'].includes(limpio.toLowerCase())) return null;
  try {
    const dato = JSON.parse(limpio);
    if (dato && typeof dato === 'object' && !Array.isArray(dato)) {
      return {
        codigo: typeof dato.codigo === 'string' ? dato.codigo : String(dato.codigo ?? ''),
        motivo: typeof dato.motivo === 'string' && dato.motivo.trim() ? dato.motivo : MOTIVO_BLOQUEO_DESCONOCIDO,
        fecha: typeof dato.fecha === 'string' ? dato.fecha : '',
      };
    }
  } catch {
    // Texto libre escrito a mano: se trata como detenido con el motivo genérico.
  }
  return { codigo: '', motivo: MOTIVO_BLOQUEO_DESCONOCIDO, fecha: '' };
}

/** Las banderas que habilitan emitir solo cuentan con el 'true' exacto que escribe el panel. */
function marcado(valores: Valores, clave: string): boolean {
  return texto(valores, clave) === 'true';
}

function leerConfirmaciones(valores: Valores): ConfirmacionesActivacion {
  const c = CLAVES_CONFIRMACIONES_ACTIVACION;
  return {
    emisorElectronicoSol: marcado(valores, c.emisorElectronicoSol),
    certificadoEnSol: marcado(valores, c.certificadoEnSol),
    usuarioSolSecundario: marcado(valores, c.usuarioSolSecundario),
    rucHabido: marcado(valores, c.rucHabido),
  };
}

/** Solo cuenta una confirmación explícita hecha desde el panel (JSON con fecha). */
export function leerConfirmacion(valor: string | null): ConfirmacionNoOse | null {
  if (!valor) return null;
  try {
    const dato = JSON.parse(valor);
    if (!dato || typeof dato !== 'object' || typeof dato.fecha !== 'string' || !dato.fecha) return null;
    return {
      id_usuario: Number.isFinite(Number(dato.id_usuario)) && dato.id_usuario !== null ? Number(dato.id_usuario) : null,
      nombre: typeof dato.nombre === 'string' ? dato.nombre : null,
      fecha: dato.fecha,
      ip: typeof dato.ip === 'string' ? dato.ip : null,
    };
  } catch {
    return null;
  }
}

export function construirSnapshot(valores: Valores, defectos: DefectosEntornoFiscal): SnapshotConfigFiscal {
  const codigoProducto = texto(valores, CLAVES_CONFIG_FISCAL.codigoProductoDefecto);
  const usuarioSol = texto(valores, CLAVES_CONFIG_FISCAL.solUsuario)?.toUpperCase() ?? null;
  const series = Object.freeze(leerSeries(valores, defectos));
  const emisor = Object.freeze(leerEmisor(valores, defectos));

  const correlativoInicial = texto(valores, CLAVES_CONFIG_FISCAL.correlativoInicialCpe);

  return Object.freeze({
    proveedor: opcion(texto(valores, CLAVES_CONFIG_FISCAL.proveedor), PROVEEDORES_FISCALES, 'nubefact'),
    ambiente: leerAmbiente(texto(valores, CLAVES_CONFIG_FISCAL.ambiente), defectos.ambiente),
    boletasModo: opcion(texto(valores, CLAVES_CONFIG_FISCAL.boletasModo), MODOS_BOLETAS, 'individual'),
    envioEnLinea: booleano(texto(valores, CLAVES_CONFIG_FISCAL.envioEnLinea), true),
    tareasActivas: booleano(texto(valores, CLAVES_CONFIG_FISCAL.tareasActivas), true),
    series,
    emisor,
    codigoProductoDefecto: codigoProducto && /^\d{8}$/.test(codigoProducto) ? codigoProducto : null,
    solUsuario: usuarioSol && /^[A-Z0-9]{8}$/.test(usuarioSol) ? usuarioSol : null,
    confirmacionNoOse: leerConfirmacion(texto(valores, CLAVES_CONFIG_FISCAL.confirmacionNoOse)),
    reglas2027: opcion(texto(valores, CLAVES_CONFIG_FISCAL.reglas2027), MODOS_REGLAS_2027, 'auto'),
    gre: Object.freeze(leerGre(valores, series, emisor)),
    posBetaActivo: marcado(valores, CLAVES_CONFIG_FISCAL.posBetaActivo),
    correlativoInicialCpe: Object.freeze(leerCorrelativoInicialCpe(correlativoInicial)),
    correlativoInicialRevisado: correlativoInicial !== null,
    certRucConfirmadoProduccion: marcado(valores, CLAVES_CONFIG_FISCAL.certRucConfirmadoProduccion),
    confirmaciones: Object.freeze(leerConfirmaciones(valores)),
    bloqueos: Object.freeze({
      beta: leerBloqueoEmision(texto(valores, CLAVES_BLOQUEO_EMISION.beta)),
      produccion: leerBloqueoEmision(texto(valores, CLAVES_BLOQUEO_EMISION.produccion)),
    }),
  });
}
