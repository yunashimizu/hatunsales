# Graph Report - hatunsales  (2026-11-06)

## Corpus Check
- 656 files · ~471,877 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 8 file(s) not represented in the graph (top: (none) 3, .example 1, .sqlite 1)

## Summary
- 7203 nodes · 22422 edges · 197 communities (150 shown, 47 thin omitted)
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 1439 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `0249c536`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- certificado-fiscal.service.ts
- Pedido
- pedido.bussnies.ts
- SunatEmisionService
- AmbienteFiscal
- auth.bussnies.ts
- ActorFiscal
- venta.repository.ts
- guia-remision.bussnies.spec.ts
- DibujoComprobante
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
- Cliente
- fiscal-config.dto.ts
- FiscalConfigError
- firmador-xml.ts
- validaciones-cpe.ts
- validaciones-gre.ts
- UsuarioToken
- producto-imagen.bussnies.ts
- carrito.bussnies.ts
- resumen-caja-pdf.ts
- CuentaTiendaBussnies
- documentos-prueba-spec.ts
- app.module.ts
- constructor-resumen-diario.ts
- comprobante-pdf.ts
- nota-credito.bussnies.spec.ts
- proforma.bussnies.ts
- ProductoImagen
- nota-credito.integracion.spec.ts
- Dinero
- FiscalAdminController
- Empresa
- ProformaBussnies
- reportes.bussnies.ts
- admin.bussnies.ts
- sunat.catalogos.ts
- package.json
- Dinero
- guia-remision-pdf.ts
- axios
- fecha-lima.ts
- CajaPagosRepository
- VentaController
- relanzarHttp
- pago.bussnies.ts
- RecepcionRepository
- nota-credito.bussnies.ts
- DibujoArqueo
- plataforma.registro.ts
- logo-emisor.ts
- CajaSesionRepository
- AuthBussnies
- comprobante.repository.ts
- fiscal-tokens.ts
- ProformaController
- CuentaTiendaRepository
- guia-remision.bussnies.ts
- ComprobanteController
- ComprobanteCorreosRepository
- errores-nucleo.ts
- registro-peticiones.middleware.ts
- dependencies
- caja.request.ts
- FiscalConfigService
- lotes-fiscales.service.ts
- politica-limites.ts
- cuerpoError
- devDependencies
- GuardarGuiaRemisionRequest
- rol.bussnies.ts
- proforma.repository.ts
- enmascarar.ts
- .confirmarAceptado
- DibujoProforma
- main.ts
- AlmacenLimitesMemoria
- reporte-ventas-pdf.ts
- documento-fiscal.types.ts
- compilerOptions
- LotesAdminController
- caja-sesion.bussnies.ts
- clasificador-gre.ts
- StockSucursalBussnies
- ReceptorRepository
- ReceptorController
- CategoriaController
- CreditoRepository
- GreTicketsTarea
- ProductoController
- clasificador-respuesta.ts
- class-validator
- venta-documentos.repository.ts
- ProductoBussnies
- checklist-activacion.ts
- InventarioBussnies
- nota-credito.controller.spec.ts
- caja-turnos.bussnies.ts
- ReportesBussnies
- roles.config.ts
- RegistrarArqueoRequest
- correo-comprobante.service.ts
- ReceptorBussnies
- reporte-ventas-excel.ts
- reglas-postgres.ts
- ProductoImagenController
- InventarioRepository
- WhatsappPasarela
- StockTiendaRepository
- guia-remision.repository.ts
- MarcaController
- correo.config.ts
- filtro-errores.filter.ts
- gre-emision.service.spec.ts
- ActualizarPerfilRequest
- InventarioController
- UserController
- listar-ventas.request.ts
- Usuarios
- filtro-errores.filter.spec.ts
- caja.registro.ts
- mensajes-validacion.ts
- AlmacenController
- loginController
- scripts
- qr.ts
- comprobante-correos.repository.ts
- GuiaRemision
- guia-remision.controller.spec.ts
- EmitirNotaCreditoRequest
- numero-letras.ts
- jest
- .pasosLocales
- ReportesController
- log-repository.ts
- caja-sesion.repository.ts
- ProductoResponse
- comprobante-pdf.spec.ts
- preparar-fiscal-local.cjs
- AppService
- GuiaRemisionController
- CatalogoRepository
- BetaAdminController
- deploy
- README.md
- ConfiguracionRepository
- producto.bussnies.ts
- ReportesRepository
- traductor-errores-bd.ts
- calculo-fiscal.ts
- VentaTiendaRepository
- UbigeoService
- CertificadoFiscalRepository
- StorageService
- Inventario
- base-datos.almacen.ts
- errores-fiscales.interceptor.ts
- catalogo.bussnies.ts
- CloudinaryAlmacen
- IRepository
- inventario.bussnies.ts
- nest-cli.json
- Proforma
- arqueo-pdf.ts
- Log
- AsignarCodigosSunatRequest
- venta-documentos.integracion.spec.ts
- CatalogoBussnies
- ActualizarConfigFiscalDto
- compresion.ts
- proforma-documento.paleta.spec.ts
- tsconfig.build.json
- receptor.response.ts
- auth.response.ts
- login-response.ts
- JwtStrategy
- LogController
- CuentaPorCobrar
- CatalogoQueryRequest
- EmisorBetaDto
- EmisorNotasCredito
- Permiso

## God Nodes (most connected - your core abstractions)
1. `@nestjs/common` - 243 edges
2. `Roles()` - 160 edges
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
- `venta()` --calls--> `calcularComprobante()`  [EXTRACTED]
  src/bussnies/Bussnies/nota-credito.integracion.spec.ts → src/util/fiscal/calculo-fiscal.ts
- `facturaAceptada()` --calls--> `calcularComprobante()`  [EXTRACTED]
  src/bussnies/Bussnies/nota-credito.integracion.spec.ts → src/util/fiscal/calculo-fiscal.ts

## Import Cycles
- None detected.

## Communities (197 total, 47 thin omitted)

### Community 0 - "certificado-fiscal.service.ts"
Cohesion: 0.04
Nodes (88): AccionAuditoriaFiscal, ACCIONES_AUDITORIA_FISCAL, FiscalAuditoriaRepository, FilaCertificadoFiscal, MetadatosCertificadoFiscal, VersionCertificadoFiscal, CertificadoFiscalService, EXTENSIONES_ACEPTADAS (+80 more)

### Community 1 - "Pedido"
Cohesion: 0.04
Nodes (16): CarritoItemTienda, PagoBussnies, codigoPedido(), codigoProvisional(), PedidoBussnies, recortar(), armar(), itemCarrito() (+8 more)

