import { config } from 'dotenv';

// Las variables del proceso (Railway) tienen prioridad. El archivo fiscal es
// local, está ignorado por Git y permite usar la llave maestra sin copiarla al código.
config({
  path: ['.env.fiscal.local', '.env.local', '.env'],
  override: false,
  quiet: true,
});
