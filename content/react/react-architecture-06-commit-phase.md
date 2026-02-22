---
title: "React Commit Phase: DOM을 확정하는 불가역적 순간"
date: "2025-02-20"
tags: [React, Commit Phase, Fiber, useLayoutEffect, useEffect, 더블 버퍼링]
series: "React 아키텍처 심층 분석"
---

> **React 아키텍처 심층 분석** 시리즈의 여섯 번째 글입니다. [5편](./react-architecture-05-rendering-cycle.md)에서 Render Phase가 Fiber 트리를 순회하며 변경 사항을 계산하는 과정을 살펴봤습니다. 이번 편에서는 그 계산 결과가 실제 세계로 나오는 순간, **Commit Phase**를 탐구합니다.

---

## 돌아올 수 없는 강을 건너는 일

외과 의사는 첫 절개를 가하기 전까지 멈출 수 있습니다. 수술 계획을 수정하고, 도구를 교체하고, 팀을 재배치할 수도 있습니다. 하지만 메스가 피부를 가르는 순간부터는 다릅니다. 절반만 완료된 수술은 허용되지 않습니다. 시작했으면 끝내야 합니다.

React의 Commit Phase는 정확히 이 지점에 위치합니다. Render Phase가 아무리 오래 걸리고, 아무리 여러 번 중단되더라도 상관없습니다. Concurrent Mode에서 React는 우선순위가 높은 작업이 들어오면 진행 중인 렌더를 멈추고 나중에 다시 시작할 수 있습니다. 그러나 Commit Phase에 진입한 순간부터는 이 철학이 바뀝니다. **중단 없이, 예외 없이, 끝까지 실행**되어야 합니다.

왜 이런 원칙이 필요한지 이해하려면, 먼저 Commit Phase가 무엇을 하는지 알아야 합니다.

Render Phase는 순수하게 계산합니다. Fiber 트리를 순회하고, 이전 상태와 새 상태를 비교하고, "이 컴포넌트의 DOM 속성을 이렇게 바꿔야 한다"는 명세를 작성합니다. 이 과정에서 실제 DOM은 단 한 번도 건드리지 않습니다. Commit Phase는 그 명세를 집행합니다. DOM을 삽입하고, 제거하고, 속성을 수정하고, ref를 연결하고, lifecycle을 호출합니다. 이 작업들이 절반만 적용된 채로 사용자에게 노출되면 안 됩니다. 깜빡이는 UI, 일관성 없는 데이터, 이전 DOM을 가리키는 ref — 이 모든 문제가 "절반만 완료된 Commit"에서 비롯됩니다.

원자성(Atomicity)이 필요한 이유가 바로 여기 있습니다.

---

## 다섯 막으로 구성된 파이프라인

Commit Phase는 하나의 거대한 함수가 아닙니다. 명확하게 구분된 다섯 단계의 파이프라인으로 구성되어 있습니다. 각 단계는 이전 단계의 완료를 전제로 하며, 각자가 담당하는 역할이 분리되어 있습니다.

**0단계**는 이전 렌더 사이클에서 예약된 Passive Effects를 먼저 처리하는 준비 단계입니다. `useEffect`는 비동기로 실행되기 때문에, 이전 렌더의 `useEffect`가 아직 실행되지 않은 채 새 Commit이 시작될 수 있습니다. 이 경우 React는 새 Commit을 시작하기 전에 밀린 `useEffect`를 먼저 처리합니다. 일관된 실행 순서를 보장하기 위한 방어 로직입니다.

**1단계, Before Mutation Phase**는 DOM이 변경되기 직전에 실행됩니다. 이 단계에서 가장 중요한 작업은 `getSnapshotBeforeUpdate`의 호출입니다. 이름에서 알 수 있듯이, DOM이 변경되기 직전의 스냅샷을 캡처합니다. 스크롤 위치, 레이아웃 치수 등 "변경 이전"에만 읽을 수 있는 정보를 저장해두고, 나중에 `componentDidUpdate`에서 활용할 수 있도록 합니다.

