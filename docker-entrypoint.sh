#!/bin/sh
set -e

AUTH_DIR=${AUTH_DIR:-/app/.wwebjs_auth}

echo "🧹 Cleaning Chromium/WhatsApp lock files in $AUTH_DIR ..."

# Remove known Chromium lock files that cause profile errors
rm -f "$AUTH_DIR"/SingletonLock \
      "$AUTH_DIR"/SingletonCookie \
      "$AUTH_DIR"/SingletonSocket \
      "$AUTH_DIR"/Singleton* \
      "$AUTH_DIR"/LOCK \
      "$AUTH_DIR"/.lockfile 2>/dev/null || true

# Make sure the dir exists & is writable
mkdir -p "$AUTH_DIR"
chmod -R u+rwX "$AUTH_DIR" || true

# Fix permissions just in case
chown -R whatsapp:whatsapp "$AUTH_DIR"

# Run your app under dumb-init (PID 1)
exec /usr/bin/dumb-init -- "$@"


