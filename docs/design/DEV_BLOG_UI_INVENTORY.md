# DEV_BLOG_UI_INVENTORY.md

## Stage D1 — UI Inventory

### 1) Route Surface
- `app/page.tsx`
- `app/dev/page.tsx`
- `app/invest/page.tsx`
- `app/blog/page.tsx`
- `app/blog/[category]/page.tsx`
- `app/blog/[category]/[slug]/page.tsx`

### 2) Shared UI Components
- `components/SiteHeader.tsx` — 전역 헤더/브랜드 전환
- `components/BlogPostBrowser.tsx` — 목록/필터/정렬/검색 UI
- `components/PostCard.tsx` — 카드 뷰 셀
- `components/BlogContent.tsx` — 포스트 본문 렌더
- `components/ThemeController.tsx` — 테마 상태/전환 제어

### 3) Current Design Patterns (observed)
- 다크/라이트 테마가 경로(`dev`/`invest`)에 따라 분기됨
- 카드/리스트/헤더 컴포넌트는 존재하지만 토큰화된 공통 규약 문서 연결은 아직 없음
- 페이지별 Tailwind 클래스 하드코딩 비중이 높음
- 모션은 전역 preset 체계로 연결되어 있지 않음

### 4) Hardcoded Style Risk Points
- `app/*` 라우트 파일에서 layout/color/spacing 클래스 직접 선언 빈도 높음
- `components/PostCard.tsx`/`BlogPostBrowser.tsx`에서 상태(hover/active) 스타일 개별 선언
- Typography scale이 페이지 단위로 분산되어 추후 일관성 리스크 있음

### 5) Migration Priority (for Stage D2+)
1. `components/SiteHeader.tsx` (브랜드/테마 진입점)
2. `components/BlogPostBrowser.tsx` (정보밀도 높은 목록 핵심)
3. `components/PostCard.tsx` (카드 규격 통일)
4. `app/blog/[category]/[slug]/page.tsx` + `components/BlogContent.tsx` (본문 가독성)

### 6) Definition of Stage D1 Done
- 라우트/공통 컴포넌트 인벤토리 문서화 완료
- 우선순위 페이지 및 컴포넌트 선정 완료
- 다음 단계(D2 token mapping) 입력 자료 준비 완료
