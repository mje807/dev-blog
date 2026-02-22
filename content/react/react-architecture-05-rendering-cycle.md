---
title: "React는 어떻게 아무것도 하지 않으면서 모든 것을 처리하는가 — Render Phase 해부"
date: "2025-02-20"
tags: [React, Fiber, Reconciler, Rendering, Performance]
series: "React 아키텍처 심층 분석"
---

> **시리즈**: React 아키텍처 심층 분석 5편  
> **이전**: Lane 스케줄링 시스템  
> **다음**: Commit Phase

---

## 들어가며: 계산과 실행을 분리한다는 것

React의 가장 큰 아이디어 중 하나는 **"무엇이 바뀌어야 하는지 계산하는 것"과 "실제로 바꾸는 것"을 완전히 분리한다**는 점입니다. 우리가 `setState`를 호출하면 React는 즉시 DOM을 건드리지 않습니다. 대신 화면이 어떻게 바뀌어야 하는지를 메모리 안에서 조용히 계산합니다. 이 계산의 단계를 Render Phase라고 부릅니다.

이 분리가 왜 중요한지는 중단 가능성(interruptibility)을 생각하면 명확해집니다. DOM 조작은 중간에 멈출 수 없습니다. 반쯤 업데이트된 화면은 사용자에게 그대로 노출됩니다. 하지만 메모리 안에서의 계산은 언제든 멈출 수 있고, 버릴 수 있고, 처음부터 다시 시작할 수 있습니다. React의 Concurrent Mode가 가능한 이유가 바로 이 설계 결정에 있습니다.

이 글에서는 Render Phase의 내부를 해부합니다. `workLoop`가 어떻게 렌더링을 조율하는지, `beginWork`가 각 Fiber를 어떻게 처리하는지, 그리고 React가 실제 DOM 변경 없이도 변경 사항을 어떻게 추적하는지를 살펴봅니다.

---

## 1. Work Loop: 렌더링 엔진의 심장박동

### 중단 가능한 루프라는 개념

Work Loop는 React가 Fiber 트리를 순회하는 메인 엔진입니다. 각 Fiber를 하나씩 처리하며 트리 전체를 탐색하는데, 여기서 결정적인 설계 선택이 등장합니다. 루프는 두 가지 버전으로 존재합니다. 하나는 절대 멈추지 않는 동기 버전이고, 다른 하나는 매 단위 작업마다 "지금 멈춰야 하는가?"를 묻는 비동기 버전입니다.

동기 루프는 작업이 끝날 때까지 CPU를 독점합니다. 브라우저는 그 사이에 사용자 입력을 처리할 수 없습니다. 반면 비동기 루프는 Scheduler 패키지가 제공하는 신호를 받아, 현재 프레임의 데드라인이 다가오거나 사용자 입력이 대기 중이면 자발적으로 제어권을 양보합니다. 이 양보가 일어나는 순간, 루프는 깨지고 처리 중이던 Fiber에 대한 포인터만 남습니다. 나중에 React는 이 포인터를 보고 중단됐던 자리에서 정확히 재개합니다.

흥미로운 점은, Concurrent Mode를 사용해도 **대부분의 업데이트는 동기 루프로 처리된다**는 사실입니다. `useState`로 인한 상태 업데이트, 연속적인 입력 처리, 일반적인 이벤트 핸들러 — 이것들은 모두 동기적으로 실행됩니다. Time Slicing이 실제로 작동하는 건 개발자가 `useTransition`을 명시적으로 사용하거나 Suspense 재시도가 일어날 때로 한정됩니다. "Concurrent Mode = 모든 렌더링이 중단 가능"이라는 통념은 사실이 아닙니다.

### 렌더의 일곱 가지 결말

Work Loop가 끝날 때 React는 단순한 성공/실패 이분법이 아닌 7가지 상태 중 하나를 반환합니다. 여전히 진행 중인지(`RootInProgress`), 복구 불가능한 오류인지(`RootFatalErrored`), Error Boundary가 처리할 수 있는 오류인지(`RootErrored`), Suspense 경계에서 멈췄는지(`RootSuspended`), 정상 완료인지(`RootCompleted`) 등으로 세분화됩니다.

이 세분화가 중요한 이유는 각 결과에 따라 React의 다음 행동이 완전히 달라지기 때문입니다. `RootInProgress`가 반환되면 React는 Commit Phase로 넘어가지 않고 다음 Scheduler 틱에서 작업을 재개합니다. `RootCompleted`만이 실제 DOM 반영으로 이어집니다.

