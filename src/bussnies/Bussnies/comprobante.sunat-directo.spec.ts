import { BadRequestException, ConflictException } from '@nestjs/common';
import type { GenerarComprobanteRequest } from '../../models/model/c-electronico/comprobante.request';
import type { DocumentoCpe } from '../../sunat/nucleo/documento-fiscal.types';
import { DocumentoCpeInvalidoError } from '../../sunat/nucleo/errores-nucleo';
import { MAXIMO_INTENTOS_NUMERO } from './comprobante.bussnies';
import {
  COLUMNAS_FASE9,
  CONTEXTO_BETA,
  CONTEXTO_PRODUCCION,
  EMISOR_BETA,
  EMISOR_REAL,
  crearBdFalsa,
  crearMotor,
  posicion,
  resultadoEmision,
  silenciarLogs,
} from './comprobante.prueba-spec';

/** Boleta de 2 cementos a S/ 10 con S/ 0.40 de descuento = S/ 19.60, de la venta 9. */
function boleta(parcial: Partial<GenerarComprobanteRequest> = {}): GenerarComprobanteRequest {
  return {
    id_tipo: 2,
    id_venta: 9,
    items: [
      {
        id_producto: 7,
        codigo: 'CEM-01',
        descripcion: 'CEMENTO SOL 42.5 KG',
        unidad_de_medida: 'NIU',
        cantidad: 2,
        precio_unitario: 10,
        descuento: 0.4,
      },
    ],
    ...parcial,
  } as GenerarComprobanteRequest;
}

function documentoPreparado(emision: { prepararDocumento: jest.Mock }, llamada = 0): DocumentoCpe {
  return emision.prepararDocumento.mock.calls[llamada][0] as DocumentoCpe;
}

