import { ConflictException, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { UbigeoService } from '../../catalogos/ubigeo/ubigeo.service';
import type { GuardarGuiaRemisionRequest } from '../../models/model/guia-remision.request';
import { GuiaRemisionRepository } from '../../repository/Repository/guia-remision.repository';
import { RelojSistemaFiscal } from '../../sunat/config/reloj-fiscal';
import { TransaccionesFiscalesPg } from '../../sunat/config/transacciones-fiscales';
import { nombreBaseGre, validarDocumentoGre } from '../../sunat/gre';
import type { DocumentoGre, GreEsperada, GrePreparada, ResultadoConsultaGre, ResultadoEnvioGre } from '../../sunat/gre';
import { REMITENTE_GRE_PRUEBA } from '../../sunat/gre/pruebas/documentos-gre-prueba-spec';
import { GuiaRemisionBussnies } from './guia-remision.bussnies';

/**
 * Integración con PostgreSQL REAL (PLAN V3, D10/D11). Se salta sin HS_PG_PRUEBAS_URL, así `npm test` no la
 * necesita. Con la variable apuntando a una COPIA de la base de pruebas con fase12 y fase13 aplicadas (nunca
 * Railway) usa el repositorio y el negocio reales con un motor GRE simulado: prepara un ZIP falso y contesta
 * como SUNAT (ticket, rechazo 422 antes del ticket o constancia aceptada) sin red. La consulta inmediata del
 * ticket espera de verdad sus 2,5 s.
 */
const URL = process.env.HS_PG_PRUEBAS_URL;
const describirConBd = URL ? describe : describe.skip;

/** Serie solo de esta prueba (uq_guias_remision_serie_numero es global). */
const SERIE = 'T901';
const PRODUCTO = 1;
const PARTIDA = { ubigeo: '150119', direccion: 'LT. 8 MZ. N1 URB. NUEVO LURIN', codigoEstablecimiento: '0000' };
const CON_ESPERA_MS = 30_000;

describirConBd('Guía de remisión contra PostgreSQL real (HS_PG_PRUEBAS_URL)', () => {
  const reloj = new RelojSistemaFiscal();
  const hoy = reloj.fechaLima();
  let ds: DataSource;
  let negocio: GuiaRemisionBussnies;
  /** Pausa de prepararDocumento: deja que dos emisiones simultáneas tomen el mismo número candidato. */
  let retrasoPreparar = 0;
  let rechazarProximoEnvio = false;

  /** Motor GRE simulado: valida con las reglas reales y contesta como SUNAT, sin red ni firma. */
  const emision = {
    modo: jest.fn(async () => ({ activo: true as const })),
    contexto: jest.fn(async () => ({ emisor: { ...REMITENTE_GRE_PRUEBA }, serie: SERIE, partidaPorDefecto: PARTIDA })),
    validar: (documento: DocumentoGre) => validarDocumentoGre(documento, { hoy }),
    prepararDocumento: jest.fn(async (documento: DocumentoGre): Promise<GrePreparada> => {
      if (retrasoPreparar) await new Promise((resolver) => setTimeout(resolver, retrasoPreparar));
      const nombreBase = nombreBaseGre(documento.remitente.ruc, documento.serie, documento.numero);
      const zip = Buffer.from(`ZIP ${nombreBase}`);
      return {
        documento,
        nombreBase,
        xml: `<DespatchAdvice id="${nombreBase}"/>`,
        xmlFirmado: `<DespatchAdvice id="${nombreBase}" firmado="si"/>`,
        zip,
        zipBase64: zip.toString('base64'),
        sha256: createHash('sha256').update(zip).digest('hex'),
        digestValue: `DIGEST-${documento.numero}`,
        advertencias: [],
      };
    }),
    enviar: jest.fn(async (preparada: GrePreparada): Promise<ResultadoEnvioGre> => {
      const comun = { fechaRecepcion: null, httpStatus: 200, crudo: null };
      if (rechazarProximoEnvio) {
        rechazarProximoEnvio = false;
        const errores = [{ codigo: '2774', descripcion: 'El ubigeo del punto de llegada no existe' }];
        return { ...comun, estado: 'RECHAZADA', ticket: null, codigo: '2774', errores, accion: 'CORREGIR_Y_REENVIAR', httpStatus: 422, mensaje: 'SUNAT rechazó la guía antes de recibirla: 2774.' };
      }
      return { ...comun, estado: 'TICKET_PENDIENTE', ticket: `TK-${preparada.nombreBase}`, codigo: null, errores: [], accion: 'CONSULTAR_TICKET', mensaje: 'SUNAT recibió la guía.' };
    }),
    consultarTicket: jest.fn(async (ticket: string, esperada?: GreEsperada): Promise<ResultadoConsultaGre> => ({
      estado: 'ACEPTADA',
      codigo: '0',
      mensaje: 'La Guía de Remisión Electrónica ha sido aceptada.',
      errores: [],
      observaciones: [],
      accion: 'NINGUNA',
      cdr: {
        nombre: `R-${ticket}.xml`,
        xml: Buffer.from(`<ApplicationResponse ticket="${ticket}"/>`),
        zip: Buffer.from(`CDR ${ticket}`),
        enlaceQr: `https://e-factura.sunat.gob.pe/v1/contribuyente/gre/comprobantes/descargaqr?hashqr=${esperada?.numero}`,
      },
      httpStatus: 200,
      crudo: null,
    })),
  };

  const fiscal = {
    emisor: async () => ({ ...REMITENTE_GRE_PRUEBA }),
    gre: async () => ({
      activa: true,
      serie: SERIE,
      correlativoInicial: 1,
      partida: { ...PARTIDA },
      partidaHeredada: { ubigeo: false, direccion: false, codigoEstablecimiento: false },
    }),
    tareasActivas: async () => false,
  };

  function sinVenta(cambios: Partial<GuardarGuiaRemisionRequest> = {}): GuardarGuiaRemisionRequest {
    return {
      motivo_traslado: '13',
      descripcion_motivo: 'Traslado a reparación',
      modalidad_traslado: '02',
      fecha_inicio_traslado: hoy,
      peso_bruto_total: 12.5,
      unidad_peso: 'KGM',
      destinatario: { tipo_documento: '6', numero_documento: '20553856451', denominacion: 'TALLER LOS ANDES S.A.C.' },
      partida: { ubigeo: PARTIDA.ubigeo, direccion: PARTIDA.direccion },
      llegada: { ubigeo: '150122', direccion: 'AV. JOSE LARCO 1150, MIRAFLORES' },
      vehiculo: { placa: 'ABC123' },
      conductor: { tipo_documento: '1', numero_documento: '45678912', nombres: 'JUAN', apellidos: 'PEREZ', licencia: 'Q45678912' },
      items: [{ id_producto: PRODUCTO, cantidad: 2, unidad: 'NIU' }],
      ...cambios,
    } as GuardarGuiaRemisionRequest;
  }

  function deVenta(idVenta: number, cantidad: number): GuardarGuiaRemisionRequest {
    return { id_venta: idVenta, motivo_traslado: '01', modalidad_traslado: '02', items: [{ id_producto: PRODUCTO, cantidad }] } as GuardarGuiaRemisionRequest;
  }

  async function venta(cantidad: number): Promise<number> {
    const [v] = await ds.query(`INSERT INTO ventas (subtotal, igv, total, origen, estado) VALUES (84.75, 15.25, 100, 'mostrador', 'activa') RETURNING id_venta`);
    await ds.query(
      'INSERT INTO detalle_venta (id_venta, id_producto, cantidad, precio, subtotal, igv, total) VALUES ($1, $2, $3, 20, 84.75, 15.25, 100)',
      [v.id_venta, PRODUCTO, cantidad],
    );
    return Number(v.id_venta);
  }

  async function maximo(): Promise<number> {
    const [f] = await ds.query('SELECT COALESCE(MAX(numero), 0)::int AS n FROM guias_remision WHERE serie = $1', [SERIE]);
    return Number(f.n);
  }

  async function guia(idGuia: number): Promise<{ serie: string | null; numero: number | null; estado: string }> {
    const [g] = await ds.query('SELECT serie, numero, estado FROM guias_remision WHERE id_guia = $1', [idGuia]);
    return { serie: g.serie, numero: g.numero === null ? null : Number(g.numero), estado: g.estado };
  }

  async function envios(idGuia: number): Promise<Array<{ estado: string; identificador: string; archivos: number }>> {
    return ds.query(
      `SELECT f.estado, f.identificador, (SELECT count(*)::int FROM fiscal_artifacts a WHERE a.id_envio = f.id_envio) AS archivos
         FROM fiscal_envios f WHERE f.id_guia = $1 ORDER BY f.id_envio`,
      [idGuia],
    );
  }

  function rechazoDe(resultados: PromiseSettledResult<unknown>[]): ConflictException {
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rechazado = resultados.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rechazado?.reason).toBeInstanceOf(ConflictException);
    return rechazado!.reason as ConflictException;
  }

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    ds = new DataSource({ type: 'postgres', url: URL, entities: [], synchronize: false, logging: false });
    await ds.initialize();
    const [fase13] = await ds.query(`SELECT to_regclass('uq_fiscal_envio_gre_en_curso') IS NOT NULL AS ok`);
    if (!fase13.ok) throw new Error('La base de HS_PG_PRUEBAS_URL no tiene sql/fase13_gre_directa_v2.sql aplicado.');
    negocio = new GuiaRemisionBussnies(
      new GuiaRemisionRepository(ds, new TransaccionesFiscalesPg(ds)),
      { obtener: async () => null } as never,
      emision as never,
      fiscal as never,
      reloj,
      new UbigeoService(),
    );
  });

  afterAll(async () => {
    await ds?.destroy();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    retrasoPreparar = 0;
    rechazarProximoEnvio = false;
    emision.prepararDocumento.mockClear();
  });

  it('dos emisiones simultáneas de la misma serie no repiten número: la segunda se prepara de nuevo con el siguiente', async () => {
    const base = await maximo();
    const [a, b] = await Promise.all([negocio.crear(sinVenta(), null), negocio.crear(sinVenta(), null)]);
    retrasoPreparar = 300;

    const [ea, eb] = await Promise.all([negocio.emitir(a.id_guia, null), negocio.emitir(b.id_guia, null)]);

    expect([ea.guia.numero!, eb.guia.numero!].sort((x, y) => x - y)).toEqual([base + 1, base + 2]);
    expect(emision.prepararDocumento).toHaveBeenCalledTimes(3);
    // Directo a SUNAT: la respuesta ya trae la constancia (consulta inmediata del ticket).
    expect([ea.resultado.estado, eb.resultado.estado]).toEqual(['ACEPTADA', 'ACEPTADA']);
    for (const id of [a.id_guia, b.id_guia]) {
      expect(await guia(id)).toMatchObject({ serie: SERIE, estado: 'aceptado' });
      // xml_original, xml_firmado y zip antes de enviar; cdr_xml y cdr_zip al aceptarse.
      expect(await envios(id)).toEqual([expect.objectContaining({ estado: 'ACEPTADO', archivos: 5 })]);
    }
    const nombre = nombreBaseGre(REMITENTE_GRE_PRUEBA.ruc, SERIE, ea.guia.numero!);
    expect(await negocio.archivo(a.id_guia, 'cdr_xml')).toMatchObject({ nombre: `R-${nombre}.xml`, mime: 'application/xml' });
    expect((await negocio.archivo(a.id_guia, 'zip')).contenido.toString()).toBe(`ZIP ${nombre}`);
  }, CON_ESPERA_MS);

  it('una guía rechazada conserva su número: se corrige y se reenvía con el mismo, y la siguiente guía no lo reutiliza', async () => {
    const base = await maximo();
    const g = await negocio.crear(sinVenta(), null);
    rechazarProximoEnvio = true;
    const rechazada = await negocio.emitir(g.id_guia, null);
    expect(rechazada.resultado).toMatchObject({ estado: 'RECHAZADA', codigo: '2774' });
    expect(await guia(g.id_guia)).toMatchObject({ estado: 'rechazado', numero: base + 1 });

    const otra = await negocio.crear(sinVenta(), null);
    expect((await negocio.emitir(otra.id_guia, null)).guia.numero).toBe(base + 2);

    await negocio.actualizar(g.id_guia, sinVenta({ observaciones: 'Ubigeo de llegada corregido' }));
    const reenviada = await negocio.emitir(g.id_guia, null);
    expect(reenviada.guia).toMatchObject({ estado: 'aceptado', numero: base + 1, observaciones: 'Ubigeo de llegada corregido' });
    const nombre = nombreBaseGre(REMITENTE_GRE_PRUEBA.ruc, SERIE, base + 1);
    expect((await envios(g.id_guia)).map((e) => [e.estado, e.identificador])).toEqual([
      ['RECHAZADO', nombre],
      ['ACEPTADO', nombre],
    ]);
  }, CON_ESPERA_MS);

  it('tope por venta: dos guías simultáneas que juntas superan lo vendido → pasa una y la otra 409 con lo pendiente', async () => {
    const idVenta = await venta(5);
    const rechazo = rechazoDe(await Promise.allSettled([negocio.crear(deVenta(idVenta, 3), null), negocio.crear(deVenta(idVenta, 3), null)]));
    expect(rechazo.getResponse()).toMatchObject({
      codigo: 'GRE_CANTIDAD_EXCEDE_VENTA',
      detalle: [expect.objectContaining({ cantidad_vendida: 5, cantidad_en_guias: 3, cantidad_pendiente: 2 })],
    });

    await expect(negocio.crear(deVenta(idVenta, 2), null)).resolves.toMatchObject({ estado: 'borrador', id_venta: idVenta });
    expect(await negocio.contextoVenta(idVenta)).toMatchObject({
      permitido: false,
      items: [expect.objectContaining({ cantidad_vendida: 5, cantidad_en_guias: 5, cantidad_pendiente: 0 })],
    });
  });

  it('anti doble envío: dos «Emitir» simultáneos de la misma guía → un solo envío y el otro 409; la BD tampoco admite dos abiertos', async () => {
    const g = await negocio.crear(sinVenta(), null);
    retrasoPreparar = 200;
    const rechazo = rechazoDe(await Promise.allSettled([negocio.emitir(g.id_guia, null), negocio.emitir(g.id_guia, null)]));
    expect(['GRE_ENVIO_EN_CURSO', 'GRE_ESTADO_CAMBIO', 'GRE_YA_ENVIADA']).toContain((rechazo.getResponse() as { codigo: string }).codigo);
    expect(await envios(g.id_guia)).toHaveLength(1);

    // Sin pasar por el negocio: el índice de fase13 impide un segundo envío abierto de la misma guía.
    const otra = await negocio.crear(sinVenta(), null);
    const abrir = () =>
      ds.query(
        `INSERT INTO fiscal_envios (id_guia, tipo_documento, ambiente, proveedor, operacion, intento, estado)
         VALUES ($1, '09', 'produccion', 'sunat_directo', 'emitir', 1, 'ENVIANDO')`,
        [otra.id_guia],
      );
    await abrir();
    await expect(abrir()).rejects.toMatchObject({ code: '23505', constraint: 'uq_fiscal_envio_gre_en_curso' });
  }, CON_ESPERA_MS);

  it('el borrador guarda creado_en en UTC aunque la BD use otra zona horaria, y el listado lo cuenta en su día de Lima', async () => {
    const g = await negocio.crear(sinVenta(), null);
    const [desfase] = await ds.query(
      `SELECT EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - creado_en))::int AS segundos FROM guias_remision WHERE id_guia = $1`,
      [g.id_guia],
    );
    expect(Math.abs(Number(desfase.segundos))).toBeLessThan(60);
    const listado = await negocio.listar({ estado: 'borrador', desde: hoy, hasta: hoy, por_pagina: 100 });
    expect(listado.datos.map((d) => d.id_guia)).toContain(g.id_guia);
    // Búsqueda por destinatario sin distinguir mayúsculas; '%' y '_' son literales (ESCAPE), no comodines.
    expect((await negocio.listar({ texto: 'taller los andes', por_pagina: 100 })).datos.map((d) => d.id_guia)).toContain(g.id_guia);
    expect((await negocio.listar({ texto: '100%_', por_pagina: 100 })).total).toBe(0);
  });
});
