---
title: "React Fiber: 재귀를 루프로 바꾼 아키텍처의 철학"
date: "2025-02-20"
tags: [React, Fiber, Concurrent, Architecture, JavaScript]
series: "React 아키텍처 심층 분석"
---

> **React 아키텍처 심층 분석** 시리즈의 두 번째 글입니다. 1편에서는 React의 패키지 구조가 What/How/When/Where라는 네 가지 질문을 분리하기 위해 설계되었음을 확인했습니다. 이번 편에서는 그 중 "How" — `react-reconciler`의 심장부인 **Fiber 아키텍처**가 왜 이런 형태로 설계되었는지를 탐구합니다.

---

## 1. 멈출 수 없는 렌더링이라는 문제

2017년 이전의 React를 떠올려봅시다. 사용자가 검색창에 글자를 입력합니다. 입력 이벤트가 발생하고, 상태가 갱신되며, 컴포넌트 트리 전체의 재조정(reconciliation)이 시작됩니다. 여기서 결정적인 문제가 있었습니다. 이 재조정은 **한번 시작되면 끝날 때까지 멈출 수 없었습니다.**

당시 React가 사용하던 방식은 Stack Reconciler라고 불립니다. 이름이 모든 것을 설명합니다. 컴포넌트 트리를 탐색하는 방식이 JavaScript의 콜 스택에 의존하는 재귀 호출이었습니다. 컴포넌트를 렌더하기 위해 함수를 호출하고, 그 자식을 렌더하기 위해 또 함수를 호출하는 식으로 스택이 깊게 쌓였습니다.

브라우저는 60fps로 동작하기 위해 16.67ms마다 한 번씩 화면을 그립니다. 이 짧은 시간 안에 레이아웃 계산, 페인팅, 사용자 입력 처리가 모두 이루어져야 합니다. 그런데 수천 개의 컴포넌트를 가진 트리를 재귀로 탐색하면 JavaScript 엔진은 수십 밀리초 동안 재조정만 수행합니다. 그동안 브라우저는 다른 어떤 일도 할 수 없습니다. 화면이 얼어붙고, 입력이 씹히고, 스크롤이 끊기는 것은 이 구조적 한계의 직접적인 결과였습니다.

`requestAnimationFrame`이나 `requestIdleCallback`으로 해결할 수 있을 것처럼 보이지만, 이 API들은 타이밍 문제를 다룰 뿐 근본적인 해결책이 아니었습니다. 일단 시작된 재귀를 중간에 끊는 방법이 없었기 때문입니다. 문제의 본질은 타이밍이 아니라 **작업의 분할 불가능성**에 있었습니다.

---

## 2. 핵심 통찰: 콜 스택이 하던 일을 힙이 대신하면 어떨까

Fiber 아키텍처의 탄생은 하나의 질문에서 시작됩니다. "콜 스택이 렌더링 진행 상태를 추적한다면, 우리가 직접 그 역할을 하는 객체를 만들 수 없을까?"

콜 스택의 각 프레임이 하는 일을 분석해보면 두 가지입니다. 하나는 현재 실행 중인 함수의 지역 변수와 컨텍스트를 보관하는 것이고, 다른 하나는 함수가 끝나면 어디로 돌아갈지(return address)를 기억하는 것입니다. React는 이 두 역할을 힙(heap)에 있는 JavaScript 객체로 대체했습니다. 이것이 FiberNode입니다.

이 전환의 결정적인 차이는 **제어권**입니다. 콜 스택은 JavaScript 엔진이 관리하므로 애플리케이션이 개입할 수 없습니다. 반면 힙의 객체는 우리가 만든 것이므로, "지금 여기까지 했으니 잠시 브라우저에 제어권을 돌려주자"고 언제든 결정할 수 있습니다.

이 원리 덕분에 트리 탐색이 깊은 재귀에서 단순한 while 루프로 변환됩니다.

```javascript
// Concurrent 실행 경로
function workLoopConcurrent() {
  while (workInProgress !== null && !shouldYield()) {
    performUnitOfWork(workInProgress);
  }
}
```

