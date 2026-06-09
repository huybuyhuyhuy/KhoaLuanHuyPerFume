import 'dotenv/config';

const useSqlAuthentication = Boolean(process.env.DB_USER?.trim());
const { default: sql } = await import(useSqlAuthentication ? 'mssql' : 'mssql/msnodesqlv8.js');

const config = {
  server: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 1433),
  database: process.env.DB_NAME || 'huyperfume',
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

if (useSqlAuthentication) {
  config.user = process.env.DB_USER.trim();
  config.password = process.env.DB_PASSWORD || '';
} else {
  config.driver = process.env.DB_DRIVER || 'ODBC Driver 18 for SQL Server';
  config.options.trustedConnection = true;
}

let _pool = null;

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

async function getPool() {
  if (!_pool) {
    _pool = await sql.connect(config);
    console.log('Đã kết nối SQL Server');
  }
  return _pool;
}

// Convert MySQL-style ? placeholders to @p0, @p1, etc.
function convertQuery(sqlStr, params) {
  let idx = 0;
  const newParams = {};
  const converted = sqlStr.replace(/\?/g, () => {
    const name = `arg${idx}`;
    newParams[name] = params[idx];
    idx++;
    return `@${name}`;
  });
  return { sql: converted, params: newParams };
}

function toSafePageNumber(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${label} phải là số nguyên không âm`);
  }
  return number;
}

function applyTopLimit(sqlStr, limit) {
  const withoutLimit = sqlStr.replace(/\s+LIMIT\s+(\?|\d+)\s*$/i, '');
  return withoutLimit.replace(/^\s*SELECT\s+/i, (match) => `${match}TOP (${limit}) `);
}

// Convert MySQL LIMIT/OFFSET to SQL Server OFFSET/FETCH.
// msnodesqlv8 trips over bound parameters inside OFFSET/FETCH, so only pagination
// values are inlined after being reduced to safe non-negative integers.
function convertLimit(sqlStr, params) {
  let nextParams = [...params];

  const parameterizedLimitOffset = /\bLIMIT\s+\?\s+OFFSET\s+\?\s*$/i;
  if (parameterizedLimitOffset.test(sqlStr)) {
    const offset = toSafePageNumber(nextParams.pop(), 'offset');
    const limit = toSafePageNumber(nextParams.pop(), 'limit');
    return {
      sql: sqlStr.replace(
        parameterizedLimitOffset,
        `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
      ),
      params: nextParams,
    };
  }

  const parameterizedLimitOnly = /\bLIMIT\s+\?\s*$/i;
  if (parameterizedLimitOnly.test(sqlStr)) {
    const limit = toSafePageNumber(nextParams.pop(), 'limit');
    return {
      sql: applyTopLimit(sqlStr, limit),
      params: nextParams,
    };
  }

  const numericLimitOffset = /\bLIMIT\s+(\d+)\s+OFFSET\s+(\d+)\s*$/i;
  const numericLimitOffsetMatch = sqlStr.match(numericLimitOffset);
  if (numericLimitOffsetMatch) {
    const limit = toSafePageNumber(numericLimitOffsetMatch[1], 'limit');
    const offset = toSafePageNumber(numericLimitOffsetMatch[2], 'offset');
    return {
      sql: sqlStr.replace(
        numericLimitOffset,
        `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
      ),
      params: nextParams,
    };
  }

  const numericLimitOnly = /\bLIMIT\s+(\d+)\s*$/i;
  const numericLimitOnlyMatch = sqlStr.match(numericLimitOnly);
  if (numericLimitOnlyMatch) {
    const limit = toSafePageNumber(numericLimitOnlyMatch[1], 'limit');
    return {
      sql: applyTopLimit(sqlStr, limit),
      params: nextParams,
    };
  }

  return { sql: sqlStr, params: nextParams };
}

// Replace MySQL NOW() with GETDATE()
function convertFunctions(sqlStr) {
  return sqlStr.replace(/\bNOW\(\)/gi, 'GETDATE()');
}

// Replace MySQL FOR UPDATE with SQL Server WITH (UPDLOCK, ROWLOCK) table hints
function convertForUpdate(sqlStr) {
  if (!/\s+FOR\s+UPDATE\s*$/i.test(sqlStr)) return sqlStr;

  let result = sqlStr.replace(/\s+FOR\s+UPDATE\s*$/i, '');

  // Add WITH (UPDLOCK, ROWLOCK) after each table reference in FROM/JOIN
  // Handles: FROM table, FROM table alias, JOIN table alias ON, JOIN table ON
  result = result.replace(
    /\b(FROM|JOIN)\s+(\w+)(\s+(?:AS\s+)?\w+)?(?=\s+(?:ON|WHERE|ORDER|GROUP|HAVING|LIMIT|OFFSET|FETCH|$))/gi,
    (match, keyword, table, aliasPart) => {
      if (aliasPart) {
        return `${keyword} ${table}${aliasPart} WITH (UPDLOCK, ROWLOCK)`;
      }
      return `${keyword} ${table} WITH (UPDLOCK, ROWLOCK)`;
    }
  );

  return result;
}

// Convert MySQL boolean values (0/1) to BIT for SQL Server
// Handled at parameter level

// Run a query using the new SQL Server pool
async function query(rawSql, params = []) {
  const p = await getPool();
  let sqlStr = rawSql;
  sqlStr = convertFunctions(sqlStr);
  sqlStr = convertForUpdate(sqlStr);
  const limitConverted = convertLimit(sqlStr, params);
  sqlStr = limitConverted.sql;

  const { sql: finalSql, params: newParams } = convertQuery(sqlStr, limitConverted.params);

  const request = p.request();
  for (const [key, value] of Object.entries(newParams)) {
    if (value === undefined || value === null) {
      request.input(key, sql.NVarChar, null);
    } else if (typeof value === 'boolean') {
      request.input(key, sql.Bit, value ? 1 : 0);
    } else if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        request.input(key, sql.Int, value);
      } else {
        request.input(key, sql.Float, value);
      }
    } else if (value instanceof Date) {
      request.input(key, sql.NVarChar(19), toSqlDateTimeText(value));
    } else {
      request.input(key, sql.NVarChar, String(value));
    }
  }

  // If this is an INSERT, wrap with OUTPUT to capture inserted id
  const isInsert = /^\s*INSERT\s+/i.test(finalSql);
  let executeSql = finalSql;
  if (isInsert && !/OUTPUT\s+INSERTED/i.test(finalSql)) {
    executeSql = finalSql.replace(/^\s*INSERT\s+/i, 'INSERT ');
    // Add OUTPUT INSERTED clause
    const valuesIdx = executeSql.toUpperCase().indexOf(' VALUES ');
    if (valuesIdx > -1) {
      const beforeValues = executeSql.substring(0, valuesIdx);
      const afterValues = executeSql.substring(valuesIdx);
      // Get the first column name from INSERT INTO table (col1, col2, ...)
      const colMatch = beforeValues.match(/INSERT\s+INTO\s+\S+\s*\(([^)]+)\)/i);
      if (colMatch) {
        const firstCol = colMatch[1].split(',')[0].trim();
        executeSql = beforeValues + ` OUTPUT INSERTED.${firstCol} AS insertId` + afterValues;
      }
    }
  }

  // Add SELECT SCOPE_IDENTITY() approach instead - simpler
  // Actually let's keep OUTPUT INSERTED approach

  const result = await request.query(executeSql);

  // Return in mysql2-compatible format: [rows, resultMeta]
  // For SELECT: result.recordset contains rows
  // For INSERT/UPDATE/DELETE: result.rowsAffected contains count

  if (result.recordset && result.recordset.length > 0) {
    // Check if this was an INSERT with OUTPUT
    const firstRow = result.recordset[0];
    if (firstRow && 'insertId' in firstRow) {
      // Map insertId for INSERT operations
      return [{ insertId: firstRow.insertId, affectedRows: result.rowsAffected?.[0] || 0 }, []];
    }
    return [result.recordset, []];
  }

  // For INSERT without returning rows, check if there's an output
  if (isInsert) {
    // Try to get the last inserted identity
    const idResult = await request.query('SELECT CAST(SCOPE_IDENTITY() AS INT) AS insertId');
    const insertId = idResult.recordset[0]?.insertId || 0;
    return [{ insertId, affectedRows: result.rowsAffected?.[0] || 0 }, []];
  }

  return [[], { affectedRows: result.rowsAffected?.[0] || 0 }];
}

// Simulate mysql2 connection for transactions
class FakeConnection {
  constructor() {
    this.transaction = null;
    this.released = false;
  }

  async beginTransaction() {
    const p = await getPool();
    this.transaction = new sql.Transaction(p);
    await this.transaction.begin();
  }

  async query(rawSql, params = []) {
    const p = this.transaction || (await getPool());
    let sqlStr = rawSql;
    sqlStr = convertFunctions(sqlStr);
    sqlStr = convertForUpdate(sqlStr);
    const limitConverted = convertLimit(sqlStr, params);
    sqlStr = limitConverted.sql;

    const { sql: finalSql, params: newParams } = convertQuery(sqlStr, limitConverted.params);

    const request = this.transaction ? new sql.Request(this.transaction) : new sql.Request(p);
    for (const [key, value] of Object.entries(newParams)) {
      if (value === undefined || value === null) {
        request.input(key, sql.NVarChar, null);
      } else if (typeof value === 'boolean') {
        request.input(key, sql.Bit, value ? 1 : 0);
      } else if (typeof value === 'number') {
        if (Number.isInteger(value)) {
          request.input(key, sql.Int, value);
        } else {
          request.input(key, sql.Float, value);
        }
      } else if (value instanceof Date) {
        request.input(key, sql.NVarChar(19), toSqlDateTimeText(value));
      } else {
        request.input(key, sql.NVarChar, String(value));
      }
    }

    const result = await request.query(finalSql);

    if (result.recordset && result.recordset.length > 0) {
      return [result.recordset, []];
    }
    return [[], { affectedRows: result.rowsAffected?.[0] || 0 }];
  }

  async commit() {
    if (this.transaction) {
      await this.transaction.commit();
      this.transaction = null;
    }
  }

  async rollback() {
    if (this.transaction) {
      await this.transaction.rollback();
      this.transaction = null;
    }
  }

  release() {
    this.released = true;
    this.transaction = null;
  }
}

// Compatible getConnection API
async function getConnection() {
  return new FakeConnection();
}

// pool object for named import { pool } compatibility
const pool = { query, getConnection, getPool };

export { query, getConnection, getPool, pool };

const db = { query, getConnection, getPool };
export default db;