### DFS로 트리를 순회하는 방식

Work Loop 안에서 각 Fiber를 처리하는 단위 함수는 깊이 우선 탐색(DFS)으로 트리를 내려갑니다. 처리할 Fiber를 받아 `beginWork`로 작업을 수행하고, 자식이 있으면 자식으로 내려가고, 자식이 없으면(리프 노드) `completeWork`를 호출한 뒤 형제 또는 부모로 돌아옵니다. 이 순회 패턴은 나중에 `completeWork`가 아래에서 위로 DOM 트리를 조립하는 방식과 밀접하게 연결됩니다.

---

## 2. beginWork: 20여 가지 Fiber의 운명을 결정하는 분기점

### 이중 bailout: 두 번의 "건너뛸까?" 질문

`beginWork`는 React Reconciler의 핵심 함수입니다. 이 함수가 하는 가장 중요한 일은 역설적으로 **아무것도 하지 않는 것**입니다. 즉, 변경이 없는 Fiber를 최대한 빨리 식별하고 건너뛰는 것입니다.

`beginWork`에 들어서자마자 React는 두 단계의 bailout 가능성을 검사합니다. 첫 번째는 "이 Fiber에 예약된 업데이트가 없고, props도 변경되지 않았는가?"입니다. 이 조건이 성립하면 React는 이 Fiber를 처리하는 대신 `childLanes`를 확인하여 자식 중에 작업이 있는지만 판단합니다. 자식에도 아무 작업이 없다면 서브트리 전체를 건너뜁니다. 단 한 번의 확인으로 수백 개의 노드를 스킵하는 것입니다.

두 번째 bailout은 컴포넌트를 실제로 실행한 후에 이루어집니다. props는 변경됐지만 state는 달라진 게 없는 경우, 혹은 그 반대인 경우를 정밀하게 구분합니다. 이를 위해 React는 모듈 수준의 전역 변수 `didReceiveUpdate`를 사용합니다. `beginWork`가 props 비교를 통해 초기값을 설정하고, 컴포넌트 함수 실행 중 Hook이 실제 상태 변경을 감지하면 이 변수를 덮어씁니다. 컴포넌트 함수 실행이 끝난 뒤 이 변수를 확인하여 재조정 여부를 결정합니다.

### 타입마다 다른 처리 경로

bailout을 통과하면 Fiber의 타입에 따라 완전히 다른 처리 경로로 분기됩니다. React에는 20가지 이상의 Fiber 타입이 존재합니다. 함수형 컴포넌트, 클래스 컴포넌트, DOM 요소, 텍스트 노드, Context Provider, Suspense, React.memo 컴포넌트 등이 각자의 경로를 가집니다.

함수형 컴포넌트 처리에서 가장 흥미로운 부분은 **Dispatcher 교체**입니다. React는 컴포넌트 함수를 실행하기 직전에 전역 Dispatcher 객체를 교체합니다. 최초 마운트라면 `HooksDispatcherOnMount`로, 이후 업데이트라면 `HooksDispatcherOnUpdate`로, 렌더 중 `setState`가 호출된 경우라면 `HooksDispatcherOnRerender`로 교체됩니다. 컴포넌트 함수 실행이 끝나면 Dispatcher를 모든 Hook을 에러로 처리하는 `ContextOnlyDispatcher`로 되돌립니다.

이것이 바로 컴포넌트 외부에서 `useState()`를 호출하면 "Invalid hook call" 에러가 나는 이유입니다. 컴포넌트 함수 실행 밖에서는 Dispatcher가 항상 에러를 던지도록 설정되어 있습니다. Hook의 규칙은 단순한 관례가 아니라 이 메커니즘에 의해 강제됩니다.

### 무한 루프 방지 메커니즘

렌더 중에 `setState`를 호출하면 React는 같은 컴포넌트를 즉시 다시 실행합니다. 이것 자체는 의도된 동작이지만, 무한히 반복될 위험이 있습니다. React는 이를 25회로 제한합니다. 25번의 재렌더 시도 이후에도 안정 상태에 도달하지 못하면 "Too many re-renders" 에러를 발생시킵니다. 파생 상태 패턴을 구현할 때 이 한계를 이해하는 것이 중요합니다.

### shouldSetTextContent: 보이지 않는 최적화

