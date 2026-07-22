export class AuthResponse {
  id_usuario!: number;
  nombre!: string;
  email!: string;
  rol!: string;
  permisos!: string[];
  access_token!: string;
  expires_in!: string;
}