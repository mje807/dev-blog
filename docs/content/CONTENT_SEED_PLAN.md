# CONTENT_SEED_PLAN

실제 글을 쓰기 전에 어떤 seed부터 넣으면 좋은지 정리한 시작점 문서.

## 권장 seed 순서

### Seed 1. 홈 대표 글 1개
목적:
- `/dev` featured hero가 실제로 보이게 만들기
- 메인 랜딩 인상을 빠르게 완성하기

권장 조건:
- `featured: true`
- excerpt 품질이 좋을 것
- tags 2~4개
- 실제로 가장 먼저 읽히길 원하는 글

추천 주제 예시:
- 현재 dev archive를 대표하는 글 1편
- 팀/개발 철학이 드러나는 글 1편
- React 또는 프론트엔드 관점의 강한 대표 글 1편

---

### Seed 2. 시리즈 2~3편
목적:
- `/blog/series/[slug]` 흐름이 실제로 작동하게 만들기
- 상세 페이지의 시리즈 연결 UX를 살아나게 만들기

권장 조건:
- 같은 `series` 값 사용
- 제목에 01 / 02 / 03 표기
- 첫 편만 `featured: true` 고려

추천 주제 예시:
- React Architecture Deep Dive
- Module Federation Operations
- AI Skill Design Patterns

---

### Seed 3. 카테고리별 대표 글 1편씩
목적:
- category archive가 빈 화면처럼 보이지 않게 만들기
- archive filter 탐색이 유의미해지게 만들기

우선 추천 카테고리:
- `react`
- `frontend-architecture`
- `software-engineering`

---

## 최소 seed 세트 예시
가볍게 시작하려면 아래 4개만 있어도 됩니다.

1. 대표 featured 글 1개
2. 같은 series 글 2개
3. 다른 category 대표 글 1개

이렇게만 있어도:
- `/dev` hero
- featured cards
- latest posts
- related posts
- series page
- archive tag/search
가 대부분 실제 데이터로 동작합니다.

---

## 추천 운영 방식
- 처음에는 전부 `draft: true`로 저장
- 로컬에서 build 확인
- 공개 순서대로 `draft: false` 전환
- 대표 글만 `featured: true`
