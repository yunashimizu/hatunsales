# Graph Report - hatunsales  (2026-11-05)

## Corpus Check
- 650 files · ~460,793 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 8 file(s) not represented in the graph (top: (none) 3, .example 1, .sqlite 1)

## Summary
- 7093 nodes · 22059 edges · 189 communities (136 shown, 53 thin omitted)
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 1428 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b3756b7b`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- certificado-fiscal.service.ts
- pedido.bussnies.ts
- app.module.ts
- sunat-emision.service.ts
- lotes-fiscales.service.ts
- auth.bussnies.ts
- ActorFiscal
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
- AmbienteFiscal
- CatalogoRepository
- Roles
- filasDe
- proforma-documento.ts
- caja-arqueo.bussnies.ts
- ClienteRepository
- gre-emision.service.ts
- FiscalConfigError
- firmador-xml.ts
- validaciones-cpe.ts
- validaciones-gre.ts
- UsuarioToken
- ref_crypto
- carrito.bussnies.ts
- nucleo/index.ts
- CuentaTiendaBussnies
- documento-fiscal.types.ts
- ProductoRepository
- el
- emision.registro.spec.ts
- nota-credito.bussnies.spec.ts
- EmisionDirectaService
- ProductoImagen
- nota-credito.integracion.spec.ts
- Dinero
- class-validator
- sunat.bussnies.ts
- proforma.bussnies.ts
- reportes.bussnies.ts
- AdminController
- sunat.catalogos.ts
- package.json
- Dinero
- guia-remision-pdf.ts
- correo.config.ts
- fecha-lima.ts
- CajaPagosRepository
- VentaController
- caja-arqueo.repository.ts
- culqi.pasarela.ts
- RecepcionRepository
- nota-credito.bussnies.ts
- arqueo-pdf.ts
- plataforma.registro.ts
- logo-emisor.ts
- CajaSesionRepository
- CajaArqueoBussnies
- ComprobanteRepository
- ConfiguracionRepository
- ProformaController
- pedido.controller.ts
- venta.bussnies.ts
- ComprobanteController
- ComprobanteCorreosRepository
- construir-xml-cpe.ts
- filtro-errores.filter.ts
- dependencies
- CreditoRepository
- checklist-activacion.ts
- firmador-xml.spec.ts
- politica-limites.ts
- cuerpoError
- devDependencies
- GuardarGuiaRemisionRequest
- RolBussnies
- proforma.repository.ts
- traductor-errores-bd.ts
- EnviosAdminController
- DibujoProforma
- main.ts
- AlmacenLimitesMemoria
- reporte-ventas-pdf.ts
- sunat-soap-client.ts
- compilerOptions
- LotesAdminController
- BovedaSecretosFiscales
- ProveedorController
- StockSucursalController
- ReceptorBussnies
- RespuestaSunat
- Categoria
- AbonoCreditoRequest
- GuiaRemisionController
- ProductoController
- clasificador-respuesta.ts
- producto-imagen.controller.ts
- ActualizarInventarioRequest
- ProductoBussnies
- CrearVentaRequest
- InventarioBussnies
- nota-credito.controller.spec.ts
- ReceptorController
- caja-sesion.bussnies.ts
- esquema-caja.service.ts
- RegistrarArqueoRequest
- correo-comprobante.service.ts
- ClasificadorRespuestaSunat
- reporte-ventas-excel.ts
- reglas-postgres.ts
- RecepcionController
- InventarioRepository
- WhatsappPasarela
- sunat-soap-client.spec.ts
- transporte-soap.ts
- MarcaController
- ReceptorRepository
- ErrorTraducido
- traductor-http-exception.ts
- AuthController
- InventarioController
- UserController
- Get
- runtime.config.ts
- filtro-errores.filter.spec.ts
- caja.registro.ts
- mensajes-validacion.ts
- AlmacenController
- loginController
- scripts
- qr.ts
- reporte-export.ts
- GuiaRemision
- Proforma
- UserRequest
- numero-letras.ts
- jest
- gre-tickets.tarea.ts
- ReportesController
- log.bussnies.ts
- unidades-amigables.ts
- ActualizarProductoRequest
- compresion.ts
- preparar-fiscal-local.cjs
- AppService
- ProductoResponse
- Inventario
- traductor-error-dominio.ts
- deploy
- README.md
- ConfiguracionController
- codigo-barras.util.ts
- ReportesRepository
- ConfiguracionFiscalBussnies
- LogRepository
- ConsultaDocumentoService
- Usuario
- CertificadoFiscalRepository
- StorageService
- LogController
- CreditoVencimientosTarea
- correo.registro.ts
- VentaDto
- .buscar
- IRepository
- SecretosFiscalesRepository
- nest-cli.json
- comprobante-correos.repository.spec.ts
- Auditoria
- Log
- ProductoAtributo
- BuscarUbigeoRequest
- CuentaPorCobrar
- Seccion
- Banner
- proforma-documento.paleta.spec.ts
- tsconfig.build.json
- Permiso
- ILogRepository
- auth.response.ts
- login-response.ts

## God Nodes (most connected - your core abstractions)
1. `@nestjs/common` - 239 edges
2. `Roles()` - 160 edges
3. `UsuarioToken` - 130 edges
4. `AmbienteFiscal` - 130 edges
5. `typeorm` - 126 edges
6. `FiscalConfigError` - 112 edges
7. `ComprobanteBussnies` - 104 edges
8. `UsuarioActual` - 83 edges
9. `FiscalConfigService` - 78 edges
10. `Cliente` - 76 edges

## Surprising Connections (you probably didn't know these)
- `validar()` --calls--> `crearValidationPipe()`  [EXTRACTED]
  src/api/controllers/nota-credito.controller.spec.ts → src/util/http/validacion/validation-pipe.factory.ts
- `crear()` --calls--> `ConfiguracionFiscalBussnies`  [EXTRACTED]
  src/bussnies/Bussnies/configuracion-fiscal.bussnies.spec.ts → src/bussnies/Bussnies/configuracion-fiscal.bussnies.ts
- `SinValidez` --references--> `CabeceraComprobante`  [EXTRACTED]
  src/bussnies/Bussnies/nota-credito.bussnies.ts → src/repository/Repository/nota-credito.repository.ts
- `crearServicio()` --calls--> `VentaBussnies`  [EXTRACTED]
  src/bussnies/Bussnies/venta.bussnies.spec.ts → src/bussnies/Bussnies/venta.bussnies.ts
- `MetaSesion` --references--> `SnapshotEsquema`  [EXTRACTED]
  src/repository/Repository/caja-sesion.repository.ts → src/caja/esquema/esquema-caja.service.ts

## Import Cycles
- None detected.

## Communities (189 total, 53 thin omitted)

### Community 0 - "certificado-fiscal.service.ts"
Cohesion: 0.04
Nodes (111): AccionAuditoriaFiscal, ACCIONES_AUDITORIA_FISCAL, FiscalAuditoriaRepository, RegistroAuditoriaFiscal, FilaCertificadoFiscal, MetadatosCertificadoFiscal, VersionCertificadoFiscal, CertificadoFiscalService (+103 more)

### Community 1 - "pedido.bussnies.ts"
Cohesion: 0.02
Nodes (38): CheckoutController, PagoWebhookController, CheckoutBussnies, CuponAplicado, diaDe(), dos(), armar(), NOCHE_EN_LIMA (+30 more)

### Community 2 - "app.module.ts"
Cohesion: 0.03
Nodes (43): @nestjs/common, @nestjs/typeorm, typeorm, AppModule, ETIQUETA_MOTIVO, traducirErrorStock(), ResultadoAsignacionCodigosSunat, CONSUMIDOR_FINAL (+35 more)

### Community 3 - "sunat-emision.service.ts"
Cohesion: 0.04
Nodes (71): EfectosNotasTarea, montar(), ConsultorTx, EnvioVista, EventoEnvioCompletado, FiltroEnvios, MAXIMO_ENVIOS_POR_PAGINA, OyenteEnvioFiscal (+63 more)

### Community 4 - "lotes-fiscales.service.ts"
Cohesion: 0.04
Nodes (70): MaterialCargado, MaterialFirma, aLinea(), aLote(), ambienteDe(), aVista(), CabeceraBaja, efectoDelCierre() (+62 more)

### Community 5 - "auth.bussnies.ts"
Cohesion: 0.03
Nodes (36): bcrypt, @nestjs/jwt, RolesAdminController, AdminBussnies, AuthBussnies, esCorreoDuplicado(), JwtPayload, armar() (+28 more)

### Community 6 - "ActorFiscal"
Cohesion: 0.04
Nodes (29): actorDe(), FiscalAdminBussnies, FiscalAdminController, OPCIONES_SUBIDA_CERTIFICADO, IFiscalAdminBussnies, sanitizarDetalle(), CertificadoLeido, ArchivoCertificado (+21 more)

### Community 7 - "venta.repository.ts"
Cohesion: 0.03
Nodes (43): EsquemaCajaService, SnapshotEsquema, snapshot(), FilaInventarioBloqueada, LineaPorDespachar, PlanSalida, SalidaStock, VentaHistorialFila (+35 more)

### Community 8 - "guia-remision.bussnies.ts"
Cohesion: 0.03
Nodes (68): campoFormularioGuia(), CAMPOS_FORMULARIO, cantidadTexto(), CODIGOS_YA_REGISTRADA, conGuiaGuardada(), conPlazo(), ContextoDocumento, DefectosGuardado (+60 more)

### Community 9 - "comprobante-pdf.ts"
Cohesion: 0.05
Nodes (54): Alineacion, AVISO_BETA_PDF, cantidad(), ClientePdfComprobante, COLOR, comoError(), conMiles(), conSon() (+46 more)

### Community 10 - "fiscal-config.tipos.ts"
Cohesion: 0.04
Nodes (83): EventoAuditoriaFiscal, CodigoFaltante, FALTANTES, ItemChecklist, DEFECTOS_PRUEBA, DOCUMENTOS_PRUEBA, esMapaCorrelativoInicial(), FORMATOS_CERTIFICADO_PUBLICO (+75 more)

### Community 11 - "gre-rest-client.ts"
Cohesion: 0.05
Nodes (77): adm-zip, base(), clasificarConsultaGre(), clasificarEnvioGre(), codigoParaBuscar(), CODIGOS_CONFIGURACION, CODIGOS_YA_REGISTRADA, comoObjeto() (+69 more)

### Community 12 - "comprobante.bussnies.ts"
Cohesion: 0.04
Nodes (51): AccionesComprobante, BaseRespuesta, EmisorConfigurado, EmisorDocumento, ESTADOS_ACEPTADO, ESTADOS_EN_CURSO, FORMA_MOTIVO_NOTA_CREDITO, MONEDAS (+43 more)

### Community 13 - "GuiaRemisionBussnies"
Cohesion: 0.05
Nodes (29): estadoDe(), GuiaRemisionBussnies, mensajeDe(), numeroFormateado(), IGuiaRemisionBussniees, EstadoGuia, AccionesGuiaResponse, CatalogosGuiaResponse (+21 more)

### Community 14 - "ComprobanteBussnies"
Cohesion: 0.06
Nodes (14): ComprobanteBussnies, ComprobantePreparado, banderas(), ComprobanteDetalleResponse, ComprobanteResponse, ItemPreviewResponse, DatosFiscalesComprobante, FiltroComprobantes (+6 more)

### Community 15 - "venta-documentos.bussnies.ts"
Cohesion: 0.06
Nodes (63): clasificarParaAnular(), motivoEmisionInactiva(), ResumenNotasOrigen, AccionesDetalle, estadoGuia(), ESTADOS_ACEPTADO, fechaLegible(), mensajeDe() (+55 more)

### Community 16 - "NotaCreditoBussnies"
Cohesion: 0.08
Nodes (21): calcularAcreditable(), esNotaEnCurso(), esNotaVigente(), NotaCreditoBussnies, AnulacionVentaResponse, NotaAnulacionResponse, AnularVentaRequest, booleano() (+13 more)

### Community 17 - "AmbienteFiscal"
Cohesion: 0.04
Nodes (20): certificadoPublico(), FormatoCertificadoPublico, NuevoCertificadoFiscal, RepositorioCertificadosFiscales, DescargaCertificadoPublico, OpcionesSubidaCertificado, RepositorioCertificadosMemoria, CredencialesSol (+12 more)

### Community 18 - "CatalogoRepository"
Cohesion: 0.05
Nodes (22): CatalogoController, limitePedido(), CatalogoBussnies, limiteSeguro(), armar(), textoBusqueda(), CatalogoQueryRequest, CategoriaTiendaResponse (+14 more)

### Community 19 - "Roles"
Cohesion: 0.09
Nodes (25): @nestjs/core, @nestjs/swagger, @nestjs/testing, supertest, FORMATOS_PDF, CUERPO_VALIDO, servicio, opcionesSubida (+17 more)

### Community 20 - "filasDe"
Cohesion: 0.07
Nodes (32): aFila(), AlmacenSalidaGuia, ArchivoGuia, archivosDe(), CierreConsultaGuia, COLUMNAS_GUARDADO, DatosGuardarGuia, decimal() (+24 more)

### Community 21 - "proforma-documento.ts"
Cohesion: 0.06
Nodes (67): contraste(), luminancia(), argb(), avisoEstadoCliente(), condicionesComerciales(), cuentasUtiles(), DatosProformaDocumento, describirCuenta() (+59 more)

### Community 22 - "caja-arqueo.bussnies.ts"
Cohesion: 0.07
Nodes (55): ICajaArqueoBussniees, ResultadoPreparacionCierre, arqueoDetalleResponse(), arqueoResumenResponse(), CLAVES_RESERVADAS, codigoArqueo(), denominacionesValidas(), efectivoResponse() (+47 more)

### Community 23 - "ClienteRepository"
Cohesion: 0.06
Nodes (10): ClienteController, ClienteBussnies, armar(), IClienteBussniees, IBussniesCrud, ActualizarClienteRequest, CrearClienteRequest, ClienteResponse (+2 more)

### Community 24 - "gre-emision.service.ts"
Cohesion: 0.07
Nodes (42): EnvioParaConsulta, RegistroEmisionGuia, ContextoGre, EmisionGre, GreEsperada, GrePreparada, ModoEmisionGre, ResultadoConsultaGre (+34 more)

### Community 25 - "FiscalConfigError"
Cohesion: 0.05
Nodes (50): RFC-8017, node-forge, armarCertificado(), atributos(), BITS_MINIMOS_SUNAT, BITS_RECOMENDADOS, buscarRuc(), decodificarValor() (+42 more)

### Community 26 - "firmador-xml.ts"
Cohesion: 0.08
Nodes (60): xml-crypto, enlaceQrDeCdr(), constructor, ORDEN_XSD, violacionesDeOrden(), CDR_ILEGIBLE, CdrLeido, EstadoCdr (+52 more)

### Community 27 - "validaciones-cpe.ts"
Cohesion: 0.11
Nodes (33): esAfectacionGratuita(), esAfectacionOnerosa(), esMotivoNotaDebito(), LineaCpe, OpcionesValidacionCpe, ResultadoValidacionCpe, PATRON_SERIE_BOLETA, PATRON_SERIE_FACTURA (+25 more)

### Community 28 - "validaciones-gre.ts"
Cohesion: 0.07
Nodes (58): CATALOGO_18_MODALIDAD_TRASLADO, CATALOGO_20_MOTIVOS_TRASLADO, CATALOGO_61_DOCUMENTOS_RELACIONADOS, DOCUMENTOS_RELACIONADOS_CON_SERIE, ID_ENVIO_GRE, MAXIMO_CONDUCTORES_GRE, MAXIMO_ITEMS_GRE, MOTIVO_GRE_OTROS (+50 more)

### Community 29 - "UsuarioToken"
Cohesion: 0.07
Nodes (6): CajaArqueoController, CajaSesionController, CarritoController, ContextoCarrito, UsuarioActual, UsuarioToken

### Community 30 - "ref_crypto"
Cohesion: 0.06
Nodes (21): ArchivoController, ArchivoSubido, almacenamientoConfig, cloudinary, ProveedorAlmacen, ProductoImagenRepository, LineaRecepcionInput, NuevaRecepcion (+13 more)

### Community 31 - "carrito.bussnies.ts"
Cohesion: 0.06
Nodes (15): CarritoBussnies, CarritoItemTienda, CarritoTienda, carritoVacio(), centavos(), esViolacionUnica(), armar(), VACIO (+7 more)

### Community 32 - "nucleo/index.ts"
Cohesion: 0.07
Nodes (44): CATALOGO_06_TIPOS_VALIDOS, esConsumidorFinal(), PLAZOS_ENVIO_DIAS, construirCadenaQr(), TIPOS_QR, DatosCadenaQr, esDniValido(), PESOS_RUC (+36 more)

### Community 33 - "CuentaTiendaBussnies"
Cohesion: 0.06
Nodes (9): idOpcional(), CuentaTiendaController, CuentaTiendaBussnies, UsuarioAutenticado, CrearResenaRequest, GuardarDireccionRequest, CuentaTiendaRepository, IdEnteroPipe (+1 more)

### Community 34 - "documento-fiscal.types.ts"
Cohesion: 0.07
Nodes (44): @xmldom/xmldom, facturaAceptada(), venta(), afectacionDesdeTipoIgv(), crearDocumentoPruebaBeta(), crearDocumentoPruebaUnidades(), serieBetaDe(), serieDePrueba() (+36 more)

### Community 35 - "ProductoRepository"
Cohesion: 0.04
Nodes (9): StockSucursalBussnies, Almacen, MovimientoInventario, StockSucursal, Sucursal, conQuery(), crear(), ProductoRepository (+1 more)

### Community 36 - "el"
Cohesion: 0.11
Nodes (15): ConstructorGreUbl, texto(), MonedaCpe, identificadorCpe(), nombreArchivoResumen(), ConstructorComunicacionBajaUbl, ConstructorResumenDiarioUbl, LineaResumenDiario (+7 more)

### Community 37 - "emision.registro.spec.ts"
Cohesion: 0.06
Nodes (23): main(), REGISTRO_CORREO, REGISTRO_NOTAS_CREDITO, REGISTRO_PLATAFORMA, RegistroModulo, unirRegistros(), REGISTROS, REGISTRO_VENTA_DOCUMENTOS (+15 more)

### Community 38 - "nota-credito.bussnies.spec.ts"
Cohesion: 0.07
Nodes (46): MAXIMO_INTENTOS_NUMERO, cpe(), crear(), envio(), fila(), fiscal(), generarPdf, motorConOrigen() (+38 more)

### Community 39 - "EmisionDirectaService"
Cohesion: 0.06
Nodes (13): Registrado, tokenApiPeruDeEntorno(), VARIABLES_TOKEN_APIPERU, DiagnosticoArranqueFiscal, SnapshotConfigFiscal, BetaAdminController, DocumentoPreparado, copiaEmisor() (+5 more)

### Community 40 - "ProductoImagen"
Cohesion: 0.07
Nodes (5): ProductoImagenController, ProductoImagenBussnies, armar(), armarSubidas(), ProductoImagen

### Community 41 - "nota-credito.integracion.spec.ts"
Cohesion: 0.05
Nodes (27): aceptarNota(), EMISOR, eventoAceptado(), LineaOrigen, marcarAceptado(), SERIES, ADMIN, cliente() (+19 more)

### Community 42 - "Dinero"
Cohesion: 0.08
Nodes (10): DecimalExacto, Dinero, dividirRedondeando(), formatearDecimal(), formatearMonto(), potencia10(), potenciasDe10, redondear() (+2 more)

### Community 43 - "class-validator"
Cohesion: 0.05
Nodes (13): class-transformer, class-validator, @nestjs/passport, OptionalJwtGuard, CANTIDAD_MAXIMA_OPERACION, AsignarCodigosSunatRequest, MAX_ASIGNACIONES_CODIGO_SUNAT, ActualizarItemCarritoRequest (+5 more)

### Community 44 - "sunat.bussnies.ts"
Cohesion: 0.09
Nodes (9): SunatController, SunatBussnies, ISunatBussniees, BuscarDniRequest, BuscarRucEmpresaRequest, BuscarRucProveedorRequest, DniResponse, RucResponse (+1 more)

### Community 45 - "proforma.bussnies.ts"
Cohesion: 0.10
Nodes (15): ConfigEmisor, CUENTAS_DOCUMENTO_POR_DEFECTO, DocumentoProforma, ProformaBussnies, IProformaBussniees, ProformaItemResponse, ProformaResponse, CuentaBancariaProforma (+7 more)

### Community 46 - "reportes.bussnies.ts"
Cohesion: 0.08
Nodes (32): exceljs, ClaseReporte, clasificarComprobanteReporte(), ComprobanteReporte, DetalleReporteVentas, diaLimaComprobante(), idTipoDe(), MESES_CORTOS (+24 more)

### Community 47 - "AdminController"
Cohesion: 0.05
Nodes (5): AdminController, ActualizarEmpleadoRequest, CambiarRolRequest, CrearEmpleadoRequest, EliminarUsuarioRequest

### Community 48 - "sunat.catalogos.ts"
Cohesion: 0.05
Nodes (44): motivosDisponibles(), AFECTACIONES_GRATUITAS, AFECTACIONES_ONEROSAS, AfectacionIgv, CATALOGO_01_BOLETA, CATALOGO_01_FACTURA, CATALOGO_01_GUIA_REMISION_REMITENTE, CATALOGO_01_NOTA_CREDITO (+36 more)

### Community 49 - "package.json"
Cohesion: 0.05
Nodes (44): author, description, license, name, private, version, @anthropic-ai/sdk, better-sqlite3 (+36 more)

### Community 50 - "Dinero"
Cohesion: 0.06
Nodes (11): DeclaracionMedio, buscarDenominacion(), ConteoDenominacionEntrada, ConteoEfectivo, Denominacion, DENOMINACIONES_PEN, leerValor(), TipoDenominacion (+3 more)

### Community 51 - "guia-remision-pdf.ts"
Cohesion: 0.09
Nodes (21): pdfkit, cantidad(), COLOR, DatosGuiaRemisionPdf, DibujoGuia, fecha(), Fila, generarGuiaRemisionPdf() (+13 more)

### Community 52 - "correo.config.ts"
Cohesion: 0.13
Nodes (24): axios, ConfigCorreo, Entorno, fabricarEnviador(), leerConfigCorreo(), ProveedorCorreo, texto(), EnviadorArchivo (+16 more)

### Community 53 - "fecha-lima.ts"
Cohesion: 0.13
Nodes (36): escaparComodines(), aFechaLima(), cuatro(), DESFASE_LIMA_MINUTOS, diasEntreYmd(), dos(), fechaHoraLimaLegible(), FechaLimaInvalidaError (+28 more)

### Community 54 - "CajaPagosRepository"
Cohesion: 0.08
Nodes (3): CajaPagosController, CajaPagosBussnies, CajaPagosRepository

### Community 55 - "VentaController"
Cohesion: 0.08
Nodes (16): contexto(), crear(), mensajes(), Metodo, metodoDe(), rutasGet(), validar(), VentaController (+8 more)

### Community 56 - "caja-arqueo.repository.ts"
Cohesion: 0.08
Nodes (13): OpcionesSqlEsperado, sqlEsperadoTurno(), LineaConteo, FilaFuenteCaja, FuenteCaja, ArqueoGuardado, ICajaArqueoRepository, MovimientoGuardado (+5 more)

### Community 57 - "culqi.pasarela.ts"
Cohesion: 0.09
Nodes (15): ENTORNO_ORIGINAL, escenario(), Estado, pasarelaConfig, esProduccion(), CulqiPasarela, EventoWebhook, PASARELA_PAGO (+7 more)

### Community 58 - "RecepcionRepository"
Cohesion: 0.09
Nodes (6): RecepcionBussnies, armar(), tick(), RecepcionRepository, armar(), fila

### Community 59 - "nota-credito.bussnies.ts"
Cohesion: 0.10
Nodes (38): AVISO_MOTIVO, buscarAcreditable(), centesimas(), centimos(), ClaseAnulacion, CODIGOS_BAJA_CONFLICTO, conDosDecimales(), DecisionIncierto (+30 more)

### Community 60 - "arqueo-pdf.ts"
Cohesion: 0.17
Nodes (15): Alineacion, COLOR, colorEstado(), DibujoArqueo, EmisorArqueoPdf, etiquetaEstado(), fecha(), Fuente (+7 more)

### Community 61 - "plataforma.registro.ts"
Cohesion: 0.10
Nodes (11): SaludController, CACHE_PING_MS, SaludBussnies, TIEMPO_MAXIMO_PING_MS, ISaludBussniees, versionDespliegue(), EstadoPingBd, ResultadoPingBd (+3 more)

### Community 62 - "logo-emisor.ts"
Cohesion: 0.10
Nodes (28): SeriesPosResponse, CLAVE_CONDICIONES_PROFORMA, CLAVES_EMISOR, CLAVES_SERIES, emisorConfig, LOGO_EMISOR_OFICIAL, SERIES_POR_DEFECTO, SERIES_FISCALES_POR_DEFECTO (+20 more)

### Community 63 - "CajaSesionRepository"
Cohesion: 0.10
Nodes (5): CajaSesionBussnies, CajaSesionRepository, apertura, armar(), snapshot()

### Community 64 - "CajaArqueoBussnies"
Cohesion: 0.14
Nodes (7): CajaArqueoBussnies, esAdmin(), movimientoResponse(), turnoResponse(), ErrorCaja, relanzarHttp(), TurnoArqueo

### Community 65 - "ComprobanteRepository"
Cohesion: 0.08
Nodes (9): ComprobanteRepository, esViolacionUnicaSerieNumero(), NumeroOcupadoError, numeroONulo(), pisoValido(), COLUMNAS_FASE9, crearRepositorio(), ITEM (+1 more)

### Community 66 - "ConfiguracionRepository"
Cohesion: 0.08
Nodes (15): planificarSalidas(), sunatConfig, ConfiguracionRepository, repositorio(), FUENTE_CATALOGO, OpcionesBusqueda, LineaReserva, ModoStockTienda (+7 more)

### Community 67 - "ProformaController"
Cohesion: 0.10
Nodes (5): ProformaController, CrearProformaRequest, EnviarCotizacionWaRequest, MarcarProformaRequest, ProformaItemRequest

### Community 68 - "pedido.controller.ts"
Cohesion: 0.12
Nodes (5): PedidoAdminController, PedidoController, CambiarEstadoPedidoRequest, CrearPedidoRequest, RegistrarPagoRequest

### Community 69 - "venta.bussnies.ts"
Cohesion: 0.10
Nodes (28): ItemRecargo, SIN_RECARGO, calcularLinea(), desagregarIgv(), LineaFiscal, LineaFiscalEntrada, normalizarTipoIgv(), PORCENTAJE_IGV_POR_DEFECTO (+20 more)

### Community 70 - "ComprobanteController"
Cohesion: 0.13
Nodes (3): ComprobanteController, nombreDescarga(), crear()

### Community 71 - "ComprobanteCorreosRepository"
Cohesion: 0.11
Nodes (4): ComprobanteCorreosRepository, CorreoFila, CorreoComprobanteService, correoValido()

### Community 72 - "construir-xml-cpe.ts"
Cohesion: 0.12
Nodes (20): ATRIBUTOS_CATALOGO_01, CATALOGO_51_VENTA_INTERNA, construirXmlCpe(), construirXmlCpeValidado(), FabricaConstructoresXmlCpe, fabricaPorOmision, FormaPagoCpe, ResultadoXmlCpe (+12 more)

### Community 73 - "filtro-errores.filter.ts"
Cohesion: 0.12
Nodes (20): CABECERA_ID_PETICION, Cabeceras, ContextoPeticion, DatosPeticion, decodificarSeguro(), enmascararDatosPersonales(), enmascararTexto(), LARGO_MAXIMO_RUTA (+12 more)

### Community 74 - "dependencies"
Cohesion: 0.06
Nodes (33): dependencies, adm-zip, @anthropic-ai/sdk, axios, bcrypt, better-sqlite3, class-transformer, class-validator (+25 more)

### Community 76 - "checklist-activacion.ts"
Cohesion: 0.13
Nodes (26): advertenciasCertificado(), describirCertificado(), advertencias(), checklist(), ChecklistDocumento, detalleSecreto(), evaluarPreparacion(), fechaCorta() (+18 more)

### Community 77 - "firmador-xml.spec.ts"
Cohesion: 0.09
Nodes (22): CertificadoDigitalError, FirmaDemoNoPermitidaError, firmarXmlDemo(), MENSAJE_DEMO_EN_PRODUCCION, OpcionesFirmaDemo, ALGORITMOS_FIRMA_SUNAT, BITS_MINIMOS_CLAVE, CertificadoPreparado (+14 more)

### Community 78 - "politica-limites.ts"
Cohesion: 0.08
Nodes (19): LimitePeticionesGuard, claveIp(), coincide(), ConfigLimites, correoDe(), CUALQUIERA, ESCRITURAS, expandirIpv6() (+11 more)

### Community 79 - "cuerpoError"
Cohesion: 0.15
Nodes (3): VentaBussnies, VentaResponse, cuerpoError()

### Community 80 - "devDependencies"
Cohesion: 0.06
Nodes (31): devDependencies, eslint, eslint-config-prettier, @eslint/eslintrc, @eslint/js, eslint-plugin-prettier, globals, jest (+23 more)

### Community 81 - "GuardarGuiaRemisionRequest"
Cohesion: 0.19
Nodes (12): AnularGuiaRemisionRequest, CODIGOS_UNIDAD, ConductorGuiaRequest, DestinatarioGuiaRequest, GuardarGuiaRemisionRequest, ItemGuiaRequest, ListarGuiasRemisionRequest, PuntoGuiaRequest (+4 more)

### Community 82 - "RolBussnies"
Cohesion: 0.11
Nodes (4): RolController, RolBussnies, ActualizarRolRequest, CrearRolRequest

### Community 83 - "proforma.repository.ts"
Cohesion: 0.12
Nodes (15): codigoErrorBd(), codigoProforma(), detalleBd(), esChoqueDeCodigo(), esChoqueDePk(), LIMITE_NUMERO_HEREDADO, NuevaProforma, NuevoItemProforma (+7 more)

### Community 84 - "traductor-errores-bd.ts"
Cohesion: 0.13
Nodes (17): Registrador, RegistroTypeorm, mensajePgSeguro(), sqlSeguro(), mensajePorEstado(), esErrorPgOperativo(), reglaParaErrorPg(), BD_NO_DISPONIBLE (+9 more)

### Community 85 - "EnviosAdminController"
Cohesion: 0.12
Nodes (3): EnviosAdminController, ConfirmarAceptadoDto, ListarEnviosDto

### Community 87 - "main.ts"
Cohesion: 0.12
Nodes (23): cookie-parser, postgresConfigurado(), JWT_DEFAULT_DEV, booleanoEntorno(), bootstrap(), montarSwagger(), validarEntornoProduccion(), crearMiddlewareCabecerasSeguridad() (+15 more)

### Community 88 - "AlmacenLimitesMemoria"
Cohesion: 0.11
Nodes (10): AlmacenLimites, AlmacenLimitesMemoria, ConsumoLimite, Contador, ResultadoLimite, CODIGO_DEMASIADAS_SOLICITUDES, DemasiadasPeticionesException, ALMACEN_LIMITES (+2 more)

### Community 89 - "reporte-ventas-pdf.ts"
Cohesion: 0.16
Nodes (26): ABREVIATURA_TIPO, Alineacion, cantidad(), COLOR, ColumnaPdf, entero(), Fuente, generarReporteVentasPdf() (+18 more)

### Community 90 - "sunat-soap-client.ts"
Cohesion: 0.15
Nodes (21): EstadoComprobanteSunat, ConfiguracionSoapInvalidaError, ENDPOINTS_SUNAT, endpointsSunat, esEndpointProduccion(), HOSTS_PRODUCCION_SUNAT, DESCRIPCIONES_CONSULTA_SUNAT, estadoDeConsulta() (+13 more)

### Community 91 - "compilerOptions"
Cohesion: 0.07
Nodes (26): compilerOptions, allowSyntheticDefaultImports, declaration, emitDecoratorMetadata, esModuleInterop, experimentalDecorators, forceConsistentCasingInFileNames, ignoreDeprecations (+18 more)

### Community 97 - "RespuestaSunat"
Cohesion: 0.16
Nodes (12): RespuestaSunat, ArgumentosSoap, construirSobreSoap(), CredencialesSoap, ESPACIO_SERVICIO_SUNAT, ESPACIO_SOAP_11, ESPACIO_WSSE, MetodoSoapSunat (+4 more)

### Community 99 - "AbonoCreditoRequest"
Cohesion: 0.14
Nodes (3): CreditoController, AbonoCreditoRequest, LineaCreditoRequest

### Community 102 - "clasificador-respuesta.ts"
Cohesion: 0.09
Nodes (20): clasificadorPorOmision, clasificarRespuesta(), CODIGOS_BAJA_FUERA_DE_PLAZO, CODIGOS_CERTIFICADO, CODIGOS_CREDENCIAL_SOL, CODIGOS_DOCUMENTO_ALTERADO, CODIGOS_EMISOR_NO_HABILITADO, CODIGOS_FAULT_CONFIGURACION (+12 more)

### Community 103 - "producto-imagen.controller.ts"
Cohesion: 0.14
Nodes (10): @nestjs/platform-express, rxjs, opcionesSubida, ErroresSubidaImagenInterceptor, MAXIMO_FOTOS_POR_LOTE, comoNest, traducirErrorSubidaImagen(), ErroresFiscalesInterceptor (+2 more)

### Community 104 - "ActualizarInventarioRequest"
Cohesion: 0.13
Nodes (3): IInventarioBussniees, ActualizarInventarioRequest, InventarioResponse

### Community 106 - "CrearVentaRequest"
Cohesion: 0.16
Nodes (7): crear(), crearServicio(), ventaGuardada(), CrearVentaRequest, EmitirComprobanteVentaRequest, ItemVentaRequest, PagoVentaRequest

### Community 107 - "InventarioBussnies"
Cohesion: 0.18
Nodes (3): InventarioBussnies, AjustarStockRequest, TransferirStockRequest

### Community 108 - "nota-credito.controller.spec.ts"
Cohesion: 0.11
Nodes (7): NotaCreditoController, Clase, contexto(), crear(), metodoDe(), rutas(), validar()

### Community 110 - "caja-sesion.bussnies.ts"
Cohesion: 0.29
Nodes (6): AbrirCajaRequest, ActualizarCuentaBancariaRequest, CerrarCajaRequest, CuentaBancariaRequest, IniciarYapeRequest, MovimientoCajaRequest

### Community 111 - "esquema-caja.service.ts"
Cohesion: 0.14
Nodes (17): CodigoErrorCaja, CodigoErrorCajaTipo, cuerpoErrorCaja(), mensajeScriptPendiente(), SCRIPT_FASE11, CapacidadCaja, EFECTO_SI_FALTA, REQUISITOS (+9 more)

### Community 112 - "RegistrarArqueoRequest"
Cohesion: 0.19
Nodes (6): MAX_CANTIDAD_POR_DENOMINACION, DenominacionArqueoRequest, MedioDeclaradoRequest, PdfArqueoQuery, RegistrarArqueoRequest, TurnoQuery

### Community 113 - "correo-comprobante.service.ts"
Cohesion: 0.13
Nodes (17): CLAVE_CORREO_ENVIO_ACTIVO, DetalleParaCorreo, EstadoCorreoDetalle, ESTADOS_ACEPTADOS, ResultadoProceso, ResumenCorreoComprobante, detalle(), fila() (+9 more)

### Community 114 - "ClasificadorRespuestaSunat"
Cohesion: 0.34
Nodes (6): ClasificadorRespuestaSunat, cuatroDigitos(), decision(), numero(), ClasificacionRespuesta, ContextoClasificacion

### Community 115 - "reporte-ventas-excel.ts"
Cohesion: 0.18
Nodes (20): aFecha(), agregarHoja(), agregarResumen(), ARGB, bloqueTitulo(), bordeFino, bordes, cabeceraTabla() (+12 more)

### Community 116 - "reglas-postgres.ts"
Cohesion: 0.12
Nodes (16): BD_NO_DISPONIBLE, campo(), claveForanea(), columnasDeDetalle(), DATO_INVALIDO, duplicado(), ESQUEMA_PENDIENTE, Fabrica (+8 more)

### Community 118 - "InventarioRepository"
Cohesion: 0.13
Nodes (3): InventarioRepository, armar(), fila

### Community 119 - "WhatsappPasarela"
Cohesion: 0.19
Nodes (6): armar(), armarCreacion(), whatsappCloudListo(), whatsappConfig, ResultadoEnvioWa, WhatsappPasarela

### Community 120 - "sunat-soap-client.spec.ts"
Cohesion: 0.19
Nodes (17): cdrDe(), cdrPrueba(), OpcionesCdrPrueba, respuestaFault(), respuestaGetStatus(), respuestaGetStatusCdr(), respuestaSendBill(), respuestaSendSummary() (+9 more)

### Community 121 - "transporte-soap.ts"
Cohesion: 0.16
Nodes (10): DependenciasClienteSoap, agenteHttps(), CODIGOS_RED_TRANSITORIOS, ErrorTransporteSoap, MAXIMO_BYTES_RESPUESTA_SOAP, normalizarErrorRed(), PeticionSoap, RespuestaHttpSoap (+2 more)

### Community 123 - "ReceptorRepository"
Cohesion: 0.15
Nodes (3): OrigenReceptor, SugerenciaReceptor, ReceptorRepository

### Community 124 - "ErrorTraducido"
Cohesion: 0.18
Nodes (11): ErrorTraducido, NivelRegistro, TraductorError, traductoresPorDefecto(), CODIGOS_DE_RED, ErrorAxios, ErrorHttpCrudo, estadoHttpCrudo() (+3 more)

### Community 125 - "traductor-http-exception.ts"
Cohesion: 0.20
Nodes (15): codigoPorEstado(), CODIGOS, esFraseInglesaDeNest(), estadoDeError(), FRASES, FRASES_INGLES, MENSAJES, comoTexto() (+7 more)

### Community 130 - "runtime.config.ts"
Cohesion: 0.17
Nodes (11): FALSOS, LimitesNumericos, numeroEntorno(), VERDADEROS, RITMO_MAXIMO_MS, RITMO_MINIMO_POR_OMISION_MS, RITMO_SUNAT, ritmoMinimoDesdeEntorno() (+3 more)

### Community 131 - "filtro-errores.filter.spec.ts"
Cohesion: 0.16
Nodes (6): ErrorDominio, EsquemaPendienteError, consultaFallida(), ejecutar(), errorPg(), RespuestaFalsa

### Community 132 - "caja.registro.ts"
Cohesion: 0.17
Nodes (3): REGISTRO_CAJA, CajaArqueoDenominacion, CajaArqueo

### Community 133 - "mensajes-validacion.ts"
Cohesion: 0.22
Nodes (12): aplanarErroresValidacion(), CODIGO_VALIDACION, cuerpoErrorValidacion, ErrorDeCampo, etiquetaCampo(), legible(), PREDICADOS, LineaDto (+4 more)

### Community 136 - "scripts"
Cohesion: 0.14
Nodes (14): scripts, build, fiscal:preparar-local, format, lint, start, start:debug, start:dev (+6 more)

### Community 137 - "qr.ts"
Cohesion: 0.22
Nodes (11): qrcode, codificarQrPng(), CORRECCIONES, CorreccionQr, crc32(), generarQrPng(), OpcionesQrPng, leerModulos() (+3 more)

### Community 138 - "reporte-export.ts"
Cohesion: 0.20
Nodes (9): TIPO_NOTA_DEBITO, CabeceraReporte, claveTipoReporte(), FilaDetalleReporte, formatearFechaEs(), formatearFechaHoraEs(), nombreArchivoReporte(), REPORTE_COLUMNAS_DETALLE (+1 more)

### Community 142 - "numero-letras.ts"
Cohesion: 0.26
Nodes (12): apocopar(), CENTENAS, centenasALetras(), DECENAS, decenasALetras(), enteroALetras(), grupoALetras(), hastaMillonALetras() (+4 more)

### Community 143 - "jest"
Cohesion: 0.17
Nodes (12): jest, collectCoverageFrom, coverageDirectory, maxWorkers, moduleFileExtensions, moduleNameMapper, rootDir, testEnvironment (+4 more)

### Community 146 - "log.bussnies.ts"
Cohesion: 0.30
Nodes (4): LogBussnies, SCRIPT_TABLA_AUDITORIA, ILogBussniees, RegistroLogResponse

### Community 147 - "unidades-amigables.ts"
Cohesion: 0.20
Nodes (9): Base, GRUPOS_UNIDADES, GrupoUnidad, FRECUENTES_PLAN, OCULTAS_PLAN, UnidadAmigable, UNIDADES_AMIGABLES, UNIDADES_FRECUENTES (+1 more)

### Community 148 - "ActualizarProductoRequest"
Cohesion: 0.30
Nodes (3): ActualizarProductoRequest, AsignacionCodigoSunat, CrearProductoRequest

### Community 149 - "compresion.ts"
Cohesion: 0.24
Nodes (8): compression, debeComprimir(), JSON_GRANDE, peticion, TEXTO_GRANDE, textoCabecera(), TIPOS_SIN_COMPRESION, UMBRAL_COMPRESION_BYTES

### Community 150 - "preparar-fiscal-local.cjs"
Cohesion: 0.18
Nodes (6): archivoLlave, dotenv, fs, path, raiz, { randomBytes, X509Certificate }

### Community 154 - "traductor-error-dominio.ts"
Cohesion: 0.36
Nodes (8): CAMPOS_RESERVADOS, ErrorConCodigo, esErrorConCodigo(), esObjetoPlano(), estadoDeclarado(), sinCamposReservados(), cuerpoPropio(), TraductorErrorDominio

### Community 155 - "deploy"
Cohesion: 0.20
Nodes (9): build, buildCommand, deploy, healthcheckPath, healthcheckTimeout, restartPolicyMaxRetries, restartPolicyType, startCommand (+1 more)

### Community 156 - "README.md"
Cohesion: 0.20
Nodes (9): Compile and run the project, Deployment, Description, License, Project setup, Resources, Run tests, Stay in touch (+1 more)

### Community 158 - "codigo-barras.util.ts"
Cohesion: 0.40
Nodes (7): armar(), conSecuencia(), digitoVerificadorEan13(), ean13Interno(), esEan13Valido(), MAX_SECUENCIA_INTERNA, variantesCodigo()

### Community 159 - "ReportesRepository"
Cohesion: 0.24
Nodes (3): ReportesRepository, armar(), aTimestampUtc()

### Community 161 - "LogRepository"
Cohesion: 0.33
Nodes (3): esTablaInexistente(), limitar(), LogRepository

### Community 173 - "nest-cli.json"
Cohesion: 0.33
Nodes (5): collection, compilerOptions, deleteOutDir, $schema, sourceRoot

### Community 174 - "comprobante-correos.repository.spec.ts"
Cohesion: 0.40
Nodes (5): DIAS_SIEMBRA_CORREO, SEGUNDOS_RECLAMO_CORREO, consultorFalso(), crear(), Llamada

### Community 182 - "proforma-documento.paleta.spec.ts"
Cohesion: 0.50
Nodes (4): ColorPaleta, contraste(), luminancia(), PARES

### Community 183 - "tsconfig.build.json"
Cohesion: 0.50
Nodes (3): ./tsconfig.json, exclude, extends

## Knowledge Gaps
- **839 isolated node(s):** `$schema`, `collection`, `sourceRoot`, `deleteOutDir`, `name` (+834 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1891 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **53 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@nestjs/common` connect `app.module.ts` to `certificado-fiscal.service.ts`, `pedido.bussnies.ts`, `sunat-emision.service.ts`, `lotes-fiscales.service.ts`, `auth.bussnies.ts`, `ActorFiscal`, `venta.repository.ts`, `guia-remision.bussnies.ts`, `filtro-errores.filter.spec.ts`, `mensajes-validacion.ts`, `comprobante.bussnies.ts`, `venta-documentos.bussnies.ts`, `gre-tickets.tarea.ts`, `NotaCreditoBussnies`, `log.bussnies.ts`, `Roles`, `CatalogoRepository`, `filasDe`, `caja-arqueo.bussnies.ts`, `AppService`, `gre-emision.service.ts`, `FiscalConfigError`, `ref_crypto`, `codigo-barras.util.ts`, `carrito.bussnies.ts`, `CuentaTiendaBussnies`, `emision.registro.spec.ts`, `nota-credito.bussnies.spec.ts`, `correo.registro.ts`, `nota-credito.integracion.spec.ts`, `class-validator`, `sunat.bussnies.ts`, `proforma.bussnies.ts`, `reportes.bussnies.ts`, `package.json`, `correo.config.ts`, `VentaController`, `caja-arqueo.repository.ts`, `culqi.pasarela.ts`, `RecepcionRepository`, `nota-credito.bussnies.ts`, `plataforma.registro.ts`, `logo-emisor.ts`, `ConfiguracionRepository`, `pedido.controller.ts`, `venta.bussnies.ts`, `ComprobanteController`, `filtro-errores.filter.ts`, `proforma.repository.ts`, `traductor-errores-bd.ts`, `main.ts`, `AlmacenLimitesMemoria`, `producto-imagen.controller.ts`, `CrearVentaRequest`, `nota-credito.controller.spec.ts`, `caja-sesion.bussnies.ts`, `esquema-caja.service.ts`, `correo-comprobante.service.ts`, `WhatsappPasarela`, `traductor-http-exception.ts`?**
  _High betweenness centrality (0.263) - this node is a cross-community bridge._
