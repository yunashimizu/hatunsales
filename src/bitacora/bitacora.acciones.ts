/**
 * Acciones de la bitácora (`bitacora_acciones.accion`, VARCHAR(60)). Plan «Escribir menos y vender con
 * control», Fase 6.3. Las marcadas «B2» las registra el control de rebajas (Tanda B2); aquí solo se
 * declaran para que el nombre sea uno solo en todo el sistema.
 */
export const ACCIONES_BITACORA = {
  /** B2: rebaja manual sobre el tope del rol (modo `registrar`, o autorizada en modo `autorizar`). */
  VENTA_REBAJA_SOBRE_TOPE: 'venta.rebaja_sobre_tope',
  /** B2: precio final por debajo del costo. */
  VENTA_BAJO_COSTO: 'venta.bajo_costo',
  /** B2: venta que pasó con el permiso de un administrador. */
  VENTA_AUTORIZADA: 'venta.autorizada',
  /** Venta de administración que no descontó stock (6.5), con su motivo o «sin motivo». */
  VENTA_SIN_DESCONTAR_STOCK: 'venta.sin_descontar_stock',
  /** Pedido de anulación de una venta (en el sistema, con nota de crédito o con baja en SUNAT). */
  VENTA_ANULADA: 'venta.anulada',
  /** Nota de crédito emitida (por devolución parcial o para anular). */
  NOTA_CREDITO_EMITIDA: 'nota_credito.emitida',
  /** Ajuste manual de stock (POST /inventario/ajuste). */
  INVENTARIO_AJUSTE: 'inventario.ajuste',
  /** Cambio de precio de venta, costo o descuento de un producto (antes y después). R7: obligatorio. */
  PRODUCTO_PRECIO_CAMBIADO: 'producto.precio_cambiado',
  PRODUCTO_ELIMINADO: 'producto.eliminado',
  /** Un usuario (admin) cerró el turno de caja de otro. */
  CAJA_CIERRE_AJENO: 'caja.cierre_ajeno',
  /** B2: cambio de la configuración del control de rebajas. */
  CONFIGURACION_CONTROL_REBAJA: 'configuracion.control_rebaja',
  /** Fase 7.1: egreso de caja que devuelve en efectivo lo cobrado de una venta (anulación de otro turno o devolución parcial). */
  CAJA_DEVOLUCION_EFECTIVO: 'caja.devolucion_efectivo',
  /** Fase 7.4: la tarea cerró un turno olvidado (sin conteo). */
  CAJA_CIERRE_AUTOMATICO: 'caja.cierre_automatico',
  /** Fase 7: cambio de la configuración de caja (crédito con abonos, arqueo ciego, cierre automático). */
  CONFIGURACION_CONTROL_CAJA: 'configuracion.control_caja',
  /** Fase 8.2: la tarea venció un pedido web sin pagar (stock y cupón devueltos). */
  PEDIDO_VENCIDO: 'pedido.vencido',
  /** Fase 8.3: la pasarela aprobó un cobro de un pedido ya cancelado (hay que devolverlo). */
  PEDIDO_COBRO_SOBRE_CANCELADO: 'pedido.cobro_sobre_cancelado',
  /** Fase 8.3: el admin marcó ese cobro como devuelto. */
  PEDIDO_COBRO_DEVUELTO: 'pedido.cobro_devuelto',
  /** Fase 8.4: se confirmó una recepción con una guía ya registrada del mismo proveedor. */
  RECEPCION_GUIA_REPETIDA: 'recepcion.guia_repetida',
  /** Fase 8.5: cambio de los locales asignados a un usuario. */
  USUARIO_LOCALES: 'usuario.locales',
  /** Fase 8: cambio de la configuración de stock y pedidos web (vencimiento, guía repetida). */
  CONFIGURACION_CONTROL_STOCK: 'configuracion.control_stock',
  /** Fase 9.4: un administrador vendió a crédito a un cliente con deuda vencida más allá de los días de gracia. */
  CREDITO_CON_MORA: 'credito.con_mora',
} as const;

export type AccionBitacora = (typeof ACCIONES_BITACORA)[keyof typeof ACCIONES_BITACORA];

/** Nombre legible de cada acción, para el filtro de la pantalla «Actividad». */
export const ETIQUETA_ACCION_BITACORA: Record<AccionBitacora, string> = {
  'venta.rebaja_sobre_tope': 'Rebaja sobre el tope',
  'venta.bajo_costo': 'Venta bajo el costo',
  'venta.autorizada': 'Venta autorizada por un administrador',
  'venta.sin_descontar_stock': 'Venta sin descontar stock',
  'venta.anulada': 'Anulación de venta',
  'nota_credito.emitida': 'Nota de crédito emitida',
  'inventario.ajuste': 'Ajuste de stock',
  'producto.precio_cambiado': 'Cambio de precio o costo',
  'producto.eliminado': 'Producto eliminado',
  'caja.cierre_ajeno': 'Cierre de caja de otro usuario',
  'configuracion.control_rebaja': 'Configuración del control de rebajas',
  'caja.devolucion_efectivo': 'Devolución en efectivo desde la caja',
  'caja.cierre_automatico': 'Cierre automático de un turno olvidado',
  'configuracion.control_caja': 'Configuración de caja',
  'pedido.vencido': 'Pedido web vencido sin pago',
  'pedido.cobro_sobre_cancelado': 'Cobro sobre un pedido cancelado',
  'pedido.cobro_devuelto': 'Cobro de pedido cancelado devuelto',
  'recepcion.guia_repetida': 'Recepción con guía repetida',
  'usuario.locales': 'Locales asignados a un usuario',
  'configuracion.control_stock': 'Configuración de stock y pedidos web',
  'credito.con_mora': 'Crédito dado con deuda vencida',
};

/** Texto que se anota cuando una acción que debería traer motivo llega sin él (front anterior). */
export const SIN_MOTIVO = 'sin motivo';
