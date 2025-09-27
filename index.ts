// index.ts
/// <reference path="./types.d.ts" />
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import qrcode from 'qrcode-terminal';
import WAWebJS, { Message, Chat } from 'whatsapp-web.js';
import { db, initDb } from './db/db';
import * as schema from './db/schema';
import { eq } from "drizzle-orm";
import express, { Request, Response } from 'express';
import QRCode from 'qrcode';

const { Client, LocalAuth } = WAWebJS as any;

/* ===========================
   Config
=========================== */
const OUTPUT_DIR = path.join(process.cwd(), 'out');
const RAW_PATH = path.join(OUTPUT_DIR, 'raw.jsonl');
const STATUS_PATH = path.join(OUTPUT_DIR, 'status.json');
const AUTH_DIR = path.join(process.cwd(), '.wwebjs_auth');

const BOOTSTRAP_CHAT_LIMIT = +(process.env.BOOTSTRAP_CHAT_LIMIT || 15);
const BOOTSTRAP_MSG_LIMIT  = +(process.env.BOOTSTRAP_MSG_LIMIT  || 20);

const HEARTBEAT_MS   = +(process.env.HEARTBEAT_MS || 30_000);
const MAX_RETRIES_BEFORE_AUTH_RESET = +(process.env.MAX_RETRIES_BEFORE_AUTH_RESET || 5);
const BASE_RETRY_MS  = +(process.env.BASE_RETRY_MS || 5_000);
const MAX_RETRY_MS   = +(process.env.MAX_RETRY_MS || 60_000);

const LOG_PATH = path.join(OUTPUT_DIR, 'service.log');
const LOG_MAX_BYTES = +(process.env.LOG_MAX_BYTES || 10_000_000); // 10 MB
const LOG_KEEP = +(process.env.LOG_KEEP || 3); // keep service.log.1 .. .3
const BACKFILL_BATCH = +(process.env.BACKFILL_BATCH || 100);

/* ===========================
   Ensure output dir + DB
=========================== */
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
initDb();

// Run database migrations at startup
try {
  log('🔄 Running database migrations...');
  const { execSync } = require('child_process');
  execSync('npx drizzle-kit migrate', { stdio: 'inherit' });
  log('✅ Database migrations completed');
} catch (err: any) {
  log('⚠️ Database migration failed:', err?.message);
  // Don't fail startup if migrations fail - service can still run
}

/* ===========================
   Status helpers
=========================== */
type ServiceState =
  | 'starting'
  | 'waiting_qr'
  | 'connected'
  | 'reconnecting'
  | 'needs_qr'
  | 'error'
  | 'shutting_down';

const status = {
  state: 'starting' as ServiceState,
  lastQrAt: 0,
  lastReadyAt: 0,
  lastMessageAt: 0,
  lastDbWriteAt: 0,   // NEW
  retryCount: 0,
  restartCount: 0,   // NEW
  details: '' as string,
};

function writeStatus(partial: Partial<typeof status>) {
  Object.assign(status, partial);
  try {
    fs.writeFileSync(
      STATUS_PATH,
      JSON.stringify({ ...status, now: Date.now() }, null, 2),
      'utf8'
    );
  } catch {}
}

/* ===========================
   Logging with rotation
=========================== */
function rotateLogIfNeeded() {
  try {
    const stats = fs.statSync(LOG_PATH);
    if (stats.size >= LOG_MAX_BYTES) {
      for (let i = LOG_KEEP; i >= 1; i--) {
        const src = i === 1 ? LOG_PATH : `${LOG_PATH}.${i - 1}`;
        const dest = `${LOG_PATH}.${i}`;
        if (fs.existsSync(src)) {
          try {
            fs.renameSync(src, dest);
          } catch {}
        }
      }
    }
  } catch {
    // no log yet
  }
}

function log(...args: any[]) {
  const ts = new Date().toISOString();
  const line = [ts, ...args].join(' ') + '\n';

  // console
  console.log(line.trim());

  // file
  try {
    rotateLogIfNeeded();
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch (err) {
    console.error('⚠️ Failed to write service.log:', err);
  }
}

/* ===========================
   Client factory
=========================== */
function createClient() {
  return new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });
}

let client: any = createClient();

/* ===========================
   Contact cache
=========================== */
const contactCache = new Map<string, { savedName: string | null; pushname: string | null; timestamp: number }>();
const CONTACT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/* ===========================
   Call state management
=========================== */
interface CallState {
  id: string;
  chatId: string;
  callerId: string;
  calleeId?: string;
  isVideo: boolean;
  isGroup: boolean;
  status: 'pending' | 'connecting' | 'in_progress' | 'ended' | 'rejected' | 'missed';
  startTime: number;
  endTime?: number;
  durationMs?: number;
}