**2단계, Mutation Phase**는 실제로 DOM을 수정하는 단계입니다. 삭제해야 할 요소를 제거하고, 새로 추가할 요소를 삽입하고, 속성이 바뀐 요소를 업데이트합니다. 이 단계에서 DOM은 이전 상태에서 새 상태로 전환됩니다.

**3단계, Layout Phase**는 DOM 변경이 완료된 직후, 브라우저가 실제로 화면을 그리기 전에 실행됩니다. `useLayoutEffect`와 `componentDidMount`, `componentDidUpdate`가 여기서 실행됩니다. DOM이 새 상태로 업데이트되었지만 사용자 화면에는 아직 반영되지 않은 이 짧은 순간에 동기적으로 실행할 작업들을 처리합니다.

**4단계**는 브라우저에게 "이제 화면을 그려도 좋다"는 신호를 보내고, 비동기로 예약된 `useEffect`를 Scheduler에 등록하는 후처리 단계입니다.

이 파이프라인의 핵심 설계 철학은 **관심사의 명확한 분리**입니다. DOM 읽기(Before Mutation), DOM 쓰기(Mutation), DOM 읽기+동기 반응(Layout), 비동기 사이드 이펙트(Passive) — 이 네 가지 성격이 다른 작업을 혼재시키지 않음으로써 각 단계의 동작을 예측 가능하게 만듭니다.

---

## 더블 버퍼링: 무대 뒤에서 준비된 배경

Commit Phase를 이해하는 데 가장 중요한 개념 중 하나는 **더블 버퍼링**입니다. 영상 편집에서 사용하는 이중 버퍼 기술을 떠올리면 이해하기 쉽습니다. 현재 화면에 표시되고 있는 프레임을 건드리지 않으면서, 뒤에서 다음 프레임을 준비한 뒤 한 번에 교체합니다.

React도 정확히 이 방식으로 동작합니다. Render Phase 전체 동안 두 개의 트리가 존재합니다. 하나는 현재 화면에 표시되고 있는 "current 트리"이고, 다른 하나는 Render Phase에서 새로 만들어진 "workInProgress 트리"입니다. `FiberRoot`라는 최상위 객체가 이 두 트리 중 현재 화면에 표시 중인 것을 가리키는 포인터(`root.current`)를 유지합니다.

Render Phase가 완료되면 workInProgress 트리는 Commit을 기다리는 `finishedWork`가 됩니다. 이 시점까지도 `root.current`는 여전히 이전 트리를 가리킵니다.

포인터가 교체되는 순간은 매우 정확하게 지정되어 있습니다. Mutation Phase가 완료된 직후, Layout Phase가 시작되기 직전, 딱 한 줄의 할당문으로 교체됩니다.

```javascript
commitMutationEffects(root, finishedWork, lanes);

root.current = finishedWork; // ← 이 한 줄이 두 세계를 가른다

commitLayoutEffects(finishedWork, root, lanes);
```

이 코드에서 핵심은 `root.current = finishedWork`라는 단 하나의 할당문이 전체 Commit Phase에서 가장 중요한 순간이라는 점입니다. Mutation Phase 이후이고 Layout Phase 이전인 이 정확한 위치가 의미하는 바를 이해하는 것이 Commit Phase를 이해하는 열쇠입니다.

---

## 포인터 교체의 타이밍이 중요한 이유

이 타이밍이 왜 정확히 이 위치여야 하는지 이해하기 위해, 다른 위치에 놓았을 때 어떤 문제가 생기는지 생각해봅시다.

만약 포인터 교체가 **Mutation Phase 이전**에 일어난다면 어떻게 될까요? Mutation Phase에서 삭제 처리를 할 때 React는 "이전 트리"의 컴포넌트에서 `componentWillUnmount`와 `useLayoutEffect` cleanup을 실행해야 합니다. 그런데 `root.current`가 이미 새 트리를 가리키고 있다면, React가 잘못된 트리의 인스턴스에서 lifecycle을 호출하게 됩니다. 이미 화면에서 사라진 컴포넌트가 아니라 새로 마운트된 컴포넌트에서 cleanup이 실행되는 참사가 벌어집니다.

