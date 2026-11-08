#!/bin/bash
# Optional OpenClaw watchdog for Proof of Interaction.
# Use this when OpenClaw lifecycle hooks are unavailable or not yet wired. It
# checks whether the most recently marked turn has sealed a ring.

set -euo pipefail

SKILL="${CT_SKILL_DIR:-$HOME/.openclaw/workspace/skills/proof-of-interaction}"

if [ ! -f "$SKILL/enforce.py" ]; then
  echo "Proof of Interaction skill not found at: $SKILL" >&2
  echo "Set CT_SKILL_DIR=/path/to/proof-of-interaction and try again." >&2
  exit 2
fi

out="$(python3 "$SKILL/enforce.py" stop-check 2>&1 || true)"
if [ -n "$out" ]; then
  printf '%s\n' "$out"
else
  echo "Proof of Interaction watchdog: no pending marked OpenClaw turn is currently unsealed."
fi