### Community 2 - "pedido.bussnies.ts"
Cohesion: 0.05
Nodes (19): CheckoutController, PagoWebhookController, CheckoutBussnies, CuponAplicado, diaDe(), dos(), armar(), NOCHE_EN_LIMA (+11 more)

### Community 3 - "SunatEmisionService"
Cohesion: 0.14
Nodes (9): ResultadoEmision, CierreEnvio, EnvioRegistrado, aEnvio(), esAceptado(), mensajeDe(), resumen(), SunatEmisionService (+1 more)

### Community 4 - "AmbienteFiscal"
Cohesion: 0.03
Nodes (89): EfectosNotasTarea, montar(), MaterialCargado, OpcionesSubidaCertificado, MaterialFirma, DEFECTOS_PRUEBA, AmbienteFiscal, defectosDesdeEntorno() (+81 more)

### Community 5 - "auth.bussnies.ts"
Cohesion: 0.11
Nodes (14): @nestjs/jwt, JwtPayload, armar(), tick(), googleAuthConfig, jwtConfig, JwtPayload, UsuarioValidado (+6 more)

### Community 6 - "ActorFiscal"
Cohesion: 0.08
Nodes (24): FiscalAdminBussnies, ACTOR, crear(), IFiscalAdminBussnies, RegistroAuditoriaFiscal, ArchivoCertificado, CertificadoSubido, DescargaCertificadoPublico (+16 more)

### Community 7 - "venta.repository.ts"
Cohesion: 0.05
Nodes (29): FilaInventarioBloqueada, LineaPorDespachar, planificarSalidas(), PlanSalida, SalidaStock, VentaHistorialFila, ItemVentaResponse, ProductoVentaResponse (+21 more)

### Community 8 - "guia-remision.bussnies.spec.ts"
Cohesion: 0.06
Nodes (24): campoFormularioGuia(), ESPERA_CONSULTA_INMEDIATA_MS, ESPERAS_CONSULTA_SEG, MAXIMO_CONSULTAS_AUTOMATICAS, MENSAJE_GUIA_EN_PROCESO, MENSAJE_GUIA_EN_PROCESO_MANUAL, PLAZO_CONSULTA_INMEDIATA_MS, ACEPTADA (+16 more)

### Community 9 - "DibujoComprobante"
Cohesion: 0.17
Nodes (7): conSon(), DibujoComprobante, monto(), parrafos(), unidadLegible(), caracterWinAnsi(), textoPdf()

### Community 10 - "fiscal-config.tipos.ts"
Cohesion: 0.06
Nodes (53): EventoAuditoriaFiscal, CodigoFaltante, FALTANTES, ItemChecklist, ACTOR_SISTEMA, CLAVES_BLOQUEO_EMISION, CLAVES_CONFIG_FISCAL, CLAVES_CONFIRMACIONES_ACTIVACION (+45 more)

### Community 11 - "gre-rest-client.ts"
Cohesion: 0.06
Nodes (56): consultaSinRespuesta(), envioSinRespuesta(), MotivoSinRespuestaGre, RespuestaHttpLeidaGre, esperada, ESPACIO_DESPATCH_ADVICE, nombreBaseGre(), ResultadoXmlGre (+48 more)

### Community 12 - "comprobante.bussnies.ts"
Cohesion: 0.06
Nodes (28): AccionesComprobante, BaseRespuesta, EmisorConfigurado, EmisorDocumento, ESTADOS_ACEPTADO, ESTADOS_EN_CURSO, FORMA_MOTIVO_NOTA_CREDITO, MONEDAS (+20 more)

### Community 13 - "GuiaRemisionBussnies"
Cohesion: 0.08
Nodes (16): cantidadTexto(), conPlazo(), estadoDe(), GuiaRemisionBussnies, mensajeDe(), numeroFormateado(), pausa(), OperacionGuiaResponse (+8 more)

### Community 14 - "ComprobanteBussnies"
Cohesion: 0.05
Nodes (12): ComprobanteBussnies, ComprobantePreparado, banderas(), Comprobante, ComprobanteDetalleResponse, ComprobanteResponse, ItemPreviewResponse, DatosFiscalesComprobante (+4 more)

### Community 15 - "venta-documentos.bussnies.ts"
Cohesion: 0.07
Nodes (51): clasificarParaAnular(), motivoEmisionInactiva(), ResumenNotasOrigen, AccionesDetalle, estadoGuia(), ESTADOS_ACEPTADO, fechaLegible(), mensajeDe() (+43 more)

### Community 16 - "NotaCreditoBussnies"
Cohesion: 0.06
Nodes (21): esNotaEnCurso(), esNotaVigente(), NotaCreditoBussnies, AnulacionVentaResponse, NotaAnulacionResponse, AnularVentaRequest, booleano(), CabeceraComprobante (+13 more)

### Community 17 - "EjecutorSql"
Cohesion: 0.04
Nodes (12): sanitizarDetalle(), NuevoCertificadoFiscal, RepositorioCertificadosFiscales, RepositorioCertificadosMemoria, BloqueoEmision, GestorCredencialesFiscalesService, ResultadoReanudacion, hayCambios() (+4 more)

### Community 19 - "@nestjs/common"
Cohesion: 0.10
Nodes (24): @nestjs/common, @nestjs/core, @nestjs/passport, @nestjs/platform-express, @nestjs/swagger, @nestjs/testing, supertest, FORMATOS_PDF (+16 more)

### Community 20 - "filasDe"
Cohesion: 0.13
Nodes (8): entero(), EnvioGuiaEnCursoError, GuiaRemisionRepository, NumeroGuiaOcupadoError, sha256(), texto(), valoresGuardado(), filasDe()

### Community 21 - "proforma-documento.ts"
Cohesion: 0.09
Nodes (59): argb(), avisoEstadoCliente(), condicionesComerciales(), contactoEmisor(), cuentasUtiles(), DatosProformaDocumento, describirCuenta(), describirCuentaTabla() (+51 more)

### Community 22 - "caja-arqueo.bussnies.ts"
Cohesion: 0.08
Nodes (45): ICajaArqueoBussniees, ResultadoPreparacionCierre, arqueoDetalleResponse(), arqueoResumenResponse(), CLAVES_RESERVADAS, codigoArqueo(), denominacionesValidas(), efectivoResponse() (+37 more)

### Community 23 - "Cliente"
Cohesion: 0.04
Nodes (16): ClienteController, ClienteBussnies, armar(), IClienteBussniees, IBussniesCrud, sunatConfig, VARIABLES_TOKEN_APIPERU, Cliente (+8 more)

