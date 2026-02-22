---
title: "React Hooks 시스템: 상태는 클로저가 아니라 연결 리스트에 산다"
date: "2025-02-20"
tags: [React, Hooks, Architecture, Fiber, Concurrent Mode]
series: "React 아키텍처 심층 분석"
---

> **React 아키텍처 심층 분석** 시리즈의 세 번째 글입니다. [2편](react-architecture-02-fiber-architecture.md)에서는 Fiber가 렌더링 작업을 중단·재개 가능한 단위로 쪼개는 방식을 추적했습니다. 이번 편에서는 그 Fiber 위에 구축된 **Hooks 시스템**의 내부 작동 원리를 해부합니다.

---

## 1. Hook은 왜 태어났는가: 클래스 컴포넌트의 세 가지 결함

기술은 문제를 해결하기 위해 탄생합니다. Hooks(2019년, React 16.8)도 예외가 아닙니다. 이것이 단순한 편의 기능이 아니라 React 아키텍처의 근본적인 전환점인 이유를 이해하려면, 먼저 이전 세계의 고통을 직시해야 합니다.

### 논리의 분산: 생명주기 메서드의 역설

클래스 컴포넌트의 생명주기 메서드는 표면적으로 질서정연해 보입니다. `componentDidMount`에서 설정하고, `componentWillUnmount`에서 정리한다. 논리적으로 완벽해 보이는 이 구조가 왜 문제가 되는 걸까요?

문제는 "언제" 기준이 아니라 "무엇" 기준으로 코드를 묶어야 한다는 데 있습니다. 예를 들어 하나의 컴포넌트가 사용자 구독 설정, 데이터 페칭, 문서 타이틀 변경을 모두 담당한다면, 이 세 가지 논리는 각각 `componentDidMount`, `componentDidUpdate`, `componentWillUnmount` 전체에 걸쳐 파편화됩니다. 관련 없는 코드가 같은 메서드 안에 뒤섞이고, 관련 있는 코드는 세 개의 메서드로 분리됩니다. 컴포넌트가 커질수록 이 역설은 심화됩니다.

### 재사용 불가: Wrapper Hell

상태 로직을 재사용하려면 Higher-Order Component(HOC) 패턴이나 Render Props 패턴을 사용해야 했습니다. 두 패턴 모두 컴포넌트를 겹겹이 감싸는 방식으로 동작합니다. 이 구조는 "Wrapper Hell"이라고 불리는데, React DevTools에서 보면 실제 로직과 무관한 래퍼 컴포넌트들이 10~20겹으로 쌓인 트리를 마주하게 됩니다. 렌더링 성능, 디버깅 경험, 코드 가독성 모두 타격을 입습니다.

### this 바인딩: 우발적 복잡성

`this`는 JavaScript의 언어적 개념이지 React의 개념이 아닙니다. 클래스 기반 컴포넌트가 React에 도입되면서 개발자들은 `this.handleClick.bind(this)`, 화살표 함수 클래스 필드 등 다양한 우회책을 익혀야 했습니다. 이는 React가 해결해야 할 도메인 문제가 아닌데도 인지적 부담이 됐습니다.

### Hooks의 해결책: 관심사의 응집

Hooks는 "언제" 대신 "무엇"을 기준으로 코드를 묶을 수 있게 합니다. 사용자 구독에 관련된 설정, 업데이트, 정리 로직을 모두 하나의 `useEffect` 안에 담을 수 있습니다. 재사용은 함수 호출로 가능하고, `this`는 존재하지 않습니다. 그런데 이 우아한 설계는 어떻게 실제로 동작할까요?

---

## 2. Hook의 정체: Fiber에 붙은 연결 리스트

Hooks를 처음 배울 때 많은 개발자들이 "클로저 기반의 상태 관리"라고 이해합니다. 함수 컴포넌트가 실행될 때마다 새로운 스코프가 생기고, 상태가 그 클로저 어딘가에 캡처된다는 직관입니다. 이 직관은 틀렸습니다.

