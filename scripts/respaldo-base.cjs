/* Respaldo y prueba de restauración de la base de datos (PostgreSQL).
 *
 *   npm run respaldo:base                       → copia de seguridad de la base de la variable DATABASE_PUBLIC_URL
 *   npm run respaldo:base -- --variable NOMBRE  → usa otra variable de entorno con la URL de conexión
 *   npm run respaldo:base -- --conservar 14     → cuántas copias se guardan (las más antiguas se borran; por defecto 14)
 *   npm run respaldo:probar -- <archivo.dump>   → restaura la copia en la base LOCAL (127.0.0.1) y cuenta sus tablas
 *
 * Reglas de seguridad:
 *  - No lee archivos .env: la URL se pasa en el comando, para no tocar la base equivocada sin querer.
 *  - Solo LEE la base original (pg_dump). Nunca escribe en ella.
 *  - La clave de la base viaja en variables de entorno del proceso hijo, no en la línea de órdenes ni en pantalla.
 *  - La restauración de prueba SOLO acepta un servidor local (127.0.0.1 / localhost) y crea una base nueva con
 *    otro nombre: jamás pisa la base de trabajo ni toca producción.
 *  - Las copias quedan en la carpeta `respaldos/` (excluida de Git) con permiso solo para el dueño.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const raiz = path.resolve(__dirname, '..');
const carpeta = path.join(raiz, 'respaldos');
// A propósito NO se lee ningún archivo .env (el de este proyecto apunta a producción): la URL se pasa a mano en cada uso.

const comando = process.argv[2];
const argumento = (nombre, defecto) => {
  const i = process.argv.indexOf(nombre);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : defecto;
};
const falla = (mensaje) => {
  console.error('✖ ' + mensaje);
  process.exit(1);
};

/** Interpreta la URL y devuelve las variables PG* para el proceso hijo, más datos seguros de mostrar. */
function conexionDe(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    falla('La URL de conexión no es válida (debe empezar por postgresql://).');
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) falla('La URL de conexión debe empezar por postgresql://.');
  const base = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!base) falla('La URL de conexión no indica el nombre de la base.');
  const local = ['127.0.0.1', 'localhost', '::1'].includes(u.hostname);
  return {
    local,
    mostrar: `${u.hostname}:${u.port || 5432}/${base}`,
    base,
    entorno: {
      ...process.env,
      PGHOST: u.hostname,
      PGPORT: u.port || '5432',
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGDATABASE: base,
      PGSSLMODE: local ? 'prefer' : 'require',
    },
  };
}

function herramienta(nombre) {
  const r = spawnSync(nombre, ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    falla(`No se encontró «${nombre}». Instale las herramientas de PostgreSQL (paquete postgresql-client).`);
  }
  return r.stdout.trim();
}

