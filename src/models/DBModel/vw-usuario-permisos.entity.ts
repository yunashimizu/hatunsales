import { ViewEntity, ViewColumn } from 'typeorm';

@ViewEntity({
  name: 'vw_usuario_permisos',
  synchronize: false,   // ← importante: no tocar la vista, ya existe en la BD
})
export class VwUsuarioPermisos {

  @ViewColumn()
  id_usuario!: number;

  @ViewColumn()
  usuario!: string;

  @ViewColumn()
  rol!: string;

  @ViewColumn()
  permiso!: string;
}