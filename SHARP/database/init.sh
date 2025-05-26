#!/bin/bash

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)

if [ -z "$SCRIPT_DIR" ]; then
    echo "Error: Failed to resolve SCRIPT_DIR. Ensure the script is executed from a valid directory." >&2
    exit 1
fi
SHARP_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$SHARP_DIR")"

echo "What is your domain name? (e.g., twoblade.com)"
read DOMAIN

POSTGRES_PASSWORD="$(openssl rand -hex 32)"
POSTGRES_USER="postgres"

# Create SHARP .env file
cat > "$SHARP_DIR/.env" << EOF
DOMAIN_NAME=${DOMAIN}
DATABASE_URL=postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/postgres
SHARP_PORT=5000
HTTP_PORT=5001

# Optional but required for Turnstile spam prevention in production
# These are the test keys that will accept any token
PRIVATE_TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA

# Used for authentication, must match ../website/.env
JWT_SECRET=REPLACE_ME_WITH_RANDOM_STRING
EOF

# Generate Docker Compose .env file from SHARP .env
echo "# Docker Compose .env file" > "../.env"
echo "# This file is used to configure the Docker Compose services." >> "../.env"
grep -E "POSTGRES_USER|POSTGRES_PASSWORD" ".env" >> "../.env"

echo "Created .env"
echo "NOTE: Replace JWT_SECRET with a secure value (use 'openssl rand -hex 64'). IT MUST MATCH ../website/.env"
echo "NOTE: In production, replace Turnstile key with your actual key from Cloudflare"

MODERATION_DIR="$ROOT_DIR/website/websocket/src"
mkdir -p "$MODERATION_DIR"
cat >"$MODERATION_DIR/moderation.ts" <<EOF
// Moderation service for websocket connections
// Created by init.sh

export function checkHardcore(msg: string): boolean {
    // Placeholder implementation - should be replaced with actual detection
    return false;
}
EOF

echo "Created moderation.ts in $MODERATION_DIR"
echo ""
echo "To setup your server:"
echo "1. Start the database:"
echo "   cd -"
echo "   docker compose up -d"
echo ""
echo "2. Start the SHARP server:"
echo "   bun main.js"