const activeCalls = new Map<string, CallState>();
const CALL_CACHE_TTL = 60 * 60 * 1000; // 1 hour (calls don't last longer than this)

/* ===========================
   QR and HTTP server
=========================== */
let currentQR: string | null = null;
let currentQRBase64: string | null = null;
let httpServer: any = null;

async function generateQRBase64(qrString: string): Promise<string> {
  try {
    return await QRCode.toDataURL(qrString, {
      width: 256,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
  } catch (err) {
    log('❌ Failed to generate QR base64:', err);
    return '';
  }
}

function startHTTPServer() {
  const app = express();
  const PORT = process.env.HTTP_PORT || 3000;

  // QR endpoint - serves current QR as base64
  app.get('/qr', (req, res) => {
    if (!currentQRBase64) {
      return res.status(404).json({
        error: 'No QR code available',
        message: 'QR code will be available when service needs authentication'
      });
    }

    res.json({
      qr: currentQRBase64,
      timestamp: status.lastQrAt,
      expiresAt: status.lastQrAt + (5 * 60 * 1000), // QR expires in 5 minutes
      state: status.state
    });
  });

  // Status endpoint - comprehensive service health
  app.get('/status', (req, res) => {
    const uptime = Date.now() - (status.lastReadyAt || Date.now());
    const dbSize = fs.existsSync(path.join(OUTPUT_DIR, 'messages.db'))
      ? fs.statSync(path.join(OUTPUT_DIR, 'messages.db')).size
      : 0;

    res.json({
      state: status.state,
      uptime,
      lastQrAt: status.lastQrAt,
      lastReadyAt: status.lastReadyAt,
      lastMessageAt: status.lastMessageAt,
      lastDbWriteAt: status.lastDbWriteAt,
      retryCount: status.retryCount,
      restartCount: status.restartCount,
      details: status.details,
      databaseSize: dbSize,
      callsCaptured: activeCalls.size,
      version: '1.0.0',
      timestamp: Date.now()
    });
  });

  // Health check endpoint for containers
  app.get('/health', (req, res) => {
    const isHealthy = status.state === 'connected' &&
                     (Date.now() - status.lastMessageAt) < (10 * 60 * 1000); // 10 minutes

    res.status(isHealthy ? 200 : 503).json({
      healthy: isHealthy,
      state: status.state,
      lastMessageAt: status.lastMessageAt,
      timestamp: Date.now()
    });
  });

  httpServer = app.listen(PORT, () => {
    log(`🌐 HTTP server listening on port ${PORT}`);
    log(`📋 Endpoints: /qr, /status, /health`);
  });

  return app;
}

async function resolveContactName(
  id: string
): Promise<{ savedName: string | null; pushname: string | null }> {
  if (id === 'me') {
    // Don't even try to resolve yourself
    return { savedName: null, pushname: null };
  }

  // Check cache first
  const cached = contactCache.get(id);
  if (cached && (Date.now() - cached.timestamp) < CONTACT_CACHE_TTL) {
    return { savedName: cached.savedName, pushname: cached.pushname };
  }

  try {
    const c: ContactLike = await client.getContactById(id);
    const result = { savedName: c.name || null, pushname: c.pushname || null };

    // Cache the result
    contactCache.set(id, { ...result, timestamp: Date.now() });

    return result;
  } catch (err: any) {
    console.error('❌ Contact resolution failed:', {
      message: err?.message,
      contactId: id,
      timestamp: new Date().toISOString()
    });
    return { savedName: null, pushname: null };
  }
}

/* ===========================
   Name resolution
=========================== */
type ContactLike = { pushname?: string | null; name?: string | null };

function resolvedChatName(chat: Chat): string {
  return (
    chat.name ||
    (chat as any).formattedTitle ||
    chat.id?._serialized ||
    'unknown'
  );
}

/* ===========================
   Save message
=========================== */
async function saveMessage(m: Message, chat: Chat) {
  const senderId = m.fromMe ? 'me' : (m.author || m.from || chat.id._serialized);

  const { savedName, pushname } = await resolveContactName(senderId);
  const displayName = savedName || pushname || senderId;

  let participantId: string | null = null;
  let participantName: string | null = null;
  if (chat.isGroup && m.author) {
    participantId = m.author;
    const part = await resolveContactName(participantId);
    participantName = part.savedName || part.pushname || participantId;
  }

  const mediaMeta =
    m.type && m.type !== 'chat'
      ? {
          type: m.type,
          mimetype: (m as any)._data?.mimetype,
          filename: (m as any)._data?.filename || null,
          filesize: (m as any)._data?.size || null,
          durationMs: (m as any)._data?.duration || null,
        }
      : null;

  const record = {
    id: m.id.id,
    chatId: chat.id._serialized,
    senderId,
    savedName,
    pushname,
    displayName,
    participantId,
    participantName,
    fromMe: m.fromMe,
    type: m.type || 'unknown',
    body: m.type === 'chat' ? m.body : null,
    ts: (m.timestamp || 0) * 1000,
    mimetype: mediaMeta?.mimetype || null,
    filename: mediaMeta?.filename || null,
    filesize: mediaMeta?.filesize || null,
    durationMs: mediaMeta?.durationMs || null,
  };

  // Write to raw JSONL first (most important)
  try {
    fs.appendFileSync(RAW_PATH, JSON.stringify(record) + '\n', 'utf8');
  } catch (err: any) {
    console.error('❌ Failed to write to raw JSONL:', {
      message: err?.message,
      stack: err?.stack,
      messageId: m.id.id
    });
    return; // Don't continue if we can't log the raw message
  }

  // Database operations with comprehensive error handling
  try {
    // Upsert chat (if not WhatsApp)
    if (chat.name !== 'WhatsApp') {
      await db
        .insert(schema.chats)
        .values({
          id: chat.id._serialized,
          name: chat.name || chat.formattedTitle || 'unknown',
          isGroup: chat.isGroup ?? false,
          archived: (chat as any).archived ?? false,
        })
        .onConflictDoNothing()
        .execute();
    }

    // Upsert contact (if not from me)
    if (senderId && senderId !== 'me') {
      await db
        .insert(schema.contacts)
        .values({
          id: senderId,
          savedName,
          pushname,
          displayName,
        })
        .onConflictDoNothing()
        .execute();
    }

    // Insert message (most critical)
    await db
      .insert(schema.messages)
      .values(record)
      .onConflictDoNothing()
      .execute();

    // Insert reactions
    if (m.reactions?.length) {
      for (const r of m.reactions) {
        await db
          .insert(schema.reactions)
          .values({
            messageId: m.id.id,
            emoji: r.text,
            senderId: r.id,
          })
          .execute();
      }
    }

    status.lastMessageAt = Date.now();
    status.lastDbWriteAt = Date.now();

  } catch (err: any) {
    console.error('❌ Database operation failed:', {
      message: err?.message,
      stack: err?.stack,
      name: err?.name,
      timestamp: new Date().toISOString(),
      messageId: m.id.id,
      chatId: chat.id._serialized,
      operation: 'saveMessage'
    });
    // Don't rethrow - we still have the raw JSONL log
  }

  log(`💬 New message in ${chat.name || displayName}`);
}

/* ===========================
   Save call
=========================== */
async function saveCall(callEvent: any) {
  try {
    const callState = activeCalls.get(callEvent.id);
    if (!callState) {
      log(`📞 Call event (no active state): ${callEvent.id}`);
      return;
    }

    const callRecord = {
      id: callState.id,
      chatId: callState.chatId,
      callerId: callState.callerId,
      calleeId: callState.calleeId,
      isVideo: callState.isVideo,
      isGroup: callState.isGroup,
      timestamp: callState.startTime,
      durationMs: callState.durationMs,
      status: callState.status,
      endTimestamp: callState.endTime,
    };

    // Write to raw JSONL first (backup)
    const rawCallPath = path.join(OUTPUT_DIR, 'calls.jsonl');
    fs.appendFileSync(rawCallPath, JSON.stringify({
      ...callRecord,
      rawEvent: callEvent,
      capturedAt: Date.now()
    }) + '\n', 'utf8');

    // Database insert with error handling
    await db
      .insert(schema.calls)
      .values(callRecord)
      .onConflictDoNothing()
      .execute();

    // Update status
    status.lastDbWriteAt = Date.now();

    log(`📞 Call saved: ${callState.isVideo ? '🎥' : '📞'} ${callState.status} (${callState.durationMs ? Math.round(callState.durationMs / 1000) + 's' : 'unknown duration'})`);

    // Clean up completed calls from memory
    if (['ended', 'rejected', 'missed'].includes(callState.status)) {
      activeCalls.delete(callEvent.id);
    }

  } catch (err: any) {
    console.error('❌ Call save failed:', {
      message: err?.message,
      stack: err?.stack,
      name: err?.name,
      timestamp: new Date().toISOString(),
      callId: callEvent.id
    });
  }
}

/* ===========================
   Handle call events
=========================== */
function setupCallHandlers(client: any) {
  // Main call event
  client.on('call', async (callEvent: any) => {
    try {
      log(`📞 Call initiated: ${callEvent.id} ${callEvent.isVideo ? '🎥' : '📞'}`);

      const callState: CallState = {
        id: callEvent.id,
        chatId: callEvent.to, // The chat/group being called
        callerId: callEvent.from,
        calleeId: callEvent.isGroup ? undefined : callEvent.to,
        isVideo: callEvent.isVideo || false,
        isGroup: callEvent.isGroup || false,
        status: 'pending',
        startTime: Date.now(),
      };

      activeCalls.set(callEvent.id, callState);

    } catch (err: any) {
      console.error('❌ Call event handling failed:', {
        message: err?.message,
        stack: err?.stack,
        callId: callEvent?.id
      });
    }
  });

  // Call state changes
  client.on('call:state_change', async (callEvent: any) => {
    try {
      const existingCall = activeCalls.get(callEvent.id);
      if (!existingCall) {
        log(`📞 Call state change for unknown call: ${callEvent.id}`);
        return;
      }

      // Update call state
      const updatedCall: CallState = {
        ...existingCall,
        status: callEvent.state || existingCall.status,
      };

      // Calculate duration if call is ending
      if (['ended', 'rejected', 'missed'].includes(callEvent.state)) {
        updatedCall.endTime = Date.now();
        updatedCall.durationMs = updatedCall.endTime - updatedCall.startTime;
      }

      activeCalls.set(callEvent.id, updatedCall);

      // Save to database when call completes
      if (['ended', 'rejected', 'missed'].includes(callEvent.state)) {
        await saveCall(callEvent);
      }

      log(`📞 Call ${callEvent.id} state: ${callEvent.state}`);

    } catch (err: any) {
      console.error('❌ Call state change handling failed:', {
        message: err?.message,
        stack: err?.stack,
        callId: callEvent?.id
      });
    }
  });
}

/* ===========================
   Bootstrap
=========================== */
async function bootstrap() {
  const chats: Chat[] = await client.getChats();
  const filtered = chats
    .filter((c: Chat) => resolvedChatName(c) !== 'WhatsApp')
    .slice(0, BOOTSTRAP_CHAT_LIMIT);

  log(`📂 Found ${chats.length} chats`);
  for (const chat of filtered) {
    log(`➡️ Chat: ${resolvedChatName(chat)}`);
    const messages = await chat.fetchMessages({ limit: BOOTSTRAP_MSG_LIMIT });
    for (const m of messages) {
      await saveMessage(m, chat);
    }
  }
  log('💾 Saved messages to raw.jsonl and database');
}

/* ===========================
   Backfill worker
=========================== */
async function backfill() {
  try {
    log(`🔄 Backfill: scanning chats…`);
    const chats: Chat[] = await client.getChats();

    for (const chat of chats) {
      if (resolvedChatName(chat) === 'WhatsApp') continue;

      const existing = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.chatId, chat.id._serialized))
        .limit(1);

      if (existing.length < 100) {
        log(
          `📥 Backfilling ${BACKFILL_BATCH} messages for ${resolvedChatName(
            chat
          )}`
        );
        const msgs = await chat.fetchMessages({ limit: BACKFILL_BATCH });
        for (const m of msgs) {
          await saveMessage(m, chat);
        }
      }
    }
    log('✅ Backfill complete');
  } catch (err: any) {
    console.error("❌ Backfill error:", {
      message: err?.message,
      stack: err?.stack,
      name: err?.name,
      timestamp: new Date().toISOString()
    });
  }
}

