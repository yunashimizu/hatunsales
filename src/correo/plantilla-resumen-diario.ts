/**
 * Correo del resumen diario al dueño (Fase F3). Función pura: sin acceso a BD ni a red. HTML simple (tablas, estilos
 * en línea, sin imágenes externas) en grafito y oro, y la misma información en texto plano.
 *
 * Cada sección puede venir en `null`: si una consulta falló, el correo sale igual con un aviso en ese bloque.
 */
const GRAFITO = '#2b2c2b';
const ORO = '#b8975a';
const GRIS = '#6a6c6b';
const LINEA = '#e3e1da';
const ROJO = '#a33a2c';
const VERDE = '#2f6b45';

export interface VentasDiaResumen {
  fecha: string;
  total: number;
  ventas: number;
  ticket_promedio: number;
}

export interface DatosResumenDiario {
  /** Día del resumen, 'YYYY-MM-DD' (Lima). */
  fecha: string;
  negocio: string;
  /** Correo de prueba (botón «Enviar ahora de prueba»): se marca en el asunto y arriba. */
  esPrueba?: boolean;
  ventas: { hoy: VentasDiaResumen; ayer: VentasDiaResumen; semana_pasada: VentasDiaResumen } | null;
  caja: { total: number; turnos_abiertos: number; por_metodo: Array<{ metodo: string; monto: number }> } | null;
  comprobantes: {
    pendientes: number;
    errores: number;
    recientes: Array<{ numero: string; estado: string }>;
  } | null;
  deuda: {
    cuentas: number;
    total: number;
    mayores: Array<{ deudor: string; saldo: number; dias: number; comprobante: string | null }>;
  } | null;
  stock: {
    sin_stock: number;
    bajo_stock: number;
    criticos: Array<{ producto: string; almacen: string; stock: number; minimo: number }>;
  } | null;
  pedidos: { pendientes: number; pagados: number } | null;
}