`!shouldYield()` — 이 단 하나의 조건절 차이가 React Concurrent Mode 전체를 가능하게 합니다. 매 반복마다 "브라우저에 제어권을 돌려줘야 하는가?"를 확인하고, 그렇다면 루프를 빠져나옵니다. `workInProgress` 변수에 "다음에 처리해야 할 Fiber"가 저장되어 있으므로, 나중에 루프를 재시작하면 정확히 멈춘 지점부터 이어갈 수 있습니다. 재귀로는 절대 불가능했던 일이 루프와 힙 객체의 조합으로 가능해집니다.

"Fiber"라는 이름이 붙은 이유도 여기에 있습니다. 운영체제 이론에서 Fiber는 스레드보다 가벼운, 사용자 공간에서 협력적으로 스케줄링되는 실행 단위입니다. React의 Fiber는 "렌더링이라는 실행 컨텍스트를 작은 단위로 분해하고, 협력적으로 스케줄링한다"는 동일한 개념을 JavaScript 런타임 위에 구현한 것입니다.

---

## 3. 5ms라는 숫자의 의미

`shouldYield()`는 기본적으로 5ms를 기준으로 양보 여부를 결정합니다. 왜 5ms인가?

60fps 기준 한 프레임은 16.67ms입니다. 120fps 디스플레이에서는 8.33ms입니다. React가 5ms를 사용하면 나머지 시간으로 브라우저가 레이아웃과 페인트를 처리할 수 있습니다. 5ms는 60fps와 120fps 모두에서 유효한 균형점입니다. 여기에 더해, 최신 브라우저의 `navigator.scheduling.isInputPending()` API와 연동하면 5ms가 지나지 않았어도 사용자 입력이 대기 중이면 즉시 양보합니다.

작업 재개 시 React는 `MessageChannel`을 통해 다음 작업을 예약합니다. 이 선택도 의도적입니다. `setTimeout(fn, 0)`은 HTML 스펙에 의해 중첩 호출 시 최소 4ms 지연이 강제됩니다. 5ms 타임슬라이스에서 4ms 오버헤드는 낭비입니다. `requestIdleCallback`은 Safari 미지원이고 무기한 지연이 가능합니다. `requestAnimationFrame`은 16.67ms 주기에 묶입니다. `MessageChannel`만이 최소 지연으로 태스크 큐에 작업을 등록할 수 있습니다.

---

## 4. FiberNode: 각 필드의 존재 이유

FiberNode는 컴포넌트 하나를 표현하는 JavaScript 객체입니다. 대략 27개의 필드를 가지며, 이 필드들은 몇 가지 범주로 분류됩니다.

**인스턴스 식별 필드**(`tag`, `key`, `type`)는 이 Fiber가 무엇인지를 설명합니다. `tag`는 함수 컴포넌트인지, 클래스 컴포넌트인지, DOM 엘리먼트인지를 숫자 상수로 나타냅니다. `key`는 목록 재조정 시 동일성을 판단하는 기준입니다.

**트리 구조 필드**(`return`, `child`, `sibling`)는 Fiber들을 연결합니다. 특히 `return` 포인터의 이름이 의미심장합니다. "parent"가 아닌 "return"인 이유는, 이 포인터가 콜 스택에서 함수가 끝난 후 돌아갈 주소(return address)와 동일한 역할을 하기 때문입니다.

**Props와 State 필드**에서 흥미로운 점은 props가 두 벌 존재한다는 것입니다. `pendingProps`는 "이 props로 렌더하라"는 명령이고, `memoizedProps`는 "마지막으로 화면에 반영된 props"입니다. Concurrent Mode에서 렌더가 중단될 수 있기 때문에 이 둘이 분리되어야 합니다. 렌더 중단 시 `pendingProps`는 보존되고 `memoizedProps`는 그대로 남아 화면이 이전 상태를 유지합니다. `pendingProps === memoizedProps`라면 업데이트가 필요 없다는 신호입니다.

함수형 컴포넌트에서 `memoizedState`는 훅들의 연결 리스트 헤드를 가리킵니다. `useState`가 첫 번째 노드, `useEffect`가 두 번째 노드, `useMemo`가 세 번째 노드 식으로 이어집니다. 이것이 "Hook은 항상 같은 순서로 호출되어야 한다"는 규칙의 실제 이유입니다. 이름이 아닌 호출 순서로 연결 리스트를 탐색하기 때문에, 조건문 안에서 Hook을 호출하면 연결 리스트의 순서가 어긋납니다.

