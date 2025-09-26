// db/ops.ts
import { db } from './db';
import { chats, contacts, messages, reactions } from './schema';
import { eq } from 'drizzle-orm';

export async function upsertChat(row: {
  id: string;
  name?: string | null;
  isGroup: boolean;
  archived: boolean;
}) {
  // Try update name/isGroup/archived, else insert
  const existing = await db.select().from(chats).where(eq(chats.id, row.id));
  if (existing.length) {
    await db.update(chats)
      .set({ name: row.name ?? existing[0].name, isGroup: row.isGroup, archived: row.archived })
      .where(eq(chats.id, row.id));
  } else {
    await db.insert(chats).values({
      id: row.id,
      name: row.name ?? null,
      isGroup: row.isGroup,
      archived: row.archived,
    });
  }
}

export async function upsertContact(row: { id: string; name?: string | null }) {
  if (!row.id) return;
  const existing = await db.select().from(contacts).where(eq(contacts.id, row.id));
  if (existing.length) {
    if (row.name && row.name !== existing[0].name) {
      await db.update(contacts).set({ name: row.name }).where(eq(contacts.id, row.id));
    }
  } else {
    await db.insert(contacts).values({ id: row.id, name: row.name ?? null });
  }
}

export async function insertMessage(row: {
  id: string;
  chatId: string;
  senderId?: string | null;
  senderName?: string | null;
  fromMe: boolean;
  type: string;
  body?: string | null;
  ts: number;
  mimetype?: string | null;
  filename?: string | null;
  filesize?: number | null;
  durationMs?: number | null;
}) {
  // dedupe by PK (id). If exists, skip.
  try {
    await db.insert(messages).values({
      id: row.id,
      chatId: row.chatId,
      senderId: row.senderId ?? null,
      senderName: row.senderName ?? null,
      fromMe: row.fromMe,
      type: row.type,
      body: row.body ?? null,
      ts: row.ts,
      mimetype: row.mimetype ?? null,
      filename: row.filename ?? null,
      filesize: row.filesize ?? null,
      durationMs: row.durationMs ?? null,
    });
  } catch (e: any) {
    // SQLite returns error if PK exists — we just ignore
    if (!/UNIQUE constraint failed: messages.id/.test(e?.message || '')) {
      throw e;
    }
  }
}

export async function insertReactions(messageId: string, items: Array<{ emoji: string; senderId?: string | null }>) {
  if (!items?.length) return;
  for (const r of items) {
    await db.insert(reactions).values({
      messageId,
      emoji: r.emoji,
      senderId: r.senderId ?? null,
    });
  }
}