Hook의 상태는 **컴포넌트 함수 자체가 아니라, 해당 컴포넌트를 표현하는 Fiber 노드에 저장됩니다.** 구체적으로는 `Fiber.memoizedState` 프로퍼티에 연결 리스트(linked list) 형태로 붙어있습니다.

각 Hook은 다음 구조를 가진 노드 하나에 대응합니다: 현재 저장된 값(`memoizedState`), 업데이트 계산의 기준이 되는 상태(`baseState`), 이전 렌더에서 우선순위 문제로 건너뛴 업데이트들(`baseQueue`), 새로 들어온 업데이트들을 담는 큐(`queue`), 다음 Hook 노드를 가리키는 포인터(`next`). 이 노드들이 `next`로 연결되어 하나의 체인을 이룹니다.

컴포넌트 안에서 `useState`, `useEffect`, `useMemo`를 차례로 호출하면, Fiber.memoizedState는 그 순서 그대로 연결된 세 개의 Hook 노드를 가지게 됩니다. Hook이 호출 순서를 엄격하게 지켜야 하는 이유가 여기에 있습니다. 순서가 바뀌면 React는 각 Hook 노드가 어떤 `useState`나 `useEffect`와 대응하는지 알 수 없게 됩니다.

각 Hook 종류마다 `memoizedState`에 저장하는 값이 다릅니다. `useState`와 `useReducer`는 현재 상태 값 자체를, `useEffect`는 effect 함수와 cleanup 함수, 의존성 배열을 담은 Effect 객체를, `useMemo`는 계산된 값과 deps 배열의 쌍을, `useRef`는 `{ current: value }` 객체를 저장합니다. 하나의 자료구조 안에서 이렇게 다양한 역할을 표현하는 것이 Hook 시스템의 유연성이자, 타입 안전성을 직접 보장하기 어려운 이유이기도 합니다.

---

## 3. Dispatcher 패턴: 같은 코드, 다른 실행

`useState`를 호출하면 React 내부에서 무슨 일이 일어날까요? 단순히 상태를 읽는 것이 아닙니다. **컴포넌트가 처음 마운트되는 중인지, 재렌더 중인지에 따라 완전히 다른 구현이 실행됩니다.**

React는 이를 Dispatcher 패턴으로 구현합니다. `ReactCurrentDispatcher.current`라는 전역 포인터가 있고, 렌더 시점마다 이 포인터를 다른 객체로 교체합니다. 개발자가 `useState`를 호출하면, 실제로는 이 포인터가 가리키는 객체의 `useState`가 실행됩니다.

마운트 시에는 `HooksDispatcherOnMount`가 활성화되고, 여기서 `useState`는 새 Hook 노드를 생성하고 초기값을 설정합니다. 재렌더 시에는 `HooksDispatcherOnUpdate`로 교체되고, 동일한 `useState` 호출이 이번에는 기존 Hook 노드에서 저장된 상태를 읽고 업데이트를 처리합니다.

렌더가 끝나면 Dispatcher는 즉시 `ContextOnlyDispatcher`로 복귀합니다. 이 Dispatcher의 모든 Hook은 에러를 던집니다. 이것이 `useEffect` 콜백 안에서 `useState`를 호출하면 "Invalid hook call" 에러가 발생하는 이유입니다. useEffect 콜백은 렌더가 완료된 후 비동기적으로 실행되므로, 그 시점의 Dispatcher는 이미 에러를 던지는 상태입니다.

이 설계는 단일 진입점(`useState`)을 유지하면서 런타임 컨텍스트에 따라 구현을 교체하는 전략입니다. 개발자가 마운트인지 업데이트인지 신경 쓸 필요가 없는 이유가 여기에 있습니다.

---

## 4. renderWithHooks: 함수 컴포넌트의 진입점

Fiber 재조정 과정에서 함수 컴포넌트를 처리할 때 `renderWithHooks`가 호출됩니다. 이 함수가 Hook 시스템 전체의 출발점이자 환경 설정자입니다.

