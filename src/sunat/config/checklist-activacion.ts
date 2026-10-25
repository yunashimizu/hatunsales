import type { DiagnosticoSecreto } from '../seguridad/boveda-secretos.service';
import {
  AmbienteFiscal,
  PATRON_CODIGO_ESTABLECIMIENTO,
  PATRON_SERIE,
  PATRON_UBIGEO,
  SnapshotConfigFiscal,
  TIPOS_SERIE_CPE,
} from './fiscal-config.tipos';
import { diasHasta, fechaEnLima } from './reloj-fiscal';
import { Ruc } from './ruc';

/**
 * Checklist de activación de SUNAT directo, SEPARADO por tipo de documento:
 * - cpe: factura, boleta y notas de crédito/débito (SOAP billService);
 * - gre: guía de remisión electrónica remitente (API REST con OAuth2).
 *
 * La evaluación es una función pura sobre «hechos» ya reunidos (sin BD ni red),
 * así se prueba con facilidad y se puede evaluar un estado FUTURO antes de
 * guardarlo (reglas de transición del PUT /fiscal/configuracion).
 */

export type TipoChecklist = 'cpe' | 'gre';

/** Días antes del vencimiento del certificado en los que se avisa. */
export const DIAS_AVISO_VENCIMIENTO = 30;

/** Códigos estables de lo que puede faltar (el panel los traduce o muestra `titulo`). */
export const FALTANTES = {
  claveMaestra: 'FISCAL_SECRET_KEY',
  migracion: 'migracion_fase9',
  certificadoProduccion: 'certificado_produccion',
  certificadoVencido: 'certificado_vencido',
  certificadoAutofirmado: 'certificado_autofirmado',
  certificadoClaveDebil: 'certificado_clave_debil',
  rucCertificado: 'ruc_certificado',
  usuarioSol: 'usuario_sol',
  claveSol: 'clave_sol',
  emisorRuc: 'emisor.ruc',
  emisorRazonSocial: 'emisor.razon_social',
  emisorDireccion: 'emisor.direccion',
  emisorUbigeo: 'emisor.ubigeo',
  emisorDistrito: 'emisor.distrito',
  emisorProvincia: 'emisor.provincia',
  emisorDepartamento: 'emisor.departamento',
  emisorCodigoEstablecimiento: 'emisor.codigo_establecimiento',
  series: 'series',
  confirmacionNoOse: 'confirmacion_no_ose',
  certRucSinConfirmar: 'cert_ruc_confirmado',
  correlativoInicial: 'correlativo_inicial',
  confirmacionEmisorElectronico: 'confirmacion.emisor_electronico_sol',
  confirmacionCertificadoSol: 'confirmacion.certificado_en_sol',
  confirmacionUsuarioSecundario: 'confirmacion.usuario_sol_secundario',
  confirmacionRucHabido: 'confirmacion.ruc_habido',
  greCredenciales: 'gre.credenciales_api',
  greSerie: 'gre.serie',
  grePartidaUbigeo: 'gre.partida.ubigeo',
  grePartidaDireccion: 'gre.partida.direccion',
  grePartidaCodigo: 'gre.partida.codigo_establecimiento',
  certificadoBeta: 'certificado_beta',
} as const;
export type CodigoFaltante = (typeof FALTANTES)[keyof typeof FALTANTES];

export interface ItemChecklist {
  codigo: CodigoFaltante;
  titulo: string;
  ok: boolean;
  /** Qué está mal (null si ok). */
  detalle: string | null;
  /** Qué hacer para resolverlo (null si ok). */
  accion: string | null;
}

export interface ChecklistDocumento {
  tipo: TipoChecklist;
  titulo: string;
  documentos: string[];
  listo: boolean;
  faltantes: CodigoFaltante[];
  items: ItemChecklist[];
}

export interface ResultadoPreparacion {
  /** Factura, boleta y notas listas para emitirse en PRODUCCIÓN por SUNAT directo (§5.3 del diseño). */
  listo: boolean;
  /** Faltantes de factura/boleta/notas (los de la GRE están en checklist.gre). */
  faltantes: CodigoFaltante[];
  advertencias: string[];
  checklist: Record<TipoChecklist, ChecklistDocumento>;
  /** Lo mínimo para «Probar conexión» en SUNAT BETA. */
  pruebas_beta: { listo: boolean; faltantes: CodigoFaltante[] };
  evaluado_en: string;
}

/** Lo que el checklist necesita saber de un certificado (sin secretos). */
export interface CertificadoParaChecklist {
  ruc: string | null;
  vigenteDesde: Date;
  vigenteHasta: Date;
  autofirmado: boolean;
  bitsClave: number | null;
  /** false si está guardado pero no se puede abrir con la llave actual. */
  legible: boolean;
}

