#!/bin/bash
# Setup SurrealDB LaunchAgent for auto-start on macOS
#
# This creates a LaunchAgent plist so SurrealDB starts automatically
# on login and restarts if it crashes — just like OpenClaw's gateway.
#
# Usage: bash scripts/setup-surrealdb-launchagent.sh

PLIST_PATH="$HOME/Library/LaunchAgents/ai.qmemory.surrealdb.plist"
SURREAL_BIN=$(which surreal)
DATA_DIR="$HOME/.qmemory"
LOG_DIR="$HOME/.qmemory/logs"

# Create data and log directories
mkdir -p "$DATA_DIR" "$LOG_DIR"

if [ -z "$SURREAL_BIN" ]; then
  echo "Error: surreal not found in PATH"
  echo "Install: brew install surrealdb/tap/surreal"
  exit 1
fi

echo "Creating LaunchAgent at: $PLIST_PATH"

cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.qmemory.surrealdb</string>

    <key>ProgramArguments</key>
    <array>
        <string>${SURREAL_BIN}</string>
        <string>start</string>
        <string>--username</string>
        <string>root</string>
        <string>--password</string>
        <string>root</string>
        <string>--bind</string>
        <string>127.0.0.1:8000</string>
        <string>file:${DATA_DIR}/data.db</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/surrealdb.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/surrealdb.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF

# Load the LaunchAgent
launchctl bootout gui/$(id -u)/ai.qmemory.surrealdb 2>/dev/null
launchctl bootstrap gui/$(id -u) "$PLIST_PATH"

echo ""
echo "SurrealDB LaunchAgent installed!"
echo "  Data:  $DATA_DIR/data.db"
echo "  Logs:  $LOG_DIR/surrealdb.log"
echo "  URL:   ws://127.0.0.1:8000"
echo ""
echo "Commands:"
echo "  Status:  launchctl list | grep qmemory"
echo "  Stop:    launchctl bootout gui/\$(id -u)/ai.qmemory.surrealdb"
echo "  Restart: launchctl kickstart -k gui/\$(id -u)/ai.qmemory.surrealdb"
echo "  Logs:    tail -f $LOG_DIR/surrealdb.log"
