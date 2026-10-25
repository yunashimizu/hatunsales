import type { CertificadoInfoVista } from '../certificado/certificado-info';
import type { EstadoCredencialesGre } from '../seguridad/credenciales-gre.service';
import type { EstadoCredencialesSol } from '../seguridad/credenciales-sol.service';
import type { ResultadoPreparacion } from './checklist-activacion';
import type { EstadoEsquemaFiscal } from './fiscal-esquema.service';
import {
  AmbienteFiscal,
  AVISO_LEGAL_OSE,
  BloqueoEmision,
  ConfirmacionNoOse,
  ModoBoletas,
  ModoReglas2027,
  ProveedorFiscal,
  SeriesFiscales,
  SnapshotConfigFiscal,
  TIPOS_SERIE_CPE,
} from './fiscal-config.tipos';

/**
 * Respuesta de GET /fiscal/configuracion (y de PUT, más `advertencias`).
 * Nunca incluye secretos: de las claves solo se informa si existen.
 */
export interface ConfiguracionFiscalVista {
  /** Lo elegido en el panel: sunat_directo = emisión de producción activa; nubefact = sin emisión electrónica. */
  proveedor: ProveedorFiscal;
  proveedor_efectivo: ProveedorFiscal;
  ambiente: AmbienteFiscal;
  boletas_modo: ModoBoletas;
  envio_en_linea: boolean;
  tareas_activas: boolean;
  aplicar_reglas_2027: ModoReglas2027;
  series: SeriesFiscales;
  emisor: {
    ruc: string;
    razon_social: string;
    nombre_comercial: string;
    direccion: string;
    ubigeo: string;
    distrito: string;
    provincia: string;
    departamento: string;
    codigo_establecimiento: string;
  };
  codigo_producto_defecto: string | null;
  sol: EstadoCredencialesSol;
  gre: {
    activa: boolean;
    serie: string;
    correlativo_inicial: number;
    partida: {
      ubigeo: string;
      direccion: string;
      codigo_establecimiento: string;
      /** true en los campos que se toman del emisor porque no se configuraron. */
      heredada_del_emisor: { ubigeo: boolean; direccion: boolean; codigo_establecimiento: boolean };
    };
    credenciales: EstadoCredencialesGre;
  };
  tiene_credenciales_gre: boolean;
  certificado: Record<AmbienteFiscal, CertificadoInfoVista | null>;
  confirmacion_no_ose: ConfirmacionNoOse | null;
  aviso_legal_ose: typeof AVISO_LEGAL_OSE;
  /** Primer número libre de cada serie de comprobante configurada (1 = desde el principio). */
  correlativo_inicial: Record<string, number>;
  /** false hasta que el administrador guarde el correlativo inicial (aunque sea con 1 en todas). */
  correlativo_inicial_revisado: boolean;
  /** El administrador confirmó que el certificado de producción (sin RUC legible) es del emisor. */
  cert_ruc_confirmado: boolean;
  /** Declaraciones sobre lo que solo se ve en SOL (D1.4). */
  confirmaciones: {
    emisor_electronico_sol: boolean;
    certificado_en_sol: boolean;
    usuario_sol_secundario: boolean;
    ruc_habido: boolean;
  };
  /** Interruptor de emisión por ambiente (solo lectura: se limpia con «Reanudar emisión» o al corregir la causa). */
  emision_bloqueada: Record<AmbienteFiscal, BloqueoEmision | null>;
  estado: {
    esquema: { listo: boolean; verificado: boolean; script: string; mensaje: string | null; faltantes: string[] };
    cifrado_disponible: boolean;
    /** Por qué no hay cifrado (sin revelar la llave), o null. */
    cifrado_problema: string | null;
    /** Token de ApiPeru (autocompletar DNI/RUC del POS) presente en variables o en configuraciones. */
    consulta_documentos_configurada: boolean;
    listo_para_produccion: boolean;
    gre_lista_para_produccion: boolean;
    faltantes: string[];
    advertencias: string[];
    checklist: ResultadoPreparacion['checklist'];
    pruebas_beta: ResultadoPreparacion['pruebas_beta'];
  };
}

