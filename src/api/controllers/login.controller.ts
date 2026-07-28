import { Controller, Post, Get, Put, Body, Res, Req, UseGuards } from '@nestjs/common';
import type { Response, Request } from 'express';
import { AuthBussnies } from 'src/bussnies/Bussnies/auth.bussnies';
import { JwtGuard } from 'src/guards/jwt.guard';
import { authRequest, RegisterRequest } from 'src/models/model/auth.request';
import { ActualizarPerfilRequest } from 'src/models/model/actualizar-perfil.request';

/**
 * Controlador legado duplicado en /auth.
 * Se mantiene alineado con AuthController para no romper rutas existentes.
 */
@Controller('auth')
export class loginController {

  constructor(private readonly authService: AuthBussnies) {}

  @Post('login')
  login(
    @Body() body: authRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.authService.login(body, res);
  }

  @Post('register')
  register(@Body() body: RegisterRequest) {
    return this.authService.register(body);
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
