import { Controller, Post, Get, Put, Body, Res, Req, UseGuards } from '@nestjs/common';
import type { Response, Request } from 'express';
import { AuthBussnies } from 'src/bussnies/Bussnies/auth.bussnies';
import { JwtGuard } from 'src/guards/jwt.guard';
import { LoginRequest, RegisterRequest, GoogleAuthRequest } from 'src/models/model/login-request';
import { ActualizarPerfilRequest } from 'src/models/model/actualizar-perfil.request';

@Controller('auth')
export class AuthController {

  constructor(private readonly authService: AuthBussnies) {}

  @Post('login')
  login(
    @Body() body: LoginRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.authService.login(body, res);
  }

  /** Solo clientes de tienda. Empleados se crean en el admin. */
  @Post('register')
  register(@Body() body: RegisterRequest) {
    return this.authService.register(body);
  }

  /** Client ID público para el botón de Google Identity Services. */
  @Get('google/config')
  googleConfig() {
    return this.authService.googleClientId();
  }

  /** Login o alta automática de cliente con credential de Google. */
  @Post('google')
  loginGoogle(
    @Body() body: GoogleAuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.authService.loginConGoogle(body.credential, res);
  }

  @Post('logout')
  @UseGuards(JwtGuard)
  logout(@Res({ passthrough: true }) res: Response) {
    return this.authService.logout(res);
  }

  @Get('perfil')
  @UseGuards(JwtGuard)
  perfil(@Req() req: Request) {
    const user = req.user as { id_usuario?: number };
    return this.authService.obtenerPerfil(Number(user?.id_usuario ?? 0));
  }

  @Put('perfil')
  @UseGuards(JwtGuard)
  actualizarPerfil(
    @Req() req: Request,
    @Body() body: ActualizarPerfilRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = req.user as { id_usuario?: number };
    return this.authService.actualizarPerfil(Number(user?.id_usuario ?? 0), body, res);
  }
}
