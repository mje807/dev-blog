---
title: "figma-to-react 운영 및 트러블슈팅 가이드: 실패를 빠르게 좁히는 방법"
date: "2026-02-23"
tags: [figma-to-react, Troubleshooting, Operations, CI, Dev Workflow]
excerpt: "figma-to-react를 안정적으로 운영하기 위한 체크리스트와 트러블슈팅 패턴을 정리합니다. 반복되는 실패를 빠르게 좁히는 운영 관점 문서입니다."
---

# figma-to-react 운영 및 트러블슈팅 가이드: 실패를 빠르게 좁히는 방법

자동 생성 도구를 운영할 때 가장 위험한 착각은 "기능이 많으면 운영이 쉬워진다"는 생각입니다. 실제로는 반대입니다. 기능이 늘어날수록 실패 지점도 늘어나고, 운영에서 필요한 것은 기능 설명이 아니라 **실패를 빠르게 좁히는 체계**입니다.

figma-to-react의 운영 핵심은 다음 세 가지입니다.

1. 실행 전 게이트를 단순하게 고정
2. 장애 시 레이어 단위로 진단
3. 반복 패턴을 문서와 자동화로 흡수

이 글은 이 세 가지를 중심으로 실무 운영 루틴을 정리합니다.

---

## 1. 실행 전 게이트: 시작 전에 절반을 끝낸다

### 최소 헬스체크

```bash
cd /tmp/figma-to-react/packages/core
npx vitest run

cd /tmp/figma-to-react
npx f2r --help
```

테스트/CLI가 여기서 깨지면 변환 단계로 넘어가면 안 됩니다.

### 운영 게이트 권장

- 테스트 통과
- 실제 Figma 파일 1개 smoke 변환 성공
- 타입 체크 통과
- diff 보존 시나리오 점검

이 네 가지를 통과하면 대부분의 반복 장애를 초기에 걸러낼 수 있습니다.

---

## 2. 장애 진단 순서: "최초 이상 지점" 찾기

문제가 생기면 결과 파일부터 보지 말고 입력부터 좁혀야 합니다.

권장 순서:
1. Figma API 응답 확인
2. Parser 출력 확인
3. IR 출력 확인
4. Adapter 출력 확인
5. Generator 출력 확인

이 순서가 중요한 이유는 단순합니다. 마지막 증상은 원인이 아니라 결과일 때가 대부분이기 때문입니다.

---

## 3. 반복되는 오류 패턴과 대응

### 패턴 A: FigmaClient 초기화 오류

원인: 생성자 시그니처 착오 (`{ token }` 사용)
해결: `new FigmaClient(token: string)` 고정

### 패턴 B: exactOptionalPropertyTypes 충돌

원인: optional 필드에 undefined 직접 대입
해결: spread conditional 패턴 사용

```ts
const out = {
  id,
  ...(value && { key: value }),
};
```

### 패턴 C: 레이아웃 변환 누락

원인: `sizeToCss` 축 인자 누락
해결: width/height 축 명시

### 패턴 D: 사용자 코드 유실

원인: marker 미사용/오탈자
해결: marker 규칙 강제 + PR 체크

---

## 4. 운영 로그 설계

장애 대응 속도를 올리려면 로그 필드를 표준화해야 합니다.

권장 필드:
- runId
- fileKey
- nodeId
- layer(parser/ir/adapter/generator)
- errorCode
- durationMs
- retryCount

이 필드가 있으면 "어디서, 얼마나 자주, 어떤 형태로" 깨지는지 빠르게 파악할 수 있습니다.

---

## 5. 실 API 검증을 별도 단계로 유지해야 하는 이유

fixture 테스트는 필요하지만 충분하지 않습니다. 실제 Figma 파일은 다음을 동반합니다.

- 예외 노드 구조
- 접근 권한 변동
- 누락/비일관 스타일 데이터

그래서 "테스트 통과"와 "실 API 통과"를 별도 상태로 관리해야 합니다.

운영 권장 상태:
- unit-pass
- fixture-e2e-pass
- real-api-pass

세 상태를 분리하면 회귀 원인 추적이 쉬워집니다.

---

## 6. CI/CD에 연결할 때 주의점

### 비밀정보 관리

- PAT를 코드/로그/채팅에 남기지 않기
- 노출 시 즉시 revoke + 재발급
- CI secret 스코프 최소화

### 실패 처리

- flaky retry를 무분별하게 늘리지 않기
- 실패 로그에 레이어 정보 포함
- 실패 fixture 자동 아카이빙

### 품질 게이트

- 생성 코드 포맷 안정성
- diff 보존 테스트
- 최소 smoke render 검증

---

## 7. 운영 플레이북 (요약)

### 변환 실패 시
1) 입력 보존
2) 레이어별 출력 추적
3) 최초 이상 지점 확정
4) 최소 재현 fixture 작성
5) 회귀 테스트 추가

### 레이아웃 깨짐 시
1) auto layout 해석값 확인
2) size/axis 변환 체크
3) adapter별 스타일 충돌 확인

### 타입 오류 시
1) optional 필드 처리 확인
2) union narrowing 점검
3) 생성 타입/사용 타입 정합성 검증

---

## 8. 조직 운영 관점에서 필요한 문서

프로젝트가 커질수록 문서를 역할별로 분리해야 합니다.

- ARCHITECTURE.md (왜)
- IMPLEMENTATION.md (어떻게)
- TROUBLESHOOTING.md (깨졌을 때)
- CONTRIBUTING.md (누가/어떻게 참여)

이 글은 TROUBLESHOOTING seed로 바로 확장 가능한 베이스입니다.

---

## 9. 안티패턴

1. "테스트 통과 = 릴리즈 가능"으로 간주
2. 장애 로그에 레이어 정보 누락
3. 사용자 코드 보존 검증 생략
4. 운영 문서 없이 구두 지식에 의존

이 네 가지는 프로젝트 성숙도와 무관하게 반복적으로 비용을 만듭니다.

---

## 결론

figma-to-react 운영의 핵심은 변환 성공률이 아니라 복구 속도입니다. 실패를 빨리 좁히고, 반복 패턴을 문서화하고, 실 API 검증을 루틴화하면 자동 생성 도구를 안정적인 팀 인프라로 유지할 수 있습니다.

자동 생성 도구의 가치는 "잘 될 때"보다 "깨졌을 때" 증명됩니다.
