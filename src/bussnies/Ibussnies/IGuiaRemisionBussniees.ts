import type {
  AnularGuiaRemisionRequest,
  GuardarGuiaRemisionRequest,
  ListarGuiasRemisionRequest,
} from '../../models/model/guia-remision.request';
import type {
  CatalogosGuiaResponse,
  ContextoVentaGuiaResponse,
  GuiaRemisionResponse,
  ListadoGuiasRemisionResponse,
  OperacionGuiaResponse,
  TipoArchivoGuia,
  ValidacionGuiaResponse,
} from '../../models/model/guia-remision.response';
import type { ModoEmisionGre } from '../../sunat/gre/gre.contrato';

export interface IGuiaRemisionBussniees {
  listar(filtro: ListarGuiasRemisionRequest): Promise<ListadoGuiasRemisionResponse>;
  obtener(idGuia: number): Promise<GuiaRemisionResponse>;
  modo(): Promise<ModoEmisionGre>;
  catalogos(): CatalogosGuiaResponse;
  contextoVenta(idVenta: number): Promise<ContextoVentaGuiaResponse>;
  crear(dto: GuardarGuiaRemisionRequest, idUsuario: number | null): Promise<GuiaRemisionResponse>;
  actualizar(idGuia: number, dto: GuardarGuiaRemisionRequest): Promise<GuiaRemisionResponse>;
  validar(idGuia: number): Promise<ValidacionGuiaResponse>;
  crearYEmitir(dto: GuardarGuiaRemisionRequest, idUsuario: number | null): Promise<OperacionGuiaResponse>;
  emitir(idGuia: number, idUsuario: number | null): Promise<OperacionGuiaResponse>;
  consultar(idGuia: number): Promise<OperacionGuiaResponse>;
  anular(idGuia: number, dto: AnularGuiaRemisionRequest, idUsuario: number | null): Promise<GuiaRemisionResponse>;
  pdf(idGuia: number): Promise<{ nombre: string; contenido: Buffer }>;
  archivo(idGuia: number, tipo: TipoArchivoGuia): Promise<{ nombre: string; mime: string; contenido: Buffer }>;
}
