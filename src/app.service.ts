import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'que onda perritas style="color:red" ';
  }
}