function estampa() {
  const d = new Date();
  const dos = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${dos(d.getMonth() + 1)}${dos(d.getDate())}-${dos(d.getHours())}${dos(d.getMinutes())}`;
}

function tamano(bytes) {
  return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Lista el contenido de la copia: si pg_restore puede leerla, el archivo está completo. */
function entradasDe(archivo) {
  const r = spawnSync('pg_restore', ['--list', archivo], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const lineas = r.stdout.split('\n').filter((l) => l && !l.startsWith(';'));
  return { total: lineas.length, tablas: lineas.filter((l) => /\sTABLE\s/.test(l) && !/TABLE DATA/.test(l)).length };
}

function respaldar() {
  const variable = argumento('--variable', 'DATABASE_PUBLIC_URL');
  const url = process.env[variable];
  if (!url) {
    falla(
      `No hay valor en la variable ${variable}. Cópiela de Railway (servicio Postgres → Variables → DATABASE_PUBLIC_URL) ` +
        `y páselo así, sin guardarlo en ningún archivo:\n  DATABASE_PUBLIC_URL='postgresql://…' npm run respaldo:base`,
    );
  }
  const conservar = Math.max(1, Number(argumento('--conservar', '14')) || 14);
  const con = conexionDe(url);
  console.log('Herramienta:', herramienta('pg_dump'));
  console.log('Base de origen:', con.mostrar, con.local ? '(local)' : '(remota)');

  fs.mkdirSync(carpeta, { recursive: true, mode: 0o700 });
  const archivo = path.join(carpeta, `${con.base}-${estampa()}.dump`);
  if (fs.existsSync(archivo)) falla(`Ya existe ${path.basename(archivo)}: espere un minuto y repita.`);

  const t0 = Date.now();
  const r = spawnSync(
    'pg_dump',
    ['--format=custom', '--no-owner', '--no-privileges', '--compress=6', '--file', archivo],
    { env: con.entorno, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (r.status !== 0) {
    fs.rmSync(archivo, { force: true });
    falla('pg_dump falló: no se guardó ninguna copia (revise la conexión y que su versión sea igual o mayor que la del servidor).');
  }
  fs.chmodSync(archivo, 0o600);

  const contenido = entradasDe(archivo);
  if (!contenido || contenido.total < 1) {
    falla(`La copia ${path.basename(archivo)} se creó pero no se pudo leer: NO la dé por buena. Repita el respaldo.`);
  }
  console.log(
    `✔ Copia guardada: respaldos/${path.basename(archivo)} · ${tamano(fs.statSync(archivo).size)} · ` +
      `${contenido.tablas} tablas · verificada en ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );

  const copias = fs
    .readdirSync(carpeta)
    .filter((f) => f.startsWith(`${con.base}-`) && f.endsWith('.dump'))
    .sort();
  for (const vieja of copias.slice(0, Math.max(0, copias.length - conservar))) {
    fs.rmSync(path.join(carpeta, vieja));
    console.log('  (se borró la copia más antigua:', vieja + ')');
  }
  console.log('Recuerde: la base no incluye FISCAL_SECRET_KEY ni las fotos de uploads/. Guárdelas aparte (ver doc/GUIA_RESPALDO_Y_RESTAURACION.md).');
}

function probar() {
  const archivo = process.argv[3] && !process.argv[3].startsWith('--') ? path.resolve(process.argv[3]) : null;
  if (!archivo || !fs.existsSync(archivo)) falla('Indique la copia a probar: npm run respaldo:probar -- respaldos/<archivo>.dump');
  const destino = process.env.RESPALDO_PRUEBA_URL || 'postgresql://yuna@127.0.0.1:5433/postgres';
  const con = conexionDe(destino);
  if (!con.local) {
    falla('La prueba de restauración solo se hace en un servidor LOCAL (127.0.0.1). No se tocó nada.');
  }
  console.log('Herramientas:', herramienta('pg_restore'), '·', herramienta('psql'));
  const nombre = `restauracion_prueba_${estampa().replace('-', '_')}`;
  const admin = { ...con.entorno, PGDATABASE: 'postgres' };

  const crear = spawnSync('psql', ['-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${nombre}`], { env: admin, encoding: 'utf8' });
  if (crear.status !== 0) falla('No se pudo crear la base de prueba en el servidor local (¿está encendido?):\n' + crear.stderr);
  console.log('Base de prueba creada:', nombre, 'en', con.mostrar.split('/')[0]);

  const entorno = { ...con.entorno, PGDATABASE: nombre };
  const t0 = Date.now();
  const rest = spawnSync('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', nombre, archivo], {
    env: entorno,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (rest.status !== 0) {
    console.error(rest.stderr);
    falla(`La restauración falló: la copia NO sirve tal cual. La base de prueba ${nombre} quedó para revisarla.`);
  }
  const cuenta = spawnSync(
    'psql',
    ['-At', '-c', `SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`],
    { env: entorno, encoding: 'utf8' },
  );
  const esperadas = entradasDe(archivo);
  console.log(
    `✔ Restaurada en ${((Date.now() - t0) / 1000).toFixed(1)} s: ${cuenta.stdout.trim()} tablas en la base de prueba ` +
      `(la copia declara ${esperadas ? esperadas.tablas : '?'}).`,
  );
  console.log(`Cuando termine de revisar, bórrela con:  psql -h 127.0.0.1 -p ${con.entorno.PGPORT} -U ${con.entorno.PGUSER} -d postgres -c "DROP DATABASE ${nombre}"`);
}

if (comando === 'respaldar') respaldar();
else if (comando === 'probar') probar();
else falla('Use:  npm run respaldo:base   o   npm run respaldo:probar -- <archivo.dump>');
