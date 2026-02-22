---
title: "React는 왜 throw로 기다리는가 — Suspense와 ErrorBoundary의 설계 철학"
date: "2025-02-20"
tags: [React, Suspense, ErrorBoundary, 아키텍처, 파이버]
series: "React 아키텍처 심층 분석"
---

## 언어의 무기를 재발명하다

소프트웨어 역사에서 가장 흥미로운 설계 결정들은 대부분 기존 도구를 전혀 다른 목적으로 전용(轉用)하는 데서 나온다. `throw`는 원래 예외 상황을 알리기 위한 언어 기능이다. 그런데 React 팀은 이것을 **비동기 제어 흐름의 신호**로 재정의했다.

React 18의 Suspense와 ErrorBoundary는 표면적으로는 완전히 다른 문제를 해결하는 것처럼 보인다. 하나는 데이터가 아직 준비되지 않았을 때 로딩 상태를 보여주고, 다른 하나는 컴포넌트가 충돌했을 때 대체 UI를 보여준다. 그러나 내부 구현을 들여다보면 이 두 메커니즘은 완전히 동일한 파이프라인 위에서 동작한다. 컴포넌트가 Promise를 던지든 Error를 던지든, React의 렌더 루프는 같은 방식으로 반응한다.

이 글은 React가 왜 이런 선택을 했는지, 그리고 그 선택이 어떤 철학적 일관성을 가지는지를 탐구한다.

---

## 에러 경계의 역사: 조용한 죽음에서 명시적 실패로

2017년 이전의 React 앱은 컴포넌트 내부에서 오류가 발생하면 조용히 무너졌다. 렌더 함수 안에서 예외가 발생하면 React는 이를 복구할 방법이 없었고, 앱 전체가 흰 화면으로 전환되거나 부분적으로 손상된 UI가 그대로 노출됐다. 사용자 입장에서는 왜 앱이 동작하지 않는지 알 수 없었고, 개발자 입장에서도 어떤 컴포넌트가 원인인지 추적하기 어려웠다.

React 16이 도입한 ErrorBoundary는 이 문제에 대한 철학적 응답이었다. "에러는 발생할 수 있다. 그러나 에러가 전체 앱을 무너뜨려서는 안 된다." 이 원칙은 운영 환경에서 동작하는 소프트웨어의 현실을 반영한다. 하나의 위젯이 실패하더라도 나머지 앱은 정상적으로 동작해야 한다는 것이다.

ErrorBoundary가 클래스 컴포넌트로만 구현 가능한 이유도 이 역사와 맞닿아 있다. React가 에러를 포착하고 대체 상태로 전환하려면 컴포넌트 인스턴스가 필요하고, 인스턴스 기반의 생명주기 메서드(`getDerivedStateFromError`, `componentDidCatch`)가 있어야 했다. 함수 컴포넌트로는 아직 이 역할을 수행할 수 없다. 이것은 기술적 한계가 아니라, 현재까지의 설계 우선순위 때문이다.

Suspense는 다른 방향에서 등장했다. 데이터 페칭, 코드 스플리팅, 이미지 로딩 — 이 모든 비동기 작업들에 대해 React는 통일된 추상화를 원했다. "컴포넌트가 준비되지 않았을 때 React에게 알릴 수 있는 표준 방법은 무엇인가?" 그 답이 바로 Promise를 throw하는 것이었다.

---

## throw 기반 제어 흐름의 본질

React의 렌더 루프를 이해하려면 먼저 그것이 거대한 `try-catch` 블록 안에 있다는 사실을 알아야 한다. `renderRootConcurrent` 함수는 `workLoopConcurrent`를 `try` 블록 안에서 실행하고, 무언가가 throw되면 `catch`에서 `handleError`를 호출한다. 중요한 점은 이 구조가 단순한 `try-catch`가 아니라 `do { try {...} catch {...} } while(true)` 패턴이라는 것이다.

이 패턴의 의미는 심오하다. 에러가 발생해도 렌더 루프 자체는 종료되지 않는다. `handleError`가 적절한 처리를 완료하고 `workInProgress`를 올바른 위치로 재설정하면, 루프는 자동으로 재개된다. 즉, throw는 렌더를 중단시키는 것이 아니라 **렌더의 재개 지점을 변경하는 신호**다.

이 설계를 항공기의 비상 착륙에 비유할 수 있다. 기체에 문제가 생겼다고 해서 비행 자체를 포기하지는 않는다. 대신 가장 가까운 안전한 공항으로 경로를 바꾼다. React에서 throw는 "지금 이 컴포넌트에서 렌더를 계속할 수 없다"는 신호이고, React는 가장 가까운 안전한 경계(Suspense 또는 ErrorBoundary)를 찾아 착륙한다.

---

