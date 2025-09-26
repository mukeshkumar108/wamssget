// db/schema.ts
import {
  sqliteTable, text, integer
} from "drizzle-orm/sqlite-core";

// CHATS
export const chats = sqliteTable("chats", {
  id: text("id").primaryKey(),           // "5025...@c.us" or "...@g.us"
  name: text("name"),
  isGroup: integer("is_group", { mode: "boolean" }).notNull().default(false),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
});

// CONTACTS
export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  savedName: text("saved_name"),        // how YOU saved them
  displayName: text("display_name"),    // how THEY present themselves
});

// MESSAGES
export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),           // messageId
  chatId: text("chat_id").notNull(),

  senderId: text("sender_id"),
  savedName: text("saved_name"),
  displayName: text("display_name"),

  participantId: text("participant_id"),       // NEW for groups
  participantSavedName: text("participant_saved_name"),
  participantDisplayName: text("participant_display_name"),

  fromMe: integer("from_me", { mode: "boolean" }).notNull(),
  type: text("type").notNull(),
  body: text("body"),
  ts: integer("ts", { mode: "number" }).notNull(),

  // media metadata
  mimetype: text("mimetype"),
  filename: text("filename"),
  filesize: integer("filesize", { mode: "number" }),
  durationMs: integer("duration_ms", { mode: "number" }),
});

// REACTIONS
export const reactions = sqliteTable("reactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  messageId: text("message_id").notNull(),
  emoji: text("emoji").notNull(),
  senderId: text("sender_id"),
});
