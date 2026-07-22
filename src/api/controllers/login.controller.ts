import { Controller, Post, Get, Body, Res, Req, UseGuards } from '@nestjs/common';
import type { Response, Request } from 'express';
import { AuthBussnies } from 'src/bussnies/Bussnies/auth.bussnies';
import { JwtGuard } from 'src/guards/jwt.guard';
import { authRequest, RegisterRequest } from 'src/models/model/auth.request';

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
    return req.user;
  }
}