**이펙트 필드**(`flags`, `subtreeFlags`)는 비트마스크로 표현됩니다. `flags`는 이 Fiber에 필요한 작업을 비트로 표현합니다. DOM 삽입, 갱신, 삭제, ref 갱신 등이 각각 다른 비트입니다. `subtreeFlags`는 하위 트리 전체의 flags를 합산한 것입니다. Commit Phase에서 `subtreeFlags`가 0인 가지를 통째로 건너뛸 수 있습니다. 1000개 컴포넌트 중 3개만 변경되었다면, 997개의 서브트리를 방문할 필요가 없습니다.

---

## 5. LCRS Tree: 세 개의 포인터로 N-ary 트리를 표현하는 방법

Fiber 트리의 구조는 컴퓨터 과학에서 **LCRS Tree(Left-Child Right-Sibling Tree)**라고 부르는 고전적 표현법을 사용합니다. 임의 개수의 자식을 가진 트리를, 각 노드가 최대 두 개의 포인터만 갖는 이진 트리로 변환하는 기법입니다.

직관적으로 설명하면 이렇습니다. 어떤 컴포넌트가 세 개의 자식을 갖는다고 할 때, 부모는 첫째 자식만 `child` 포인터로 직접 가리킵니다. 첫째 자식은 둘째 자식을 `sibling` 포인터로 가리키고, 둘째 자식은 셋째 자식을 `sibling` 포인터로 가리킵니다. 모든 노드는 `return` 포인터로 자신의 부모를 가리킵니다.

이 구조 덕분에 스택 없이도 전체 트리를 DFS로 방문하는 알고리즘이 단순해집니다. 자식이 있으면 자식으로 내려가고, 자식이 없으면 형제를 확인하고, 형제가 없으면 `return` 포인터를 따라 부모로 올라갑니다. 콜 스택이 자동으로 해주던 "어디로 돌아갈지"를 `return` 포인터가 명시적으로 기록하는 것입니다.

---

## 6. beginWork와 completeWork: 내려가고 올라오는 두 단계

Fiber 트리 탐색은 두 단계로 이루어집니다. **beginWork**는 트리를 내려가면서 각 Fiber를 처리하고, **completeWork**는 올라오면서 결과를 조립합니다.

beginWork는 각 Fiber의 `tag`에 따라 서로 다른 처리 함수로 분기합니다. 함수 컴포넌트라면 훅을 실행하고 JSX를 평가합니다. DOM 엘리먼트라면 새로운 props를 이전 props와 비교합니다. 그리고 가장 중요하게, "이 Fiber를 실제로 렌더해야 하는가?"를 판단합니다.

props가 변경되지 않았고, 예약된 업데이트도 없고, Context도 바뀌지 않았다면 React는 **bailout**을 수행합니다. 해당 Fiber와 그 하위 트리 전체를 건너뜁니다. `React.memo`, `PureComponent`, `useMemo`는 모두 이 bailout 경로를 활성화하기 위한 도구들입니다. 빠른 것이 아니라, 불필요한 작업을 아예 하지 않는 것입니다.

completeWork는 실제 DOM 노드를 생성하는 단계입니다. 그러나 아직 실제 DOM 트리에 삽입하지는 않습니다. 메모리상에 완전한 DOM 서브트리를 조립하지만, 화면에는 반영하지 않습니다. 이것이 Render Phase(순수 계산)와 Commit Phase(부수효과 실행)를 물리적으로 구분하는 경계입니다.

completeWork의 또 다른 핵심 역할은 `subtreeFlags` 버블링입니다. 자식 Fiber의 flags를 부모로 합산하면서 올라옵니다. 이 덕분에 루트에서 내려다보면 변경이 있는 가지와 없는 가지를 한눈에 알 수 있습니다.

---

## 7. 자식 조정: key가 있어야 하는 진짜 이유

컴포넌트가 렌더링을 마치면 React는 이전에 렌더된 자식들과 새로 렌더된 자식들을 비교해야 합니다. 이 과정을 자식 조정(child reconciliation)이라고 부릅니다.

단일 자식의 경우, React는 key와 type을 순서대로 비교합니다. key가 같고 type도 같으면 기존 Fiber를 재사용합니다. DOM 노드를 새로 만들지 않고, 기존 DOM 노드에 새 props를 적용하는 방식입니다. type이 다르다면, key가 같더라도 기존 Fiber를 폐기하고 새로 만듭니다.

