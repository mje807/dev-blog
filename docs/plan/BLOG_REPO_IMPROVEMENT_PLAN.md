# BLOG_REPO_IMPROVEMENT_PLAN

우리 블로그 레포(`repos/dev-blog`)의 PM, 디자이너, 프론트엔드 관점 분석을 바탕으로 정리한 구조 개선 실행 문서.

## 문서 목적
- 실제 콘텐츠 투입 전에 제품 구조를 안정화한다.
- PM / 디자인 / 프론트엔드 개선 포인트를 하나의 실행 계획으로 통합한다.
- 다른 쓰레드에서도 바로 이어서 작업할 수 있는 기준 문서로 사용한다.

---

## 1. 현재 상태 요약

### 한 줄 요약
이 레포는 **감각 있는 UI 셸과 정적 블로그 기반은 갖췄지만, 콘텐츠/IA/운영 구조가 비어 있어 제품으로서는 아직 미완성**이다.

### 공통 진단
- 현재 `content/*`는 비어 있고, git status 기준 기존 마크다운 포스트들이 삭제 상태로 보인다.
- 즉, 지금 핵심 문제는 UI 자체보다 **콘텐츠 부재와 이를 견디는 구조 부재**다.
- `console.log(dev) / console.log(invest)` 포지셔닝은 있으나 실제 구현은 `dev` 쪽이 중심이다.
- `/blog`는 현재 사실상 dev archive처럼 동작하지만, 내비게이션/브랜딩/IA상 위치가 완전히 정리돼 있지 않다.
- 프론트엔드 구조는 작은 정적 블로그로는 충분하지만, 콘텐츠 증가를 감당하기엔 아직 정리가 덜 됐다.

---

## 2. 이번 라운드의 전제

### 전제
- 콘텐츠는 이후 사람이 직접 넣는다.
- 이번 라운드의 목표는 **콘텐츠가 들어와도 흔들리지 않는 구조를 만드는 것**이다.

### 하지 않을 것
- 실제 글 작성/업로드
- invest 영역 본격 확장
- 과도한 시각 polish
- CMS/대규모 플랫폼 전환

---

## 3. 전략

### 전략 1. `dev` 중심 MVP로 정렬
- 현재 실질 제품은 `console.log(dev)`이다.
- 이번 단계에서는 `/blog`를 **dev archive**로 간주하는 방향이 가장 현실적이다.
- `invest`는 teaser / coming soon 성격으로 유지한다.

### 전략 2. empty product를 정상적으로 보이게 만든다
- 콘텐츠가 없어도 버그처럼 보이면 안 된다.
- zero-state를 정식 UX로 설계한다.

### 전략 3. 콘텐츠 계층은 지금 정리한다
- 콘텐츠가 비어 있는 지금이 구조 정리 적기다.
- 나중에 글이 쌓인 뒤 바꾸면 비용이 더 커진다.

---

## 4. 관점별 핵심 개선 포인트

### PM 관점
- 범위가 넓고 실질 구현은 한쪽만 살아 있음
- 콘텐츠 운영 규칙 / launch 기준 / README 수준 문서 부재
- 초기 카테고리 폭이 넓어 MVP 집중도가 떨어짐
- 가장 중요한 일은 기능 추가보다:
  1. 범위 축소
  2. 운영 기준 수립
  3. 콘텐츠 투입 준비 완료 상태 정의

### 디자이너 관점
- 브랜드 컨셉은 좋지만 정보구조와 현재 UX가 그 약속을 충분히 받쳐주지 못함
- `/blog`의 IA 위치가 모호함
- `console.log(*)`와 `종구리.dev` 브랜딩이 섞여 있음
- 헤더 active state, 모바일 내비, zero-state, 접근성 affordance 부족
- 디자인 시스템 문서는 있으나 실제 구현은 아직 부분적 정렬 상태