/* ===========================
   Backfill scheduler
=========================== */
function scheduleBackfill() {
  // Initial run: 10 minutes after login
  setTimeout(() => {
    log("🕒 Running initial delayed backfill (10m after login)...");
    backfill();
  }, 10 * 60 * 1000);

  // Daily run: every 24h ±30m jitter
  const DAY_MS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    const jitter = (Math.random() - 0.5) * 60 * 60 * 1000; // ±30m
    const delay = Math.max(0, DAY_MS + jitter);

    log(`🕒 Scheduling daily backfill with jitter (${(delay/60000).toFixed(0)}m)...`);
    setTimeout(() => {
      backfill();
    }, delay);
  }, DAY_MS);
}


/* ===========================
   Event handlers
=========================== */
function setupEventHandlers(c: any) {
  c.on('qr', async (qr: string) => {
    currentQR = qr;
    currentQRBase64 = await generateQRBase64(qr);

    writeStatus({
      state: 'waiting_qr',
      lastQrAt: Date.now(),
      details: 'Scan the QR in WhatsApp → Linked Devices',
    });

    console.log(
      '\n🔐 Scan this QR in WhatsApp: Settings → Linked Devices → Link a Device\n'
    );
    qrcode.generate(qr, { small: true });

    // Start HTTP server when QR is available
    if (!httpServer) {
      startHTTPServer();
    }
  });

  c.on('ready', async () => {
    writeStatus({ state: 'connected', lastReadyAt: Date.now(), details: '' });
    log('✅ WhatsApp client is ready!');
    try {
      await bootstrap();
      scheduleBackfill();
      if (process.env.BACKFILL_ALL === 'true') {
        setTimeout(() => backfill(), 5_000);
      }
    } catch (err: any) {
      writeStatus({
        state: 'error',
        details: `Bootstrap failed: ${err?.message || err}`,
      });
      console.error('❌ Bootstrap error:', {
        message: err?.message,
        stack: err?.stack,
        name: err?.name,
        timestamp: new Date().toISOString()
      });
    }
  });

  c.on('message_create', async (m: Message) => {
    try {
      const chat = await m.getChat();
      await saveMessage(m, chat);
    } catch (err: any) {
      console.error('❌ Failed to save live message:', {
        message: err?.message,
        stack: err?.stack,
        name: err?.name,
        timestamp: new Date().toISOString(),
        messageId: m?.id?.id || 'unknown'
      });
    }
  });

  c.on('disconnected', async (reason: string) => {
    writeStatus({ state: 'reconnecting', details: `Disconnected: ${reason}` });
    log(`⚠️ Client disconnected: ${reason}. Reconnecting…`);
    await scheduleReconnect();
  });
}

