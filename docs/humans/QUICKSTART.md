# 🚀 WhatsApp Get Quick Start Guide

Welcome! This guide will get your WhatsApp message archive running in just a few minutes. No complex setup required.

## 📋 Prerequisites

- Docker & Docker Compose (latest versions)
- WhatsApp Business or Personal account
- Mobile device with WhatsApp installed

---

## ⚡ 3-Step Setup (5 Minutes)

### 1. **Get the Code**
```bash
git clone https://github.com/mukeshkumar108/wamssget.git
cd wamssget
```

### 2. **Configure Security**
```bash
# Copy the example config
cp .env.example .env

# Edit .env and set your API key
nano .env
# Change API_KEY=your-secret-api-key-here-REPLACE-THIS
```

**Your .env should look like:**
```bash
API_KEY=my-super-secret-key-12345
# Keep other defaults for now
```

### 3. **Launch the Service**
```bash
docker-compose up --build
```

🎉 **That's it!** Docker handles everything automatically.

---

## 🔐 WhatsApp Authentication

1. **Wait for QR Code**: Docker logs will show when the service starts
2. **Open WhatsApp** on your phone
3. **Go to**: Settings → Linked Devices → Link a Device
4. **Scan the QR Code** displayed in terminal logs
5. **Done!** Messages will start saving automatically

---

## ✅ Verify It's Working

### **Check Service Health**
```bash
curl http://localhost:3000/health
# Should return: {"healthy":true,"state":"connected","lastMessageAt":...}
```

### **Test API Access**
```bash
# Get recent chats (requires auth)
curl -H "Authorization: Bearer my-super-secret-key-12345" \
  http://localhost:3000/api/messages/recent-chats

# Should return your WhatsApp chats with recent messages
```

### **Check Files Are Creating**
```bash
ls -la ./out/
# Should show:
# service.log     (app logs)
# raw.jsonl       (message backups)
# status.json     (state)
```

---

## 🎯 What Happens Next

**🔄 Messages Flow Automatically:**
- Every new message → Saved to SQLite database
- Every message → Backed up to raw JSONL logs
- Service runs continuously, survives restarts
- Messages are never lost

**📊 Your Data Structure:**
```
data/
├── app.sqlite          # Main database (messages, chats, contacts)

out/
├── service.log         # Application logs
├── raw.jsonl           # Complete message backups
├── calls.jsonl         # Call event backups
└── status.json         # Service status
```

---

## 🔧 Common Setup Issues

### **"Permission denied" errors**
```bash
# Ensure Docker has permission to write to current directory
ls -la .  # Should show writable by your user
```

### **QR Code Not Showing**
- Wait 30-60 seconds after container starts
- Check logs: `docker-compose logs whatsapp-get`
- Try restarting: `docker-compose restart`

### **API Returns 401 Unauthorized**
- Check your API key in .env matches curl request
- Ensure no extra spaces in .env
- Restart container after .env changes

---

## 🎉 Next Steps

**Your WhatsApp message archive is now running!**

- **Monitor logs**: `docker-compose logs -f whatsapp-get`
- **View messages**: Use the API endpoints documented in README.md
- **Read full docs**: Check the main README.md for API details
- **Stop service**: `docker-compose down` (data persists)

---

**Happy archiving! 📱✨**

**Need help?** Check the troubleshooting section in the main README or open a GitHub issue.