이 함수가 하는 일을 순서대로 보면: 먼저 `workInProgress.memoizedState`를 null로 초기화합니다(새 Hook 체인을 처음부터 다시 만들 준비). 그런 다음 현재 상황에 맞는 Dispatcher를 설정합니다. 그 후 컴포넌트 함수를 실행합니다 — 이 실행 과정에서 개발자가 작성한 모든 Hook 호출이 일어납니다. 컴포넌트가 렌더 중에 `setState`를 호출했다면(파생 상태 패턴 등), 최대 25회까지 재실행을 반복합니다. 마지막으로 Dispatcher를 `ContextOnlyDispatcher`로 복귀시킵니다.

25회 재실행 한도는 `RE_RENDER_LIMIT = 25`로 정의되어 있습니다. 이 한도를 초과하면 "Too many re-renders" 에러가 발생합니다. 이 숫자는 임의적으로 보이지만, 대부분의 합법적인 파생 상태 계산은 훨씬 적은 횟수 안에 수렴하므로 실용적인 안전망입니다.

---

## 5. 새 Hook vs 기존 Hook: 마운트와 업데이트의 분기

Hook 노드를 다루는 두 함수가 Hook 시스템의 핵심 메커니즘을 담고 있습니다.

마운트 시 `mountWorkInProgressHook`은 새 Hook 노드 객체를 생성하고 이를 Fiber의 `memoizedState` 체인 끝에 연결합니다. 처음 Hook이라면 Fiber.memoizedState에 직접 연결하고, 이후 Hook이라면 체인의 끝에 이어붙입니다. 이 과정에서 Hook 순서가 Fiber에 기록됩니다.

업데이트 시 `updateWorkInProgressHook`은 전혀 다른 일을 합니다. 이전 렌더의 Hook 체인(current Fiber의 `memoizedState`)에서 대응하는 노드를 찾아 복제합니다. 이때 `queue` 프로퍼티는 복제되지 않고 **동일한 참조를 공유**합니다. 이 큐가 `setState`가 호출될 때 업데이트가 쌓이는 곳이기 때문입니다. current 트리와 work-in-progress 트리가 같은 큐를 바라보고 있어야, 렌더 도중 발생한 업데이트가 유실되지 않습니다.

이 과정에서 Hook 개수가 맞지 않으면 에러가 발생합니다. 이전 렌더보다 Hook이 많으면 "Rendered more hooks than during the previous render", 적으면 "Rendered fewer hooks than expected". Rules of Hooks가 실제로 강제되는 순간입니다.

---

## 6. useState와 useReducer: 실은 하나다

`useState`는 `useReducer`의 특수한 형태입니다. 내부 구현에서 두 Hook은 모두 `updateReducer`라는 동일한 함수로 합류합니다. 차이는 사용되는 reducer 함수뿐입니다.

`useState`의 경우 React가 내장한 `basicStateReducer`를 사용합니다. 이 reducer는 단순한 규칙을 따릅니다: 액션이 함수이면 그 함수를 현재 상태에 적용하고(함수형 업데이트), 함수가 아니면 그 값 자체를 새 상태로 사용합니다. 이것이 `setState(42)`와 `setState(prev => prev + 1)` 두 형태를 모두 지원하는 이유입니다.

`useReducer`는 이 자리에 개발자가 정의한 reducer 함수를 넣습니다. 복잡한 상태 전환 로직, 여러 액션 타입 처리, 이전 상태를 참조하는 계산이 필요할 때 `useReducer`가 더 명시적인 선택이 되는 이유가 여기에 있습니다.

마운트 시 `mountState`는 초기값을 설정하고 업데이트 큐를 생성합니다. 주목할 점은 `initialState`가 함수인 경우 즉시 실행한다는 것입니다. 이것이 lazy initialization 기능입니다 — 비용이 큰 초기값 계산을 컴포넌트가 처음 마운트될 때 한 번만 실행하도록 최적화합니다.

---

## 7. dispatchSetState: setState가 호출될 때 실제로 일어나는 일