`<div>Hello</div>`와 `<div><span>Hello</span></div>`의 처리 방식은 다릅니다. 전자의 경우 React는 "Hello"라는 텍스트를 위한 별도의 Fiber를 만들지 않습니다. `children`이 단순 문자열이나 숫자인지를 확인하여 그렇다면 DOM 노드의 `textContent`를 직접 설정하는 방식을 택합니다. Fiber 트리를 더 얕게 유지하고 불필요한 객체 생성을 줄이는 조용한 최적화입니다.

### React.memo의 두 가지 얼굴

`React.memo`로 감싼 컴포넌트는 내부적으로 두 가지 다른 Fiber 타입 중 하나로 처리됩니다. 커스텀 비교 함수 없이 `React.memo(fn)`으로 만들어진 컴포넌트는 `SimpleMemoComponent`로 처리되고, `React.memo(fn, customCompare)`처럼 커스텀 비교 함수를 제공한 경우는 `MemoComponent`로 처리됩니다. 전자는 더 최적화된 단축 경로를 따르며 Fiber 구조도 더 단순합니다.

주의할 점은 React.memo의 비교 함수 시맨틱이 `shouldComponentUpdate`와 **반대**라는 것입니다. `shouldComponentUpdate`는 "업데이트해야 하는가?"를 묻기 때문에 `true`를 반환하면 렌더링이 일어납니다. 반면 React.memo의 compare 함수는 "같은가?"를 묻기 때문에 `true`를 반환하면 렌더링을 건너뜁니다. 이 차이를 혼동하면 업데이트가 전혀 일어나지 않거나 항상 일어나는 버그가 발생합니다.

---

## 3. Context: 스택으로 구현된 전파 시스템

### Context는 어떻게 하위 컴포넌트에 전달되는가

`useContext(MyContext)`가 가장 가까운 Provider의 값을 반환하는 것은 당연해 보이지만, 내부 구현은 놀랍도록 단순합니다. Context 값은 스택으로 관리됩니다. Provider가 처리될 때 현재 값을 스택에 push하고, Provider의 하위 트리 처리가 끝나면 pop합니다. `useContext`는 이 스택의 현재 최상단 값을 O(1)으로 읽습니다.

이 스택 메커니즘 덕분에 Provider가 중첩되어도 올바르게 작동합니다. 안쪽 Provider의 값이 스택 상단에 있으므로 더 가까운 Provider의 값이 우선합니다. Provider의 bailout에서도 — 즉, 아무 처리도 하지 않고 건너뛰는 상황에서도 — `pushProvider`는 반드시 호출되어야 합니다. 하위 컴포넌트가 스택에서 값을 읽기 때문입니다.

### Context 값이 바뀌면 무슨 일이 일어나는가

Context Provider가 이전과 다른 값을 받으면, React는 Provider부터 시작하는 DFS 순회를 즉시 시작합니다. 목적은 이 Context를 구독하는 모든 컴포넌트를 찾아내는 것입니다. 각 Fiber는 자신이 구독하는 Context의 목록을 연결 리스트로 보관하고 있습니다. 컴포넌트 렌더 중 `useContext(MyContext)`가 호출될 때마다 이 리스트에 항목이 추가됩니다.

순회 중 구독자를 발견하면 두 가지 일이 동시에 일어납니다. 첫째, 해당 Fiber의 `lanes`에 현재 렌더 우선순위를 표시하여 이 렌더에서 반드시 재처리되도록 만듭니다. 둘째, 그 Fiber에서 루트 방향으로 거슬러 올라가며 모든 조상의 `childLanes`를 갱신합니다. 두 번째 단계가 필수적인 이유는, 조상들이 bailout을 결정할 때 `childLanes`를 확인하기 때문입니다. 조상의 `childLanes`가 갱신되지 않으면 Context 구독자가 있더라도 그 서브트리 전체가 건너뛰어집니다.

단, 중첩된 동일 Context의 Provider를 만나면 탐색을 멈춥니다. 그 아래는 다른 Provider가 제공하는 값을 읽으므로, 현재 Provider의 변경이 영향을 주지 않기 때문입니다.

---

## 4. bailoutOnAlreadyFinishedWork: "이 서브트리는 조용하다"

React가 가진 가장 강력한 최적화는 변경이 없는 서브트리를 통째로 건너뛰는 능력입니다. 이것이 `bailoutOnAlreadyFinishedWork`의 역할입니다.

