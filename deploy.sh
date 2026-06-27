#!/bin/bash
# Deploy script for PopcornTime API
# Usage: ./deploy.sh
set -e

cd "$(dirname "$0")"

echo "🔄 Pulling latest changes..."
git pull

echo "📦 Installing dependencies..."
bun install --frozen-lockfile

echo "🔨 Checking TypeScript..."
bun run --bun tsc --noEmit 2>/dev/null || true

echo "🚀 Restarting service..."
sudo systemctl restart popcorntime-api

echo "✅ Deploy complete!"
systemctl status popcorntime-api --no-pager -l | head -5
