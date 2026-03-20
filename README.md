# dev-blog

`console.log(dev)` 중심으로 정렬된 개인 개발 아카이브 레포입니다.

## 현재 제품 구조
- `/dev` — 메인 dev landing
- `/blog` — Dev Archive
- `/blog/[category]` — 카테고리별 아카이브
- `/invest` — teaser surface

이번 라운드의 목표는 **콘텐츠 대량 투입 전, 구조/브랜드/아카이브 UX를 안정화하는 것**입니다.

## 실행 문서
- 개선 계획: `docs/plan/BLOG_REPO_IMPROVEMENT_PLAN.md`
- P1 실행 backlog: `docs/plan/P1_EXECUTION_BACKLOG.md`
- sanitize 결정: `docs/plan/P1_07_SANITIZE_DECISION.md`
- 콘텐츠 운영 가이드: `docs/content/CONTENT_GUIDE.md`

## 개발 명령어
```bash
npm run dev
npm run typecheck
npm run build
npm run lint
npm run quality:gate
```

## 콘텐츠 구조
```text
content/
  react/
  frontend-architecture/
  software-engineering/
  ai-skill-design/
  claude-code/
  general/
```

## content 계층 구조
```text
lib/content/
  categories.ts   # 카테고리 메타 단일 source
  schema.ts       # Post / Frontmatter 타입
  repository.ts   # 파일 시스템 읽기
  transform.ts    # slug/title/excerpt 정규화
  validation.ts   # frontmatter 최소 validation
  render.ts       # sanitized markdown -> HTML
```

## 작성 규칙 요약
- 카테고리는 하나를 기본값으로 선택
- `title`, `date`, `tags`, `excerpt` frontmatter 권장
- `date`는 `YYYY-MM-DD` 권장
- `tags`는 문자열 배열만 허용
- `excerpt`가 없으면 본문에서 자동 생성
- 자세한 규칙은 `docs/content/CONTENT_GUIDE.md` 참고

## 렌더링 / 보안
markdown 렌더 파이프라인은 sanitize를 적용합니다.

- `remark-gfm`
- `remark-rehype`
- `rehype-sanitize`
- `rehype-stringify`

즉, raw HTML을 신뢰하는 구조가 아니라 **허용 태그/속성 기반 렌더링**을 사용합니다.

## 현재 우선순위
1. dev 중심 IA 정렬
2. zero-state UX
3. content architecture 정리
4. sanitize / validation
5. 테스트 및 운영 문서화
