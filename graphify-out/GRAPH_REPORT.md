# Graph Report - hatunsales  (2026-11-06)

## Corpus Check
- 658 files · ~473,242 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 8 file(s) not represented in the graph (top: (none) 3, .example 1, .sqlite 1)

## Summary
- 7214 nodes · 22454 edges · 196 communities (148 shown, 48 thin omitted)
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 1441 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `0249c536`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- certificado-fiscal.service.ts
- PedidoBussnies
- CheckoutBussnies
- SunatEmisionService
- lotes-fiscales.service.ts
- auth.bussnies.ts
- AmbienteFiscal
- venta.repository.ts
- guia-remision.bussnies.ts
- comprobante-pdf.ts
- fiscal-config.tipos.ts
- gre-rest-client.ts
- comprobante.bussnies.ts
- GuiaRemisionBussnies
- ComprobanteBussnies
- venta-documentos.bussnies.ts
- NotaCreditoBussnies
- EjecutorSql
- CatalogoController
- @nestjs/common
- filasDe
- proforma-documento.ts
- caja-arqueo.bussnies.ts
- ClienteRepository
- @nestjs/typeorm
- certificado-digital.util.ts
- clasificador-gre.ts
- validaciones-cpe.ts
- validaciones-gre.ts
- UsuarioToken
- ref_crypto
- Carrito
- resumen-caja-pdf.ts
- CuentaTiendaBussnies
- linea-cpe.ts
- app.module.ts
- el
- lotes-fiscales.service.spec.ts
- nota-credito.bussnies.spec.ts
- constructor-resumen-diario.ts
- ProductoImagen
- caja-arqueo.repository.ts
- Dinero
- FiscalAdminController
- SunatBussnies
- proforma.bussnies.ts
- reportes.bussnies.ts
- AdminController
- sunat.catalogos.ts
- package.json
- Dinero
- guia-remision-pdf.ts
- axios
- fecha-lima.ts
- caja.request.ts
- VentaController
- relanzarHttp
- culqi.pasarela.ts
- RecepcionRepository
- nota-credito.bussnies.ts
- arqueo-pdf.ts
- salud.bussnies.ts
- logo-emisor.ts
- ConfiguracionRepository
- sunat-emision.service.spec.ts
- comprobante.repository.ts
- EnvioFiscalRepository
- ProformaController
- CarritoController
- guia-remision.response.ts
- ComprobanteController
- ComprobanteCorreosRepository
- documento-fiscal.types.ts
- registro-peticiones.middleware.ts
- dependencies
- filasDe
- FiscalConfigService
- lote-fiscal.repository.ts
- politica-limites.ts
- venta.bussnies.ts
- devDependencies
- GuardarGuiaRemisionRequest
- rol.bussnies.ts
- ProformaRepository
- enmascarar.ts
- runtime.config.ts
- DibujoProforma
- main.ts
- AlmacenLimitesMemoria
- reporte-ventas-pdf.ts
- sunat-soap-client.ts
- compilerOptions
- fiscal-errores.ts
- caja-turnos.bussnies.ts
- PedidoRepository
- StockSucursal
- Empresa
- ReceptorController
- Categoria
- CreditoRepository
- EmisionGre
- ProductoController
- clasificador-respuesta.ts
- plataforma.registro.ts
- tipos-comprobante.ts
- ProductoBussnies
- FiscalConfigError
- InventarioBussnies
- NotaCreditoController
- CajaTurnosBussnies
- registros.ts
- BuscarDniRequest
- RegistrarArqueoRequest
- correo-comprobante.service.ts
- ReceptorBussnies
- reporte-ventas-excel.ts
- reglas-postgres.ts
- CajaArqueoController
- InventarioRepository
- WhatsappPasarela
- pago.bussnies.ts
- carrito.bussnies.ts
- MarcaController
- correo.config.ts
- filtro-errores.filter.ts
- gre-emision.service.spec.ts
- AuthController
- InventarioController
- UserController
- listar-ventas.request.ts
- SunatController
- filtro-errores.filter.spec.ts
- caja.registro.ts
- mensajes-validacion.ts
- Sucursal
- loginController
- scripts
- qr.ts
- comprobante-correos.repository.ts
- PagoBussnies
- BuscarUbigeoRequest
- espacios-ubl.ts
- numero-letras.ts
- jest
- cifrado-fiscal.service.spec.ts
- ReportesController
- log-repository.ts
- EsquemaCajaService
- ProductoResponse
- escritor-xml.ts
- preparar-fiscal-local.cjs
- AppService
- GuiaRemisionController
- CatalogoRepository
- emision-directa.service.ts
- deploy
- README.md
- ConfiguracionFiscalBussnies
- codigo-barras.util.ts
- reportes.repository.ts
- traductor-errores-bd.ts
- RegistroTypeorm
- VentaTiendaRepository
- UbigeoService
- CertificadoFiscalRepository
- StorageService
- Inventario
- CarritoItem
- PedidoPago
- catalogo.response.ts
- ConsultaDocumentoService
- IRepository
- InventarioResponse
- nest-cli.json
- CreditoVencimientosTarea
- correo-comprobantes.tarea.ts
- Log
- CrearResenaRequest
- Cliente
- CatalogoBussnies
- RepositorioCertificadosMemoria
- compresion.ts
- proforma-documento.paleta.spec.ts
- tsconfig.build.json
- SecretosFiscalesRepository
- receptor.response.ts
- auth.response.ts
- login-response.ts
- pedido.bussnies.spec.ts
- eslint.config.mjs
- CatalogoQueryRequest
- correo-comprobante.service.spec.ts

## God Nodes (most connected - your core abstractions)
1. `@nestjs/common` - 243 edges
2. `Roles()` - 161 edges
3. `UsuarioToken` - 138 edges
4. `AmbienteFiscal` - 130 edges
5. `typeorm` - 126 edges
6. `FiscalConfigError` - 112 edges
7. `ComprobanteBussnies` - 104 edges
8. `UsuarioActual` - 86 edges
9. `FiscalConfigService` - 78 edges
10. `Cliente` - 76 edges

## Surprising Connections (you probably didn't know these)
- `Registrado` --references--> `DocumentoPreparado`  [EXTRACTED]
  src/bussnies/Bussnies/comprobante.bussnies.ts → src/sunat/emision/emision.contrato.ts
- `crear()` --calls--> `ConfiguracionFiscalBussnies`  [EXTRACTED]
  src/bussnies/Bussnies/configuracion-fiscal.bussnies.spec.ts → src/bussnies/Bussnies/configuracion-fiscal.bussnies.ts
