import AdmZip from 'adm-zip';
import { Logger } from '@nestjs/common';
import type { FiscalAuditoriaRepository } from '../auditoria/fiscal-auditoria.repository';
import type { CertificadoFiscalService } from '../certificado/certificado-fiscal.service';
import type { FiscalConfigService } from '../config/fiscal-config.service';
import type { AmbienteFiscal, BloqueoEmision } from '../config/fiscal-config.tipos';
import { FiscalConfigError } from '../config/fiscal-errores';
import type { InterruptorEmisionFiscal } from '../config/interruptor-emision.service';
import { RelojFiscal } from '../config/reloj-fiscal';
import type { TransaccionesFiscales } from '../config/transacciones-fiscales';
import { EventoEnvioCompletado, OyenteEnvioFiscal, OyentesEnvioFiscal } from '../emision/emision.contrato';
import type { CierreEnvio } from '../emision/emision.tipos';
import type { EnvioFiscalRepository } from '../emision/envio-fiscal.repository';
import type { SunatEmisionService } from '../emision/sunat-emision.service';
import { ClasificadorRespuestaSunat } from '../nucleo/clasificador-respuesta';
import type { DocumentoCpe, RespuestaSunat } from '../nucleo/documento-fiscal.types';
import { PreparadorEnvioCpe } from '../nucleo/preparador-envio-cpe';
import { generarCertificadoPrueba, materialDePrueba } from '../nucleo/pruebas/certificados-prueba-spec';
import { boletaPrueba, EMISOR_PRUEBA, facturaPrueba } from '../nucleo/pruebas/documentos-prueba-spec';
import { ESTADOS_LOTE_ABIERTOS, efectoDelCierre } from './lote-fiscal.repository';
import type { CabeceraBaja, LoteCerrado, LoteFiscalRepository, LoteRegistrado, RegistroLoteNuevo } from './lote-fiscal.repository';
import { ESPERA_TICKET_MINUTOS, LotesFiscalesService, MAXIMO_CONSULTAS_TICKET } from './lotes-fiscales.service';

class RelojPrueba extends RelojFiscal {
  /** 10:00 en Lima del 5/11/2026. */
  momento = new Date('2026-11-05T15:00:00Z');
  ahora(): Date {
    return this.momento;
  }
}

/**
 * fiscal_envios (lotes) + fiscal_resumen_lineas + comprobantes en memoria, con las mismas reglas de
 * reclamo, cierre y efectos sobre los comprobantes que el SQL de LoteFiscalRepository.
 */
class LotesMemoria {
  private siguiente = 700;
  readonly comprobantes = new Map<number, CabeceraBaja>();
  readonly lotes = new Map<number, LoteRegistrado>();
  /** Estado que tenía cada comprobante al entrar al lote (lo que guarda la línea). */
  readonly previos = new Map<number, string>();
  readonly registros: RegistroLoteNuevo[] = [];
  readonly cierres: Array<{ id: number; cierre: CierreEnvio }> = [];
  readonly tickets: Array<{ id: number; ticket: string; mensaje: string; espera: number }> = [];
  ocupadosAlRegistrar = 0;

  cabeceraComprobante = jest.fn(async (id: number) => this.comprobantes.get(id) ?? null);

  siguienteCorrelativo = jest.fn(async (_tx: unknown, ambiente: AmbienteFiscal, prefijo: string, fecha: string) => {
    const patron = new RegExp(`^${prefijo}-${fecha.replace(/-/g, '')}-(\\d+)$`);
    const usados = [...this.lotes.values()]
      .filter((l) => l.ambiente === ambiente)
      .map((l) => Number(patron.exec(l.identificador)?.[1] ?? 0));
    return Math.max(0, ...usados) + 1;
  });

  registrar = jest.fn(async (_tx: unknown, r: RegistroLoteNuevo) => {
    if (this.ocupadosAlRegistrar > 0) {
      this.ocupadosAlRegistrar -= 1;
      throw new FiscalConfigError('FISCAL_NUMERO_OCUPADO', 'El identificador ya se usó.');
    }
    for (const linea of r.lineas) {
      const c = this.comprobantes.get(linea.id_comprobante);
      if (!c || !['ACEPTADO', 'ACEPTADO_OBS'].includes(c.estado_sunat ?? '') || c.anulado) {
        throw new FiscalConfigError('FISCAL_ENVIO_EN_CURSO', 'El comprobante ya tiene una baja en curso.');
      }
    }
    const id = ++this.siguiente;
    this.registros.push(r);
    for (const linea of r.lineas) {
      const c = this.comprobantes.get(linea.id_comprobante) as CabeceraBaja;
      this.previos.set(linea.id_comprobante, c.estado_sunat as string);
      c.estado_sunat = 'BAJA_PENDIENTE';
    }
    this.lotes.set(id, {
      id_envio: id,
      ambiente: r.ambiente,
      operacion: r.operacion,
      tipo_documento: r.operacion === 'baja' ? 'RA' : 'RC',
      estado: 'ENVIANDO',
      intento: 1,
      nombre_archivo: r.lote.zip.nombreZip,
      nombre_base: r.lote.nombreBase,
      identificador: r.lote.identificador,
      sunat_ticket: null,
      codigo_sunat: null,
      accion: null,
      libre: false,
      fecha_referencia: r.fechaReferencia,
      zip: r.lote.zip.zip,
      lineas: r.lineas.map((l) => ({
        id_comprobante: l.id_comprobante,
        serie: l.serie,
        numero: l.numero,
        tipo_documento: l.tipo_documento,
        condicion: l.condicion,
        estado: this.previos.get(l.id_comprobante) ?? null,
      })),
    });
    return id;
  });

