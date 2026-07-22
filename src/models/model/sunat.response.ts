export class DniResponse {
  success!: boolean;
  dni!: string;
  nombre!: string;
  apellido_paterno!: string;
  apellido_materno!: string;
  nombre_completo!: string;
  tipo_documento!: string;
  numero_documento!: number;
  id_cliente?: number;
  id_documento?: number;
  guardado!: boolean;
}

export class RucResponse {
  success!: boolean;
  id_empresa?: number;
  id_proveedor?: number;
  ruc!: string;
  nombre!: string;
  nombre_comercial!: string | null;
  telefono!: string;
  email!: string;
  direccion!: string;
  departamento!: string;
  provincia!: string;
  distrito!: string;
  ubigeo!: string;
  capital!: string;
  estado!: string;
  condicion!: string;
  tipo!: string | null;
  fecha_inscripcion!: string | null;
  fecha_baja!: string | null;
  guardado!: boolean;
}