export interface CorreoResumenDiarioArmado {
  asunto: string;
  html: string;
  texto: string;
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'];

function escapar(valor: string): string {
  return valor.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function soles(valor: number): string {
  const n = Number(valor) || 0;
  const [entero, decimales] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}S/ ${entero.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimales}`;
}

/** 'YYYY-MM-DD' → 'jueves 5 de noviembre de 2026' (sin pasar por la zona del servidor). */
export function fechaLarga(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const dia = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return `${DIAS[dia]} ${Number(m[3])} de ${MESES[Number(m[2]) - 1]} de ${m[1]}`;
}

function fechaCorta(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ymd;
}

/** Variación respecto de una referencia: «+12 %», «-8 %» o «sin referencia» si la referencia es 0. */
export function variacion(actual: number, referencia: number): { texto: string; signo: 1 | 0 | -1 | null } {
  if (!referencia) return { texto: 'sin referencia', signo: null };
  const pct = Math.round(((actual - referencia) / Math.abs(referencia)) * 100);
  return { texto: `${pct > 0 ? '+' : ''}${pct} %`, signo: pct > 0 ? 1 : pct < 0 ? -1 : 0 };
}

const NOMBRES_ESTADO: Record<string, string> = {
  pendiente: 'pendiente de envío',
  error: 'con error',
  RECHAZADO: 'rechazado por SUNAT',
  EXCEPCION: 'con excepción',
};

/** Texto llano del estado de un comprobante con problema. */
export function nombreEstadoComprobante(estado: string | null | undefined, estadoSunat: string | null | undefined): string {
  const sunat = String(estadoSunat ?? '').toUpperCase();
  if (sunat === 'RECHAZADO' || sunat === 'EXCEPCION') return NOMBRES_ESTADO[sunat];
  const e = String(estado ?? '').toLowerCase();
  return NOMBRES_ESTADO[e] ?? (e || 'sin estado');
}

const TD = `padding:6px 8px;border-bottom:1px solid ${LINEA};font-size:13px`;

function celda(contenido: string, derecha = false, color?: string): string {
  return `<td style="${TD}${derecha ? ';text-align:right;white-space:nowrap' : ''}${color ? `;color:${color}` : ''}">${contenido}</td>`;
}

function seccion(titulo: string, cuerpo: string): string {
  return (
    `<h2 style="margin:22px 0 6px;font-size:15px;color:${GRAFITO};border-bottom:2px solid ${ORO};padding-bottom:4px">${escapar(titulo)}</h2>` +
    cuerpo
  );
}

const SIN_DATO_HTML = `<p style="margin:6px 0;color:${GRIS};font-size:13px">No se pudo leer esta sección. Revísela en el panel.</p>`;

function tabla(cabeceras: string[], filas: string[], derechaDesde = 1): string {
  const cab = cabeceras
    .map((c, i) => `<th style="${TD};text-align:${i >= derechaDesde ? 'right' : 'left'};color:${GRIS};font-weight:600">${escapar(c)}</th>`)
    .join('');
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse"><tr>${cab}</tr>${filas.join('')}</table>`;
}

function colorVariacion(signo: 1 | 0 | -1 | null): string {
  return signo === 1 ? VERDE : signo === -1 ? ROJO : GRIS;
}

export function armarCorreoResumenDiario(d: DatosResumenDiario): CorreoResumenDiarioArmado {
  const t: string[] = [];
  const h: string[] = [];
  const titulo = `Resumen del día · ${fechaLarga(d.fecha)}`;
  const prefijo = d.esPrueba ? 'PRUEBA – ' : '';
  const ventasHoy = d.ventas ? soles(d.ventas.hoy.total) : 'sin dato';
  const asunto = `${prefijo}Resumen del ${fechaCorta(d.fecha)} – ${d.negocio} – Ventas ${ventasHoy}`;

  t.push(titulo.toUpperCase(), d.negocio);
  if (d.esPrueba) t.push('(Correo de prueba enviado desde Configuración. Los envíos automáticos llegan a la hora que usted eligió.)');

  // ── Ventas
  t.push('', 'VENTAS DEL DÍA');
  if (d.ventas) {
    const { hoy, ayer, semana_pasada: sp } = d.ventas;
    const vAyer = variacion(hoy.total, ayer.total);
    const vSem = variacion(hoy.total, sp.total);
    t.push(
      `Hoy: ${soles(hoy.total)} · ${hoy.ventas} comprobantes · ticket ${soles(hoy.ticket_promedio)}`,
      `Ayer: ${soles(ayer.total)} · ${ayer.ventas} comprobantes (${vAyer.texto})`,
      `Mismo día de la semana pasada (${fechaCorta(sp.fecha)}): ${soles(sp.total)} · ${sp.ventas} comprobantes (${vSem.texto})`,
    );
    const fila = (nombre: string, v: VentasDiaResumen, ref?: { texto: string; signo: 1 | 0 | -1 | null }) =>
      `<tr>${celda(escapar(nombre))}${celda(`<strong>${soles(v.total)}</strong>`, true)}${celda(String(v.ventas), true)}${celda(soles(v.ticket_promedio), true)}` +
      `${celda(ref ? escapar(ref.texto) : '', true, ref ? colorVariacion(ref.signo) : undefined)}</tr>`;
    h.push(
      seccion(
        'Ventas del día',
        tabla(
          ['', 'Ventas netas', 'Comprobantes', 'Ticket', 'Cambio de hoy'],
          [
            fila('Hoy', hoy),
            fila('Ayer', ayer, vAyer),
            fila(`Mismo día semana pasada (${fechaCorta(sp.fecha)})`, sp, vSem),
          ],
        ),
      ),
    );
  } else {
    t.push('No se pudo leer esta sección.');
    h.push(seccion('Ventas del día', SIN_DATO_HTML));
  }

  // ── Caja
  t.push('', 'COBROS DEL DÍA (CAJA)');
  if (d.caja) {
    if (d.caja.por_metodo.length === 0) {
      t.push('No hubo cobros registrados en caja.');
      h.push(seccion('Cobros del día (caja)', `<p style="margin:6px 0;color:${GRIS};font-size:13px">No hubo cobros registrados en caja.</p>`));
    } else {
      for (const m of d.caja.por_metodo) t.push(`${m.metodo}: ${soles(m.monto)}`);
      t.push(`Total: ${soles(d.caja.total)}${d.caja.turnos_abiertos ? ` · ${d.caja.turnos_abiertos} caja(s) sin cerrar` : ''}`);
      const filas = d.caja.por_metodo.map((m) => `<tr>${celda(escapar(m.metodo))}${celda(soles(m.monto), true)}</tr>`);
      filas.push(`<tr>${celda('<strong>Total</strong>')}${celda(`<strong>${soles(d.caja.total)}</strong>`, true)}</tr>`);
      const aviso = d.caja.turnos_abiertos
        ? `<p style="margin:6px 0;color:${ROJO};font-size:13px">${d.caja.turnos_abiertos} caja(s) siguen abiertas.</p>`
        : '';
      h.push(seccion('Cobros del día (caja)', tabla(['Medio de pago', 'Monto'], filas) + aviso));
    }
  } else {
    t.push('No se pudo leer esta sección.');
    h.push(seccion('Cobros del día (caja)', SIN_DATO_HTML));
  }

  // ── Comprobantes con problema
  t.push('', 'COMPROBANTES CON PROBLEMA');
  if (d.comprobantes) {
    const c = d.comprobantes;
    if (c.pendientes + c.errores === 0 && c.recientes.length === 0) {
      t.push('Ninguno. Todo en orden.');
      h.push(seccion('Comprobantes con problema', `<p style="margin:6px 0;color:${VERDE};font-size:13px">Ninguno. Todo en orden.</p>`));
    } else {
      t.push(`Pendientes de envío: ${c.pendientes} · Con error: ${c.errores}`);
      for (const r of c.recientes) t.push(`- ${r.numero}: ${r.estado}`);
      const lista = c.recientes.length
        ? tabla(
            ['Comprobante', 'Estado'],
            c.recientes.map((r) => `<tr>${celda(escapar(r.numero))}${celda(escapar(r.estado), true)}</tr>`),
          )
        : '';
      h.push(
        seccion(
          'Comprobantes con problema',
          `<p style="margin:6px 0;font-size:13px"><strong>${c.pendientes}</strong> pendientes de envío · <strong style="color:${c.errores ? ROJO : GRAFITO}">${c.errores}</strong> con error</p>` + lista,
        ),
      );
    }
  } else {
    t.push('No se pudo leer esta sección.');
    h.push(seccion('Comprobantes con problema', SIN_DATO_HTML));
  }

  // ── Deuda vencida
  t.push('', 'DEUDA VENCIDA');
  if (d.deuda) {
    if (d.deuda.cuentas === 0) {
      t.push('No hay deuda vencida.');
      h.push(seccion('Deuda vencida', `<p style="margin:6px 0;color:${VERDE};font-size:13px">No hay deuda vencida.</p>`));
    } else {
      t.push(`${d.deuda.cuentas} cuenta(s) vencida(s) por ${soles(d.deuda.total)}. Las mayores:`);
      for (const m of d.deuda.mayores) {
        t.push(`- ${m.deudor}: ${soles(m.saldo)} (hace ${m.dias} días${m.comprobante ? `, ${m.comprobante}` : ''})`);
      }
      h.push(
        seccion(
          'Deuda vencida',
          `<p style="margin:6px 0;font-size:13px"><strong style="color:${ROJO}">${soles(d.deuda.total)}</strong> en ${d.deuda.cuentas} cuenta(s) vencida(s)</p>` +
            tabla(
              ['Deudor', 'Saldo', 'Atraso'],
              d.deuda.mayores.map(
                (m) =>
                  `<tr>${celda(escapar(m.deudor) + (m.comprobante ? `<br><span style="color:${GRIS};font-size:12px">${escapar(m.comprobante)}</span>` : ''))}` +
                  `${celda(soles(m.saldo), true)}${celda(`${m.dias} días`, true)}</tr>`,
              ),
            ),
        ),
      );
    }
  } else {
    t.push('No se pudo leer esta sección.');
    h.push(seccion('Deuda vencida', SIN_DATO_HTML));
  }

  // ── Stock
  t.push('', 'STOCK CRÍTICO');
  if (d.stock) {
    const s = d.stock;
    if (s.sin_stock + s.bajo_stock === 0 && s.criticos.length === 0) {
      t.push('Sin alertas de stock.');
      h.push(seccion('Stock crítico', `<p style="margin:6px 0;color:${VERDE};font-size:13px">Sin alertas de stock.</p>`));
    } else {
      t.push(`Sin existencias: ${s.sin_stock} · Bajo el mínimo: ${s.bajo_stock}`);
      for (const p of s.criticos) t.push(`- ${p.producto} (${p.almacen}): ${p.stock} de mínimo ${p.minimo}`);
      h.push(
        seccion(
          'Stock crítico',
          `<p style="margin:6px 0;font-size:13px"><strong style="color:${s.sin_stock ? ROJO : GRAFITO}">${s.sin_stock}</strong> sin existencias · <strong>${s.bajo_stock}</strong> bajo el mínimo</p>` +
            (s.criticos.length
              ? tabla(
                  ['Producto', 'Stock', 'Mínimo'],
                  s.criticos.map(
                    (p) =>
                      `<tr>${celda(escapar(p.producto) + (p.almacen ? `<br><span style="color:${GRIS};font-size:12px">${escapar(p.almacen)}</span>` : ''))}` +
                      `${celda(String(p.stock), true, p.stock <= 0 ? ROJO : undefined)}${celda(String(p.minimo), true)}</tr>`,
                  ),
                )
              : ''),
        ),
      );
    }
  } else {
    t.push('No se pudo leer esta sección.');
    h.push(seccion('Stock crítico', SIN_DATO_HTML));
  }

  // ── Pedidos web
  t.push('', 'PEDIDOS DE LA TIENDA WEB');
  if (d.pedidos) {
    t.push(`Pendientes de pago: ${d.pedidos.pendientes} · Pagados por preparar: ${d.pedidos.pagados}`);
    h.push(
      seccion(
        'Pedidos de la tienda web',
        `<p style="margin:6px 0;font-size:13px"><strong>${d.pedidos.pendientes}</strong> pendientes de pago · <strong style="color:${d.pedidos.pagados ? ROJO : GRAFITO}">${d.pedidos.pagados}</strong> pagados por preparar</p>`,
      ),
    );
  } else {
    t.push('No se pudo leer esta sección.');
    h.push(seccion('Pedidos de la tienda web', SIN_DATO_HTML));
  }

  t.push('', `Generado por HatunSales. Puede cambiar la hora o apagar este correo en Configuración.`);

  const aviso = d.esPrueba
    ? `<p style="background:#fff3cd;border:1px solid #ffe08a;padding:8px 12px;font-size:13px;margin:0 0 12px"><strong>Correo de prueba.</strong> Enviado a mano desde Configuración.</p>`
    : '';
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;color:${GRAFITO};max-width:640px;margin:0 auto">` +
    `<div style="background:${GRAFITO};color:#ffffff;padding:16px 20px;border-bottom:4px solid ${ORO}">` +
    `<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${ORO}">Resumen diario</div>` +
    `<div style="font-size:19px;font-weight:bold;margin-top:2px">${escapar(fechaLarga(d.fecha))}</div>` +
    `<div style="font-size:13px;color:#d8d6cf;margin-top:2px">${escapar(d.negocio)}</div>` +
    `</div><div style="padding:14px 20px">${aviso}${h.join('')}` +
    `<p style="margin:24px 0 0;color:${GRIS};font-size:12px">Generado por HatunSales. Puede cambiar la hora o apagar este correo en Configuración.</p>` +
    `</div></div>`;

  return { asunto, html, texto: t.join('\n') };
}
