import { CATALOGO_06_TIPOS_VALIDOS, esUnidadCatalogo03 } from '../catalogos/sunat.catalogos';
import { DecimalExacto } from '../nucleo/decimal';
import { errorDocumentoIdentidad, esRucValido } from '../nucleo/documentos-identidad';
import { esFechaIso, esHoraValida, resolverHoy } from '../nucleo/fechas-fiscales';
import { NUMERO_MAXIMO_CPE, PATRON_SERIE_GUIA } from '../nucleo/identificadores-cpe';
import {
  CATALOGO_20_MOTIVOS_TRASLADO,
  CATALOGO_61_DOCUMENTOS_RELACIONADOS,
  DOCUMENTOS_RELACIONADOS_CON_SERIE,
  MAXIMO_CONDUCTORES_GRE,
  MAXIMO_ITEMS_GRE,
  MOTIVO_GRE_OTROS,
  MOTIVO_GRE_TRASLADO_ESTABLECIMIENTOS,
  MOTIVO_GRE_VENTA,
  MOTIVOS_GRE_SOPORTADOS,
  TIPO_DOCUMENTO_GRE_REMITENTE,
  UNIDADES_PESO_GRE,
} from './catalogos-gre';
import type {
  ConductorGre,
  DireccionGre,
  DocumentoGre,
  DocumentoRelacionadoGre,
  ItemGre,
  ObservacionCampoGre,
  ResultadoValidacionGre,
} from './gre.tipos';

/**
 * Reglas previas al envío de la GRE remitente. Puras (sin red ni BD): sirven para «validar sin enviar»
 * desde el formulario y como candado antes de firmar. Cada mensaje dice qué campo falla y cómo
 * corregirlo, y va también en `porCampo` con la ruta del campo para marcarlo en pantalla.
 *
 * Fuentes: [A12] anexo N.° 12 (requisitos y validaciones) y [A14] anexo N.° 14 (estándar UBL 2.1,
 * longitudes) de la RS 097-2012/SUNAT según la RS 000123-2022/SUNAT y la RS 000108-2026/SUNAT;
 * [A13] anexo N.° 13 (nombre del archivo); [R188] art. 19 de la RS 188-2010/SUNAT (datos a ingresar en
 * la GRE remitente). Lo que es criterio del proyecto se indica como tal.
 */

export interface OpcionesValidacionGre {
  /** Fecha de referencia (yyyy-mm-dd o Date). Por omisión, hoy en Lima. */
  hoy?: string | Date;
}

/** [A14] longitudes máximas (an..N). */
const LONGITUD = {
  observaciones: 250, // dato 7
  nombre: 250, // datos 9, 16, 43 y 54
  numeroDocumentoIdentidad: 15, // dato 15
  descripcionMotivo: 100, // dato 23
  direccion: 500, // datos 61 y 66
  registroMtc: 20, // dato 44
  tarjetaCirculacion: 15, // dato 47
  licencia: 10, // dato 55
  descripcionItem: 500, // dato 76
  codigoItem: 30, // dato 77
  documentoRelacionado: 100, // dato 13
} as const;

/** [A12] campo 44: placa alfanumérica de 6 a 8 posiciones; [A14] dato 46: an..8. */
const PATRON_PLACA = /^[A-Z0-9]{6,8}$/;
const PATRON_ALFANUMERICO = /^[A-Z0-9]+$/;
const PATRON_UBIGEO = /^\d{6}$/;
const PATRON_ESTABLECIMIENTO = /^\d{4}$/;
const PATRON_UNSPSC = /^\d{8}$/;
const PATRON_NUMERO_COMPROBANTE = /^\d{1,8}$/;

/**
 * Serie de los comprobantes relacionados: electrónica (F###/B###), emitida en SEE-SOL (E001/EB01) o
 * impresa o importada (4 dígitos, catálogo 61 la admite). Criterio del proyecto a partir de los patrones de serie de SUNAT.
 */
const SERIE_RELACIONADO: Readonly<Record<string, { patron: RegExp; ejemplo: string }>> = {
  '01': { patron: /^(F[A-Z0-9]{3}|E001|\d{4})$/, ejemplo: 'F001, E001 o 0001' },
  '03': { patron: /^(B[A-Z0-9]{3}|EB01|\d{4})$/, ejemplo: 'B001, EB01 o 0001' },
};
const SERIE_RELACIONADO_GENERICA = { patron: /^[A-Z0-9]{4}$/, ejemplo: '4 letras o dígitos, p. ej. T001' };

