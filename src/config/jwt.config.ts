export const jwtConfig = {
  secret: process.env.JWT_SECRET ?? 'hatunsales_secret_key_2024',

  admin: {
    expiresIn: '30m',      // ← cambia esto a lo que quieras: '1h', '30m', '2d'
  },

  usuario: {
    expiresIn: '1h',      // ← clientes siempre 1h
  },
};


