---
title: "figma-to-react 아키텍처 의사결정 기록: 왜 4-Layer 구조를 선택했는가"
date: "2026-02-23"
tags: [figma-to-react, Architecture, ADR, Code Generation, TypeScript]
excerpt: "figma-to-react의 핵심 설계 결정을 ADR 관점으로 정리합니다. Parser→IR→Adapter→Generator 구조를 왜 선택했고, 어떤 트레이드오프를 감수했는지 설명합니다."
---

# figma-to-react 아키텍처 의사결정 기록: 왜 4-Layer 구조를 선택했는가

자동 코드 생성 도구는 데모 단계에서는 빠르게 만들 수 있지만, 실무 단계로 들어가는 순간 유지보수 난이도가 급격히 올라갑니다. 특히 Figma처럼 입력 스키마가 복잡하고 결과물 스타일 타깃(Tailwind, CSS Modules, styled-components, emotion)이 여러 개인 경우에는 "한 번 변환되면 끝" 모델이 거의 항상 깨집니다.

figma-to-react는 이 문제를 피하기 위해 초기에 아키텍처 결정을 강하게 걸었습니다. 핵심은 다음 한 문장입니다.

> 변환 복잡도는 기능으로 해결하지 않고, 경계로 해결한다.

---

## 1) Parser → IR → Adapter → Generator를 분리한 이유

### Parser
Figma API 응답을 직접 생성기로 넘기지 않고, 파서에서 먼저 "해석 가능한 정보"로 정리합니다. 이 단계의 목적은 Figma 원본 JSON의 변동성을 프로젝트 내부로 그대로 전파하지 않는 것입니다.

### IR (Intermediate Representation)
IR은 이 프로젝트의 진실 원천입니다. 이후 단계는 Figma 원본 구조를 몰라도 동작해야 합니다. 즉, Adapter와 Generator가 "Figma가 어떻게 생겼는지"가 아니라 "우리가 어떤 UI 의미를 갖는지"만 알도록 경계를 만듭니다.

### Adapter
같은 의미를 다른 스타일 언어로 변환합니다. Tailwind를 쓰든 CSS Modules를 쓰든, 의미 계층은 같아야 합니다. Adapter는 그 번역기 역할을 맡습니다.

### Generator
최종 JSX/TS/보조 파일을 생성합니다. Generator가 파싱 책임까지 가지면 코드가 빠르게 비대해지고, 디버깅 비용이 급증합니다. 그래서 생성기는 "마지막 조립 단계"에 집중합니다.

---

## 2) 이 구조로 얻은 실질적 이점

1. **스타일 타깃 확장 비용 감소**
   - Adapter 추가만으로 새 스타일 전략을 붙일 수 있습니다.
2. **회귀 디버깅 경로 단축**
   - Parser 문제인지, Adapter 문제인지 레이어 단위로 좁힐 수 있습니다.
3. **테스트 단위 명확화**
   - Unit 테스트와 Fixture 기반 E2E를 레이어별로 분리해 운영 가능합니다.

---

## 3) 감수한 트레이드오프

아키텍처는 공짜가 아닙니다.

- 초기 구현 속도 저하
- 타입 정의와 변환 코드 증가
- 신규 기여자 온보딩 비용 상승

하지만 figma-to-react처럼 장기적으로 규칙이 늘어나는 프로젝트에서는, 이 비용을 초기에 내는 편이 총비용이 낮습니다.

---

## 4) strict TypeScript를 유지한 이유

`exactOptionalPropertyTypes: true` 제약은 불편합니다. optional 필드에 `undefined`를 습관적으로 넣으면 바로 깨집니다. 그럼에도 유지한 이유는 생성기 품질 때문입니다.

생성 도구는 작은 타입 누수도 결과물 전체 신뢰를 무너뜨립니다. 그래서 다소 장황하더라도 아래 패턴을 기준으로 삼았습니다.

```ts
const node = {
  id,
  ...(layout && { layout }),
  ...(style && { style }),
};
```

이 제약 덕분에 "있을 수도 있는 필드"와 "반드시 있는 필드" 경계가 선명해졌고, 결과 코드 일관성이 올라갔습니다.

---

## 5) 사용자 코드 보존 전략을 별도 결정으로 분리한 이유

자동 생성기에서 가장 위험한 사고는 사용자 수정 내용 유실입니다. 그래서 figma-to-react는 diff marker 전략을 별도 ADR로 취급했습니다.

- `@f2r-user-start [id]`
- `@f2r-user-end`

생성 재실행 시 marker 기준으로 블록을 보존합니다. 이 전략은 완벽하지 않지만, overwrite 방식 대비 실무 신뢰를 크게 높였습니다.

---

## 6) Plugin/Server/CLI 하이브리드 선택

Plugin만으로는 CI 자동화와 파일 시스템 통제가 약하고, CLI만으로는 디자이너 접점을 놓치기 쉽습니다. 그래서 하이브리드 전략을 택했습니다.

- Plugin: 디자인 툴 내부 접점
- Server: watch/SSE/자동화 API
- CLI: 로컬/CI 워크플로우

이 구조는 복잡도를 올리지만, 실제 협업 흐름(디자이너-개발자-운영)을 고려하면 현실적인 선택입니다.

---

## 마무리

figma-to-react의 아키텍처 결정은 "예쁜 구조"를 위한 것이 아닙니다. 변환 규칙이 계속 늘어나는 상황에서 품질을 유지하기 위한 생존 전략입니다.

이 프로젝트에서 중요한 건 Figma를 React로 바꾸는 기능 그 자체가 아니라, **변환의 복잡성을 어디에서 흡수할지**를 명확히 나누는 설계입니다.