- `SinValidez` --references--> `CabeceraComprobante`  [EXTRACTED]
  src/bussnies/Bussnies/nota-credito.bussnies.ts → src/repository/Repository/nota-credito.repository.ts
- `armar()` --calls--> `CarritoBussnies`  [EXTRACTED]
  src/bussnies/Bussnies/tienda/carrito.bussnies.spec.ts → src/bussnies/Bussnies/tienda/carrito.bussnies.ts
- `CuponAplicado` --references--> `Cupon`  [EXTRACTED]
  src/bussnies/Bussnies/tienda/checkout.bussnies.ts → src/models/DBModel/tienda/cupon.entity.ts

## Import Cycles
- None detected.

## Communities (196 total, 48 thin omitted)

### Community 0 - "certificado-fiscal.service.ts"
Cohesion: 0.04
Nodes (79): AccionAuditoriaFiscal, ACCIONES_AUDITORIA_FISCAL, FiscalAuditoriaRepository, FilaCertificadoFiscal, MetadatosCertificadoFiscal, VersionCertificadoFiscal, CertificadoFiscalService, EXTENSIONES_ACEPTADAS (+71 more)

### Community 1 - "PedidoBussnies"
Cohesion: 0.18
Nodes (3): PedidoBussnies, recortar(), PedidoResponse

### Community 2 - "CheckoutBussnies"
Cohesion: 0.07
Nodes (10): CheckoutController, PagoWebhookController, CheckoutBussnies, CuponAplicado, diaDe(), dos(), armar(), NOCHE_EN_LIMA (+2 more)

### Community 3 - "SunatEmisionService"
Cohesion: 0.12
Nodes (11): DocumentoPreparado, ResultadoEmision, CierreEnvio, EnvioRegistrado, aEnvio(), esAceptado(), mensajeDe(), resumen() (+3 more)

### Community 4 - "lotes-fiscales.service.ts"
Cohesion: 0.07
Nodes (48): adm-zip, MaterialCargado, MaterialFirma, CONDICION_ANULAR, LONGITUD_MAXIMA_MOTIVO_BAJA, EnvioVista, FiltroEnvios, TIPOS_ARCHIVO_ENVIO (+40 more)

### Community 5 - "auth.bussnies.ts"
Cohesion: 0.03
Nodes (34): class-validator, @nestjs/jwt, RolesAdminController, AuthBussnies, esCorreoDuplicado(), JwtPayload, armar(), tick() (+26 more)

### Community 6 - "AmbienteFiscal"
Cohesion: 0.04
Nodes (69): main(), FiscalAdminBussnies, ACTOR, crear(), OPCIONES_SUBIDA_CERTIFICADO, IFiscalAdminBussnies, RegistroAuditoriaFiscal, ArchivoCertificado (+61 more)

### Community 7 - "venta.repository.ts"
Cohesion: 0.04
Nodes (45): FilaInventarioBloqueada, LineaPorDespachar, planificarSalidas(), PlanSalida, SalidaStock, VentaHistorialFila, ProductoVentaResponse, booleano() (+37 more)

### Community 8 - "guia-remision.bussnies.ts"
Cohesion: 0.04
Nodes (47): campoFormularioGuia(), CAMPOS_FORMULARIO, cantidadTexto(), CODIGOS_YA_REGISTRADA, ContextoDocumento, DESCRIPCION_MODALIDAD, DESCRIPCION_MOTIVO, ESPERA_CONSULTA_INMEDIATA_MS (+39 more)

### Community 9 - "comprobante-pdf.ts"
Cohesion: 0.05
Nodes (54): Alineacion, AVISO_BETA_PDF, cantidad(), ClientePdfComprobante, COLOR, comoError(), conMiles(), conSon() (+46 more)

### Community 10 - "fiscal-config.tipos.ts"
Cohesion: 0.08
Nodes (46): SeriesPosResponse, DEFECTOS_PRUEBA, ACTOR_SISTEMA, AMBIENTES_FISCALES, BloqueoEmision, CLAVES_BLOQUEO_EMISION, CLAVES_CONFIG_FISCAL, CLAVES_CONFIRMACIONES_ACTIVACION (+38 more)

### Community 11 - "gre-rest-client.ts"
Cohesion: 0.05
Nodes (61): consultaSinRespuesta(), envioSinRespuesta(), MotivoSinRespuestaGre, RespuestaHttpLeidaGre, esperada, ESPACIO_DESPATCH_ADVICE, nombreBaseGre(), ResultadoXmlGre (+53 more)

### Community 12 - "comprobante.bussnies.ts"
Cohesion: 0.05
Nodes (42): AccionesComprobante, BaseRespuesta, ComprobantePreparado, EmisorConfigurado, EmisorDocumento, ESTADOS_ACEPTADO, ESTADOS_EN_CURSO, FORMA_MOTIVO_NOTA_CREDITO (+34 more)

### Community 13 - "GuiaRemisionBussnies"
Cohesion: 0.10
Nodes (14): conPlazo(), estadoDe(), GuiaRemisionBussnies, mensajeDe(), numeroFormateado(), pausa(), GuiaRemisionResponse, OperacionGuiaResponse (+6 more)

### Community 14 - "ComprobanteBussnies"
Cohesion: 0.05
Nodes (14): ComprobanteBussnies, banderas(), Comprobante, ComprobanteDetalleResponse, ComprobanteResponse, DatosFiscalesComprobante, FiltroComprobantes, fechaLima() (+6 more)

### Community 15 - "venta-documentos.bussnies.ts"
Cohesion: 0.07
Nodes (48): clasificarParaAnular(), motivoEmisionInactiva(), ResumenNotasOrigen, AccionesDetalle, estadoGuia(), ESTADOS_ACEPTADO, fechaLegible(), mensajeDe() (+40 more)

### Community 16 - "NotaCreditoBussnies"
Cohesion: 0.07
Nodes (20): esNotaEnCurso(), esNotaVigente(), NotaCreditoBussnies, EmisorNotasCredito, AnulacionVentaResponse, NotaAnulacionResponse, AnularVentaRequest, booleano() (+12 more)

### Community 17 - "EjecutorSql"
Cohesion: 0.05
Nodes (9): sanitizarDetalle(), RepositorioCertificadosFiscales, ConfigFiscalRepository, GestorCredencialesFiscalesService, EjecutorSql, BovedaSecretosFiscales, enmascararIdentificador(), validarClientIdGre() (+1 more)

### Community 19 - "@nestjs/common"
Cohesion: 0.06
Nodes (43): class-transformer, @nestjs/common, @nestjs/core, @nestjs/passport, @nestjs/swagger, @nestjs/testing, supertest, FORMATOS_PDF (+35 more)

