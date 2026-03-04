# DEV Blog Stage D8 — Quality Gate Automation

## 목적
Stage D7에서 수동으로 수행하던 검증(타입/린트/빌드)을 Stage D8에서 단일 커맨드로 자동화.

## 추가 사항
- `scripts/quality-gate.sh`
  - `npx tsc --noEmit`
  - `npm run -s lint`
  - `npm run -s build`
- `package.json` scripts
  - `typecheck`: `tsc --noEmit`
  - `quality:gate`: `bash ./scripts/quality-gate.sh`

## 사용법
```bash
npm run -s quality:gate
```

## 기대 효과
- 배포 전 필수 검증을 일관된 순서로 실행
- Stage 종료 보고 시 검증 증빙 표준화
