/** @param {import('knex').Knex} db */
export async function up(db) {
  const hasChats = await db.schema.hasTable("sync_chats");
  if (!hasChats) {
    await db.schema.createTable("sync_chats", (t) => {
      t.string("session_id").notNullable();
      t.string("jid").notNullable();
      t.string("name").nullable();
      t.boolean("is_group").notNullable().defaultTo(false);
      t.integer("unread_count").notNullable().defaultTo(0);
      t.text("last_message").nullable();
      t.bigInteger("last_message_ts").notNullable().defaultTo(0);
      t.integer("ephemeral_expiry").notNullable().defaultTo(0);
      t.bigInteger("created_at_sec").notNullable().defaultTo(0);
      t.bigInteger("updated_at_sec").notNullable().defaultTo(0);
      t.timestamp("created_at").notNullable().defaultTo(db.fn.now());
      t.timestamp("updated_at").notNullable();
      t.primary(["session_id", "jid"]);
      try {
        t.foreign("session_id")
          .references("id")
          .inTable("sessions")
          .onDelete("CASCADE");
      } catch {}
    });
    await db.schema.alterTable("sync_chats", (t) => {
      t.index(["session_id"], "sync_chats_session_idx");
      t.index(["session_id", "last_message_ts"], "sync_chats_last_ts_idx");
    });
  }

  const hasContacts = await db.schema.hasTable("sync_contacts");
  if (!hasContacts) {
    await db.schema.createTable("sync_contacts", (t) => {
      t.string("session_id").notNullable();
      t.string("jid").notNullable();
      t.string("phone").nullable();
      t.string("name").nullable();
      t.string("notify").nullable();
      t.string("verified_name").nullable();
      t.boolean("is_me").notNullable().defaultTo(false);
      t.boolean("is_my_contact").notNullable().defaultTo(false);
      t.boolean("is_group").notNullable().defaultTo(false);
      t.bigInteger("updated_at_sec").notNullable().defaultTo(0);
      t.timestamp("created_at").notNullable().defaultTo(db.fn.now());
      t.timestamp("updated_at").notNullable();
      t.primary(["session_id", "jid"]);
      try {
        t.foreign("session_id")
          .references("id")
          .inTable("sessions")
          .onDelete("CASCADE");
      } catch {}
    });
    await db.schema.alterTable("sync_contacts", (t) => {
      t.index(["session_id"], "sync_contacts_session_idx");
      t.index(["session_id", "phone"], "sync_contacts_phone_idx");
    });
  }

  const hasMessages = await db.schema.hasTable("sync_messages");
  if (!hasMessages) {
    await db.schema.createTable("sync_messages", (t) => {
      t.string("session_id").notNullable();
      t.string("id").notNullable();
      t.string("chat_jid").notNullable();
      t.boolean("from_me").notNullable().defaultTo(false);
      t.string("sender_jid").nullable();
      t.string("to_jid").nullable();
      t.string("message_type", 64).nullable();
      t.text("body").nullable();
      t.bigInteger("timestamp_sec").notNullable().defaultTo(0);
      t.text("raw").nullable();
      t.bigInteger("updated_at_sec").notNullable().defaultTo(0);
      t.timestamp("created_at").notNullable().defaultTo(db.fn.now());
      t.timestamp("updated_at").notNullable();
      t.primary(["session_id", "id"]);
      try {
        t.foreign("session_id")
          .references("id")
          .inTable("sessions")
          .onDelete("CASCADE");
      } catch {}
    });
    await db.schema.alterTable("sync_messages", (t) => {
      t.index(
        ["session_id", "chat_jid", "timestamp_sec"],
        "sync_messages_chat_ts_idx"
      );
    });
  }
}

/** @param {import('knex').Knex} db */
export async function down(db) {
  await db.schema.dropTableIfExists("sync_messages");
  await db.schema.dropTableIfExists("sync_contacts");
  await db.schema.dropTableIfExists("sync_chats");
}