### Community 20 - "filasDe"
Cohesion: 0.07
Nodes (29): aFila(), AlmacenSalidaGuia, archivosDe(), COLUMNAS_GUARDADO, DatosGuardarGuia, decimal(), entero(), EnvioGuiaEnCursoError (+21 more)

### Community 21 - "proforma-documento.ts"
Cohesion: 0.07
Nodes (65): argb(), avisoEstadoCliente(), condicionesComerciales(), contactoEmisor(), cuentasUtiles(), DatosProformaDocumento, describirCuenta(), describirCuentaTabla() (+57 more)

### Community 22 - "caja-arqueo.bussnies.ts"
Cohesion: 0.08
Nodes (47): ICajaArqueoBussniees, ResultadoPreparacionCierre, arqueoDetalleResponse(), arqueoResumenResponse(), CLAVES_RESERVADAS, codigoArqueo(), denominacionesValidas(), efectivoResponse() (+39 more)

### Community 23 - "ClienteRepository"
Cohesion: 0.06
Nodes (10): ClienteController, ClienteBussnies, armar(), IClienteBussniees, IBussniesCrud, ActualizarClienteRequest, CrearClienteRequest, ClienteResponse (+2 more)

### Community 24 - "@nestjs/typeorm"
Cohesion: 0.04
Nodes (30): @nestjs/typeorm, ETIQUETA_MOTIVO, traducirErrorStock(), ResultadoAsignacionCodigosSunat, Marca, Usuario, CANTIDAD_MAXIMA_OPERACION, MAX_ASIGNACIONES_CODIGO_SUNAT (+22 more)

### Community 25 - "certificado-digital.util.ts"
Cohesion: 0.09
Nodes (35): RFC-8017, node-forge, armarCertificado(), atributos(), buscarRuc(), CertificadoLeido, certificadoPublico(), decodificarValor() (+27 more)

### Community 26 - "clasificador-gre.ts"
Cohesion: 0.05
Nodes (86): @xmldom/xmldom, base(), clasificarConsultaGre(), clasificarEnvioGre(), codigoParaBuscar(), CODIGOS_CONFIGURACION, CODIGOS_YA_REGISTRADA, comoObjeto() (+78 more)

### Community 27 - "validaciones-cpe.ts"
Cohesion: 0.12
Nodes (28): esAfectacionGratuita(), esAfectacionOnerosa(), esMotivoNotaDebito(), CuotaCpe, LineaCpe, ResultadoValidacionCpe, AcumuladorValidacion, ContextoValidacionCpe (+20 more)

### Community 28 - "validaciones-gre.ts"
Cohesion: 0.06
Nodes (65): DefectosGuardado, CATALOGO_06_TIPOS_VALIDOS, CATALOGO_18_MODALIDAD_TRASLADO, CATALOGO_20_MOTIVOS_TRASLADO, CATALOGO_61_DOCUMENTOS_RELACIONADOS, DOCUMENTOS_RELACIONADOS_CON_SERIE, ID_ENVIO_GRE, MAXIMO_CONDUCTORES_GRE (+57 more)

### Community 29 - "UsuarioToken"
Cohesion: 0.08
Nodes (6): CajaSesionController, CuentaTiendaController, PedidoAdminController, PedidoController, UsuarioActual, UsuarioToken

### Community 30 - "ref_crypto"
Cohesion: 0.06
Nodes (21): @nestjs/platform-express, ArchivoController, opcionesSubida, ErroresSubidaImagenInterceptor, MAXIMO_FOTOS_POR_LOTE, comoNest, traducirErrorSubidaImagen(), ArchivoSubido (+13 more)

### Community 31 - "Carrito"
Cohesion: 0.11
Nodes (5): CarritoBussnies, carritoVacio(), esViolacionUnica(), Carrito, CarritoRepository

### Community 32 - "resumen-caja-pdf.ts"
Cohesion: 0.13
Nodes (15): dibujarFranjaMarca(), LienzoPdf, Alineacion, COLOR, DibujoResumenCaja, EmisorResumenCajaPdf, Fuente, generarResumenCajaPdf() (+7 more)

### Community 34 - "linea-cpe.ts"
Cohesion: 0.16
Nodes (19): afectacionDesdeTipoIgv(), crearDocumentoPruebaBeta(), crearDocumentoPruebaUnidades(), serieBetaDe(), serieDePrueba(), AHORA, EMISOR, NUEVOS (+11 more)

### Community 35 - "app.module.ts"
Cohesion: 0.03
Nodes (31): typeorm, CANCELABLE_POR_CLIENTE, FLUJO_ESTADOS, OpcionSsl, postgresConfig, postgresEntities, DataSourceSinConexion, Registrador (+23 more)

### Community 36 - "el"
Cohesion: 0.15
Nodes (12): ConstructorGreUbl, texto(), formatearDecimal(), MonedaCpe, identificadorCpe(), nombreArchivoResumen(), ConstructorComunicacionBajaUbl, ConstructorResumenDiarioUbl (+4 more)

### Community 37 - "lotes-fiscales.service.spec.ts"
Cohesion: 0.08
Nodes (22): EfectosNotasTarea, montar(), CabeceraBaja, ESTADOS_LOTE_ABIERTOS, RegistroLoteNuevo, ESPERA_TICKET_MINUTOS, MAXIMO_CONSULTAS_TICKET, CDR_ACEPTADO (+14 more)

### Community 38 - "nota-credito.bussnies.spec.ts"
Cohesion: 0.08
Nodes (45): MAXIMO_INTENTOS_NUMERO, cpe(), crear(), envio(), fila(), fiscal(), generarPdf, motorConOrigen() (+37 more)

### Community 39 - "constructor-resumen-diario.ts"
Cohesion: 0.09
Nodes (31): PLAZOS_ENVIO_DIAS, hoyDeReferencia(), aMilisegundosUtc(), compactarFecha(), diasEntre(), esFechaIso(), esHoraValida(), formatoFechaLima (+23 more)

### Community 40 - "ProductoImagen"
Cohesion: 0.07
Nodes (6): ProductoImagenController, ProductoImagenBussnies, armar(), armarSubidas(), ProductoImagen, ProductoImagenRepository

### Community 41 - "caja-arqueo.repository.ts"
Cohesion: 0.09
Nodes (11): OpcionesSqlEsperado, sqlEsperadoTurno(), LineaConteo, FilaFuenteCaja, FuenteCaja, ICajaArqueoRepository, MovimientoGuardado, NuevoArqueo (+3 more)