export interface HechosPreparacion {
  snapshot: SnapshotConfigFiscal;
  ahora: Date;
  esquema: { listo: boolean; faltantes: readonly string[] };
  cifradoDisponible: boolean;
  certificados: Record<AmbienteFiscal, CertificadoParaChecklist | null>;
  claveSol: DiagnosticoSecreto;
  credencialesGre: DiagnosticoSecreto;
}

const BITS_MINIMOS = 1024;
const BITS_RECOMENDADOS = 2048;

function item(codigo: CodigoFaltante, titulo: string, ok: boolean, detalle: string, accion: string): ItemChecklist {
  return ok ? { codigo, titulo, ok, detalle: null, accion: null } : { codigo, titulo, ok, detalle, accion };
}

function lleno(valor: string | null | undefined): boolean {
  return !!valor && valor.trim().length > 0;
}

function fechaCorta(fecha: Date): string {
  const [anio, mes, dia] = fechaEnLima(fecha).split('-');
  return `${dia}/${mes}/${anio}`;
}

const MENSAJE_SECRETO: Record<Exclude<DiagnosticoSecreto, 'ok'>, string> = {
  falta: 'No se ha registrado.',
  ilegible: 'Está guardada pero no se puede descifrar con la FISCAL_SECRET_KEY actual (¿cambió la llave?).',
  sin_cifrado: 'Falta FISCAL_SECRET_KEY en el servidor para poder leerla.',
  sin_esquema: 'Falta ejecutar sql/fase9_sunat_directo.sql.',
};

function detalleSecreto(diagnostico: DiagnosticoSecreto): string {
  return diagnostico === 'ok' ? '' : MENSAJE_SECRETO[diagnostico];
}

function itemsGenerales(h: HechosPreparacion): ItemChecklist[] {
  return [
    item(
      FALTANTES.claveMaestra,
      'Llave de seguridad del servidor (FISCAL_SECRET_KEY)',
      h.cifradoDisponible,
      'El servidor no tiene una FISCAL_SECRET_KEY válida: no puede guardar ni leer el certificado ni las claves.',
      'Configure FISCAL_SECRET_KEY en Railway (genérela con `openssl rand -base64 32`, guarde una copia offline) y reinicie.',
    ),
    item(
      FALTANTES.migracion,
      'Base de datos preparada (sql/fase9_sunat_directo.sql)',
      h.esquema.listo,
      `Falta ejecutar sql/fase9_sunat_directo.sql en Railway${h.esquema.faltantes.length ? ` (faltan: ${h.esquema.faltantes.slice(0, 5).join(', ')})` : ''}.`,
      'Ejecute sql/fase9_sunat_directo.sql en la base de datos de Railway (es idempotente y no borra datos).',
    ),
  ];
}

function itemsCertificado(h: HechosPreparacion): ItemChecklist[] {
  const cert = h.certificados.produccion;
  const ruc = h.snapshot.emisor.ruc;
  if (!cert) {
    return [
      item(
        FALTANTES.certificadoProduccion,
        'Certificado digital de producción',
        false,
        'No hay un certificado de producción cargado.',
        'Suba el .pfx/.p12 (el CDT gratuito que descarga del buzón SOL o uno comprado) con su contraseña.',
      ),
    ];
  }

  const vencido = cert.vigenteHasta.getTime() <= h.ahora.getTime();
  const aunNoVigente = cert.vigenteDesde.getTime() > h.ahora.getTime();
  return [
    item(
      FALTANTES.certificadoProduccion,
      'Certificado digital de producción',
      cert.legible,
      'El certificado está guardado pero no se puede abrir con la FISCAL_SECRET_KEY actual.',
      'Vuelva a subir el .pfx con su contraseña (o restaure la llave anterior en FISCAL_SECRET_KEY_ANTERIOR).',
    ),
    item(
      FALTANTES.certificadoVencido,
      'Certificado vigente',
      !vencido && !aunNoVigente,
      vencido
        ? `El certificado venció el ${fechaCorta(cert.vigenteHasta)}.`
        : `El certificado recién será válido desde el ${fechaCorta(cert.vigenteDesde)}.`,
      'Renueve el certificado (CDT en SOL) y súbalo de nuevo.',
    ),
    item(
      FALTANTES.certificadoAutofirmado,
      'Certificado emitido por una entidad autorizada',
      !cert.autofirmado,
      'El certificado de producción es autofirmado (solo sirve para pruebas en BETA).',
      'Suba el CDT de SUNAT o un certificado comprado a una entidad acreditada.',
    ),
    item(
      FALTANTES.certificadoClaveDebil,
      'Clave del certificado de al menos 1024 bits',
      cert.bitsClave === null || cert.bitsClave >= BITS_MINIMOS,
      `La clave del certificado tiene ${cert.bitsClave} bits; SUNAT exige al menos ${BITS_MINIMOS}.`,
      'Solicite un certificado nuevo (RSA de 2048 bits).',
    ),
    // Si el RUC no se puede leer del certificado, lo confirma el administrador (D1): sin eso no se emite.
    cert.ruc === null
      ? item(
          FALTANTES.certRucSinConfirmar,
          'Confirmación: el certificado pertenece al RUC del emisor',
          h.snapshot.certRucConfirmadoProduccion,
          `No se pudo leer el RUC dentro del certificado de producción; confirme que pertenece a ${ruc}.`,
          'Revise el titular del certificado (el CDT de SOL siempre es del RUC) y marque la confirmación en el panel.',
        )
      : item(
          FALTANTES.rucCertificado,
          'El certificado pertenece al RUC del emisor',
          cert.ruc === ruc,
          `El certificado es del RUC ${cert.ruc}, pero el emisor configurado es ${ruc}.`,
          'Suba el certificado de la empresa o corrija el RUC del emisor.',
        ),
  ];
}