배열 자식의 경우가 흥미롭습니다. React는 두 번의 패스(pass)로 처리합니다. 첫 번째 패스에서는 앞에서부터 순서대로 비교합니다. key가 불일치하는 순간 멈춥니다. 두 번째 패스에서는 남은 기존 자식들을 Map에 넣고 key로 빠르게 탐색합니다.

key 없이는 인덱스를 key로 사용합니다. 목록 중간에 아이템을 삽입하거나 삭제하면 그 이후의 모든 아이템의 인덱스가 바뀝니다. Map 탐색에서 "인덱스 1번"이라는 key는 이제 다른 아이템을 가리키므로, 기존 Fiber를 재사용하지 못하고 모두 새로 만들게 됩니다. key를 `item.id`처럼 실제 고유 식별자로 지정하면 인덱스가 바뀌어도 Map에서 올바른 Fiber를 찾아 재사용할 수 있습니다.

위치가 변경된 아이템을 판단하는 방식도 흥미롭습니다. `lastPlacedIndex`라는 변수를 추적하면서, 재사용하는 기존 Fiber의 원래 인덱스가 이 값보다 크면 제자리, 작으면 이동 필요로 판단합니다. 이 알고리즘 덕분에 `[A, B, C, D]`에서 `[A, C, B, D]`로 변경될 때 B 하나만 이동하면 되고, C와 D는 제자리임을 알 수 있습니다.

---

## 8. UpdateQueue: 원형 연결 리스트가 선택된 이유

`setState`를 호출하면 상태가 즉시 변경되는 것이 아닙니다. Update 객체가 생성되어 해당 Fiber의 UpdateQueue에 삽입됩니다. 이 큐는 원형 연결 리스트로 구현되어 있습니다.

원형 연결 리스트를 선택한 이유는 head와 tail을 모두 O(1)으로 접근하기 위해서입니다. 일반적인 연결 리스트는 tail을 O(1)으로 접근하려면 별도의 tail 포인터가 필요합니다. 원형 연결 리스트에서는 `pending` 하나만 유지하면 됩니다. `pending`은 항상 tail을 가리키고, `pending.next`는 head를 가리킵니다. 새 업데이트를 삽입할 때는 기존 tail의 next(head)를 새 업데이트의 next로 설정하고, 새 업데이트를 새 tail로 만들면 됩니다. 항상 O(1)입니다.

Concurrent Mode에서 업데이트에는 우선순위(Lane)가 부여됩니다. 높은 우선순위의 렌더링 중에 낮은 우선순위 업데이트는 건너뜁니다. 그런데 업데이트를 건너뛸 때 중요한 문제가 생깁니다. 업데이트 A, B, C가 있고 B를 건너뛰면, 1차 렌더에서 A→C 순서로 적용되고 2차 렌더에서 A→B→C 순서로 적용됩니다. 결과가 달라질 수 있습니다.

이를 해결하기 위해 React는 첫 번째로 건너뛰는 업데이트가 발생할 때의 상태를 스냅샷으로 저장해둡니다. 2차 렌더는 이 스냅샷에서 시작해 건너뛴 업데이트부터 다시 적용합니다. 건너뛴 이후의 업데이트들도 baseQueue에 복사해두어 순서 의존성을 보장합니다. 우선순위와 무관하게 최종 결과가 항상 결정론적이어야 하기 때문입니다.

---

## 9. Lane 시스템: 우선순위를 비트로 표현하는 이유

Lane은 업데이트의 우선순위를 표현하는 비트마스크입니다. 이전 버전의 Expiration Time 방식을 대체했습니다.

Expiration Time 방식에서는 각 업데이트에 "이 시간까지 처리해야 한다"는 숫자를 부여했습니다. 우선순위가 높을수록 만료 시간이 가깝습니다. 그런데 이 방식은 중요한 문제가 있었습니다. "여러 업데이트를 묶어서 처리"(batching)하려면 만료 시간이 같아야 하는데, 서로 다른 시점에 발생한 업데이트들의 만료 시간을 인위적으로 같게 맞추기 어려웠습니다.

