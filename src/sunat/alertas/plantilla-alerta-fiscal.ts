export interface AlertaParaCorreo {
  /** Tipo de alerta (sirve para no repetirla el mismo día). */
  tipo: string;
  titulo: string;
  detalle: string;
  /** Ruta del panel donde se resuelve (empieza con «/»). */
  ruta: string;
}

export interface CorreoAlerta {
  asunto: string;
  html: string;
  texto: string;
}

function escapar(texto: string): string {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Correo sencillo con la lista de alertas y un enlace al panel por cada una. `baseUrl` sin barra final ('' si no se conoce). */
export function armarCorreoAlerta(alertas: readonly AlertaParaCorreo[], baseUrl: string, nombreNegocio = 'HATUNSALES'): CorreoAlerta {
  const enlace = (a: AlertaParaCorreo) => (baseUrl ? `${baseUrl}${a.ruta}` : null);
  const asunto =
    alertas.length === 1
      ? `${nombreNegocio}: ${alertas[0].titulo}`
      : `${nombreNegocio}: ${alertas.length} avisos de facturación electrónica`;

  const filasHtml = alertas
    .map((a) => {
      const url = enlace(a);
      return `<li style="margin:0 0 14px"><strong>${escapar(a.titulo)}</strong><br>${escapar(a.detalle)}${
        url ? `<br><a href="${escapar(url)}">Abrir en el panel</a>` : ''
      }</li>`;
    })
    .join('');
  const html = `<!doctype html><html lang="es"><body style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:560px">
<h2 style="font-size:18px">Avisos de facturación electrónica</h2>
<p>Estas situaciones necesitan su atención:</p>
<ul style="padding-left:18px">${filasHtml}</ul>
<p style="color:#666;font-size:12px">Este aviso se envía una vez al día por cada situación. Puede cambiar el correo en Facturación SUNAT › Llave y alertas.</p>
</body></html>`;

  const texto = [
    'Avisos de facturación electrónica',
    '',
    ...alertas.flatMap((a) => [`- ${a.titulo}`, `  ${a.detalle}`, ...(enlace(a) ? [`  ${enlace(a)}`] : []), '']),
    'Este aviso se envía una vez al día por cada situación.',
  ].join('\n');

  return { asunto, html, texto };
}