## 파이버 트리를 거슬러 오르는 두 단계 신호

React가 예외를 처리하는 핵심 메커니즘은 **두 단계 플래그 시스템**이다. 이것을 이해하면 Suspense와 ErrorBoundary의 내부 동작이 명확해진다.

컴포넌트가 무언가를 throw하면, React는 파이버 트리를 위쪽으로 순회하며 처리할 수 있는 경계를 찾는다. 경계를 찾았을 때 React는 즉시 "이 경계가 처리했다"고 표시하지 않는다. 대신 `ShouldCapture`라는 플래그를 설정한다. 이것은 "이 파이버가 캡처해야 한다는 의도"를 표현한다.

그 다음 단계에서 `unwindWork` 함수가 호출된다. 이 함수는 throw가 발생한 지점부터 경계 파이버까지의 스택을 되감으면서, `ShouldCapture` 플래그를 가진 파이버를 만나면 이를 `DidCapture`로 전환하고 해당 파이버를 반환한다. React는 이 파이버를 `workInProgress`로 설정하고 그 지점부터 렌더를 재시작한다.

왜 두 단계로 나누는가? `unwindWork`는 단순히 플래그를 바꾸는 일만 하지 않는다. Context 스택, Suspense Context 스택, Host Container 스택 등 렌더 과정에서 쌓인 모든 상태를 정리한다. ShouldCapture를 발견하기 전까지 지나온 모든 파이버의 스택을 올바르게 팝해야 한다. 이 정리 작업 없이 바로 경계 파이버로 점프하면 스택 상태가 오염된다. 두 단계 구조는 이 정리 작업의 필요성에서 나온 설계다.

최종적으로 `updateSuspenseComponent`가 호출될 때, 이 함수는 `DidCapture` 플래그를 확인하여 fallback을 렌더할지 primary 콘텐츠를 렌더할지 결정한다. 그리고 이 플래그를 소비(`&= ~DidCapture`)한다. 플래그는 한 번 읽히고 사라진다.

---

## Promise와 Error: 같은 입구, 다른 목적지

`throwException` 함수는 두 종류의 throw를 처리한다. value가 `.then` 메서드를 가진 객체(Wakeable)이면 Suspense 경로로, 그렇지 않으면 Error Boundary 경로로 분기한다.

Suspense 경로에서 React가 하는 일은 두 가지다. 첫 번째는 가장 가까운 `SuspenseComponent` 파이버를 찾아 `ShouldCapture` 플래그를 설정하는 것이고, 두 번째는 Promise가 resolve됐을 때 재렌더를 트리거할 리스너를 등록하는 것이다.

흥미로운 것은 이 리스너가 두 종류라는 점이다. **Ping Listener**는 렌더 단계에서 등록된다. Promise가 resolve되면 `pingSuspendedRoot`가 호출되어 루트 전체를 재스케줄링한다. 이것은 "Promise가 해소됐으니 이 우선순위 레인을 다시 시작하라"는 신호다. **Retry Listener**는 커밋 단계에서 등록된다. fallback UI가 실제로 DOM에 그려진 이후, `attachSuspenseRetryListeners`가 Promise에 retry 함수를 바인딩한다. Promise가 resolve되면 `resolveRetryWakeable`이 호출되어 해당 Suspense 경계만 재렌더를 요청한다.

두 리스너가 동시에 존재하는 이유는 타이밍의 문제다. Ping Listener는 렌더가 진행되는 동안 Promise가 resolve됐을 때 빠르게 반응하기 위한 것이고, Retry Listener는 fallback이 커밋된 이후의 정상적인 재시도 경로다. 중복 재렌더를 방지하기 위해 각 리스너는 자신의 캐시에서 wakeable을 삭제한 후 동작한다.

Error Boundary 경로는 더 단순하다. 파이버 트리를 위쪽으로 순회하면서 `getDerivedStateFromError`나 `componentDidCatch`를 구현한 ClassComponent, 또는 HostRoot를 찾는다. 찾으면 `ShouldCapture` 플래그를 설정하고 `CaptureUpdate`를 해당 파이버의 업데이트 큐에 넣는다. 이 업데이트는 이후 `processUpdateQueue`에서 처리되어 에러 상태로의 전환을 일으킨다.

---

## OffscreenComponent: 사라지지 않는 Primary 트리

React Suspense의 가장 중요한 설계 결정 중 하나는 fallback을 표시할 때 primary 콘텐츠를 버리지 않는다는 것이다.

fallback이 표시될 때, React는 primary 자식들을 `OffscreenComponent`(내부 tag=22)로 감싸서 `mode='hidden'` 상태로 유지한다. DOM에서는 보이지 않지만 파이버 트리에는 살아있다. 이 파이버의 `memoizedState`에는 `baseLanes`, `cachePool`, `transitions` 등의 정보가 담긴다. Promise가 resolve되면 React는 새로운 primary 트리를 처음부터 만들 필요 없이, 기존 OffscreenFiber를 `mode='visible'`로 전환하고 재렌더만 수행한다.