`const [count, setCount] = useState(0)`에서 반환되는 `setCount`는 `dispatchSetState`를 현재 Fiber와 업데이트 큐에 미리 바인딩한 함수입니다. `setCount(5)`를 호출하면 내부적으로 `dispatchSetState(fiber, queue, 5)`가 실행됩니다.

이 함수가 가장 먼저 하는 일은 현재 컨텍스트의 우선순위 Lane을 결정하는 것입니다. 같은 `setCount` 호출이라도 버튼 클릭 이벤트 핸들러 안에서 실행되면 높은 우선순위의 `InputDiscreteLane`을, `startTransition` 안에서 실행되면 낮은 우선순위의 `TransitionLane`을, `setTimeout` 안에서 실행되면 중간 우선순위의 `DefaultLane`을 받습니다. 이 Lane이 나중에 해당 업데이트가 어떤 렌더 사이클에서 처리될지를 결정합니다.

그 다음 **Eager State 최적화**가 이루어집니다. 이것은 React가 렌더링 자체를 건너뛸 수 있는 가장 이른 시점의 최적화입니다. 현재 Fiber와 그 alternate에 대기 중인 업데이트가 없다면, React는 새 상태를 미리 계산해봅니다. 그 결과가 현재 상태와 동일하다면(`Object.is` 기준) 스케줄링 자체를 중단합니다. Fiber Reconciler가 깨어나지 않습니다.

```javascript
// 이 시점에서 이미 렌더링 스킵 여부가 결정됩니다
const eagerState = lastRenderedReducer(currentState, action);
if (is(eagerState, currentState)) {
  return; // scheduleUpdateOnFiber가 호출되지 않음
}
```

이 코드에서 핵심은 `return`입니다. 이 한 줄이 불필요한 렌더링 사이클 전체를 방지합니다. 이것이 `setState(sameValue)`가 리렌더를 유발하지 않는 정확한 이유이고, 동시에 `setState({})` 처럼 내용은 같지만 참조가 다른 객체를 전달하면 리렌더가 발생하는 이유입니다. `Object.is`는 참조를 비교하기 때문입니다.

---

## 8. updateReducer: 우선순위별 업데이트 필터링

렌더가 시작되면 `updateReducer`가 Hook의 업데이트 큐를 처리합니다. 이 과정은 단순한 큐 드레이닝이 아닙니다. **현재 렌더의 우선순위(Lane)에 따라 처리할 업데이트와 보류할 업데이트를 선별합니다.**

업데이트 큐는 원형 연결 리스트로 구성됩니다. `updateReducer`는 이 리스트를 순회하며 각 업데이트의 Lane이 현재 렌더의 `renderLanes`에 포함되는지 확인합니다. 포함된다면 그 업데이트를 처리하고, 포함되지 않는다면 `baseQueue`에 보존하고 해당 Lane을 Fiber에 표시해 다음 렌더에서 재처리되도록 예약합니다.

이 메커니즘이 가진 섬세한 요구사항이 하나 있습니다. 만약 낮은 우선순위 업데이트를 건너뛴 후 높은 우선순위 업데이트를 처리한다면, 이후의 모든 업데이트도 `baseQueue`에 포함시켜야 합니다. 상태 전환의 순서가 중요하기 때문입니다. 예를 들어 업데이트가 A, B, C 순서로 들어왔고 B를 건너뛰었다면, C는 처리되더라도 `baseQueue`에도 남겨둡니다. 다음 렌더에서 `baseState`에서 시작해 B, C를 순서대로 적용해야 최종 상태의 일관성이 보장됩니다.

이 복잡성이 Concurrent Mode에서 상태 업데이트의 일관성을 보장하는 기반입니다.

---

## 9. useEffect의 내부: 원형 연결 리스트의 이유

`useEffect`는 상태를 저장하는 대신, **Effect 객체를 Fiber의 `updateQueue`에 원형 연결 리스트로 등록합니다.** 각 Effect 객체는 실행할 함수(`create`), cleanup 함수(`destroy`), 의존성 배열(`deps`), 그리고 비트마스크 플래그(`tag`)를 담고 있습니다.