function itemsSol(h: HechosPreparacion): ItemChecklist[] {
  return [
    item(
      FALTANTES.usuarioSol,
      'Usuario secundario SOL',
      !!h.snapshot.solUsuario,
      'No se ha registrado el usuario secundario SOL.',
      'Cree en SOL un usuario secundario (8 caracteres) con perfil de emisión electrónica y regístrelo en el panel.',
    ),
    item(
      FALTANTES.claveSol,
      'Clave del usuario secundario SOL',
      h.claveSol === 'ok',
      `Clave SOL: ${detalleSecreto(h.claveSol)}`,
      'Registre la clave del usuario secundario SOL (8 a 12 caracteres).',
    ),
  ];
}

function itemsEmisorBasico(h: HechosPreparacion): ItemChecklist[] {
  const e = h.snapshot.emisor;
  return [
    item(
      FALTANTES.emisorRuc,
      'RUC del emisor',
      Ruc.esValido(e.ruc),
      `El RUC del emisor («${e.ruc}») no es válido.`,
      'Corrija el RUC del emisor en la configuración fiscal.',
    ),
    item(
      FALTANTES.emisorRazonSocial,
      'Razón social del emisor',
      lleno(e.razonSocial),
      'Falta la razón social del emisor.',
      'Ingrese la razón social tal como figura en la Ficha RUC.',
    ),
  ];
}

function itemsEmisorDomicilio(h: HechosPreparacion): ItemChecklist[] {
  const e = h.snapshot.emisor;
  return [
    item(
      FALTANTES.emisorDireccion,
      'Dirección del domicilio fiscal',
      lleno(e.direccion),
      'Falta la dirección del domicilio fiscal.',
      'Ingrese la dirección tal como figura en la Ficha RUC.',
    ),
    item(
      FALTANTES.emisorUbigeo,
      'Ubigeo del domicilio fiscal (6 dígitos)',
      PATRON_UBIGEO.test(e.ubigeo ?? ''),
      'Falta el ubigeo del domicilio fiscal o no tiene 6 dígitos.',
      'Ingrese el ubigeo INEI de la Ficha RUC (Lurín, Lima = 150119).',
    ),
    item(FALTANTES.emisorDistrito, 'Distrito', lleno(e.distrito), 'Falta el distrito.', 'Ingrese el distrito del domicilio fiscal.'),
    item(FALTANTES.emisorProvincia, 'Provincia', lleno(e.provincia), 'Falta la provincia.', 'Ingrese la provincia del domicilio fiscal.'),
    item(
      FALTANTES.emisorDepartamento,
      'Departamento',
      lleno(e.departamento),
      'Falta el departamento.',
      'Ingrese el departamento del domicilio fiscal.',
    ),
    item(
      FALTANTES.emisorCodigoEstablecimiento,
      'Código de establecimiento (4 dígitos)',
      PATRON_CODIGO_ESTABLECIMIENTO.test(e.codigoEstablecimiento ?? ''),
      'El código de establecimiento debe tener 4 dígitos.',
      'Use 0000 para el domicilio fiscal o el código del anexo registrado en SUNAT.',
    ),
  ];
}

