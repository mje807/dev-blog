# CONTENT_GUIDE

`dev-blog`에 글을 넣을 때 따르는 최소 운영 규칙.

## 목적
- `console.log(dev)` 중심 MVP 구조에 맞춰 글을 일관되게 관리한다.
- 아카이브/카테고리/카드 UI가 깨지지 않도록 frontmatter 품질을 맞춘다.
- 초안 → 검토 → 발행 흐름의 최소 기준을 남긴다.

---

## 현재 제품 구조
- `/dev`: 메인 랜딩
- `/blog`: Dev Archive
- `/blog/[category]`: 카테고리 아카이브
- `/invest`: teaser surface

즉, 이번 라운드에서 실제 운영 중심은 **dev 글 아카이브**입니다.

---

## 카테고리 규칙
현재 허용 카테고리:
- `react`
- `compiler`
- `frontend-architecture`
- `software-engineering`
- `ai-skill-design`
- `claude-code`
- `general`

### 선택 기준
- `react`: React 내부 동작, 렌더링, SSR, hydration, hooks, router 등
- `compiler`: 파싱, AST, 정적 분석, IR, 최적화 패스, 타입 시스템, 컴파일러 구조
- `frontend-architecture`: MFE, module federation, 계층 구조, UI architecture
- `software-engineering`: 운영 경험, 품질, 테스트, 설계 원칙, 협업 방식
- `ai-skill-design`: 에이전트/스킬 설계, 프롬프트 운영, 자동화 구조
- `claude-code`: Claude Code 워크플로, 활용법, 패턴
- `general`: 위 카테고리 어디에도 애매하게 걸치는 글

카테고리는 **하나만 선택**하는 것을 기본값으로 둡니다.

---

## 파일 위치 규칙
예시:
- `content/react/react-architecture-01-package-structure.md`
- `content/frontend-architecture/module-federation-page-caching-strategy.md`

규칙:
- 파일명은 `kebab-case`
- 가능하면 제목보다 **주제/검색성** 중심으로 naming
- 같은 시리즈는 접두 규칙을 맞춘다

---

## frontmatter 규칙
권장 형식:

```md
---
title: React Server Components의 역할 정리
date: 2026-03-20
tags:
  - react
  - rsc
  - architecture
excerpt: React Server Components가 어떤 문제를 풀고, 기존 loader/action 모델과 어떻게 역할을 나누는지 정리한다.
draft: false
featured: true
series: React Architecture Deep Dive
---
```

### 필드 규칙
- `title`
  - 권장: 명확하고 검색 가능한 제목
  - 없으면 본문 첫 H1 또는 파일명으로 fallback
- `date`
  - 권장: `YYYY-MM-DD`
  - 잘못된 날짜면 fallback 처리될 수 있음
- `tags`
  - 문자열 배열만 허용
  - 빈 값/숫자/혼합 타입은 무시됨
- `excerpt`
  - 1~2문장 권장
  - 없으면 본문 첫 문단 기반 자동 생성
- `draft`
  - `true`면 archive/route에서 제외
  - 초안 저장용으로 사용
- `featured`
  - `true`면 이후 홈/아카이브 강조 영역 후보로 사용
- `series`
  - 같은 시리즈 글을 묶는 문자열
  - 예: `React Architecture Deep Dive`

---

## 본문 작성 규칙
- 문서 시작부에 가능한 한 H1 하나를 둔다
- 첫 1~2문단 안에 “이 글이 푸는 문제”를 적는다
- heading 계층은 `h2`, `h3` 중심으로 단순하게 유지한다
- 코드블록은 fenced block 사용
- 표는 필요한 경우만 사용

### 권장 구조
1. 문제 정의
2. 왜 중요한지
3. 구조/원리 설명
4. 실제 운영 관점
5. 트레이드오프 / 결론

---

## 발행 전 체크리스트
- [ ] 카테고리가 맞는가
- [ ] title이 검색 가능한가
- [ ] excerpt가 카드/리스트에 노출돼도 자연스러운가
- [ ] 첫 문단만 읽어도 글 목적이 보이는가
- [ ] 태그가 과도하게 많지 않은가
- [ ] 코드블록/표/링크가 sanitize 이후에도 의미가 유지되는가

---

## 최소 운영 절차
### 초안
- 구조와 핵심 메시지를 먼저 정리
- excerpt 초안 작성

### 검토
- 카테고리/제목/excerpt 확인
- 중복 주제 여부 확인
- 카드/아카이브에 노출될 때 어색하지 않은지 확인

### 발행
- 적절한 content 폴더에 저장
- build/typecheck 확인
- Dev Archive 반영 상태 확인

---

## 바로 시작할 때 참고할 문서
- 포스트 기본 템플릿: `docs/content/POST_TEMPLATE.md`
- 시리즈 템플릿: `docs/content/SERIES_TEMPLATE.md`
- seed 추천 순서: `docs/content/CONTENT_SEED_PLAN.md`

## 메모
- 이번 라운드는 **콘텐츠 양보다 구조 안정화**가 우선입니다.
- invest 관련 본격 확장은 아직 범위 밖입니다.