### Community 24 - "fiscal-config.dto.ts"
Cohesion: 0.10
Nodes (25): OPCIONES_SUBIDA_CERTIFICADO, AmbienteConsultaDto, AmbienteRequeridoDto, AuditoriaConsultaDto, CertificadoPublicoConsultaDto, ConfigGreDto, ConfirmacionesActivacionDto, CredencialesGreDto (+17 more)

### Community 25 - "FiscalConfigError"
Cohesion: 0.04
Nodes (65): RFC-8017, node-forge, armarCertificado(), atributos(), BITS_MINIMOS_SUNAT, BITS_RECOMENDADOS, buscarRuc(), CertificadoLeido (+57 more)

### Community 26 - "firmador-xml.ts"
Cohesion: 0.06
Nodes (77): @xmldom/xmldom, enlaceQrDeCdr(), constructor, ORDEN_XSD, violacionesDeOrden(), aplicar(), CambiosGre, greOtrosPrivado() (+69 more)

### Community 27 - "validaciones-cpe.ts"
Cohesion: 0.10
Nodes (33): potenciasDe10, ValorDecimal, LineaCpe, OpcionesValidacionCpe, ResultadoValidacionCpe, PATRON_SERIE_BOLETA, PATRON_SERIE_FACTURA, AcumuladorValidacion (+25 more)

### Community 28 - "validaciones-gre.ts"
Cohesion: 0.07
Nodes (62): CATALOGO_06_TIPOS_VALIDOS, CATALOGO_20_MOTIVOS_TRASLADO, CATALOGO_61_DOCUMENTOS_RELACIONADOS, DOCUMENTOS_RELACIONADOS_CON_SERIE, ID_ENVIO_GRE, MAXIMO_CONDUCTORES_GRE, MAXIMO_ITEMS_GRE, MOTIVO_GRE_OTROS (+54 more)

### Community 29 - "UsuarioToken"
Cohesion: 0.05
Nodes (8): CajaArqueoController, CajaSesionController, CarritoController, CuentaTiendaController, PedidoAdminController, PedidoController, UsuarioActual, UsuarioToken

### Community 30 - "producto-imagen.bussnies.ts"
Cohesion: 0.17
Nodes (9): ArchivoSubido, almacenamientoConfig, cloudinary, ProveedorAlmacen, ALMACEN_ARCHIVOS, AlmacenArchivos, ArchivoGuardado, almacenProvider (+1 more)

### Community 31 - "carrito.bussnies.ts"
Cohesion: 0.06
Nodes (15): CarritoBussnies, CarritoTienda, carritoVacio(), centavos(), ContextoCarrito, esViolacionUnica(), armar(), VACIO (+7 more)

### Community 32 - "resumen-caja-pdf.ts"
Cohesion: 0.10
Nodes (22): Alineacion, COLOR, DatosResumenCajaPdf, DibujoResumenCaja, EmisorResumenCajaPdf, FilaResumenCajaPdf, Fuente, generarResumenCajaPdf() (+14 more)

### Community 33 - "CuentaTiendaBussnies"
Cohesion: 0.06
Nodes (11): idOpcional(), CuentaTiendaBussnies, UsuarioAutenticado, OptionalJwtGuard, ActualizarItemCarritoRequest, AgregarItemCarritoRequest, FusionarCarritoRequest, CrearResenaRequest (+3 more)

### Community 34 - "documentos-prueba-spec.ts"
Cohesion: 0.09
Nodes (36): afectacionDesdeTipoIgv(), crearDocumentoPruebaBeta(), crearDocumentoPruebaUnidades(), serieBetaDe(), serieDePrueba(), AHORA, EMISOR, NUEVOS (+28 more)

### Community 35 - "app.module.ts"
Cohesion: 0.03
Nodes (37): @nestjs/typeorm, typeorm, CONSUMIDOR_FINAL, nombreAplicacionBd(), opcionesComunes(), opcionesPoolPostgres(), opcionesSsl(), OpcionSsl (+29 more)

### Community 36 - "constructor-resumen-diario.ts"
Cohesion: 0.06
Nodes (44): PLAZOS_ENVIO_DIAS, ConstructorGreUbl, texto(), hoyDeReferencia(), formatearDecimal(), MonedaCpe, aMilisegundosUtc(), diasEntre() (+36 more)

### Community 37 - "comprobante-pdf.ts"
Cohesion: 0.07
Nodes (37): Alineacion, AVISO_BETA_PDF, cantidad(), ClientePdfComprobante, COLOR, comoError(), conMiles(), CuotaPdfComprobante (+29 more)

### Community 38 - "nota-credito.bussnies.spec.ts"
Cohesion: 0.08
Nodes (44): MAXIMO_INTENTOS_NUMERO, cpe(), crear(), envio(), fila(), fiscal(), generarPdf, motorConOrigen() (+36 more)

### Community 39 - "proforma.bussnies.ts"
Cohesion: 0.10
Nodes (14): ConfigEmisor, CUENTAS_DOCUMENTO_POR_DEFECTO, DocumentoProforma, IProformaBussniees, CrearProformaRequest, EnviarCotizacionWaRequest, MarcarProformaRequest, ProformaItemRequest (+6 more)

### Community 40 - "ProductoImagen"
Cohesion: 0.10
Nodes (5): ProductoImagenBussnies, armar(), armarSubidas(), ProductoImagen, ProductoImagenRepository

### Community 41 - "nota-credito.integracion.spec.ts"
Cohesion: 0.08
Nodes (11): aceptarNota(), EMISOR, eventoAceptado(), facturaAceptada(), LineaOrigen, marcarAceptado(), SERIES, venta() (+3 more)

### Community 42 - "Dinero"
Cohesion: 0.08
Nodes (7): DecimalExacto, Dinero, dividirRedondeando(), formatearMonto(), potencia10(), redondear(), valorAbsoluto()

### Community 44 - "Empresa"
Cohesion: 0.07
Nodes (11): SunatController, SunatBussnies, ISunatBussniees, Empresa, Proveedor, BuscarDniRequest, BuscarRucEmpresaRequest, BuscarRucProveedorRequest (+3 more)

### Community 45 - "ProformaBussnies"
Cohesion: 0.19
Nodes (3): ProformaBussnies, ProformaResponse, nombreArchivoProforma()

### Community 46 - "reportes.bussnies.ts"
Cohesion: 0.13
Nodes (22): ClaseReporte, ComprobanteReporte, DetalleReporteVentas, idTipoDe(), MESES_CORTOS, OpcionesReporte, PERIODOS_VALIDOS, PLANES (+14 more)

