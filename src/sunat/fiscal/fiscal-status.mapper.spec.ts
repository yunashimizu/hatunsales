import { FiscalStatusMapper } from './fiscal-status.mapper';

describe('FiscalStatusMapper', () => {
  it('normaliza estados externos sin romper el flujo', () => {
    expect(FiscalStatusMapper.normalizar('error')).toBe('EXCEPCION');
    expect(FiscalStatusMapper.normalizar('enviado')).toBe('ENVIANDO');
    expect(FiscalStatusMapper.normalizar('aceptado')).toBe('ACEPTADO');
    expect(FiscalStatusMapper.normalizar('ticket_pendiente')).toBe('TICKET_PENDIENTE');
  });
});