이 함수의 핵심 질문은 단 하나입니다: "이 Fiber의 자손 중 현재 렌더에서 처리해야 할 작업이 있는가?" 이 판단은 `childLanes`를 통해 이루어집니다. `childLanes`는 해당 Fiber의 모든 후손이 가진 업데이트 우선순위의 합집합입니다. 업데이트가 예약될 때마다 루트 방향으로 모든 조상의 `childLanes`가 갱신되므로, 이 값은 항상 최신 상태입니다.

현재 렌더의 우선순위가 `childLanes`에 포함되지 않는다면, 자식 전체를 건너뜁니다. 반환값은 `null`이고, Work Loop는 이 Fiber 아래로 내려가지 않습니다. 수백 개의 노드가 단 한 번의 비트 연산으로 처리되는 것입니다.

```javascript
function bailoutOnAlreadyFinishedWork(current, workInProgress, renderLanes) {
  if (!includesSomeLane(renderLanes, workInProgress.childLanes)) {
    // 자식 중 현재 렌더에서 처리할 작업 없음 → 서브트리 전체 skip
    return null;
  }
  // 이 Fiber는 bailout이지만, 자식은 방문해야 함
  cloneChildFibers(current, workInProgress);
  return workInProgress.child;
}
```

이 코드에서 핵심은 `includesSomeLane` 비트 연산 한 번으로 서브트리 수백 개 노드의 방문 여부를 결정한다는 점입니다. `null`을 반환하면 Work Loop는 그 방향으로 내려가지 않습니다.

현실적인 React 앱에서 하나의 `setState`는 전체 Fiber 트리의 1~5%만 실제로 재렌더합니다. 수천 개 노드 중 컴포넌트 함수가 재실행되는 건 수십 개에 불과합니다. 나머지 95~99%는 이 bailout 경로를 통해 처리됩니다.

---

## 5. reconcileChildFibers: 자식을 어떻게 비교하는가

### 마운트와 업데이트의 결정적 차이

자식 Fiber를 생성하고 비교하는 함수는 두 버전으로 존재합니다. 마운트(최초 렌더)용과 업데이트용입니다. 이 두 버전의 차이는 `Placement` 플래그를 추적하느냐 아니냐에 있습니다.

이 차이가 왜 중요한지는 DOM 삽입 비용을 생각하면 명확합니다. `Placement` 플래그는 Commit Phase에서 실제 DOM에 노드를 삽입하라는 신호입니다. 마운트 시 모든 자식에 이 플래그를 설정하면, 트리의 모든 노드가 개별적으로 DOM에 삽입됩니다. 50개 노드라면 50번의 DOM 삽입이 일어납니다.

하지만 React는 더 영리하게 동작합니다. 마운트 시 루트에서 직접 연결되는 단 하나의 노드만 `Placement` 플래그를 받고, 그 아래의 모든 자식 노드는 플래그 없이 생성됩니다. 대신 `completeWork` 단계에서 메모리 안에서 DOM 트리를 먼저 조립합니다. 최종적으로 완성된 트리를 실제 DOM에 단 한 번 삽입합니다. 50번의 DOM 삽입이 1번으로 줄어드는 것입니다.

### key 없이 배열 자식을 비교하면 어떤 일이 벌어지는가

배열로 주어진 자식들의 비교는 두 단계로 이루어집니다. 1단계에서는 이전 자식과 새 자식을 같은 인덱스에서 순서대로 비교합니다. key가 일치하는 동안은 Fiber를 재사용합니다. key가 맞지 않는 순간 1단계를 종료하고 2단계로 넘어갑니다.

2단계에서는 남은 이전 Fiber들을 key(또는 인덱스)를 키로 하는 Map에 저장한 뒤, 새 자식들을 이 Map에서 찾아 매칭합니다. 배열의 중간에 요소를 삽입하거나 순서를 변경하는 경우 여기서 처리됩니다.

key의 역할이 명확해지는 순간이 2단계입니다. key가 있으면 위치가 바뀌어도 Map에서 같은 Fiber를 찾을 수 있어 재사용이 가능합니다. key가 없으면 인덱스를 Map의 키로 사용하므로, 요소의 순서가 바뀌면 재사용 실패가 발생하고 불필요한 DOM 삭제 및 삽입이 뒤따릅니다. key는 최적화 힌트가 아니라 Fiber 재사용의 필수 식별자입니다.

---

## 6. completeWork: 아래에서 위로 올라오며 세상을 조립한다