반대로, 포인터 교체가 **Layout Phase 이후**에 일어난다면 어떻게 될까요? `componentDidMount` 안에서 `setState`를 호출하는 패턴을 생각해봅시다. `setState`는 어떤 Fiber에 업데이트를 등록할지 결정하기 위해 `root.current`를 참조합니다. 이 시점에 `root.current`가 여전히 이전 트리를 가리키고 있다면, 업데이트가 이미 화면에서 폐기된 트리의 Fiber에 등록됩니다. 그 Fiber를 기준으로 재렌더가 시작되면 잘못된 상태를 기반으로 UI가 만들어집니다.

결국 이 타이밍은 두 가지를 동시에 보장하기 위해 최적화된 위치입니다. Mutation Phase에서는 이전 트리와 새 트리를 명확하게 구분할 수 있어야 하고, Layout Phase에서는 `setState` 같은 업데이트가 올바른 트리를 기준으로 등록되어야 합니다. Mutation 완료 + Layout 시작 사이의 단 하나의 라인만이 이 두 조건을 모두 충족합니다.

---

## Mutation Phase: 외과적 정밀성

Mutation Phase는 세 종류의 작업을 처리합니다. 삭제(Deletion), 삽입(Placement), 속성 업데이트(Update)입니다.

주목할 만한 점은 처리 순서입니다. **삭제가 삽입보다 먼저** 처리됩니다. 이 순서는 DOM 일관성을 위한 선택입니다. 삽입을 먼저 하면 이미 삭제 예정인 요소와 새 요소가 잠시 공존하는 상태가 만들어질 수 있습니다. 삭제를 먼저 처리함으로써 "이전 것은 사라지고, 새 것은 등장하는" 단방향 흐름을 유지합니다.

삭제 처리에서 React가 선택한 최적화도 흥미롭습니다. 컨테이너 DOM 노드 하나를 `removeChild`로 제거하면 그 안의 모든 자식 DOM 노드도 자동으로 제거됩니다. 브라우저의 이 특성을 활용하여 React는 최상위 Host 노드 하나만 `removeChild`하고, 하위 노드들에 대해서는 DOM 조작 없이 lifecycle 정리(`componentWillUnmount`, `useLayoutEffect` cleanup, ref 해제)만 실행합니다. 수천 개의 자식을 가진 컴포넌트를 삭제할 때 수천 번의 `removeChild`를 호출하는 대신 단 한 번으로 처리하는 것입니다.

새 노드를 삽입할 때(`commitPlacement`)는 단순히 `appendChild`를 부르지 않습니다. React는 먼저 삽입할 위치를 정확히 계산합니다. 새 Fiber의 다음 형제 중 이미 DOM에 존재하는 Host 노드를 찾아서, 그 앞에 삽입(`insertBefore`)할지 끝에 추가(`appendChild`)할지 결정합니다. 이 계산이 필요한 이유는 Fragment, Context, memo 같은 래퍼 컴포넌트들이 DOM 노드를 만들지 않기 때문입니다. Fiber 트리의 형제 순서가 DOM 트리의 순서와 일치하지 않을 수 있으므로, React는 Fiber 트리를 탐색하며 실제 DOM 노드를 찾아내야 합니다.

---

## Layout Phase와 브라우저 Paint의 관계

Layout Phase는 타이밍으로 이해해야 합니다. DOM은 이미 새 상태로 업데이트되었습니다. 하지만 브라우저는 아직 화면을 다시 그리지 않았습니다. 이 짧은 간극에 실행되는 것이 Layout Phase입니다.

왜 이 간극이 존재할까요? 브라우저는 JavaScript가 실행되는 동안 화면을 그리지 않습니다. JavaScript 실행이 완료되고 콜스택이 비워진 후에야 렌더링 파이프라인(Style → Layout → Paint → Compositing)이 실행됩니다. Commit Phase 전체가 하나의 동기적 JavaScript 실행 흐름이므로, Layout Phase가 완료될 때까지 브라우저는 대기합니다.

