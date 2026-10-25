import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Comprobante } from '../../models/DBModel/c-electronico/comprobante.entity';
import type { DocumentoCpe } from '../../sunat/nucleo/documento-fiscal.types';
import type { SolicitudEmisionNotaCredito } from './nota-credito.contrato';
import {
  COLUMNAS_COMPLETAS,
  COLUMNAS_FASE9,
  CONTEXTO_PRODUCCION,
  EMISOR_REAL,
  crearBdFalsa,
  crearMotor,
  posicion,
  silenciarLogs,
} from './comprobante.prueba-spec';

/** Factura F001-12 de S/ 118 aceptada en producción, de la venta 9 (dos ítems de S/ 59). */
function facturaOrigen(parcial: Partial<Comprobante> = {}): Comprobante {
  return {
    id_comprobante: 40,
    id_venta: 9,
    tipo: { id_tipo: 1 },
    moneda: { id_moneda: 1 },
    cliente: { id_cliente: 55 },
    serie: 'F001',
    numero: 12,
    cliente_tipo_doc: 6,
    cliente_numero_doc: '20123456789',
    cliente_denominacion: 'FERRETERIA EL MARTILLO S.A.C.',
    cliente_direccion: 'AV. LOS OLIVOS 456',
    cliente_email: '',
    porcentaje_igv: 18,
    total: 118,
    aceptada_sunat: true,
    estado: 'emitido',
    estado_sunat: 'ACEPTADO',
    ambiente_fiscal: 'produccion',
    proveedor_fiscal: 'sunat_directo',
    anulado: false,
    items: [],
    ...parcial,
  } as unknown as Comprobante;
}

function solicitud(registro: string[], parcial: Partial<SolicitudEmisionNotaCredito> = {}): SolicitudEmisionNotaCredito {
  return {
    id_comprobante_origen: 40,
    id_venta: 9,
    motivo: '07',
    sustento: 'Devolución de una bolsa de cemento',
    lineas: [
      {
        id_item_origen: 401,
        id_producto: 7,
        codigo: 'CEM-01',
        descripcion: 'CEMENTO SOL 42.5 KG',
        unidad_de_medida: 'NIU',
        cantidad: 1,
        precio_unitario: 59,
        descuento: 0,
        tipo_de_igv: 1,
      },
    ],
    saldo_maximo: 118,
    id_usuario: 3,
    efecto: 'devolucion',
    reingresar_stock: true,
    validarEnTransaccion: jest.fn(async () => {
      registro.push('validarEnTransaccion');
    }),
    ...parcial,
  };
}

function motorConOrigen(origen: Comprobante, columnas: string[] = COLUMNAS_FASE9) {
  const bd = crearBdFalsa({ columnas, maximos: { FC01: [2], BC01: [7] } });
  const findOne = jest.fn().mockResolvedValue(origen);
  return crearMotor({ bd, contexto: CONTEXTO_PRODUCCION, findOne });
}

