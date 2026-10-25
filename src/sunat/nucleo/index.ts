/**
 * API pública del núcleo fiscal SUNAT (puro: sin Nest ni base de datos).
 * Contrato completo con ejemplos: scratchpad/contratos/sunat-nucleo.md.
 */
export * from './documento-fiscal.types';
export * from './errores-nucleo';
export { DecimalExacto, Dinero, formatearDecimal, formatearMonto, redondear } from './decimal';
export * from './fechas-fiscales';
export * from './identificadores-cpe';
export { errorDocumentoIdentidad, esDniValido, esRucValido } from './documentos-identidad';
export * from './linea-cpe';
export * from './validaciones-cpe';
export * from './construir-xml-cpe';
export { importeEnLetras } from './ubl/constructor-ubl-cpe';
export * from './ubl/constructor-resumen-diario';
export * from './ubl/constructor-comunicacion-baja';
export * from './firma/firmador-xml';
export * from './firma/material-certificado';
export { firmarXmlDemo, MENSAJE_DEMO_EN_PRODUCCION } from './firma/firma-demo';
export * from './zip/paquete-zip';
export * from './cdr/lector-cdr';
export * from './cdr/verificar-cdr';
export * from './reglas-envio';
export * from './soap/endpoints-sunat';
export { construirSobreSoap, soapActionDe } from './soap/sobre-soap';
export type { CredencialesSoap, MetodoSoapSunat } from './soap/sobre-soap';
export { ErrorTransporteSoap, TransporteSoapAxios } from './soap/transporte-soap';
export type { PeticionSoap, RespuestaHttpSoap, TransporteSoap } from './soap/transporte-soap';
export * from './soap/sunat-soap-client';
export * from './clasificador-respuesta';
export * from './cadena-qr';
export * from './preparador-envio-cpe';
