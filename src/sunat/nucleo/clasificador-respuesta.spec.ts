import {
  ClasificadorRespuestaSunat,
  CODIGOS_RECUPERAR_CDR,
} from './clasificador-respuesta';
import type { ContextoClasificacion, RespuestaSunat } from './documento-fiscal.types';

describe('ClasificadorRespuestaSunat', () => {
  const advertencias = { warn: jest.fn() };
  const clasificador = new ClasificadorRespuestaSunat(advertencias);

  beforeEach(() => advertencias.warn.mockClear());

  function respuesta(tipo: RespuestaSunat['tipo'], codigo: string, cambios: Partial<RespuestaSunat> = {}): RespuestaSunat {
    return {
      tipo,
      codigo,
      descripcion: 'Respuesta de prueba',
      observaciones: [],
      tiempoMs: 1,
      ...cambios,
    };
  }

  const emitirFactura: ContextoClasificacion = { operacion: 'emitir', tipo: '01', serie: 'F001' };
  const emitirBoleta: ContextoClasificacion = { operacion: 'emitir', tipo: '03', serie: 'B001' };

  describe('«ya recibido» (1033, 0402, 2109, 2403): recuperar la constancia, nunca reenviar a ciegas', () => {
    it('el conjunto incluye los cuatro códigos documentados', () => {
      expect([...CODIGOS_RECUPERAR_CDR].sort()).toEqual(['0402', '1033', '2109', '2403']);
    });

    it.each(['1033', '0402', '2109', '2403'])('%s como Fault → PENDIENTE_REENVIO + RECUPERAR_CDR', (codigo) => {
      const resultado = clasificador.clasificar(respuesta('FAULT', codigo), emitirFactura);
      expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'RECUPERAR_CDR' });
      expect(resultado.bloqueaEmision).toBeUndefined();
    });

    it.each(['2109', '2403'])('%s en el CDR se revisa ANTES del rango 2000-3999 (no es RECHAZADO/EMITIR_NUEVO)', (codigo) => {
      const resultado = clasificador.clasificar(respuesta('CDR', codigo), emitirFactura);
      expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'RECUPERAR_CDR' });
    });

    it('también reconoce los códigos sin ceros a la izquierda (402)', () => {
      expect(clasificador.clasificar(respuesta('FAULT', '402'), emitirFactura).accion).toBe('RECUPERAR_CDR');
    });

    it('1033/2109 avisan que el número se registró con OTROS datos; 0402/2403 que ya se recibió', () => {
      expect(clasificador.clasificar(respuesta('FAULT', '1033'), emitirFactura).mensajeUsuario).toContain('registrado antes con otros datos');
      expect(clasificador.clasificar(respuesta('CDR', '2109'), emitirFactura).mensajeUsuario).toContain('registrado antes con otros datos');
      expect(clasificador.clasificar(respuesta('FAULT', '0402'), emitirFactura).mensajeUsuario).toContain('ya recibió este comprobante');
      expect(clasificador.clasificar(respuesta('CDR', '2403'), emitirFactura).mensajeUsuario).toContain('ya recibió este comprobante');
    });

    it('en producción, una factura o nota de serie F se recuperará por getStatusCdr', () => {
      for (const contexto of [
        { ...emitirFactura, ambiente: 'produccion' as const },
        { operacion: 'emitir' as const, tipo: '07' as const, serie: 'FC01', ambiente: 'produccion' as const },
        { operacion: 'emitir' as const, tipo: '08' as const, serie: 'FD01', ambiente: 'produccion' as const },
      ]) {
        const mensaje = clasificador.clasificar(respuesta('FAULT', '1033'), contexto).mensajeUsuario;
        expect(mensaje).toContain('se consultará la constancia (CDR) a SUNAT antes de reenviar');
        expect(mensaje).not.toContain('Operaciones en Línea');
        expect(mensaje).not.toContain('BETA');
      }
    });

    it('boletas, notas de boleta y BETA: verificar en SOL y confirmar (sin textos de BETA en producción)', () => {
      const casos: ContextoClasificacion[] = [
        { ...emitirBoleta, ambiente: 'produccion' },
        { operacion: 'emitir', tipo: '07', serie: 'BC01', ambiente: 'produccion' },
        { ...emitirFactura, ambiente: 'beta' },
        { operacion: 'emitir', tipo: '01', ambiente: 'produccion' },
      ];
      for (const contexto of casos) {
        const mensaje = clasificador.clasificar(respuesta('FAULT', '0402'), contexto).mensajeUsuario;
        expect(mensaje).toContain('verifique en SUNAT Operaciones en Línea y confirme el resultado');
        expect(mensaje).not.toContain('se consultará la constancia');
        expect(mensaje).not.toContain('no está disponible en BETA');
      }
    });

    it('sin ambiente el texto es neutro', () => {
      const mensaje = clasificador.clasificar(respuesta('FAULT', '2403'), emitirBoleta).mensajeUsuario;
      expect(mensaje).toContain('No reenvíe el ZIP a ciegas');
      expect(mensaje).not.toContain('BETA');
      expect(mensaje).not.toContain('se consultará la constancia');
      expect(mensaje).not.toContain('confirme el resultado');
    });

    it('en el CDR de un resumen manda el rechazo del lote (los números no se invalidan)', () => {
      const resultado = clasificador.clasificar(respuesta('CDR', '2403'), { operacion: 'resumen' });
      expect(resultado).toMatchObject({ estado: 'RECHAZADO', accion: 'CORREGIR_Y_REENVIAR' });
    });
  });

  describe('ya informado y anulado o rechazado (1032 y 2987)', () => {
    it.each([
      ['FAULT', '1032'],
      ['FAULT', '2987'],
      ['CDR', '2987'],
    ] as const)('%s %s → RECHAZADO + EMITIR_NUEVO, no es recuperable', (tipo, codigo) => {
      const resultado = clasificador.clasificar(respuesta(tipo, codigo), emitirFactura);
      expect(resultado).toMatchObject({ estado: 'RECHAZADO', accion: 'EMITIR_NUEVO' });
      expect(resultado.mensajeUsuario).toContain('anulado o rechazado');
    });
  });

  describe('1079 y 1078', () => {
    it('1079 → EXCEPCION + NINGUNA: la boleta solo puede ir en un resumen diario', () => {
      const resultado = clasificador.clasificar(respuesta('FAULT', '1079', { descripcion: 'Solo puede enviar el comprobante en un resumen diario' }), emitirBoleta);
      expect(resultado).toMatchObject({ estado: 'EXCEPCION', accion: 'NINGUNA' });
      expect(resultado.mensajeUsuario).toContain('Fuera del plazo de envío individual: la boleta solo puede informarse en un resumen diario');
      expect(resultado.mensajeUsuario).not.toContain('reenvíe con el mismo número');
      expect(resultado.bloqueaEmision).toBeUndefined();
    });

    it('1078 (emisor no autorizado en SEE-Del contribuyente) → ERROR_CONFIG + REVISAR_CONFIG sin bloquear el ambiente', () => {
      const resultado = clasificador.clasificar(respuesta('FAULT', '1078'), emitirFactura);
      expect(resultado).toMatchObject({ estado: 'ERROR_CONFIG', accion: 'REVISAR_CONFIG' });
      expect(resultado.mensajeUsuario).toContain('no está habilitado');
      expect(resultado.bloqueaEmision).toBeUndefined();
    });

    it('2012 (contribuyente no autorizado a emitir electrónicos) en el CDR → ERROR_CONFIG, con aviso de número usado', () => {
      const resultado = clasificador.clasificar(respuesta('CDR', '2012'), emitirFactura);
      expect(resultado).toMatchObject({ estado: 'ERROR_CONFIG', accion: 'REVISAR_CONFIG' });
      expect(resultado.mensajeUsuario).toContain('número ya quedó usado');
    });
  });

  describe('credencial SOL y certificado: ERROR_CONFIG que abre el interruptor (bloqueaEmision)', () => {
    it.each(['0101', '0102', '0103', '0104', '0105', '0106', '0111', '0112', '0113', '0154'])('Fault %s de credencial', (codigo) => {
      const resultado = clasificador.clasificar(respuesta('FAULT', codigo), emitirFactura);
      expect(Object.keys(resultado).sort()).toEqual(['accion', 'bloqueaEmision', 'estado', 'mensajeUsuario']);
      expect(resultado).toMatchObject({ estado: 'ERROR_CONFIG', accion: 'REVISAR_CONFIG', bloqueaEmision: true });
      expect(resultado.mensajeUsuario).toContain('Corrija el usuario y la clave SOL');
      expect(resultado.mensajeUsuario).toContain('reanude la emisión');
    });

    it('2107 (usuario SOL de otro RUC) es de credencial, como Fault o en el CDR', () => {
      for (const tipo of ['FAULT', 'CDR'] as const) {
        const resultado = clasificador.clasificar(respuesta(tipo, '2107', { descripcion: 'Numero de RUC SOL no coincide con RUC emisor' }), emitirFactura);
        expect(resultado).toMatchObject({ estado: 'ERROR_CONFIG', accion: 'REVISAR_CONFIG', bloqueaEmision: true });
        expect(resultado.mensajeUsuario).toContain('credencial SOL');
      }
    });

    it.each(['2325', '2326', '2327', '2328'])('certificado %s en el CDR: se corrige el certificado y se reanuda; el número quedó usado', (codigo) => {
      const resultado = clasificador.clasificar(respuesta('CDR', codigo), emitirFactura);
      expect(resultado).toMatchObject({ estado: 'ERROR_CONFIG', accion: 'REVISAR_CONFIG', bloqueaEmision: true });
      expect(resultado.mensajeUsuario).toContain('Corrija el certificado');
      expect(resultado.mensajeUsuario).toContain('reanude la emisión');
      expect(resultado.mensajeUsuario).toContain('número ya quedó usado');
    });

    it('certificado como Fault: bloquea sin afirmar que el número quedó usado', () => {
      const resultado = clasificador.clasificar(respuesta('FAULT', '2327'), emitirFactura);
      expect(resultado).toMatchObject({ estado: 'ERROR_CONFIG', bloqueaEmision: true });
      expect(resultado.mensajeUsuario).not.toContain('número ya quedó usado');
    });

    it('el certificado rechazado en un resumen también bloquea (firma el lote)', () => {
      const resultado = clasificador.clasificar(respuesta('CDR', '2325'), { operacion: 'resumen', etapa: 'consulta_ticket' });
      expect(resultado).toMatchObject({ estado: 'ERROR_CONFIG', bloqueaEmision: true });
      expect(resultado.mensajeUsuario).not.toContain('número ya quedó usado');
    });

    it('0109 (servicio de autenticación caído) NO es de credencial: es transitorio', () => {
      const resultado = clasificador.clasificar(respuesta('FAULT', '0109'), emitirFactura);
      expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR' });
      expect(resultado.bloqueaEmision).toBeUndefined();
    });
  });

  describe('fuera de plazo (2108, 2600, 2950 y bajas 2374, 2376, 2379, 2957, 2958): EXCEPCION del documento, sin bloquear', () => {
    it.each(['2108', '2600', '2950'])('%s en una factura: emitir un comprobante nuevo', (codigo) => {
      const resultado = clasificador.clasificar(respuesta('CDR', codigo), emitirFactura);
      expect(resultado).toMatchObject({ estado: 'EXCEPCION', accion: 'NINGUNA' });
      expect(resultado.mensajeUsuario).toContain('Fuera de plazo');
      expect(resultado.mensajeUsuario).toContain('Emita un comprobante nuevo');
      expect(resultado.bloqueaEmision).toBeUndefined();
    });

    it('en una boleta o nota de boleta: informarla por resumen diario', () => {
      for (const contexto of [emitirBoleta, { operacion: 'emitir' as const, tipo: '07' as const, serie: 'BC01' }]) {
        const resultado = clasificador.clasificar(respuesta('FAULT', '2600'), contexto);
        expect(resultado).toMatchObject({ estado: 'EXCEPCION', accion: 'NINGUNA' });
        expect(resultado.mensajeUsuario).toContain('informe la boleta por resumen diario');
      }
    });

    it('una nota de factura sigue a la factura', () => {
      const resultado = clasificador.clasificar(respuesta('CDR', '2950'), { operacion: 'emitir', tipo: '07', serie: 'FC01' });
      expect(resultado.mensajeUsuario).toContain('Emita un comprobante nuevo');
    });

    it('sin tipo conocido el texto no supone factura ni boleta', () => {
      const resultado = clasificador.clasificar(respuesta('CDR', '2108'), { operacion: 'emitir' });
      expect(resultado).toMatchObject({ estado: 'EXCEPCION', accion: 'NINGUNA' });
      expect(resultado.mensajeUsuario).not.toContain('boleta');
      expect(resultado.mensajeUsuario).not.toContain('Emita');
    });

    it.each(['2374', '2376', '2379', '2957', '2958'])('baja %s fuera de plazo: anular con nota de crédito', (codigo) => {
      const resultado = clasificador.clasificar(respuesta('CDR', codigo), { operacion: 'baja', etapa: 'consulta_ticket' });
      expect(resultado).toMatchObject({ estado: 'EXCEPCION', accion: 'NINGUNA' });
      expect(resultado.mensajeUsuario).toContain('nota de crédito');
      expect(resultado.bloqueaEmision).toBeUndefined();
    });

    it('un resumen fuera de fecha no se «corrige y reenvía»', () => {
      const resultado = clasificador.clasificar(respuesta('CDR', '2108'), { operacion: 'resumen', etapa: 'consulta_ticket' });
      expect(resultado).toMatchObject({ estado: 'EXCEPCION', accion: 'NINGUNA' });
      expect(resultado.mensajeUsuario).toContain('resumen');
    });
  });

  describe('documento alterado (2334, 2335)', () => {
    it.each(['2334', '2335'])('%s → EXCEPCION con alerta técnica, sin bloquear el ambiente', (codigo) => {
      const resultado = clasificador.clasificar(respuesta('CDR', codigo), emitirFactura);
      expect(resultado).toMatchObject({ estado: 'EXCEPCION', accion: 'NINGUNA' });
      expect(resultado.mensajeUsuario).toContain('revise la firma o la codificación del XML');
      expect(resultado.bloqueaEmision).toBeUndefined();
    });
  });

  describe('0140 y demás transitorios', () => {
    it('0140 (otro documento igual en proceso) es transitorio: PENDIENTE_REENVIO + REINTENTAR', () => {
      const resultado = clasificador.clasificar(respuesta('FAULT', '0140'), emitirFactura);
      expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR' });
      expect(resultado.mensajeUsuario).toContain('procesando otro envío igual');
      expect(advertencias.warn).not.toHaveBeenCalled();
    });

    it('identifica los errores de transporte como resultado incierto, sin afirmar reintento automático', () => {
      const resultado = clasificador.clasificar(respuesta('TRANSPORTE', 'ETIMEDOUT'), emitirFactura);
      expect(resultado.estado).toBe('PENDIENTE_REENVIO');
      expect(resultado.accion).toBe('REINTENTAR');
      expect(resultado.mensajeUsuario).toContain('resultado puede ser incierto');
      expect(resultado.mensajeUsuario).toContain('manualmente');
      expect(resultado.mensajeUsuario).not.toContain('automáticamente');
    });
  });

  describe('rangos oficiales sin cambios para los demás códigos', () => {
    it('CDR 0 sin notas → ACEPTADO; con notas o 4xxx → ACEPTADO_OBS', () => {
      expect(clasificador.clasificar(respuesta('CDR', '0'), emitirFactura).estado).toBe('ACEPTADO');
      expect(
        clasificador.clasificar(respuesta('CDR', '0', { observaciones: [{ codigo: '4252', descripcion: 'Obs' }] }), emitirFactura).estado,
      ).toBe('ACEPTADO_OBS');
      expect(clasificador.clasificar(respuesta('CDR', '4031'), emitirFactura).estado).toBe('ACEPTADO_OBS');
    });

    it('otro 2xxx sigue siendo rechazo: el número quedó usado', () => {
      expect(clasificador.clasificar(respuesta('CDR', '2017'), emitirFactura)).toMatchObject({ estado: 'RECHAZADO', accion: 'EMITIR_NUEVO' });
      expect(clasificador.clasificar(respuesta('CDR', '2017'), { operacion: 'resumen' })).toMatchObject({ estado: 'RECHAZADO', accion: 'CORREGIR_Y_REENVIAR' });
    });

    it('otro 1xxx es excepción: se corrige y se reenvía con el mismo número', () => {
      expect(clasificador.clasificar(respuesta('FAULT', '1034'), emitirFactura)).toMatchObject({ estado: 'EXCEPCION', accion: 'CORREGIR_Y_REENVIAR' });
    });
  });

  describe('consultas getStatusCdr / getStatus (tabla 0001-0012 del Manual): ningún error de la consulta se reintenta', () => {
    const consulta: ContextoClasificacion = { operacion: 'consulta', tipo: '01', serie: 'F001', ambiente: 'produccion' };

    it.each([
      ['0001', 'ACEPTADO', 'ACEPTADO', 'NINGUNA'],
      ['0002', 'RECHAZADO', 'RECHAZADO', 'EMITIR_NUEVO'],
      ['0003', 'DE_BAJA', 'ANULADO', 'NINGUNA'],
      ['0011', 'NO_EXISTE', 'PENDIENTE_REENVIO', 'REINTENTAR'],
    ] as const)('%s (%s) → %s + %s', (codigo, estadoComprobante, estado, accion) => {
      expect(clasificador.clasificar(respuesta('ESTADO', codigo, { estadoComprobante }), consulta)).toMatchObject({ estado, accion });
    });

    it.each(['0004', '0005', '0006', '0007', '0009', '0010'])('%s (datos de la consulta inválidos) → EXCEPCION + NINGUNA', (codigo) => {
      const resultado = clasificador.clasificar(respuesta('ESTADO', codigo, { estadoComprobante: 'CONSULTA_INVALIDA' }), consulta);
      expect(resultado).toMatchObject({ estado: 'EXCEPCION', accion: 'NINGUNA' });
      expect(resultado.mensajeUsuario).toContain('repetirla no cambiará la respuesta');
      expect(advertencias.warn).not.toHaveBeenCalled();
    });

    it.each(['0008', '0012'])('%s (RUC no inscrito / no le pertenece) → ERROR_CONFIG + REVISAR_CONFIG', (codigo) => {
      const resultado = clasificador.clasificar(respuesta('ESTADO', codigo, { estadoComprobante: 'NO_AUTORIZADO' }), consulta);
      expect(resultado).toMatchObject({ estado: 'ERROR_CONFIG', accion: 'REVISAR_CONFIG' });
      expect(resultado.mensajeUsuario).toContain('usuario SOL');
    });

    it('sin estadoComprobante (respuesta armada en otro lado) decide por el código de la tabla', () => {
      expect(clasificador.clasificar(respuesta('ESTADO', '0010'), consulta)).toMatchObject({ estado: 'EXCEPCION', accion: 'NINGUNA' });
      expect(clasificador.clasificar(respuesta('ESTADO', '12', { estadoComprobante: 'DESCONOCIDO' }), consulta)).toMatchObject({ estado: 'ERROR_CONFIG' });
    });

    it('un código no documentado se registra y se reintenta (la tarea lo limita)', () => {
      const resultado = clasificador.clasificar(respuesta('ESTADO', '0099', { estadoComprobante: 'DESCONOCIDO' }), consulta);
      expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'REINTENTAR' });
      expect(advertencias.warn).toHaveBeenCalledTimes(1);
    });

    it('los ESTADO de un ticket (RC/RA) siguen su propio camino', () => {
      expect(clasificador.clasificar(respuesta('ESTADO', '99', { estadoComprobante: 'RECHAZADO' }), { operacion: 'resumen', etapa: 'consulta_ticket' })).toMatchObject({
        estado: 'RECHAZADO',
        accion: 'CORREGIR_Y_REENVIAR',
      });
    });
  });

  describe('consulta no disponible (BETA o documento que no admite getStatusCdr)', () => {
    it('queda para verificar y confirmar a mano; nunca reenvía ni reintenta en bucle', () => {
      const resultado = clasificador.clasificar(
        respuesta('NO_DISPONIBLE', 'CONSULTA_NO_ADMITIDA', { descripcion: 'SUNAT solo permite consultar por este servicio facturas y sus notas con serie F.' }),
        { ...emitirBoleta, ambiente: 'produccion' },
      );
      expect(resultado).toMatchObject({ estado: 'PENDIENTE_REENVIO', accion: 'RECUPERAR_CDR' });
      expect(resultado.mensajeUsuario).toContain('solo permite consultar');
      expect(resultado.mensajeUsuario).toContain('confirme el resultado');
    });

    it('en BETA usa el motivo que da el cliente SOAP', () => {
      const resultado = clasificador.clasificar(
        respuesta('NO_DISPONIBLE', 'NO_DISPONIBLE', { descripcion: 'SUNAT no ofrece el servicio de consulta de comprobantes en el ambiente BETA.' }),
        { ...emitirFactura, ambiente: 'beta' },
      );
      expect(resultado.accion).toBe('RECUPERAR_CDR');
      expect(resultado.mensajeUsuario).toContain('ambiente BETA');
    });
  });
});