### Community 47 - "admin.bussnies.ts"
Cohesion: 0.05
Nodes (6): AdminController, AdminBussnies, ActualizarEmpleadoRequest, CambiarRolRequest, CrearEmpleadoRequest, EliminarUsuarioRequest

### Community 48 - "sunat.catalogos.ts"
Cohesion: 0.04
Nodes (52): motivosDisponibles(), CatalogoMotivosResponse, AFECTACIONES_GRATUITAS, AFECTACIONES_ONEROSAS, AfectacionIgv, ALIAS_UNIDADES, CATALOGO_01_BOLETA, CATALOGO_01_FACTURA (+44 more)

### Community 49 - "package.json"
Cohesion: 0.04
Nodes (46): author, description, license, name, private, version, @anthropic-ai/sdk, better-sqlite3 (+38 more)

### Community 50 - "Dinero"
Cohesion: 0.04
Nodes (22): OpcionesSqlEsperado, sqlEsperadoTurno(), DeclaracionMedio, buscarDenominacion(), ConteoDenominacionEntrada, ConteoEfectivo, Denominacion, DENOMINACIONES_PEN (+14 more)

### Community 51 - "guia-remision-pdf.ts"
Cohesion: 0.09
Nodes (21): pdfkit, cantidad(), COLOR, DatosGuiaRemisionPdf, DibujoGuia, fecha(), Fila, generarGuiaRemisionPdf() (+13 more)

### Community 52 - "axios"
Cohesion: 0.20
Nodes (14): axios, config, mensaje, post, URL_BREVO, ErrorEnvioCorreo, MensajeCorreo, ResultadoEnvioCorreo (+6 more)

### Community 53 - "fecha-lima.ts"
Cohesion: 0.14
Nodes (34): aFechaLima(), cuatro(), DESFASE_LIMA_MINUTOS, diasEntreYmd(), dos(), fechaHoraLimaLegible(), FechaLimaInvalidaError, FiltroFechasLima (+26 more)

### Community 54 - "CajaPagosRepository"
Cohesion: 0.08
Nodes (3): CajaPagosController, CajaPagosBussnies, CajaPagosRepository

### Community 56 - "relanzarHttp"
Cohesion: 0.13
Nodes (10): CajaArqueoBussnies, esAdmin(), movimientoResponse(), turnoResponse(), relanzarHttp(), ArqueoDetalleResponse, ArqueoGuardado, TurnoArqueo (+2 more)

### Community 57 - "pago.bussnies.ts"
Cohesion: 0.08
Nodes (18): ENTORNO_ORIGINAL, escenario(), Estado, pasarelaConfig, esProduccion(), CambiarEstadoPedidoRequest, CrearPedidoRequest, RegistrarPagoRequest (+10 more)

### Community 58 - "RecepcionRepository"
Cohesion: 0.04
Nodes (15): ProveedorController, RecepcionController, RecepcionBussnies, armar(), tick(), LineaRecepcionInput, NuevaRecepcion, ObservacionCreada (+7 more)

### Community 59 - "nota-credito.bussnies.ts"
Cohesion: 0.06
Nodes (59): AVISO_MOTIVO, buscarAcreditable(), calcularAcreditable(), centesimas(), centimos(), ClaseAnulacion, CODIGOS_BAJA_CONFLICTO, conDosDecimales() (+51 more)

### Community 60 - "DibujoArqueo"
Cohesion: 0.30
Nodes (3): colorEstado(), DibujoArqueo, soles()

### Community 61 - "plataforma.registro.ts"
Cohesion: 0.10
Nodes (12): SaludController, CACHE_PING_MS, SaludBussnies, TIEMPO_MAXIMO_PING_MS, ISaludBussniees, versionDespliegue(), EstadoPingBd, ResultadoPingBd (+4 more)

### Community 62 - "logo-emisor.ts"
Cohesion: 0.07
Nodes (32): CLAVE_CONDICIONES_PROFORMA, CLAVES_EMISOR, CLAVES_SERIES, LOGO_EMISOR_OFICIAL, SERIES_POR_DEFECTO, logoPrueba(), cache, codificarPng() (+24 more)

### Community 63 - "CajaSesionRepository"
Cohesion: 0.11
Nodes (3): CajaSesionBussnies, armar(), CajaSesionRepository

### Community 64 - "AuthBussnies"
Cohesion: 0.13
Nodes (4): AuthBussnies, esCorreoDuplicado(), AuthBussnies, TokenUtil

### Community 65 - "comprobante.repository.ts"
Cohesion: 0.06
Nodes (23): PlanRegistro, COLUMNAS_EFECTOS_NOTA, COLUMNAS_NOTA, COLUMNAS_OPCIONALES, ComprobanteRepository, ComprobanteVigenteVenta, Consultor, DatosListadoComprobante (+15 more)

### Community 66 - "fiscal-tokens.ts"
Cohesion: 0.06
Nodes (32): main(), REGISTRO_NOTAS_CREDITO, RegistroModulo, unirRegistros(), REGISTRO_VENTA_DOCUMENTOS, EmisorFiscal, ContextoPruebaEnvio, EMISOR_PRUEBA_BETA (+24 more)

### Community 68 - "CuentaTiendaRepository"
Cohesion: 0.07
Nodes (4): DireccionEnvio, Favorito, Resena, CuentaTiendaRepository

### Community 69 - "guia-remision.bussnies.ts"
Cohesion: 0.04
Nodes (39): CAMPOS_FORMULARIO, CODIGOS_YA_REGISTRADA, DESCRIPCION_MODALIDAD, DESCRIPCION_MOTIVO, ESTADO_GUIA_TEXTO, esUnicaIdempotencia(), MENSAJE_ARCHIVO, milesimas() (+31 more)

### Community 71 - "ComprobanteCorreosRepository"
Cohesion: 0.10
Nodes (7): ComprobanteCorreosRepository, CorreoFila, CorreoComprobanteService, detalle(), fila(), montar(), correoValido()

### Community 72 - "errores-nucleo.ts"
Cohesion: 0.04
Nodes (62): adm-zip, ATRIBUTOS_CATALOGO_01, CATALOGO_51_VENTA_INTERNA, esConsumidorFinal(), GreInvalidaError, construirCadenaQr(), TIPOS_QR, construirXmlCpe() (+54 more)

