# DEV_THEME_TOKEN_MAP.md

## Stage D2 — Theme Token Mapping

## 목적
Dev Blog에 디자인 시스템을 도입하기 위해, 기존 스타일 클래스를
Core/Semantic/Theme alias 토큰으로 매핑한다.

---

## 1) Token Layers

### Core (공통)
- `core.color.gray.*`
- `core.space.*` (4px 스케일)
- `core.radius.*`
- `core.font.size.*`, `core.font.weight.*`

### Semantic (역할 기반)
- `text.primary`, `text.secondary`, `text.muted`
- `bg.canvas`, `bg.surface`, `bg.elevated`
- `border.default`, `border.subtle`, `border.accent`
- `state.success`, `state.warning`, `state.danger`, `state.info`

### Theme Alias (dev)
- `dev.bg.canvas` → `bg-zinc-950`
- `dev.bg.surface` → `bg-zinc-900`
- `dev.text.primary` → `text-zinc-100`
- `dev.text.secondary` → `text-zinc-300`
- `dev.text.muted` → `text-zinc-500`
- `dev.border.default` → `border-zinc-800`
- `dev.brand.primary` → `text-cyan-300` / `bg-cyan-600`

---

## 2) Existing Class → Token Mapping (우선 구간)

### Header / Navigation
- `text-gray-400` → `dev.text.secondary`
- `text-white` → `dev.text.primary`
- `bg-gray-900` → `dev.bg.surface`
- `border-gray-800` → `dev.border.default`

### Card / Container
- `rounded-xl p-4 border` → `radius.lg + space.4 + border.default`
- `bg-gray-900` → `dev.bg.surface`
- `bg-gray-800` → `dev.bg.elevated`

### Data/Meta text
- `text-xs text-gray-500` → `font.size.xs + dev.text.muted`
- `text-sm text-gray-300` → `font.size.sm + dev.text.secondary`

### Action / Link
- `text-cyan-300 hover:text-cyan-200` → `dev.brand.link`
- `bg-indigo-600 hover:bg-indigo-500` → `dev.brand.cta`

---

## 3) Component Token Contract (v0.1)

### SiteHeader
- 배경: `dev.bg.canvas`
- 경계: `dev.border.default`
- 브랜드 텍스트: `dev.brand.primary`

### PostCard
- 카드 배경: `dev.bg.surface`
- 본문: `dev.text.secondary`
- 메타: `dev.text.muted`

### BlogPostBrowser
- 필터/정렬 컨트롤 배경: `dev.bg.elevated`
- 인터랙션 상태: `state.info` 기반

### BlogContent
- 본문 폭/타이포: `typography.article.*`
- 코드블록: `dev.code.*` alias

---

## 4) Migration Rules
1. 새 코드에서 gray/indigo/cyan 직접 하드코딩 금지 (token alias 우선)
2. 라우트 파일에서 직접 스타일 선언 최소화, 공통 컴포넌트 우선
3. component-level style 변경 시 token map 문서 업데이트

---

## 5) Stage D2 Done Criteria
- [x] Dev theme alias 정의
- [x] 주요 클래스→토큰 매핑 정리
- [x] v0.1 공통 컴포넌트별 토큰 계약 정의
- [x] D3 구현 입력자료 준비 완료