### 프론트엔드 관점
- App Router + SSG 구조는 단순하고 안정적
- `lib/posts.ts`에 책임 과밀
- `CATEGORIES`, read time 계산 등 중복 존재
- `remarkHtml({ sanitize: false })` + `dangerouslySetInnerHTML` 조합은 보안 리스크
- metadata/page 중복 로딩, 테스트 부재, 콘텐츠 계층 분리 필요

---

## 5. 실행 Workstreams

## A. PM / Product Alignment

### A1. 제품 범위 명시
**해야 할 일**
- 이번 MVP 범위를 `console.log(dev)` 중심으로 명시
- `/blog`를 dev archive로 정의
- `invest`는 teaser surface로 위치 고정

**완료 기준**
- 문서와 UI에서 현재 공개 범위를 혼동 없이 이해할 수 있다.

### A2. Launch 기준 정의
**해야 할 일**
- 구조 준비 완료 기준 정의
- 콘텐츠 투입 준비 완료 기준 정의

**예시 기준**
- IA 정렬 완료
- zero-state 구현 완료
- header active state 완료
- content schema / sanitize / test 최소선 확보

### A3. 콘텐츠 운영 규칙 뼈대 작성
**해야 할 일**
- frontmatter 규칙
- 카테고리 선택 기준
- 제목 / excerpt / tags 규칙
- 초안 → 검토 → 발행 최소 절차

**추천 문서**
- `docs/content/CONTENT_GUIDE.md`

---

## B. Design / IA Alignment

### B1. `/blog` IA 위치 명확화
**해야 할 일**
- 헤더 / 브랜드 / 카피에서 `/blog`를 dev archive로 일관되게 표현
- `Dev`와 `All Posts`의 관계 재정의

**완료 기준**
- 사용자가 현재 위치와 정보구조를 직관적으로 이해한다.

### B2. Zero-state 설계
**대상 화면**
- `/dev`
- `/blog`
- `/blog/[category]`
- 최근 글 섹션
- 카테고리 빈 상태

**포함 요소**
- 안내 카피
- 앞으로 들어올 콘텐츠 유형 설명
- CTA 또는 가이드 링크
- 빈 상태에서도 안정적인 레이아웃

### B3. 헤더 / 내비 개선
**해야 할 일**
- active link 표시
- 현재 위치 강조
- 모바일 내비 정리
- Dev / Invest / Blog 관계가 드러나는 라벨링 검토

### B4. 브랜드 정합성 정리
**해야 할 일**
- `console.log(dev)` vs `종구리.dev` 사용 맥락 통일
- 메타데이터 / 페이지 타이틀 / 헤더 브랜드 문구 정리

### B5. 토큰 / 컴포넌트 규율 강화
**해야 할 일**
- 카테고리 배지 색상 토큰화
- 버튼 / 카드 / 배지 상태 variant 정리
- inline style 점진 축소

---

## C. Frontend Architecture Hardening

### C1. 콘텐츠 도메인 계층 분리
**현재 문제**
- `lib/posts.ts`에 파일 로딩, 파싱, 카테고리 메타, excerpt 생성, HTML 변환이 몰려 있음

**추천 구조**
- `lib/content/categories.ts`
- `lib/content/schema.ts`
- `lib/content/repository.ts`
- `lib/content/transform.ts`

### C2. 중복 로직 제거
**해야 할 일**
- `CATEGORIES` 단일 source of truth화
- read time / date formatter / label helper 공통화

### C3. 보안 강화
**현재 리스크**
- `sanitize: false` + `dangerouslySetInnerHTML`

**해야 할 일**
- sanitize 전략 적용
- 허용 태그 / 속성 allowlist 정리
- markdown 렌더 파이프라인 안전화

### C4. 조회 구조 최적화
**해야 할 일**
- metadata/page 중복 읽기 최소화
- posts index 캐싱 또는 memoization
- category/post 조회 경로 정리

### C5. 최소 테스트 도입
**우선 테스트 대상**
- excerpt/title parsing
- category/frontmatter validation
- empty content / malformed content
- route smoke test (`/blog`, category, notFound)