Lane은 각 업데이트를 비트 하나로 표현합니다. 여러 업데이트를 함께 처리하려면 비트를 OR 연산으로 합치면 됩니다. 특정 우선순위의 업데이트만 처리하려면 AND 연산으로 마스킹합니다. 어떤 업데이트가 이미 처리되었는지 확인하려면 비트가 설정되어 있는지만 보면 됩니다. 모든 연산이 단순한 비트 연산입니다.

이벤트 종류에 따라 다른 Lane이 부여됩니다. `click`이나 `keydown`처럼 사용자 응답에 민감한 이벤트는 SyncLane을 받아 즉시 처리됩니다. `mousemove`나 `scroll`처럼 연속으로 발생하는 이벤트는 InputContinuousLane을 받습니다. `setTimeout`이나 `fetch` 콜백처럼 백그라운드 작업은 DefaultLane을 받습니다. `startTransition` 안의 업데이트는 TransitionLane을 받아 가장 낮은 우선순위로 처리됩니다.

`setState`를 호출하면 해당 Fiber의 `lanes` 필드에 새 Lane이 추가되고, 이 정보가 `return` 포인터를 따라 루트까지 전파됩니다. 부모 Fiber들의 `childLanes` 필드에도 같은 Lane이 추가됩니다. 이 덕분에 beginWork에서 "이 서브트리에 처리할 업데이트가 있는가?"를 `childLanes`를 보고 즉시 판단할 수 있습니다.

---

## 10. 더블 버퍼링: GPU에서 빌려온 설계

Fiber 아키텍처에서 가장 우아한 설계 중 하나입니다.

GPU 렌더링에서 더블 버퍼링은 화면 깜빡임을 방지합니다. 모니터가 현재 표시 중인 **Front Buffer**와 GPU가 다음 프레임을 준비하는 **Back Buffer**가 별도로 존재합니다. 다음 프레임 준비가 완료되면 포인터를 교체합니다. 화면은 항상 완성된 버퍼만 보이므로 중간 상태가 노출되지 않습니다.

React는 이 원리를 Fiber 트리에 적용합니다. 현재 화면에 표시된 트리를 **current 트리**, 다음 상태를 계산 중인 트리를 **workInProgress 트리**라고 부릅니다. 두 트리의 Fiber들은 `alternate` 포인터로 서로 연결됩니다. `current.alternate = workInProgress`, `workInProgress.alternate = current`입니다.

커밋이 완료되면 `FiberRoot.current` 포인터를 workInProgress 트리로 교체합니다. 포인터 교체 한 번으로 전체 트리가 전환됩니다. GPU의 버퍼 스왑과 정확히 같은 원리입니다.

객체 재사용의 이점도 있습니다. 다음 렌더링 때는 새 객체를 만드는 대신 이전 렌더에서 사용했던 객체를 재사용하고 필드만 갱신합니다. 이는 두 가지 효과를 가집니다. 첫째, V8 GC 압력을 줄입니다. 매 렌더마다 수천 개의 객체를 새로 만들면 Young Generation에 단명 객체가 쏟아져 Minor GC가 빈번하게 발동합니다. 둘째, bailout 비교가 쉬워집니다. `alternate.memoizedProps`를 현재 `pendingProps`와 비교하는 것만으로 변경 여부를 알 수 있습니다.

---

## 11. Commit Phase: 원자적이어야 하는 이유

Render Phase가 "무엇을 바꿀지 계산하는" 단계라면, Commit Phase는 "실제로 바꾸는" 단계입니다. 결정적인 차이가 있습니다. Render Phase는 중단될 수 있지만, **Commit Phase는 절대 중단되지 않습니다.**

이유는 원자성(atomicity) 때문입니다. 데이터베이스 트랜잭션이 완료되거나 완전히 취소되거나 둘 중 하나여야 하듯, DOM 변경도 중간 상태가 화면에 노출되어서는 안 됩니다. 컴포넌트 A의 DOM을 변경하고 B는 아직 변경하지 않은 상태에서 브라우저가 화면을 그린다면, 두 컴포넌트가 불일치하는 상태가 노출됩니다.

Commit Phase는 세 단계로 나뉩니다.

**Before Mutation 단계**에서는 DOM이 변경되기 직전 스냅샷을 읽습니다. 클래스 컴포넌트의 `getSnapshotBeforeUpdate`가 여기서 호출됩니다. 스크롤 위치처럼 DOM 변경 전에 캡처해야 하는 값들을 이 단계에서 기록합니다.

