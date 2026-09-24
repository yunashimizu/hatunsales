import { formatearFecha, formatearSoles, formatearTelefono, textoPlano } from './proforma-documento';

/**
 * Mensaje de WhatsApp que acompaña a la proforma. Usa los mismos formatos que
 * el PDF y el Excel (S/ 1,234.50, dd/mm/aaaa) para que el cliente vea las mismas
 * cifras en el chat y en el documento.
 */

/** Líneas de productos que se listan antes de resumir el resto. */
export const ITEMS_EN_TEXTO_WA = 8;
const LARGO_MAXIMO_DESCRIPCION = 56;

export interface DatosTextoWhatsapp {
  razon_social: string;
  /** Teléfono de contacto del emisor (opcional; solo se menciona si existe). */
  telefono_emisor?: string | null;
  codigo: string;
  cliente_nombre?: string | null;
  /** True si el cliente es una empresa (RUC): cambia el saludo. */
  es_empresa?: boolean;
  /** Fecha AAAA-MM-DD. */
  valida_hasta?: string | null;
  items: Array<{
    descripcion?: string | null;
    cantidad: number;
    /** Importe de la línea con IGV. */
    subtotal?: number | null;
    precio_unitario?: number | null;
  }>;
  total: number;
}

/** WhatsApp da formato con *negrita*, _cursiva_ y ~tachado~: se quitan de los datos del cliente. */
function limpiar(valor: unknown): string {
  return textoPlano(valor).replace(/[*~]/g, '');
}

function recortar(texto: string, largo: number): string {
  return texto.length <= largo ? texto : `${texto.slice(0, largo - 1).trimEnd()}…`;
}

function saludo(d: DatosTextoWhatsapp): string {
  const nombre = limpiar(d.cliente_nombre);
  if (!nombre) return 'Estimado cliente:';
  return d.es_empresa ? `Estimados señores de ${nombre}:` : `Estimado(a) ${nombre}:`;
}

export function textoWhatsappProforma(d: DatosTextoWhatsapp): string {
  const emisor = limpiar(d.razon_social);
  const items = d.items ?? [];

  const lineas = items.slice(0, ITEMS_EN_TEXTO_WA).map((item) => {
    const importe =
      item.subtotal != null && Number.isFinite(Number(item.subtotal))
        ? Number(item.subtotal)
        : Number(item.precio_unitario ?? 0) * Number(item.cantidad ?? 0);
    const descripcion = recortar(limpiar(item.descripcion) || 'Producto', LARGO_MAXIMO_DESCRIPCION);
    return `• ${descripcion} × ${item.cantidad} — ${formatearSoles(importe)}`;
  });
  const restantes = items.length - ITEMS_EN_TEXTO_WA;
  if (restantes > 0) lineas.push(`… y ${restantes} ítem(s) más (ver detalle en el PDF)`);

  const valida = formatearFecha(d.valida_hasta ?? null);
  const telefono = formatearTelefono(d.telefono_emisor);

  const partes: string[] = [
    saludo(d),
    '',
    `Le saludamos de *${emisor}* y le compartimos la proforma *${limpiar(d.codigo)}*:`,
  ];
  if (lineas.length) partes.push('', ...lineas);
  partes.push('', `*TOTAL: ${formatearSoles(d.total)}* (IGV incluido)`);
  if (valida) partes.push(`Oferta válida hasta el ${valida}.`);
  partes.push(
    '',
    'El detalle completo va en el PDF adjunto.',
    telefono
      ? `Para confirmar su pedido, responda a este mensaje o llámenos al ${telefono}.`
      : 'Para confirmar su pedido, responda a este mensaje.',
  );
  return partes.join('\n');
}