왜 원형 연결 리스트일까요? 커밋 단계에서 Effect를 순회할 때 `lastEffect.next`로 시작점에 접근하고, 한 바퀴를 돌면 다시 시작점으로 돌아오기 때문에 별도의 길이 추적이나 끝 표시가 필요 없습니다. 구조가 단순하고 순회 코드가 균일해집니다.

비트마스크 플래그는 Effect의 종류를 구분합니다. `useEffect`는 Passive 비트(0b1000)를, `useLayoutEffect`는 Layout 비트(0b0100)를, `useInsertionEffect`는 Insertion 비트(0b0010)를 가집니다. 의존성이 변경된 Effect에는 추가로 HasEffect 비트(0b0001)가 설정됩니다. 커밋 단계에서는 이 비트마스크로 필터링하여 실행할 Effect를 선별합니다.

중요한 통찰이 하나 있습니다. **의존성이 변경되지 않은 Effect도 원형 리스트에는 등록됩니다.** 단지 HasEffect 비트가 없을 뿐입니다. 커밋 단계는 이 비트를 보고 실행 여부를 결정합니다. 이 설계 덕분에 커밋 단계는 Effect 존재 여부와 실행 여부를 독립적으로 추적할 수 있습니다.

`updateEffectImpl`은 deps가 변경되지 않았을 때도 이전 cleanup 함수를 새 Effect 노드에 그대로 전달합니다. 이것이 중요한 이유는 deps가 변경되지 않더라도 컴포넌트가 언마운트될 때 cleanup이 실행되어야 하기 때문입니다. cleanup 함수의 참조를 항상 최신 Effect 노드에 보존함으로써 이 케이스를 처리합니다.

---

## 10. Effect 실행 타이밍: 세 개의 층

React는 세 종류의 Effect를 서로 다른 타이밍에 실행합니다. 이 구분은 성능과 정확성 사이의 의도적인 트레이드오프입니다.

**useInsertionEffect**는 DOM이 실제로 변경되기 전에 실행됩니다. CSS-in-JS 라이브러리(styled-components, emotion)가 스타일을 주입하는 용도입니다. DOM 변경 전에 스타일이 삽입되어야, 이후 `useLayoutEffect`에서 `getBoundingClientRect()` 같은 API를 호출할 때 올바른 레이아웃 정보를 얻을 수 있습니다. ref도 아직 연결되기 전이므로, DOM 노드에 직접 접근해서는 안 됩니다.

**useLayoutEffect**는 DOM 변경이 완료된 후, 브라우저가 화면을 그리기(paint) 전에 동기적으로 실행됩니다. DOM을 읽거나 변경하는 작업에 적합합니다. 예를 들어 특정 요소의 크기를 측정하고 그 결과로 다른 요소를 조정하는 경우, 브라우저가 중간 상태를 그리기 전에 처리해야 깜빡임이 발생하지 않습니다. 하지만 동기 실행이므로 무거운 작업을 여기서 하면 렌더링이 블로킹됩니다.

**useEffect**는 브라우저가 화면을 그린 후, MessageChannel을 통해 비동기적으로 실행됩니다. 네트워크 요청, 이벤트 구독, 외부 라이브러리 초기화처럼 DOM과 무관하거나 즉각적인 반영이 필요 없는 작업에 적합합니다. 가장 나중에 실행되므로 사용자는 Effect가 실행되기 전에 이미 업데이트된 UI를 볼 수 있습니다.

커밋 단계에서 Effect는 전체 트리의 cleanup을 먼저 실행하고, 그 다음 전체 트리의 create를 실행합니다. A의 cleanup → B의 cleanup → A의 create → B의 create 순서입니다. 이 순서가 중요한 이유는 A의 create가 B의 cleanup이 완료된 상태를 전제할 수 있기 때문입니다. 예를 들어 B가 공유 리소스를 해제한 후 A가 그 리소스를 다시 획득하는 시나리오가 안전하게 동작합니다.