### Community 42 - "Dinero"
Cohesion: 0.08
Nodes (9): DecimalExacto, Dinero, dividirRedondeando(), formatearMonto(), potencia10(), potenciasDe10, redondear(), valorAbsoluto() (+1 more)

### Community 43 - "FiscalAdminController"
Cohesion: 0.11
Nodes (3): actorDe(), FiscalAdminController, EnviosAdminController

### Community 45 - "proforma.bussnies.ts"
Cohesion: 0.09
Nodes (20): ConfigEmisor, CUENTAS_DOCUMENTO_POR_DEFECTO, DocumentoProforma, ProformaBussnies, IProformaBussniees, CLAVE_CONDICIONES_PROFORMA, CLAVES_EMISOR, CLAVES_SERIES (+12 more)

### Community 46 - "reportes.bussnies.ts"
Cohesion: 0.08
Nodes (32): exceljs, ClaseReporte, clasificarComprobanteReporte(), ComprobanteReporte, DetalleReporteVentas, diaLimaComprobante(), idTipoDe(), MESES_CORTOS (+24 more)

### Community 47 - "AdminController"
Cohesion: 0.05
Nodes (6): AdminController, AdminBussnies, ActualizarEmpleadoRequest, CambiarRolRequest, CrearEmpleadoRequest, EliminarUsuarioRequest

### Community 48 - "sunat.catalogos.ts"
Cohesion: 0.04
Nodes (60): motivosDisponibles(), CatalogoMotivosResponse, AFECTACIONES_GRATUITAS, AFECTACIONES_ONEROSAS, AfectacionIgv, ALIAS_UNIDADES, ATRIBUTOS_CATALOGO_01, CATALOGO_01_BOLETA (+52 more)

### Community 49 - "package.json"
Cohesion: 0.05
Nodes (43): author, description, license, name, private, version, @anthropic-ai/sdk, bcrypt (+35 more)

### Community 50 - "Dinero"
Cohesion: 0.07
Nodes (9): buscarDenominacion(), ConteoDenominacionEntrada, ConteoEfectivo, Denominacion, DENOMINACIONES_PEN, leerValor(), TipoDenominacion, Dinero (+1 more)

### Community 51 - "guia-remision-pdf.ts"
Cohesion: 0.11
Nodes (19): pdfkit, cantidad(), COLOR, DatosGuiaRemisionPdf, DibujoGuia, fecha(), Fila, generarGuiaRemisionPdf() (+11 more)

### Community 52 - "axios"
Cohesion: 0.20
Nodes (14): axios, config, mensaje, post, URL_BREVO, ErrorEnvioCorreo, MensajeCorreo, ResultadoEnvioCorreo (+6 more)

### Community 53 - "fecha-lima.ts"
Cohesion: 0.13
Nodes (35): aFechaLima(), cuatro(), DESFASE_LIMA_MINUTOS, diasEntreYmd(), dos(), fechaHoraLimaLegible(), FechaLimaInvalidaError, FiltroFechasLima (+27 more)

### Community 54 - "caja.request.ts"
Cohesion: 0.07
Nodes (11): CajaPagosController, AbrirCajaRequest, ActualizarCuentaBancariaRequest, AperturasCajaQuery, CerrarCajaRequest, CuentaBancariaRequest, IniciarYapeRequest, MovimientoCajaRequest (+3 more)

### Community 56 - "relanzarHttp"
Cohesion: 0.13
Nodes (8): CajaArqueoBussnies, esAdmin(), movimientoResponse(), turnoResponse(), relanzarHttp(), ArqueoGuardado, TurnoArqueo, CajaArqueoRepository

### Community 57 - "culqi.pasarela.ts"
Cohesion: 0.09
Nodes (15): ENTORNO_ORIGINAL, escenario(), Estado, pasarelaConfig, esProduccion(), CulqiPasarela, EventoWebhook, PASARELA_PAGO (+7 more)

### Community 58 - "RecepcionRepository"
Cohesion: 0.04
Nodes (8): ProveedorController, RecepcionController, RecepcionBussnies, armar(), tick(), RecepcionRepository, armar(), fila

### Community 59 - "nota-credito.bussnies.ts"
Cohesion: 0.06
Nodes (43): AVISO_MOTIVO, buscarAcreditable(), calcularAcreditable(), centesimas(), centimos(), ClaseAnulacion, CODIGOS_BAJA_CONFLICTO, conDosDecimales() (+35 more)

### Community 60 - "arqueo-pdf.ts"
Cohesion: 0.16
Nodes (16): Alineacion, COLOR, colorEstado(), DatosArqueoPdf, DibujoArqueo, EmisorArqueoPdf, etiquetaEstado(), fecha() (+8 more)

### Community 61 - "salud.bussnies.ts"
Cohesion: 0.10
Nodes (10): SaludController, CACHE_PING_MS, SaludBussnies, TIEMPO_MAXIMO_PING_MS, ISaludBussniees, EstadoPingBd, ResultadoPingBd, SaludResponse (+2 more)

### Community 62 - "logo-emisor.ts"
Cohesion: 0.09
Nodes (28): LOGO_EMISOR_OFICIAL, logoPrueba(), cache, codificarPng(), crc32(), dimensionesImagen(), esJpeg(), esPng() (+20 more)

### Community 63 - "ConfiguracionRepository"
Cohesion: 0.07
Nodes (7): CajaSesionBussnies, montoInicialDeApertura(), armar(), usuario, CajaSesionRepository, ConfiguracionRepository, repositorio()

### Community 64 - "sunat-emision.service.spec.ts"
Cohesion: 0.13
Nodes (19): NUMERO_PRUEBA_CREDENCIALES, ABIERTOS, cdrDe(), certificado, crear(), CREDENCIALES_PRODUCCION, EnviosMemoria, material (+11 more)

### Community 65 - "comprobante.repository.ts"
Cohesion: 0.07
Nodes (23): PlanRegistro, COLUMNAS_EFECTOS_NOTA, COLUMNAS_NOTA, COLUMNAS_OPCIONALES, ComprobanteRepository, ComprobanteVigenteVenta, Consultor, DatosListadoComprobante (+15 more)

### Community 66 - "EnvioFiscalRepository"
Cohesion: 0.06
Nodes (24): restriccionUnica(), sha256(), consultorFalso(), crear(), Llamada, LOTE, RESPUESTAS_REGISTRO, ConsultorTx (+16 more)

### Community 67 - "ProformaController"
Cohesion: 0.10
Nodes (5): ProformaController, CrearProformaRequest, EnviarCotizacionWaRequest, MarcarProformaRequest, ProformaItemRequest