  reclamarPrimerEnvio = jest.fn(async (id: number) => {
    const l = this.lotes.get(id);
    if (!l || l.estado !== 'ENVIANDO' || l.intento !== 1 || l.sunat_ticket) return null;
    l.libre = false;
    return { ...l };
  });

  reclamarEnvio = jest.fn(async (id: number) => {
    const l = this.lotes.get(id);
    if (!l || !l.libre || l.sunat_ticket || !['PENDIENTE_REENVIO', 'ENVIANDO'].includes(l.estado)) return null;
    Object.assign(l, { estado: 'ENVIANDO', intento: l.intento + 1, libre: false });
    return { ...l };
  });

  reclamarConsulta = jest.fn(async (id: number) => {
    const l = this.lotes.get(id);
    const consultable = !!l && !!l.sunat_ticket && (l.estado === 'TICKET_PENDIENTE' || (l.estado === 'EXCEPCION' && l.accion === 'CONSULTAR_TICKET'));
    if (!l || !consultable || !l.libre) return null;
    l.libre = false;
    return { ...l };
  });

  leer = jest.fn(async (id: number) => {
    const l = this.lotes.get(id);
    return l ? { ...l } : null;
  });

  guardarTicket = jest.fn(async (id: number, ticket: string, mensaje: string, espera: number) => {
    const l = this.lotes.get(id);
    if (!l || !['ENVIANDO', 'TICKET_PENDIENTE', 'EXCEPCION'].includes(l.estado)) return false;
    Object.assign(l, { estado: 'TICKET_PENDIENTE', sunat_ticket: ticket, intento: l.intento + 1, libre: true, accion: 'CONSULTAR_TICKET' });
    this.tickets.push({ id, ticket, mensaje, espera });
    return true;
  });

  completar = jest.fn(async (id: number, _ambiente: AmbienteFiscal, _nombreBase: string, cierre: CierreEnvio): Promise<LoteCerrado | null> => {
    const l = this.lotes.get(id);
    if (!l || !ESTADOS_LOTE_ABIERTOS.includes(l.estado)) return null;
    Object.assign(l, { estado: cierre.estado, accion: cierre.accion, libre: true, codigo_sunat: cierre.sunat?.codigo ?? l.codigo_sunat });
    this.cierres.push({ id, cierre });
    const efecto = efectoDelCierre(cierre);
    for (const linea of l.lineas) {
      const c = this.comprobantes.get(linea.id_comprobante) as CabeceraBaja;
      if (efecto === 'anular') {
        linea.estado = 'ACEPTADO';
        if (c.estado_sunat === 'BAJA_PENDIENTE') c.estado_sunat = 'ANULADO';
      } else if (efecto === 'restaurar') {
        if (c.estado_sunat === 'BAJA_PENDIENTE') c.estado_sunat = this.previos.get(linea.id_comprobante) as string;
        linea.estado = 'RECHAZADO';
      }
    }
    return {
      id_comprobante: l.lineas[0]?.id_comprobante ?? null,
      ids_comprobantes: l.lineas.map((x) => x.id_comprobante),
      tipo_documento: l.tipo_documento,
      operacion: l.operacion,
      identificador: l.identificador,
    };
  });

  loteDeComprobante = jest.fn(async (idComprobante: number) => {
    const ultimo = [...this.lotes.values()]
      .filter((l) => l.lineas.some((x) => x.id_comprobante === idComprobante && x.estado !== 'RECHAZADO'))
      .sort((a, b) => b.id_envio - a.id_envio)[0];
    return ultimo
      ? { id_envio: ultimo.id_envio, operacion: ultimo.operacion, identificador: ultimo.identificador, estado: ultimo.estado, sunat_ticket: ultimo.sunat_ticket, mensaje: null }
      : null;
  });
}

const certificado = generarCertificadoPrueba({ desde: new Date('2026-10-01'), hasta: new Date('2027-10-13') });
const material = materialDePrueba(certificado);

const TICKET = '202611050001';

function respuesta(parcial: Partial<RespuestaSunat>): RespuestaSunat {
  return { tipo: 'TICKET', codigo: '', descripcion: '', observaciones: [], tiempoMs: 12, ...parcial };
}

const CDR_ACEPTADO = respuesta({
  tipo: 'CDR',
  codigo: '0',
  statusCode: '0',
  descripcion: 'La Comunicacion de baja RA-20261105-00001 ha sido aceptada',
  cdrXml: '<ApplicationResponse/>',
  cdrZip: Buffer.from('zip-del-cdr'),
});

interface OpcionesCrear {
  ambiente?: AmbienteFiscal;
  documento?: DocumentoCpe | null;
  cabecera?: Partial<CabeceraBaja>;
}