### 트리를 거슬러 올라가는 단계

`beginWork`가 트리를 내려가며 각 Fiber를 처리한다면, `completeWork`는 리프 노드에서 시작하여 루트 방향으로 올라가며 실제 DOM 노드를 생성하고 조립합니다. DFS 특성상 아래 노드들이 먼저 완료되므로, 부모 노드가 `completeWork`를 실행하는 시점에는 자식 DOM 노드들이 이미 메모리에 존재합니다.

마운트 경로에서 `completeWork`는 DOM 노드를 생성하고, 이미 완료된 자식 DOM 노드들을 찾아 부모에 붙이는 `appendAllChildren`을 호출합니다. 이 과정은 전적으로 메모리 안에서 이루어집니다. 실제 DOM에 붙이는 작업은 Commit Phase에서 단 한 번 발생합니다.

업데이트 경로에서는 DOM 노드를 새로 만들지 않습니다. 대신 이전 props와 새 props를 비교하여 변경된 속성만 추출합니다. 이 차이 목록은 `[key, value, key, value, ...]` 형태의 배열로 저장되어 Fiber의 `updateQueue`에 남습니다. 실제 DOM 속성 변경은 Commit Phase에서 이 배열을 사용해 이루어집니다.

이벤트 핸들러(`onClick`, `onChange` 등)는 이 차이 목록에 포함되지 않습니다. React의 이벤트 시스템은 이벤트 위임(Event Delegation)으로 구현되어 있어, 모든 이벤트를 root 컨테이너 하나에서 처리합니다. `onClick` prop이 변경되어도 DOM API 호출이 필요 없습니다.

### bubbleProperties: 플래그가 루트로 흘러가는 방식

`completeWork`의 마지막에는 항상 `bubbleProperties`가 호출됩니다. 이 함수는 자식들의 `flags`와 `subtreeFlags`를 수집하여 현재 Fiber의 `subtreeFlags`로 집계합니다. 쉽게 말하면, "내 후손 중 어떤 종류의 작업이 있는지"를 비트마스크 형태로 현재 Fiber에 기록하는 것입니다.

이 집계가 루트까지 거슬러 올라가면, 루트의 `subtreeFlags`에는 전체 트리에서 발생할 모든 부수 효과의 합집합이 담깁니다. Commit Phase는 이 값을 활용하여 DOM 변경이 없는 서브트리 전체를 건너뜁니다. Render Phase가 만들어준 이 지도를 따라 Commit Phase는 정밀하게 필요한 곳만 방문합니다.

---

## 7. 비트마스크로 상태를 기록하는 방법

### 플래그 시스템의 설계 철학

React는 각 Fiber의 상태를 기록하기 위해 비트마스크 플래그 시스템을 사용합니다. `Placement`(DOM 삽입 필요), `Update`(DOM 속성 변경 필요), `ChildDeletion`(자식 삭제 필요), `Passive`(useEffect 실행 필요), `Ref`(ref 갱신 필요) 등 수십 가지 플래그가 단일 정수에 비트로 저장됩니다.

비트 OR 연산으로 플래그를 추가하고, 비트 AND 연산으로 특정 플래그의 존재를 확인합니다. Commit Phase는 처리할 플래그들의 마스크를 미리 정의해두고, 각 단계에서 관련 플래그를 가진 Fiber만 처리합니다. Before Mutation 단계는 `Snapshot`과 `Passive` 플래그를, Mutation 단계는 `Placement`, `Update`, `ChildDeletion` 등을, Layout 단계는 `Update`와 `Ref` 등을 담당합니다.

`subtreeFlags`는 이 플래그들이 서브트리 수준으로 집계된 버전입니다. Commit Phase의 순회 함수는 부모의 `subtreeFlags`를 확인하여, 관련 플래그가 없으면 그 서브트리 전체를 방문하지 않습니다. Render Phase에서 일어나는 `bubbleProperties`의 집계 작업이 Commit Phase의 정밀한 탐색을 가능하게 하는 것입니다.

---

## 8. 멱등성: 같은 입력, 항상 같은 출력

### 왜 컴포넌트 함수는 순수해야 하는가

Concurrent Mode에서 React는 단일 업데이트에 대해 렌더 함수를 여러 번 호출할 수 있습니다. Time Slicing으로 중단했다가 재개할 때, Suspense 재시도, Offscreen 사전 렌더링, 개발 환경의 Strict Mode — 이 모든 경우에 같은 컴포넌트가 여러 번 실행됩니다.