### Community 68 - "CarritoController"
Cohesion: 0.14
Nodes (4): CarritoController, ActualizarItemCarritoRequest, AgregarItemCarritoRequest, FusionarCarritoRequest

### Community 69 - "guia-remision.response.ts"
Cohesion: 0.10
Nodes (18): EstadoGuia, AccionesGuiaResponse, ConductorGuiaResponse, ContextoVentaGuiaResponse, DocumentoRelacionadoGuiaResponse, EnvioGuiaResponse, GuiaRemisionItemResponse, GuiaRemisionResumenResponse (+10 more)

### Community 71 - "ComprobanteCorreosRepository"
Cohesion: 0.11
Nodes (3): ComprobanteCorreosRepository, CorreoFila, CorreoComprobanteService

### Community 72 - "documento-fiscal.types.ts"
Cohesion: 0.05
Nodes (62): esConsumidorFinal(), boleta(), factura(), construirCadenaQr(), TIPOS_QR, documentoConCaracteresEspeciales(), construirXmlCpe(), construirXmlCpeValidado() (+54 more)

### Community 73 - "registro-peticiones.middleware.ts"
Cohesion: 0.17
Nodes (8): CABECERA_ID_PETICION, Cabeceras, ContextoPeticion, DatosPeticion, crearMiddlewareRegistroPeticiones(), MARCA_ERROR_REGISTRADO, OpcionesRegistroPeticiones, rutaParaLog()

### Community 74 - "dependencies"
Cohesion: 0.06
Nodes (33): dependencies, adm-zip, @anthropic-ai/sdk, axios, bcrypt, better-sqlite3, class-transformer, class-validator (+25 more)

### Community 75 - "filasDe"
Cohesion: 0.16
Nodes (9): filasDe(), ESTADOS_CXC, LineaCredito, MetodoPagoActivo, LineaRecepcionInput, NuevaRecepcion, ObservacionCreada, RecepcionRegistrada (+1 more)

### Community 76 - "FiscalConfigService"
Cohesion: 0.05
Nodes (9): CertificadoParaChecklist, HechosPreparacion, ResultadoPreparacion, FiscalConfigService, SnapshotConfigFiscal, ProductosSinCodigoSunatRepository, SaludFiscalService, construirVistaConfigFiscal() (+1 more)

### Community 77 - "lote-fiscal.repository.ts"
Cohesion: 0.05
Nodes (36): aLinea(), aLote(), ambienteDe(), aVista(), efectoDelCierre(), ESTADOS_COMPROBANTE_ACEPTADO, iso(), LineaLoteNueva (+28 more)

### Community 78 - "politica-limites.ts"
Cohesion: 0.10
Nodes (20): ConsumoLimite, claveIp(), coincide(), ConfigLimites, ConsumoCubeta, correoDe(), CUALQUIERA, ESCRITURAS (+12 more)

### Community 79 - "venta.bussnies.ts"
Cohesion: 0.04
Nodes (48): aceptarNota(), EMISOR, eventoAceptado(), facturaAceptada(), LineaOrigen, marcarAceptado(), SERIES, venta() (+40 more)

### Community 80 - "devDependencies"
Cohesion: 0.06
Nodes (31): devDependencies, eslint, eslint-config-prettier, @eslint/eslintrc, @eslint/js, eslint-plugin-prettier, globals, jest (+23 more)

### Community 81 - "GuardarGuiaRemisionRequest"
Cohesion: 0.09
Nodes (21): IGuiaRemisionBussniees, AnularGuiaRemisionRequest, CODIGOS_UNIDAD, ConductorGuiaRequest, DestinatarioGuiaRequest, ESTADOS_GUIA, GuardarGuiaRemisionRequest, ItemGuiaRequest (+13 more)

### Community 82 - "rol.bussnies.ts"
Cohesion: 0.10
Nodes (5): RolController, RolBussnies, ROLES_PROTEGIDOS, ActualizarRolRequest, CrearRolRequest

### Community 83 - "ProformaRepository"
Cohesion: 0.10
Nodes (9): Proforma, codigoErrorBd(), codigoProforma(), detalleBd(), esChoqueDeCodigo(), esChoqueDePk(), ProformaRepository, restriccionBd() (+1 more)

### Community 84 - "enmascarar.ts"
Cohesion: 0.24
Nodes (10): decodificarSeguro(), enmascararDatosPersonales(), enmascararTexto(), LARGO_MAXIMO_RUTA, LARGO_MAXIMO_SQL, recortar(), rutaSegura(), sqlSeguro() (+2 more)

### Community 85 - "runtime.config.ts"
Cohesion: 0.12
Nodes (17): nombreAplicacionBd(), opcionesComunes(), opcionesPoolPostgres(), opcionesSsl(), postgresDesdeEnv(), FALSOS, LimitesNumericos, numeroEntorno() (+9 more)

### Community 86 - "DibujoProforma"
Cohesion: 0.23
Nodes (3): DibujoProforma, generarProformaPdf(), PDFDocument

### Community 87 - "main.ts"
Cohesion: 0.13
Nodes (22): postgresConfigurado(), JWT_DEFAULT_DEV, booleanoEntorno(), bootstrap(), montarSwagger(), validarEntornoProduccion(), crearMiddlewareCabecerasSeguridad(), OpcionesCabecerasSeguridad (+14 more)

### Community 89 - "reporte-ventas-pdf.ts"
Cohesion: 0.16
Nodes (26): ABREVIATURA_TIPO, Alineacion, cantidad(), COLOR, ColumnaPdf, entero(), Fuente, generarReporteVentasPdf() (+18 more)

### Community 90 - "sunat-soap-client.ts"
Cohesion: 0.06
Nodes (47): ConfiguracionSoapInvalidaError, ENDPOINTS_SUNAT, endpointsSunat, esEndpointProduccion(), HOSTS_PRODUCCION_SUNAT, DESCRIPCIONES_CONSULTA_SUNAT, estadoDeConsulta(), ESTADOS_CONSULTA_SUNAT (+39 more)

### Community 91 - "compilerOptions"
Cohesion: 0.07
Nodes (26): compilerOptions, allowSyntheticDefaultImports, declaration, emitDecoratorMetadata, esModuleInterop, experimentalDecorators, forceConsistentCasingInFileNames, ignoreDeprecations (+18 more)

### Community 92 - "fiscal-errores.ts"
Cohesion: 0.06
Nodes (12): CAMPOS_RESERVADOS, CodigoFiscal, CODIGOS_FISCALES_EMISION, ESTADO_HTTP, LotesAdminController, ListarLotesDto, Transformacion, descargaDeEnvio() (+4 more)

