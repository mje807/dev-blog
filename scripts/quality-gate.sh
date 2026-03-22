#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[1/4] TypeScript check"
npx tsc --noEmit

echo "[2/4] Unit tests"
npm run -s test

echo "[3/4] ESLint check"
npm run -s lint

echo "[4/4] Production build"
npm run -s build

echo "✅ Quality gate passed"
