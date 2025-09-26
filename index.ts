// index.ts
/// <reference path="./types.d.ts" />
import "dotenv/config";
import fs from "fs";
import path from "path";
import qrcode from "qrcode-terminal";
import WAWebJS, { Message, Chat, Contact } from "whatsapp-web.js";
import { db, initDb } from "./db/db";
import * as schema from "./db/schema";

const { Client, LocalAuth } = WAWebJS as any;

// --- config ---
const OUTPUT_DIR = path.join(process.cwd(), "out");
const RAW_PATH = path.join(OUTPUT_DIR, "raw.jsonl");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// --- init database ---
initDb();

// --- WhatsApp client factory ---
function createClient() {
  return new Client({
    authStrategy: new LocalAuth({ dataPath: "./.wwebjs_auth" }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });
}

let client: any = createClient();

// --- QR login
function setupEventHandlers(client: any) {
  client.on("qr", (qr: string) => {
    console.log("\n🔐 Scan this QR in WhatsApp: Settings → Linked Devices → Link a Device\n");
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", async () => {
    console.log("✅ WhatsApp client is ready!");
    try {
      const chats = await client.getChats();
      console.log(`📂 Found ${chats.length} chats`);

      const recentChats = chats
        .filter((c: Chat) => c.name !== "WhatsApp") // skip system chat
        .slice(0, 15);

      for (const chat of recentChats) {
        console.log(`➡️ Chat: ${chat.name || chat.id._serialized}`);
        const messages = await chat.fetchMessages({ limit: 20 });
        for (const m of messages) {
          await saveMessage(m, chat);
        }
      }

      console.log(`💾 Saved messages to raw.jsonl and database`);
    } catch (err: any) {
      console.error("❌ Error during ready handler:", err.message);
    }
  });

  client.on("disconnected", (reason: string) => {
    console.error(`⚠️ Client disconnected: ${reason}. Reconnecting in 5s…`);
    restartClient();
  });
}

// --- Save message helper ---
async function saveMessage(m: Message, chat: Chat) {
  // --- resolve sender ---
  const senderId = m.fromMe ? "me" : (m.author || m.from || chat.id._serialized);

  let savedName: string | null = null;
  let displayName: string | null = null;

  if (!m.fromMe) {
    const contact: Contact = await client.getContactById(senderId).catch(() => null);
    if (contact) {
      savedName = contact.name || null;
      displayName = contact.pushname || null;
    }
  }

  // --- resolve participant (for groups) ---
  let participantId: string | null = null;
  let participantSavedName: string | null = null;
  let participantDisplayName: string | null = null;

  if (chat.isGroup && m.author) {
    participantId = m.author;
    const pContact: Contact = await client.getContactById(participantId).catch(() => null);
    if (pContact) {
      participantSavedName = pContact.name || null;
      participantDisplayName = pContact.pushname || null;
    }
  }

  // --- media metadata ---
  const mediaMeta = m.type && m.type !== "chat"
    ? {
        type: m.type,
        mimetype: m._data?.mimetype,
        filename: m._data?.filename || null,
        filesize: m._data?.size || null,
        durationMs: m._data?.duration || null,
      }
    : null;

  const record = {
    id: m.id.id,
    chatId: chat.id._serialized,
    senderId,
    savedName,
    displayName,
    participantId,
    participantSavedName,
    participantDisplayName,
    fromMe: m.fromMe,
    type: m.type || "unknown",
    body: m.type === "chat" ? m.body : null,
    ts: (m.timestamp || 0) * 1000,
    mimetype: mediaMeta?.mimetype || null,
    filename: mediaMeta?.filename || null,
    filesize: mediaMeta?.filesize || null,
    durationMs: mediaMeta?.durationMs || null,
  };

  // debug: write to JSONL
  fs.appendFileSync(RAW_PATH, JSON.stringify(record) + "\n", "utf8");

  // upsert chat
  await db.insert(schema.chats).values({
    id: chat.id._serialized,
    name: chat.name || chat.formattedTitle || "unknown",
    isGroup: chat.isGroup ?? false,
    archived: (chat as any).archived ?? false,
  }).onConflictDoNothing().execute();

  // upsert contact
  if (senderId && senderId !== "me") {
    await db.insert(schema.contacts).values({
      id: senderId,
      savedName,
      displayName,
    }).onConflictDoNothing().execute();
  }

  // insert message
  await db.insert(schema.messages).values(record).onConflictDoNothing().execute();

  // save reactions
  if (m.reactions?.length) {
    for (const r of m.reactions) {
      await db.insert(schema.reactions).values({
        messageId: m.id.id,
        emoji: r.text,
        senderId: r.id,
      }).execute();
    }
  }
}

// --- restart logic ---
function restartClient() {
  try {
    if (client) client.destroy().catch(() => {});
  } catch (_) {}
  client = createClient();
  setupEventHandlers(client);
  setTimeout(() => {
    client.initialize().catch((err: any) => {
      console.error("⚠️ Init failed, retrying in 10s…", err.message);
      setTimeout(restartClient, 10000);
    });
  }, 5000);
}

// --- start client ---
setupEventHandlers(client);
client.initialize().catch((err: any) => {
  console.error("❌ Failed to start client:", err?.message || err);
  setTimeout(restartClient, 5000);
});