`useLayoutEffect`와 `componentDidMount`/`componentDidUpdate`가 바로 이 간극을 활용합니다. 이 훅들은 "DOM은 업데이트됐지만 사용자는 아직 못 본" 상태에서 실행됩니다. 따라서 이 훅 안에서 DOM 크기를 측정하고 상태를 업데이트해도, 사용자에게는 최종 결과만 보입니다. 중간 상태가 화면에 노출되지 않습니다.

ref가 Layout Phase에서 연결되는 이유도 같은 맥락입니다. `useLayoutEffect` 안에서 ref를 통해 DOM을 측정하려면, ref가 이미 최신 DOM을 가리키고 있어야 합니다. Layout Phase에서 ref 연결이 완료된 후 `useLayoutEffect`가 실행되는 순서가 이를 보장합니다.

다만 이 강력함에는 비용이 따릅니다. `useLayoutEffect`는 브라우저 paint를 블로킹합니다. Layout Phase가 실행되는 동안 브라우저는 아무것도 할 수 없습니다. `useLayoutEffect` 안에서 DOM 크기 측정(`getBoundingClientRect`, `offsetWidth` 등)을 반복적으로 수행하거나, `setState`로 재렌더를 유발하면 paint가 그만큼 지연됩니다. 이것이 "DOM 측정이 필요하거나 paint 이전에 동기적으로 실행되어야 하는 작업"에만 `useLayoutEffect`를 사용하고, 나머지는 `useEffect`를 권장하는 이유입니다.

---

## useEffect는 왜 paint 이후에 실행되는가

`useEffect`는 Commit Phase 내에서 실행되지 않습니다. Commit Phase가 완료되고, 브라우저가 화면을 그리고 난 뒤, **별도의 태스크**로 실행됩니다.

이 타이밍을 구현하는 방법이 흥미롭습니다. React는 내부적으로 `MessageChannel`을 사용합니다. `MessageChannel`의 `port.postMessage()`를 호출하면 새로운 매크로태스크(macrotask)가 큐에 등록됩니다. 브라우저는 매크로태스크 사이의 간격에 렌더링을 수행할 수 있습니다. 즉, Commit Phase의 태스크가 완료되면 브라우저가 Style 계산, Layout 계산, Paint를 수행하고, 그 이후에 `useEffect`를 실행하는 새 태스크가 시작됩니다.

초기 React 버전에서는 `requestAnimationFrame`을 사용했습니다. `requestAnimationFrame`은 다음 paint 직전에 실행됩니다. 하지만 두 가지 문제가 있었습니다. 첫째, 탭이 백그라운드에 있으면 `requestAnimationFrame`이 실행되지 않아 `useEffect`가 동작하지 않는 버그가 발생했습니다. 둘째, "paint 이전"이 아니라 "paint 이후 가능한 빨리"가 목표이므로 `requestAnimationFrame`은 정확한 도구가 아니었습니다. `MessageChannel`은 탭 상태와 무관하게 동작하고, paint 이후 실행을 보장합니다.

이 타이밍 차이가 개발 경험에 미치는 영향은 큽니다. `useEffect` 안에서 `setState`를 호출하면 사용자는 두 번의 렌더 결과를 순차적으로 봅니다. 첫 번째 렌더가 화면에 나타난 뒤, `useEffect`가 실행되어 상태가 바뀌고, 두 번째 렌더가 다시 화면에 나타납니다. 반면 `useLayoutEffect`에서 `setState`를 호출하면 두 번 렌더하더라도 paint는 한 번만 일어납니다. 두 번째 렌더의 결과만 사용자에게 보입니다. 어느 것이 더 좋다가 아니라, 상황에 따라 올바른 도구를 선택해야 합니다.

---

## componentDidMount에서 setState가 동기인 이유

`componentDidMount` 안에서 `setState`를 호출하면 `flushSync`를 사용하지 않았는데도 동기적으로 재렌더가 일어나는 것처럼 보입니다. 이 동작의 원리를 이해하려면 `executionContext`라는 내부 상태를 알아야 합니다.

