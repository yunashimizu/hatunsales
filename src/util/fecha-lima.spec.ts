import {
  aFechaLima,
  aTimestampUtc,
  diasEntreYmd,
  esFechaYmd,
  FechaLimaInvalidaError,
  fechaHoraLimaLegible,
  finDiaLima,
  horaLima,
  hoyLima,
  inicioAnioLima,
  inicioDiaLima,
  inicioMesLima,
  inicioQuincenaLima,
  inicioSemanaLima,
  mesLima,
  parsearFiltroFechasLima,
  rangoDiaLima,
  rangoFechasLima,
  SQL_HOY_LIMA,
  sqlFinExclusivoDiaLima,
  sqlInicioDiaLima,
  sumarDiasYmd,
  validarFechaYmd,
  ymdLima,
} from './fecha-lima';

describe('fecha-lima', () => {
  describe('aFechaLima / hoyLima', () => {
    it('el comprobante 23 (01:59 UTC) cae en el día anterior de Lima', () => {
      expect(aFechaLima(new Date('2026-07-30T01:59:38Z'))).toBe('2026-07-29');
      expect(ymdLima(new Date('2026-07-30T01:59:38Z'))).toBe('2026-07-29');
    });

    it('bordes: 04:59:59.999Z sigue siendo ayer y 05:00Z ya es hoy', () => {
      expect(aFechaLima(new Date('2026-07-30T04:59:59.999Z'))).toBe('2026-07-29');
      expect(aFechaLima(new Date('2026-07-30T05:00:00.000Z'))).toBe('2026-07-30');
    });

    it('cambio de año y de mes', () => {
      expect(aFechaLima(new Date('2027-01-01T03:00:00Z'))).toBe('2026-12-31');
      expect(aFechaLima(new Date('2026-03-01T04:00:00Z'))).toBe('2026-02-28');
      expect(aFechaLima(new Date('2028-03-01T04:00:00Z'))).toBe('2028-02-29');
    });

    it('hoyLima usa el instante recibido', () => {
      expect(hoyLima(new Date('2026-10-13T23:30:00Z'))).toBe('2026-10-13');
      expect(hoyLima(new Date('2026-10-14T00:30:00Z'))).toBe('2026-10-13');
    });

    it('rechaza instantes inválidos', () => {
      expect(() => aFechaLima(new Date('x'))).toThrow(FechaLimaInvalidaError);
    });

    it('mes, hora y formato legible en Lima', () => {
      expect(mesLima(new Date('2026-08-01T02:00:00Z'))).toBe('2026-07');
      expect(horaLima(new Date('2026-07-30T01:59:38Z'))).toBe('20:59:38');
      expect(fechaHoraLimaLegible(new Date('2026-07-30T01:59:38Z'))).toBe('29/07/2026 20:59');
    });
  });

  describe('validación de AAAA-MM-DD', () => {
    it('acepta fechas reales y rechaza las inexistentes o mal escritas', () => {
      expect(esFechaYmd('2026-02-28')).toBe(true);
      expect(esFechaYmd('2028-02-29')).toBe(true);
      expect(esFechaYmd('2026-02-29')).toBe(false);
      expect(esFechaYmd('2026-13-01')).toBe(false);
      expect(esFechaYmd('2026-7-1')).toBe(false);
      expect(esFechaYmd('2026-07-01T00:00:00')).toBe(false);
      expect(esFechaYmd("2026-07-01' OR 1=1 --")).toBe(false);
      expect(esFechaYmd(20260701)).toBe(false);
    });

    it('validarFechaYmd recorta espacios e informa el campo', () => {
      expect(validarFechaYmd(' 2026-07-01 ', 'desde')).toBe('2026-07-01');
      let error: unknown;
      try {
        validarFechaYmd('01/07/2026', 'hasta');
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(FechaLimaInvalidaError);
      expect((error as FechaLimaInvalidaError).campo).toBe('hasta');
      expect((error as Error).message).toContain('AAAA-MM-DD');
    });
  });

  describe('límites de día', () => {
    it('inicio y fin del día de Lima en UTC', () => {
      expect(inicioDiaLima('2026-07-29').toISOString()).toBe('2026-07-29T05:00:00.000Z');
      expect(finDiaLima('2026-07-29').toISOString()).toBe('2026-07-30T04:59:59.999Z');
    });

    it('rangoDiaLima es medio abierto y contiene al comprobante 23', () => {
      const r = rangoDiaLima('2026-07-29');
      expect(r.desde.toISOString()).toBe('2026-07-29T05:00:00.000Z');
      expect(r.hasta.toISOString()).toBe('2026-07-30T05:00:00.000Z');
      const c23 = new Date('2026-07-30T01:59:38Z').getTime();
      expect(c23 >= r.desde.getTime() && c23 < r.hasta.getTime()).toBe(true);
    });

    it('rangoFechasLima cubre los días completos y rechaza rangos invertidos', () => {
      const r = rangoFechasLima('2026-07-01', '2026-07-31');
      expect(r.desde.toISOString()).toBe('2026-07-01T05:00:00.000Z');
      expect(r.hasta.toISOString()).toBe('2026-08-01T05:00:00.000Z');
      expect(() => rangoFechasLima('2026-08-01', '2026-07-31')).toThrow(FechaLimaInvalidaError);
    });

    it('aTimestampUtc da texto UTC sin zona para columnas timestamp', () => {
      expect(aTimestampUtc(inicioDiaLima('2026-07-29'))).toBe('2026-07-29 05:00:00.000');
    });
  });

  describe('aritmética de días', () => {
    it('suma días cruzando meses y años', () => {
      expect(sumarDiasYmd('2026-12-25', 15)).toBe('2027-01-09');
      expect(sumarDiasYmd('2026-03-01', -1)).toBe('2026-02-28');
      expect(() => sumarDiasYmd('2026-03-01', 1.5)).toThrow(FechaLimaInvalidaError);
    });

    it('cuenta días entre fechas', () => {
      expect(diasEntreYmd('2026-07-01', '2026-07-31')).toBe(30);
      expect(diasEntreYmd('2026-07-31', '2026-07-01')).toBe(-30);
    });
  });

  describe('inicios de periodo en Lima', () => {
    // Martes 2026-07-28 a las 21:00 de Lima = 2026-07-29T02:00Z (en UTC ya es miércoles).
    const martesNoche = new Date('2026-07-29T02:00:00Z');

    it('semana empieza el lunes de Lima', () => {
      expect(inicioSemanaLima(martesNoche).toISOString()).toBe('2026-07-27T05:00:00.000Z');
      // Domingo 2026-08-02 23:00 Lima → lunes 2026-07-27
      expect(inicioSemanaLima(new Date('2026-08-03T04:00:00Z')).toISOString()).toBe('2026-07-27T05:00:00.000Z');
      // Lunes 2026-08-03 00:00 Lima exacto
      expect(inicioSemanaLima(new Date('2026-08-03T05:00:00Z')).toISOString()).toBe('2026-08-03T05:00:00.000Z');
    });

    it('quincena, mes y año', () => {
      expect(inicioQuincenaLima(martesNoche).toISOString()).toBe('2026-07-16T05:00:00.000Z');
      expect(inicioQuincenaLima(new Date('2026-07-15T12:00:00Z')).toISOString()).toBe('2026-07-01T05:00:00.000Z');
      expect(inicioMesLima(new Date('2026-08-01T03:00:00Z')).toISOString()).toBe('2026-07-01T05:00:00.000Z');
      expect(inicioAnioLima(new Date('2027-01-01T03:00:00Z')).toISOString()).toBe('2026-01-01T05:00:00.000Z');
    });
  });

  describe('parsearFiltroFechasLima', () => {
    it('ignora vacíos', () => {
      expect(parsearFiltroFechasLima({ desde: '', hasta: undefined })).toEqual({});
      expect(parsearFiltroFechasLima({ desde: '  ', hasta: null })).toEqual({});
    });

    it('devuelve fechas e instantes de borde', () => {
      const f = parsearFiltroFechasLima({ desde: '2026-07-29', hasta: '2026-07-29' });
      expect(f.desde).toBe('2026-07-29');
      expect(f.hasta).toBe('2026-07-29');
      expect(f.desdeInstante!.toISOString()).toBe('2026-07-29T05:00:00.000Z');
      expect(f.hastaExclusivo!.toISOString()).toBe('2026-07-30T05:00:00.000Z');
    });

    it('rechaza formato malo, rango invertido y rango muy largo', () => {
      expect(() => parsearFiltroFechasLima({ desde: '29-07-2026' })).toThrow(FechaLimaInvalidaError);
      expect(() => parsearFiltroFechasLima({ desde: '2026-08-02', hasta: '2026-08-01' })).toThrow(
        /no puede ser posterior/,
      );
      expect(() =>
        parsearFiltroFechasLima({ desde: '2026-01-01', hasta: '2026-12-31' }, { maxDias: 31 }),
      ).toThrow(/31 días/);
      expect(parsearFiltroFechasLima({ desde: '2026-07-01', hasta: '2026-07-31' }, { maxDias: 31 }).hasta).toBe(
        '2026-07-31',
      );
    });
  });

  describe('fragmentos SQL', () => {
    it('solo aceptan marcadores, nunca valores', () => {
      expect(sqlInicioDiaLima('$1')).toBe(
        "(CAST($1 AS date)::timestamp AT TIME ZONE 'America/Lima' AT TIME ZONE 'UTC')",
      );
      expect(sqlFinExclusivoDiaLima(':hasta')).toBe(
        "((CAST(:hasta AS date) + 1)::timestamp AT TIME ZONE 'America/Lima' AT TIME ZONE 'UTC')",
      );
      expect(() => sqlInicioDiaLima("'2026-07-01'")).toThrow();
      expect(() => sqlInicioDiaLima('$1; DROP TABLE ventas')).toThrow();
      expect(SQL_HOY_LIMA).toBe("(now() AT TIME ZONE 'America/Lima')::date");
    });
  });

  it('no depende de la zona horaria del proceso', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Tokyo';
      expect(aFechaLima(new Date('2026-07-30T01:59:38Z'))).toBe('2026-07-29');
      expect(inicioDiaLima('2026-07-29').toISOString()).toBe('2026-07-29T05:00:00.000Z');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});
