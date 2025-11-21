/** @param {import('knex').Knex} db */
export async function up(db) {
  const hasUsers = await db.schema.hasTable("users");
  if (!hasUsers) {
    await db.schema.createTable("users", (t) => {
      t.string("id").primary();
      t.string("registry").notNullable().defaultTo("").unique();
      t.string("username").notNullable().defaultTo("").unique();
      t.string("password").notNullable().defaultTo("");
      t.string("api_key").notNullable().defaultTo("").unique();
      t.boolean("is_admin").notNullable().defaultTo(false);
      t.timestamp("last_login_at").nullable();
      t.timestamp("created_at").notNullable().defaultTo(db.fn.now());
      t.timestamp("updated_at").nullable();
    });
    await db.schema.alterTable("users", (t) => {
      t.index(["registry"], "users_registry_idx");
      t.index(["username"], "users_username_idx");
      t.index(["api_key"], "users_api_key_idx");
      t.index(["is_admin"], "users_is_admin_idx");
    });
  }
  const hasSessions = await db.schema.hasTable("sessions");
  if (!hasSessions) {
    await db.schema.createTable("sessions", (t) => {
      t.string("id").primary();
      t.string("registry_user").notNullable().defaultTo("");
      t.string("label").notNullable().unique();
      t.text("credentials_path").nullable();
      t.boolean("auto_start").notNullable().defaultTo(true);
      t.text("webhook_url").nullable();
      t.string("webhook_secret").nullable();
      t.string("status").notNullable().defaultTo("starting");
      t.text("session_profile").nullable();
      t.timestamp("last_connected_at").nullable();
      t.timestamp("created_at").notNullable().defaultTo(db.fn.now());
      t.timestamp("updated_at").nullable();
      try {
        t.foreign("registry_user")
          .references("registry")
          .inTable("users")
          .onDelete("CASCADE");
      } catch {}
    });
    await db.schema.alterTable("sessions", (t) => {
      t.index(["registry_user"], "sessions_registry_user_idx");
      t.index(["label"], "sessions_label_idx");
    });
  }
}

/** @param {import('knex').Knex} db */
export async function down(db) {
  await db.schema.dropTableIfExists("users");
  await db.schema.dropTableIfExists("sessions");
}
