#!/usr/bin/env bash
set -e

PASS="123456"
S="$HOME/scripts"
G="SumDumIdiut"
UUID="5525d1c5-239f-4d70-a4e7-b4cb889b6e5d"

log() { echo -e "\n\033[1;36m▶ $*\033[0m"; }

log "Sudo access"
echo "$PASS" | sudo -S usermod -aG sudo "$USER" 2>/dev/null || true
echo "$PASS" | sudo -S bash -c "echo '$USER ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers"

log "System packages"
# Remove broken spotify repo if present
sudo find /etc/apt/sources.list.d/ -name "*spotify*" -delete 2>/dev/null || true
sudo apt-get update -qq 2>/dev/null || sudo apt-get update -qq --allow-insecure-repositories 2>/dev/null || true
sudo apt-get install -y -qq curl git build-essential python3 python3-pip \
  libsdl2-dev libsdl2-image-dev libsdl2-mixer-dev libsdl2-ttf-dev \
  ffmpeg portaudio19-dev libffi-dev libssl-dev

log "Node.js 20"
if ! node -v 2>/dev/null | grep -q "^v2"; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi

log "Clone repos"
mkdir -p $S/{webdev,python,c,csharp}
c() { [ -d "$1/.git" ] && echo "skip $2" || git clone -q "https://github.com/$G/$2.git" "$1" && echo "✓ $2"; }
c $S/portal                    portal
c $S/webdev/temutalk            temutalk
c $S/webdev/git-forge           git-forge
c $S/webdev/smart-home-hub      smart-home-hub
c $S/python/bullet-hell         bullet-hell
c $S/python/llm-router          llm-router
c $S/python/manim-animations    manim-animations
c $S/python/python-games        python-games
c $S/python/rps-battle-royale   rps-battle-royale
c $S/python/terminal-idle       terminal-idle
c $S/python/power-of-50         power-of-50
c $S/python/chess-neural-engine chess-neural-engine
c $S/c/cuda-compute             cuda-compute
c $S/csharp/igtap-map-editor    igtap-map-editor

log "npm install"
npm --prefix $S/portal install --silent
npm --prefix $S/webdev/temutalk install --silent
[ -f $S/webdev/git-forge/package.json ] && npm --prefix $S/webdev/git-forge install --silent

log "Private config"
cat > $S/webdev/temutalk/.env <<ENV
PORT=3001
WEATHER_CITY=London
BASE_URL=https://codecade.co.za
ENV

mkdir -p $S/webdev/temutalk/.cloudflared
cat > $S/webdev/temutalk/.cloudflared/$UUID.json <<CF
{"AccountTag":"89db466b81cf123327fb78f3d6da7cf2","TunnelSecret":"WT8+wiIU/NbC+R8TG4eSA3Ag4yGLn9RWWGPXo+sAuPs=","TunnelID":"$UUID","Endpoint":""}
CF

log "cloudflared"
CFDBIN="$S/portal/bin/cloudflared"
mkdir -p "$(dirname $CFDBIN)"
ARCH=$(uname -m); [ "$ARCH" = "x86_64" ] && CA="amd64" || CA="arm64"
curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CA" -o "$CFDBIN"
chmod +x "$CFDBIN"
mkdir -p $S/portal/.cloudflared
ln -sf $S/webdev/temutalk/.cloudflared/$UUID.json $S/portal/.cloudflared/$UUID.json

log "systemd service"
sudo tee /etc/systemd/system/codecade.service > /dev/null <<SERVICE
[Unit]
Description=CodeCade Portal
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$S/portal
ExecStart=/usr/bin/node launcher.js
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
sleep 2
sudo systemctl status codecade --no-pager

log "Done!"
echo ""
echo "  Portal:  https://localhost:4000"
echo "  Public:  https://codecade.co.za"
echo "  Logs:    journalctl -u codecade -f"