React는 현재 어떤 작업을 실행 중인지 추적하는 비트 플래그(`executionContext`)를 유지합니다. Commit Phase 전체 동안 이 플래그에는 `CommitContext`가 설정되어 있습니다. `setState`가 호출되면 React는 이 플래그를 확인합니다. Commit 도중이라면 즉시 재렌더를 시작하지 않고, 현재 Commit이 완료된 후 처리할 큐에 등록합니다.

Commit이 완료된 직후, React는 이 큐를 확인합니다. `componentDidMount`에서 발생한 업데이트는 `SyncLane` 우선순위를 가지므로, 마이크로태스크(microtask)로 즉시 처리됩니다. 마이크로태스크는 현재 매크로태스크 내에서, 브라우저 렌더링 기회 이전에 실행됩니다. 따라서 브라우저 paint 전에 동기 재렌더가 완료되고, 사용자에게는 두 번째 렌더의 결과만 보입니다.

이 동작이 의미하는 바는 분명합니다. `componentDidMount`나 `componentDidUpdate`에서 DOM 측정 후 `setState`를 호출하는 고전적인 패턴은 이중 렌더를 유발하지만, paint는 한 번입니다. `useLayoutEffect` + `useState` 패턴도 동일합니다. 중요한 것은 이 이중 렌더가 함수 호출 레벨에서는 발생하지만 사용자 경험 레벨에서는 숨겨져 있다는 점입니다.

---

## 삭제된 Fiber의 메모리 관리

Commit Phase가 끝나고 난 후에도 할 일이 있습니다. 삭제된 Fiber 객체들을 메모리에서 해제하는 작업입니다.

Fiber 객체는 복잡한 참조 그래프를 형성합니다. 부모를 가리키는 포인터, 자식을 가리키는 포인터, 형제를 가리키는 포인터, 다른 버전의 자신을 가리키는 `alternate` 포인터. 이 참조들이 해제되지 않으면 JavaScript GC는 해당 객체를 수집하지 못합니다. Fiber가 GC되지 않으면, Fiber가 참조하는 DOM 노드, 클래스 인스턴스, Hook 체인도 모두 메모리에 남습니다.

특히 `alternate` 포인터가 만드는 순환 참조가 문제입니다. current 트리의 Fiber A는 workInProgress 트리의 Fiber A를 `alternate`로 가리키고, workInProgress 트리의 Fiber A도 current 트리의 Fiber A를 `alternate`로 가리킵니다. 컴포넌트가 삭제되어 두 Fiber가 모두 트리에서 제거되더라도, 서로를 가리키는 순환 참조 때문에 GC가 어느 것도 수집하지 못할 수 있습니다.

React는 `detachFiberAfterEffects`에서 삭제된 Fiber의 모든 포인터를 명시적으로 `null`로 설정합니다. `child`, `sibling`, `return`, `alternate`, `stateNode`, `memoizedState`, `updateQueue`까지 — 삭제된 Fiber에서 다른 객체로 이어지는 모든 연결을 끊습니다. 이렇게 하면 해당 Fiber가 더 이상 다른 객체를 "붙잡고 있지" 않으므로, 연결된 객체들이 GC 대상이 됩니다.

무한 스크롤이나 탭 전환처럼 컴포넌트가 빈번하게 마운트/언마운트되는 앱에서 이 정리 작업이 얼마나 중요한지는 실제로 측정해보면 알 수 있습니다. 정리 없이 수백 개의 컴포넌트가 마운트/언마운트를 반복하면 메모리 사용량이 선형적으로 증가합니다.

---

## Commit Phase는 왜 중단될 수 없는가

Render Phase의 루프에는 `shouldYield()` 체크가 있습니다. Scheduler가 "지금 브라우저에게 양보해야 한다"고 판단하면 렌더를 멈추고 나중에 재개할 수 있습니다. Commit Phase의 루프에는 이 체크가 없습니다. 의도적인 설계입니다.

세 가지 이유가 있습니다.

첫째, **사용자에게 일관성 없는 UI를 보여줄 수 없습니다.** Mutation이 절반만 적용된 상태에서 브라우저 paint가 일어나면, 사용자는 새 버튼이 등장했는데 이전 텍스트가 남아있는 화면을 보게 됩니다. 이는 명백한 버그입니다.

