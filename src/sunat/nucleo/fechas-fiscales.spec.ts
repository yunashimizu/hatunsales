import { compactarFecha, diasEntre, esFechaIso, esHoraValida, fechaLima, horaLima, resolverHoy, sumarDias, ZONA_HORARIA_PERU } from './fechas-fiscales';

describe('fechas fiscales (hora de Lima, UTC−5)', () => {
  it('la zona horaria es America/Lima', () => {
    expect(ZONA_HORARIA_PERU).toBe('America/Lima');
  });

  it('fechaLima y horaLima convierten desde UTC: a las 03:30 UTC todavía es el día anterior en Lima', () => {
    const instante = new Date('2026-11-06T03:30:15Z');
    expect(fechaLima(instante)).toBe('2026-11-05');
    expect(horaLima(instante)).toBe('22:30:15');
    expect(fechaLima(new Date('2026-11-06T05:00:00Z'))).toBe('2026-11-06');
    expect(horaLima(new Date('2026-11-06T05:00:00Z'))).toBe('00:00:00');
  });

  it('fechaLima cruza el fin de año y respeta los años bisiestos', () => {
    expect(fechaLima(new Date('2027-01-01T04:59:59Z'))).toBe('2026-12-31');
    expect(fechaLima(new Date('2028-03-01T03:00:00Z'))).toBe('2028-02-29');
  });

  it('esFechaIso acepta solo fechas que existen en el calendario', () => {
    expect(esFechaIso('2026-11-05')).toBe(true);
    expect(esFechaIso('2028-02-29')).toBe(true);
    expect(esFechaIso('2026-02-29')).toBe(false);
    expect(esFechaIso('2026-13-01')).toBe(false);
    expect(esFechaIso('2026-4-5')).toBe(false);
    expect(esFechaIso('05/11/2026')).toBe(false);
    expect(esFechaIso(20261105)).toBe(false);
    expect(esFechaIso(null)).toBe(false);
  });

  it('esHoraValida acepta HH:mm:ss de 00:00:00 a 23:59:59', () => {
    expect(esHoraValida('00:00:00')).toBe(true);
    expect(esHoraValida('23:59:59')).toBe(true);
    expect(esHoraValida('24:00:00')).toBe(false);
    expect(esHoraValida('10:60:00')).toBe(false);
    expect(esHoraValida('10:00')).toBe(false);
  });

  it('diasEntre cuenta días calendario, con signo, sin importar el horario', () => {
    expect(diasEntre('2026-11-03', '2026-11-10')).toBe(7);
    expect(diasEntre('2026-11-10', '2026-11-03')).toBe(-7);
    expect(diasEntre('2026-11-05', '2026-11-05')).toBe(0);
    expect(diasEntre('2026-12-28', '2027-01-04')).toBe(7);
    expect(diasEntre('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('diasEntre lanza con una fecha inválida', () => {
    expect(() => diasEntre('2026-02-30', '2026-03-01')).toThrow(/Fecha inválida/);
    expect(() => diasEntre('2026-03-01', 'ayer')).toThrow(/Fecha inválida/);
  });

  it('sumarDias suma y resta cruzando mes y año', () => {
    expect(sumarDias('2026-11-03', 7)).toBe('2026-11-10');
    expect(sumarDias('2026-12-30', 3)).toBe('2027-01-02');
    expect(sumarDias('2026-03-01', -1)).toBe('2026-02-28');
    expect(sumarDias('2028-03-01', -1)).toBe('2028-02-29');
    expect(sumarDias('2026-11-05', 0)).toBe('2026-11-05');
  });

  it('compactarFecha quita los guiones (identificadores RC y RA) y rechaza lo inválido', () => {
    expect(compactarFecha('2026-11-05')).toBe('20261105');
    expect(() => compactarFecha('2026-11-31')).toThrow(/Fecha inválida/);
  });

  it('resolverHoy: texto válido tal cual, Date por su día en Lima, vacío = hoy en Lima y basura lanza', () => {
    expect(resolverHoy('2026-11-05')).toBe('2026-11-05');
    expect(resolverHoy(new Date('2026-11-06T03:00:00Z'))).toBe('2026-11-05');
    expect(resolverHoy(null)).toBe(fechaLima());
    expect(resolverHoy(undefined)).toBe(fechaLima());
    expect(() => resolverHoy('hoy')).toThrow(/Fecha de referencia inválida/);
  });
});
