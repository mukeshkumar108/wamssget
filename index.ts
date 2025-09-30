// index.ts
/// <reference path="./types.d.ts" />
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import qrcode from 'qrcode-terminal';
import WAWebJS, { Message, Chat } from 'whatsapp-web.js';
import { db, initDb } from './db/db';
import * as schema from './db/schema';
import { eq, desc, gte, and, sql } from "drizzle-orm";

// Continuity management for zero-loss message recovery
let lastProcessedTimestamp = 0;

async function initializeContinuity(): Promise<void> {
  try {
    // Try to get existing continuity record
    const continuityRecords = await db
      .select({ lastProcessedTimestamp: schema.continuity.lastProcessedTimestamp })
      .from(schema.continuity)
      .limit(1);

    if (continuityRecords.length > 0) {
      lastProcessedTimestamp = continuityRecords[0].lastProcessedTimestamp || 0;
      log(`📊 Loaded continuity watermark: ${lastProcessedTimestamp} (${new Date(lastProcessedTimestamp).toISOString()})`);
    } else {
      // Initialize continuity record
      await db
        .insert(schema.continuity)
        .values({
          id: 1,
          lastProcessedTimestamp: 0
        })
        .onConflictDoNothing()
        .execute();

      lastProcessedTimestamp = 0;
      log('📊 Initialized new continuity record at timestamp 0');
    }
  } catch (err: any) {
    log('⚠️ Failed to initialize continuity, falling back to 0:', err?.message);
    lastProcessedTimestamp = 0;
  }
}

// Update continuity watermark in both memory and database
async function updateContinuity(timestamp: number): Promise<void> {
  lastProcessedTimestamp = Math.max(lastProcessedTimestamp, timestamp);

  try {
    await db
      .update(schema.continuity)
      .set({ lastProcessedTimestamp })
      .where(eq(schema.continuity.id, 1))
      .execute();
  } catch (err: any) {
    console.error('❌ Failed to update continuity in DB:', err?.message);
    // Continue with memory update - DB failure shouldn't break message processing
  }
}
import express from 'express';
import { Request, Response } from 'express';
import QRCode from 'qrcode';

const { Client, LocalAuth } = WAWebJS as any;

/* ===========================
   Config & State
=========================== */
const OUTPUT_DIR = path.join(process.cwd(), 'out');
const RAW_PATH = path.join(OUTPUT_DIR, 'raw.jsonl');
const STATUS_PATH = path.join(OUTPUT_DIR, 'status.json');

// Create output directory only if it doesn't exist (not required in container)
try {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
} catch (err) {
  console.warn('Could not create output directory:', err);
}
const AUTH_DIR = path.join(process.cwd(), '.wwebjs_auth');

const ENABLE_BACKFILL = process.env.ENABLE_BACKFILL !== 'false';

const BOOTSTRAP_CHAT_LIMIT = +(process.env.BOOTSTRAP_CHAT_LIMIT || 15);
const BOOTSTRAP_MSG_LIMIT  = +(process.env.BOOTSTRAP_MSG_LIMIT  || 20);

const HEARTBEAT_MS   = +(process.env.HEARTBEAT_MS || 30_000);
const MAX_RETRIES_BEFORE_AUTH_RESET = +(process.env.MAX_RETRIES_BEFORE_AUTH_RESET || 5);
const BASE_RETRY_MS  = +(process.env.BASE_RETRY_MS || 5_000);
const MAX_RETRY_MS   = +(process.env.MAX_RETRY_MS || 60_000);

// Continuity monitoring
const CONTINUITY_WARN_MINUTES = +(process.env.CONTINUITY_WARN_MINUTES || 10);

const LOG_PATH = path.join(OUTPUT_DIR, 'service.log');
const LOG_MAX_BYTES = +(process.env.LOG_MAX_BYTES || 10_000_000); // 10 MB
const LOG_KEEP = +(process.env.LOG_KEEP || 3); // keep service.log.1 .. .3
const BACKFILL_BATCH = +(process.env.BACKFILL_BATCH || 100);

/* ===========================
   Ensure output dir + DB
=========================== */
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
initDb();

