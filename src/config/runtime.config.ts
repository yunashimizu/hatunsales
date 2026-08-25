/** Entorno de producción (Railway o NODE_ENV=production). */
export function esProduccion(): boolean {
  return (
    (process.env.NODE_ENV ?? '').toLowerCase() === 'production' ||
    !!process.env.RAILWAY_ENVIRONMENT ||
    !!process.env.RAILWAY_ENVIRONMENT_NAME
  );
} 