/** Las 6 series de comprobantes deben ser válidas y distintas (comparten el índice serie+número). */
export function problemasSeriesCpe(snapshot: SnapshotConfigFiscal): string[] {
  const problemas: string[] = [];
  const vistas = new Map<string, string>();
  for (const tipo of TIPOS_SERIE_CPE) {
    const serie = snapshot.series[tipo];
    if (!PATRON_SERIE[tipo].test(serie ?? '')) problemas.push(`La serie ${tipo} («${serie}») no es válida.`);
    const repetida = vistas.get(serie);
    if (repetida) problemas.push(`La serie ${serie} está repetida en ${repetida} y ${tipo}.`);
    vistas.set(serie, tipo);
  }
  return problemas;
}

function itemSeriesCpe(h: HechosPreparacion): ItemChecklist {
  const problemas = problemasSeriesCpe(h.snapshot);
  return item(
    FALTANTES.series,
    'Series de factura, boleta y notas',
    problemas.length === 0,
    problemas.join(' '),
    'Revise las series: factura y sus notas empiezan con F; boleta y sus notas con B; todas distintas.',
  );
}

function itemCorrelativoInicial(h: HechosPreparacion): ItemChecklist {
  return item(
    FALTANTES.correlativoInicial,
    'Primer número de cada serie revisado',
    h.snapshot.correlativoInicialRevisado,
    'Falta revisar desde qué número empieza cada serie de factura, boleta y notas.',
    'Si ya usó estas series con otro sistema (o en SOL), indique el primer número libre de cada una; si son nuevas, guarde el valor 1.',
  );
}

/** Lo que solo se ve en SOL: el dueño lo declara desde el panel y queda auditado (D1.4). */
function itemsConfirmacionesSol(h: HechosPreparacion): ItemChecklist[] {
  const c = h.snapshot.confirmaciones;
  return [
    item(
      FALTANTES.confirmacionEmisorElectronico,
      'Confirmación: alta como emisor electrónico desde su sistema (SEE - Del Contribuyente)',
      c.emisorElectronicoSol,
      'Falta confirmar que en SOL se dio de alta como emisor electrónico desde el sistema del contribuyente.',
      'En SOL › Comprobantes de pago › SEE - Del Contribuyente, declare la emisión desde su sistema y luego marque la confirmación.',
    ),
    item(
      FALTANTES.confirmacionCertificadoSol,
      'Confirmación: certificado digital registrado en SOL',
      c.certificadoEnSol,
      'Falta confirmar que el certificado de producción subido aquí está registrado en SOL.',
      'Descargue la parte pública (.cer) desde este panel, regístrela en SOL › «Actualización de certificado digital» y luego marque la confirmación.',
    ),
    item(
      FALTANTES.confirmacionUsuarioSecundario,
      'Confirmación: usuario secundario SOL con perfil de envío de comprobantes',
      c.usuarioSolSecundario,
      'Falta confirmar que el usuario secundario tiene el perfil para enviar comprobantes electrónicos.',
      'En SOL › Administración de usuarios secundarios, asígnele el perfil de envío de comprobantes electrónicos y luego marque la confirmación.',
    ),
    item(
      FALTANTES.confirmacionRucHabido,
      'Confirmación: RUC activo y habido',
      c.rucHabido,
      'Falta confirmar que el RUC está activo y con domicilio habido.',
      'Revíselo en la Consulta RUC de SUNAT y luego marque la confirmación.',
    ),
  ];
}

function itemConfirmacion(h: HechosPreparacion): ItemChecklist {
  return item(
    FALTANTES.confirmacionNoOse,
    'Confirmación: sin OSE registrado y no es PRICO ni agente de retención/percepción',
    !!h.snapshot.confirmacionNoOse,
    'Falta confirmar que HatunSales no tiene un OSE registrado en SOL (RS 117-2017 y RS 239-2018).',
    'Revise en SOL los OSE/PSE registrados y en Consulta RUC su condición; luego marque la confirmación.',
  );
}

