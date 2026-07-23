#!/usr/bin/env bash
# Deploy hermes-ha to local host (run on vps-dmit / vps-band as joel).
set -euo pipefail

SRC="${1:-}"
if [[ -z "$SRC" ]]; then
  echo "Usage: $0 /path/to/hermes-ha" >&2
  exit 2
fi
SRC="$(cd "$SRC" && pwd -P)"

SOURCE_COMMIT="${HERMES_HA_SOURCE_COMMIT:-}"
repo_root="$(git -C "$SRC" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -n "$repo_root" ]]; then
  source_rel="$(python3 - "$repo_root" "$SRC" <<'PY'
import os
import sys
print(os.path.relpath(sys.argv[2], sys.argv[1]))
PY
)"
  if [[ -n "$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all -- "$source_rel")" ]]; then
    echo "Refusing dirty Hermes HA source: $source_rel" >&2
    exit 3
  fi
  git_commit="$(git -C "$repo_root" rev-parse HEAD)"
  if [[ -n "$SOURCE_COMMIT" && "$SOURCE_COMMIT" != "$git_commit" ]]; then
    echo "HERMES_HA_SOURCE_COMMIT does not match the Git source" >&2
    exit 3
  fi
  SOURCE_COMMIT="$git_commit"
elif [[ ! "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Bare artifact installs require HERMES_HA_SOURCE_COMMIT" >&2
  exit 3
fi

SOURCE_SHA256="$(python3 - "$SRC" <<'PY'
from hashlib import sha256
from pathlib import Path
import sys

root = Path(sys.argv[1])
digest = sha256()
for path in sorted(item for item in root.rglob("*") if item.is_file()):
    rel = path.relative_to(root)
    if any(part in {".git", "__pycache__", ".pytest_cache", ".tmp"} for part in rel.parts):
        continue
    digest.update(str(rel).encode("utf-8"))
    digest.update(b"\0")
    digest.update(path.read_bytes())
    digest.update(b"\0")
print(digest.hexdigest())
PY
)"
if [[ -n "${HERMES_HA_SOURCE_SHA256:-}" && "$HERMES_HA_SOURCE_SHA256" != "$SOURCE_SHA256" ]]; then
  echo "HERMES_HA_SOURCE_SHA256 does not match the source tree" >&2
  exit 3
fi

DEST="${HERMES_HA_INSTALL:-$HOME/hermes-ha}"
NODE_ID="${HERMES_HA_NODE_ID:-}"
if [[ -z "$NODE_ID" ]]; then
  case "$(hostname -s 2>/dev/null || hostname)" in
    DMIT*|dmit*) NODE_ID=vps-dmit ;;
    famous-fan*|band*) NODE_ID=vps-band ;;
    *) NODE_ID="${HERMES_HA_NODE_ID:-vps-dmit}" ;;
  esac
fi

mkdir -p "$DEST" "$HOME/.config/hermes-ha" "$HOME/.local/bin"
rsync -a --delete \
  --exclude '.git/' \
  --exclude '__pycache__/' \
  --exclude 'tests/.tmp/' \
  "$SRC/" "$DEST/"

python3 - "$DEST/.install-source.json" "$SOURCE_COMMIT" "$SOURCE_SHA256" <<'PY'
from datetime import datetime, timezone
import json
import os
import sys

path, commit, tree_hash = sys.argv[1:]
payload = {
    "installed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "source_commit": commit,
    "source_tree_sha256": tree_hash,
    "source_subtree": "infra/hermes-ha",
}
temporary = f"{path}.{os.getpid()}.tmp"
with open(temporary, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2, sort_keys=True)
    handle.write("\n")
os.chmod(temporary, 0o644)
os.replace(temporary, path)
PY

chmod +x "$DEST/scripts/hermes-ha" "$DEST/scripts/"*.sh "$DEST/hooks/"*.sh 2>/dev/null || true
ln -sfn "$DEST/scripts/hermes-ha" "$HOME/.local/bin/hermes-ha"

CFG="$HOME/.config/hermes-ha/config.json"
python3 - "$DEST/config.example.json" "$CFG" "$NODE_ID" <<'PY'
import json
import os
import sys

src, dst, node = sys.argv[1], sys.argv[2], sys.argv[3]
example = json.loads(open(src, encoding="utf-8").read())
if os.path.isfile(dst):
    data = json.loads(open(dst, encoding="utf-8").read())
    # Refresh migrate policy keys from example; keep other local edits.
    for key in ("local_trees", "shared_dirs", "shared_files"):
        if key in example:
            data[key] = example[key]
    for key in ("local_only", "secrets", "stack_units", "probe", "gateway_checkpoint", "gateway_version_sync", "state_checkpoint", "dns", "hosts", "alert"):
        if key not in data and key in example:
            data[key] = example[key]
    # Add newly introduced nested defaults without replacing host-specific values.
    for key in ("probe", "gateway_checkpoint", "gateway_version_sync", "state_checkpoint", "dns"):
        if isinstance(example.get(key), dict):
            current = data.setdefault(key, {})
            if isinstance(current, dict):
                for nested_key, value in example[key].items():
                    current.setdefault(nested_key, value)
else:
    data = example
data["node_id"] = node
data["peer_id"] = "vps-band" if node == "vps-dmit" else "vps-dmit"
open(dst, "w", encoding="utf-8").write(json.dumps(data, indent=2) + "\n")
print(f"wrote {dst} node_id={node} peer_id={data['peer_id']}")
PY

# systemd user units
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
for f in "$DEST"/systemd/*.service "$DEST"/systemd/*.timer "$DEST"/systemd/*.slice; do
  [[ -e "$f" ]] || continue
  base="$(basename "$f")"
  sed "s|@HERMES_HA_ROOT@|$DEST|g" "$f" > "$UNIT_DIR/$base"
done
systemctl --user daemon-reload
if [[ "$NODE_ID" == "vps-dmit" ]]; then
  systemctl --user disable --now hermes-ha-evaluate.timer 2>/dev/null || true
  systemctl --user disable --now hermes-ha-gateway-version-sync.timer 2>/dev/null || true
else
  systemctl --user enable --now hermes-ha-evaluate.timer
  systemctl --user enable --now hermes-ha-gateway-version-sync.timer
fi
systemctl --user enable --now \
  hermes-ha-gateway-checkpoint.timer \
  hermes-ha-checkpoint-watchdog.timer \
  hermes-ha-state-checkpoint.timer

echo "Installed to $DEST"
echo "CLI: $HOME/.local/bin/hermes-ha"
echo "Next: hermes-ha migrate ensure-layout && hermes-ha secrets init-keys"