### Community 73 - "registro-peticiones.middleware.ts"
Cohesion: 0.20
Nodes (8): CABECERA_ID_PETICION, Cabeceras, ContextoPeticion, DatosPeticion, crearMiddlewareRegistroPeticiones(), MARCA_ERROR_REGISTRADO, OpcionesRegistroPeticiones, rutaParaLog()

### Community 74 - "dependencies"
Cohesion: 0.06
Nodes (33): dependencies, adm-zip, @anthropic-ai/sdk, axios, bcrypt, better-sqlite3, class-transformer, class-validator (+25 more)

### Community 75 - "caja.request.ts"
Cohesion: 0.28
Nodes (9): AbrirCajaRequest, ActualizarCuentaBancariaRequest, AperturasCajaQuery, CerrarCajaRequest, CuentaBancariaRequest, IniciarYapeRequest, MovimientoCajaRequest, ResumenSucursalesPdfQuery (+1 more)

### Community 76 - "FiscalConfigService"
Cohesion: 0.05
Nodes (11): tokenApiPeruDeEntorno(), CertificadoParaChecklist, HechosPreparacion, DiagnosticoArranqueFiscal, FiscalConfigService, SnapshotConfigFiscal, construirVistaConfigFiscal(), ContextoGre (+3 more)

### Community 77 - "lotes-fiscales.service.ts"
Cohesion: 0.04
Nodes (58): aLinea(), aLote(), ambienteDe(), aVista(), CabeceraBaja, efectoDelCierre(), ESTADOS_COMPROBANTE_ACEPTADO, ESTADOS_LOTE_ABIERTOS (+50 more)

### Community 78 - "politica-limites.ts"
Cohesion: 0.06
Nodes (29): LimitePeticionesGuard, AlmacenLimites, ConsumoLimite, Contador, ResultadoLimite, CODIGO_DEMASIADAS_SOLICITUDES, DemasiadasPeticionesException, ALMACEN_LIMITES (+21 more)

### Community 79 - "cuerpoError"
Cohesion: 0.09
Nodes (11): crear(), crearServicio(), ventaGuardada(), VentaBussnies, CrearVentaRequest, EmitirComprobanteVentaRequest, ItemVentaRequest, PagoVentaRequest (+3 more)

### Community 80 - "devDependencies"
Cohesion: 0.06
Nodes (31): devDependencies, eslint, eslint-config-prettier, @eslint/eslintrc, @eslint/js, eslint-plugin-prettier, globals, jest (+23 more)

### Community 81 - "GuardarGuiaRemisionRequest"
Cohesion: 0.17
Nodes (13): AnularGuiaRemisionRequest, CODIGOS_UNIDAD, ConductorGuiaRequest, DestinatarioGuiaRequest, GuardarGuiaRemisionRequest, ItemGuiaRequest, ListarGuiasRemisionRequest, PuntoGuiaRequest (+5 more)

### Community 82 - "rol.bussnies.ts"
Cohesion: 0.09
Nodes (6): RolController, RolBussnies, ROLES_PROTEGIDOS, ROL_IDS, ActualizarRolRequest, CrearRolRequest

### Community 83 - "proforma.repository.ts"
Cohesion: 0.11
Nodes (15): codigoErrorBd(), codigoProforma(), detalleBd(), esChoqueDeCodigo(), esChoqueDePk(), LIMITE_NUMERO_HEREDADO, NuevaProforma, NuevoItemProforma (+7 more)

### Community 84 - "enmascarar.ts"
Cohesion: 0.12
Nodes (14): Registrador, RegistroTypeorm, decodificarSeguro(), enmascararDatosPersonales(), enmascararTexto(), LARGO_MAXIMO_RUTA, LARGO_MAXIMO_SQL, mensajePgSeguro() (+6 more)

### Community 86 - "DibujoProforma"
Cohesion: 0.23
Nodes (3): DibujoProforma, generarProformaPdf(), PDFDocument

### Community 87 - "main.ts"
Cohesion: 0.10
Nodes (25): AppModule, postgresConfigurado(), JWT_DEFAULT_DEV, booleanoEntorno(), FALSOS, LimitesNumericos, VERDADEROS, bootstrap() (+17 more)

### Community 89 - "reporte-ventas-pdf.ts"
Cohesion: 0.16
Nodes (26): ABREVIATURA_TIPO, Alineacion, cantidad(), COLOR, ColumnaPdf, entero(), Fuente, generarReporteVentasPdf() (+18 more)

### Community 90 - "documento-fiscal.types.ts"
Cohesion: 0.04
Nodes (68): cdrDe(), CuotaCpe, DatosCadenaQr, EstadoComprobanteSunat, OperacionSunat, TipoCpe, ConfiguracionSoapInvalidaError, cdrPrueba() (+60 more)

### Community 91 - "compilerOptions"
Cohesion: 0.07
Nodes (26): compilerOptions, allowSyntheticDefaultImports, declaration, emitDecoratorMetadata, esModuleInterop, experimentalDecorators, forceConsistentCasingInFileNames, ignoreDeprecations (+18 more)

### Community 93 - "caja-sesion.bussnies.ts"
Cohesion: 0.13
Nodes (14): MONTO_INICIAL_MAXIMO, montoInicialDeApertura(), usuario, CodigoErrorCaja, CodigoErrorCajaTipo, cuerpoErrorCaja(), ErrorCaja, mensajeScriptPendiente() (+6 more)

### Community 94 - "clasificador-gre.ts"
Cohesion: 0.26
Nodes (18): base(), clasificarConsultaGre(), clasificarEnvioGre(), codigoParaBuscar(), CODIGOS_CONFIGURACION, CODIGOS_YA_REGISTRADA, comoObjeto(), crearError() (+10 more)

### Community 99 - "CreditoRepository"
Cohesion: 0.06
Nodes (10): CreditoController, CreditoBussnies, CreditoVencimientosTarea, intervaloVencimientosMs(), AbonoCreditoRequest, LineaCreditoRequest, CreditoRepository, ESTADOS_CXC (+2 more)

### Community 102 - "clasificador-respuesta.ts"
Cohesion: 0.11
Nodes (27): clasificadorPorOmision, ClasificadorRespuestaSunat, clasificarRespuesta(), CODIGOS_BAJA_FUERA_DE_PLAZO, CODIGOS_CERTIFICADO, CODIGOS_CREDENCIAL_SOL, CODIGOS_DOCUMENTO_ALTERADO, CODIGOS_EMISOR_NO_HABILITADO (+19 more)

### Community 103 - "class-validator"
Cohesion: 0.14
Nodes (8): class-transformer, class-validator, FormaPagoComprobante, FORMAS_PAGO_COMPROBANTE, AMBIENTES_FISCALES, Transformacion, ESTADOS_SUNAT, Transformacion

