import type { DocumentoCpe } from './documento-fiscal.types';
import { DocumentoCpeInvalidoError } from './errores-nucleo';
import {
  boletaPrueba,
  facturaPrueba,
  HOY_PRUEBA,
  notaCreditoPrueba,
  notaDebitoPrueba,
} from './pruebas/documentos-prueba-spec';
import { asegurarDocumentoCpeValido, ValidadorDocumentoCpe, validarDocumentoCpe } from './validaciones-cpe';
import { AcumuladorValidacion, ContextoValidacionCpe, ReglaValidacionCpe } from './validacion/base-validacion';

const opciones = { hoy: HOY_PRUEBA };

function errores(doc: DocumentoCpe, extra: Parameters<typeof validarDocumentoCpe>[1] = {}): string[] {
  return validarDocumentoCpe(doc, { ...opciones, ...extra }).errores;
}

function contiene(lista: string[], texto: string): boolean {
  return lista.some((m) => m.includes(texto));
}

describe('validarDocumentoCpe', () => {
  describe('casos válidos', () => {
    it.each([
      ['factura', facturaPrueba()],
      ['boleta sin documento (< S/ 700)', boletaPrueba()],
      ['nota de crédito de factura', notaCreditoPrueba()],
      ['nota de débito de factura', notaDebitoPrueba()],
      ['factura con series alfanuméricas reales (FFF1)', facturaPrueba(undefined, { serie: 'FFF1' })],
      ['factura con serie F001', facturaPrueba(undefined, { serie: 'F001' })],
    ])('%s no tiene errores', (_nombre, doc) => {
      expect(validarDocumentoCpe(doc, opciones)).toEqual({ errores: [], advertencias: [] });
    });

    it('factura a crédito con 2 cuotas que suman el pendiente', () => {
      const doc = facturaPrueba([{ descripcion: 'FIERRO 1/2', cantidad: 10, precio: 35 }], {
        formaPago: {
          tipo: 'Credito',
          montoPendiente: 350,
          cuotas: [
            { numero: 1, monto: 175, fechaPago: '2026-11-12' },
            { numero: 2, monto: 175, fechaPago: '2026-12-12' },
          ],
        },
      });
      expect(errores(doc)).toEqual([]);
    });

    it('boleta mayor a S/ 700 con DNI', () => {
      const doc = boletaPrueba([{ descripcion: 'MEZCLADORA', cantidad: 1, precio: 1500 }], {
        cliente: { tipoDoc: '1', numDoc: '71739060', nombre: 'JUAN PEREZ' },
      });
      expect(errores(doc)).toEqual([]);
    });
  });

  describe('serie y número', () => {
    it('rechaza series que no siguen F/B + 3 alfanuméricos', () => {
      expect(contiene(errores(facturaPrueba(undefined, { serie: 'B001' })), 'no es válida para una factura')).toBe(true);
      expect(contiene(errores(boletaPrueba(undefined, { serie: 'F001' })), 'no es válida para una boleta')).toBe(true);
      expect(contiene(errores(facturaPrueba(undefined, { serie: 'F01' })), 'no es válida')).toBe(true);
      expect(contiene(errores(facturaPrueba(undefined, { serie: 'fff1' })), 'mayúsculas')).toBe(true);
    });

    it('la nota usa el prefijo del documento que modifica', () => {
      const nc = notaCreditoPrueba(undefined, { serie: 'BC01' });
      expect(contiene(errores(nc), 'de una factura')).toBe(true);
      const ncBoleta = notaCreditoPrueba(undefined, {
        serie: 'BC01',
        cliente: { tipoDoc: '1', numDoc: '71739060', nombre: 'JUAN PEREZ' },
        referencia: { tipoDoc: '03', serie: 'BBB1', numero: 26, motivo: '07', sustento: 'DEVOLUCION' },
      });
      expect(errores(ncBoleta)).toEqual([]);
    });

    it('número entre 1 y 99999999', () => {
      expect(contiene(errores(facturaPrueba(undefined, { numero: 0 })), 'entre 1 y 99999999')).toBe(true);
      expect(contiene(errores(facturaPrueba(undefined, { numero: 100_000_000 })), 'entre 1 y 99999999')).toBe(true);
      expect(contiene(errores(facturaPrueba(undefined, { numero: 1.5 })), 'entre 1 y 99999999')).toBe(true);
    });
  });

  describe('emisor y adquirente', () => {
    it('RUC del emisor con dígito verificador y ubigeo de 6 dígitos', () => {
      const doc = facturaPrueba();
      doc.emisor = { ...doc.emisor, ruc: '20610206330', ubigeo: '1501' };
      const lista = errores(doc);
      expect(contiene(lista, 'RUC del emisor')).toBe(true);
      expect(contiene(lista, 'ubigeo')).toBe(true);
    });

    it('la factura exige RUC válido del adquirente', () => {
      expect(contiene(errores(facturaPrueba(undefined, { cliente: { tipoDoc: '1', numDoc: '71739060', nombre: 'X' } })), 'exige un adquirente con RUC')).toBe(true);
      expect(contiene(errores(facturaPrueba(undefined, { cliente: { tipoDoc: '6', numDoc: '20123456789', nombre: 'X' } })), 'no es válido')).toBe(true);
    });

    it('la boleta que supera S/ 700 exige identificar al comprador; hasta 700.00 no', () => {
      const mayor = boletaPrueba([{ descripcion: 'MEZCLADORA', cantidad: 1, precio: 700.01 }]);
      expect(contiene(errores(mayor), 'supera S/ 700.00')).toBe(true);
      const exacto = boletaPrueba([{ descripcion: 'MEZCLADORA', cantidad: 1, precio: 700 }]);
      expect(errores(exacto)).toEqual([]);
      const dniCeros = boletaPrueba([{ descripcion: 'MEZCLADORA', cantidad: 1, precio: 900 }], {
        cliente: { tipoDoc: '1', numDoc: '00000000', nombre: 'CLIENTES VARIOS' },
      });
      expect(contiene(errores(dniCeros), 'supera S/ 700.00')).toBe(true);
    });

    it('DNI de 8 dígitos y tipo de documento del catálogo 06', () => {
      expect(contiene(errores(boletaPrueba(undefined, { cliente: { tipoDoc: '1', numDoc: '1234', nombre: 'X' } })), 'DNI')).toBe(true);
      expect(contiene(errores(boletaPrueba(undefined, { cliente: { tipoDoc: '9', numDoc: '1234', nombre: 'X' } })), 'catálogo 06')).toBe(true);
    });
  });

  describe('líneas', () => {
    it('cantidad, unidad del catálogo 03, descripción y afectación', () => {
      const doc = facturaPrueba();
      doc.lineas = [{ ...doc.lineas[0], cantidad: 0, unidad: 'SFSDF', descripcion: 'a\u0007b' }];
      const lista = errores(doc);
      expect(contiene(lista, 'la cantidad debe ser mayor que cero')).toBe(true);
      expect(contiene(lista, 'catálogo 03')).toBe(true);
      expect(contiene(lista, 'caracteres de control')).toBe(true);
    });

    it('rechaza operaciones gratuitas y exportación con un mensaje claro', () => {
      const doc = facturaPrueba();
      doc.lineas = [{ ...doc.lineas[0], afectacion: '11' as never }];
      expect(contiene(errores(doc), 'operación gratuita')).toBe(true);
      doc.lineas = [{ ...doc.lineas[0], afectacion: '40' as never }];
      expect(contiene(errores(doc), 'exportación')).toBe(true);
    });

    it('detecta IGV que no corresponde a la tasa (doble IGV) y totales que no cuadran', () => {
      const doc = facturaPrueba();
      doc.lineas = [{ ...doc.lineas[0], igv: 1.8, total: 10.27 }];
      const lista = errores(doc);
      expect(contiene(lista, 'no corresponde al 18%')).toBe(true);
      expect(contiene(lista, 'no cuadra con la suma de las líneas')).toBe(true);
    });

    it('una línea exonerada no lleva IGV', () => {
      const doc = facturaPrueba([{ descripcion: 'LIBRO', cantidad: 1, precio: 20, tipoIgv: 8 }]);
      doc.lineas = [{ ...doc.lineas[0], igv: 1, total: 21 }];
      expect(contiene(errores(doc), 'no lleva IGV')).toBe(true);
    });

    it('código de producto SUNAT: 8 dígitos si viene; advierte segmentos genéricos', () => {
      const doc = facturaPrueba([{ descripcion: 'X', cantidad: 1, precio: 10, codigoSunat: '1234' }]);
      expect(contiene(errores(doc), '8 dígitos')).toBe(true);
      const generico = facturaPrueba([{ descripcion: 'X', cantidad: 1, precio: 10, codigoSunat: '10000000' }]);
      const resultado = validarDocumentoCpe(generico, opciones);
      expect(resultado.errores).toEqual([]);
      expect(contiene(resultado.advertencias, 'segmento genérico')).toBe(true);
    });

    it('montos con más de 2 decimales', () => {
      const doc = facturaPrueba();
      doc.lineas = [{ ...doc.lineas[0], valorVenta: 8.474 }];
      expect(contiene(errores(doc), 'como máximo 2 decimales')).toBe(true);
    });
  });

  describe('forma de pago', () => {
    const base = () => facturaPrueba([{ descripcion: 'FIERRO', cantidad: 10, precio: 35 }]);

    it('crédito sin cuotas, cuotas que no suman y cuota que vence antes de la emisión', () => {
      expect(contiene(errores({ ...base(), formaPago: { tipo: 'Credito', montoPendiente: 350, cuotas: [] } }), 'al menos una cuota')).toBe(true);
      expect(
        contiene(
          errores({ ...base(), formaPago: { tipo: 'Credito', montoPendiente: 350, cuotas: [{ numero: 1, monto: 300, fechaPago: '2026-11-01' }] } }),
          'suma de las cuotas',
        ),
      ).toBe(true);
      expect(
        contiene(
          errores({ ...base(), formaPago: { tipo: 'Credito', montoPendiente: 350, cuotas: [{ numero: 1, monto: 350, fechaPago: HOY_PRUEBA }] } }),
          'posterior a la fecha de emisión',
        ),
      ).toBe(true);
      expect(
        contiene(
          errores({ ...base(), formaPago: { tipo: 'Credito', montoPendiente: 400, cuotas: [{ numero: 1, monto: 400, fechaPago: '2026-11-01' }] } }),
          'no puede superar el importe total',
        ),
      ).toBe(true);
    });

    it('la NC motivo 13 exige la nueva forma de pago al crédito', () => {
      const nc = notaCreditoPrueba(undefined, { referencia: { tipoDoc: '01', serie: 'FFF1', numero: 7, motivo: '13', sustento: 'NUEVO CRONOGRAMA' } });
      expect(contiene(errores(nc), 'motivo 13 debe informar la forma de pago')).toBe(true);
    });
  });

  describe('notas', () => {
    it('referencia obligatoria, motivo del catálogo y sustento', () => {
      expect(contiene(errores(notaCreditoPrueba(undefined, { referencia: undefined })), 'Falta el comprobante que modifica')).toBe(true);
      const sinMotivo = notaCreditoPrueba(undefined, { referencia: { tipoDoc: '01', serie: 'FFF1', numero: 7, motivo: '99', sustento: '' } });
      const lista = errores(sinMotivo);
      expect(contiene(lista, 'catálogo 09')).toBe(true);
      expect(contiene(lista, 'sustento')).toBe(true);
    });

    it('motivos exclusivos de factura no aplican a boletas', () => {
      const nc = notaCreditoPrueba(undefined, {
        serie: 'BC01',
        cliente: { tipoDoc: '1', numDoc: '71739060', nombre: 'JUAN PEREZ' },
        referencia: { tipoDoc: '03', serie: 'BBB1', numero: 26, motivo: '04', sustento: 'DESCUENTO' },
      });
      expect(contiene(errores(nc), 'no se puede usar sobre una boleta')).toBe(true);
    });

    it('la NC no puede superar el saldo del comprobante modificado', () => {
      expect(contiene(errores(notaCreditoPrueba(), { montoMaximoNota: 5 }), 'supera el saldo')).toBe(true);
      expect(errores(notaCreditoPrueba(), { montoMaximoNota: 10 })).toEqual([]);
    });
  });

  describe('reglas RS 000048-2026 (desde el 01/01/2027)', () => {
    it('en auto se activan por la fecha de emisión: el código de producto pasa a ser obligatorio', () => {
      const antes = facturaPrueba();
      expect(errores(antes, { aplicarReglas2027: 'auto' })).toEqual([]);
      const despues = facturaPrueba(undefined, { fechaEmision: '2027-01-02' });
      expect(contiene(errores(despues, { hoy: '2027-01-02' }), 'código de producto SUNAT de 8 dígitos')).toBe(true);
      expect(errores(antes, { aplicarReglas2027: true }).length).toBeGreaterThan(0);
      expect(errores(despues, { hoy: '2027-01-02', aplicarReglas2027: false })).toEqual([]);
    });

    it('ND motivo 13: solo desde 2027 y solo inafecta o exonerada', () => {
      const gravada = notaDebitoPrueba([{ descripcion: 'PENALIDAD', cantidad: 1, precio: 50, codigoSunat: '80161500' }], {
        referencia: { tipoDoc: '01', serie: 'FFF1', numero: 7, motivo: '13', sustento: 'PENALIDAD' },
      });
      expect(contiene(errores(gravada), 'rige desde el 01/01/2027')).toBe(true);
      expect(contiene(errores(gravada, { aplicarReglas2027: true }), 'debe ser inafecta o exonerada')).toBe(true);
      const inafecta = notaDebitoPrueba([{ descripcion: 'PENALIDAD', cantidad: 1, precio: 50, tipoIgv: 9, codigoSunat: '80161500' }], {
        referencia: { tipoDoc: '01', serie: 'FFF1', numero: 7, motivo: '13', sustento: 'PENALIDAD' },
      });
      expect(errores(inafecta, { aplicarReglas2027: true })).toEqual([]);
    });
  });

  describe('fechas y plazos', () => {
    it('fecha futura es error; fuera de plazo es advertencia', () => {
      expect(contiene(errores(facturaPrueba(undefined, { fechaEmision: '2026-10-14' })), 'posterior a hoy')).toBe(true);
      const atrasada = validarDocumentoCpe(facturaPrueba(undefined, { fechaEmision: '2026-10-08' }), opciones);
      expect(atrasada.errores).toEqual([]);
      expect(contiene(atrasada.advertencias, '3 días')).toBe(true);
      const boleta = validarDocumentoCpe(boletaPrueba(undefined, { fechaEmision: '2026-10-07' }), opciones);
      expect(contiene(boleta.advertencias, 'resumen diario')).toBe(true);
    });

    it('formato de fecha y hora', () => {
      const lista = errores(facturaPrueba(undefined, { fechaEmision: '13-10-2026', horaEmision: '25:00:00' }));
      expect(contiene(lista, 'fecha de emisión')).toBe(true);
      expect(contiene(lista, 'hora de emisión')).toBe(true);
    });
  });

  it('una regla que falla por datos con forma inesperada no lanza: queda como error', () => {
    const doc = facturaPrueba();
    (doc as any).lineas = [null];
    expect(() => validarDocumentoCpe(doc, opciones)).not.toThrow();
    expect(errores(doc).length).toBeGreaterThan(0);
  });

  it('asegurarDocumentoCpeValido lanza DocumentoCpeInvalidoError con la lista', () => {
    let capturado: unknown;
    try {
      asegurarDocumentoCpeValido(facturaPrueba(undefined, { serie: 'X1' }), opciones);
    } catch (error) {
      capturado = error;
    }
    expect(capturado).toBeInstanceOf(DocumentoCpeInvalidoError);
    expect((capturado as DocumentoCpeInvalidoError).codigo).toBe('FISCAL_DOCUMENTO_INVALIDO');
    expect((capturado as DocumentoCpeInvalidoError).errores.length).toBeGreaterThan(0);
    expect(asegurarDocumentoCpeValido(facturaPrueba(), opciones)).toEqual([]);
  });

  it('admite reglas propias (estrategia)', () => {
    const reglaPropia: ReglaValidacionCpe = {
      nombre: 'propia',
      validar: (contexto: ContextoValidacionCpe, acumulador: AcumuladorValidacion) => {
        if (contexto.doc.totales.total > 5) acumulador.advertencia('Venta mayor a 5');
      },
    };
    const resultado = new ValidadorDocumentoCpe([reglaPropia]).validar(facturaPrueba(), opciones);
    expect(resultado).toEqual({ errores: [], advertencias: ['Venta mayor a 5'] });
  });
});