둘째, **ref의 계약을 지켜야 합니다.** Layout Phase가 완료되기 전에 ref 접근이 허용되면, ref가 이전 DOM을 가리킬 수 있습니다. "ref는 항상 최신 DOM을 가리킨다"는 보장이 깨집니다.

셋째, **lifecycle 실행 순서가 보장되어야 합니다.** `componentDidMount`는 모든 자식의 `componentDidMount`가 실행된 이후에 실행됩니다. 트리의 아래에서 위로 올라오는 순서입니다. Commit이 중간에 중단되면 이 순서가 깨집니다.

Commit Phase가 5ms 프레임 예산을 초과하여 실행되면 어떻게 될까요? 다음 프레임에서 UI가 버벅거릴 수 있습니다. 하지만 이것은 "일관성 없는 UI"보다 나은 결과입니다. 복잡한 앱에서 단일 Commit이 오래 걸린다는 것은 한 번에 너무 많은 컴포넌트를 업데이트하고 있다는 신호입니다. 해결책은 Commit을 중단 가능하게 만드는 것이 아니라, `useTransition`으로 업데이트를 분산시켜 각각의 Commit이 더 작아지게 만드는 것입니다.

---

## 흐름의 전체를 보면

Commit Phase를 하나의 이야기로 요약하면 이렇습니다.

React는 Render Phase에서 계산한 결과를 가지고 Commit Phase에 진입합니다. 먼저 밀린 숙제(이전 Passive Effects)를 처리하고, DOM이 변경되기 전 마지막으로 스냅샷을 찍습니다(Before Mutation). 그런 다음 외과적 정밀성으로 DOM을 수정합니다(Mutation). 이제 DOM은 새 상태지만 사용자는 아직 모릅니다. 이 순간 포인터를 교체합니다(`root.current = finishedWork`). 브라우저가 화면을 그리기 전, 동기적으로 실행해야 할 작업들을 처리합니다(Layout). 마지막으로 브라우저에게 신호를 보내고, 비동기 사이드 이펙트를 나중에 실행하도록 예약합니다(Passive).

이 전체 과정은 세 가지를 보장합니다. **원자성** — 중간 상태는 사용자에게 노출되지 않습니다. **순서 보장** — 각 단계에서 DOM의 상태와 `root.current`의 상태가 정확히 예측 가능합니다. **메모리 안전성** — 삭제된 객체들이 순환 참조로 메모리에 남지 않습니다.

개발자 관점에서 이 지식이 실용적으로 의미하는 바는 다음과 같습니다.

`useLayoutEffect`는 강력하지만 그 강력함이 paint를 블로킹한다는 비용으로 옵니다. DOM 측정이나 "화면에 나타나기 전에 실행되어야 하는 작업"에만 사용하고, 나머지는 `useEffect`로 처리합니다. `componentDidMount`에서 `setState`를 호출하는 패턴은 이중 렌더를 유발하지만 이것이 항상 나쁜 것은 아닙니다. 대신 `useLayoutEffect` + `useState`의 조합으로 동일한 효과를 얻으면서 paint를 한 번으로 줄일 수 있습니다.

그리고 `FiberRoot.current`가 Mutation과 Layout 사이에 교체된다는 사실 — 이 단 하나의 타이밍이 `getSnapshotBeforeUpdate`, `componentDidMount` 내 `setState`, Error Boundary 동작 등 React의 여러 미묘한 동작들의 근거입니다. 왜 그렇게 작동하는지 이상하게 느껴질 때마다, 이 포인터 교체의 타이밍으로 돌아오면 답을 찾을 수 있습니다.

---

다음 편에서는 Concurrent Mode의 핵심 기능인 **Suspense와 데이터 페칭의 내부 메커니즘**을 다룹니다. Promise throw, Suspense 경계의 fallback 전환, 그리고 Streaming SSR에서의 동작까지 분석합니다.

---

*소스 참조: `packages/react-reconciler/src/ReactFiberCommitWork.js`, `packages/react-reconciler/src/ReactFiberWorkLoop.js`, `packages/scheduler/src/forks/Scheduler.js` (react-dom@18.3.1)*