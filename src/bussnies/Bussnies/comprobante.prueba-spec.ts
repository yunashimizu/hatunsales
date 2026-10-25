/**
 * Dobles para las pruebas del motor de comprobantes: una base de datos falsa que registra en
 * orden cada consulta (candados, lecturas, INSERT, BEGIN/COMMIT/ROLLBACK) y una EmisionDirecta
 * falsa que escribe en el mismo registro. Así se prueba el orden real de la transacción única.
 */
import { Logger } from '@nestjs/common';
import { ComprobanteRepository } from '../../repository/Repository/comprobante.repository';
import { ConfiguracionRepository } from '../../repository/Repository/configuracion.repository';
import type { ContextoEmision, DocumentoPreparado, EmisionDirecta, ResultadoEmision } from '../../sunat/emision/emision.contrato';
import type { DocumentoCpe, EmisorCpe } from '../../sunat/nucleo/documento-fiscal.types';
import type { ReceptorResponse } from '../../models/model/receptor.response';
import { ComprobanteBussnies } from './comprobante.bussnies';
import { ReceptorBussnies } from './receptor.bussnies';

export const EMISOR_BETA: EmisorCpe = {
  ruc: '20614736420',
  razonSocial: 'EMISOR DE PRUEBAS S.A.C.',
  direccion: 'AV. PRUEBA 123',
  ubigeo: '150101',
  distrito: 'LIMA',
  provincia: 'LIMA',
  departamento: 'LIMA',
  codigoEstablecimiento: '0000',
};

export const EMISOR_REAL: EmisorCpe = {
  ruc: '20610206337',
  razonSocial: 'HATUNSALES S.A.C.',
  direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN',
  ubigeo: '150119',
  distrito: 'LURIN',
  provincia: 'LIMA',
  departamento: 'LIMA',
  codigoEstablecimiento: '0000',
};

export const CONTEXTO_BETA: ContextoEmision = {
  ambiente: 'beta',
  emisor: EMISOR_BETA,
  series: { factura: 'FB01', boleta: 'BB01', nc_factura: 'FBC1', nc_boleta: 'BBC1', nd_factura: 'FBD1', nd_boleta: 'BBD1' },
  aviso: 'Prueba SUNAT BETA: sin validez tributaria',
  correlativo_inicial: {},
};

export const CONTEXTO_PRODUCCION: ContextoEmision = {
  ambiente: 'produccion',
  emisor: EMISOR_REAL,
  series: { factura: 'F001', boleta: 'B001', nc_factura: 'FC01', nc_boleta: 'BC01', nd_factura: 'FD01', nd_boleta: 'BD01' },
  aviso: null,
  correlativo_inicial: {},
};

export const RECEPTOR_RUC: ReceptorResponse = {
  origen: 'base',
  tipo: 'empresa',
  id_empresa: 31,
  tipo_documento: 6,
  numero_documento: '20123456789',
  denominacion: 'FERRETERIA EL MARTILLO S.A.C.',
  direccion: 'AV. LOS OLIVOS 456',
  email: '',
  telefono: '',
  admite_factura: true,
};

export const RECEPTOR_DNI: ReceptorResponse = {
  origen: 'base',
  tipo: 'cliente',
  id_cliente: 17,
  tipo_documento: 1,
  numero_documento: '45678912',
  denominacion: 'JUAN PEREZ QUISPE',
  direccion: '',
  email: '',
  telefono: '',
  admite_factura: false,
};

export const CONSUMIDOR_FINAL: ReceptorResponse = {
  origen: 'generico',
  tipo: 'cliente',
  tipo_documento: 1,
  numero_documento: '00000000',
  denominacion: 'CLIENTES VARIOS',
  direccion: '',
  email: '',
  telefono: '',
  admite_factura: false,
};