// Create database indexes for API performance
async function createIndexes() {
  try {
    log('🔍 Creating database indexes for API performance...');

    // Message indexes
    await (db as any).run(sql.raw(schema.messageIndexes.chatIdTs));
    await (db as any).run(sql.raw(schema.messageIndexes.senderIdTs));
    await (db as any).run(sql.raw(schema.messageIndexes.ts));
    await (db as any).run(sql.raw(schema.messageIndexes.type));

    // Call indexes
    await (db as any).run(sql.raw(schema.callIndexes.timestamp));
    await (db as any).run(sql.raw(schema.callIndexes.chatId));
    await (db as any).run(sql.raw(schema.callIndexes.callerId));

    // Chat indexes
    await (db as any).run(sql.raw(schema.chatIndexes.isGroup));
    await (db as any).run(sql.raw(schema.chatIndexes.archived));

    log('✅ Database indexes created successfully');
  } catch (err: any) {
    log('⚠️ Database index creation failed:', err?.message);
    // Don't fail startup if index creation fails
  }
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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--no-zygote',
        '--single-process'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    },
  });
}

let client: any = createClient();

// Track successful initial connection (for heartbeat logic)
let everConnected = false;  // Only activate aggressive heartbeat after first success

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

  // Middleware
  app.use(express.json());

  // API Key authentication middleware
  const authenticate = (req: Request, res: Response, next: any) => {
    const authHeader = req.headers.authorization;
    const apiKey = process.env.API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);
    if (token !== apiKey) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    next();
  };

  // QR endpoint - serves current QR as base64
  app.get('/qr', (req: Request, res: Response) => {
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
  app.get('/status', (req: Request, res: Response) => {
    const uptime = Date.now() - (status.lastReadyAt || Date.now());
    const dbSize = fs.existsSync(path.join(process.cwd(), 'data/app.sqlite'))
      ? fs.statSync(path.join(process.cwd(), 'data/app.sqlite')).size
      : 0;

    res.json({
      state: status.state,
      uptime,
      lastQrAt: status.lastQrAt,
      lastReadyAt: status.lastReadyAt,
      lastMessageAt: status.lastMessageAt,
      lastDbWriteAt: status.lastDbWriteAt,
      lastProcessedTimestamp, // ← Continuity watermark for zero-loss reconnection
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
  app.get('/health', (req: Request, res: Response) => {
    const isHealthy = status.state === 'connected' &&
                     (Date.now() - status.lastMessageAt) < (10 * 60 * 1000); // 10 minutes

    res.status(isHealthy ? 200 : 503).json({
      healthy: isHealthy,
      state: status.state,
      lastMessageAt: status.lastMessageAt,
      timestamp: Date.now()
    });
  });

  // API Routes - Messages
  app.get('/api/messages/recent-chats', authenticate, async (req: Request, res: Response) => {
    try {
      const chatsCount = Math.min(parseInt(req.query.chats as string) || 5, 50);
      const messagesPerChat = Math.min(parseInt(req.query.messages as string) || 10, 100);

      // Get recent chats with their latest messages (exclude WhatsApp system chat)
      const chats = await db
        .select({
          id: schema.chats.id,
          name: schema.chats.name,
          isGroup: schema.chats.isGroup,
          archived: schema.chats.archived,
        })
        .from(schema.chats)
        .where(sql`name != 'WhatsApp'`)
        .orderBy(desc(schema.chats.id))
        .limit(chatsCount);

      const result = [];

      for (const chat of chats) {
        const messages = await db
          .select({
            id: schema.messages.id,
            chatId: schema.messages.chatId,
            senderId: schema.messages.senderId,
            displayName: schema.messages.displayName,
            fromMe: schema.messages.fromMe,
            type: schema.messages.type,
            body: schema.messages.body,
            timestamp: schema.messages.ts,
          })
          .from(schema.messages)
          .where(eq(schema.messages.chatId, chat.id))
          .orderBy(desc(schema.messages.ts))
          .limit(messagesPerChat);

        if (messages.length > 0) {
          result.push({
            chatId: chat.id,
            chatName: chat.name,
            isGroup: chat.isGroup,
            messages: messages.reverse() // Oldest first
          });
        }
      }

      res.json({ chats: result });
    } catch (err: any) {
      log('❌ API Error /api/messages/recent-chats:', err?.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/messages/chat/:chatId', authenticate, async (req: Request, res: Response) => {
    try {
      const { chatId } = req.params;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
      const offset = parseInt(req.query.offset as string) || 0;

      const messages = await db
        .select({
          id: schema.messages.id,
          chatId: schema.messages.chatId,
          senderId: schema.messages.senderId,
          displayName: schema.messages.displayName,
          fromMe: schema.messages.fromMe,
          type: schema.messages.type,
          body: schema.messages.body,
          timestamp: schema.messages.ts,
          mimetype: schema.messages.mimetype,
          filename: schema.messages.filename,
          filesize: schema.messages.filesize,
          durationMs: schema.messages.durationMs,
        })
        .from(schema.messages)
        .where(eq(schema.messages.chatId, chatId))
        .orderBy(desc(schema.messages.ts))
        .limit(limit)
        .offset(offset);

      // Get total count
      const totalResult = await (db as any).select({
        count: sql`count(*)`.as('count')
      }).from(schema.messages).where(eq(schema.messages.chatId, chatId));

      const total = totalResult[0]?.count || 0;

      res.json({
        messages: messages.reverse(), // Oldest first
        total,
        hasMore: (offset + limit) < total,
        chatId
      });
    } catch (err: any) {
      log('❌ API Error /api/messages/chat/:chatId:', err?.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/messages/contact/:contactId', authenticate, async (req: Request, res: Response) => {
    try {
      const { contactId } = req.params;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
      const offset = parseInt(req.query.offset as string) || 0;

      const messages = await db
        .select({
          id: schema.messages.id,
          chatId: schema.messages.chatId,
          senderId: schema.messages.senderId,
          displayName: schema.messages.displayName,
          fromMe: schema.messages.fromMe,
          type: schema.messages.type,
          body: schema.messages.body,
          timestamp: schema.messages.ts,
          mimetype: schema.messages.mimetype,
          filename: schema.messages.filename,
          filesize: schema.messages.filesize,
          durationMs: schema.messages.durationMs,
        })
        .from(schema.messages)
        .where(eq(schema.messages.senderId, contactId))
        .orderBy(desc(schema.messages.ts))
        .limit(limit)
        .offset(offset);

      // Get contact info
      const contact = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, contactId))
        .limit(1);

      // Get total count
      const totalResult = await (db as any).select({
        count: sql`count(*)`.as('count')
      }).from(schema.messages).where(eq(schema.messages.senderId, contactId));

      const total = totalResult[0]?.count || 0;

      res.json({
        messages: messages.reverse(), // Oldest first
        contact: contact[0] || null,
        total,
        hasMore: (offset + limit) < total,
        contactId
      });
    } catch (err: any) {
      log('❌ API Error /api/messages/contact/:contactId:', err?.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/messages/recent', authenticate, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);

      const messages = await db
        .select({
          id: schema.messages.id,
          chatId: schema.messages.chatId,
          senderId: schema.messages.senderId,
          displayName: schema.messages.displayName,
          fromMe: schema.messages.fromMe,
          type: schema.messages.type,
          body: schema.messages.body,
          timestamp: schema.messages.ts,
          mimetype: schema.messages.mimetype,
          filename: schema.messages.filename,
          filesize: schema.messages.filesize,
          durationMs: schema.messages.durationMs,
        })
        .from(schema.messages)
        .orderBy(desc(schema.messages.ts))
        .limit(limit);

      res.json({
        messages: messages.reverse(), // Oldest first
        total: messages.length,
        limit
      });
    } catch (err: any) {
      log('❌ API Error /api/messages/recent:', err?.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/messages/since', authenticate, async (req: Request, res: Response) => {
    try {
      const ts = parseInt(req.query.ts as string);
      if (!ts || isNaN(ts)) {
        return res.status(400).json({ error: 'Invalid timestamp parameter' });
      }

      const messages = await db
        .select({
          id: schema.messages.id,
          chatId: schema.messages.chatId,
          senderId: schema.messages.senderId,
          displayName: schema.messages.displayName,
          fromMe: schema.messages.fromMe,
          type: schema.messages.type,
          body: schema.messages.body,
          timestamp: schema.messages.ts,
          mimetype: schema.messages.mimetype,
          filename: schema.messages.filename,
          filesize: schema.messages.filesize,
          durationMs: schema.messages.durationMs,
        })
        .from(schema.messages)
        .where(gte(schema.messages.ts, ts))
        .orderBy(desc(schema.messages.ts));

      res.json({
        messages: messages.reverse(), // Oldest first
        total: messages.length,
        since: ts
      });
    } catch (err: any) {
      log('❌ API Error /api/messages/since:', err?.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // API Routes - Calls
  app.get('/api/calls/recent', authenticate, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);

      const calls = await db
        .select({
          id: schema.calls.id,
          chatId: schema.calls.chatId,
          callerId: schema.calls.callerId,
          calleeId: schema.calls.calleeId,
          isVideo: schema.calls.isVideo,
          isGroup: schema.calls.isGroup,
          timestamp: schema.calls.timestamp,
          durationMs: schema.calls.durationMs,
          status: schema.calls.status,
          endTimestamp: schema.calls.endTimestamp,
        })
        .from(schema.calls)
        .orderBy(desc(schema.calls.timestamp))
        .limit(limit);

      res.json({
        calls: calls.reverse(), // Oldest first
        total: calls.length,
        limit
      });
    } catch (err: any) {
      log('❌ API Error /api/calls/recent:', err?.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/calls/since', authenticate, async (req: Request, res: Response) => {
    try {
      const ts = parseInt(req.query.ts as string);
      if (!ts || isNaN(ts)) {
        return res.status(400).json({ error: 'Invalid timestamp parameter' });
      }

      const calls = await db
        .select({
          id: schema.calls.id,
          chatId: schema.calls.chatId,
          callerId: schema.calls.callerId,
          calleeId: schema.calls.calleeId,
          isVideo: schema.calls.isVideo,
          isGroup: schema.calls.isGroup,
          timestamp: schema.calls.timestamp,
          durationMs: schema.calls.durationMs,
          status: schema.calls.status,
          endTimestamp: schema.calls.endTimestamp,
        })
        .from(schema.calls)
        .where(gte(schema.calls.timestamp, ts))
        .orderBy(desc(schema.calls.timestamp));

      res.json({
        calls: calls.reverse(), // Oldest first
        total: calls.length,
        since: ts
      });
    } catch (err: any) {
      log('❌ API Error /api/calls/since:', err?.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  httpServer = app.listen(PORT, () => {
    log(`🌐 HTTP server listening on port ${PORT}`);
    log(`📋 Public endpoints: /qr, /status, /health`);
    log(`🔐 API endpoints: /api/messages/*, /api/calls/*`);
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

    // Update message continuity watermark for zero-loss reconnection
    lastProcessedTimestamp = Math.max(lastProcessedTimestamp, m.timestamp);

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
   Helper functions
=========================== */
async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Check if WhatsApp connection is stable enough for bootstrap operations
async function isConnectionStable(): Promise<boolean> {
  try {
    const state = await client.getState();
    // Require: CONNECTED state + 3 seconds uptime to stabilize
    const uptimeMs = Date.now() - status.lastReadyAt;
    return state === 'CONNECTED' && uptimeMs > 3000;
  } catch {
    return false; // If can't get state, assume unstable
  }
}

async function getMessageCount(chatId: string): Promise<number> {
  const result = await (db as any).select({
    count: sql`count(*)`.as('count')
  }).from(schema.messages).where(eq(schema.messages.chatId, chatId));
  return result[0]?.count || 0;
}

async function getActiveChatsLast24h(limit: number): Promise<Array<{chatId: string, count: number}>> {
  const sinceTs = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago
  const result = await (db as any).select({
    chatId: schema.messages.chatId,
    count: sql`count(*)`.as('count')
  }).from(schema.messages)
    .where(gte(schema.messages.ts, sinceTs))
    .groupBy(schema.messages.chatId)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
  return result.map((row: any) => ({ chatId: row.chatId, count: row.count }));
}

async function getChatsByRecency(limit: number): Promise<Chat[]> {
  const allChats = await client.getChats();
  const filtered = allChats
    .filter((c: Chat) => resolvedChatName(c) !== 'WhatsApp')
    .slice(0, limit);
  return filtered;
}

/* ===========================
   Bootstrap
=========================== */
async function bootstrap() {
  const chats = await getChatsByRecency(10); // Only 10 most recent chats

  log(`📂 Found ${chats.length} chats for bootstrap`);
  for (const chat of chats) {
    log(`➡️ Bootstrap chat: ${resolvedChatName(chat)}`);
    const messages = await chat.fetchMessages({ limit: 10 }); // Only last 10 messages
    for (const m of messages) {
      await saveMessage(m, chat); // Save each immediately
    }
  }
  log('💾 Bootstrap complete - switched to live listening');
}

/* ===========================
   Progressive Enrichment (replaces old backfill)
=========================== */
async function progressiveEnrichment() {
  if (!ENABLE_BACKFILL) {
    log('ℹ️ Progressive enrichment skipped (ENABLE_BACKFILL=false)');
    return;
  }

  try {
    log(`🔄 Starting progressive enrichment...`);

    // Get all chats by recency (more than 20 to select from)
    const allChats = await getChatsByRecency(25); // Get more than needed to select from

    // Phase 1: For initial 10 chats, enrich if <20 messages
    const phase1Chats = allChats.slice(0, 10);
    log(`📥 Phase 1: Processing ${phase1Chats.length} chats (enrich <20 messages)`);
    for (const chat of phase1Chats) {
      const count = await getMessageCount(chat.id._serialized);
      if (count < 20) {
        log(`➡️ Enriching ${resolvedChatName(chat)} (${count} → ${count + 20} messages)`);
        const msgs = await chat.fetchMessages({ limit: 20 });
        for (const m of msgs) {
          await saveMessage(m, chat);
        }
      }
      await delay(1500); // 1.5s delay between chats
    }

    // Phase 2: For next 10 chats (11-20), fetch 30 messages each
    const phase2Chats = allChats.slice(10, 20);
    log(`📥 Phase 2: Processing ${phase2Chats.length} chats (30 messages each)`);
    for (const chat of phase2Chats) {
      log(`➡️ Fetching 30 messages for ${resolvedChatName(chat)}`);
      const msgs = await chat.fetchMessages({ limit: 30 });
      for (const m of msgs) {
        await saveMessage(m, chat);
      }
      await delay(1500); // 1.5s delay between chats
    }

    log('✅ Progressive enrichment complete');
  } catch (err: any) {
    console.error("❌ Progressive enrichment error:", {
      message: err?.message,
      stack: err?.stack,
      name: err?.name,
      timestamp: new Date().toISOString()
    });
  }
}

/* ===========================
   Daily active chat backfill
=========================== */
async function dailyActiveChatBackfill() {
  if (!ENABLE_BACKFILL) return;

  try {
    log(`📊 Daily active chat backfill: finding top 10 chats by recent activity...`);
    const activeChats = await getActiveChatsLast24h(10);

    for (const { chatId, count: recentCount } of activeChats) {
      const totalCount = await getMessageCount(chatId);
      if (totalCount < 20) {
        log(`📥 Daily: ${chatId} has ${totalCount} stored, fetching 20 more (recent activity: ${recentCount})`);
        const chat = await client.getChatById(chatId);
        const msgs = await chat.fetchMessages({ limit: 20 });
        for (const m of msgs) {
          await saveMessage(m, chat);
        }
        await delay(1500); // Respectful delay
      }
    }
    log('✅ Daily active chat backfill complete');
  } catch (err: any) {
    console.error("❌ Daily active chat backfill error:", {
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
  if (!ENABLE_BACKFILL) {
    log('ℹ️ Backfill scheduling skipped (ENABLE_BACKFILL=false)');
    return;
  }

  // Initial progressive enrichment: 2 minutes after login
  setTimeout(() => {
    log("🕒 Running initial progressive enrichment (2m after login)...");
    progressiveEnrichment();
  }, 2 * 60 * 1000);

  // Daily active chat backfill: every 24h ±1h jitter
  const DAY_MS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    const jitter = (Math.random() - 0.5) * 2 * 60 * 60 * 1000; // ±1h
    const delay = Math.max(0, DAY_MS + jitter);

    log(`🕒 Scheduling daily active chat backfill with jitter (${(delay/60000).toFixed(0)}m)...`);
    setTimeout(() => {
      dailyActiveChatBackfill();
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

    // Allow browser session to stabilize before heavy operations
    await delay(2000);

    try {
      // Create database indexes for API performance (non-fatal)
      await createIndexes();

      // Only bootstrap if connection is verified stable
      if (await isConnectionStable()) {
        await bootstrap();
        scheduleBackfill();
      } else {
        log('⏳ Bootstrap postponed - waiting for additional connection stability');
        setTimeout(async () => {
          await bootstrap();
          scheduleBackfill();
        }, 2000);
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
   Heartbeat - Only active after first connection
=========================== */
setInterval(async () => {
  const now = Date.now();

  try {
    const s = await client.getState();

    if (s !== 'CONNECTED') {
      // Only trigger ACTIVE reconnection if we fell from connected state
      // During initial connection, just observe without trying to fix
      if (everConnected) {
        log(`⚠️ Heartbeat: client disconnected (state = ${s}). Triggering reconnect.`);
        await scheduleReconnect();
        return;
      } else {
        log(`⏳ Heartbeat: Initial connection in progress (state = ${s}). Waiting...`);
        // Don't trigger reconnection during first-time setup
        return;
      }
    }
  } catch (err) {
    // Similar logic for state check failures
    if (everConnected) {
      log('❌ Heartbeat: Cannot determine client state. Triggering reconnect.');
      await scheduleReconnect();
      return;
    } else {
      log('⏳ Heartbeat: Cannot check state during initial connection attempt.');
      return;
    }
  }

  const sinceMsg = status.lastMessageAt ? now - status.lastMessageAt : null;
  if (sinceMsg !== null) {
    log(`⏳ Heartbeat: last message ${(sinceMsg / 1000).toFixed(0)}s ago`);
  }

  // Continuity monitoring - warn if processing has stalled
  if (status.state === 'connected' && lastProcessedTimestamp > 0) {
    const staleness = (now - lastProcessedTimestamp * 1000) / (60 * 1000); // Minutes
    if (staleness > CONTINUITY_WARN_MINUTES) {
      log(`⚠️ WARNING: Message continuity stale for ${staleness.toFixed(1)} min (last processed: ${new Date(lastProcessedTimestamp * 1000).toISOString()}) - potential processing issues`);
    }
  }

  writeStatus({});
}, HEARTBEAT_MS);

/* ===========================
   Startup & shutdown
=========================== */
async function start() {
  writeStatus({ state: 'starting', details: 'Initializing client…' });

  // Initialize message continuity for zero-loss recovery
  try {
    await initializeContinuity();
  } catch (err: any) {
    log('⚠️ Continuity initialization failed, falling back to 0:', err?.message);
    lastProcessedTimestamp = 0;
  }

  setupEventHandlers(client);
  setupCallHandlers(client); // Add call event handlers

  // Start HTTP server for QR and status endpoints
  startHTTPServer();

  try {
    await client.initialize();
  } catch (err: any) {
    console.error('⚠️ Initial client init failed:', {
      message: err?.message,
      stack: err?.stack,
      name: err?.name,
      timestamp: new Date().toISOString()
    });

    // For initial connection failures, create new client and retry immediately
    // This prevents container restart and QR rescanning
    log('🔄 Creating new Puppeteer client for immediate retry...');
    client = createClient();
    setupEventHandlers(client);
    setupCallHandlers(client);

    // Retry initialization with new client
    try {
      log('🔄 Retrying WhatsApp initialization...');
      await delay(1000); // Brief pause before retry
      await client.initialize();
    } catch (retryErr: any) {
      log('❌ Retry also failed, entering standard reconnection loop');
      // Only then fall back to scheduleReconnect (which might still need auth reset)
      await scheduleReconnect();
    }
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