function crear(opciones: OpcionesCrear = {}) {
  const reloj = new RelojPrueba();
  const lotes = new LotesMemoria();
  const documento = opciones.documento === undefined ? facturaPrueba(undefined, { serie: 'F001', numero: 12, fechaEmision: '2026-11-03' }) : opciones.documento;
  const esBoleta = documento?.tipo === '03';
  const cabecera: CabeceraBaja = {
    id_comprobante: 40,
    id_tipo: esBoleta ? 2 : 1,
    serie: documento?.serie ?? 'F001',
    numero: documento?.numero ?? 12,
    fecha_de_emision: '03-11-2026',
    estado_sunat: 'ACEPTADO',
    aceptada_sunat: true,
    anulado: false,
    ambiente_fiscal: opciones.ambiente ?? 'produccion',
    proveedor_fiscal: 'sunat_directo',
    id_envio_ultimo: 500,
    ...opciones.cabecera,
  };
  lotes.comprobantes.set(cabecera.id_comprobante, cabecera);

  const envios = { leer: jest.fn(async () => (documento ? { datos: { documento, digest: '', cadena_qr: '' } } : { datos: null })) };
  const cliente = {
    enviarResumen: jest.fn(async (): Promise<RespuestaSunat> => respuesta({ tipo: 'TICKET', ticket: TICKET, descripcion: `SUNAT recibió el lote; ticket ${TICKET}.` })),
    consultarTicket: jest.fn(async (): Promise<RespuestaSunat> => CDR_ACEPTADO),
  };
  const emision = { clienteSoap: jest.fn(async () => cliente) };
  const bloqueos: Record<AmbienteFiscal, BloqueoEmision | null> = { beta: null, produccion: null };
  const interruptor = {
    leer: jest.fn(async (ambiente: AmbienteFiscal) => bloqueos[ambiente]),
    abrir: jest.fn(async (ambiente: AmbienteFiscal, causa: { codigo: string; motivo: string }) => {
      bloqueos[ambiente] = { ...causa, fecha: '2026-11-05T15:00:00.000Z' };
      return bloqueos[ambiente];
    }),
  };
  const oyentes = new OyentesEnvioFiscal();
  const eventos: EventoEnvioCompletado[] = [];
  oyentes.registrar({ alCompletarEnvio: async (evento: EventoEnvioCompletado) => void eventos.push(evento) } as OyenteEnvioFiscal);
  const auditoria = { registrar: jest.fn(async () => undefined) };
  const transacciones = { ejecutar: jest.fn(async (trabajo: (tx: { query: jest.Mock }) => Promise<unknown>) => trabajo({ query: jest.fn() })) };
  const certificados = {
    obtenerMaterialFirma: jest.fn(async () => ({ ...material })),
    obtenerMaterialFirmaBeta: jest.fn(async () => ({ ...material })),
  };
  const snapshot = { ambiente: opciones.ambiente ?? 'produccion', emisor: { ...EMISOR_PRUEBA }, certRucConfirmadoProduccion: false };
  const config = { snapshotFresco: jest.fn(async () => snapshot) };
  const emisorBeta = { obtenerEmisor: jest.fn(async () => ({ ...EMISOR_PRUEBA })) };

  const servicio = new LotesFiscalesService(
    lotes as unknown as LoteFiscalRepository,
    envios as unknown as EnvioFiscalRepository,
    new PreparadorEnvioCpe(),
    emision as unknown as SunatEmisionService,
    new ClasificadorRespuestaSunat({ warn: () => undefined }),
    certificados as unknown as CertificadoFiscalService,
    config as unknown as FiscalConfigService,
    emisorBeta,
    interruptor as unknown as InterruptorEmisionFiscal,
    oyentes,
    auditoria as unknown as FiscalAuditoriaRepository,
    transacciones as unknown as TransaccionesFiscales,
    reloj,
  );
  const esperas: number[] = [];
  jest.spyOn(servicio as unknown as { esperar: (ms: number) => Promise<void> }, 'esperar').mockImplementation(async (ms: number) => {
    esperas.push(ms);
  });
  return { servicio, lotes, envios, cliente, emision, interruptor, bloqueos, eventos, auditoria, transacciones, certificados, emisorBeta, reloj, esperas, cabecera };
}

/** XML firmado que viaja dentro del ZIP del lote. */
function xmlDelLote(zip: Buffer | null): string {
  const archivo = new AdmZip(zip as Buffer);
  return archivo.readAsText(archivo.getEntries()[0]);
}

const PEDIDO = { id_comprobante: 40, motivo: 'Error en el monto cobrado', idUsuario: 7 };