/** Todas las columnas opcionales que conoce el repositorio (fase 9, 12 y 14). */
export const COLUMNAS_COMPLETAS = [
  'comprobantes.hora_emision',
  'comprobantes.forma_pago',
  'comprobantes.cuotas',
  'comprobantes.fecha_limite_envio',
  'comprobantes.doc_modificado_tipo',
  'comprobantes.doc_modificado_serie',
  'comprobantes.doc_modificado_numero',
  'comprobantes.id_comprobante_modificado',
  'comprobantes.nota_motivo',
  'comprobantes.nota_sustento',
  'comprobantes.efecto_nota',
  'comprobantes.reingresar_stock',
  'comprobantes.efectos_aplicados',
  'comprobante_items.id_item_origen',
  'fiscal_envios.respuesta_json',
  'fiscal_envios.bloqueado_hasta',
];

/** Lo que hay hoy en producción (fase 9 aplicada; sin fase 12 ni 14). */
export const COLUMNAS_FASE9 = COLUMNAS_COMPLETAS.filter(
  (c) => !['comprobantes.hora_emision', 'comprobantes.efecto_nota', 'comprobantes.reingresar_stock',
    'comprobantes.efectos_aplicados', 'comprobante_items.id_item_origen'].includes(c),
);

export interface ConsultaRegistrada {
  sql: string;
  parametros: unknown[];
  enTransaccion: boolean;
}

export interface BdFalsa {
  /** Eventos en orden: 'BEGIN', 'tx:lock:comprobante:B001', 'max:B001', 'tx:insert:comprobantes', 'COMMIT'… */
  registro: string[];
  consultas: ConsultaRegistrada[];
  /** MAX(numero) que devuelve cada lectura de la serie, en orden (el último se repite). */
  maximos: Record<string, number[]>;
  /** Comprobante principal vigente de la venta que devuelve cada lectura, en orden (el último se repite). */
  vigentes: Record<number, Array<{ id_comprobante: number; serie: string; numero: number; estado: string } | null>>;
  columnas: string[];
  /** Errores que lanzará cada INSERT de comprobantes, en orden (undefined = inserta bien). */
  erroresInsert: unknown[];
  siguienteId: number;
  manager: { query: jest.Mock };
  dataSource: { query: jest.Mock; transaction: jest.Mock };
}

function siguienteDe<T>(cola: T[] | undefined, respaldo: T): T {
  if (!cola || cola.length === 0) return respaldo;
  return cola.length > 1 ? (cola.shift() as T) : cola[0];
}

