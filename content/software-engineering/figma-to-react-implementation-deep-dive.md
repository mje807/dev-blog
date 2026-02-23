---
title: "figma-to-react 구현 상세 Deep Dive: 파이프라인이 실제로 동작하는 방식"
date: "2026-02-23"
tags: [figma-to-react, Implementation, Parser, IR, Adapter, Generator, TypeScript]
excerpt: "figma-to-react의 구현을 레이어별로 해부합니다. 입력 해석부터 코드 생성, diff 보존, 테스트 전략까지 실제 동작 경로를 심층 분석합니다."
---

# figma-to-react 구현 상세 Deep Dive: 파이프라인이 실제로 동작하는 방식

설계 문서가 "왜"를 설명한다면, 구현 문서는 "어디서 깨지고 어디서 지켜지는지"를 설명해야 합니다. figma-to-react는 구조적으로는 단순한 파이프라인처럼 보이지만, 실제 구현은 경계가 많습니다. 입력(Figma), 의미(IR), 표현(Adapter), 출력(Generator), 사용자 수정(Diff), 운영(CLI/Server)까지 모두 연결되어 있기 때문입니다.

이 글은 레이어별 구현 포인트를 따라가며, 프로젝트가 실제로 어떻게 동작하고 어디가 취약한지 정리합니다.

---

## 1. End-to-End 흐름: 어떤 데이터가 어디서 변환되는가

기본 흐름:

1. FigmaClient가 파일/노드/이미지 메타를 수집
2. Parser가 노드 트리를 정규화
3. IR Builder가 의미 모델을 구성
4. Adapter가 스타일 전략으로 번역
5. Generator가 JSX/TS/보조 파일을 생성
6. Diff 단계가 사용자 블록을 병합
7. Formatter가 출력 안정화

이 흐름에서 중요한 건 "정보 손실이 의도적으로 발생하는 지점"을 아는 것입니다.

- Parser에서 Figma 세부사항 일부를 버림
- IR에서 도메인 의미만 유지
- Adapter에서 스타일 언어별 특화 정보 생성

정보를 안 버리면 시스템이 복잡해지고, 너무 많이 버리면 출력 품질이 무너집니다.

---

## 2. Parser 레이어: 입력 불확실성을 흡수하는 단계

### 2.1 FigmaClient

핵심 규칙은 단순합니다.

- 생성자: `new FigmaClient(token: string)`
- API 경로: `/files`, `/nodes`, `/images`

여기서 흔한 오류는 시그니처 착오입니다. `{ token }` 객체를 넣거나, 토큰 로딩을 불안정하게 두면 초기 단계에서 실패합니다. 입력 경계 실패는 이후 레이어에 2차 증상으로 퍼지므로 가장 먼저 고정해야 합니다.

### 2.2 node/layout/style parser

- node-parser: 노드 타입 분기와 트리 정규화
- layout-parser: Auto Layout → IRLayout
- style-parser: fills/strokes/effects/text style 정규화

레이아웃 파싱은 특히 민감합니다. `sizeToCss` 인자 하나가 누락되어도 결과 레이아웃이 깨질 수 있습니다.

```ts
sizeToCss(size, 'width');
sizeToCss(size, 'height');
```

이런 "작은 규칙"이 누적되면 시각 오류를 만듭니다.

---

## 3. IR 레이어: 의미를 고정하는 핵심

IR는 입력도 출력도 아닙니다. 설계 의도를 보존하는 중간 언어입니다.

핵심 원칙:
- 하위 레이어는 Figma 원본을 모른다
- IR 타입만으로 렌더/스타일 결정을 내린다
- optional 필드는 엄격하게 다룬다

`exactOptionalPropertyTypes` 환경에서는 optional 필드 취급이 곧 품질입니다.

```ts
const node = {
  id,
  ...(layout && { layout }),
  ...(style && { style }),
};
```

이 패턴이 반복되는 이유는 문법 취향이 아니라 타입 계약을 지키기 위해서입니다.

---

## 4. Adapter 레이어: 동일 의미의 다중 표현

Adapter는 "같은 UI 의미"를 "다른 스타일 언어"로 변환합니다.

