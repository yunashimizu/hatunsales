export class ClienteResponse {
  id_cliente!: number;
  nombre!: string;
  apellido_paterno!: string;
  apellido_materno!: string;
  nombre_completo!: string;
  dni?: number;
  telefono?: string;
  email?: string;
  direccion?: string;
  tipo_documento?: string;
  numero_documento?: number;
  tiene_cuenta!: boolean;
  id_usuario?: number;
  creado_en?: Date;
}

export class EmpresaResponse {
  id_empresa!: number;
  ruc!: string;
  razon_social!: string;
  nombre_comercial?: string;
  telefonos?: string[];
  tipo?: string;
  estado?: string;
  condicion?: string;
  direccion?: string;
  departamento?: string;
  provincia?: string;
  distrito?: string;
  ubigeo?: string;
  capital?: string;
  fecha_inscripcion?: string;
  fecha_baja?: string;
  creado_en?: Date;
}