export function crearBdFalsa(parcial: Partial<Pick<BdFalsa, 'maximos' | 'vigentes' | 'columnas' | 'erroresInsert'>> = {}): BdFalsa {
  const bd = {
    registro: [] as string[],
    consultas: [] as ConsultaRegistrada[],
    maximos: parcial.maximos ?? {},
    vigentes: parcial.vigentes ?? {},
    columnas: parcial.columnas ?? COLUMNAS_FASE9,
    erroresInsert: parcial.erroresInsert ?? [],
    siguienteId: 900,
  } as BdFalsa;

  const responder = async (sql: string, parametros: unknown[] = [], enTransaccion: boolean): Promise<unknown> => {
    bd.consultas.push({ sql, parametros, enTransaccion });
    const prefijo = enTransaccion ? 'tx:' : '';
    if (/pg_advisory_xact_lock/.test(sql)) {
      bd.registro.push(`${prefijo}lock:${String(parametros[0])}`);
      return [{}];
    }
    if (/information_schema\.columns/.test(sql)) {
      bd.registro.push(`${prefijo}columnas`);
      return bd.columnas.map((columna) => ({ columna }));
    }
    if (/COALESCE\(MAX\(numero\), 0\) AS ultimo/.test(sql)) {
      const serie = String(parametros[0]);
      bd.registro.push(`${prefijo}max:${serie}`);
      return [{ ultimo: siguienteDe(bd.maximos[serie], 0) }];
    }
    if (/FROM comprobantes\s+WHERE id_venta = \$1/.test(sql)) {
      const idVenta = Number(parametros[0]);
      bd.registro.push(`${prefijo}vigente:${idVenta}`);
      const fila = siguienteDe(bd.vigentes[idVenta], null);
      return fila ? [fila] : [];
    }
    if (/^\s*INSERT INTO comprobantes\s*\(/.test(sql)) {
      bd.registro.push(`${prefijo}insert:comprobantes`);
      const error = bd.erroresInsert.shift();
      if (error) throw error;
      return [{ id_comprobante: bd.siguienteId++ }];
    }
    if (/^\s*INSERT INTO comprobante_items/.test(sql)) {
      bd.registro.push(`${prefijo}insert:items`);
      return [];
    }
    throw new Error(`Consulta no prevista en la prueba: ${sql.slice(0, 120)}`);
  };

  bd.manager = { query: jest.fn((sql: string, parametros?: unknown[]) => responder(sql, parametros, true)) };
  bd.dataSource = {
    query: jest.fn((sql: string, parametros?: unknown[]) => responder(sql, parametros, false)),
    transaction: jest.fn(async (trabajo: (manager: unknown) => Promise<unknown>) => {
      bd.registro.push('BEGIN');
      try {
        const resultado = await trabajo(bd.manager);
        bd.registro.push('COMMIT');
        return resultado;
      } catch (error) {
        bd.registro.push('ROLLBACK');
        throw error;
      }
    }),
  };
  return bd;
}

/** Repositorio REAL sobre la base falsa (findOne/find se pueden simular aparte). */
export function crearRepositorio(bd: BdFalsa, extra: { findOne?: jest.Mock; find?: jest.Mock } = {}): ComprobanteRepository {
  const typeorm = {
    manager: { connection: bd.dataSource },
    findOne: extra.findOne ?? jest.fn().mockResolvedValue(null),
    find: extra.find ?? jest.fn().mockResolvedValue([]),
  };
  return new ComprobanteRepository(typeorm as never);
}

export function resultadoEmision(parcial: Partial<ResultadoEmision> = {}): ResultadoEmision {
  return {
    ambiente: 'beta',
    id_envio: 501,
    nombre_base: '20614736420-03-BB01-00000001',
    estado: 'ACEPTADO',
    aceptado: true,
    codigo: '0',
    mensaje: 'El comprobante ha sido aceptado',
    observaciones: [],
    digest: 'HASH-SUNAT',
    cadena_qr: '20614736420|03|BB01|1|0.00|10.00|2026-10-21|1|45678912|HASH-SUNAT|',
    accion: 'NINGUNA',
    archivos: ['xml_original', 'xml_firmado', 'zip', 'cdr_xml', 'cdr_zip'],
    fecha_limite_envio: '2026-10-26',
    ...parcial,
  };
}

export type EmisionFalsa = { [K in keyof EmisionDirecta]: jest.Mock };

/** EmisionDirecta falsa: prepara sin firmar y anota en el registro cuándo registra y envía. */
export function crearEmisionFalsa(bd: BdFalsa, contexto: ContextoEmision = CONTEXTO_BETA): EmisionFalsa {
  return {
    modo: jest.fn().mockResolvedValue({ activo: true, ambiente: contexto.ambiente }),
    contexto: jest.fn().mockResolvedValue(contexto),
    prepararDocumento: jest.fn(async (documento: DocumentoCpe): Promise<DocumentoPreparado> => {
      bd.registro.push(`preparar:${documento.serie}-${documento.numero}`);
      return {
        ambiente: contexto.ambiente,
        documento,
        material: {} as never,
        preparado: {
          nombreBase: `${documento.emisor.ruc}-${documento.tipo}-${documento.serie}-${String(documento.numero).padStart(8, '0')}`,
          xmlSinFirmar: '<xml/>',
          xmlFirmado: '<xml firmado/>',
          digestValue: 'HASH-LOCAL',
          signatureValue: 'FIRMA',
          zip: {} as never,
          cadenaQr: 'QR-LOCAL',
          advertencias: [],
        },
      };
    }),
    registrarEnvio: jest.fn(async (consultor: unknown, _preparado: unknown, idComprobante: number) => {
      bd.registro.push(consultor === bd.manager ? `tx:registrarEnvio:${idComprobante}` : `registrarEnvio-FUERA:${idComprobante}`);
      return 501;
    }),
    enviarRegistrado: jest.fn(async (idEnvio: number) => {
      bd.registro.push(`enviar:${idEnvio}`);
      return resultadoEmision({ ambiente: contexto.ambiente, id_envio: idEnvio });
    }),
    emitirPreparado: jest.fn(),
    reintentar: jest.fn(),
    recuperarCdr: jest.fn(),
    confirmarAceptadoManual: jest.fn(),
    obtenerArchivo: jest.fn(),
    listarEnvios: jest.fn(),
    obtenerEnvio: jest.fn().mockResolvedValue(null),
  };
}

export function crearReceptorFalso() {
  return {
    buscarPorDocumento: jest.fn(async (documento: string) => (documento.length === 11 ? { ...RECEPTOR_RUC } : { ...RECEPTOR_DNI })),
    porIdEmpresa: jest.fn().mockResolvedValue({ ...RECEPTOR_RUC }),
    porIdCliente: jest.fn().mockResolvedValue({ ...RECEPTOR_DNI }),
    consumidorFinal: jest.fn(() => ({ ...CONSUMIDOR_FINAL })),
  };
}

export function crearConfigFalsa(valores: Record<string, string | null> = {}) {
  const leer = (clave: string) => (clave in valores ? valores[clave] : null);
  return {
    obtenerNumero: jest.fn(async (clave: string, defecto: number) => {
      const valor = leer(clave);
      return valor === null ? (clave === 'tienda_igv_porcentaje' ? 18 : defecto) : Number(valor);
    }),
    obtenerTexto: jest.fn(async (clave: string, defecto: string) => leer(clave) ?? defecto),
    obtener: jest.fn(async (clave: string) => leer(clave)),
    obtenerVarias: jest.fn(async (claves: string[]) => Object.fromEntries(claves.map((clave) => [clave, leer(clave)]))),
  };
}

export interface Motor {
  servicio: ComprobanteBussnies;
  bd: BdFalsa;
  emision: EmisionFalsa;
  receptor: ReturnType<typeof crearReceptorFalso>;
  config: ReturnType<typeof crearConfigFalsa>;
  repo: ComprobanteRepository;
}

export function crearMotor(opciones: {
  bd?: BdFalsa;
  contexto?: ContextoEmision;
  config?: Record<string, string | null>;
  findOne?: jest.Mock;
} = {}): Motor {
  const bd = opciones.bd ?? crearBdFalsa();
  const emision = crearEmisionFalsa(bd, opciones.contexto ?? CONTEXTO_BETA);
  const receptor = crearReceptorFalso();
  const config = crearConfigFalsa(opciones.config);
  const repo = crearRepositorio(bd, { findOne: opciones.findOne });
  const servicio = new ComprobanteBussnies(
    repo,
    receptor as unknown as ReceptorBussnies,
    config as unknown as ConfiguracionRepository,
    emision as unknown as EmisionDirecta,
  );
  return { servicio, bd, emision, receptor, config, repo };
}

/** Los avisos del motor (reintentos de número, envíos que no terminan) son esperados en estas pruebas. */
export function silenciarLogs(): void {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
}

/** Posición de un evento en el registro (falla la prueba con el registro completo si no está). */
export function posicion(registro: string[], evento: string): number {
  const indice = registro.indexOf(evento);
  if (indice < 0) throw new Error(`No se encontró "${evento}" en el registro: ${registro.join(' → ')}`);
  return indice;
}