### Community 104 - "venta-documentos.repository.ts"
Cohesion: 0.08
Nodes (29): SeriesPosResponse, FilaProductoCotizado, FilaProductoVendido, ReportesQueryFilters, booleano(), clienteDe(), esPrincipalVigente(), FiltroVentasSinComprobante (+21 more)

### Community 105 - "ProductoBussnies"
Cohesion: 0.09
Nodes (5): ProductoBussnies, conQuery(), crear(), FilaProductoSinCodigoSunat, ProductoRepository

### Community 106 - "checklist-activacion.ts"
Cohesion: 0.16
Nodes (22): advertencias(), checklist(), ChecklistDocumento, detalleSecreto(), evaluarPreparacion(), fechaCorta(), item(), itemConfirmacion() (+14 more)

### Community 107 - "InventarioBussnies"
Cohesion: 0.12
Nodes (5): InventarioBussnies, traducirErrorStock(), ActualizarInventarioRequest, AjustarStockRequest, TransferirStockRequest

### Community 108 - "nota-credito.controller.spec.ts"
Cohesion: 0.13
Nodes (6): NotaCreditoController, Clase, contexto(), crear(), metodoDe(), rutas()

### Community 109 - "caja-turnos.bussnies.ts"
Cohesion: 0.08
Nodes (20): admin, armar(), cajero, filasEfectivo140, turno(), admin, armar(), cajero (+12 more)

### Community 110 - "ReportesBussnies"
Cohesion: 0.16
Nodes (10): exceljs, clasificarComprobanteReporte(), diaLimaComprobante(), ReportesBussnies, armar(), leer(), logoMock, claveTipoReporte() (+2 more)

### Community 111 - "roles.config.ts"
Cohesion: 0.13
Nodes (8): RolesAdminController, ALIAS_ROL, esRolCliente(), esRolConsulta(), esRolStaff(), normalizarRol(), STAFF_ROL_IDS, STAFF_ROL_NOMBRES

### Community 112 - "RegistrarArqueoRequest"
Cohesion: 0.20
Nodes (5): DenominacionArqueoRequest, MedioDeclaradoRequest, PdfArqueoQuery, RegistrarArqueoRequest, TurnoQuery

### Community 113 - "correo-comprobante.service.ts"
Cohesion: 0.16
Nodes (14): CLAVE_CORREO_ENVIO_ACTIVO, DetalleParaCorreo, EstadoCorreoDetalle, ESTADOS_ACEPTADOS, ResultadoProceso, ResumenCorreoComprobante, AdjuntoCorreo, armarCorreoComprobante() (+6 more)

### Community 115 - "reporte-ventas-excel.ts"
Cohesion: 0.11
Nodes (27): aFecha(), agregarHoja(), agregarResumen(), ARGB, bloqueTitulo(), bordeFino, bordes, cabeceraTabla() (+19 more)

### Community 116 - "reglas-postgres.ts"
Cohesion: 0.13
Nodes (15): BD_NO_DISPONIBLE, campo(), claveForanea(), columnasDeDetalle(), DATO_INVALIDO, duplicado(), ESQUEMA_PENDIENTE, Fabrica (+7 more)

### Community 118 - "InventarioRepository"
Cohesion: 0.13
Nodes (4): FiltroInventario, InventarioRepository, armar(), fila

### Community 119 - "WhatsappPasarela"
Cohesion: 0.18
Nodes (6): armar(), armarCreacion(), whatsappCloudListo(), whatsappConfig, ResultadoEnvioWa, WhatsappPasarela

### Community 120 - "StockTiendaRepository"
Cohesion: 0.15
Nodes (7): LineaReserva, ModoStockTienda, PoliticaStockTienda, ReservaAplicada, armar(), dataSourceCon(), StockTiendaRepository

### Community 121 - "guia-remision.repository.ts"
Cohesion: 0.07
Nodes (32): ContextoDocumento, DefectosGuardado, sha256(), aFila(), AlmacenSalidaGuia, archivosDe(), CierreConsultaGuia, COLUMNAS_GUARDADO (+24 more)

### Community 123 - "correo.config.ts"
Cohesion: 0.24
Nodes (11): ConfigCorreo, Entorno, fabricarEnviador(), leerConfigCorreo(), ProveedorCorreo, texto(), EnviadorArchivo, EnviadorBrevo (+3 more)

### Community 124 - "filtro-errores.filter.ts"
Cohesion: 0.09
Nodes (39): CAMPOS_RESERVADOS, ErrorConCodigo, esErrorConCodigo(), esObjetoPlano(), estadoDeclarado(), sinCamposReservados(), ErrorTraducido, NivelRegistro (+31 more)

### Community 125 - "gre-emision.service.spec.ts"
Cohesion: 0.22
Nodes (10): Cambios, CERTIFICADO, certificadoInfo(), crear(), CREDENCIALES, snapshot(), preparar(), generarCertificadoPrueba() (+2 more)

### Community 128 - "UserController"
Cohesion: 0.10
Nodes (6): bcrypt, UserController, UserService, UserRequest, UserResponse, UserMapper

### Community 129 - "listar-ventas.request.ts"
Cohesion: 0.17
Nodes (10): ymdLegible(), diaLima(), ESTADOS_VENTA, ListarVentasRequest, ListarVentasSinComprobanteRequest, noAntesDeDesde(), OPCIONES_TIENE_COMPROBANTE, PaginaVentasRequest (+2 more)

### Community 131 - "filtro-errores.filter.spec.ts"
Cohesion: 0.16
Nodes (6): ErrorDominio, EsquemaPendienteError, consultaFallida(), ejecutar(), errorPg(), RespuestaFalsa

### Community 132 - "caja.registro.ts"
Cohesion: 0.17
Nodes (3): REGISTRO_CAJA, CajaArqueoDenominacion, CajaArqueo

### Community 133 - "mensajes-validacion.ts"
Cohesion: 0.13
Nodes (12): aplanarErroresValidacion(), cuerpoErrorValidacion, ErrorDeCampo, etiquetaCampo(), legible(), PREDICADOS, LineaDto, VentaDto (+4 more)

### Community 135 - "loginController"
Cohesion: 0.16
Nodes (3): loginController, authRequest, RegisterRequest

### Community 136 - "scripts"
Cohesion: 0.14
Nodes (14): scripts, build, fiscal:preparar-local, format, lint, start, start:debug, start:dev (+6 more)