이것이 "렌더 함수는 순수해야 한다"는 원칙의 실질적 의미입니다. 순수하다는 것은 같은 입력(props, state)에 대해 항상 같은 출력(JSX)을 반환하고, 외부 세계에 관찰 가능한 영향을 미치지 않아야 한다는 뜻입니다. 렌더 함수가 외부 카운터를 증가시키거나, API를 호출하거나, 전역 변수를 수정한다면 여러 번 호출될 때 예기치 않은 결과가 발생합니다.

Strict Mode의 "이중 호출"은 이 원칙을 검증하기 위해 존재합니다. 개발 환경에서 React는 컴포넌트 함수를 의도적으로 두 번 실행하되, 두 번째 결과를 버립니다. React가 확인하는 것은 "두 번 실행했을 때 부수 효과가 눈에 보이는가"입니다. 콘솔 로그가 두 번 출력되거나, API가 두 번 호출되거나, 컴포넌트가 다르게 보인다면 순수성 위반의 징후입니다.

---

## 9. shallowEqual: 비교의 정밀도

### Object.is와 ===의 미묘한 차이

`React.memo`의 기본 비교 함수 `shallowEqual`은 두 객체의 키를 열거하여 각 값을 `Object.is`로 비교합니다. `Object.is`와 `===`는 대부분 동일하게 동작하지만 두 가지 엣지 케이스에서 다릅니다. `NaN === NaN`은 `false`이지만 `Object.is(NaN, NaN)`은 `true`이고, `+0 === -0`은 `true`이지만 `Object.is(+0, -0)`은 `false`입니다.

상태에 `NaN`이 포함된 경우를 생각해보면 이 차이가 중요합니다. `===` 기반 비교는 이전 값과 새 값이 모두 `NaN`이어도 다르다고 판단하여 매번 재렌더를 유발합니다. `Object.is` 기반 비교는 이를 같다고 올바르게 판단합니다.

### 의존성 배열의 비교는 다르다

`useEffect`, `useMemo`, `useCallback`의 의존성 배열은 `shallowEqual`과 다른 함수로 비교됩니다. 의존성 배열 비교는 배열의 순서에 민감합니다. `[a, b]`와 `[b, a]`는 같은 값을 담고 있어도 다른 배열로 취급됩니다. 반면 `shallowEqual`은 키의 순서에 무관하게 비교합니다. 두 함수는 사용 맥락이 다르고 의미론도 다릅니다.

---

## 마치며: 세 겹의 최적화가 만드는 조화

Render Phase를 관통하는 핵심 아이디어는 하나입니다. **변경이 없는 것은 최대한 빠르게 식별하고, 변경이 있는 것만 정밀하게 처리한다.**

이 목표는 세 레벨의 최적화가 동시에 작동하면서 달성됩니다.

첫 번째는 **Lane 레벨**입니다. `childLanes`를 통해 서브트리 전체를 단 하나의 비트 연산으로 건너뜁니다. 1000개 노드의 서브트리도 이 검사 하나로 처리됩니다.

두 번째는 **컴포넌트 레벨**입니다. `shallowEqual`, `didReceiveUpdate`, `shouldComponentUpdate`, 의존성 배열 비교가 각자의 맥락에서 개별 컴포넌트의 재실행 여부를 결정합니다.

세 번째는 **Commit 레벨**입니다. Render Phase에서 집계된 `subtreeFlags`를 사용하여 Commit Phase는 부수 효과가 있는 서브트리만 정밀하게 방문합니다.

이 세 레이어가 조화롭게 작동할 때, 수천 개 노드의 Fiber 트리에서도 실제 DOM 작업은 변경된 소수의 노드에만 집중됩니다. React가 "빠르다"고 느껴지는 것은 마법이 아니라 이 체계적인 건너뜀(bailout)의 결과입니다.

다음 편에서는 Render Phase가 계산한 결과를 실제 DOM에 반영하는 **Commit Phase**를 다룹니다. Before Mutation, Mutation, Layout, Passive Effects — 이 네 단계가 왜 분리되어 있고, 각 단계가 무엇을 보장하는지 살펴봅니다.

---

*소스 참조: `packages/react-reconciler/src/ReactFiberWorkLoop.js`, `ReactFiberBeginWork.js`, `ReactFiberCompleteWork.js`, `ReactChildFiber.js`, `ReactFiberNewContext.js`*