describe('ComprobanteBussnies: emisión directa por el contrato EmisionDirecta', () => {
  beforeAll(silenciarLogs);
  afterEach(() => jest.useRealTimers());

  describe('emisión inactiva', () => {
    it('generar responde 503 con el motivo y no prepara, no numera ni abre transacción', async () => {
      const { servicio, emision, bd } = crearMotor();
      emision.modo.mockResolvedValue({
        activo: false,
        ambiente: 'produccion',
        codigo: 'FISCAL_EMISION_INACTIVA',
        motivo: 'falta activar el proveedor sunat_directo',
      });

      await expect(servicio.generar(boleta())).rejects.toMatchObject({
        status: 503,
        response: {
          message: expect.stringContaining('falta activar el proveedor sunat_directo'),
          codigo: 'FISCAL_EMISION_INACTIVA',
        },
      });
      expect(emision.prepararDocumento).not.toHaveBeenCalled();
      expect(emision.registrarEnvio).not.toHaveBeenCalled();
      expect(bd.registro).not.toContain('BEGIN');
    });

    it('la vista previa NO falla: avisa el motivo y usa el emisor y la serie configurados si no hay contexto', async () => {
      const bd = crearBdFalsa({ maximos: { B001: [41] } });
      const { servicio, emision } = crearMotor({
        bd,
        config: {
          fiscal_serie_boleta: 'B001',
          emisor_ruc: '20610206337',
          emisor_razon_social: 'HATUNSALES S.A.C.',
          emisor_direccion: 'LT. 8 MZ. N1',
          emisor_ubicacion: 'LURIN - LIMA - LIMA',
        },
      });
      emision.modo.mockResolvedValue({ activo: false, ambiente: 'beta', codigo: 'FISCAL_BETA_POS_APAGADO', motivo: 'el POS BETA está apagado' });
      emision.contexto.mockRejectedValue(new Error('ambiente no listo'));

      const vista = await servicio.previsualizar(boleta());

      expect(vista.advertencias[0]).toBe('La emisión electrónica no está activa: el POS BETA está apagado');
      expect(vista.emision_activa).toBe(false);
      expect(vista.serie).toBe('B001');
      expect(vista.numero).toBe(42);
      expect(vista.emisor).toMatchObject({ ruc: '20610206337', razon_social: 'HATUNSALES S.A.C.' });
      expect(vista.totales.total).toBe(19.6);
      expect(emision.prepararDocumento).not.toHaveBeenCalled();
    });

    it('con la emisión activa la vista previa usa el emisor, la serie y el aviso del contexto', async () => {
      const { servicio } = crearMotor({ bd: crearBdFalsa({ maximos: { BB01: [4] } }) });

      const vista = await servicio.previsualizar(boleta({ serie: 'X999', numero: 77 }));

      expect(vista.serie).toBe('BB01');
      expect(vista.numero).toBe(5);
      expect(vista.emisor.ruc).toBe(EMISOR_BETA.ruc);
      expect(vista.ambiente_fiscal).toBe('beta');
      expect(vista.aviso).toBe(CONTEXTO_BETA.aviso);
      expect(vista.emision_activa).toBe(true);
      expect(vista.advertencias).toEqual([]);
    });
  });

  describe('transacción única (PLAN D3)', () => {
    it('candados en orden fijo, registrarEnvio dentro de la transacción y envío recién después del COMMIT', async () => {
      const bd = crearBdFalsa({ maximos: { BB01: [4] } });
      const { servicio, emision } = crearMotor({ bd });

      const respuesta = await servicio.generar(boleta(), 3);

      const r = bd.registro;
      expect(posicion(r, 'preparar:BB01-5')).toBeLessThan(posicion(r, 'BEGIN'));
      expect(posicion(r, 'BEGIN')).toBeLessThan(posicion(r, 'tx:lock:cpe-venta:9'));
      expect(posicion(r, 'tx:lock:cpe-venta:9')).toBeLessThan(posicion(r, 'tx:vigente:9'));
      expect(posicion(r, 'tx:vigente:9')).toBeLessThan(posicion(r, 'tx:lock:comprobante:BB01'));
      expect(posicion(r, 'tx:lock:comprobante:BB01')).toBeLessThan(posicion(r, 'tx:max:BB01'));
      expect(posicion(r, 'tx:max:BB01')).toBeLessThan(posicion(r, 'tx:insert:comprobantes'));
      expect(posicion(r, 'tx:insert:comprobantes')).toBeLessThan(posicion(r, 'tx:insert:items'));
      expect(posicion(r, 'tx:insert:items')).toBeLessThan(posicion(r, 'tx:registrarEnvio:900'));
      expect(posicion(r, 'tx:registrarEnvio:900')).toBeLessThan(posicion(r, 'COMMIT'));
      expect(posicion(r, 'COMMIT')).toBeLessThan(posicion(r, 'enviar:501'));
      expect(r).not.toContain('ROLLBACK');

      // Se registra y se envía el MISMO documento preparado (el ZIP firmado en memoria).
      const preparado = await emision.prepararDocumento.mock.results[0].value;
      expect(emision.registrarEnvio).toHaveBeenCalledWith(bd.manager, preparado, 900, 3);
      expect(emision.enviarRegistrado).toHaveBeenCalledWith(501, preparado);
      expect(respuesta).toMatchObject({ id_comprobante: 900, serie: 'BB01', numero: 5, numero_formateado: 'BB01-00000005' });
    });

    it('guarda el comprobante pendiente, sin enviar, de emisión directa, con el ambiente y el usuario', async () => {
      const bd = crearBdFalsa({ maximos: { F001: [0] } });
      const { servicio } = crearMotor({ bd, contexto: CONTEXTO_PRODUCCION });

      await servicio.generar(boleta({ id_tipo: 1, documento: '20123456789' }), 8);

      const insert = bd.consultas.find((c) => /^\s*INSERT INTO comprobantes/.test(c.sql))!;
      const columnas = insert.sql.slice(insert.sql.indexOf('(') + 1, insert.sql.indexOf(')')).split(',').map((c) => c.trim());
      const valor = (columna: string) => insert.parametros[columnas.indexOf(columna)];
      expect(valor('serie')).toBe('F001');
      expect(valor('numero')).toBe(1);
      expect(valor('estado')).toBe('pendiente');
      expect(valor('proveedor_fiscal')).toBe('sunat_directo');
      expect(valor('ambiente_fiscal')).toBe('produccion');
      expect(valor('estado_sunat')).toBe('NO_ENVIADO');
      expect(valor('id_usuario')).toBe(8);
      expect(valor('id_venta')).toBe(9);
      expect(valor('cliente_numero_doc')).toBe('20123456789');
      expect(valor('total')).toBe(19.6);
      // Los datos fiscales (QR, hash, hora, forma de pago, cuotas, plazo) los escribe registrarEnvio.
      expect(columnas).not.toEqual(expect.arrayContaining(['cadena_qr']));
      expect(columnas).not.toEqual(expect.arrayContaining(['forma_pago']));
      expect(bd.consultas.some((c) => /setval|DO \$seq\$/.test(c.sql))).toBe(false);
    });

    it('guarda en cliente_email el correo escrito en el POS (correo_cliente) y enviar_cliente', async () => {
      const bd = crearBdFalsa({ maximos: { F001: [0] } });
      const { servicio } = crearMotor({ bd, contexto: CONTEXTO_PRODUCCION });

      await servicio.generar(
        boleta({ id_tipo: 1, documento: '20123456789', enviar_cliente: true, correo_cliente: ' caja@cliente.pe ' }),
        8,
      );

      const insert = bd.consultas.find((c) => /^\s*INSERT INTO comprobantes/.test(c.sql))!;
      const columnas = insert.sql.slice(insert.sql.indexOf('(') + 1, insert.sql.indexOf(')')).split(',').map((c) => c.trim());
      expect(insert.parametros[columnas.indexOf('cliente_email')]).toBe('caja@cliente.pe');
      expect(insert.parametros[columnas.indexOf('enviar_cliente')]).toBe(true);
    });

    it('si registrarEnvio falla se revierte todo y no se llama a SUNAT', async () => {
      const bd = crearBdFalsa({ maximos: { BB01: [0] } });
      const { servicio, emision } = crearMotor({ bd });
      emision.registrarEnvio.mockRejectedValue(new Error('FISCAL_AMBIENTE_CAMBIO: el ambiente cambió'));

      await expect(servicio.generar(boleta())).rejects.toThrow('el ambiente cambió');

      expect(bd.registro).toContain('ROLLBACK');
      expect(bd.registro).not.toContain('COMMIT');
      expect(emision.enviarRegistrado).not.toHaveBeenCalled();
      expect(emision.prepararDocumento).toHaveBeenCalledTimes(1);
    });

    it('si el envío falla después del COMMIT responde pendiente (el comprobante ya existe y es recuperable)', async () => {
      const bd = crearBdFalsa({ maximos: { BB01: [0] } });
      const { servicio, emision } = crearMotor({ bd });
      emision.enviarRegistrado.mockRejectedValue(new Error('SUNAT respondió, pero no se pudo guardar su respuesta'));

      const respuesta = await servicio.generar(boleta());

      expect(bd.registro).toContain('COMMIT');
      expect(respuesta).toMatchObject({
        id_comprobante: 900,
        estado: 'pendiente',
        estado_sunat: 'ENVIANDO',
        id_envio_ultimo: 501,
        aceptada_sunat: false,
        cadena_qr: 'QR-LOCAL',
        codigo_hash: 'HASH-LOCAL',
      });
      expect(respuesta.error).toContain('quedó guardado');
      expect(respuesta.error).toContain('no emita otro comprobante');
    });
  });

  describe('numeración (PLAN D2)', () => {
    it('ignora serie y número del cliente: serie del contexto y siguiente número de la serie', async () => {
      const { servicio, emision } = crearMotor({ bd: crearBdFalsa({ maximos: { BB01: [11] } }) });

      await servicio.generar(boleta({ serie: 'B999', numero: 1 }));

      expect(documentoPreparado(emision)).toMatchObject({ tipo: '03', serie: 'BB01', numero: 12 });
    });

    it('respeta el correlativo inicial de la serie (piso) cuando es mayor que MAX + 1', async () => {
      const { servicio, emision } = crearMotor({
        bd: crearBdFalsa({ maximos: { B001: [3] } }),
        contexto: { ...CONTEXTO_PRODUCCION, correlativo_inicial: { B001: 120 } },
      });

      const respuesta = await servicio.generar(boleta());

      expect(documentoPreparado(emision).numero).toBe(120);
      expect(respuesta.numero).toBe(120);
    });

    it('carrera: si otro cajero usó el número, revierte y re-prepara con el siguiente', async () => {
      // Fuera: MAX 4 (candidato 5). Bajo el candado: MAX 5 (alguien usó el 5). Reintento: 6.
      const bd = crearBdFalsa({ maximos: { BB01: [4, 5, 5, 5] } });
      const { servicio, emision } = crearMotor({ bd });

      const respuesta = await servicio.generar(boleta());

      expect(emision.prepararDocumento).toHaveBeenCalledTimes(2);
      expect(documentoPreparado(emision, 0).numero).toBe(5);
      expect(documentoPreparado(emision, 1).numero).toBe(6);
      expect(bd.registro.filter((e) => e === 'ROLLBACK')).toHaveLength(1);
      expect(bd.registro.filter((e) => e === 'tx:insert:comprobantes')).toHaveLength(1);
      expect(emision.registrarEnvio).toHaveBeenCalledTimes(1);
      expect(respuesta.numero).toBe(6);
    });

    it('el índice único uq_comprobantes_serie_numero (23505) también hace re-preparar con otro número', async () => {
      const duplicado = Object.assign(new Error('duplicate key value violates unique constraint "uq_comprobantes_serie_numero"'), {
        code: '23505',
        constraint: 'uq_comprobantes_serie_numero',
      });
      const bd = crearBdFalsa({ maximos: { BB01: [4, 4, 5, 5] }, erroresInsert: [duplicado] });
      const { servicio, emision } = crearMotor({ bd });

      const respuesta = await servicio.generar(boleta());

      expect(emision.prepararDocumento.mock.calls.map(([d]) => (d as DocumentoCpe).numero)).toEqual([5, 6]);
      expect(respuesta.numero).toBe(6);
    });

    it('un número que SUNAT ya recibió en el ambiente (FISCAL_NUMERO_OCUPADO de registrarEnvio) se salta', async () => {
      // BETA: la prueba de conexión del panel envió FB01-1 sin fila en comprobantes.
      const bd = crearBdFalsa({ maximos: { BB01: [0] } });
      const { servicio, emision } = crearMotor({ bd });
      emision.registrarEnvio.mockRejectedValueOnce(
        Object.assign(new Error('El número BB01-1 ya se envió a SUNAT en este ambiente'), { codigo: 'FISCAL_NUMERO_OCUPADO' }),
      );

      const respuesta = await servicio.generar(boleta());

      expect(emision.prepararDocumento.mock.calls.map(([d]) => (d as DocumentoCpe).numero)).toEqual([1, 2]);
      expect(bd.registro.filter((e) => e === 'ROLLBACK')).toHaveLength(1);
      expect(respuesta.numero).toBe(2);
    });

    it(`tras ${MAXIMO_INTENTOS_NUMERO} intentos ocupados responde 409 sin registrar ningún envío`, async () => {
      const bd = crearBdFalsa({ maximos: { BB01: [0, 1, 1, 2, 2, 3, 3, 4, 4, 5] } });
      const { servicio, emision } = crearMotor({ bd });

      const error = await servicio.generar(boleta()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ codigo: 'NUMERO_NO_DISPONIBLE' });
      expect(emision.prepararDocumento).toHaveBeenCalledTimes(MAXIMO_INTENTOS_NUMERO);
      expect(emision.registrarEnvio).not.toHaveBeenCalled();
      expect(bd.registro.filter((e) => e === 'ROLLBACK')).toHaveLength(MAXIMO_INTENTOS_NUMERO);
      expect(bd.registro).not.toContain('tx:insert:comprobantes');
    });

    it('un documento que el núcleo rechaza es 400 y no abre transacción (no quema número)', async () => {
      const bd = crearBdFalsa();
      const { servicio, emision } = crearMotor({ bd });
      emision.prepararDocumento.mockRejectedValue(new DocumentoCpeInvalidoError(['Línea 1: la unidad "XYZ" no existe en el catálogo 03']));

      const error = await servicio.generar(boleta()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        codigo: 'FISCAL_VALIDACION_CPE',
        errores: ['Línea 1: la unidad "XYZ" no existe en el catálogo 03'],
      });
      expect(bd.registro).not.toContain('BEGIN');
    });
  });

  describe('un solo comprobante principal por venta (PLAN D10)', () => {
    it('si la venta ya tiene uno vigente responde 409 con su id antes de firmar', async () => {
      const bd = crearBdFalsa({ vigentes: { 9: [{ id_comprobante: 77, serie: 'BB01', numero: 3, estado: 'emitido' }] } });
      const { servicio, emision } = crearMotor({ bd });

      const error = await servicio.generar(boleta()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ codigo: 'VENTA_CON_COMPROBANTE', id_comprobante: 77 });
      expect(emision.prepararDocumento).not.toHaveBeenCalled();
    });

    it('la verificación que cuenta es la de dentro de la transacción: 409 sin insertar ni registrar el envío', async () => {
      // Al empezar no había comprobante; otra caja lo emitió mientras se firmaba.
      const bd = crearBdFalsa({ vigentes: { 9: [null, { id_comprobante: 78, serie: 'BB01', numero: 4, estado: 'pendiente' }] } });
      const { servicio, emision } = crearMotor({ bd });

      const error = await servicio.generar(boleta()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ id_comprobante: 78 });
      expect(String((error as ConflictException).message)).toContain('envío a SUNAT está en curso');
      expect(bd.registro).toContain('ROLLBACK');
      expect(bd.registro).not.toContain('tx:insert:comprobantes');
      expect(emision.registrarEnvio).not.toHaveBeenCalled();
    });

    it('sin venta no toma el candado de la venta', async () => {
      const bd = crearBdFalsa();
      const { servicio } = crearMotor({ bd });

      await servicio.generar(boleta({ id_venta: undefined }));

      expect(bd.registro.some((e) => e.includes('cpe-venta'))).toBe(false);
      expect(bd.registro).toContain('tx:lock:comprobante:BB01');
    });
  });

  describe('documento que se firma', () => {
    it('emisor del contexto y fecha y hora de Lima del mismo instante', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-21T04:59:59.000Z') });
      const { servicio, emision } = crearMotor({ contexto: CONTEXTO_PRODUCCION });

      await servicio.generar(boleta());

      const documento = documentoPreparado(emision);
      expect(documento.emisor).toEqual(EMISOR_REAL);
      // 04:59:59 UTC del 21 = 23:59:59 del 20 en Lima: fecha y hora no se mezclan de instantes distintos.
      expect(documento.fechaEmision).toBe('2026-10-20');
      expect(documento.horaEmision).toBe('23:59:59');
      expect(documento.formaPago).toEqual({ tipo: 'Contado' });
      expect(documento.totales).toMatchObject({ total: 19.6, igv: 2.99, gravada: 16.61 });
    });

    it('crédito por el campo tipado: una cuota por el monto al crédito con el vencimiento de la venta', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-21T15:00:00.000Z') });
      const { servicio, emision } = crearMotor();

      await servicio.generar(boleta({ forma_pago: 'Credito', monto_credito: 19.6, fecha_de_vencimiento: '05-11-2026' }));

      const documento = documentoPreparado(emision);
      expect(documento.formaPago).toEqual({
        tipo: 'Credito',
        montoPendiente: 19.6,
        cuotas: [{ numero: 1, monto: 19.6, fechaPago: '2026-11-05' }],
      });
      expect(documento.fechaVencimiento).toBe('2026-11-05');
    });

    it('sin campo tipado detecta el crédito por el texto con o sin tilde; el campo tipado manda', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-21T15:00:00.000Z') });
      const motor = crearMotor();
      await motor.servicio.generar(boleta({ id_venta: undefined, condiciones_de_pago: 'CRÉDITO 15 días', monto_credito: 10, fecha_de_vencimiento: '2026-11-05' }));
      await motor.servicio.generar(boleta({ id_venta: undefined, condiciones_de_pago: 'credito', monto_credito: 10, fecha_de_vencimiento: '2026-11-05' }));
      await motor.servicio.generar(boleta({ id_venta: undefined, forma_pago: 'Contado', condiciones_de_pago: 'Crédito' }));

      const formas = motor.emision.prepararDocumento.mock.calls.map(([d]) => (d as DocumentoCpe).formaPago?.tipo);
      expect(formas).toEqual(['Credito', 'Credito', 'Contado']);
    });

    it('rechaza el crédito sin vencimiento posterior a la emisión, antes de firmar', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-21T15:00:00.000Z') });
      const { servicio, emision } = crearMotor();

      await expect(
        servicio.generar(boleta({ forma_pago: 'Credito', monto_credito: 10, fecha_de_vencimiento: '2026-10-21' })),
      ).rejects.toThrow('fecha de vencimiento posterior a la emisión');
      expect(emision.prepararDocumento).not.toHaveBeenCalled();
    });

    it('código SUNAT: el del producto, si no el configurado por defecto, y si tampoco hay se omite (nunca 10000000)', async () => {
      const conDefecto = crearMotor({ config: { fiscal_codigo_producto_defecto: '31162800' } });
      await conDefecto.servicio.generar(boleta({
        id_venta: undefined,
        items: [
          { id_producto: 7, codigo: 'A', descripcion: 'CLAVO 2"', cantidad: 1, precio_unitario: 5, codigo_producto_sunat: '31161600' },
          { id_producto: 8, codigo: 'B', descripcion: 'MARTILLO', cantidad: 1, precio_unitario: 25 },
        ],
      }));
      expect(documentoPreparado(conDefecto.emision).lineas.map((l) => l.codigoSunat)).toEqual(['31161600', '31162800']);

      const sinDefecto = crearMotor();
      await sinDefecto.servicio.generar(boleta({ id_venta: undefined }));
      const linea = documentoPreparado(sinDefecto.emision).lineas[0];
      expect(linea.codigoSunat).toBeUndefined();
      expect(JSON.stringify(documentoPreparado(sinDefecto.emision))).not.toContain('10000000');
    });

    it('el consumidor final (00000000) no se busca como DNI', async () => {
      const { servicio, receptor, emision } = crearMotor();

      await servicio.generar(boleta({ documento: '00000000' }));

      expect(receptor.buscarPorDocumento).not.toHaveBeenCalled();
      expect(receptor.consumidorFinal).toHaveBeenCalled();
      expect(documentoPreparado(emision).cliente).toMatchObject({ numDoc: '00000000', nombre: 'CLIENTES VARIOS' });
    });

    it('con un total exigido distinto (venta ya cobrada) responde 400 explicando la diferencia, sin firmar', async () => {
      const { servicio, emision } = crearMotor();

      const error = await servicio.generar(boleta(), null, { totalExigido: 20.19 }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      const cuerpo = (error as BadRequestException).getResponse() as { message: string; codigo: string };
      expect(cuerpo.codigo).toBe('COMPROBANTE_TOTAL_DISTINTO');
      expect(cuerpo.message).toContain('S/ 19.60');
      expect(cuerpo.message).toContain('S/ 20.19');
      expect(cuerpo.message).toContain('diferencia S/ -0.59');
      expect(emision.prepararDocumento).not.toHaveBeenCalled();
    });
  });

  describe('respuesta', () => {
    it('aceptado: emitido con ambiente, estado SUNAT, envío, acción, archivos, QR, hash, aviso y plazo', async () => {
      const { servicio } = crearMotor();

      const respuesta = await servicio.generar(boleta());

      expect(respuesta).toMatchObject({
        estado: 'emitido',
        aceptada_sunat: true,
        proveedor_fiscal: 'sunat_directo',
        ambiente_fiscal: 'beta',
        estado_sunat: 'ACEPTADO',
        id_envio_ultimo: 501,
        accion_sunat: 'NINGUNA',
        archivos: ['xml_original', 'xml_firmado', 'zip', 'cdr_xml', 'cdr_zip'],
        codigo_hash: 'HASH-SUNAT',
        aviso: CONTEXTO_BETA.aviso,
        fecha_limite_envio: '2026-10-26',
        id_venta: 9,
      });
      expect(respuesta.cadena_qr).toContain('|HASH-SUNAT|');
      expect(respuesta.error).toBeUndefined();
    });

    it('«emitido» solo si SUNAT aceptó: rechazo = error y reenvío pendiente = pendiente', async () => {
      const rechazado = crearMotor();
      rechazado.emision.enviarRegistrado.mockResolvedValue(
        resultadoEmision({ estado: 'RECHAZADO', aceptado: false, codigo: '2017', mensaje: 'El RUC del receptor no existe', accion: 'EMITIR_NUEVO' }),
      );
      expect(await rechazado.servicio.generar(boleta())).toMatchObject({
        estado: 'error',
        estado_sunat: 'RECHAZADO',
        aceptada_sunat: false,
        error: 'El RUC del receptor no existe',
        accion_sunat: 'EMITIR_NUEVO',
      });

      const pendiente = crearMotor();
      pendiente.emision.enviarRegistrado.mockResolvedValue(
        resultadoEmision({ estado: 'PENDIENTE_REENVIO', aceptado: false, codigo: 'ETIMEDOUT', mensaje: 'SUNAT no respondió', accion: 'REINTENTAR' }),
      );
      expect(await pendiente.servicio.generar(boleta())).toMatchObject({ estado: 'pendiente', estado_sunat: 'PENDIENTE_REENVIO' });
    });
  });

  describe('validaciones de la solicitud (antes de tocar la emisión)', () => {
    it.each([
      [{ id_tipo: 7 }, 'solo se emiten facturas y boletas'],
      [{ enviar_sunat: false }, 'siempre envía el comprobante a SUNAT'],
      [{ descuento_global: 5 }, 'no admite descuentos globales'],
      [{ id_moneda: 3 }, 'solo admite soles (PEN) o dólares (USD)'],
    ])('rechaza %o', async (cambio, mensaje) => {
      const { servicio, emision } = crearMotor();
      await expect(servicio.generar(boleta(cambio as Partial<GenerarComprobanteRequest>))).rejects.toThrow(mensaje);
      expect(emision.modo).not.toHaveBeenCalled();
    });

    it('una factura exige RUC', async () => {
      const { servicio, emision } = crearMotor();
      await expect(servicio.generar(boleta({ id_tipo: 1, documento: '45678912' }))).rejects.toThrow('solo puede emitirse a un RUC');
      expect(emision.prepararDocumento).not.toHaveBeenCalled();
    });

    it('la columna de fase 9 basta para emitir factura y boleta (sin fase 12 ni 14)', async () => {
      const bd = crearBdFalsa({ columnas: COLUMNAS_FASE9 });
      const { servicio } = crearMotor({ bd });
      await expect(servicio.generar(boleta())).resolves.toMatchObject({ estado: 'emitido' });
    });
  });
});
