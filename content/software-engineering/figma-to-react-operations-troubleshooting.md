---
title: "figma-to-react 운영 및 트러블슈팅 가이드: 실패를 빠르게 좁히는 방법"
date: "2026-02-23"
tags: [figma-to-react, Troubleshooting, Operations, Dev Workflow]
excerpt: "figma-to-react를 안정적으로 운영하기 위한 체크리스트와 트러블슈팅 패턴을 정리합니다. 반복되는 실패를 빠르게 좁히는 운영 관점 문서입니다."
---

# figma-to-react 운영 및 트러블슈팅 가이드: 실패를 빠르게 좁히는 방법

코드 생성 도구의 운영 품질은 "몇 개 기능이 있느냐"보다 "실패를 얼마나 빨리 좁히느냐"에서 결정됩니다. figma-to-react도 예외가 아닙니다. 특히 디자인 입력(Figma), 타입 제약(TypeScript), 출력 코드(React)라는 세 축이 동시에 얽히기 때문에, 문제를 레이어 단위로 쪼개서 보는 습관이 필수입니다.

이 글은 자주 발생하는 오류 패턴과 운영 루틴을 정리합니다.

---

## 1) 실행 전 기본 체크

### 최소 헬스체크

```bash
cd /tmp/figma-to-react/packages/core
npx vitest run

cd /tmp/figma-to-react
npx f2r --help
```

이 단계에서 깨지면 변환 파이프라인 진입 전에 환경 문제를 먼저 해결해야 합니다.

### 실제 검증 전제

- Figma PAT 유효성 확인
- 대상 파일 접근 권한 확인
- 테스트 fixture와 실제 파일 검증을 분리

---

## 2) 반복되는 오류 패턴

### 패턴 A: FigmaClient 생성자 사용 오류

증상: 클라이언트 초기화 단계 타입 오류

원인: `new FigmaClient({ token })` 형태 사용

해결: string token 직접 전달

```ts
new FigmaClient(process.env.FIGMA_TOKEN!);
```

---

### 패턴 B: exactOptionalPropertyTypes 충돌

증상: optional 필드 대입에서 타입 오류 연쇄

원인: optional 필드에 undefined 직접 할당

해결: spread conditional 패턴 사용

```ts
const out = {
  id,
  ...(value && { key: value }),
};
```

---

### 패턴 C: 레이아웃 변환 미세 오차

증상: 결과 컴포넌트 폭/높이 해석 불일치

원인: `sizeToCss` 축 인자 누락

해결:

```ts
sizeToCss(size, 'width');
sizeToCss(size, 'height');
```

---

### 패턴 D: 사용자 수동 수정 유실

증상: 재생성 후 커스텀 코드 사라짐

원인: marker 블록 미사용 또는 id 불일치

해결: marker 규칙 강제 + PR 체크리스트 반영

---

## 3) 장애 시 진단 순서

문제가 생기면 아래 순서로 좁히는 것이 가장 빠릅니다.

1. 입력(Figma API 응답) 확인
2. Parser 출력(IR 전 단계) 확인
3. IR 출력 확인
4. Adapter 출력 확인
5. Generator 최종 출력 확인

핵심은 "최초 이상 지점"을 찾는 것입니다. 마지막 결과만 보면 원인이 흐려집니다.

---

## 4) 운영 품질을 올리는 체크리스트

- [ ] 실제 Figma 파일 baseline 검증이 있는가
- [ ] Diff 보존 시나리오를 정기 검증하는가
- [ ] 변환 실패 로그에 레이어 정보가 남는가
- [ ] 테스트 통과와 실 API 통과를 분리 보고하는가
- [ ] 토큰/시크릿 노출 방지 루틴이 있는가

---

## 5) 릴리즈 전 필수 게이트

릴리즈/배포 전에는 아래를 최소 게이트로 잡는 것이 안전합니다.

1. core 테스트 통과
2. 실제 파일 변환 1회 이상 성공
3. 생성 결과 타입 체크 통과
4. 사용자 블록 보존 검증
5. 변경사항 문서 동기화

---

## 6) 운영 관점에서 자주 놓치는 것

### "테스트는 통과했는데 실제 파일이 깨진다"

이건 보통 테스트가 단순 fixture에 편향됐다는 신호입니다. 실제 디자인 파일은 예외 노드/불완전 스타일/권한 제약이 함께 들어옵니다. 그래서 "실 API 검증"을 독립 단계로 유지해야 합니다.

### "문제는 알겠는데 누가 고칠지 모르겠다"

레이어 소유권이 없으면 대응이 느려집니다. Parser/IR/Adapter/Generator 담당 범위를 명시해 두면 장애 대응 속도가 크게 올라갑니다.

---

## 7) 추천 운영 문서 구조

프로젝트가 커질수록 문서도 역할 분리가 필요합니다.

- ARCHITECTURE.md
- IMPLEMENTATION.md
- TROUBLESHOOTING.md
- CONTRIBUTING.md

이 글은 TROUBLESHOOTING seed로 바로 확장 가능한 내용입니다.

---

## 마무리

figma-to-react 운영의 핵심은 기능이 아니라 관측성입니다. 실패를 레이어 단위로 좁히고, 반복되는 패턴을 문서화하고, 실 API 검증을 루틴화하면 도구 신뢰도가 유지됩니다.

자동 생성 도구는 "잘 생성되는 날"보다 "깨졌을 때 빨리 복구되는 날"에 가치를 증명합니다.
