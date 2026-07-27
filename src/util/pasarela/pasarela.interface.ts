/**
 * Contrato único que debe cumplir cualquier pasarela de pago.
 *
 * El resto del sistema solo conoce esta interfaz, así que cambiar de proveedor
 * (Culqi, Niubiz, Izipay, Mercado Pago…) es escribir una clase nueva y
 * registrarla en el provider; ninguna regla de negocio se entera.
 */
export const PASARELA_PAGO = Symbol('PASARELA_PAGO');

export interface SolicitudCargo {
  /** Monto en soles, con decimales. La implementación lo convierte a céntimos si hace falta. */
  monto: number;
  moneda: string;
  descripcion: string;
  email: string;
  /** Token de tarjeta generado en el navegador por el SDK del proveedor. */
  token: string;
  /** Se reenvía a la pasarela para que ella tampoco duplique el cargo. */
  claveIdempotencia: string;
  metadata?: Record<string, string | number>;
}

export interface ResultadoCargo {
  aprobado: boolean;
  /** Id del cargo en la pasarela. Es lo que guardamos como referencia_externa. */
  referencia: string;
  proveedor: string;
  mensaje: string;
  /** Respuesta cruda, útil para conciliar y depurar. */
  crudo?: Record<string, any>;
}

export interface EventoWebhook {
  /** true si la firma del webhook es válida. */
  valido: boolean;
  tipo: string;
  referencia?: string;
  aprobado: boolean;
  monto?: number;
  /** Lo que hayamos mandado como metadata al crear el cargo. */
  metadata?: Record<string, any>;
  crudo?: Record<string, any>;
}

export interface PasarelaPago {
  /** Nombre corto: 'culqi', 'simulada'… Se guarda en pedido_pagos.proveedor. */
  readonly nombre: string;

  /** Llave pública que el frontend necesita para tokenizar la tarjeta. */
  llavePublica(): string;

  /** true si hay credenciales reales; false si estamos en modo simulado. */
  operativa(): boolean;

  crearCargo(solicitud: SolicitudCargo): Promise<ResultadoCargo>;

  /** Interpreta y valida la notificación que envía la pasarela. */
  interpretarWebhook(cuerpo: any, cabeceras: Record<string, any>): EventoWebhook;
}
