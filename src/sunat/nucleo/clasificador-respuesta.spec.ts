import {
  ClasificadorRespuestaSunat,
  CODIGOS_RECUPERAR_CDR,
} from './clasificador-respuesta';
import type { RespuestaSunat } from './documento-fiscal.types';

describe('ClasificadorRespuestaSunat: recuperación segura BETA', () => {
  const clasificador = new ClasificadorRespuestaSunat({ warn: jest.fn() });

  function respuesta(tipo: RespuestaSunat['tipo'], codigo: string): RespuestaSunat {
    return {
      tipo,
      codigo,
      descripcion: 'Respuesta de prueba',
      observaciones: [],
      tiempoMs: 1,
    };
  }

  it.each([...CODIGOS_RECUPERAR_CDR])(
    'marca el código %s como recuperación de CDR y prohíbe reenviar a ciegas',
    (codigo) => {
      const resultado = clasificador.clasificar(respuesta('FAULT', codigo), {
        operacion: 'emitir',
        tipo: '03',
      });

      expect(resultado.estado).toBe('PENDIENTE_REENVIO');
      expect(resultado.accion).toBe('RECUPERAR_CDR');
      expect(resultado.mensajeUsuario).toContain('No reenvíe el ZIP');
      expect(resultado.mensajeUsuario).toContain('no está disponible en BETA');
    },
  );

  it('identifica los errores de transporte como resultado incierto, sin afirmar reintento automático', () => {
    const resultado = clasificador.clasificar(
      respuesta('TRANSPORTE', 'ETIMEDOUT'),
      { operacion: 'emitir', tipo: '01' },
    );

    expect(resultado.estado).toBe('PENDIENTE_REENVIO');
    expect(resultado.accion).toBe('REINTENTAR');
    expect(resultado.mensajeUsuario).toContain('resultado puede ser incierto');
    expect(resultado.mensajeUsuario).toContain('manualmente');
    expect(resultado.mensajeUsuario).not.toContain('automáticamente');
  });
});
