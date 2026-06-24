#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# SECRETS — fill these in before running
# ─────────────────────────────────────────────────────────────────────────────
SPOTIFY_CLIENT_ID=""
SPOTIFY_CLIENT_SECRET=""
SPOTIFY_REDIRECT_URI="http://localhost:3000/callback"
SESSION_SECRET=""
WEATHER_CITY="London"

# Cloudflare tunnel credential JSON (contents of .cloudflared/<uuid>.json)
CLOUDFLARED_UUID="5525d1c5-239f-4d70-a4e7-b4cb889b6e5d"
CLOUDFLARED_JSON='{}'   # paste full JSON here

# Git Forge secrets
FORGE_SECRET=""
FORGE_TOKEN=""

# ─────────────────────────────────────────────────────────────────────────────

GITHUB_USER="SumDumIdiut"
SCRIPTS="$HOME/scripts"

log() { echo -e "\n\033[1;36m▶ $*\033[0m"; }

# ── 1. System packages ────────────────────────────────────────────────────────
log "Installing system packages"
sudo apt-get update -qq
sudo apt-get install -y -qq curl git build-essential python3 python3-pip python3-venv \
  python3-dev libsdl2-dev libsdl2-image-dev libsdl2-mixer-dev libsdl2-ttf-dev \
  ffmpeg portaudio19-dev libffi-dev libssl-dev

# ── 2. Node.js 20 ─────────────────────────────────────────────────────────────
log "Installing Node.js 20"
if ! node -v 2>/dev/null | grep -q "^v2"; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - -q
  sudo apt-get install -y -qq nodejs
fi
node -v && npm -v

# ── 3. Clone repos ────────────────────────────────────────────────────────────
log "Cloning repos"
mkdir -p "$SCRIPTS"/{webdev,python,c,csharp}

clone() {
  local dest="$1" repo="$2"
  [ -d "$dest/.git" ] && echo "  skip $repo (exists)" || git clone -q "https://github.com/$GITHUB_USER/$repo.git" "$dest"
}

clone "$SCRIPTS/portal"                      portal
clone "$SCRIPTS/webdev/temutalk"             temutalk
clone "$SCRIPTS/webdev/git-forge"            git-forge
clone "$SCRIPTS/webdev/smart-home-hub"       smart-home-hub
clone "$SCRIPTS/python/discord-ollama-bot"   discord-ollama-bot
clone "$SCRIPTS/python/bullet-hell"          bullet-hell
clone "$SCRIPTS/python/llm-router"           llm-router
clone "$SCRIPTS/python/manim-animations"     manim-animations
clone "$SCRIPTS/python/python-games"         python-games
clone "$SCRIPTS/python/rps-battle-royale"    rps-battle-royale
clone "$SCRIPTS/python/terminal-idle"        terminal-idle
clone "$SCRIPTS/python/power-of-50"          power-of-50
clone "$SCRIPTS/python/chess-neural-engine"  chess-neural-engine
clone "$SCRIPTS/c/cuda-compute"              cuda-compute
clone "$SCRIPTS/csharp/igtap-map-editor"     igtap-map-editor

# ── 4. npm install ────────────────────────────────────────────────────────────
log "Installing npm dependencies"
npm --prefix "$SCRIPTS/portal" install --silent
[ -f "$SCRIPTS/webdev/temutalk/package.json" ]   && npm --prefix "$SCRIPTS/webdev/temutalk"   install --silent
[ -f "$SCRIPTS/webdev/git-forge/package.json" ]  && npm --prefix "$SCRIPTS/webdev/git-forge"  install --silent

# ── 5. Python deps ────────────────────────────────────────────────────────────
log "Installing Python dependencies"
pip3 install -q pygame requests websockets aiohttp discord.py ollama manim

# ── 6. Private files ──────────────────────────────────────────────────────────
log "Writing private config files"

# TemuTalk .env
cat > "$SCRIPTS/webdev/temutalk/.env" <<ENV
SPOTIFY_CLIENT_ID=$SPOTIFY_CLIENT_ID
SPOTIFY_CLIENT_SECRET=$SPOTIFY_CLIENT_SECRET
REDIRECT_URI=$SPOTIFY_REDIRECT_URI
PORT=3000
SESSION_SECRET=$SESSION_SECRET
WEATHER_CITY=$WEATHER_CITY
ENV

# Cloudflare tunnel credentials
mkdir -p "$SCRIPTS/webdev/temutalk/.cloudflared"
echo "$CLOUDFLARED_JSON" > "$SCRIPTS/webdev/temutalk/.cloudflared/${CLOUDFLARED_UUID}.json"

# Git Forge secrets
[ -n "$FORGE_SECRET" ] && echo "$FORGE_SECRET" > "$SCRIPTS/webdev/git-forge/.forge-secret"
[ -n "$FORGE_TOKEN"  ] && echo "$FORGE_TOKEN"  > "$SCRIPTS/webdev/git-forge/.forge-token"

# ── 7. Cloudflare tunnel binary ───────────────────────────────────────────────
log "Installing cloudflared"
CFDBIN="$SCRIPTS/portal/bin/cloudflared"
if [ ! -x "$CFDBIN" ]; then
  mkdir -p "$(dirname "$CFDBIN")"
  ARCH=$(uname -m)
  [ "$ARCH" = "x86_64" ] && CFDARCH="amd64" || CFDARCH="arm64"
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CFDARCH" -o "$CFDBIN"
  chmod +x "$CFDBIN"
fi
"$CFDBIN" --version

# ── 8. Symlink cloudflared creds into portal ──────────────────────────────────
log "Linking tunnel credentials"
mkdir -p "$SCRIPTS/portal/.cloudflared"
[ -f "$SCRIPTS/portal/.cloudflared/${CLOUDFLARED_UUID}.json" ] || \
  ln -s "$SCRIPTS/webdev/temutalk/.cloudflared/${CLOUDFLARED_UUID}.json" \
        "$SCRIPTS/portal/.cloudflared/${CLOUDFLARED_UUID}.json"

# ── 9. systemd service ────────────────────────────────────────────────────────
log "Installing portal systemd service"
sudo tee /etc/systemd/system/codecade.service > /dev/null <<SERVICE
[Unit]
Description=CodeCade Portal
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$SCRIPTS/portal
ExecStart=$(which node) launcher.js
Restart=always
RestartSec=5
User=$USER
Environment=HOME=$HOME
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable codecade
sudo systemctl restart codecade

# ── 10. Done ─────────────────────────────────────────────────────────────────
log "All done!"
echo ""
echo "  Portal:  https://localhost:4000"
echo "  Public:  https://codecade.co.za"
echo ""
echo "  Logs:    journalctl -u codecade -f"
echo "  Status:  systemctl status codecade"
