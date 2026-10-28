import { PALETA } from '../util/documentos/proforma-documento';

/** Datos que necesita el correo del comprobante (función pura: sin acceso a BD ni a red). */
export interface DatosPlantillaCorreo {
  tipoNombre: string;
  numeroFormateado: string;
  fechaEmision: string;
  total: number;
  simboloMoneda: string;
  monedaNombre: string;
  receptor: string | null;
  emisor: {
    razon_social: string;
    ruc: string;
    direccion?: string | null;
    telefono?: string | null;
    email?: string | null;
  };
  /** Comprobante emitido en el ambiente BETA de SUNAT (sin validez). */
  esBeta: boolean;
}

export interface CorreoComprobanteArmado {
  asunto: string;
  html: string;
  texto: string;
}

export const PREFIJO_BETA = 'PRUEBA SUNAT BETA – SIN VALIDEZ';

function escapar(valor: string): string {
  return valor.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function importe(simbolo: string, total: number): string {
  return `${simbolo} ${Number(total || 0).toFixed(2)}`;
}

export function armarCorreoComprobante(d: DatosPlantillaCorreo): CorreoComprobanteArmado {
  const titulo = `${d.tipoNombre} ${d.numeroFormateado}`;
  const asunto = `${d.esBeta ? `${PREFIJO_BETA} – ` : ''}${titulo} – ${d.emisor.razon_social}`;
  const saludo = d.receptor ? `Estimado(a) ${d.receptor}:` : 'Estimado(a) cliente:';
  const contacto = [d.emisor.direccion, d.emisor.telefono, d.emisor.email].filter((x): x is string => Boolean(x && x.trim()));

  const lineas = [
    saludo,
    '',
    `Adjuntamos su ${d.tipoNombre.toLowerCase()} electrónica ${d.numeroFormateado} (PDF) y el archivo XML firmado.`,
    '',
    `Número: ${d.numeroFormateado}`,
    `Fecha de emisión: ${d.fechaEmision}`,
    `Total: ${importe(d.simboloMoneda, d.total)} (${d.monedaNombre})`,
    '',
    `${d.emisor.razon_social} – RUC ${d.emisor.ruc}`,
    ...contacto,
  ];
  if (d.esBeta) lineas.unshift(`${PREFIJO_BETA}. Este documento se emitió en el ambiente de pruebas de SUNAT.`, '');
  const texto = lineas.join('\n');

  const filas = [
    ['Número', d.numeroFormateado],
    ['Fecha de emisión', d.fechaEmision],
    ['Total', `${importe(d.simboloMoneda, d.total)} (${d.monedaNombre})`],
  ]
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:${PALETA.gris}">${escapar(k)}</td><td style="padding:4px 0"><strong>${escapar(v)}</strong></td></tr>`)
    .join('');
  const aviso = d.esBeta
    ? `<p style="background:#fff3cd;border:1px solid #ffe08a;padding:8px 12px"><strong>${escapar(PREFIJO_BETA)}.</strong> Este documento se emitió en el ambiente de pruebas de SUNAT.</p>`
    : '';
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${PALETA.texto};max-width:560px">` +
    aviso +
    `<p>${escapar(saludo)}</p>` +
    `<p>Adjuntamos su ${escapar(d.tipoNombre.toLowerCase())} electrónica <strong>${escapar(d.numeroFormateado)}</strong> (PDF) y el archivo XML firmado.</p>` +
    `<table style="border-collapse:collapse">${filas}</table>` +
    `<p style="margin-top:20px;color:${PALETA.gris};font-size:12px">${escapar(d.emisor.razon_social)} – RUC ${escapar(d.emisor.ruc)}` +
    contacto.map((c) => `<br>${escapar(c)}`).join('') +
    `</p></div>`;

  return { asunto, html, texto };
}
