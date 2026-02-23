---
title: "figma-to-react 구현 상세 Deep Dive: 파이프라인이 실제로 동작하는 방식"
date: "2026-02-23"
tags: [figma-to-react, Implementation, Parser, IR, Generator, TypeScript]
excerpt: "figma-to-react의 구현을 레이어별로 해부합니다. Parser, IR, Adapter, Generator, Diff 보존까지 실제 동작 경로를 정리합니다."
---

# figma-to-react 구현 상세 Deep Dive: 파이프라인이 실제로 동작하는 방식

설계 문서는 방향을 알려주지만, 구현 디테일은 별도로 정리하지 않으면 팀 지식이 빠르게 휘발됩니다. 이 글은 figma-to-react의 실제 동작 경로를 레이어 기준으로 추적합니다.

---

## 1) 입력부터 출력까지 한 번에 보기

전체 흐름은 다음과 같습니다.

1. FigmaClient가 파일/노드 데이터를 가져온다
2. Parser가 노드/레이아웃/스타일을 해석한다
3. IR Builder가 중간 표현 트리를 만든다
4. Adapter가 스타일 전략별 코드 표현을 생성한다
5. Generator가 JSX/TS를 조립한다
6. Diff 단계에서 사용자 블록을 보존한다
7. Formatter를 거쳐 파일을 출력한다

핵심은 "한 번에 생성"이 아니라 "단계별 의미 보존"입니다.

---

## 2) Parser 레이어 구현 포인트

### FigmaClient
가장 흔한 함정은 생성자 시그니처입니다. `new FigmaClient(token: string)` 형태가 기준인데, 객체 `{ token }`를 넘기면 타입 단계에서 바로 깨집니다.

이런 작은 규칙 하나가 중요했던 이유는, 입력 경계가 흔들리면 이후 오류가 모두 2차 증상으로 나타나기 때문입니다.

### node/layout/style parser
- node-parser: 노드 타입 분류와 트리 정규화
- layout-parser: Auto Layout 규칙을 IRLayout으로 전환
- style-parser: fills/strokes/effects/text style 정규화

실무에서 문제가 가장 많았던 구간은 레이아웃 해석입니다. 특히 `sizeToCss` 호출은 축 인자가 필요합니다.

```ts
sizeToCss(size, 'width');
sizeToCss(size, 'height');
```

단순해 보이지만 이 규칙 누락이 누적되면 생성 결과가 미묘하게 어긋납니다.

---

## 3) IR 레이어: 복잡도를 고정하는 계층

IR는 이 프로젝트에서 가장 중요한 레이어입니다. 이유는 분명합니다.

- Figma 원본 변화가 Parser에서만 처리됨
- Adapter/Generator는 IR만 보면 됨
- 테스트 fixture를 IR 기준으로 고정 가능

즉 IR는 타입 집합이 아니라 "프로젝트의 안정화 장치"입니다.

`exactOptionalPropertyTypes` 환경에서 IR를 안전하게 유지하려면 optional 필드 취급을 엄격히 해야 했습니다.

```ts
const out = {
  id,
  ...(value && { key: value }),
};
```

이 패턴이 반복되는 이유는 코드 스타일이 아니라, 타입 계약을 런타임 의미와 일치시키기 위해서입니다.

---

## 4) Adapter 레이어: 같은 의미를 다른 언어로 번역

Adapter는 기능 추가가 가장 자주 일어나는 곳입니다.

- Tailwind: utility class 매핑
- CSS Modules: class + module file 생성
- styled-components/emotion: 선언형 스타일 블록 생성

여기서 중요한 건 "표현이 달라도 의미는 같아야 한다"는 점입니다. Adapter가 의미를 바꾸기 시작하면 결과가 일관되지 않게 됩니다.

그래서 token-mapper를 별도 축으로 두고, 스타일 의미를 semantic token으로 승격하는 경로를 유지했습니다.

---

## 5) Generator 레이어: 출력 품질의 마지막 방어선

Generator는 IR/Adapter 결과를 코드로 조립합니다.

- JSX builder
- Type generator
- Import resolver
- Formatter

이 단계의 책임은 기능 추가보다 안정성입니다. import 충돌, dead import, 타입 불일치, 포맷 편차 같은 "작은 잡음"이 누적되면 전체 신뢰가 급격히 떨어집니다.

---

## 6) Diff 보존: 자동 생성기 신뢰의 핵심

자동 생성기의 실패는 대부분 사용자 수동 수정 유실에서 시작합니다. figma-to-react는 marker 기반 보존 전략을 사용합니다.

- `@f2r-user-start [id]`
- `@f2r-user-end`

재생성 시 기존 블록을 찾아 재삽입합니다. 매칭 실패 시 하단 append로 최소 보존을 시도합니다. 완벽하지 않더라도 overwrite 방식 대비 운영 신뢰를 크게 높였습니다.

---

## 7) 테스트 전략이 구현을 지탱한 방식

테스트는 단순 커버리지가 아니라 "변환 규칙 회귀 방지 장치"로 설계되었습니다.

- Unit: parser/adapter/generator 함수 단위
- Fixture E2E: 입력 대비 출력 스냅샷
- 실제 API 검증: 테스트 통과 이후 반드시 수행

최종 263개 테스트 통과는 숫자 자체보다, 레이어 분리 설계가 실제로 검증 가능했다는 의미가 큽니다.

---

## 8) 구현 과정에서 얻은 교훈

1. 엄격한 타입은 속도를 늦추지만 품질을 지킨다
2. IR 중심 설계는 초기 비용이 크지만 확장 비용을 낮춘다
3. 사용자 코드 보존 없는 생성기는 실무 신뢰를 잃는다
4. 테스트 통과보다 실제 API 검증이 먼저다

---

## 마무리

figma-to-react 구현의 본질은 "코드 생성"이 아니라 "경계 통제"입니다.

- 입력 경계는 Parser에서 고정하고
- 의미 경계는 IR에서 안정화하고
- 표현 경계는 Adapter에서 흡수하고
- 사용자 경계는 Diff에서 보존하는 구조

이 경계가 유지될 때만 자동 생성 도구가 프로젝트 규모 확장에도 버틸 수 있습니다.