describe('ComprobanteBussnies.emitirNotaCredito (contrato EmisorNotasCredito)', () => {
  beforeAll(silenciarLogs);

  it('usa la serie de nota de factura, la referencia al origen y el receptor, moneda e IGV del origen', async () => {
    const motor = motorConOrigen(facturaOrigen());

    const respuesta = await motor.servicio.emitirNotaCredito(solicitud(motor.bd.registro));

    const documento = motor.emision.prepararDocumento.mock.calls[0][0] as DocumentoCpe;
    expect(documento).toMatchObject({
      tipo: '07',
      serie: 'FC01',
      numero: 3,
      moneda: 'PEN',
      emisor: EMISOR_REAL,
      cliente: { tipoDoc: '6', numDoc: '20123456789', nombre: 'FERRETERIA EL MARTILLO S.A.C.' },
      referencia: { tipoDoc: '01', serie: 'F001', numero: 12, motivo: '07', sustento: 'Devolución de una bolsa de cemento' },
    });
    expect(documento.formaPago).toBeUndefined();
    expect(documento.lineas[0]).toMatchObject({ porcentajeIgv: 18, total: 59, igv: 9, valorVenta: 50 });
    expect(respuesta).toMatchObject({
      tipo_de_comprobante: 7,
      serie: 'FC01',
      numero: 3,
      id_venta: 9,
      id_comprobante_modificado: 40,
      doc_modificado: 'F001-12',
      estado: 'emitido',
    });
  });

  it('una boleta se corrige con la serie de nota de boleta', async () => {
    const motor = motorConOrigen(
      facturaOrigen({ tipo: { id_tipo: 2 } as never, serie: 'B001', cliente_tipo_doc: 1, cliente_numero_doc: '45678912' }),
    );

    await motor.servicio.emitirNotaCredito(solicitud(motor.bd.registro, { motivo: '06' }));

    const documento = motor.emision.prepararDocumento.mock.calls[0][0] as DocumentoCpe;
    expect(documento.serie).toBe('BC01');
    expect(documento.numero).toBe(8);
    expect(documento.referencia).toMatchObject({ tipoDoc: '03', serie: 'B001' });
  });

  it('orden fijo: nc:<origen> → validarEnTransaccion → serie → INSERT → registrarEnvio → COMMIT → envío', async () => {
    const motor = motorConOrigen(facturaOrigen());

    await motor.servicio.emitirNotaCredito(solicitud(motor.bd.registro));

    const r = motor.bd.registro;
    expect(posicion(r, 'BEGIN')).toBeLessThan(posicion(r, 'tx:lock:nc:40'));
    expect(posicion(r, 'tx:lock:nc:40')).toBeLessThan(posicion(r, 'validarEnTransaccion'));
    expect(posicion(r, 'validarEnTransaccion')).toBeLessThan(posicion(r, 'tx:lock:comprobante:FC01'));
    expect(posicion(r, 'tx:lock:comprobante:FC01')).toBeLessThan(posicion(r, 'tx:insert:comprobantes'));
    expect(posicion(r, 'tx:insert:items')).toBeLessThan(posicion(r, 'tx:registrarEnvio:900'));
    expect(posicion(r, 'tx:registrarEnvio:900')).toBeLessThan(posicion(r, 'COMMIT'));
    expect(posicion(r, 'COMMIT')).toBeLessThan(posicion(r, 'enviar:501'));
    // La nota no toma el candado de la venta: no es el comprobante principal.
    expect(r.some((e) => e.includes('cpe-venta'))).toBe(false);
  });

  it('validarEnTransaccion recibe la conexión de la transacción y si rechaza no se inserta nada', async () => {
    const motor = motorConOrigen(facturaOrigen());
    const pedido = solicitud(motor.bd.registro, {
      validarEnTransaccion: jest.fn(async () => {
        throw new ConflictException({ message: 'Hay otra nota de crédito en curso para F001-12', id_comprobante: 41 });
      }),
    });

    await expect(motor.servicio.emitirNotaCredito(pedido)).rejects.toBeInstanceOf(ConflictException);

    expect(pedido.validarEnTransaccion).toHaveBeenCalledWith(motor.bd.manager);
    expect(motor.bd.registro).toContain('ROLLBACK');
    expect(motor.bd.registro).not.toContain('tx:lock:comprobante:FC01');
    expect(motor.bd.registro).not.toContain('tx:insert:comprobantes');
    expect(motor.emision.registrarEnvio).not.toHaveBeenCalled();
  });

  it('guarda el enlace con el origen y, solo si existen las columnas de fase14, el efecto y el ítem de origen', async () => {
    const conFase14 = motorConOrigen(facturaOrigen(), COLUMNAS_COMPLETAS);
    await conFase14.servicio.emitirNotaCredito(solicitud(conFase14.bd.registro));

    const insert = conFase14.bd.consultas.find((c) => /^\s*INSERT INTO comprobantes/.test(c.sql))!;
    const columnas = insert.sql.slice(insert.sql.indexOf('(') + 1, insert.sql.indexOf(')')).split(',').map((c) => c.trim());
    const valor = (columna: string) => insert.parametros[columnas.indexOf(columna)];
    expect(valor('id_tipo')).toBe(7);
    expect(valor('id_venta')).toBe(9);
    expect(valor('doc_modificado_tipo')).toBe('01');
    expect(valor('doc_modificado_serie')).toBe('F001');
    expect(valor('doc_modificado_numero')).toBe(12);
    expect(valor('id_comprobante_modificado')).toBe(40);
    expect(valor('nota_motivo')).toBe('07');
    expect(valor('nota_sustento')).toBe('Devolución de una bolsa de cemento');
    expect(valor('efecto_nota')).toBe('devolucion');
    expect(valor('reingresar_stock')).toBe(true);
    expect(valor('efectos_aplicados')).toBe(false);
    const items = conFase14.bd.consultas.find((c) => /INSERT INTO comprobante_items/.test(c.sql))!;
    expect(items.sql).toContain('id_item_origen');
    expect(items.parametros).toContainEqual([401]);

    const sinFase14 = motorConOrigen(facturaOrigen(), COLUMNAS_FASE9);
    await sinFase14.servicio.emitirNotaCredito(solicitud(sinFase14.bd.registro));
    const insertViejo = sinFase14.bd.consultas.find((c) => /^\s*INSERT INTO comprobantes/.test(c.sql))!;
    expect(insertViejo.sql).toContain('id_comprobante_modificado');
    expect(insertViejo.sql).not.toContain('efecto_nota');
    expect(insertViejo.sql).not.toContain('efectos_aplicados');
    const itemsViejos = sinFase14.bd.consultas.find((c) => /INSERT INTO comprobante_items/.test(c.sql))!;
    expect(itemsViejos.sql).not.toContain('id_item_origen');
  });

  it('sin las columnas de enlace de fase 9 responde 503 sin preparar ni numerar', async () => {
    const motor = motorConOrigen(facturaOrigen(), ['fiscal_envios.respuesta_json']);

    await expect(motor.servicio.emitirNotaCredito(solicitud(motor.bd.registro))).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('sql/fase9_sunat_directo.sql'),
    });
    expect(motor.emision.prepararDocumento).not.toHaveBeenCalled();
  });

  it('la nota no puede superar el saldo acreditable (montoMaximoNota = saldo_maximo)', async () => {
    const motor = motorConOrigen(facturaOrigen());

    const error = await motor.servicio
      .emitirNotaCredito(solicitud(motor.bd.registro, { saldo_maximo: 50 }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ codigo: 'FISCAL_NOTA_EXCEDE_MONTO' });
    expect(motor.emision.prepararDocumento).not.toHaveBeenCalled();
  });

  describe('origen admisible (PLAN D8)', () => {
    it.each([
      ['no aceptado', { aceptada_sunat: false, estado_sunat: 'PENDIENTE_REENVIO' }, 'todavía no está aceptado'],
      ['anulado', { anulado: true }, 'está anulado'],
      ['histórico', { proveedor_fiscal: 'nubefact' }, 'sistema anterior'],
      ['de otro ambiente', { ambiente_fiscal: 'beta' }, 'SUNAT BETA (pruebas)'],
    ])('rechaza un origen %s con 409', async (_caso, cambio, mensaje) => {
      const motor = motorConOrigen(facturaOrigen(cambio as Partial<Comprobante>));

      const error = await motor.servicio.emitirNotaCredito(solicitud(motor.bd.registro)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toContain(mensaje);
      expect(motor.emision.prepararDocumento).not.toHaveBeenCalled();
    });

    it('rechaza motivos que no se ofrecen y los exclusivos de factura sobre una boleta', async () => {
      const motor = motorConOrigen(facturaOrigen());
      await expect(motor.servicio.emitirNotaCredito(solicitud(motor.bd.registro, { motivo: '04' }))).rejects.toThrow('no está disponible');
      await expect(motor.servicio.emitirNotaCredito(solicitud(motor.bd.registro, { motivo: '13' }))).rejects.toThrow('no está disponible');

      const deBoleta = motorConOrigen(facturaOrigen({ tipo: { id_tipo: 2 } as never, serie: 'B001' }));
      await expect(deBoleta.servicio.emitirNotaCredito(solicitud(deBoleta.bd.registro, { motivo: '05' }))).rejects.toThrow(
        'solo se puede usar sobre facturas',
      );
    });

    it('con la emisión inactiva responde 503 sin reservar número', async () => {
      const motor = motorConOrigen(facturaOrigen());
      motor.emision.modo.mockResolvedValue({ activo: false, ambiente: 'produccion', codigo: 'FISCAL_EMISION_BLOQUEADA', motivo: 'SUNAT rechazó la clave SOL' });

      await expect(motor.servicio.emitirNotaCredito(solicitud(motor.bd.registro))).rejects.toMatchObject({ status: 503 });
      expect(motor.bd.registro).not.toContain('BEGIN');
    });

    it('exige sustento de 3 a 250 caracteres y al menos una línea', async () => {
      const motor = motorConOrigen(facturaOrigen());
      await expect(motor.servicio.emitirNotaCredito(solicitud(motor.bd.registro, { sustento: 'x' }))).rejects.toThrow('entre 3 y 250');
      await expect(motor.servicio.emitirNotaCredito(solicitud(motor.bd.registro, { lineas: [] }))).rejects.toThrow('al menos una línea');
    });
  });
});