**Mutation 단계**에서는 실제 DOM이 변경됩니다. 새 노드가 삽입되고, 기존 노드의 속성이 업데이트되고, 불필요한 노드가 제거됩니다. `subtreeFlags`를 활용해 변경이 있는 노드만 방문합니다. 이 단계의 중간에 `FiberRoot.current`가 workInProgress 트리로 교체됩니다. `useEffect` cleanup 함수가 "이전 상태를 기준으로" 동작하도록 이 타이밍을 정교하게 설계한 것입니다.

**Layout 단계**에서는 DOM 변경이 완료된 직후, 브라우저가 화면을 그리기 전에 실행됩니다. `componentDidMount`, `componentDidUpdate`, `useLayoutEffect`가 여기서 실행됩니다. `getBoundingClientRect()`처럼 최신 DOM 상태를 읽는 작업은 이 단계에서 해야 정확합니다.

Commit Phase가 끝나면 브라우저가 화면을 그립니다. 그 이후에 `useEffect`가 비동기로 실행됩니다. `useLayoutEffect`와 `useEffect`의 타이밍 차이는 이 설계에서 직접 유래합니다.

---

## 12. V8 최적화와 FiberNode 생성자의 관계

FiberNode 생성자에서 모든 필드를 반드시 초기화하는 것은 단순한 관례가 아닙니다. V8 엔진의 **Hidden Class** 최적화를 위해서입니다.

V8은 JavaScript 객체의 구조를 추적하기 위해 Hidden Class를 사용합니다. 동일한 순서로 동일한 필드를 가진 객체들은 같은 Hidden Class를 공유합니다. V8은 이를 통해 프로퍼티 접근 코드를 특수화하여 매우 빠르게 실행합니다. 수십만 개의 Fiber 객체가 모두 같은 Hidden Class를 공유하면 프로퍼티 접근이 극도로 최적화됩니다.

반대로 객체 생성 후 새 필드를 추가하거나, 같은 필드를 다른 순서로 초기화하면 다른 Hidden Class가 생성됩니다. Fiber 객체들이 서로 다른 Hidden Class를 갖게 되면 V8은 최적화를 포기하고 범용적인 방법으로 프로퍼티를 읽게 됩니다.

2019년 V8 팀은 실제로 이 문제와 관련한 React 성능 이슈를 공개했습니다. 타이밍 정보를 기록하는 두 필드(`actualDuration`, `actualStartTime`)가 처음에는 정수 0으로 초기화되었다가, 나중에 `performance.now()`의 부동소수점 값이 할당되었습니다. V8은 정수(Smi)와 부동소수점(Double)을 내부적으로 다르게 표현하므로, 타입이 바뀌면 Hidden Class를 변경해야 합니다. 수십만 개의 Fiber마다 이 변환이 일어나면서 각각 다른 Hidden Class가 만들어졌고, 성능이 크게 저하되었습니다.

해결책은 간단했습니다. 처음부터 `Number.NaN`으로 초기화하여 V8이 즉시 Double 표현을 사용하도록 강제하는 것입니다. 나중에 실제 부동소수점 값이 할당되어도 Hidden Class가 변경되지 않습니다. 라이브러리 설계 결정이 언어 런타임의 내부 구현까지 고려해야 한다는 것을 보여주는 사례입니다.

---

## 13. Concurrent Features의 토대

지금까지 살펴본 Fiber의 구조적 특성들이 합쳐져서 React의 Concurrent Features를 가능하게 합니다.

**`startTransition`**은 특정 상태 업데이트를 낮은 우선순위(TransitionLane)로 표시합니다. 높은 우선순위 업데이트(사용자 입력)가 들어오면 진행 중인 Transition 렌더가 중단되고, 입력이 즉시 처리됩니다. Transition 렌더는 처음부터 다시 시작합니다. 중단과 재개가 가능한 것은 workInProgress 트리가 항상 current 트리와 별도로 존재하고, `shouldYield()`로 루프를 제어할 수 있기 때문입니다.

**`Suspense`**는 `throw`와 `catch`를 재해석한 것입니다. 데이터가 준비되지 않았을 때 컴포넌트가 Promise를 throw합니다. React는 `return` 포인터를 따라 올라가면서 가장 가까운 Suspense 컴포넌트를 찾습니다. 그 Suspense의 `fallback`을 대신 렌더하고, Promise가 resolve되면 원래 서브트리를 다시 시도합니다. `return` 포인터로 연결된 Fiber 트리가 없었다면 이 탐색이 불가능했습니다.

