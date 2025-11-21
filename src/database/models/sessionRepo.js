import { db } from "./db.js";

export async function upsertSession({
  id,
  registry_user = "",
  label = null,
  credentials_path = null,
  webhook_url = null,
  webhook_secret = null,
  session_profile = null,
  auto_start = true,
  status = null,
  last_connected_at = null,
}) {
  const client = db.client.config.client;
  const params = [
    id,
    registry_user,
    label,
    credentials_path,
    webhook_url,
    webhook_secret,
    session_profile,
    auto_start ? 1 : 0,
    status,
    last_connected_at,
  ];
  const paramsWithUpdateFlags = [...params, status, last_connected_at];

  if (client === "pg") {
    await db.raw(
      `INSERT INTO sessions(id, registry_user, label, credentials_path, webhook_url, webhook_secret, session_profile, auto_start, status, last_connected_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'starting'), ?, NOW())
        ON CONFLICT (id) DO UPDATE SET
          registry_user = COALESCE(NULLIF(EXCLUDED.registry_user, ''), sessions.registry_user),
          label = COALESCE(EXCLUDED.label, sessions.label),
          credentials_path = COALESCE(EXCLUDED.credentials_path, sessions.credentials_path),
          webhook_url = COALESCE(EXCLUDED.webhook_url, sessions.webhook_url),
          webhook_secret = COALESCE(EXCLUDED.webhook_secret, sessions.webhook_secret),
          session_profile = COALESCE(EXCLUDED.session_profile, sessions.session_profile),
          auto_start = COALESCE(EXCLUDED.auto_start, sessions.auto_start),
          status = COALESCE(?, sessions.status),
          last_connected_at = COALESCE(?, sessions.last_connected_at),
          updated_at = NOW()`,
      paramsWithUpdateFlags
    );
  } else if (client === "mysql2") {
    await db.raw(
      `INSERT INTO sessions(id, registry_user, label, credentials_path, webhook_url, webhook_secret, session_profile, auto_start, status, last_connected_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'starting'), ?, NOW())
        ON DUPLICATE KEY UPDATE
          registry_user = COALESCE(NULLIF(VALUES(registry_user), ''), registry_user),
          label = COALESCE(VALUES(label), label),
          credentials_path = COALESCE(VALUES(credentials_path), credentials_path),
          webhook_url = COALESCE(VALUES(webhook_url), webhook_url),
          webhook_secret = COALESCE(VALUES(webhook_secret), webhook_secret),
          session_profile = COALESCE(VALUES(session_profile), session_profile),
          auto_start = COALESCE(VALUES(auto_start), auto_start),
          status = COALESCE(?, status),
          last_connected_at = COALESCE(?, last_connected_at),
          updated_at = NOW()`,
      paramsWithUpdateFlags
    );
  } else {
    await db.raw(
      `INSERT INTO sessions(id, registry_user, label, credentials_path, webhook_url, webhook_secret, session_profile, auto_start, status, last_connected_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'starting'), ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          registry_user = COALESCE(NULLIF(excluded.registry_user, ''), sessions.registry_user),
          label = COALESCE(excluded.label, sessions.label),
          credentials_path = COALESCE(excluded.credentials_path, sessions.credentials_path),
          webhook_url = COALESCE(excluded.webhook_url, sessions.webhook_url),
          webhook_secret = COALESCE(excluded.webhook_secret, sessions.webhook_secret),
          session_profile = COALESCE(excluded.session_profile, sessions.session_profile),
          auto_start = COALESCE(excluded.auto_start, sessions.auto_start),
          status = COALESCE(?, sessions.status),
          last_connected_at = COALESCE(?, sessions.last_connected_at),
          updated_at = CURRENT_TIMESTAMP`,
      paramsWithUpdateFlags
    );
  }
}

export async function listSessions() {
  return db("sessions").select("*").orderBy("created_at", "asc");
}

export async function getSessionById(id) {
  if (!id) return null;
  try {
    const row = await db("sessions").where({ id }).first();
    return row || null;
  } catch {
    return null;
  }
}

export async function removeSession(id) {
  if (!id) return;
  await db("sessions").where({ id }).del();
}

export async function clearSessionWebhook(id) {
  if (!id) return;
  await db("sessions").where({ id }).update({ webhook_url: null });
}
