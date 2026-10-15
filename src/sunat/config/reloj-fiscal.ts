import { Injectable } from '@nestjs/common';

/** Reloj inyectable: las reglas de vigencia y plazos se prueban sin depender de la hora real. */
export abstract class RelojFiscal {
  abstract ahora(): Date;

  ms(): number {
    return this.ahora().getTime();
  }

  /** Fecha calendario en Lima (YYYY-MM-DD); Perú no tiene horario de verano. */
  fechaLima(fecha: Date = this.ahora()): string {
    return fechaEnLima(fecha);
  }
}

@Injectable()
export class RelojSistemaFiscal extends RelojFiscal {
  ahora(): Date {
    return new Date();
  }
}

const FORMATO_LIMA = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Lima',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function fechaEnLima(fecha: Date): string {
  return FORMATO_LIMA.format(fecha);
}

const MS_POR_DIA = 86_400_000;

/** Días enteros que faltan hasta `hasta` (negativo si ya pasó). */
export function diasHasta(hasta: Date, desde: Date): number {
  return Math.floor((hasta.getTime() - desde.getTime()) / MS_POR_DIA);
}