function itemsGre(h: HechosPreparacion): ItemChecklist[] {
  const gre = h.snapshot.gre;
  return [
    item(
      FALTANTES.greCredenciales,
      'Credenciales API SUNAT para GRE (client_id y client_secret)',
      h.credencialesGre === 'ok',
      `Credenciales API: ${detalleSecreto(h.credencialesGre)}`,
      'Genérelas en SOL › Empresas › Credenciales de API SUNAT y regístrelas en el panel.',
    ),
    item(
      FALTANTES.greSerie,
      'Serie de la guía de remisión remitente',
      PATRON_SERIE.gre_remitente.test(gre.serie ?? ''),
      `La serie de GRE («${gre.serie}») debe empezar con T y tener 4 caracteres (ej. T001).`,
      'Configure la serie de la GRE remitente (por ejemplo T001).',
    ),
    item(
      FALTANTES.grePartidaUbigeo,
      'Punto de partida: ubigeo (6 dígitos)',
      PATRON_UBIGEO.test(gre.partida.ubigeo ?? ''),
      'Falta el ubigeo del punto de partida (o el del domicilio fiscal).',
      'Ingrese el ubigeo del local desde donde salen los productos.',
    ),
    item(
      FALTANTES.grePartidaDireccion,
      'Punto de partida: dirección',
      lleno(gre.partida.direccion),
      'Falta la dirección del punto de partida.',
      'Ingrese la dirección del local desde donde salen los productos.',
    ),
    item(
      FALTANTES.grePartidaCodigo,
      'Punto de partida: código de establecimiento',
      PATRON_CODIGO_ESTABLECIMIENTO.test(gre.partida.codigoEstablecimiento ?? ''),
      'El código de establecimiento del punto de partida debe tener 4 dígitos.',
      'Use 0000 si sale del domicilio fiscal o el código del anexo registrado en SUNAT.',
    ),
  ];
}

function checklist(tipo: TipoChecklist, titulo: string, documentos: string[], items: ItemChecklist[]): ChecklistDocumento {
  const faltantes = Array.from(new Set(items.filter((i) => !i.ok).map((i) => i.codigo)));
  return { tipo, titulo, documentos, listo: faltantes.length === 0, faltantes, items };
}

function advertencias(h: HechosPreparacion): string[] {
  const lista: string[] = [];
  const cert = h.certificados.produccion;
  if (cert) {
    const dias = diasHasta(cert.vigenteHasta, h.ahora);
    if (dias >= 0 && dias <= DIAS_AVISO_VENCIMIENTO) {
      lista.push(
        `El certificado de producción vence en ${dias} día(s), el ${fechaCorta(cert.vigenteHasta)}. Renuévelo y súbalo antes de esa fecha.`,
      );
    }
    if (cert.bitsClave !== null && cert.bitsClave >= BITS_MINIMOS && cert.bitsClave < BITS_RECOMENDADOS) {
      lista.push(`La clave del certificado es de ${cert.bitsClave} bits; se recomienda 2048 bits al renovarlo.`);
    }
  }
  if (h.snapshot.proveedor === 'sunat_directo' && h.snapshot.ambiente !== 'produccion') {
    lista.push(
      'La emisión de producción está elegida pero el ambiente es BETA: solo se emiten pruebas de SUNAT BETA y únicamente si la emisión de prueba del POS está activa.',
    );
  }
  return lista;
}

export function evaluarPreparacion(h: HechosPreparacion): ResultadoPreparacion {
  const generales = itemsGenerales(h);
  const certificado = itemsCertificado(h);
  const sol = itemsSol(h);
  const confirmacion = itemConfirmacion(h);

  const cpe = checklist(
    'cpe',
    'Factura, boleta y notas electrónicas',
    ['01 Factura', '03 Boleta de venta', '07 Nota de crédito', '08 Nota de débito'],
    [
      ...generales,
      ...certificado,
      ...sol,
      ...itemsEmisorBasico(h),
      ...itemsEmisorDomicilio(h),
      itemSeriesCpe(h),
      itemCorrelativoInicial(h),
      confirmacion,
      ...itemsConfirmacionesSol(h),
    ],
  );
  const gre = checklist(
    'gre',
    'Guía de remisión electrónica remitente',
    ['09 Guía de remisión remitente'],
    [...generales, ...certificado, ...sol, ...itemsEmisorBasico(h), ...itemsGre(h), confirmacion],
  );

  const faltantesBeta: CodigoFaltante[] = [];
  if (!h.cifradoDisponible) faltantesBeta.push(FALTANTES.claveMaestra);
  if (!h.esquema.listo) faltantesBeta.push(FALTANTES.migracion);
  const certBeta = h.certificados.beta ?? h.certificados.produccion;
  if (!certBeta?.legible || certBeta.vigenteHasta.getTime() <= h.ahora.getTime()) {
    faltantesBeta.push(FALTANTES.certificadoBeta);
  }
  if (!Ruc.esValido(h.snapshot.emisor.ruc)) faltantesBeta.push(FALTANTES.emisorRuc);

  return {
    listo: cpe.listo,
    faltantes: cpe.faltantes,
    advertencias: advertencias(h),
    checklist: { cpe, gre },
    pruebas_beta: { listo: faltantesBeta.length === 0, faltantes: faltantesBeta },
    evaluado_en: h.ahora.toISOString(),
  };
}
