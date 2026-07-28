import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { LogRepository } from '../../repository/Repository/log-repository';
import { JwtGuard } from '../../guards/jwt.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/roles.decorator';

@ApiTags('Log')
@ApiBearerAuth('access-token')
@Controller('log')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
export class LogController {

  constructor(private readonly logRepo: LogRepository) {}

  @Get()
  getAll() {
    return this.logRepo.getAll();
  }
}
