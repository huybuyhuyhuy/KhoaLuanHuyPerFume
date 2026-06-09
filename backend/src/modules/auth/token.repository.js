import { randomUUID } from 'crypto';
import { getDbPool, query, sql } from '../../config/database.js';
import { env } from '../../config/env.js';
import { generateSecureToken, sha256Hex } from '../../jwt.js';
import { getAuthStorageCapabilities } from './auth.storage.js';

const memoryRefreshTokens = new Map();
const memoryPasswordResetTokens = new Map();
const memoryEmailVerificationTokens = new Map();

function expiresAtFromMs(ms) {
  return new Date(Date.now() + Number(ms)).toISOString();
}

function isExpired(value) {
  return new Date(value).getTime() <= Date.now();
}

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

function tokenPair() {
  const token = generateSecureToken(48);
  return { token, tokenHash: sha256Hex(token) };
}

export async function createRefreshToken(user, { familyId = randomUUID(), userAgent = '', ipAddress = '' } = {}) {
  const capabilities = await getAuthStorageCapabilities();
  const { token, tokenHash } = tokenPair();
  const expiresAt = expiresAtFromMs(env.refreshTokenExpirationMs || 604800000);
  const issuedJti = randomUUID();

  if (!capabilities.hasRefreshTokens) {
    memoryRefreshTokens.set(tokenHash, {
      id: tokenHash,
      userId: user.id,
      familyId,
      issuedJti,
      expiresAt,
      revokedAt: null,
      replacedByTokenId: null,
    });
    return { token, tokenHash, familyId, id: tokenHash, expiresAt };
  }

  const rows = await query(
    `INSERT INTO refresh_tokens
       (user_id, token_hash, family_id, issued_jti, user_agent, ip_address, expires_at)
     OUTPUT INSERTED.id AS id
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [user.id, tokenHash, familyId, issuedJti, userAgent, ipAddress, expiresAt]
  );

  return { token, tokenHash, familyId, id: rows[0]?.id, expiresAt };
}

export async function findRefreshToken(rawToken) {
  const capabilities = await getAuthStorageCapabilities();
  const tokenHash = sha256Hex(rawToken);

  if (!capabilities.hasRefreshTokens) {
    const record = memoryRefreshTokens.get(tokenHash);
    if (!record) return null;
    return {
      id: record.id,
      user_id: record.userId,
      family_id: record.familyId,
      expires_at: record.expiresAt,
      revoked_at: record.revokedAt,
      replaced_by_token_id: record.replacedByTokenId,
    };
  }

  const rows = await query(
    `SELECT TOP 1 id, user_id, family_id, expires_at, revoked_at, replaced_by_token_id
     FROM refresh_tokens
     WHERE token_hash = ?`,
    [tokenHash]
  );
  return rows[0] || null;
}

export async function rotateRefreshToken(rawToken, user, context = {}) {
  const capabilities = await getAuthStorageCapabilities();
  if (!capabilities.hasRefreshTokens) {
    const existing = await findRefreshToken(rawToken);
    if (!existing) return { code: 401, message: 'Refresh token khong hop le' };
    if (existing.revoked_at || existing.replaced_by_token_id) {
      await revokeRefreshTokenFamily(existing.user_id, existing.family_id);
      return { code: 401, message: 'Refresh token da bi thu hoi' };
    }
    if (isExpired(existing.expires_at)) return { code: 401, message: 'Refresh token da het han' };
    const next = await createRefreshToken(user, {
      familyId: existing.family_id,
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
    });
    const oldHash = sha256Hex(rawToken);
    const record = memoryRefreshTokens.get(oldHash);
    if (record) {
      record.revokedAt = new Date().toISOString();
      record.replacedByTokenId = next.id;
    }
    return next;
  }

  const pool = await getDbPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const tokenHash = sha256Hex(rawToken);
    const findRequest = new sql.Request(transaction);
    findRequest.input('tokenHash', sql.Char(64), tokenHash);
    const existingResult = await findRequest.query(
      `SELECT TOP 1 id, user_id, family_id, expires_at, revoked_at, replaced_by_token_id
       FROM refresh_tokens WITH (UPDLOCK, ROWLOCK)
       WHERE token_hash = @tokenHash`
    );
    const existing = existingResult.recordset?.[0];
    if (!existing) {
      await transaction.rollback();
      return { code: 401, message: 'Refresh token khong hop le' };
    }
    if (existing.revoked_at || existing.replaced_by_token_id) {
      await transaction.rollback();
      await revokeRefreshTokenFamily(existing.user_id, existing.family_id);
      return { code: 401, message: 'Refresh token da bi thu hoi' };
    }
    if (isExpired(existing.expires_at)) {
      await transaction.rollback();
      return { code: 401, message: 'Refresh token da het han' };
    }

    const { token, tokenHash: nextHash } = tokenPair();
    const expiresAt = expiresAtFromMs(env.refreshTokenExpirationMs || 604800000);
    const insertRequest = new sql.Request(transaction);
    insertRequest.input('userId', sql.Int, user.id);
    insertRequest.input('tokenHash', sql.Char(64), nextHash);
    insertRequest.input('familyId', sql.UniqueIdentifier, existing.family_id);
    insertRequest.input('issuedJti', sql.UniqueIdentifier, randomUUID());
    insertRequest.input('userAgent', sql.NVarChar, context.userAgent || '');
    insertRequest.input('ipAddress', sql.NVarChar, context.ipAddress || '');
    insertRequest.input('expiresAt', sql.NVarChar(19), toSqlDateTimeText(expiresAt));
    const insertResult = await insertRequest.query(
      `INSERT INTO refresh_tokens
         (user_id, token_hash, family_id, issued_jti, user_agent, ip_address, expires_at)
       OUTPUT INSERTED.id AS id
       VALUES (@userId, @tokenHash, @familyId, @issuedJti, @userAgent, @ipAddress, CONVERT(DATETIME2, @expiresAt, 120))`
    );
    const nextId = insertResult.recordset?.[0]?.id;

    const updateRequest = new sql.Request(transaction);
    updateRequest.input('oldId', sql.BigInt, existing.id);
    updateRequest.input('newId', sql.BigInt, nextId);
    await updateRequest.query(
      `UPDATE refresh_tokens
       SET revoked_at = SYSUTCDATETIME(), replaced_by_token_id = @newId
       WHERE id = @oldId AND revoked_at IS NULL AND replaced_by_token_id IS NULL`
    );

    await transaction.commit();
    return {
      token,
      tokenHash: nextHash,
      familyId: existing.family_id,
      id: nextId,
      expiresAt,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch {}
    throw error;
  }
}

export async function revokeRefreshToken(rawToken) {
  const capabilities = await getAuthStorageCapabilities();
  const tokenHash = sha256Hex(rawToken);

  if (!capabilities.hasRefreshTokens) {
    const record = memoryRefreshTokens.get(tokenHash);
    if (record) record.revokedAt = new Date().toISOString();
    return;
  }

  await query(
    `UPDATE refresh_tokens
     SET revoked_at = SYSUTCDATETIME()
     WHERE token_hash = ? AND revoked_at IS NULL`,
    [tokenHash]
  );
}

export async function revokeRefreshTokenFamily(userId, familyId) {
  const capabilities = await getAuthStorageCapabilities();
  if (!capabilities.hasRefreshTokens) {
    for (const record of memoryRefreshTokens.values()) {
      if (Number(record.userId) === Number(userId) && String(record.familyId) === String(familyId)) {
        record.revokedAt = new Date().toISOString();
      }
    }
    return;
  }

  await query(
    `UPDATE refresh_tokens
     SET revoked_at = SYSUTCDATETIME()
     WHERE user_id = ? AND family_id = ? AND revoked_at IS NULL`,
    [userId, familyId]
  );
}

export async function revokeAllUserRefreshTokens(userId) {
  const capabilities = await getAuthStorageCapabilities();
  if (!capabilities.hasRefreshTokens) {
    for (const record of memoryRefreshTokens.values()) {
      if (Number(record.userId) === Number(userId)) record.revokedAt = new Date().toISOString();
    }
    return;
  }

  await query(
    `UPDATE refresh_tokens
     SET revoked_at = SYSUTCDATETIME()
     WHERE user_id = ? AND revoked_at IS NULL`,
    [userId]
  );
}

async function createPurposeToken({ userId, purpose }) {
  const capabilities = await getAuthStorageCapabilities();
  const { token, tokenHash } = tokenPair();
  const isReset = purpose === 'password_reset';
  const expiresAt = expiresAtFromMs(isReset ? env.passwordResetTokenExpirationMs : env.emailVerificationTokenExpirationMs);
  const memoryStore = isReset ? memoryPasswordResetTokens : memoryEmailVerificationTokens;
  const hasTable = isReset ? capabilities.hasPasswordResetTokens : capabilities.hasEmailVerificationTokens;
  const table = isReset ? 'password_reset_tokens' : 'email_verification_tokens';

  if (!hasTable) {
    memoryStore.set(tokenHash, {
      userId,
      expiresAt,
      usedAt: null,
    });
    return { token, expiresAt };
  }

  await query(
    `INSERT INTO ${table} (user_id, token_hash, expires_at)
     VALUES (?, ?, ?)`,
    [userId, tokenHash, expiresAt]
  );

  return { token, expiresAt };
}

async function consumePurposeToken({ token, purpose }) {
  const capabilities = await getAuthStorageCapabilities();
  const tokenHash = sha256Hex(token);
  const isReset = purpose === 'password_reset';
  const memoryStore = isReset ? memoryPasswordResetTokens : memoryEmailVerificationTokens;
  const hasTable = isReset ? capabilities.hasPasswordResetTokens : capabilities.hasEmailVerificationTokens;
  const table = isReset ? 'password_reset_tokens' : 'email_verification_tokens';

  if (!hasTable) {
    const record = memoryStore.get(tokenHash);
    if (!record || record.usedAt || isExpired(record.expiresAt)) return null;
    record.usedAt = new Date().toISOString();
    return { userId: record.userId };
  }

  const pool = await getDbPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const findRequest = new sql.Request(transaction);
    findRequest.input('tokenHash', sql.Char(64), tokenHash);
    const result = await findRequest.query(
      `SELECT TOP 1 id, user_id, expires_at, used_at
       FROM ${table} WITH (UPDLOCK, ROWLOCK)
       WHERE token_hash = @tokenHash`
    );
    const row = result.recordset?.[0];
    if (!row || row.used_at || isExpired(row.expires_at)) {
      await transaction.rollback();
      return null;
    }

    const updateRequest = new sql.Request(transaction);
    updateRequest.input('id', sql.BigInt, row.id);
    await updateRequest.query(`UPDATE ${table} SET used_at = SYSUTCDATETIME() WHERE id = @id`);
    await transaction.commit();
    return { userId: row.user_id };
  } catch (error) {
    try { await transaction.rollback(); } catch {}
    throw error;
  }
}

export function createPasswordResetToken(userId) {
  return createPurposeToken({ userId, purpose: 'password_reset' });
}

export function consumePasswordResetToken(token) {
  return consumePurposeToken({ token, purpose: 'password_reset' });
}

export function createEmailVerificationToken(userId) {
  return createPurposeToken({ userId, purpose: 'email_verification' });
}

export function consumeEmailVerificationToken(token) {
  return consumePurposeToken({ token, purpose: 'email_verification' });
}