/* ===========================
   Reconnect & auth reset
=========================== */
let reconnectTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

async function safeDestroy() {
  try {
    await client.destroy();
  } catch {}
}

async function scheduleReconnect() {
  if (shuttingDown) return;

  status.retryCount += 1;
  status.restartCount += 1;

  const delay = Math.min(
    BASE_RETRY_MS * Math.pow(2, status.retryCount - 1),
    MAX_RETRY_MS
  );
  writeStatus({
    state: 'reconnecting',
    details: `Retry #${status.retryCount} in ${delay}ms`,
  });

  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    try {
      await safeDestroy();
      client = createClient();
      setupEventHandlers(client);

      if (status.retryCount > MAX_RETRIES_BEFORE_AUTH_RESET) {
        log('❌ Too many retries → clearing auth and requiring QR scan.');
        writeStatus({
          state: 'needs_qr',
          details: 'Session expired. Clearing auth; will request new QR.',
        });
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch {}
        status.retryCount = 0;
      }

      await client.initialize();
    } catch (err: any) {
      console.error('⚠️ Init failed:', {
        message: err?.message,
        stack: err?.stack,
        name: err?.name,
        timestamp: new Date().toISOString()
      });
      await scheduleReconnect();
    }
  }, delay);
}

/* ===========================
   Heartbeat
=========================== */
setInterval(async () => {
  const now = Date.now();

  try {
    const s = await client.getState();
    if (s !== 'CONNECTED') {
      log(`⚠️ Heartbeat: client state = ${s}. Triggering reconnect.`);
      await scheduleReconnect();
      return;
    }
  } catch {
    log('❌ Heartbeat: failed to get client state. Triggering reconnect.');
    await scheduleReconnect();
    return;
  }

  const sinceMsg = status.lastMessageAt ? now - status.lastMessageAt : null;
  if (sinceMsg !== null) {
    log(`⏳ Heartbeat: last message ${(sinceMsg / 1000).toFixed(0)}s ago`);
  }

  writeStatus({});
}, HEARTBEAT_MS);

/* ===========================
   Startup & shutdown
=========================== */
async function start() {
  writeStatus({ state: 'starting', details: 'Initializing client…' });
  setupEventHandlers(client);
  setupCallHandlers(client); // Add call event handlers

  // Start HTTP server for QR and status endpoints
  startHTTPServer();

  try {
    await client.initialize();
  } catch (err: any) {
    console.error('⚠️ Initial init failed:', {
      message: err?.message,
      stack: err?.stack,
      name: err?.name,
      timestamp: new Date().toISOString()
    });
    await scheduleReconnect();
  }
}

async function shutdown() {
  shuttingDown = true;
  writeStatus({
    state: 'shutting_down',
    details: 'Received termination signal',
  });
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try {
    await safeDestroy();
  } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