export interface DatosVistaConfigFiscal {
  snapshot: SnapshotConfigFiscal;
  proveedorEfectivo: ProveedorFiscal;
  sol: EstadoCredencialesSol;
  gre: EstadoCredencialesGre;
  certificados: Record<AmbienteFiscal, CertificadoInfoVista | null>;
  preparacion: ResultadoPreparacion;
  esquema: EstadoEsquemaFiscal;
  scriptEsquema: string;
  cifrado: { disponible: boolean; problema: string | null };
  consultaDocumentosConfigurada: boolean;
}

/** Arma la vista a partir de datos ya reunidos (función pura). */
export function construirVistaConfigFiscal(d: DatosVistaConfigFiscal): ConfiguracionFiscalVista {
  const s = d.snapshot;
  return {
    proveedor: s.proveedor,
    proveedor_efectivo: d.proveedorEfectivo,
    ambiente: s.ambiente,
    boletas_modo: s.boletasModo,
    envio_en_linea: s.envioEnLinea,
    tareas_activas: s.tareasActivas,
    aplicar_reglas_2027: s.reglas2027,
    series: { ...s.series },
    emisor: {
      ruc: s.emisor.ruc,
      razon_social: s.emisor.razonSocial,
      nombre_comercial: s.emisor.nombreComercial ?? '',
      direccion: s.emisor.direccion,
      ubigeo: s.emisor.ubigeo,
      distrito: s.emisor.distrito,
      provincia: s.emisor.provincia,
      departamento: s.emisor.departamento,
      codigo_establecimiento: s.emisor.codigoEstablecimiento,
    },
    codigo_producto_defecto: s.codigoProductoDefecto,
    sol: { ...d.sol },
    gre: {
      activa: s.gre.activa,
      serie: s.gre.serie,
      correlativo_inicial: s.gre.correlativoInicial,
      partida: {
        ubigeo: s.gre.partida.ubigeo,
        direccion: s.gre.partida.direccion,
        codigo_establecimiento: s.gre.partida.codigoEstablecimiento,
        heredada_del_emisor: {
          ubigeo: s.gre.partidaHeredada.ubigeo,
          direccion: s.gre.partidaHeredada.direccion,
          codigo_establecimiento: s.gre.partidaHeredada.codigoEstablecimiento,
        },
      },
      credenciales: { ...d.gre },
    },
    tiene_credenciales_gre: d.gre.tiene_credenciales,
    certificado: { beta: d.certificados.beta, produccion: d.certificados.produccion },
    confirmacion_no_ose: s.confirmacionNoOse ? { ...s.confirmacionNoOse } : null,
    aviso_legal_ose: AVISO_LEGAL_OSE,
    correlativo_inicial: Object.fromEntries(
      TIPOS_SERIE_CPE.map((tipo) => [s.series[tipo], s.correlativoInicialCpe[s.series[tipo]] ?? 1]),
    ),
    correlativo_inicial_revisado: s.correlativoInicialRevisado,
    cert_ruc_confirmado: s.certRucConfirmadoProduccion,
    confirmaciones: {
      emisor_electronico_sol: s.confirmaciones.emisorElectronicoSol,
      certificado_en_sol: s.confirmaciones.certificadoEnSol,
      usuario_sol_secundario: s.confirmaciones.usuarioSolSecundario,
      ruc_habido: s.confirmaciones.rucHabido,
    },
    emision_bloqueada: {
      beta: s.bloqueos.beta ? { ...s.bloqueos.beta } : null,
      produccion: s.bloqueos.produccion ? { ...s.bloqueos.produccion } : null,
    },
    estado: {
      esquema: {
        listo: d.esquema.listo,
        verificado: d.esquema.verificado,
        script: d.scriptEsquema,
        mensaje: d.esquema.mensaje,
        faltantes: [...d.esquema.faltantes],
      },
      cifrado_disponible: d.cifrado.disponible,
      cifrado_problema: d.cifrado.problema,
      consulta_documentos_configurada: d.consultaDocumentosConfigurada,
      listo_para_produccion: d.preparacion.listo,
      gre_lista_para_produccion: d.preparacion.checklist.gre.listo,
      faltantes: [...d.preparacion.faltantes],
      advertencias: [...d.preparacion.advertencias],
      checklist: d.preparacion.checklist,
      pruebas_beta: d.preparacion.pruebas_beta,
    },
  };
}
