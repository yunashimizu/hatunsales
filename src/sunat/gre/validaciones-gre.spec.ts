import type { DocumentoGre } from './gre.tipos';
import { greOtrosPrivado, greTrasladoPrivado, greVentaPublica, HOY_GRE_PRUEBA } from './pruebas/documentos-gre-prueba-spec';
import { normalizarPlacaGre, validarDocumentoGre } from './validaciones-gre';

const validar = (doc: DocumentoGre) => validarDocumentoGre(doc, { hoy: HOY_GRE_PRUEBA });
const campos = (doc: DocumentoGre) => validar(doc).porCampo!.filter((o) => o.nivel === 'error').map((o) => o.campo);

describe('validarDocumentoGre', () => {
  describe('casos válidos', () => {
    it.each([
      ['venta (01) con transporte público', greVentaPublica()],
      ['traslado entre establecimientos (04) con transporte privado', greTrasladoPrivado()],
      ['otros (13) con descripción y caracteres especiales', greOtrosPrivado()],
    ])('%s pasa sin errores', (_nombre, doc) => {
      const resultado = validar(doc);
      expect(resultado.errores).toEqual([]);
      expect(resultado.porCampo!.every((o) => o.nivel === 'advertencia')).toBe(true);
    });

    it('cada mensaje va también en porCampo con su ruta', () => {
      const resultado = validar(greVentaPublica({ serie: 'F001', envio: { pesoBrutoTotal: 0 } }));
      expect(resultado.porCampo).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ campo: 'serie', nivel: 'error' }),
          expect.objectContaining({ campo: 'envio.pesoBrutoTotal', nivel: 'error' }),
        ]),
      );
      expect(resultado.errores).toHaveLength(resultado.porCampo!.filter((o) => o.nivel === 'error').length);
    });

    it('una fecha de referencia mal escrita no hace lanzar: se usa hoy en Lima', () => {
      expect(() => validarDocumentoGre(greVentaPublica(), { hoy: '21/10/2026' })).not.toThrow();
    });

    it('no lanza con un documento vacío o incompleto', () => {
      expect(validarDocumentoGre(null as unknown as DocumentoGre).errores).toEqual(['La guía de remisión llegó vacía.']);
      const incompleto = validar({ tipo: '09' } as DocumentoGre);
      expect(incompleto.errores.length).toBeGreaterThan(5);
      expect(incompleto.errores.join(' ')).toContain('Datos del traslado');
    });
  });

  describe('cabecera', () => {
    it('serie con T + 3 alfanuméricos y correlativo de 1 a 99999999', () => {
      expect(campos(greVentaPublica({ serie: 'F001' }))).toContain('serie');
      expect(campos(greVentaPublica({ serie: 't001' }))).toContain('serie');
      expect(campos(greVentaPublica({ numero: 0 }))).toContain('numero');
      expect(campos(greVentaPublica({ numero: 100_000_000 }))).toContain('numero');
      expect(campos(greVentaPublica({ numero: 1.5 }))).toContain('numero');
      expect(validar(greVentaPublica({ numero: 99_999_999 })).errores).toEqual([]);
    });

    it('fecha de emisión: no futura; si es pasada solo advierte', () => {
      expect(campos(greVentaPublica({ fechaEmision: '2026-10-22', envio: { fechaInicioTraslado: '2026-10-22' } }))).toContain('fechaEmision');
      const pasada = validar(greVentaPublica({ fechaEmision: '2026-10-20' }));
      expect(pasada.errores).toEqual([]);
      expect(pasada.advertencias.join(' ')).toContain('anterior a hoy');
      expect(campos(greVentaPublica({ fechaEmision: '2026-02-30' }))).toContain('fechaEmision');
      expect(campos(greVentaPublica({ horaEmision: '24:00:00' }))).toContain('horaEmision');
    });

    it('remitente con RUC válido y razón social', () => {
      const doc = greVentaPublica();
      doc.remitente = { ...doc.remitente, ruc: '20610206330', razonSocial: ' ' };
      expect(campos(doc)).toEqual(expect.arrayContaining(['remitente.ruc', 'remitente.razonSocial']));
    });

    it('observaciones de hasta 250 caracteres', () => {
      expect(campos(greVentaPublica({ observaciones: 'x'.repeat(251) }))).toContain('observaciones');
    });
  });

  describe('destinatario', () => {
    it('RUC de 11 dígitos con dígito verificador y DNI de 8 dígitos', () => {
      expect(campos(greVentaPublica({ destinatario: { tipoDoc: '6', numDoc: '20553856450', nombre: 'X' } }))).toContain('destinatario.numDoc');
      expect(campos(greVentaPublica({ destinatario: { tipoDoc: '1', numDoc: '1234567', nombre: 'X' } }))).toContain('destinatario.numDoc');
      expect(validar(greVentaPublica({ destinatario: { tipoDoc: '1', numDoc: '45678912', nombre: 'ANA' } })).errores).toEqual([]);
    });

    it('tipo fuera del catálogo 06 se marca en el tipo; sin documento no se admite', () => {
      expect(campos(greVentaPublica({ destinatario: { tipoDoc: 'Z', numDoc: '123', nombre: 'X' } }))).toContain('destinatario.tipoDoc');
      const sinDocumento = validar(greVentaPublica({ destinatario: { tipoDoc: '0', numDoc: '-', nombre: 'CLIENTES VARIOS' } }));
      expect(sinDocumento.errores.join(' ')).toContain('necesita el documento de identidad');
    });

    it('nombre obligatorio', () => {
      expect(campos(greVentaPublica({ destinatario: { tipoDoc: '6', numDoc: '20553856451', nombre: '' } }))).toContain('destinatario.nombre');
    });
  });

  describe('motivos', () => {
    it('solo 01, 04 y 13 están habilitados; los demás dan un error claro', () => {
      const compra = validar(greVentaPublica({ envio: { motivo: '02' } }));
      expect(compra.errores.join(' ')).toContain('«Compra» (02) no está habilitado todavía');
      expect(validar(greVentaPublica({ envio: { motivo: '19' } })).errores.join(' ')).toContain('no está habilitado todavía');
      expect(validar(greVentaPublica({ envio: { motivo: '99' } })).errores.join(' ')).toContain('no existe en el catálogo 20');
    });

    it('04: el destinatario es el propio remitente', () => {
      const doc = greTrasladoPrivado({ destinatario: { tipoDoc: '6', numDoc: '20553856451', nombre: 'OTRA EMPRESA' } });
      const resultado = validar(doc);
      expect(resultado.porCampo).toEqual(expect.arrayContaining([expect.objectContaining({ campo: 'destinatario.numDoc', nivel: 'error' })]));
      expect(resultado.errores.join(' ')).toContain('use RUC 20610206337');
    });

    it('04: partida y llegada con código de establecimiento de 4 dígitos y distintos', () => {
      const sinCodigo = greTrasladoPrivado();
      sinCodigo.envio.llegada = { ubigeo: '150101', direccion: 'JR. AYACUCHO 450' };
      expect(campos(sinCodigo)).toContain('envio.llegada.codigoEstablecimiento');

      const malCodigo = greTrasladoPrivado();
      malCodigo.envio.partida = { ...malCodigo.envio.partida, codigoEstablecimiento: '01' };
      expect(campos(malCodigo)).toContain('envio.partida.codigoEstablecimiento');

      const mismo = greTrasladoPrivado();
      mismo.envio.llegada = { ...mismo.envio.llegada, codigoEstablecimiento: '0000' };
      expect(validar(mismo).errores.join(' ')).toContain('mismo establecimiento');
    });

    it('13: la descripción es obligatoria (hasta 100) y se advierte si es un motivo del catálogo', () => {
      expect(campos(greOtrosPrivado({ envio: { descripcionMotivo: '' } }))).toContain('envio.descripcionMotivo');
      expect(campos(greOtrosPrivado({ envio: { descripcionMotivo: 'x'.repeat(101) } }))).toContain('envio.descripcionMotivo');
      const parecido = validar(greOtrosPrivado({ envio: { descripcionMotivo: 'Venta al cliente' } }));
      expect(parecido.errores).toEqual([]);
      expect(parecido.advertencias.join(' ')).toContain('corresponde al motivo 01');
    });

    it('01 sin factura ni boleta relacionada: solo advertencia (RS 188-2010, art. 19, num. 9)', () => {
      const resultado = validar(greVentaPublica({ documentosRelacionados: [] }));
      expect(resultado.errores).toEqual([]);
      expect(resultado.advertencias.join(' ')).toContain('conviene relacionar la factura o boleta');
    });
  });

  describe('modalidad', () => {
    it('solo 01 o 02', () => {
      expect(campos(greVentaPublica({ envio: { modalidad: '03' as never } }))).toContain('envio.modalidad');
    });

    it('01 (público): transportista con RUC válido y razón social; registro MTC opcional', () => {
      expect(campos(greVentaPublica({ transportista: undefined }))).toContain('transportista');
      expect(campos(greVentaPublica({ transportista: { tipoDoc: '6', numDoc: '20100066604', razonSocial: 'X' } }))).toContain('transportista.numDoc');
      expect(campos(greVentaPublica({ transportista: { tipoDoc: '1', numDoc: '20100066603', razonSocial: 'X' } }))).toContain('transportista.tipoDoc');
      expect(campos(greVentaPublica({ transportista: { tipoDoc: '6', numDoc: '20100066603', razonSocial: '' } }))).toContain('transportista.razonSocial');
      expect(validar(greVentaPublica({ transportista: { tipoDoc: '6', numDoc: '20100066603', razonSocial: 'TRANSPORTES' } })).errores).toEqual([]);
      expect(campos(greVentaPublica({ transportista: { tipoDoc: '6', numDoc: '20100066603', razonSocial: 'T', registroMtc: 'MTC 123-45' } }))).toContain(
        'transportista.registroMtc',
      );
    });

    it('01: vehículo y conductores no se envían (advertencia) y el transportista no debería ser el remitente', () => {
      const resultado = validar(
        greVentaPublica({
          vehiculo: { placa: 'ABC123' },
          transportista: { tipoDoc: '6', numDoc: '20610206337', razonSocial: 'HATUNSALES S.A.C.' },
        }),
      );
      expect(resultado.errores).toEqual([]);
      expect(resultado.advertencias.join(' ')).toContain('no se enviarán');
      expect(resultado.advertencias.join(' ')).toContain('modalidad 02');
    });

    it('01: la fecha de entrega al transportista no puede ser anterior a la emisión', () => {
      expect(campos(greVentaPublica({ envio: { fechaEntregaTransportista: '2026-10-20' } }))).toContain('envio.fechaEntregaTransportista');
      expect(campos(greVentaPublica({ envio: { fechaEntregaTransportista: '21/10/2026' } }))).toContain('envio.fechaEntregaTransportista');
    });

    it('02 (privado): placa peruana en mayúsculas sin guiones y al menos un conductor completo', () => {
      expect(campos(greTrasladoPrivado({ vehiculo: undefined }))).toContain('vehiculo.placa');
      const conGuion = validar(greTrasladoPrivado({ vehiculo: { placa: 'abc-123' } }));
      expect(conGuion.errores.join(' ')).toContain('sin guiones ni espacios: ABC123');
      expect(campos(greTrasladoPrivado({ vehiculo: { placa: 'AB12' } }))).toContain('vehiculo.placa');
      expect(campos(greTrasladoPrivado({ vehiculo: { placa: 'ABC1234567' } }))).toContain('vehiculo.placa');
      expect(campos(greTrasladoPrivado({ conductores: [] }))).toContain('conductores');
      expect(
        campos(greTrasladoPrivado({ conductores: [{ tipoDoc: '1', numDoc: '4567891', nombres: '', apellidos: '', licencia: '' }] })),
      ).toEqual(
        expect.arrayContaining(['conductores[0].numDoc', 'conductores[0].nombres', 'conductores[0].apellidos', 'conductores[0].licencia']),
      );
      expect(
        campos(greTrasladoPrivado({ conductores: [{ tipoDoc: '1', numDoc: '45678912', nombres: 'A', apellidos: 'B', licencia: 'Q-123 456' }] })),
      ).toContain('conductores[0].licencia');
    });

    it('02: un conductor principal y hasta dos secundarios', () => {
      const conductor = { tipoDoc: '1', numDoc: '45678912', nombres: 'A', apellidos: 'B', licencia: 'Q45678912' };
      expect(validar(greTrasladoPrivado({ conductores: [conductor, conductor, conductor] })).errores).toEqual([]);
      expect(campos(greTrasladoPrivado({ conductores: [conductor, conductor, conductor, conductor] }))).toContain('conductores');
    });

    it('normalizarPlacaGre quita guiones y espacios y pasa a mayúsculas', () => {
      expect(normalizarPlacaGre(' abc-123 ')).toBe('ABC123');
      expect(normalizarPlacaGre(null)).toBe('');
    });
  });

  describe('traslado, peso y puntos', () => {
    it('inicio del traslado igual o posterior a la emisión', () => {
      expect(campos(greVentaPublica({ envio: { fechaInicioTraslado: '2026-10-20' } }))).toContain('envio.fechaInicioTraslado');
      expect(validar(greVentaPublica({ envio: { fechaInicioTraslado: '2026-10-25' } })).errores).toEqual([]);
    });

    it('peso bruto mayor que 0, hasta 3 decimales, en KGM o TNE', () => {
      expect(campos(greVentaPublica({ envio: { pesoBrutoTotal: 0 } }))).toContain('envio.pesoBrutoTotal');
      expect(campos(greVentaPublica({ envio: { pesoBrutoTotal: -1 } }))).toContain('envio.pesoBrutoTotal');
      expect(campos(greVentaPublica({ envio: { pesoBrutoTotal: 1.2345 } }))).toContain('envio.pesoBrutoTotal');
      expect(campos(greVentaPublica({ envio: { pesoBrutoTotal: Number.NaN } }))).toContain('envio.pesoBrutoTotal');
      expect(campos(greVentaPublica({ envio: { unidadPeso: 'LBR' } }))).toContain('envio.unidadPeso');
      expect(validar(greVentaPublica({ envio: { pesoBrutoTotal: 0.001, unidadPeso: 'TNE' } })).errores).toEqual([]);
    });

    it('número de bultos entero de 1 a 999999 u omitido', () => {
      expect(campos(greVentaPublica({ envio: { numeroBultos: 0 } }))).toContain('envio.numeroBultos');
      expect(campos(greVentaPublica({ envio: { numeroBultos: 2.5 } }))).toContain('envio.numeroBultos');
      expect(validar(greVentaPublica({ envio: { numeroBultos: undefined } })).errores).toEqual([]);
    });

    it('ubigeo INEI de 6 dígitos con forma de distrito y dirección obligatoria', () => {
      const doc = greVentaPublica();
      doc.envio.llegada = { ubigeo: '15012', direccion: '' };
      expect(campos(doc)).toEqual(expect.arrayContaining(['envio.llegada.ubigeo', 'envio.llegada.direccion']));
      doc.envio.llegada = { ubigeo: '150100', direccion: 'AV. LIMA 1' };
      expect(campos(doc)).toContain('envio.llegada.ubigeo');
      doc.envio.llegada = { ubigeo: '260101', direccion: 'AV. LIMA 1' };
      expect(campos(doc)).toContain('envio.llegada.ubigeo');
      doc.envio.llegada = { ubigeo: '150101', direccion: 'x'.repeat(501) };
      expect(campos(doc)).toContain('envio.llegada.direccion');
    });

    it('la llegada no puede ser la misma dirección que la partida', () => {
      const doc = greVentaPublica();
      doc.envio.llegada = { ubigeo: '150119', direccion: ' lt. 8  mz. n1 urb. nuevo lurín ' };
      expect(validar(doc).errores.join(' ')).toContain('misma dirección');
    });
  });

  describe('ítems', () => {
    it('al menos un ítem', () => {
      expect(campos(greVentaPublica({ items: [] }))).toContain('items');
    });

    it('cantidad > 0 con hasta 10 decimales, unidad del catálogo 03 y descripción', () => {
      const errores = campos(
        greVentaPublica({
          items: [
            { cantidad: 0, unidad: 'UND', descripcion: '' },
            { cantidad: 1.12345678901, unidad: 'NIU', descripcion: 'X', codigoSunat: '123' },
            { cantidad: 1, unidad: 'NIU', descripcion: 'X', codigoInterno: 'c'.repeat(31) },
          ],
        }),
      );
      expect(errores).toEqual(
        expect.arrayContaining([
          'items[0].cantidad',
          'items[0].unidad',
          'items[0].descripcion',
          'items[1].cantidad',
          'items[1].codigoSunat',
          'items[2].codigoInterno',
        ]),
      );
    });
  });

  describe('documentos relacionados', () => {
    it('tipo del catálogo 61, serie y número válidos y sin repetir', () => {
      const errores = campos(
        greVentaPublica({
          documentosRelacionados: [
            { tipo: '01', serie: 'B001', numero: '12' },
            { tipo: '03', serie: 'B001', numero: '000000000' },
            { tipo: '77', serie: 'X', numero: '1' },
            { tipo: '01', serie: 'F001', numero: '12', rucEmisor: '20610206330' },
            { tipo: '50', serie: '', numero: '' },
          ],
        }),
      );
      expect(errores).toEqual(
        expect.arrayContaining([
          'documentosRelacionados[0].serie',
          'documentosRelacionados[1].numero',
          'documentosRelacionados[2].tipo',
          'documentosRelacionados[3].rucEmisor',
          'documentosRelacionados[4].numero',
        ]),
      );
      const repetido = validar(
        greVentaPublica({
          documentosRelacionados: [
            { tipo: '01', serie: 'F001', numero: '12' },
            { tipo: '01', serie: 'f001', numero: '0012' },
          ],
        }),
      );
      expect(repetido.errores.join(' ')).toContain('está repetido');
    });

    it('acepta facturas y boletas electrónicas, de SEE-SOL e impresas, y una DAM sin serie', () => {
      const resultado = validar(
        greVentaPublica({
          documentosRelacionados: [
            { tipo: '01', serie: 'E001', numero: '5' },
            { tipo: '03', serie: '0001', numero: '99999999' },
            { tipo: '50', serie: '', numero: '118-2026-10-123456' },
          ],
        }),
      );
      expect(resultado.errores).toEqual([]);
    });
  });
});