### Community 93 - "caja-turnos.bussnies.ts"
Cohesion: 0.08
Nodes (30): MONTO_INICIAL_MAXIMO, AperturaListada, ConsultaAperturas, ConsultaResumen, ResumenSucursal, CodigoErrorCaja, CodigoErrorCajaTipo, cuerpoErrorCaja() (+22 more)

### Community 94 - "PedidoRepository"
Cohesion: 0.13
Nodes (3): codigoPedido(), codigoProvisional(), PedidoRepository

### Community 95 - "StockSucursal"
Cohesion: 0.08
Nodes (3): StockSucursalController, StockSucursalBussnies, StockSucursal

### Community 99 - "CreditoRepository"
Cohesion: 0.06
Nodes (5): CreditoController, CreditoBussnies, AbonoCreditoRequest, LineaCreditoRequest, CreditoRepository

### Community 100 - "EmisionGre"
Cohesion: 0.15
Nodes (3): GreTicketsTarea, montar(), EmisionGre

### Community 101 - "ProductoController"
Cohesion: 0.12
Nodes (3): ProductoController, AsignarCodigosSunatRequest, UnidadAmigable

### Community 102 - "clasificador-respuesta.ts"
Cohesion: 0.12
Nodes (27): clasificadorPorOmision, ClasificadorRespuestaSunat, clasificarRespuesta(), CODIGOS_BAJA_FUERA_DE_PLAZO, CODIGOS_CERTIFICADO, CODIGOS_CREDENCIAL_SOL, CODIGOS_DOCUMENTO_ALTERADO, CODIGOS_EMISOR_NO_HABILITADO (+19 more)

### Community 103 - "plataforma.registro.ts"
Cohesion: 0.14
Nodes (8): LimitePeticionesGuard, AlmacenLimites, Contador, ResultadoLimite, CODIGO_DEMASIADAS_SOLICITUDES, DemasiadasPeticionesException, ALMACEN_LIMITES, PROVEEDORES_LIMITE_PETICIONES

### Community 104 - "tipos-comprobante.ts"
Cohesion: 0.11
Nodes (17): ymdLegible(), NOMBRE_TIPO, TIPO_BOLETA, TIPO_DOC_DNI, TIPO_DOC_RUC, TIPO_NOTA_DEBITO, TIPO_SUNAT, TipoCatalogo01 (+9 more)

### Community 106 - "FiscalConfigError"
Cohesion: 0.06
Nodes (64): EventoAuditoriaFiscal, BITS_MINIMOS_SUNAT, BITS_RECOMENDADOS, InfoCertificado, advertenciasCertificado(), ContextoInfoCertificado, describirCertificado(), ContextoValidacionCertificado (+56 more)

### Community 107 - "InventarioBussnies"
Cohesion: 0.15
Nodes (4): InventarioBussnies, ActualizarInventarioRequest, AjustarStockRequest, TransferirStockRequest

### Community 109 - "CajaTurnosBussnies"
Cohesion: 0.08
Nodes (17): admin, armar(), cajero, filasEfectivo140, turno(), admin, armar(), cajero (+9 more)

### Community 110 - "registros.ts"
Cohesion: 0.20
Nodes (11): REGISTRO_CAJA, REGISTRO_CORREO, REGISTRO_GUIAS, REGISTRO_NOTAS_CREDITO, REGISTRO_PLATAFORMA, RegistroModulo, unirRegistros(), REGISTROS (+3 more)

### Community 111 - "BuscarDniRequest"
Cohesion: 0.25
Nodes (6): ISunatBussniees, BuscarDniRequest, BuscarRucEmpresaRequest, BuscarRucProveedorRequest, DniResponse, RucResponse

### Community 112 - "RegistrarArqueoRequest"
Cohesion: 0.19
Nodes (6): MAX_CANTIDAD_POR_DENOMINACION, DenominacionArqueoRequest, MedioDeclaradoRequest, PdfArqueoQuery, RegistrarArqueoRequest, TurnoQuery

### Community 113 - "correo-comprobante.service.ts"
Cohesion: 0.16
Nodes (14): CLAVE_CORREO_ENVIO_ACTIVO, DetalleParaCorreo, EstadoCorreoDetalle, ESTADOS_ACEPTADOS, ResultadoProceso, ResumenCorreoComprobante, AdjuntoCorreo, armarCorreoComprobante() (+6 more)

### Community 115 - "reporte-ventas-excel.ts"
Cohesion: 0.18
Nodes (20): aFecha(), agregarHoja(), agregarResumen(), ARGB, bloqueTitulo(), bordeFino, bordes, cabeceraTabla() (+12 more)

### Community 116 - "reglas-postgres.ts"
Cohesion: 0.13
Nodes (15): BD_NO_DISPONIBLE, campo(), claveForanea(), columnasDeDetalle(), DATO_INVALIDO, duplicado(), ESQUEMA_PENDIENTE, Fabrica (+7 more)

### Community 118 - "InventarioRepository"
Cohesion: 0.12
Nodes (3): InventarioRepository, armar(), fila

### Community 119 - "WhatsappPasarela"
Cohesion: 0.19
Nodes (6): armar(), armarCreacion(), whatsappCloudListo(), whatsappConfig, ResultadoEnvioWa, WhatsappPasarela

### Community 120 - "pago.bussnies.ts"
Cohesion: 0.09
Nodes (15): UsuarioAutenticado, CambiarEstadoPedidoRequest, CrearPedidoRequest, RegistrarPagoRequest, PedidoEstadoResponse, PedidoItemResponse, FUENTE_CATALOGO, OpcionesBusqueda (+7 more)

### Community 121 - "carrito.bussnies.ts"
Cohesion: 0.16
Nodes (10): CarritoItemTienda, CarritoTienda, centavos(), ContextoCarrito, armar(), VACIO, TASA_IGV, CarritoItemResponse (+2 more)

### Community 123 - "correo.config.ts"
Cohesion: 0.26
Nodes (11): ConfigCorreo, correoValido(), Entorno, fabricarEnviador(), leerConfigCorreo(), ProveedorCorreo, texto(), EnviadorArchivo (+3 more)

### Community 124 - "filtro-errores.filter.ts"
Cohesion: 0.10
Nodes (38): CAMPOS_RESERVADOS, ErrorConCodigo, esErrorConCodigo(), esObjetoPlano(), estadoDeclarado(), sinCamposReservados(), ErrorTraducido, NivelRegistro (+30 more)

### Community 125 - "gre-emision.service.spec.ts"
Cohesion: 0.13
Nodes (21): Cambios, CERTIFICADO, certificadoInfo(), crear(), CREDENCIALES, snapshot(), GreInvalidaError, aplicar() (+13 more)

