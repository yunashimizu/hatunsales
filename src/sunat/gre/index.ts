/**
 * API pública del motor de la GRE remitente (src/sunat/gre). El negocio de la guía (numeración,
 * persistencia, HTTP, PDF) inyecta `EmisionGre` y usa estos tipos; el resto es para specs y herramientas.
 */
export * from './gre.tipos';
export * from './gre.contrato';
export * from './catalogos-gre';
export { normalizarPlacaGre, validarDocumentoGre } from './validaciones-gre';
export type { OpcionesValidacionGre } from './validaciones-gre';
export { ConstructorGreUbl, ESPACIO_DESPATCH_ADVICE, nombreBaseGre } from './constructor-gre-ubl';
export type { ResultadoXmlGre } from './constructor-gre-ubl';
export { GreInvalidaError, PreparadorGre } from './preparador-gre';
export type { OpcionesPreparacionGre } from './preparador-gre';
export { clasificarConsultaGre, clasificarEnvioGre, consultaSinRespuesta, crudoParaAuditoria, envioSinRespuesta, redactarSecretosGre } from './clasificador-gre';
export type { MotivoSinRespuestaGre, RespuestaHttpLeidaGre } from './clasificador-gre';
export {
  ClienteRestGre,
  ErrorTokenGre,
  ErrorTransporteGre,
  exigirUrlPermitidaGre,
  HOSTS_PERMITIDOS_GRE,
  sanearErrorHttpGre,
  TransporteHttpGreAxios,
  urlConsultaGre,
  urlEnvioGre,
  urlTokenGre,
} from './gre-rest-client';
export type { ErrorHttpSaneado, OpcionesClienteRestGre, PeticionHttpGre, RespuestaHttpGre, TransporteHttpGre } from './gre-rest-client';
export { GreEmisionService } from './gre-emision.service';