- **What connects `$schema`, `collection`, `sourceRoot` to the rest of the system?**
  _839 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `certificado-fiscal.service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.03512291052114061 - nodes in this community are weakly interconnected._
- **Why does `Roles()` connect `Roles` to `UserController`, `app.module.ts`, `auth.bussnies.ts`, `AlmacenController`, `ActorFiscal`, `ReportesController`, `ClienteRepository`, `ConfiguracionController`, `UsuarioToken`, `LogController`, `EmisionDirectaService`, `ProductoImagen`, `class-validator`, `sunat.bussnies.ts`, `AdminController`, `CajaPagosRepository`, `VentaController`, `ProformaController`, `pedido.controller.ts`, `ComprobanteController`, `RolBussnies`, `EnviosAdminController`, `LotesAdminController`, `ProveedorController`, `StockSucursalController`, `Categoria`, `AbonoCreditoRequest`, `GuiaRemisionController`, `ProductoController`, `producto-imagen.controller.ts`, `ActualizarInventarioRequest`, `InventarioBussnies`, `nota-credito.controller.spec.ts`, `ReceptorController`, `RecepcionController`, `MarcaController`, `ReceptorRepository`, `InventarioController`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **Should `pedido.bussnies.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.022030350601779172 - nodes in this community are weakly interconnected._
- **Why does `UsuarioToken` connect `UsuarioToken` to `ActorFiscal`, `venta-documentos.bussnies.ts`, `NotaCreditoBussnies`, `Roles`, `caja-arqueo.bussnies.ts`, `ref_crypto`, `CuentaTiendaBussnies`, `nota-credito.integracion.spec.ts`, `class-validator`, `VentaController`, `RecepcionRepository`, `CajaSesionRepository`, `CajaArqueoBussnies`, `pedido.controller.ts`, `venta.bussnies.ts`, `ComprobanteController`, `CreditoRepository`, `cuerpoError`, `EnviosAdminController`, `AbonoCreditoRequest`, `GuiaRemisionController`, `ProductoController`, `nota-credito.controller.spec.ts`, `caja-sesion.bussnies.ts`, `esquema-caja.service.ts`, `RecepcionController`?**
  _High betweenness centrality (0.038) - this node is a cross-community bridge._
- **Should `app.module.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.03085491506544138 - nodes in this community are weakly interconnected._