# P1-07 Sanitize Decision

## 목표
- markdown 렌더 경로에서 unsafe HTML 허용을 제거한다.
- 기존 정적 블로그 흐름은 유지하되, 허용 태그/속성을 명시적으로 관리한다.

## 기존 상태
- `remarkHtml({ sanitize: false })`
- 이후 `dangerouslySetInnerHTML`로 출력
- 결과적으로 markdown source에 포함된 HTML이 과도하게 신뢰되는 구조였다.

## 결정
- 렌더 파이프라인을 아래로 교체한다.
  - `remark-gfm`
  - `remark-rehype`
  - `rehype-sanitize`
  - `rehype-stringify`
- `dangerouslySetInnerHTML`는 유지하되, 입력 HTML을 sanitize된 결과로 제한한다.

## allowlist 방향
### 허용 태그
- heading: `h1` ~ `h6`
- text: `p`, `strong`, `em`, `del`, `blockquote`, `hr`
- list: `ul`, `ol`, `li`
- code: `pre`, `code`
- link/media: `a`, `img`
- table: `table`, `thead`, `tbody`, `tr`, `th`, `td`

### 허용 속성
- `a`: `href`, `title`, `target`, `rel`
- `code`: `className` (`language-*` 패턴만 허용)
- `img`: `src`, `alt`, `title`, `width`, `height`, `loading`

## 제외 범위
- 임의 inline event handler
- script/style/embed/iframe
- arbitrary class/style 허용
- raw HTML 확장 지원

## 후속 과제
- Mermaid 같은 고급 블록이 필요하면, markdown 단계가 아니라 명시적인 컴포넌트/플러그인 레이어에서 다시 허용 여부를 검토한다.
- malformed frontmatter validation은 P2 테스트/validation 묶음에서 강화한다.