이것은 단순한 최적화가 아니다. Transitions와 함께 생각하면 의미가 더 깊어진다. 사용자가 페이지를 전환할 때 React는 현재 화면을 유지하면서 배경에서 새 화면을 준비할 수 있다. 이것이 가능한 이유는 두 상태의 파이버 트리가 동시에 메모리에 존재할 수 있기 때문이다.

SuspenseComponent의 `memoizedState`는 `SUSPENDED_MARKER`라는 고정된 객체다. 이 객체가 있으면 현재 fallback을 표시 중이고, `null`이면 primary를 표시 중이다. Promise가 resolve되어 primary로 전환될 때, React는 이 `memoizedState`를 `null`로 설정하고 OffscreenFiber를 `mode='visible'`로 바꾸면서 `SUSPENDED_MARKER`를 제거한다.

---

## Error Boundary가 ClassComponent인 이유

Error Boundary가 클래스 컴포넌트만 될 수 있다는 제약은 종종 불편함으로 여겨지지만, 이는 필요에서 나온 설계다.

`createClassErrorUpdate`가 생성하는 `CaptureUpdate`의 payload는 함수다. 이 함수가 `processUpdateQueue`에서 호출될 때 `getDerivedStateFromError(error)`의 반환값을 새 상태로 사용한다. 이것은 에러를 상태 전환의 입력으로 사용하는 패턴이다.

`componentDidCatch`는 커밋 단계에서 호출된다. 이 메서드는 컴포넌트 인스턴스(`this`)를 통해 호출되어야 하므로, 인스턴스를 가진 클래스 컴포넌트가 필요하다. 함수 컴포넌트는 렌더마다 새로운 실행 컨텍스트를 가지므로 "이전 에러 상태"를 보유하기 어렵다.

루트까지 전파된 에러는 다르게 처리된다. `createRootErrorUpdate`는 `{ element: null }`을 payload로 가지는 업데이트를 생성한다. 즉, 아무것도 잡지 못한 에러는 앱 전체를 언마운트한다. 개발 환경에서 친숙한 "A component suspended while responding to synchronous input..." 같은 에러 메시지는 이 경로에서 출력된다.

한 가지 주목할 만한 세부 사항이 있다. `isAlreadyFailedLegacyErrorBoundary` 체크다. 동일한 ErrorBoundary가 이미 한 번 실패했다면, 같은 경계가 같은 에러를 다시 포착하지 않는다. 이것은 에러 루프를 방지하기 위한 보호 장치다. ErrorBoundary의 `render` 메서드 자체가 throw하면 그 에러는 부모 ErrorBoundary로 전파된다.

---

## 렌더 종료 상태: 6가지 결말

React의 렌더 루프는 여섯 가지 방식으로 끝날 수 있다. 이 상태들을 이해하면 Suspense와 ErrorBoundary가 전체 스케줄링 시스템과 어떻게 통합되는지 보인다.

가장 단순한 결말은 `RootCompleted`다. 모든 작업이 정상적으로 완료된 상태다. `RootSuspended`는 Suspense 경계가 포착에 성공했을 때다. fallback을 커밋할 준비가 된 상태다. `RootSuspendedWithDelay`는 Transition과 같은 지연 허용 시나리오에서 발생한다. React는 더 오래 기다려서 불필요한 로딩 상태 전환을 줄이려 한다.

`RootErrored`는 Error Boundary가 포착에 성공했을 때다. 에러 UI로 재렌더가 예약된다. `RootFatalErrored`는 루트까지 에러가 전파됐을 때, 즉 ErrorBoundary가 하나도 없거나 모두 실패한 경우다. `RootDidNotComplete`는 렌더가 중단됐을 때(yield)로, 우선순위가 더 높은 작업이 있어서 나중에 재시도한다.

이 여섯 상태의 중요성은 `pingSuspendedRoot`에서 잘 드러난다. Promise가 resolve될 때 React는 현재 렌더 상태를 확인한다. `RootSuspendedWithDelay` 상태였다면 즉시 `prepareFreshStack`을 호출해 루트부터 재시작한다. 단순한 `RootSuspended`라면 `workInProgressRootPingedLanes`에 기록하여 나중에 처리한다. 같은 Promise resolve 이벤트도 렌더 상태에 따라 다르게 반응하는 것이다.

---

## Concurrent Mode와 Legacy Mode의 차이

Concurrent Mode는 React 18의 핵심 기능이지만, Suspense 처리에서 Legacy Mode와의 차이는 미묘하면서도 중요하다.

