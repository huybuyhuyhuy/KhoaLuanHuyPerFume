import { env } from './env.js';

const useSqlAuthentication = Boolean(env.dbUser.trim());
const { default: sql } = await import(useSqlAuthentication ? 'mssql' : 'mssql/msnodesqlv8.js');
export { sql };

const config = {
  server: env.dbHost,
  database: env.dbName,
  options: {
    trustServerCertificate: true,
    encrypt: false,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

const usesNamedInstance = env.dbHost.includes('\\');
if (env.dbPort && !usesNamedInstance) {
  config.port = env.dbPort;
}

if (useSqlAuthentication) {
  config.user = env.dbUser.trim();
  config.password = env.dbPassword;
} else {
  config.driver = env.dbDriver;
  config.options.trustedConnection = true;
}

let poolPromise = null;

function padDatePart(value) {
  return String(value).padStart(2, '0');
}

function toSqlDateTimeText(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value).trim());
  if (Number.isNaN(date.getTime())) return null;

  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join('-') + ' ' + [
    padDatePart(date.getHours()),
    padDatePart(date.getMinutes()),
    padDatePart(date.getSeconds()),
  ].join(':');
}

export async function getDbPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(config);
  }
  return poolPromise;
}

export async function query(sqlText, params = []) {
  const pool = await getDbPool();
  const request = pool.request();

  params.forEach((value, index) => {
    const name = `arg${index}`;
    if (value === null || value === undefined) {
      request.input(name, sql.NVarChar, null);
    } else if (typeof value === 'boolean') {
      request.input(name, sql.Bit, value ? 1 : 0);
    } else if (typeof value === 'number') {
      request.input(name, Number.isInteger(value) ? sql.Int : sql.Float, value);
    } else if (value instanceof Date) {
      request.input(name, sql.NVarChar(19), toSqlDateTimeText(value));
    } else {
      request.input(name, sql.NVarChar, String(value));
    }
  });

  let paramIndex = 0;
  const convertedSql = sqlText.replace(/\?/g, () => `@arg${paramIndex++}`);
  const result = await request.query(convertedSql);
  return result.recordset || [];
}

export default { getDbPool, query, sql };