---

## 11. Passive Effects와 MessageChannel

React 16에서 18로 오면서 `useEffect`의 비동기 스케줄링 방식이 `requestAnimationFrame`에서 **MessageChannel**로 전환됐습니다. 이 변화는 중요한 의미를 가집니다.

`requestAnimationFrame`은 브라우저의 프레임 렌더링 사이클에 연동됩니다. 모니터 주사율에 따라 16.7ms(60fps) 또는 8.3ms(120fps) 간격으로 실행됩니다. 반면 MessageChannel은 단순히 현재 태스크를 완료한 후 다음 마이크로태스크 이후에 실행됩니다. 이 차이로 인해 Passive Effects가 더 예측 가능한 타이밍에 실행되고, 프레임 경계에 묶이지 않아 고주사율 디스플레이에서도 일관된 동작을 보장합니다.

커밋 단계가 끝나면 React는 `scheduleCallback(NormalSchedulerPriority, flushPassiveEffects)`를 호출합니다. 이 호출이 MessageChannel을 통해 비동기로 예약됩니다. 브라우저가 페인트를 완료하고, 이벤트 루프가 현재 태스크를 마친 후, 비로소 `flushPassiveEffects`가 실행되어 useEffect의 cleanup과 create가 순서대로 진행됩니다.

---

## 12. Strict Mode의 Effect 이중 실행: 버그 조기 감지 장치

개발 모드의 Strict Mode는 컴포넌트를 두 번 렌더한다는 사실은 널리 알려져 있습니다. 덜 알려진 사실은 **Effect도 두 번 실행한다는 것**입니다: create → cleanup → create 순서로.

이 동작의 목적은 cleanup 함수의 완결성을 강제하는 것입니다. cleanup 없이 EventSource나 WebSocket을 생성하면, 두 번째 create에서 두 개의 연결이 만들어집니다. 이 버그가 개발 단계에서 즉시 드러납니다. cleanup이 제대로 구현된 Effect는 이중 실행 후에도 정확히 하나의 연결만 존재합니다.

이것은 React가 "cleanup은 선택사항이 아니라 Effect의 필수 구성요소"라는 철학을 코드로 표현하는 방식입니다. cleanup 없는 Effect를 작성하는 순간 Strict Mode가 경고를 보냅니다.

---

## 13. useMemo와 useCallback: 메모이제이션의 실체

`useMemo`와 `useCallback`은 놀랍도록 단순한 구현을 가지고 있습니다. 각 Hook은 `memoizedState`에 `[값, deps]` 쌍을 저장합니다. 재렌더 시 현재 deps를 이전 deps와 `Object.is`로 비교합니다. 동일하다면 저장된 값을 반환하고, 다르다면 새로 계산하여 저장합니다.

두 Hook의 유일한 차이는 무엇을 저장하느냐입니다. `useMemo`는 팩토리 함수의 실행 결과를, `useCallback`은 함수 자체를 저장합니다. 따라서 `useCallback(fn, deps)`는 `useMemo(() => fn, deps)`와 동일합니다.

메모이제이션이 실패하는 가장 흔한 패턴은 deps에 객체나 배열을 직접 넣는 것입니다. `Object.is`는 참조를 비교하므로, 매 렌더마다 새로 생성되는 객체는 내용이 동일해도 "다른 것"으로 판단합니다. 메모이제이션이 의미를 가지려면 deps에 원시값(string, number, boolean)이나 렌더 간 참조가 유지되는 값이 들어가야 합니다.

또한 `useMemo`는 메모리를 희생해 계산을 피하는 트레이드오프입니다. 모든 값에 무조건 적용하는 것은 오히려 메모리 압박을 늘리고 코드 가독성을 해칩니다. 실제로 비용이 큰 계산이거나, 참조 동일성이 하위 컴포넌트의 렌더를 방지하는 데 필요한 경우에 사용하는 것이 적절합니다.

---