Ping Listener는 Concurrent Mode에서만 등록된다. Legacy Mode에서는 동기적으로 즉시 커밋하기 때문에, 렌더 도중 Promise resolve를 기다릴 필요가 없다. 렌더가 시작되고 fallback이 결정되면 바로 커밋한다.

`ShouldCapture` 플래그 처리도 다르다. Concurrent Mode에서는 `throwException`이 `ShouldCapture`를 설정하고 `unwindWork`에서 `DidCapture`로 전환한다. Legacy Mode에서는 일부 경로에서 `ShouldCapture` 없이 직접 `DidCapture`를 설정한다. 이것은 Legacy Mode가 단계적 처리보다 즉각적인 반응을 선호하기 때문이다.

`RootSuspendedWithDelay` 상태는 Concurrent Mode 전용이다. Transition을 사용하면 React는 이미 표시된 콘텐츠를 숨기는 것을 피하려 한다. 이를 위해 렌더를 즉시 커밋하지 않고 더 기다린다. Legacy Mode에는 이런 개념이 없다.

---

## updateQueue의 이중 생활

React 코드를 읽다 보면 `updateQueue`라는 필드가 컴포넌트 타입에 따라 완전히 다른 구조를 가진다는 것을 발견한다.

ClassComponent에서 `updateQueue`는 상태 업데이트들의 링크드 리스트다. `setState`, `forceUpdate` 등이 이 리스트에 쌓이고, `processUpdateQueue`가 이를 순차적으로 처리한다.

그런데 SuspenseComponent에서 `updateQueue`는 `Set<Wakeable>`이다. `attachRetryListener`가 이 Set에 Promise를 추가하고, 커밋 단계에서 `attachSuspenseRetryListeners`가 이 Set을 순회하며 retry 함수를 바인딩한다.

같은 필드 이름이 완전히 다른 자료구조로 사용된다. 이것은 React의 파이버 구조가 메모리 효율을 위해 필드를 재사용하는 패턴을 따르기 때문이다. `stateNode`도 마찬가지다. ClassComponent에서는 컴포넌트 인스턴스지만, SuspenseComponent에서는 `WeakSet<Wakeable>` 형태의 retry 캐시다. 이 재사용 패턴은 React 파이버 코드를 처음 읽을 때 종종 혼란을 준다.

---

## 설계의 일관성

```
컴포넌트 throw (Promise | Error)
  └─ workLoop catch → handleError
       └─ throwException: 경계 탐색 + 플래그 설정 + 리스너 등록
            └─ completeUnitOfWork → unwindWork: 스택 정리 + DidCapture 전환
                 └─ 경계 파이버로 재시작 → updateSuspenseComponent / updateClassComponent
```

이 흐름에서 핵심은 단순함이다.

위의 흐름도에서 볼 수 있듯이, React는 컴포넌트가 무엇을 throw하든 동일한 파이프라인을 통과시킨다. 차이는 `throwException` 내부의 분기뿐이다. 이 통일성은 우연이 아니다. React 팀은 "비동기 대기"와 "에러 복구"를 개념적으로 동일한 문제로 봤다. 둘 다 "현재 컴포넌트가 렌더를 완료할 수 없다"는 신호이고, 둘 다 "가장 가까운 처리 경계를 찾아 위임한다"는 해결책을 가진다.

이 설계는 미래 확장성도 고려한다. 새로운 종류의 비동기 동작이 필요하다면, 새로운 타입의 값을 throw하는 것만으로 통합할 수 있다. Wakeable 인터페이스를 구현한다면 어떤 객체든 Suspense 메커니즘을 활용할 수 있다. React의 캐싱 라이브러리들이 이 패턴을 따르는 것은 그래서다.

---

## 마치며: 철학이 구현을 결정한다

React Suspense와 ErrorBoundary를 이해하는 데 있어 가장 중요한 통찰은 기술적 세부사항이 아니다. "throw는 에러를 알리는 것이 아니라 제어를 위임하는 방법"이라는 설계 철학이다.

이 철학에서 모든 구현 결정이 따라온다. workLoop가 `do-while`로 감싸진 이유, 두 단계 플래그(ShouldCapture/DidCapture)가 존재하는 이유, OffscreenComponent가 primary 트리를 보존하는 이유, Ping과 Retry 두 리스너가 분리된 이유 — 이 모두가 "throw는 렌더를 중단하는 게 아니라 재개 지점을 변경한다"는 원칙의 구현이다.

소스 코드의 복잡성은 이 단순한 철학이 실제 프로덕션 환경의 수많은 엣지 케이스(Legacy/Concurrent 모드, Hydration, Transition, Profiler 등)를 처리하면서 누적된 것이다. 핵심 아이디어는 놀라울 만큼 간결하다.