### Community 137 - "qr.ts"
Cohesion: 0.22
Nodes (11): qrcode, codificarQrPng(), CORRECCIONES, CorreccionQr, crc32(), generarQrPng(), OpcionesQrPng, leerModulos() (+3 more)

### Community 138 - "comprobante-correos.repository.ts"
Cohesion: 0.15
Nodes (9): DIAS_SIEMBRA_CORREO, EstadoCorreo, OrigenCorreo, SEGUNDOS_RECLAMO_CORREO, consultorFalso(), crear(), Llamada, CorreoComprobantesTarea (+1 more)

### Community 140 - "guia-remision.controller.spec.ts"
Cohesion: 0.08
Nodes (19): CUERPO_VALIDO, servicio, validar(), contexto(), mensajes(), Metodo, metodoDe(), rutasGet() (+11 more)

### Community 141 - "EmitirNotaCreditoRequest"
Cohesion: 0.15
Nodes (4): SolicitudPlanNota, AnularDocumentoRequest, EmitirNotaCreditoRequest, ItemNotaCreditoRequest

### Community 142 - "numero-letras.ts"
Cohesion: 0.26
Nodes (12): apocopar(), CENTENAS, centenasALetras(), DECENAS, decenasALetras(), enteroALetras(), grupoALetras(), hastaMillonALetras() (+4 more)

### Community 143 - "jest"
Cohesion: 0.17
Nodes (12): jest, collectCoverageFrom, coverageDirectory, maxWorkers, moduleFileExtensions, moduleNameMapper, rootDir, testEnvironment (+4 more)

### Community 144 - ".pasosLocales"
Cohesion: 0.22
Nodes (4): CredencialesSol, DocumentoPrueba, mensajeDe(), PruebaConexionFiscalService

### Community 146 - "log-repository.ts"
Cohesion: 0.11
Nodes (9): LogBussnies, SCRIPT_TABLA_AUDITORIA, ILogBussniees, Auditoria, RegistroLogResponse, ILogRepository, esTablaInexistente(), limitar() (+1 more)

### Community 147 - "caja-sesion.repository.ts"
Cohesion: 0.06
Nodes (24): CapacidadCaja, EFECTO_SI_FALTA, EsquemaCajaService, REQUISITOS, SCRIPT_POR_CAPACIDAD, SnapshotEsquema, snapshot(), TablaCaja (+16 more)

### Community 148 - "ProductoResponse"
Cohesion: 0.14
Nodes (7): IProductoBussniees, CANTIDAD_MAXIMA_OPERACION, ActualizarProductoRequest, AsignacionCodigoSunat, CrearProductoRequest, MAX_ASIGNACIONES_CODIGO_SUNAT, ProductoResponse

### Community 149 - "comprobante-pdf.spec.ts"
Cohesion: 0.21
Nodes (11): ItemPdfComprobante, boleta(), credito(), decodificar(), factura(), item(), notaCredito(), paginas() (+3 more)

### Community 150 - "preparar-fiscal-local.cjs"
Cohesion: 0.18
Nodes (6): archivoLlave, dotenv, fs, path, raiz, { randomBytes, X509Certificate }

### Community 153 - "CatalogoRepository"
Cohesion: 0.11
Nodes (4): CatalogoRepository, patronContiene(), armar(), FILTROS

### Community 155 - "deploy"
Cohesion: 0.20
Nodes (9): build, buildCommand, deploy, healthcheckPath, healthcheckTimeout, restartPolicyMaxRetries, restartPolicyType, startCommand (+1 more)

### Community 156 - "README.md"
Cohesion: 0.20
Nodes (9): Compile and run the project, Deployment, Description, License, Project setup, Resources, Run tests, Stay in touch (+1 more)

### Community 157 - "ConfiguracionRepository"
Cohesion: 0.09
Nodes (5): ConfiguracionController, ConfiguracionFiscalBussnies, ConfiguracionRepository, repositorio(), partirUbicacion()

### Community 158 - "producto.bussnies.ts"
Cohesion: 0.13
Nodes (18): ResultadoAsignacionCodigosSunat, armar(), conSecuencia(), FilaProducto, normalizarUnidad(), Base, GRUPOS_UNIDADES, GrupoUnidad (+10 more)

### Community 159 - "ReportesRepository"
Cohesion: 0.20
Nodes (3): ReportesRepository, armar(), aTimestampUtc()

### Community 160 - "traductor-errores-bd.ts"
Cohesion: 0.25
Nodes (12): mensajePorEstado(), InfoErrorPg, reglaParaErrorPg(), BD_NO_DISPONIBLE, CODIGOS_DE_RED, desdeSqlState(), ErrorPgCrudo, esFallaDeConexion() (+4 more)

### Community 161 - "calculo-fiscal.ts"
Cohesion: 0.15
Nodes (13): calcularLinea(), desagregarIgv(), LineaFiscal, LineaFiscalEntrada, normalizarTipoIgv(), PORCENTAJE_IGV_POR_DEFECTO, TIPO_IGV_EXONERADO, TIPO_IGV_GRAVADO (+5 more)

### Community 162 - "VentaTiendaRepository"
Cohesion: 0.27
Nodes (3): armar(), PAGADO, VentaTiendaRepository

### Community 163 - "UbigeoService"
Cohesion: 0.20
Nodes (4): aUbigeo(), normalizarTextoUbigeo(), UbigeoService, PuntoGuiaResponse

### Community 167 - "base-datos.almacen.ts"
Cohesion: 0.13
Nodes (5): ArchivoController, ArchivoEntrada, BaseDatosAlmacen, armar(), SQL_BORRAR_ARCHIVO_SIN_USO

### Community 168 - "errores-fiscales.interceptor.ts"
Cohesion: 0.16
Nodes (9): rxjs, ErroresSubidaImagenInterceptor, MAXIMO_FOTOS_POR_LOTE, comoNest, traducirErrorSubidaImagen(), conGuiaGuardada(), ErroresFiscalesInterceptor, traducirErrorFiscal() (+1 more)

### Community 169 - "catalogo.bussnies.ts"
Cohesion: 0.27
Nodes (9): CategoriaTiendaResponse, EspecificacionResponse, FiltrosDisponiblesResponse, FiltroValorResponse, ImagenResponse, MarcaTiendaResponse, PaginaResponse, ProductoDetalleResponse (+1 more)

### Community 172 - "inventario.bussnies.ts"
Cohesion: 0.24
Nodes (3): ETIQUETA_MOTIVO, IInventarioBussniees, InventarioResponse

### Community 173 - "nest-cli.json"
Cohesion: 0.33
Nodes (5): collection, compilerOptions, deleteOutDir, $schema, sourceRoot