---

## 6. 우선순위

### P1. 가장 먼저
1. 제품 범위 / IA 확정
2. zero-state 설계
3. 브랜드 정합성 정리
4. content architecture 분리 시작
5. sanitize 적용 방향 결정

### P2. 바로 다음
6. 헤더 / 내비 개선
7. 중복 로직 제거
8. README / CONTENT_GUIDE 문서화
9. 조회 최적화
10. 테스트 추가

### P3. 이후
11. invest 확장
12. 검색/필터 고도화
13. MDX/CMS 등 구조 확장 검토

---

## 7. 2주 실행안

### 1주차 — 구조 / 경험 정렬
- Day 1
  - 제품 범위 확정
  - `/blog` 위치 확정
  - 브랜드 문구 방향 확정
- Day 2
  - zero-state 카피/화면 설계
  - 헤더/내비 개선안 정의
- Day 3~4
  - 콘텐츠 도메인 계층 분리
  - `CATEGORIES` / helper 단일화
- Day 5
  - sanitize 적용
  - README / 콘텐츠 가이드 초안 작성

### 2주차 — 안정성 / 완성도 보강
- Day 6~7
  - zero-state 실제 반영
  - 헤더 active/mobile 반영
- Day 8~9
  - metadata/page 조회 구조 정리
  - 캐싱/중복 로딩 개선
- Day 10
  - 테스트 최소 세트 추가
- Day 11~12
  - empty state / route / notFound QA
  - 카피/브랜딩 마감
- Day 13~14
  - 콘텐츠 투입 준비 상태 점검
  - 이후 운영용 체크리스트 확정

---

## 8. 바로 backlog로 옮길 수 있는 Epic

### Epic 1. Product / IA Alignment
- `/blog`를 dev archive로 명시
- `invest`를 teaser surface로 정리
- launch 기준 정의
- 콘텐츠 가이드 작성

### Epic 2. Empty-state UX
- `/dev` zero-state
- `/blog` zero-state
- category zero-state
- recent posts empty handling
- empty-state microcopy 정리

### Epic 3. Navigation & Brand Consistency
- active nav 추가
- 모바일 헤더 정리
- 브랜드 문구 통일
- page title / metadata 통일

### Epic 4. Content Architecture Refactor
- content schema 도입
- categories 단일화
- transform helper 분리
- repository 계층 분리
- 중복 제거

### Epic 5. Safety & Quality
- sanitize 적용
- malformed content validation
- unit/integration smoke test
- README 개편

---

## 9. 추천 실행 순서
1. IA / 브랜드 정렬
2. zero-state 설계 및 구현
3. 콘텐츠 계층 분리 + 중복 제거
4. sanitize + validation
5. 테스트 + 문서화

이 순서가 좋은 이유는, 사용자 경험과 제품 정의를 먼저 고정한 뒤 기술 구조를 그 정의에 맞춰 정리할 수 있기 때문이다.

---

## 10. 최종 권장안
가장 현실적인 방향은 아래와 같다.

- 이번 라운드는 **콘텐츠 투입 준비 단계**로 정의한다.
- 제품은 **dev 중심**으로 정렬한다.
- `/blog`는 **dev archive**로 본다.
- `invest`는 유지하되 확장하지 않는다.
- 디자인은 **zero-state + nav + brand consistency**를 우선한다.
- 프론트엔드는 **content architecture + sanitize + tests**를 우선한다.
- 문서는 최소한 **README + CONTENT_GUIDE + 이 실행 문서**까지 갖춘다.

---

## 11. 다음 대화에서 이어갈 때 바로 쓸 프롬프트
아래처럼 이어서 요청하면 된다.

```text
repos/dev-blog/docs/plan/BLOG_REPO_IMPROVEMENT_PLAN.md 기준으로 이어가자.
우선순위 P1부터 backlog로 쪼개고, 바로 구현 착수 가능한 항목까지 정리해줘.
```
