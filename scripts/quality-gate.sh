#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[1/3] TypeScript check"
npx tsc --noEmit

echo "[2/3] ESLint check"
npm run -s lint

echo "[3/3] Production build"
npm run -s build

echo "✅ Quality gate passed"