### Community 128 - "UserController"
Cohesion: 0.11
Nodes (4): UserController, UserService, UserRequest, UserMapper

### Community 129 - "listar-ventas.request.ts"
Cohesion: 0.18
Nodes (9): diaLima(), ESTADOS_VENTA, ListarVentasRequest, ListarVentasSinComprobanteRequest, noAntesDeDesde(), OPCIONES_TIENE_COMPROBANTE, PaginaVentasRequest, recortar() (+1 more)

### Community 131 - "filtro-errores.filter.spec.ts"
Cohesion: 0.16
Nodes (6): ErrorDominio, EsquemaPendienteError, consultaFallida(), ejecutar(), errorPg(), RespuestaFalsa

### Community 133 - "mensajes-validacion.ts"
Cohesion: 0.12
Nodes (13): aplanarErroresValidacion(), CODIGO_VALIDACION, cuerpoErrorValidacion, ErrorDeCampo, etiquetaCampo(), legible(), PREDICADOS, LineaDto (+5 more)

### Community 134 - "Sucursal"
Cohesion: 0.06
Nodes (4): AlmacenController, Almacen, MovimientoInventario, Sucursal

### Community 136 - "scripts"
Cohesion: 0.14
Nodes (14): scripts, build, fiscal:preparar-local, format, lint, start, start:debug, start:dev (+6 more)

### Community 137 - "qr.ts"
Cohesion: 0.22
Nodes (11): qrcode, codificarQrPng(), CORRECCIONES, CorreccionQr, crc32(), generarQrPng(), OpcionesQrPng, leerModulos() (+3 more)

### Community 138 - "comprobante-correos.repository.ts"
Cohesion: 0.27
Nodes (8): DIAS_SIEMBRA_CORREO, EstadoCorreo, OrigenCorreo, SEGUNDOS_RECLAMO_CORREO, consultorFalso(), crear(), Llamada, TIPO_FACTURA

### Community 141 - "espacios-ubl.ts"
Cohesion: 0.19
Nodes (10): FirmaDemoNoPermitidaError, firmarXmlDemo(), MENSAJE_DEMO_EN_PRODUCCION, OpcionesFirmaDemo, ID_FIRMA_UBL, ID_SIGNATURE_XMLDSIG, PATRON_RAIZ_DOCUMENTO_SUNAT, RAICES_DOCUMENTO_SUNAT (+2 more)

### Community 142 - "numero-letras.ts"
Cohesion: 0.26
Nodes (12): apocopar(), CENTENAS, centenasALetras(), DECENAS, decenasALetras(), enteroALetras(), grupoALetras(), hastaMillonALetras() (+4 more)

### Community 143 - "jest"
Cohesion: 0.17
Nodes (12): jest, collectCoverageFrom, coverageDirectory, maxWorkers, moduleFileExtensions, moduleNameMapper, rootDir, testEnvironment (+4 more)

### Community 144 - "cifrado-fiscal.service.spec.ts"
Cohesion: 0.17
Nodes (6): LLAVE, OTRA, AYUDA_LLAVE_MAESTRA, interpretarLlaveMaestra(), LARGO_LLAVE_MAESTRA, LlaveInterpretada

### Community 146 - "log-repository.ts"
Cohesion: 0.08
Nodes (10): LogController, LogBussnies, SCRIPT_TABLA_AUDITORIA, ILogBussniees, Auditoria, RegistroLogResponse, ILogRepository, esTablaInexistente() (+2 more)

### Community 147 - "EsquemaCajaService"
Cohesion: 0.10
Nodes (9): EsquemaCajaService, SnapshotEsquema, snapshot(), MetaSesion, apertura, armar(), armarCaja(), snapshot() (+1 more)

### Community 148 - "ProductoResponse"
Cohesion: 0.16
Nodes (5): IProductoBussniees, ActualizarProductoRequest, AsignacionCodigoSunat, CrearProductoRequest, ProductoResponse

### Community 149 - "escritor-xml.ts"
Cohesion: 0.23
Nodes (6): aplanar(), escaparXml(), EscritorXml, limpiarTextoXml(), OpcionesSerializacion, ValorAtributoXml

### Community 150 - "preparar-fiscal-local.cjs"
Cohesion: 0.18
Nodes (6): archivoLlave, dotenv, fs, path, raiz, { randomBytes, X509Certificate }

### Community 153 - "CatalogoRepository"
Cohesion: 0.13
Nodes (5): ProductoDetalleResponse, CatalogoRepository, patronContiene(), armar(), FILTROS

### Community 154 - "emision-directa.service.ts"
Cohesion: 0.03
Nodes (32): rxjs, conGuiaGuardada(), tokenApiPeruDeEntorno(), ErroresFiscalesInterceptor, traducirErrorFiscal(), DiagnosticoArranqueFiscal, aHttp(), defectosDesdeEntorno() (+24 more)

### Community 155 - "deploy"
Cohesion: 0.20
Nodes (9): build, buildCommand, deploy, healthcheckPath, healthcheckTimeout, restartPolicyMaxRetries, restartPolicyType, startCommand (+1 more)

### Community 156 - "README.md"
Cohesion: 0.20
Nodes (9): Compile and run the project, Deployment, Description, License, Project setup, Resources, Run tests, Stay in touch (+1 more)

### Community 158 - "codigo-barras.util.ts"
Cohesion: 0.35
Nodes (7): armar(), conSecuencia(), digitoVerificadorEan13(), ean13Interno(), esEan13Valido(), MAX_SECUENCIA_INTERNA, variantesCodigo()

### Community 159 - "reportes.repository.ts"
Cohesion: 0.15
Nodes (7): FilaProductoCotizado, FilaProductoVendido, ReportesQueryFilters, ReportesRepository, armar(), aTimestampUtc(), TIPO_NOTA_CREDITO

### Community 160 - "traductor-errores-bd.ts"
Cohesion: 0.25
Nodes (13): mensajePgSeguro(), InfoErrorPg, reglaParaErrorPg(), BD_NO_DISPONIBLE, CODIGOS_DE_RED, desdeSqlState(), ErrorPgCrudo, esFallaDeConexion() (+5 more)

### Community 162 - "VentaTiendaRepository"
Cohesion: 0.21
Nodes (3): armar(), PAGADO, VentaTiendaRepository

### Community 163 - "UbigeoService"
Cohesion: 0.11
Nodes (10): FilaUbigeo, UBIGEOS_INEI, aUbigeo(), Entrada, MAXIMO_RESULTADOS_UBIGEO, MINIMO_CARACTERES_BUSQUEDA_UBIGEO, normalizarTextoUbigeo(), Ubigeo (+2 more)

