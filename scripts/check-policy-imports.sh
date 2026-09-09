#!/usr/bin/env bash
# Route-policy CI guard (docs/07 §2, CLAUDE.md hard rule 1): every route file
# must import from ../policy, or it fails the build. `health.ts` is the one
# deliberate exception — it's an unauthenticated liveness check with no
# authorization decision to make, not a route CLAUDE.md's rule 1 is guarding.
set -euo pipefail
cd "$(dirname "$0")/.."

ALLOWLIST=("src/server/routes/health.ts")

missing=0
for route in src/server/routes/*.ts; do
  [[ "$route" == *.test.ts ]] && continue
  skip=0
  for allowed in "${ALLOWLIST[@]}"; do
    [[ "$route" == "$allowed" ]] && skip=1
  done
  [[ "$skip" -eq 1 ]] && continue

  if ! grep -q "from '\.\./policy'" "$route"; then
    echo "missing policy import: $route" >&2
    missing=1
  fi
done

exit "$missing"
