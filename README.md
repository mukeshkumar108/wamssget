# WhatsApp Get 📲

A background WhatsApp logger built with [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) + [Drizzle ORM](https://orm.drizzle.team).

It runs headlessly, captures messages, and saves them to SQLite (`out/messages.db`) and `raw.jsonl` for debugging.

---

## Features
- Connects via WhatsApp Web QR (stored locally, so you only scan once).
- Saves all messages, contacts, group participants, and reactions.
- Stores both **saved name** (your phone contact) and **display name** (their WhatsApp name).
- SQLite + Drizzle migrations for portable data.
- Automatic reconnection if the client disconnects.

---

## Setup

```bash
# clone
git clone https://github.com/<your-username>/whatsapp-get.git
cd whatsapp-get

# install deps
npm install

# setup Drizzle
npx drizzle-kit generate
npx drizzle-kit migrate

# run
npx ts-node index.ts
```

## Output

Messages are written to:
- Database → out/messages.db
- Debug log → out/raw.jsonl
Each message row includes:
- Sender ID
- Saved name
- Display name
- Group participant info
- Media metadata (mimetype, filename, size, duration)
- Reactions

## Notes

- Delete `.wwebjs_auth` + `.wwebjs_cache` if login breaks.
- Only one QR scan is needed unless you unlink manually from WhatsApp.
- `out/` is ignored in git — safe for local runs.