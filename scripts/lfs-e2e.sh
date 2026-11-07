#!/usr/bin/env bash
# End-to-end Git LFS check against a running GitFlare (wrangler dev or production).
#
#   GITFLARE_URL=http://localhost:8787 GITFLARE_API_KEY=gf_... scripts/lfs-e2e.sh [size_mb]
#
# 1. creates a scratch repo, tracks *.bin, pushes a random file of size_mb (default 40)
# 2. clones it elsewhere and compares checksums
# 3. pushes an untracked 33 MB file and expects the "git lfs track" recipe
# 4. reads the LFS stats API and deletes the repo
set -euo pipefail

: "${GITFLARE_URL:?set GITFLARE_URL}"
: "${GITFLARE_API_KEY:?set GITFLARE_API_KEY}"
SIZE_MB="${1:-40}"
command -v git-lfs >/dev/null || { echo "git-lfs is required"; exit 1; }

REPO="lfs-e2e-$(date +%s)"
WORK="$(mktemp -d)"
ASKPASS="$WORK/askpass.sh"
printf '#!/bin/sh\necho "$GITFLARE_API_KEY"\n' > "$ASKPASS"; chmod +x "$ASKPASS"
export GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 GITFLARE_API_KEY
REMOTE="${GITFLARE_URL%/}/git/$REPO.git"
REMOTE_AUTH="$(echo "$REMOTE" | sed 's#://#://x-api-key@#')"
api() { curl -fsS -H "Authorization: Bearer $GITFLARE_API_KEY" -H 'Content-Type: application/json' "$@"; }

cleanup() {
  echo "--- cleanup"
  api -X DELETE "$GITFLARE_URL/api/repos/$REPO" >/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "--- create repo $REPO"
api -X POST "$GITFLARE_URL/api/repos" -d "{\"name\":\"$REPO\",\"is_private\":true}" >/dev/null

echo "--- push a ${SIZE_MB} MB LFS file"
mkdir -p "$WORK/a" && cd "$WORK/a"
git init -q -b main
git -c credential.helper= lfs install --local >/dev/null
git lfs track "*.bin" >/dev/null
head -c "$((SIZE_MB * 1024 * 1024))" /dev/urandom > big.bin
SUM_A="$(shasum -a 256 big.bin | cut -d' ' -f1)"
echo "hello" > README.md
git add .gitattributes README.md big.bin
git -c user.name=e2e -c user.email=e2e@example.com commit -q -m "LFS file"
git -c credential.helper= push -q "$REMOTE_AUTH" main 2>&1 | tail -3

echo "--- clone and compare"
cd "$WORK"
# Explicit LFS filter config so a machine-wide override (e.g. a disabled smudge) can't skew the test.
LFS_CFG=(-c 'filter.lfs.process=git-lfs filter-process' -c 'filter.lfs.smudge=git-lfs smudge -- %f' -c 'filter.lfs.clean=git-lfs clean -- %f' -c filter.lfs.required=true)
git -c credential.helper= "${LFS_CFG[@]}" clone -q "$REMOTE_AUTH" b 2>&1 | tail -3
SUM_B="$(shasum -a 256 b/big.bin | cut -d' ' -f1)"
[ "$SUM_A" = "$SUM_B" ] && echo "OK: checksum matches ($SUM_A)" || { echo "FAIL: checksum mismatch"; exit 1; }
grep -q 'oid sha256' b/big.bin && { echo "FAIL: clone has a pointer, not the file"; exit 1; } || true

echo "--- push an untracked 33 MB file (expect LFS recipe)"
# On a side branch: new repos protect their default branch (merge queue) after the first push.
cd "$WORK/a"
git checkout -q -b oversized
head -c $((33 * 1024 * 1024)) /dev/urandom > huge.dat
git add huge.dat
git -c user.name=e2e -c user.email=e2e@example.com commit -q -m "too big"
set +e
OUT="$(git -c credential.helper= push "$REMOTE_AUTH" oversized 2>&1)"
CODE=$?
set -e
echo "$OUT" | tail -12
if [ $CODE -eq 0 ]; then echo "FAIL: oversized push was accepted"; exit 1; fi
echo "$OUT" | grep -q 'git lfs track' && echo "OK: recipe shown" || { echo "FAIL: no recipe in output"; exit 1; }

echo "--- stats"
api "$GITFLARE_URL/api/repos/$REPO/lfs" | sed 's/,"/,\n  "/g' | head -12
echo "ALL OK"
