#!/bin/sh
set -e

AUTH_DIR=${AUTH_DIR:-/app/.wwebjs_auth}

echo "🧹 Cleaning Chromium/WhatsApp lock files in $AUTH_DIR ..."
# Common Chromium locks
rm -f "$AUTH_DIR"/SingletonLock "$AUTH_DIR"/SingletonCookie "$AUTH_DIR"/SingletonSocket 2>/dev/null || true
# Other lock names we’ve seen
rm -f "$AUTH_DIR"/*.lock "$AUTH_DIR"/lockfile 2>/dev/null || true

# Make sure the dir exists & is writable
mkdir -p "$AUTH_DIR"
chmod -R u+rwX "$AUTH_DIR" || true

# Run your app under dumb-init (PID 1)
exec /usr/bin/dumb-init -- "$@"