**Render Phase의 순수성**이 이 모든 것을 뒷받침합니다. Render Phase는 중단되고 재시작될 수 있으므로, 부수효과가 없어야 합니다. `React.StrictMode`가 개발 모드에서 컴포넌트를 의도적으로 두 번 렌더하는 것은 이 순수성을 위반하는 코드를 조기에 발견하기 위함입니다.

---

## 14. 업데이트에서 화면까지: 전체 흐름의 연결

지금까지 살펴본 각 조각들이 실제로 어떻게 연결되는지 정리합니다.

사용자가 버튼을 클릭하면 `setState`가 호출됩니다. 이벤트 종류에 따라 적절한 Lane이 선택되고(클릭은 SyncLane), Update 객체가 해당 Fiber의 UpdateQueue에 삽입됩니다. Lane 정보가 `return` 포인터를 따라 루트까지 버블링됩니다.

React는 이 업데이트를 처리할 작업을 스케줄러에 등록합니다. SyncLane이라면 마이크로태스크로 즉시, TransitionLane이라면 일반 태스크로 예약합니다. 스케줄러가 작업을 시작하면 `workLoopSync` 또는 `workLoopConcurrent`가 실행됩니다.

루트 Fiber부터 시작해 beginWork로 내려갑니다. 각 Fiber마다 bailout 여부를 판단합니다. 변경이 없는 서브트리는 건너뜁니다. 변경이 있는 Fiber는 렌더링하고 자식 Fiber들을 조정합니다. 잎 노드에 도달하면 completeWork로 올라옵니다. DOM 노드를 생성하고 subtreeFlags를 버블링합니다.

모든 Fiber를 처리하면 workInProgress 트리가 완성됩니다. Commit Phase에 진입합니다. Before Mutation → Mutation(DOM 변경, current 트리 교체) → Layout(useLayoutEffect) 순서로 처리합니다. 브라우저가 화면을 그리고 나면 비동기로 useEffect가 실행됩니다.

---

## 설계 철학의 일관성

Fiber 아키텍처를 관통하는 하나의 철학이 있습니다. **제어권을 되찾아라.**

콜 스택이 렌더링의 제어권을 가져갔을 때, 브라우저는 아무것도 할 수 없었습니다. Fiber는 렌더링 상태를 힙 객체로 옮겨 React가 제어권을 가지도록 했습니다. 제어권이 있으니 중단할 수 있고, 재개할 수 있고, 우선순위를 바꿀 수 있습니다.

더블 버퍼링은 중간 상태로부터 화면을 보호합니다. 순수한 Render Phase와 커밋되는 Commit Phase의 분리는 재시작의 안전성을 보장합니다. subtreeFlags와 childLanes의 버블링은 불필요한 탐색을 제거합니다. 원형 연결 리스트는 O(1) 업데이트 삽입을 보장합니다.

각 결정이 독립적으로 보이지만, 모두 "중단 가능하고, 우선순위를 가지며, 효율적인 렌더링"이라는 하나의 목표를 향합니다. 이것이 Fiber가 단순한 성능 최적화를 넘어 **아키텍처적 선택**인 이유입니다.

---

## 다음 편 예고: Hooks, 연결 리스트 위의 마법

이 글에서 우리는 `memoizedState`가 Hook 연결 리스트의 헤드를 가리킨다는 것을 확인했습니다. 다음 편에서는 **Hooks 시스템**의 내부로 들어갑니다. `useState`를 호출하면 Dispatcher가 어떻게 교체되는지, Mount와 Update에서 서로 다른 구현체가 왜 필요한지, Eager State 최적화가 어떻게 작동하는지를 탐구합니다.

---

> **React 아키텍처 심층 분석 시리즈**
> 1. 패키지 계층 구조
> 2. **Fiber 아키텍처** ← 현재 글
> 3. Hooks 시스템
> 4. Lane 스케줄링
> 5. 렌더링 사이클과 Commit Phase

---

*참조: React 소스 코드 (v19), packages/react-reconciler/src/, V8 블로그 "The story of a V8 performance cliff in React"*