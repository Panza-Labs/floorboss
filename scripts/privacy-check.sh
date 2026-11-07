#!/usr/bin/env bash
# Copyright 2026 Panza Labs
# SPDX-License-Identifier: Apache-2.0
# Fails if the repo's files contain local paths, secrets, private words, or email addresses outside reserved and
# noreply domains and Panza Labs's own hello@panzalabs.com. gmail.com addresses are allowed only with a local part ending in ".example" (the Gmail dot/plus
# rule tests). Your own words to keep out (names, projects) can go one per line in
# ~/.config/floorboss/privacy-words.
# --history also checks every commit before a release: the words and addresses in their changes, each commit's
# author and committer address, and that every commit is dated in UTC (+0000).
set -euo pipefail
cd "$(dirname "$0")/.."
status=0
self='scripts/privacy-check.sh'
files=()
if git rev-parse --git-dir >/dev/null 2>&1; then
  while IFS= read -r -d '' f; do [ "$f" != "$self" ] && [ -f "$f" ] && files+=("$f"); done < <(git ls-files -z --cached --others --exclude-standard)
else
  while IFS= read -r -d '' f; do f="${f#./}"; [ "$f" != "$self" ] && files+=("$f"); done < <(find . -type f -not -path './.git/*' -print0)
fi
[ ${#files[@]} -gt 0 ] || { echo "privacy-check: no files found"; exit 1; }

# Grep across every file, never reading stdin (an empty list would).
# Exit 1 (nothing found) is fine; exit 2 (grep failed) fails the check rather than reading as clean.
scan() { local rc=0; grep -I "$@" -- "${files[@]}" /dev/null || rc=$?; if [ $rc -gt 1 ]; then echo "privacy-check: grep failed ($*)" >&2; exit 2; fi; }

ALLOWED_EMAIL='@([a-z0-9-]+\.)*(example|test|invalid)$|@([a-z0-9-]+\.)*example\.(com|org|net)$|@users\.noreply\.github\.com$|^hello@panzalabs\.com$|^noreply@anthropic\.com$|^[a-z0-9._%-]*\.example(\+[a-z0-9._-]+)?@(gmail|googlemail)\.com$'
LOCAL_PATHS='/Users/[A-Za-z]|/home/[a-z]|/var/folders/[A-Za-z0-9_+-]{2}/|[Cc]:\\Users\\[A-Za-z]'
# Common key and token shapes (never real ones in this repo: test values use other shapes).
SECRETS='AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-(ant-|proj-)?[A-Za-z0-9_-]{32,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'

found=$(scan -nE "$LOCAL_PATHS")
if [ -n "$found" ]; then echo "privacy-check: local paths found"; echo "$found"; status=1; fi
found=$(scan -nE "$SECRETS")
if [ -n "$found" ]; then echo "privacy-check: something that looks like a key or token"; echo "$found" | cut -c1-160; status=1; fi
emails=$(scan -ohE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' | tr 'A-Z' 'a-z' | sort -u | grep -vE "$ALLOWED_EMAIL" || true)
if [ -n "$emails" ]; then echo "privacy-check: unexpected email addresses:"; echo "$emails"; status=1; fi
words="${HOME}/.config/floorboss/privacy-words"
if [ -f "$words" ]; then
  while IFS= read -r w; do
    [ -z "$w" ] && continue
    if [ -n "$(scan -liF -e "$w")" ]; then echo "privacy-check: private word found: $w"; status=1; fi
  done < "$words"
fi

if [ "${1:-}" = "--history" ]; then
  log=$(git log -p -m --all --format='%n')
  if grep -qE "$LOCAL_PATHS" <<<"$log"; then echo "privacy-check: a local path in an earlier commit"; status=1; fi
  if grep -qE "$SECRETS" <<<"$log"; then echo "privacy-check: a key or token in an earlier commit"; status=1; fi
  bad=$(grep -ohE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' <<<"$log" | tr 'A-Z' 'a-z' | sort -u | grep -vE "$ALLOWED_EMAIL" || true)
  if [ -n "$bad" ]; then echo "privacy-check: unexpected email addresses in earlier commits:"; echo "$bad"; status=1; fi
  if [ -f "$words" ]; then
    while IFS= read -r w; do [ -z "$w" ] && continue; if grep -qiF -- "$w" <<<"$log"; then echo "privacy-check: a private word in an earlier commit (${#w} letters)"; status=1; fi; done < "$words"
  fi
  people=$(git log --all --format='%ae%n%ce' | tr 'A-Z' 'a-z' | sort -u | grep -vE "$ALLOWED_EMAIL" || true)
  if [ -n "$people" ]; then echo "privacy-check: commit addresses that aren't noreply:"; echo "$people"; status=1; fi
  zones=$(git log --all --format='%h %ai | %ci' | grep -vE '\+0000 \| [^|]*\+0000$' || true)
  if [ -n "$zones" ]; then echo "privacy-check: commits not dated in UTC (they show the local time zone):"; echo "$zones"; status=1; fi
fi

[ $status -eq 0 ] && echo "privacy-check: clean"
exit $status
