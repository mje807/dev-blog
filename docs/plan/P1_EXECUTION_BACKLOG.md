# P1 Execution Backlog

`BLOG_REPO_IMPROVEMENT_PLAN.md`를 실제 작업순서 기준으로 더 잘게 분해한 체크리스트/이슈 템플릿.

## 실행 원칙
- 이번 라운드는 **dev 중심 MVP 정렬**에 집중한다.
- `/blog`는 **Dev Archive**로 정의한다.
- `invest`는 **teaser surface**로 유지한다.
- P1에서는 **사용자가 바로 체감하는 구조/브랜딩/empty-state**를 먼저 맞춘다.
- content architecture 분리는 P1 후반 착수 대상으로 설계만 남기고, 구현은 얇게 진입한다.

---

## 실제 작업순서 체크리스트

### Phase 1. IA / Brand copy fix
- [ ] P1-01 `/blog`를 Dev Archive로 재정의
- [ ] 헤더 nav label을 `All Posts` → `Dev Archive`로 변경
- [ ] `/blog` 페이지 헤더/카피를 archive 관점으로 재작성
- [ ] `/invest` 페이지 CTA 문구를 teaser 맥락으로 정리
- [ ] footer / global metadata에서 브랜드 hierarchy 정리

### Phase 2. Empty-state UX
- [ ] P1-02 `/dev` recent posts zero-state 구현
- [ ] `/dev` 카테고리 섹션의 빈 상태 메시지 정리
- [ ] P1-03 `/blog` archive zero-state 구현
- [ ] `/blog/[category]` zero-state를 archive 맥락으로 정리
- [ ] 공통 EmptyState 컴포넌트 도입

### Phase 3. Metadata consistency
- [ ] P1-04 global metadata를 dev 중심으로 재정렬
- [ ] `/dev`, `/blog`, `/blog/[category]`, `/invest` title/description 포맷 통일
- [ ] `console.log(dev)`와 `종구리.dev`의 역할을 title/description/footer에 일관되게 반영

### Phase 4. P1 후속 준비
- [ ] P1-05 category source 분리 (`lib/content/categories.ts`)
- [ ] P1-06 content domain 계층 1차 분리 설계 (`schema.ts`, `repository.ts`, `transform.ts`)
- [ ] P1-07 sanitize 전략 결정 및 allowlist 초안 작성

---

## Issue Templates

## P1-01. `/blog`를 Dev Archive로 재정의
**목표**
- `/dev`와 `/blog`의 관계를 “메인 / 아카이브” 구조로 명확히 만든다.

**배경**
- 현재 `/blog`는 `All Posts`로 노출되어 dev 중심 MVP 구조가 흐려진다.

**범위**
- header nav label
- `/blog` page header/subtitle
- `/invest`에서 `/blog`를 참조하는 CTA copy
- footer / 브랜드 보조 문구

**체크리스트**
- [ ] nav label 교체
- [ ] `/blog` title/subtitle 교체
- [ ] archive 설명 copy 추가
- [ ] 관련 CTA 문구 정리

**완료 기준**
- 사용자가 `/blog`를 “전체 포스트”가 아니라 “개발 아카이브”로 이해한다.

---

## P1-02. `/dev` recent posts zero-state 구현
**목표**
- 포스트가 0개여도 `/dev`가 비어 보이지 않도록 만든다.

**배경**
- 현재 recent posts 섹션은 콘텐츠가 없으면 완성도가 떨어져 보일 가능성이 높다.

**범위**
- recent posts empty UI
- 안내 카피
- archive/teaser CTA

**체크리스트**
- [ ] `recent.length === 0` 분기 추가
- [ ] empty-state copy 추가
- [ ] `/blog` 또는 `/invest` CTA 추가
- [ ] 레이아웃 안정성 확인

**완료 기준**
- 최근 글이 없어도 `/dev`가 준비된 landing처럼 보인다.

---

## P1-03. `/blog` archive zero-state 구현
**목표**
- `/blog`가 비어 있어도 “버그”가 아니라 “준비된 archive”처럼 보이게 만든다.

**범위**
- blog page empty state
- category page empty state
- empty-state 공통 컴포넌트

**체크리스트**
- [ ] `/blog` empty-state 추가
- [ ] `/blog/[category]` empty-state 개선
- [ ] archive intro copy 추가
- [ ] 공통 EmptyState 컴포넌트 도입

**완료 기준**
- post 0개 / category 0개 상태가 정상 UX로 동작한다.

---

## P1-04. 브랜드/메타데이터 정렬
**목표**
- `console.log(dev)`와 `종구리.dev`의 역할을 분리하고, 메타데이터를 dev 중심 MVP에 맞춘다.

**범위**
- `app/layout.tsx`
- `/dev`, `/blog`, `/blog/[category]`, `/invest` metadata
- footer 문구

**체크리스트**
- [ ] global title/description 교체
- [ ] route metadata 통일
- [ ] footer copy 정리
- [ ] teaser/archive/dev 맥락이 메타에 반영되는지 확인

**완료 기준**
- title/description/footer만 봐도 현재 제품 구조를 이해할 수 있다.