/** Quita guiones y espacios y pasa a mayúsculas: «abc-123» → «ABC123». Para normalizar lo que escribe el usuario. */
export function normalizarPlacaGre(placa: string | null | undefined): string {
  return String(placa ?? '').toUpperCase().replace(/[\s-]+/g, '');
}

/** Texto recortado de un campo que debería ser texto o número (lo demás cuenta como vacío). */
function texto(valor: unknown): string {
  return typeof valor === 'string' || typeof valor === 'number' ? String(valor).trim() : '';
}

/** Ubigeo INEI con forma de distrito: departamento 01–25, provincia y distrito distintos de 00. El catálogo completo lo valida el negocio. */
function esUbigeoDeDistrito(ubigeo: string): boolean {
  const departamento = Number(ubigeo.slice(0, 2));
  return departamento >= 1 && departamento <= 25 && ubigeo.slice(2, 4) !== '00' && ubigeo.slice(4, 6) !== '00';
}

/** Problema de un número positivo con hasta `maxEnteros` dígitos enteros y `maxDecimales` decimales, o null. */
function problemaNumeroPositivo(valor: unknown, maxEnteros: number, maxDecimales: number): string | null {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return 'debe ser un número';
  if (valor <= 0) return 'debe ser mayor que 0';
  if (DecimalExacto.de(valor).decimalesSignificativos() > maxDecimales) return `admite hasta ${maxDecimales} decimales`;
  if (String(Math.trunc(valor)).length > maxEnteros) return `admite hasta ${maxEnteros} dígitos enteros`;
  return null;
}

/** La validación nunca lanza: una fecha de referencia mal escrita se reemplaza por hoy en Lima. */
function hoyDeReferencia(hoy: string | Date | undefined): string {
  try {
    return resolverHoy(hoy);
  } catch {
    return resolverHoy();
  }
}

/** Un tipo fuera del catálogo 06 se marca en el tipo; si el tipo existe, el problema está en el número. */
function campoDocumento(base: string, tipo: string): string {
  return CATALOGO_06_TIPOS_VALIDOS.has(tipo) ? `${base}.numDoc` : `${base}.tipoDoc`;
}