## 14. useRef: 가장 단순하지만 가장 강력한 설계

`useRef`의 구현은 Hook 시스템에서 가장 단순합니다. 마운트 시 `{ current: initialValue }` 객체를 생성해 저장합니다. 업데이트 시에는 `initialValue`를 완전히 무시하고 최초에 생성한 객체를 그대로 반환합니다.

이 단순성이 강력함의 근원입니다. `useRef`가 반환하는 객체는 컴포넌트의 생애 동안 동일한 참조를 유지합니다. React가 상태 변경을 감지하거나 리렌더를 유발하는 메커니즘과 완전히 분리되어 있습니다. `ref.current`에 어떤 값을 저장하든 React는 알지 못하고, 따라서 리렌더를 유발하지 않습니다.

커밋 단계에서 DOM ref의 경우, React는 `commitAttachRef`를 통해 `ref.current`에 실제 DOM 노드를 설정합니다. Callback ref라면 함수를 직접 호출합니다. 언마운트 시에는 `ref.current = null`로 초기화합니다. 이 타이밍이 `useLayoutEffect`와 동일한 Layout 단계여서, `useLayoutEffect` 안에서 ref에 안전하게 접근할 수 있습니다.

---

## 15. Rules of Hooks: 제약의 이유

Hooks의 두 가지 규칙—최상위 레벨에서만 호출, 함수 컴포넌트(또는 custom Hook) 안에서만 호출—은 단순한 관례가 아닙니다. 앞서 살펴본 Hook 연결 리스트 구조에서 직접 도출되는 물리적 제약입니다.

Hook 연결 리스트는 순서에 의존합니다. React는 "n번째 Hook은 무조건 이전 렌더의 n번째 Hook과 같은 것"이라고 가정합니다. 이름을 저장하지 않으니, 순서가 유일한 식별자입니다. 조건문이나 반복문 안에서 Hook을 호출하면 렌더마다 Hook의 개수와 순서가 달라질 수 있어, 각 Hook 노드에서 읽어오는 데이터가 뒤섞입니다.

개발 모드에서 React는 이를 런타임에도 감지합니다. 마운트 시 각 Hook의 이름을 순서대로 기록해두고, 이후 렌더에서 같은 위치에서 다른 Hook이 호출되면 경고를 출력합니다. Hook 개수가 줄면 "Rendered fewer hooks than expected", 늘면 "Rendered more hooks than during the previous render" 에러가 발생합니다.

두 번째 규칙—함수 컴포넌트 안에서만 호출—은 Dispatcher 패턴으로 강제됩니다. 렌더 밖에서는 Dispatcher가 에러를 던지는 `ContextOnlyDispatcher`이므로, 어떤 Hook을 호출해도 즉시 에러가 발생합니다.

`eslint-plugin-react-hooks`는 이 규칙들을 컴파일 타임에 정적 분석으로 감지합니다. 런타임 에러를 기다릴 필요 없이 코드를 작성하는 시점에 위반을 잡아줍니다.

---

## 16. Concurrent Mode와 Tearing: useSyncExternalStore의 필요성

Concurrent Mode의 핵심 특성은 렌더가 중단될 수 있다는 것입니다. 이 특성이 외부 스토어(Redux, Zustand 등)와 결합되면 **Tearing** 문제가 발생합니다.

비유로 설명하면 이렇습니다. 책을 읽는 도중 누군가가 몰래 페이지를 바꿔치기 합니다. 앞부분은 바뀌기 전의 내용을, 뒷부분은 바뀐 후의 내용을 읽게 됩니다. 일관성이 깨진 책이 됩니다.

Concurrent 렌더링에서 이 상황이 발생하면: 컴포넌트 A를 렌더하면서 스토어 값 10을 읽습니다. 렌더가 중단됩니다. 그 사이 외부에서 스토어 값이 20으로 변경됩니다. 렌더가 재개되면 컴포넌트 B는 값 20을 읽습니다. 화면에는 A는 10, B는 20이 표시됩니다. 같은 렌더 사이클에서 서로 다른 시점의 스토어 값을 반영한 UI가 그려집니다.

