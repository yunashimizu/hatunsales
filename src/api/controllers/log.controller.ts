import { Controller, Get } from '@nestjs/common';
import { LogRepository } from '../../repository/Repository/log-repository';

@Controller('log')
export class LogController {

  constructor(private readonly logRepo: LogRepository) {}

  @Get()
  getAll() {
    return this.logRepo.getAll();
  }
}