describe('LotesFiscalesService: anular sin nota con la baja (RA) o el resumen (RC) de SUNAT', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  describe('solicitar la anulación', () => {
    it('factura dentro del plazo: arma y firma la comunicación de baja (RA), la envía y queda con su ticket y el comprobante en BAJA_PENDIENTE', async () => {
      const { servicio, lotes, cliente, emision, auditoria, cabecera } = crear();

      const resultado = await servicio.solicitarAnulacion(PEDIDO);

      expect(resultado).toMatchObject({ operacion: 'baja', identificador: 'RA-20261105-00001', estado: 'TICKET_PENDIENTE', aceptado: false, ticket: TICKET });
      expect(cabecera.estado_sunat).toBe('BAJA_PENDIENTE');

      const registro = lotes.registros[0];
      expect(registro).toMatchObject({
        ambiente: 'produccion',
        operacion: 'baja',
        fechaReferencia: '2026-11-03',
        idUsuario: 7,
        motivo: 'Error en el monto cobrado',
        lineas: [{ id_comprobante: 40, serie: 'F001', numero: 12, tipo_documento: '01', condicion: 3 }],
      });
      const xml = xmlDelLote(registro.lote.zip.zip);
      expect(xml).toContain('VoidedDocuments');
      expect(xml).toContain('<cbc:ID>RA-20261105-00001</cbc:ID>');
      expect(xml).toContain('<cbc:ReferenceDate>2026-11-03</cbc:ReferenceDate>');
      expect(xml).toContain('<sac:VoidReasonDescription>Error en el monto cobrado</sac:VoidReasonDescription>');
      expect(xml).toContain('<ds:SignatureValue>');

      // Los mismos bytes del ZIP guardado viajan a SUNAT, con las credenciales y el RUC del emisor.
      expect(emision.clienteSoap).toHaveBeenCalledWith('produccion', '20610206337', 30_000);
      expect(cliente.enviarResumen).toHaveBeenCalledWith('20610206337-RA-20261105-00001.zip', registro.lote.zip.base64);
      expect(lotes.tickets).toEqual([{ id: resultado.id_envio, ticket: TICKET, mensaje: expect.stringContaining(TICKET), espera: ESPERA_TICKET_MINUTOS[0] }]);
      expect(auditoria.registrar).toHaveBeenCalledWith(
        expect.objectContaining({ accion: 'FISCAL_BAJA_SOLICITADA', id_usuario: 7, entidad: 'fiscal_envios', id_entidad: resultado.id_envio }),
        expect.anything(),
      );
    });

    it('boleta: arma el resumen diario (RC) con la condición 3 «anular» y los totales y el cliente del documento', async () => {
      const documento = boletaPrueba(undefined, { serie: 'B001', numero: 33, fechaEmision: '2026-11-04' });
      const { servicio, lotes } = crear({ documento });

      const resultado = await servicio.solicitarAnulacion(PEDIDO);

      expect(resultado).toMatchObject({ operacion: 'resumen', identificador: 'RC-20261105-00001', estado: 'TICKET_PENDIENTE' });
      expect(lotes.registros[0]).toMatchObject({ operacion: 'resumen', fechaReferencia: '2026-11-04', lineas: [{ tipo_documento: '03', condicion: 3 }] });
      const xml = xmlDelLote(lotes.registros[0].lote.zip.zip);
      expect(xml).toContain('SummaryDocuments');
      expect(xml).toContain('<cbc:ReferenceDate>2026-11-04</cbc:ReferenceDate>');
      expect(xml).toContain('<cbc:IssueDate>2026-11-05</cbc:IssueDate>');
      expect(xml).toContain('<cbc:ID>B001-00000033</cbc:ID>');
      expect(xml).toContain('<cbc:ConditionCode>3</cbc:ConditionCode>');
      expect(xml).toContain('<cbc:AdditionalAccountID>0</cbc:AdditionalAccountID>');
      expect(xml).toContain(`>${documento.totales.total.toFixed(2)}</sac:TotalAmount>`);
      expect(xml).toContain(`>${documento.totales.igv.toFixed(2)}</cbc:TaxAmount>`);
    });

    it('BETA: usa el emisor de pruebas, el certificado BETA y las credenciales BETA', async () => {
      const { servicio, certificados, emisorBeta, emision } = crear({ ambiente: 'beta' });

      await servicio.solicitarAnulacion(PEDIDO);

      expect(emisorBeta.obtenerEmisor).toHaveBeenCalled();
      expect(certificados.obtenerMaterialFirmaBeta).toHaveBeenCalled();
      expect(certificados.obtenerMaterialFirma).not.toHaveBeenCalled();
      expect(emision.clienteSoap).toHaveBeenCalledWith('beta', '20610206337', 30_000);
    });

    it('fuera de plazo (más de 7 días desde la emisión): error claro y no registra ni envía nada', async () => {
      const documento = facturaPrueba(undefined, { serie: 'F001', numero: 12, fechaEmision: '2026-10-28' });
      const { servicio, lotes, cliente, cabecera } = crear({ documento });

      await expect(servicio.solicitarAnulacion(PEDIDO)).rejects.toMatchObject({
        codigo: 'FISCAL_BAJA_FUERA_DE_PLAZO',
        message: 'Ya pasaron los 7 días: anúlelo con una nota de crédito.',
      });
      expect(lotes.registrar).not.toHaveBeenCalled();
      expect(cliente.enviarResumen).not.toHaveBeenCalled();
      expect(cabecera.estado_sunat).toBe('ACEPTADO');
    });

    it('el 7.º día todavía vale (D a D+7)', async () => {
      const documento = facturaPrueba(undefined, { serie: 'F001', numero: 12, fechaEmision: '2026-10-29' });
      const { servicio } = crear({ documento });

      await expect(servicio.solicitarAnulacion(PEDIDO)).resolves.toMatchObject({ estado: 'TICKET_PENDIENTE' });
    });

    it('sin el documento electrónico guardado: error que manda a la nota de crédito', async () => {
      const { servicio, lotes } = crear({ documento: null });

      await expect(servicio.solicitarAnulacion(PEDIDO)).rejects.toMatchObject({
        codigo: 'FISCAL_DOC_NO_ENCONTRADO',
        message: 'El comprobante no conserva su documento electrónico: anúlelo con una nota de crédito.',
      });
      expect(lotes.registrar).not.toHaveBeenCalled();
    });

    it.each([
      ['ya está anulado', { anulado: true }, 'FISCAL_CONFIG_INVALIDA'],
      ['todavía no está aceptado', { estado_sunat: 'PENDIENTE_REENVIO', aceptada_sunat: false }, 'FISCAL_CONFIG_INVALIDA'],
      ['ya tiene una baja en curso', { estado_sunat: 'BAJA_PENDIENTE' }, 'FISCAL_ENVIO_EN_CURSO'],
      ['se emitió con el sistema anterior', { proveedor_fiscal: 'nubefact' }, 'FISCAL_DOC_OTRO_PROVEEDOR'],
      ['se emitió en otro ambiente', { ambiente_fiscal: 'beta' }, 'FISCAL_AMBIENTE_CAMBIO'],
      ['es una nota de crédito', { id_tipo: 7 }, 'FISCAL_CONFIG_INVALIDA'],
    ])('rechaza el comprobante que %s, sin registrar nada', async (_caso, cambios, codigo) => {
      const { servicio, lotes } = crear({ cabecera: cambios as Partial<CabeceraBaja> });

      await expect(servicio.solicitarAnulacion(PEDIDO)).rejects.toMatchObject({ codigo });
      expect(lotes.registrar).not.toHaveBeenCalled();
    });

    it('un comprobante que ya tiene un lote vigente no admite otro; uno rechazado sí (se pide de nuevo con un número nuevo)', async () => {
      const { servicio, lotes, cabecera, cliente } = crear();
      cliente.enviarResumen.mockResolvedValueOnce(respuesta({ tipo: 'FAULT', codigo: '2800', descripcion: 'El dato ingresado no cumple el formato' }));

      const primero = await servicio.solicitarAnulacion(PEDIDO);
      expect(primero).toMatchObject({ estado: 'RECHAZADO' });
      expect(cabecera.estado_sunat).toBe('ACEPTADO');

      const segundo = await servicio.solicitarAnulacion(PEDIDO);
      expect(segundo).toMatchObject({ identificador: 'RA-20261105-00002', estado: 'TICKET_PENDIENTE' });
      await expect(servicio.solicitarAnulacion(PEDIDO)).rejects.toMatchObject({ codigo: 'FISCAL_ENVIO_EN_CURSO' });
      expect(lotes.registros).toHaveLength(2);
    });

    it('el correlativo sube con cada lote del día y nunca reutiliza un número, ni el de un lote rechazado', async () => {
      const { servicio, lotes, cliente } = crear();
      lotes.comprobantes.set(41, { ...(lotes.comprobantes.get(40) as CabeceraBaja), id_comprobante: 41 });
      cliente.enviarResumen.mockResolvedValueOnce(respuesta({ tipo: 'FAULT', codigo: '2800', descripcion: 'rechazado' }));

      await servicio.solicitarAnulacion(PEDIDO); // RA-…-00001, rechazado
      const otro = await servicio.solicitarAnulacion({ ...PEDIDO, id_comprobante: 41 });

      expect(otro.identificador).toBe('RA-20261105-00002');
    });

    it('si otra solicitud tomó el mismo número a la vez (índice único), reintenta una vez con el siguiente', async () => {
      const { servicio, lotes } = crear();
      lotes.ocupadosAlRegistrar = 1;

      const resultado = await servicio.solicitarAnulacion(PEDIDO);

      expect(resultado.estado).toBe('TICKET_PENDIENTE');
      expect(lotes.registrar).toHaveBeenCalledTimes(2);
    });

    it('un motivo vacío o de más de 100 caracteres no pasa (400) y no toca nada', async () => {
      const { servicio, lotes } = crear();

      await expect(servicio.solicitarAnulacion({ ...PEDIDO, motivo: '   ' })).rejects.toMatchObject({ codigo: 'FISCAL_CONFIG_INVALIDA' });
      await expect(servicio.solicitarAnulacion({ ...PEDIDO, motivo: 'x'.repeat(101) })).rejects.toMatchObject({ codigo: 'FISCAL_CONFIG_INVALIDA' });
      expect(lotes.cabeceraComprobante).not.toHaveBeenCalled();
    });

    it('un certificado de otro RUC no firma la baja', async () => {
      const { servicio, certificados, lotes } = crear();
      certificados.obtenerMaterialFirma.mockResolvedValue({ ...material, ruc: '20100070970' });

      await expect(servicio.solicitarAnulacion(PEDIDO)).rejects.toMatchObject({ codigo: 'FISCAL_CERT_RUC_NO_COINCIDE' });
      expect(lotes.registrar).not.toHaveBeenCalled();
    });
  });

  describe('el envío del lote', () => {
    it('interruptor abierto (SUNAT rechazó la credencial): no llama a SUNAT y queda PENDIENTE_REENVIO para cuando se reanude', async () => {
      const { servicio, lotes, cliente, bloqueos, eventos } = crear();
      bloqueos.produccion = { codigo: '0103', motivo: 'Clave SOL rechazada.', fecha: '2026-11-05T14:00:00.000Z' };

      const resultado = await servicio.solicitarAnulacion(PEDIDO);

      expect(cliente.enviarResumen).not.toHaveBeenCalled();
      expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO', aceptado: false });
      expect(resultado.mensaje).toContain('Clave SOL rechazada.');
      expect(lotes.cierres[0].cierre).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR', proximoIntentoMin: 0 });
      expect((lotes.comprobantes.get(40) as CabeceraBaja).estado_sunat).toBe('BAJA_PENDIENTE');
      expect(eventos[0]).toMatchObject({ operacion: 'baja', aceptado: false, estado: 'PENDIENTE_REENVIO' });

      // Con el interruptor abierto ni el reintento manual ni la tarea llaman a SUNAT.
      await expect(servicio.reintentar(resultado.id_envio)).rejects.toMatchObject({ codigo: 'FISCAL_EMISION_BLOQUEADA' });

      bloqueos.produccion = null;
      const reanudado = await servicio.reintentar(resultado.id_envio);
      expect(reanudado).toMatchObject({ estado: 'TICKET_PENDIENTE', ticket: TICKET });
      expect(cliente.enviarResumen).toHaveBeenCalledTimes(1);
    });

    it('un Fault de credencial SOL abre el interruptor y deja el lote para reenviarlo al reanudar', async () => {
      const { servicio, cliente, interruptor, lotes } = crear();
      cliente.enviarResumen.mockResolvedValueOnce(respuesta({ tipo: 'FAULT', codigo: '0102', descripcion: 'Usuario o contraseña incorrectos' }));

      const resultado = await servicio.solicitarAnulacion(PEDIDO);

      expect(interruptor.abrir).toHaveBeenCalledWith('produccion', expect.objectContaining({ codigo: '0102' }), expect.anything());
      expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO' });
      expect(lotes.cierres[0].cierre).toMatchObject({ accion: 'REINTENTAR', proximoIntentoMin: 0 });
      expect((lotes.comprobantes.get(40) as CabeceraBaja).estado_sunat).toBe('BAJA_PENDIENTE');
    });

    it('un error de red al enviar: PENDIENTE_REENVIO con espera (el comprobante sigue en BAJA_PENDIENTE); tras 6 intentos pasa a EXCEPCION y se restaura', async () => {
      const { servicio, cliente, lotes } = crear();
      cliente.enviarResumen.mockResolvedValue(respuesta({ tipo: 'TRANSPORTE', codigo: 'ETIMEDOUT', descripcion: 'timeout' }));

      const primero = await servicio.solicitarAnulacion(PEDIDO);
      expect(primero).toMatchObject({ estado: 'PENDIENTE_REENVIO' });
      expect(lotes.cierres[0].cierre.proximoIntentoMin).toBe(2);
      expect((lotes.comprobantes.get(40) as CabeceraBaja).estado_sunat).toBe('BAJA_PENDIENTE');

      let ultimo = primero;
      for (let i = 0; i < 5; i++) ultimo = await servicio.reintentar(primero.id_envio);
      expect(ultimo.estado).toBe('EXCEPCION');
      expect((lotes.comprobantes.get(40) as CabeceraBaja).estado_sunat).toBe('ACEPTADO');
    });

    it('un usuario SOL de otro RUC (error de configuración al crear el cliente) deja el lote pendiente con el motivo', async () => {
      const { servicio, emision, cliente } = crear();
      emision.clienteSoap.mockRejectedValueOnce(new FiscalConfigError('FISCAL_SOL_RUC_NO_COINCIDE', 'El usuario SOL no es del RUC emisor.'));

      const resultado = await servicio.solicitarAnulacion(PEDIDO);

      expect(cliente.enviarResumen).not.toHaveBeenCalled();
      expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO' });
      expect(resultado.mensaje).toContain('El usuario SOL no es del RUC emisor.');
    });

    it('reintentar solo reenvía lo pendiente o consulta el ticket: en otro estado, FISCAL_REENVIO_NO_PERMITIDO', async () => {
      const { servicio, lotes } = crear();
      const resultado = await servicio.solicitarAnulacion(PEDIDO);
      await servicio.consultarTicket(resultado.id_envio); // CDR 0 → ACEPTADO

      await expect(servicio.reintentar(resultado.id_envio)).rejects.toMatchObject({ codigo: 'FISCAL_REENVIO_NO_PERMITIDO' });
      await expect(servicio.reintentar(999)).rejects.toMatchObject({ codigo: 'FISCAL_DOC_NO_ENCONTRADO' });
      expect(lotes.lotes.get(resultado.id_envio)?.estado).toBe('ACEPTADO');
    });

    it('reclamo tomado por otro proceso: no envía dos veces el mismo lote (FISCAL_ENVIO_EN_CURSO)', async () => {
      const { servicio, lotes, cliente } = crear();
      const resultado = await servicio.solicitarAnulacion(PEDIDO);
      const lote = lotes.lotes.get(resultado.id_envio) as LoteRegistrado;
      Object.assign(lote, { estado: 'PENDIENTE_REENVIO', sunat_ticket: null, libre: true });
      lotes.reclamarEnvio.mockResolvedValueOnce(null);

      await expect(servicio.enviar(resultado.id_envio)).rejects.toMatchObject({ codigo: 'FISCAL_ENVIO_EN_CURSO' });
      expect(cliente.enviarResumen).toHaveBeenCalledTimes(1);
    });
  });

  describe('la consulta del ticket', () => {
    async function conTicket(opciones: OpcionesCrear = {}) {
      const montaje = crear(opciones);
      const enviado = await montaje.servicio.solicitarAnulacion(PEDIDO);
      return { ...montaje, id: enviado.id_envio, lote: montaje.lotes.lotes.get(enviado.id_envio) as LoteRegistrado };
    }

    it('ticket 98 (en proceso): sigue TICKET_PENDIENTE y espera cada vez más (1, 2, 5, 15, 30, 60 min), sin tocar el comprobante', async () => {
      const { servicio, lotes, cliente, id, eventos } = await conTicket();
      cliente.consultarTicket.mockResolvedValue(respuesta({ tipo: 'TICKET', codigo: '98', statusCode: '98', ticket: TICKET, descripcion: 'En proceso' }));
      eventos.length = 0;
      lotes.tickets.length = 0;

      const esperas: number[] = [];
      for (let i = 0; i < 7; i++) {
        const resultado = await servicio.consultarTicket(id);
        expect(resultado).toMatchObject({ estado: 'TICKET_PENDIENTE', aceptado: false, ticket: TICKET });
        esperas.push(lotes.tickets[lotes.tickets.length - 1].espera);
      }

      expect(esperas).toEqual([2, 5, 15, 30, 60, 60, 60]);
      expect(lotes.lotes.get(id)?.estado).toBe('TICKET_PENDIENTE');
      expect((lotes.comprobantes.get(40) as CabeceraBaja).estado_sunat).toBe('BAJA_PENDIENTE');
      expect(lotes.completar).not.toHaveBeenCalled();
      expect(eventos).toEqual([]);
    });

    it('un error de red al consultar no reenvía nada: el ticket sigue vigente', async () => {
      const { servicio, lotes, cliente, id } = await conTicket();
      cliente.consultarTicket.mockResolvedValue(respuesta({ tipo: 'TRANSPORTE', codigo: 'ECONNRESET', descripcion: 'reset' }));

      const resultado = await servicio.consultarTicket(id);

      expect(resultado).toMatchObject({ estado: 'TICKET_PENDIENTE', ticket: TICKET });
      expect(cliente.enviarResumen).toHaveBeenCalledTimes(1);
      expect(lotes.lotes.get(id)?.estado).toBe('TICKET_PENDIENTE');
    });

    it(`tras ${MAXIMO_CONSULTAS_TICKET} consultas sin respuesta queda EXCEPCION (CONSULTAR_TICKET): el comprobante sigue en BAJA_PENDIENTE y se puede consultar a mano`, async () => {
      const { servicio, lotes, cliente, id } = await conTicket();
      cliente.consultarTicket.mockResolvedValue(respuesta({ tipo: 'TICKET', codigo: '98', statusCode: '98', ticket: TICKET, descripcion: 'En proceso' }));

      let resultado = await servicio.consultarTicket(id);
      for (let i = 1; i < MAXIMO_CONSULTAS_TICKET; i++) resultado = await servicio.consultarTicket(id);

      expect(resultado).toMatchObject({ estado: 'EXCEPCION', aceptado: false });
      expect(resultado.mensaje).toContain(`SUNAT no resolvió el ticket ${TICKET} tras ${MAXIMO_CONSULTAS_TICKET} consultas; consulte de nuevo manualmente`);
      expect(lotes.cierres[0].cierre).toMatchObject({ estado: 'EXCEPCION', accion: 'CONSULTAR_TICKET' });
      expect((lotes.comprobantes.get(40) as CabeceraBaja).estado_sunat).toBe('BAJA_PENDIENTE');

      // Consulta manual: SUNAT ya respondió → se resuelve desde EXCEPCION.
      cliente.consultarTicket.mockResolvedValue(CDR_ACEPTADO);
      const manual = await servicio.reintentar(id);
      expect(manual).toMatchObject({ estado: 'ACEPTADO', aceptado: true });
      expect((lotes.comprobantes.get(40) as CabeceraBaja).estado_sunat).toBe('ANULADO');
    });

    it('CDR 0: el lote queda ACEPTADO, la línea ACEPTADO, el comprobante ANULADO, se guarda el CDR y se avisa a los oyentes con la operación', async () => {
      const { servicio, lotes, cliente, id, eventos, lote } = await conTicket();
      eventos.length = 0;

      const resultado = await servicio.consultarTicket(id, 'tarea');

      expect(cliente.consultarTicket).toHaveBeenCalledWith(TICKET);
      expect(resultado).toMatchObject({ id_envio: id, operacion: 'baja', identificador: 'RA-20261105-00001', estado: 'ACEPTADO', aceptado: true, codigo: '0' });
      expect(lote.estado).toBe('ACEPTADO');
      expect(lote.lineas[0].estado).toBe('ACEPTADO');
      expect((lotes.comprobantes.get(40) as CabeceraBaja).estado_sunat).toBe('ANULADO');
      expect(lotes.cierres[0].cierre.cdr).toMatchObject({ xml: '<ApplicationResponse/>', zip: expect.any(Buffer) });
      expect(eventos).toEqual([
        { id_envio: id, id_comprobante: 40, ambiente: 'produccion', tipo_documento: 'RA', estado: 'ACEPTADO', aceptado: true, origen: 'tarea', operacion: 'baja' },
      ]);
    });

    it('CDR con observaciones (código 4xxx): ACEPTADO_OBS también anula', async () => {
      const { servicio, lotes, cliente, id } = await conTicket();
      cliente.consultarTicket.mockResolvedValue({ ...CDR_ACEPTADO, codigo: '4000', observaciones: [{ codigo: '4000', descripcion: 'observación' }] });

      const resultado = await servicio.consultarTicket(id);

      expect(resultado).toMatchObject({ estado: 'ACEPTADO_OBS', aceptado: true });
      expect((lotes.comprobantes.get(40) as CabeceraBaja).estado_sunat).toBe('ANULADO');
    });

    it('CDR 99 (procesado con errores): RECHAZADO y el comprobante vuelve a ACEPTADO para poder anularlo con una nota', async () => {
      const { servicio, lotes, cliente, id, eventos, lote } = await conTicket();
      cliente.consultarTicket.mockResolvedValue(
        respuesta({ tipo: 'ESTADO', codigo: '99', statusCode: '99', estadoComprobante: 'RECHAZADO', ticket: TICKET, descripcion: 'Procesó con errores' }),
      );
      eventos.length = 0;

      const resultado = await servicio.consultarTicket(id);

      expect(resultado).toMatchObject({ estado: 'RECHAZADO', aceptado: false });
      expect(resultado.mensaje).toMatch(/SUNAT procesó el lote con errores/);
      expect(lote.lineas[0].estado).toBe('RECHAZADO');
      expect((lotes.comprobantes.get(40) as CabeceraBaja).estado_sunat).toBe('ACEPTADO');
      expect(eventos[0]).toMatchObject({ estado: 'RECHAZADO', aceptado: false, operacion: 'baja' });
    });

    it('al rechazarse se restaura el estado que tenía: un comprobante ACEPTADO_OBS vuelve a ACEPTADO_OBS', async () => {
      const { servicio, lotes, cliente, id } = await conTicket({ cabecera: { estado_sunat: 'ACEPTADO_OBS' } });
      cliente.consultarTicket.mockResolvedValue(respuesta({ tipo: 'ESTADO', codigo: '99', statusCode: '99', estadoComprobante: 'RECHAZADO', ticket: TICKET, descripcion: 'x' }));

      await servicio.consultarTicket(id);

      expect((lotes.comprobantes.get(40) as CabeceraBaja).estado_sunat).toBe('ACEPTADO_OBS');
    });

    it('ticket inválido (0127): EXCEPCION y el comprobante vuelve a su estado, listo para pedir la baja de nuevo', async () => {
      const { servicio, lotes, cliente, id } = await conTicket();
      cliente.consultarTicket.mockResolvedValue(respuesta({ tipo: 'FAULT', codigo: '0127', descripcion: 'El ticket no existe' }));

      const resultado = await servicio.consultarTicket(id);

      expect(resultado.estado).toBe('EXCEPCION');
      expect((lotes.comprobantes.get(40) as CabeceraBaja).estado_sunat).toBe('ACEPTADO');
    });

    it('si otro proceso cerró el lote antes, no pisa su resultado ni avisa dos veces', async () => {
      const { servicio, lotes, id, eventos } = await conTicket();
      lotes.completar.mockResolvedValueOnce(null);
      eventos.length = 0;

      const resultado = await servicio.consultarTicket(id);

      expect(eventos).toEqual([]);
      expect(resultado.id_envio).toBe(id);
    });

    it('un lote sin ticket o ya reclamado por otro proceso no se consulta (FISCAL_ENVIO_EN_CURSO)', async () => {
      const { servicio, lotes, cliente, id } = await conTicket();
      lotes.reclamarConsulta.mockResolvedValueOnce(null);

      await expect(servicio.consultarTicket(id)).rejects.toMatchObject({ codigo: 'FISCAL_ENVIO_EN_CURSO' });
      expect(cliente.consultarTicket).not.toHaveBeenCalled();
    });

    it('D5.3: si la BD falla al guardar el cierre, reintenta con la respuesta en memoria (sin volver a consultar)', async () => {
      const { servicio, lotes, cliente, id, esperas } = await conTicket();
      const original = lotes.completar.getMockImplementation() as (...a: never[]) => Promise<LoteCerrado | null>;
      lotes.completar.mockRejectedValueOnce(new Error('conexión perdida')).mockRejectedValueOnce(new Error('conexión perdida')).mockImplementation(original);

      const resultado = await servicio.consultarTicket(id);

      expect(resultado.aceptado).toBe(true);
      expect(esperas).toEqual([250, 500]);
      expect(cliente.consultarTicket).toHaveBeenCalledTimes(1);
    });
  });

  describe('lecturas', () => {
    it('archivo(): solo los tipos de la lista cerrada', async () => {
      const { servicio } = crear();
      await expect(servicio.archivo(1, 'inventado' as never)).rejects.toMatchObject({ codigo: 'FISCAL_CONFIG_INVALIDA' });
    });
  });
});