/** Comparación de textos sin tildes, mayúsculas ni espacios repetidos. */
function normalizarComparacion(valor: string): string {
  return valor
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

class RegistroValidacionGre {
  private readonly errores: string[] = [];
  private readonly advertencias: string[] = [];
  private readonly porCampo: ObservacionCampoGre[] = [];

  error(campo: string, mensaje: string): void {
    this.errores.push(mensaje);
    this.porCampo.push({ campo, nivel: 'error', mensaje });
  }

  advertencia(campo: string, mensaje: string): void {
    this.advertencias.push(mensaje);
    this.porCampo.push({ campo, nivel: 'advertencia', mensaje });
  }

  /** Errores de longitud y vacío de un texto obligatorio. */
  textoObligatorio(campo: string, etiqueta: string, valor: unknown, maximo: number, sugerencia: string): void {
    const limpio = texto(valor);
    if (!limpio) this.error(campo, `${etiqueta}: ${sugerencia}`);
    else if (limpio.length > maximo) this.error(campo, `${etiqueta}: admite hasta ${maximo} caracteres (tiene ${limpio.length}).`);
  }

  textoOpcional(campo: string, etiqueta: string, valor: unknown, maximo: number): void {
    const limpio = texto(valor);
    if (limpio.length > maximo) this.error(campo, `${etiqueta}: admite hasta ${maximo} caracteres (tiene ${limpio.length}).`);
  }

  resultado(): ResultadoValidacionGre {
    return { errores: [...this.errores], advertencias: [...this.advertencias], porCampo: [...this.porCampo] };
  }
}

/**
 * Valida una GRE remitente antes de armar el XML. Nunca lanza: devuelve errores (impiden emitir) y
 * advertencias (se puede emitir, pero conviene revisar).
 */
export function validarDocumentoGre(documento: DocumentoGre, opciones: OpcionesValidacionGre = {}): ResultadoValidacionGre {
  const r = new RegistroValidacionGre();
  if (!documento || typeof documento !== 'object') {
    r.error('documento', 'La guía de remisión llegó vacía.');
    return r.resultado();
  }
  const hoy = hoyDeReferencia(opciones.hoy);

  validarCabecera(r, documento, hoy);
  validarRemitente(r, documento);
  const motivo = texto(documento.envio?.motivo);
  validarDestinatario(r, documento, motivo);
  validarEnvio(r, documento, motivo);
  validarItems(r, documento.items);
  validarDocumentosRelacionados(r, documento.documentosRelacionados, motivo);
  // [A14] dato 7: observaciones an..250.
  r.textoOpcional('observaciones', 'Observaciones', documento.observaciones, LONGITUD.observaciones);
  return r.resultado();
}

function validarCabecera(r: RegistroValidacionGre, doc: DocumentoGre, hoy: string): void {
  // [A12] campo 6: tipo de documento '09'.
  if (doc.tipo !== TIPO_DOCUMENTO_GRE_REMITENTE) {
    r.error('tipo', `Tipo de documento: la guía de remisión remitente es el tipo 09 (llegó "${texto(doc.tipo)}").`);
  }
  // [A12] campo 7 y [A13] 1.4: serie T + 3 alfanuméricos; correlativo de 1 a 8 dígitos que empieza en 1.
  const serie = texto(doc.serie);
  if (!PATRON_SERIE_GUIA.test(serie)) {
    r.error('serie', `Serie: "${serie}" no es válida; la guía remitente usa 4 caracteres que empiezan con T (p. ej. T001), en mayúsculas.`);
  }
  if (!Number.isInteger(doc.numero) || doc.numero < 1 || doc.numero > NUMERO_MAXIMO_CPE) {
    r.error('numero', `Número: debe ser un entero entre 1 y ${NUMERO_MAXIMO_CPE} (llegó ${String(doc.numero)}).`);
  }
  // [A12] campos 1 y 2: fecha yyyy-mm-dd y hora hh:mm:ss.
  if (!esFechaIso(doc.fechaEmision)) {
    r.error('fechaEmision', `Fecha de emisión: "${texto(doc.fechaEmision)}" no es una fecha válida (formato aaaa-mm-dd).`);
  } else if (doc.fechaEmision > hoy) {
    r.error('fechaEmision', `Fecha de emisión: ${doc.fechaEmision} es posterior a hoy (${hoy}, hora de Lima); use la fecha de hoy.`);
  } else if (doc.fechaEmision < hoy) {
    // Criterio del proyecto: la GRE se emite antes de entregar los bienes o iniciar el traslado (RS 255-2015, art. 4).
    // Que SUNAT rechace una fecha pasada está [NO VERIFICADO]: por eso solo se advierte.
    r.advertencia('fechaEmision', `Fecha de emisión: ${doc.fechaEmision} es anterior a hoy (${hoy}); la guía debe emitirse el día en que se envía a SUNAT.`);
  }
  if (!esHoraValida(doc.horaEmision)) {
    r.error('horaEmision', `Hora de emisión: "${texto(doc.horaEmision)}" no es válida (formato hh:mm:ss de 24 horas).`);
  }
}

function validarRemitente(r: RegistroValidacionGre, doc: DocumentoGre): void {
  // [A12] campos 4 y 5: razón social y RUC válido del remitente.
  const remitente = doc.remitente;
  if (!remitente || typeof remitente !== 'object') {
    r.error('remitente', 'Remitente: faltan los datos del emisor; revise el panel de facturación.');
    return;
  }
  if (!esRucValido(remitente.ruc)) {
    r.error('remitente.ruc', `Remitente: el RUC "${texto(remitente.ruc)}" no es válido; revise el RUC del emisor en el panel de facturación.`);
  }
  r.textoObligatorio('remitente.razonSocial', 'Remitente', remitente.razonSocial, LONGITUD.nombre, 'falta la razón social del emisor; complétela en el panel de facturación.');
}

function validarDestinatario(r: RegistroValidacionGre, doc: DocumentoGre, motivo: string): void {
  const destinatario = doc.destinatario;
  if (!destinatario || typeof destinatario !== 'object') {
    r.error('destinatario', 'Destinatario: indique el tipo y número de documento y el nombre o razón social.');
    return;
  }
  const tipo = texto(destinatario.tipoDoc);
  const numero = texto(destinatario.numDoc);
  // [A12] campo 8: tipo y número según el catálogo 06; el RUC o el DNI deben ser válidos.
  if (tipo === '0' && (numero === '' || numero === '-' || /^0+$/.test(numero))) {
    r.error('destinatario.numDoc', 'Destinatario: la guía necesita el documento de identidad de quien recibe (DNI, RUC, carné de extranjería o pasaporte).');
  } else {
    const problema = errorDocumentoIdentidad(tipo, numero);
    if (problema) r.error(campoDocumento('destinatario', tipo), `Destinatario: ${problema}.`);
    else if (numero.length > LONGITUD.numeroDocumentoIdentidad) {
      r.error('destinatario.numDoc', `Destinatario: el documento admite hasta ${LONGITUD.numeroDocumentoIdentidad} caracteres.`);
    }
  }
  // [A12] campo 9.
  r.textoObligatorio('destinatario.nombre', 'Destinatario', destinatario.nombre, LONGITUD.nombre, 'indique el nombre o la razón social de quien recibe.');

  // [A12] campos 8 y 9: con el motivo 04 el destinatario es el propio remitente.
  if (motivo === MOTIVO_GRE_TRASLADO_ESTABLECIMIENTOS && doc.remitente) {
    const ruc = texto(doc.remitente.ruc);
    if (tipo !== '6' || numero !== ruc) {
      r.error(
        'destinatario.numDoc',
        `Destinatario: en un traslado entre establecimientos de la misma empresa (motivo 04) el destinatario es el propio remitente; use RUC ${ruc} (${texto(doc.remitente.razonSocial)}).`,
      );
    }
  }
}

function validarEnvio(r: RegistroValidacionGre, doc: DocumentoGre, motivo: string): void {
  const envio = doc.envio;
  if (!envio || typeof envio !== 'object') {
    r.error('envio', 'Datos del traslado: faltan el motivo, la modalidad, las fechas, el peso y los puntos de partida y llegada.');
    return;
  }

  // [A12] campo 30 / [R188] num. 4: motivo según el catálogo 20. El motor solo emite 01, 04 y 13.
  const nombreMotivo = CATALOGO_20_MOTIVOS_TRASLADO[motivo];
  if (!nombreMotivo) {
    r.error('envio.motivo', `Motivo de traslado: el código "${motivo}" no existe en el catálogo 20 de SUNAT.`);
  } else if (!MOTIVOS_GRE_SOPORTADOS.includes(motivo)) {
    r.error(
      'envio.motivo',
      `Motivo de traslado: «${nombreMotivo}» (${motivo}) no está habilitado todavía en el sistema. Use 01 (venta), 04 (traslado entre establecimientos de la misma empresa) o 13 (otros), o emita esa guía en SUNAT Operaciones en Línea.`,
    );
  }

  // [A12] campo 31 / [R188] num. 4.e: con 13 se describe el motivo, que no debe ser ni parecerse a uno del catálogo. [A14] dato 23: an..100.
  const descripcion = texto(envio.descripcionMotivo);
  if (motivo === MOTIVO_GRE_OTROS && !descripcion) {
    r.error('envio.descripcionMotivo', 'Descripción del motivo: con el motivo 13 (otros) describa el motivo del traslado, por ejemplo «Traslado a reparación».');
  }
  r.textoOpcional('envio.descripcionMotivo', 'Descripción del motivo', descripcion, LONGITUD.descripcionMotivo);
  if (motivo === MOTIVO_GRE_OTROS && descripcion) {
    const normalizada = normalizarComparacion(descripcion);
    const parecido = Object.entries(CATALOGO_20_MOTIVOS_TRASLADO).find(
      ([codigo, nombre]) => codigo !== MOTIVO_GRE_OTROS && normalizada.includes(normalizarComparacion(nombre)),
    );
    if (parecido) {
      r.advertencia(
        'envio.descripcionMotivo',
        `Descripción del motivo: «${descripcion}» corresponde al motivo ${parecido[0]} (${parecido[1]}); SUNAT pide usar «otros» solo para lo que no está en el catálogo.`,
      );
    }
  }

  // [A12] campo 29: modalidad según el catálogo 18.
  const modalidad = texto(envio.modalidad);
  if (modalidad !== '01' && modalidad !== '02') {
    r.error('envio.modalidad', `Modalidad de traslado: use 01 (transporte público) o 02 (transporte privado) (llegó "${modalidad}").`);
  }

  // [A12] campo 39 (RS 000108-2026): fecha de inicio del traslado igual o posterior a la de emisión.
  if (!esFechaIso(envio.fechaInicioTraslado)) {
    r.error('envio.fechaInicioTraslado', `Fecha de inicio del traslado: "${texto(envio.fechaInicioTraslado)}" no es una fecha válida (formato aaaa-mm-dd).`);
  } else if (esFechaIso(doc.fechaEmision) && envio.fechaInicioTraslado < doc.fechaEmision) {
    r.error('envio.fechaInicioTraslado', `Fecha de inicio del traslado: ${envio.fechaInicioTraslado} no puede ser anterior a la fecha de emisión (${doc.fechaEmision}).`);
  }

  if (modalidad === '01') validarTransportePublico(r, doc);
  if (modalidad === '02') validarTransportePrivado(r, doc);

  // [A12] campos 23 y 24: peso bruto total (incluye envases y embalajes) en KGM o TNE. [A14] dato 26: n(12,3).
  const unidadPeso = texto(envio.unidadPeso);
  if (!UNIDADES_PESO_GRE[unidadPeso]) {
    r.error('envio.unidadPeso', `Unidad del peso bruto: use KGM (kilogramos) o TNE (toneladas) (llegó "${unidadPeso}").`);
  }
  const problemaPeso = problemaNumeroPositivo(envio.pesoBrutoTotal, 12, 3);
  if (problemaPeso) {
    r.error('envio.pesoBrutoTotal', `Peso bruto total: ${problemaPeso} (incluya envases y embalajes).`);
  }
  // [A14] dato 27: número de bultos o pallets n..6.
  if (envio.numeroBultos !== undefined && envio.numeroBultos !== null) {
    const bultos = envio.numeroBultos;
    if (!Number.isInteger(bultos) || bultos < 1 || bultos > 999_999) {
      r.error('envio.numeroBultos', 'Número de bultos: debe ser un entero entre 1 y 999999, o dejarse vacío.');
    }
  }

  // [A12] campos 33 a 38: partida y llegada con ubigeo y dirección; con el motivo 04, código de establecimiento en ambos.
  const conEstablecimiento = motivo === MOTIVO_GRE_TRASLADO_ESTABLECIMIENTOS;
  const partidaOk = validarPunto(r, 'envio.partida', 'Punto de partida', envio.partida, conEstablecimiento);
  const llegadaOk = validarPunto(r, 'envio.llegada', 'Punto de llegada', envio.llegada, conEstablecimiento);
  if (partidaOk && llegadaOk) {
    // Criterio del proyecto: un traslado necesita dos puntos distintos.
    const mismoEstablecimiento =
      conEstablecimiento && texto(envio.partida.codigoEstablecimiento) === texto(envio.llegada.codigoEstablecimiento);
    const mismaDireccion =
      texto(envio.partida.ubigeo) === texto(envio.llegada.ubigeo) &&
      normalizarComparacion(texto(envio.partida.direccion)) === normalizarComparacion(texto(envio.llegada.direccion));
    if (mismoEstablecimiento) {
      r.error('envio.llegada.codigoEstablecimiento', 'Punto de llegada: es el mismo establecimiento que el de partida; un traslado entre establecimientos necesita dos distintos.');
    } else if (mismaDireccion) {
      r.error('envio.llegada.direccion', 'Punto de llegada: es la misma dirección que el punto de partida.');
    }
  }
}

/** Devuelve true si el punto tiene la forma correcta (para poder compararlo con el otro). */
function validarPunto(
  r: RegistroValidacionGre,
  campo: string,
  etiqueta: string,
  punto: DireccionGre | undefined,
  conEstablecimiento: boolean,
): boolean {
  if (!punto || typeof punto !== 'object') {
    r.error(campo, `${etiqueta}: indique el ubigeo y la dirección.`);
    return false;
  }
  let valido = true;
  // [A12] campos 34 y 37: ubigeo según el catálogo 13 (INEI).
  const ubigeo = texto(punto.ubigeo);
  if (!PATRON_UBIGEO.test(ubigeo)) {
    r.error(`${campo}.ubigeo`, `${etiqueta}: el ubigeo "${ubigeo}" debe tener 6 dígitos (código INEI del distrito, p. ej. 150101 Lima).`);
    valido = false;
  } else if (!esUbigeoDeDistrito(ubigeo)) {
    r.error(`${campo}.ubigeo`, `${etiqueta}: el ubigeo "${ubigeo}" no es de un distrito (departamento 01 a 25, provincia y distrito distintos de 00).`);
    valido = false;
  }
  // [A12] campos 33 y 36; [A14] datos 61 y 66: an..500.
  const direccion = texto(punto.direccion);
  if (!direccion) {
    r.error(`${campo}.direccion`, `${etiqueta}: indique la dirección (calle, número, urbanización).`);
    valido = false;
  } else if (direccion.length > LONGITUD.direccion) {
    r.error(`${campo}.direccion`, `${etiqueta}: la dirección admite hasta ${LONGITUD.direccion} caracteres.`);
    valido = false;
  }
  // [A12] campos 35 y 38 / [R188] num. 4.d: con el motivo 04, código de establecimiento anexo (n4).
  if (conEstablecimiento && !PATRON_ESTABLECIMIENTO.test(texto(punto.codigoEstablecimiento))) {
    r.error(
      `${campo}.codigoEstablecimiento`,
      `${etiqueta}: en un traslado entre establecimientos indique el código de establecimiento anexo registrado en SUNAT (4 dígitos; 0000 es el domicilio fiscal).`,
    );
    valido = false;
  }
  return valido;
}

function validarTransportePublico(r: RegistroValidacionGre, doc: DocumentoGre): void {
  // [A12] campos 41 a 43 / [R188] num. 3: RUC y razón social del transportista. [A14] dato 44: registro MTC an..20.
  const transportista = doc.transportista;
  if (!transportista || typeof transportista !== 'object') {
    r.error('transportista', 'Transportista: en transporte público indique el RUC y la razón social de la empresa de transporte.');
  } else {
    if (texto(transportista.tipoDoc) !== '6') {
      r.error('transportista.tipoDoc', 'Transportista: se identifica con RUC (tipo de documento 6).');
    }
    if (!esRucValido(transportista.numDoc)) {
      r.error('transportista.numDoc', `Transportista: el RUC "${texto(transportista.numDoc)}" no es válido (11 dígitos con dígito verificador correcto).`);
    } else if (doc.remitente && texto(transportista.numDoc) === texto(doc.remitente.ruc)) {
      // Criterio del proyecto: si el remitente traslada con sus propios vehículos es transporte privado (RCP art. 18).
      r.advertencia('transportista.numDoc', 'Transportista: es el mismo RUC del remitente; si traslada con vehículo propio, use la modalidad 02 (transporte privado).');
    }
    r.textoObligatorio('transportista.razonSocial', 'Transportista', transportista.razonSocial, LONGITUD.nombre, 'indique la razón social de la empresa de transporte.');
    const registro = texto(transportista.registroMtc).toUpperCase();
    if (registro && (!PATRON_ALFANUMERICO.test(registro) || registro.length > LONGITUD.registroMtc)) {
      r.error('transportista.registroMtc', `Transportista: el registro MTC admite hasta ${LONGITUD.registroMtc} letras o dígitos, sin espacios ni guiones.`);
    }
  }
  // [A12] campos 44 a 49 (RS 000108-2026): en transporte público el vehículo y los conductores son del
  // transportista y solo se consignan con el indicador «registrar vehículos y conductores», que el sistema no usa.
  if (doc.vehiculo || (Array.isArray(doc.conductores) && doc.conductores.length > 0)) {
    r.advertencia('vehiculo', 'Vehículo y conductores: en transporte público los consigna el transportista en su propia guía; no se enviarán en esta.');
  }
  // [A12] campo 39-A (RS 000108-2026): entrega de los bienes al transportista, igual o posterior a la emisión.
  const entrega = doc.envio.fechaEntregaTransportista;
  if (entrega !== undefined && entrega !== null && texto(entrega) !== '') {
    if (!esFechaIso(entrega)) {
      r.error('envio.fechaEntregaTransportista', `Fecha de entrega al transportista: "${texto(entrega)}" no es una fecha válida (formato aaaa-mm-dd).`);
    } else if (esFechaIso(doc.fechaEmision) && entrega < doc.fechaEmision) {
      r.error('envio.fechaEntregaTransportista', `Fecha de entrega al transportista: ${entrega} no puede ser anterior a la fecha de emisión (${doc.fechaEmision}).`);
    }
  }
}

function validarTransportePrivado(r: RegistroValidacionGre, doc: DocumentoGre): void {
  // [R188] num. 8 y [A12] campo 44: placa del vehículo (alfanumérica de 6 a 8 posiciones).
  const vehiculo = doc.vehiculo;
  if (!vehiculo || typeof vehiculo !== 'object' || !texto(vehiculo.placa)) {
    r.error('vehiculo.placa', 'Vehículo: en transporte privado indique la placa del vehículo (p. ej. ABC123).');
  } else {
    const placa = texto(vehiculo.placa);
    if (!PATRON_PLACA.test(placa)) {
      const sugerida = normalizarPlacaGre(placa);
      r.error(
        'vehiculo.placa',
        PATRON_PLACA.test(sugerida)
          ? `Vehículo: escriba la placa en mayúsculas, sin guiones ni espacios: ${sugerida}.`
          : `Vehículo: la placa "${placa}" debe tener de 6 a 8 letras o dígitos, sin guiones ni espacios (p. ej. ABC123).`,
      );
    }
    // [A14] dato 47: TUC o certificado de habilitación vehicular, an..15.
    const tarjeta = texto(vehiculo.tarjetaCirculacion).toUpperCase();
    if (tarjeta && (!PATRON_ALFANUMERICO.test(tarjeta) || tarjeta.length > LONGITUD.tarjetaCirculacion)) {
      r.error('vehiculo.tarjetaCirculacion', `Vehículo: la tarjeta única de circulación admite hasta ${LONGITUD.tarjetaCirculacion} letras o dígitos, sin espacios ni guiones.`);
    }
  }

  // [R188] num. 8: tipo y número de documento, apellidos y nombres y licencia del conductor; [A14] datos 52 a 59: 1 principal + hasta 2 secundarios.
  const conductores = Array.isArray(doc.conductores) ? doc.conductores : [];
  if (conductores.length === 0) {
    r.error('conductores', 'Conductor: en transporte privado indique al menos un conductor (documento, nombres, apellidos y licencia).');
  } else if (conductores.length > MAXIMO_CONDUCTORES_GRE) {
    r.error('conductores', `Conductores: se admite un conductor principal y hasta ${MAXIMO_CONDUCTORES_GRE - 1} secundarios.`);
  }
  conductores.slice(0, MAXIMO_CONDUCTORES_GRE).forEach((conductor, i) => validarConductor(r, conductor, i));

  if (doc.transportista) {
    r.advertencia('transportista', 'Transportista: en transporte privado no se envían datos de un transportista; se ignorarán.');
  }
}

function validarConductor(r: RegistroValidacionGre, conductor: ConductorGre, indice: number): void {
  const campo = `conductores[${indice}]`;
  const etiqueta = indice === 0 ? 'Conductor principal' : `Conductor secundario ${indice}`;
  if (!conductor || typeof conductor !== 'object') {
    r.error(campo, `${etiqueta}: faltan sus datos.`);
    return;
  }
  // [A12] campo 47: catálogo 06, el DNI debe ser válido.
  const tipo = texto(conductor.tipoDoc);
  const problema = errorDocumentoIdentidad(tipo, texto(conductor.numDoc));
  if (problema || tipo === '0') {
    r.error(campoDocumento(campo, tipo), `${etiqueta}: ${problema ?? 'indique un documento de identidad (DNI, carné de extranjería o pasaporte)'}.`);
  }
  // [A12] campo 48; [A14] dato 54: nombres y apellidos an..250.
  r.textoObligatorio(`${campo}.nombres`, etiqueta, conductor.nombres, LONGITUD.nombre, 'indique los nombres.');
  r.textoObligatorio(`${campo}.apellidos`, etiqueta, conductor.apellidos, LONGITUD.nombre, 'indique los apellidos.');
  // [A12] campo 49; [A14] dato 55: licencia an..10.
  const licencia = texto(conductor.licencia).toUpperCase();
  if (!licencia) {
    r.error(`${campo}.licencia`, `${etiqueta}: indique el número de licencia de conducir.`);
  } else if (!PATRON_ALFANUMERICO.test(licencia) || licencia.length > LONGITUD.licencia) {
    r.error(`${campo}.licencia`, `${etiqueta}: la licencia admite hasta ${LONGITUD.licencia} letras o dígitos, sin espacios ni guiones (p. ej. Q12345678).`);
  }
}

function validarItems(r: RegistroValidacionGre, items: ItemGre[] | undefined): void {
  // [A12] campos 16 a 18 y [R188] num. 7: unidad (catálogo 03), cantidad y descripción de cada bien.
  if (!Array.isArray(items) || items.length === 0) {
    r.error('items', 'Bienes: agregue al menos un bien a trasladar.');
    return;
  }
  if (items.length > MAXIMO_ITEMS_GRE) {
    r.error('items', `Bienes: una guía admite hasta ${MAXIMO_ITEMS_GRE} ítems.`);
  }
  items.forEach((item, i) => {
    const campo = `items[${i}]`;
    const etiqueta = `Ítem ${i + 1}`;
    if (!item || typeof item !== 'object') {
      r.error(campo, `${etiqueta}: faltan sus datos.`);
      return;
    }
    // [A14] dato 74: cantidad n(12,10).
    const problema = problemaNumeroPositivo(item.cantidad, 12, 10);
    if (problema) r.error(`${campo}.cantidad`, `${etiqueta}: la cantidad ${problema}.`);
    const unidad = texto(item.unidad);
    if (!esUnidadCatalogo03(unidad)) {
      r.error(`${campo}.unidad`, `${etiqueta}: la unidad "${unidad}" no es un código del catálogo 03 de SUNAT (p. ej. NIU unidad, KGM kilogramo, MTR metro, BX caja).`);
    }
    // [A12] campo 18: nombre y características (marca; serie o motor si es identificable). [A14] dato 76: an..500.
    r.textoObligatorio(`${campo}.descripcion`, etiqueta, item.descripcion, LONGITUD.descripcionItem, 'describa el bien (nombre y características, como la marca).');
    r.textoOpcional(`${campo}.codigoInterno`, `${etiqueta} (código)`, item.codigoInterno, LONGITUD.codigoItem);
    // [A14] dato 78: código de producto SUNAT (catálogo 25, UNSPSC).
    const codigoSunat = texto(item.codigoSunat);
    if (codigoSunat && !PATRON_UNSPSC.test(codigoSunat)) {
      r.error(`${campo}.codigoSunat`, `${etiqueta}: el código de producto SUNAT "${codigoSunat}" debe tener 8 dígitos (UNSPSC).`);
    }
  });
}

function validarDocumentosRelacionados(r: RegistroValidacionGre, documentos: DocumentoRelacionadoGre[] | undefined, motivo: string): void {
  const lista = documentos ?? [];
  if (!Array.isArray(lista)) {
    r.error('documentosRelacionados', 'Documentos relacionados: el formato no es válido.');
    return;
  }
  const vistos = new Set<string>();
  lista.forEach((relacionado, i) => {
    const campo = `documentosRelacionados[${i}]`;
    const etiqueta = `Documento relacionado ${i + 1}`;
    if (!relacionado || typeof relacionado !== 'object') {
      r.error(campo, `${etiqueta}: faltan sus datos.`);
      return;
    }
    // [A12] campo 50: tipo según el catálogo 61.
    const tipo = texto(relacionado.tipo);
    const nombre = CATALOGO_61_DOCUMENTOS_RELACIONADOS[tipo];
    if (!nombre) {
      r.error(`${campo}.tipo`, `${etiqueta}: el tipo "${tipo}" no está en el catálogo 61 de SUNAT (01 factura, 03 boleta, 09 guía de remisión remitente…).`);
      return;
    }
    const serie = texto(relacionado.serie).toUpperCase();
    const numero = texto(relacionado.numero);
    // [A12] campo 51: serie y número del documento. [A14] dato 13: an..100.
    if (DOCUMENTOS_RELACIONADOS_CON_SERIE.has(tipo)) {
      const regla = SERIE_RELACIONADO[tipo] ?? SERIE_RELACIONADO_GENERICA;
      if (!regla.patron.test(serie)) {
        r.error(`${campo}.serie`, `${etiqueta}: la serie "${serie}" no es válida para ${nombre} (${regla.ejemplo}).`);
      }
      if (!PATRON_NUMERO_COMPROBANTE.test(numero) || Number(numero) < 1) {
        r.error(`${campo}.numero`, `${etiqueta}: el número "${numero}" debe tener de 1 a 8 dígitos, sin la serie.`);
      }
      // [A12] campo 52: RUC del emisor del documento relacionado.
      const rucEmisor = texto(relacionado.rucEmisor);
      if (rucEmisor && !esRucValido(rucEmisor)) {
        r.error(`${campo}.rucEmisor`, `${etiqueta}: el RUC del emisor "${rucEmisor}" no es válido.`);
      }
    } else if (!numero) {
      r.error(`${campo}.numero`, `${etiqueta}: indique el número de ${nombre}.`);
    } else if ((serie ? `${serie}-${numero}` : numero).length > LONGITUD.documentoRelacionado) {
      r.error(`${campo}.numero`, `${etiqueta}: el número admite hasta ${LONGITUD.documentoRelacionado} caracteres.`);
    }
    const clave = `${tipo}|${serie}|${numero.replace(/^0+(?=\d)/, '')}`;
    if (vistos.has(clave)) r.error(campo, `${etiqueta}: está repetido.`);
    vistos.add(clave);
  });

  // [R188] num. 9.a: la serie y número de la factura «cuando se cuente con dicha información» (no es obligatorio).
  if (motivo === MOTIVO_GRE_VENTA && !lista.some((d) => d && (texto(d.tipo) === '01' || texto(d.tipo) === '03'))) {
    r.advertencia(
      'documentosRelacionados',
      'Documentos relacionados: en una venta conviene relacionar la factura o boleta (RS 188-2010/SUNAT, art. 19, num. 9); si ya existe, agréguela.',
    );
  }
}