### Tailwind adapter
- utility class 조합
- 토큰 매핑과 arbitrary value 균형

### CSS Modules adapter
- class 분리와 파일 생성
- 네이밍 충돌 관리

### styled-components / emotion
- 선언형 스타일 생성
- 동적 props 규칙 통제

Adapter의 핵심 리스크는 의미 드리프트입니다. Adapter마다 해석이 달라지면 같은 Figma 입력이 다른 UI 의미로 출력될 수 있습니다. 그래서 token-mapper와 공통 규칙이 중요합니다.

---

## 5. Generator 레이어: 출력 신뢰를 결정하는 마지막 단계

Generator는 레이어들 결과를 코드로 조립합니다.

주요 하위 모듈:
- JSX builder
- Type generator
- Import resolver
- Formatter

여기서 중요한 것은 "코드가 돌아간다"가 아니라 "코드가 유지된다"입니다.

- import 정합성
- 타입 선언 일관성
- 포맷 안정성
- diff 친화성

이 네 가지가 깨지면 생성 결과는 매번 noisy diff를 만들고, 리뷰 피로가 증가합니다.

---

## 6. Diff 병합: 사용자 수정을 지키는 안전장치

자동 생성기의 실무 신뢰는 결국 사용자 코드 보존 여부로 결정됩니다. figma-to-react는 marker 기반 병합 전략을 사용합니다.

- `@f2r-user-start [id]`
- `@f2r-user-end`

흐름:
1. 기존 파일에서 user block 수집
2. 새 파일의 동일 id 위치에 복원
3. 매칭 실패 시 하단 append

완벽한 3-way merge는 아니지만, overwrite 대비 훨씬 실용적입니다.

---

## 7. CLI / Server 구현의 역할 분리

### CLI
- `init`, `convert`, `tokens`, `watch`
- 로컬/CI 파이프라인 진입점

### Server
- 경량 HTTP
- SSE watch 스트림
- 장시간 변환 상태 전달

이 분리는 개발/운영 경로를 분리하면서도 공통 코어를 재사용하기 위한 선택입니다.

---

## 8. 테스트 전략이 구현을 지탱한 방식

테스트는 커버리지 수치가 아니라 경계 보호입니다.

- Unit: parser/adapter/generator 규칙 검증
- Fixture E2E: 입력-출력 스냅샷
- 실 API 검증: fixture 밖 현실 검증

Phase 6 기준 263개 테스트 통과는 결과일 뿐이고, 진짜 의미는 "변환 규칙이 테스트 가능한 구조로 분해됐다"는 점입니다.

---

## 9. 구현 중 반복된 실패 패턴

1. FigmaClient 시그니처 오해
2. optional 필드 undefined 대입
3. 레이아웃 축 인자 누락
4. marker 없는 사용자 수정 유실

이 패턴을 문서화하고 체크리스트에 반영하지 않으면, 팀이 바뀔 때마다 같은 장애가 반복됩니다.

---

## 10. 성능/품질 균형 포인트

변환 도구의 성능 최적화는 단순 속도 경쟁이 아닙니다.

- 너무 공격적 캐시: stale 위험
- 너무 엄격한 생성 규칙: 확장 속도 저하
- 너무 유연한 생성 규칙: 품질 일관성 저하

결국 핵심은 "어느 지점에서 엄격하고 어느 지점에서 유연할지"를 명시적으로 정하는 것입니다.

---

## 11. 다음 확장 후보

1. 렌더 스냅샷(시각 회귀) 자동화
2. plugin UX 개선 (선택 노드 기반 즉시 변환)
3. token naming 표준 자동화
4. adapter 간 결과 일관성 메트릭

---

## 결론

figma-to-react 구현의 본질은 생성 코드 자체보다 경계 제어입니다.

- Parser는 입력 불확실성을 흡수하고
- IR는 의미를 고정하고
- Adapter는 표현을 분리하고
- Generator는 출력 신뢰를 보장하고
- Diff는 사용자 신뢰를 지킵니다.

이 다섯 축이 함께 유지될 때, 자동 생성 도구는 "한 번 신기한 도구"가 아니라 "지속 가능한 개발 인프라"가 됩니다.
