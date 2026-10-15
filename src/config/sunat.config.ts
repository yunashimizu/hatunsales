/**
 * Consulta de DNI/RUC (ApiPeruDev) para autocompletar clientes en el POS.
 *
 * El token NO va en el código (estaba en el historial de git: rótelo en
 * apiperu.dev). Se toma, en este orden, de:
 *   1) las variables SUNAT_TOKEN, APIPERU_TOKEN, APISPERU_TOKEN o TOKEN_SUNAT (Railway);
 *   2) la clave `sunat_token` de la tabla configuraciones (la lee
 *      ConsultaDocumentoService cuando no hay variable, sin redeploy).
 * Si no hay ninguno, la consulta responde 503 «no está configurada» y el POS
 * permite escribir los datos a mano.
 */
const VARIABLES_TOKEN_APIPERU = ['SUNAT_TOKEN', 'APIPERU_TOKEN', 'APISPERU_TOKEN', 'TOKEN_SUNAT'] as const;

export function tokenApiPeruDeEntorno(env: NodeJS.ProcessEnv = process.env): string {
  for (const nombre of VARIABLES_TOKEN_APIPERU) {
    const valor = (env[nombre] ?? '').trim();
    if (valor) return valor;
  }
  return '';
}

export const sunatConfig = {
  token: tokenApiPeruDeEntorno(),
  dniUrl: process.env.SUNAT_DNI_URL ?? 'https://apiperu.dev/api/dni',
  rucUrl: process.env.SUNAT_RUC_URL ?? 'https://apiperu.dev/api/ruc',
};

// ApiPeruDev: POST + Authorization: Bearer <token>
// Body DNI: { "dni": "71739060" }
// Body RUC: { "ruc": "20131312955" }