`useSyncExternalStore`는 이를 해결하는 공식 API입니다. 핵심 메커니즘은 커밋 직전의 일관성 검사입니다. 렌더가 완료되고 DOM에 커밋하기 직전, 렌더 중에 읽었던 스냅샷이 여전히 최신인지 확인합니다. 변경되었다면 동기적으로 재렌더를 트리거합니다. 이 검사가 Tearing을 방지하는 안전망입니다.

---

## 17. 전체 그림: setState에서 화면까지

지금까지 살펴본 조각들을 하나의 흐름으로 이어보면:

사용자가 버튼을 클릭해 `setState(newValue)`를 호출합니다. `dispatchSetState`가 실행되어 현재 컨텍스트(이벤트 핸들러)에서 `InputDiscreteLane`을 할당받습니다. Eager State 최적화를 시도해 새 값이 현재 값과 동일하다면 즉시 종료합니다. 다르다면 업데이트를 큐에 추가하고 `scheduleUpdateOnFiber`로 렌더를 예약합니다.

React 스케줄러가 우선순위에 따라 `performConcurrentWorkOnRoot`를 실행합니다. `renderWithHooks`가 Dispatcher를 설정하고 컴포넌트 함수를 실행합니다. `updateReducer`가 업데이트 큐를 처리하며 Lane 필터링으로 이번 렌더에서 적용할 업데이트를 선별합니다. 새 상태가 계산됩니다.

`commitRoot`가 시작됩니다. Mutation Phase에서 `useInsertionEffect`가 실행되고 DOM이 변경됩니다. `root.current`가 새 Fiber 트리로 교체됩니다. Layout Phase에서 `useLayoutEffect`가 실행되고 ref가 연결됩니다. 브라우저가 화면을 그립니다. 이후 MessageChannel을 통해 비동기적으로 `flushPassiveEffects`가 실행되어 전체 트리의 `useEffect` cleanup과 create가 순서대로 처리됩니다.

---

## 마치며: 제약이 자유를 만드는 방식

Hook은 제약을 통해 자유를 제공합니다. 순서를 강제함으로써 배열 인덱스 없이도 Hook을 추적할 수 있게 됩니다. Dispatcher를 렌더 외부에서 비활성화함으로써 잘못된 사용을 컴파일 타임이 아닌 런타임에 즉시 잡아냅니다. Effect를 원형 리스트로 관리함으로써 커밋 단계에서 효율적으로 순회합니다.

"Hook은 클로저 기반의 상태 관리"라는 직관은 개발자 경험 측면의 설명이지, 내부 구현의 설명이 아닙니다. 실제로 상태는 Fiber의 `memoizedState`에 살고, `setState`는 Fiber와 큐에 바인딩된 함수이며, Effect는 비트마스크로 분류된 원형 리스트의 노드입니다.

이 구조를 이해하면 다음 질문들의 답이 자명해집니다: 왜 조건문 안에서 Hook을 쓸 수 없는가, 왜 `setState(sameValue)`가 리렌더를 유발하지 않는가, 왜 `useLayoutEffect`와 `useEffect`의 타이밍이 다른가, 왜 Concurrent Mode에서 외부 스토어를 직접 읽으면 위험한가.

다음 편에서는 이 Hook들의 우선순위를 결정하는 **Lane 스케줄링 시스템**을 다룹니다. 31개의 비트로 표현되는 우선순위 채널, Entanglement, 기아(starvation) 방지 알고리즘을 추적합니다.

---

> **시리즈 링크**
> - [1편: 패키지 계층 구조](react-architecture-01-package-structure.md)
> - [2편: Fiber 아키텍처](react-architecture-02-fiber-architecture.md)
> - **3편: Hooks 시스템** (현재)
> - [4편: Lane 스케줄링](react-architecture-04-lane-scheduling.md) (예정)

*분석 기반: React 18.3.1 (`packages/react-reconciler/src/ReactFiberHooks.js`)*