export class loginResponse {
  id_usuario!: number;
  nombre!: string;
  email!: string;
  rol!: string;
  permisos!: string[];
  access_token!: string;
  expires_in!: string;
}