### Community 175 - "arqueo-pdf.ts"
Cohesion: 0.23
Nodes (12): Alineacion, COLOR, DatosArqueoPdf, EmisorArqueoPdf, etiquetaEstado(), fecha(), Fuente, generarArqueoPdf() (+4 more)

### Community 178 - "venta-documentos.integracion.spec.ts"
Cohesion: 0.25
Nodes (10): ADMIN, cliente(), comprobante(), ComprobanteNuevo, EMISOR, guia(), SERIES, uno() (+2 more)

### Community 179 - "CatalogoBussnies"
Cohesion: 0.27
Nodes (6): CatalogoBussnies, limiteSeguro(), armar(), textoBusqueda(), ProductoTiendaResponse, FiltrosCatalogo

### Community 180 - "ActualizarConfigFiscalDto"
Cohesion: 0.25
Nodes (6): ActualizarConfigFiscalDto, esMapaCorrelativoInicial(), ConfirmacionesActivacion, ModoBoletas, ModoReglas2027, CambiosConfigFiscal

### Community 181 - "compresion.ts"
Cohesion: 0.24
Nodes (9): compression, crearMiddlewareCompresion(), debeComprimir(), JSON_GRANDE, peticion, TEXTO_GRANDE, textoCabecera(), TIPOS_SIN_COMPRESION (+1 more)

### Community 182 - "proforma-documento.paleta.spec.ts"
Cohesion: 0.50
Nodes (4): ColorPaleta, contraste(), luminancia(), PARES

### Community 183 - "tsconfig.build.json"
Cohesion: 0.50
Nodes (3): ./tsconfig.json, exclude, extends

## Knowledge Gaps
- **859 isolated node(s):** `$schema`, `collection`, `sourceRoot`, `deleteOutDir`, `name` (+854 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1924 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **47 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@nestjs/common` connect `@nestjs/common` to `UserController`, `Pedido`, `pedido.bussnies.ts`, `certificado-fiscal.service.ts`, `AmbienteFiscal`, `auth.bussnies.ts`, `ActorFiscal`, `venta.repository.ts`, `guia-remision.bussnies.spec.ts`, `filtro-errores.filter.spec.ts`, `comprobante-correos.repository.ts`, `mensajes-validacion.ts`, `guia-remision.controller.spec.ts`, `comprobante.bussnies.ts`, `venta-documentos.bussnies.ts`, `NotaCreditoBussnies`, `log-repository.ts`, `caja-sesion.repository.ts`, `caja-arqueo.bussnies.ts`, `Cliente`, `AppService`, `fiscal-config.dto.ts`, `FiscalConfigError`, `producto.bussnies.ts`, `producto-imagen.bussnies.ts`, `carrito.bussnies.ts`, `CuentaTiendaBussnies`, `app.module.ts`, `nota-credito.bussnies.spec.ts`, `base-datos.almacen.ts`, `errores-fiscales.interceptor.ts`, `nota-credito.integracion.spec.ts`, `proforma.bussnies.ts`, `catalogo.bussnies.ts`, `inventario.bussnies.ts`, `Empresa`, `reportes.bussnies.ts`, `admin.bussnies.ts`, `package.json`, `venta-documentos.integracion.spec.ts`, `Dinero`, `pago.bussnies.ts`, `RecepcionRepository`, `nota-credito.bussnies.ts`, `plataforma.registro.ts`, `logo-emisor.ts`, `comprobante.repository.ts`, `fiscal-tokens.ts`, `guia-remision.bussnies.ts`, `ComprobanteCorreosRepository`, `registro-peticiones.middleware.ts`, `caja.request.ts`, `lotes-fiscales.service.ts`, `politica-limites.ts`, `cuerpoError`, `rol.bussnies.ts`, `proforma.repository.ts`, `enmascarar.ts`, `main.ts`, `caja-sesion.bussnies.ts`, `CreditoRepository`, `venta-documentos.repository.ts`, `nota-credito.controller.spec.ts`, `caja-turnos.bussnies.ts`, `ReportesBussnies`, `correo-comprobante.service.ts`, `WhatsappPasarela`, `StockTiendaRepository`, `guia-remision.repository.ts`, `correo.config.ts`, `filtro-errores.filter.ts`?**
  _High betweenness centrality (0.250) - this node is a cross-community bridge._
- **What connects `$schema`, `collection`, `sourceRoot` to the rest of the system?**
  _859 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `certificado-fiscal.service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.03979511426319937 - nodes in this community are weakly interconnected._
- **Why does `UsuarioToken` connect `UsuarioToken` to `fiscal-config.tipos.ts`, `venta-documentos.bussnies.ts`, `NotaCreditoBussnies`, `@nestjs/common`, `caja-arqueo.bussnies.ts`, `GuiaRemisionController`, `fiscal-config.dto.ts`, `CuentaTiendaBussnies`, `FiscalAdminController`, `venta-documentos.integracion.spec.ts`, `VentaController`, `relanzarHttp`, `RecepcionRepository`, `CajaSesionRepository`, `EmisorBetaDto`, `ComprobanteController`, `cuerpoError`, `.confirmarAceptado`, `caja-sesion.bussnies.ts`, `CreditoRepository`, `ProductoController`, `nota-credito.controller.spec.ts`, `caja-turnos.bussnies.ts`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **Should `Pedido` be split into smaller, more focused modules?**
  _Cohesion score 0.04225932797361369 - nodes in this community are weakly interconnected._
- **Why does `Roles()` connect `@nestjs/common` to `UserController`, `auth.bussnies.ts`, `AlmacenController`, `guia-remision.controller.spec.ts`, `ReportesController`, `EjecutorSql`, `Cliente`, `GuiaRemisionController`, `fiscal-config.dto.ts`, `BetaAdminController`, `ConfiguracionRepository`, `UsuarioToken`, `FiscalAdminController`, `Empresa`, `admin.bussnies.ts`, `CajaPagosRepository`, `VentaController`, `RecepcionRepository`, `LogController`, `ProformaController`, `ComprobanteController`, `rol.bussnies.ts`, `LotesAdminController`, `StockSucursalBussnies`, `ReceptorRepository`, `ReceptorController`, `CategoriaController`, `CreditoRepository`, `ProductoController`, `InventarioBussnies`, `nota-credito.controller.spec.ts`, `roles.config.ts`, `ProductoImagenController`, `MarcaController`, `InventarioController`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **Should `pedido.bussnies.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.04750512645249488 - nodes in this community are weakly interconnected._