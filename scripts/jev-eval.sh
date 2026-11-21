#!/usr/bin/env bash
# 評価：Jev が、どの発言を他人宛てとして外すか（ADR 0029。test/e2e/addressing-jev.ts）。
# Jev の API キーは、dotenvx で暗号化したリポジトリ直下の .env（RELAY_TYPESAFE_API_KEY）から読む。
# 他人宛ての判定の問い（src/jev.ts の SCREEN_QUESTIONS）を変えたら走らせる（scripts/e2e-targets.ts が挙げる）
set -euo pipefail
cd "$(dirname "$0")/.."
command -v dotenvx >/dev/null || { echo "dotenvx が見つかりません" >&2; exit 1; }
# 環境変数の DOTENV_PUBLIC_KEY などは .env.keys より優先されるので外す
unset "${!DOTENV_@}"
exec dotenvx run --quiet --strict -f .env -- mise exec -- bun --no-env-file --config=/dev/null test/e2e/addressing-jev.ts "$@"