### Community 169 - "catalogo.response.ts"
Cohesion: 0.14
Nodes (8): CategoriaTiendaResponse, EspecificacionResponse, FiltrosDisponiblesResponse, FiltroValorResponse, ImagenResponse, MarcaTiendaResponse, PaginaResponse, StockSucursalResponse

### Community 173 - "nest-cli.json"
Cohesion: 0.33
Nodes (5): collection, compilerOptions, deleteOutDir, $schema, sourceRoot

### Community 178 - "Cliente"
Cohesion: 0.06
Nodes (19): CONSUMIDOR_FINAL, ADMIN, cliente(), comprobante(), ComprobanteNuevo, EMISOR, guia(), SERIES (+11 more)

### Community 179 - "CatalogoBussnies"
Cohesion: 0.30
Nodes (5): CatalogoBussnies, limiteSeguro(), armar(), textoBusqueda(), ProductoTiendaResponse

### Community 181 - "compresion.ts"
Cohesion: 0.24
Nodes (8): compression, debeComprimir(), JSON_GRANDE, peticion, TEXTO_GRANDE, textoCabecera(), TIPOS_SIN_COMPRESION, UMBRAL_COMPRESION_BYTES

### Community 182 - "proforma-documento.paleta.spec.ts"
Cohesion: 0.50
Nodes (4): ColorPaleta, contraste(), luminancia(), PARES

### Community 183 - "tsconfig.build.json"
Cohesion: 0.50
Nodes (3): ./tsconfig.json, exclude, extends

### Community 190 - "pedido.bussnies.spec.ts"
Cohesion: 0.47
Nodes (3): armar(), itemCarrito(), pedidoBase()

### Community 191 - "eslint.config.mjs"
Cohesion: 0.40
Nodes (4): @eslint/js, eslint-plugin-prettier, globals, typescript-eslint

### Community 195 - "correo-comprobante.service.spec.ts"
Cohesion: 0.83
Nodes (3): detalle(), fila(), montar()

## Knowledge Gaps
- **862 isolated node(s):** `$schema`, `collection`, `sourceRoot`, `deleteOutDir`, `name` (+857 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1928 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **48 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@nestjs/common` connect `@nestjs/common` to `certificado-fiscal.service.ts`, `CheckoutBussnies`, `filtro-errores.filter.spec.ts`, `lotes-fiscales.service.ts`, `auth.bussnies.ts`, `AmbienteFiscal`, `venta.repository.ts`, `guia-remision.bussnies.ts`, `mensajes-validacion.ts`, `fiscal-config.tipos.ts`, `comprobante-correos.repository.ts`, `comprobante.bussnies.ts`, `venta-documentos.bussnies.ts`, `NotaCreditoBussnies`, `log-repository.ts`, `filasDe`, `caja-arqueo.bussnies.ts`, `AppService`, `@nestjs/typeorm`, `emision-directa.service.ts`, `ref_crypto`, `codigo-barras.util.ts`, `reportes.repository.ts`, `app.module.ts`, `UbigeoService`, `lotes-fiscales.service.spec.ts`, `nota-credito.bussnies.spec.ts`, `caja-arqueo.repository.ts`, `proforma.bussnies.ts`, `reportes.bussnies.ts`, `correo-comprobantes.tarea.ts`, `package.json`, `Cliente`, `caja.request.ts`, `culqi.pasarela.ts`, `RecepcionRepository`, `nota-credito.bussnies.ts`, `salud.bussnies.ts`, `pedido.bussnies.spec.ts`, `ConfiguracionRepository`, `sunat-emision.service.spec.ts`, `comprobante.repository.ts`, `EnvioFiscalRepository`, `correo-comprobante.service.spec.ts`, `logo-emisor.ts`, `registro-peticiones.middleware.ts`, `filasDe`, `lote-fiscal.repository.ts`, `venta.bussnies.ts`, `rol.bussnies.ts`, `main.ts`, `fiscal-errores.ts`, `caja-turnos.bussnies.ts`, `EmisionGre`, `plataforma.registro.ts`, `CajaTurnosBussnies`, `registros.ts`, `correo-comprobante.service.ts`, `WhatsappPasarela`, `pago.bussnies.ts`, `carrito.bussnies.ts`, `correo.config.ts`, `filtro-errores.filter.ts`?**
  _High betweenness centrality (0.271) - this node is a cross-community bridge._
- **What connects `$schema`, `collection`, `sourceRoot` to the rest of the system?**
  _862 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `certificado-fiscal.service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.0432183908045977 - nodes in this community are weakly interconnected._
- **Why does `UsuarioToken` connect `UsuarioToken` to `AmbienteFiscal`, `venta-documentos.bussnies.ts`, `NotaCreditoBussnies`, `@nestjs/common`, `caja-arqueo.bussnies.ts`, `GuiaRemisionController`, `emision-directa.service.ts`, `FiscalAdminController`, `Cliente`, `VentaController`, `relanzarHttp`, `RecepcionRepository`, `ConfiguracionRepository`, `.cambiarEstadoPosBeta`, `CarritoController`, `ComprobanteController`, `venta.bussnies.ts`, `caja-turnos.bussnies.ts`, `CreditoRepository`, `ProductoController`, `CajaTurnosBussnies`, `CajaArqueoController`?**
  _High betweenness centrality (0.063) - this node is a cross-community bridge._
- **Should `CheckoutBussnies` be split into smaller, more focused modules?**
  _Cohesion score 0.07435897435897436 - nodes in this community are weakly interconnected._
- **Why does `Roles()` connect `@nestjs/common` to `UserController`, `SunatController`, `auth.bussnies.ts`, `Sucursal`, `AmbienteFiscal`, `ReportesController`, `log-repository.ts`, `ClienteRepository`, `GuiaRemisionController`, `emision-directa.service.ts`, `ConfiguracionFiscalBussnies`, `UsuarioToken`, `ref_crypto`, `ProductoImagen`, `FiscalAdminController`, `AdminController`, `caja.request.ts`, `VentaController`, `RecepcionRepository`, `ProformaController`, `ComprobanteController`, `rol.bussnies.ts`, `fiscal-errores.ts`, `StockSucursal`, `Empresa`, `ReceptorController`, `Categoria`, `CreditoRepository`, `ProductoController`, `InventarioBussnies`, `NotaCreditoController`, `CajaArqueoController`, `MarcaController`, `InventarioController`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Should `SunatEmisionService` be split into smaller, more focused modules?**
  _Cohesion score 0.1191919191919192 - nodes in this community are weakly interconnected._