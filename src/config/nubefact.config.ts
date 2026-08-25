/**
 * Nubefact (comprobantes electrónicos).
 * Sin defaults en código: pegar NUBEFACT_URL y NUBEFACT_TOKEN en .env / Railway.
 */
export const nubefactConfig = {
  url: process.env.NUBEFACT_URL ?? '',
  token: process.env.NUBEFACT_TOKEN ?? '',
};

export function nubefactConfigurado(): boolean {
  return Boolean(nubefactConfig.url.trim() && nubefactConfig.token.trim());
}
