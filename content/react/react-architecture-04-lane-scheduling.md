---
title: "React는 어떻게 32비트로 세상을 조율하는가 — Lane 스케줄링의 설계 철학"
date: "2025-02-20"
tags: [React, Concurrent Mode, Scheduler, Lane, 성능최적화]
series: "React 아키텍처 심층 분석"
---

> **React 아키텍처 심층 분석** 시리즈의 네 번째 글입니다. [3편](./react-architecture-03-hooks-system.md)에서 Hooks가 Fiber 위에서 연결 리스트로 상태를 관리하는 방식을 추적했습니다. 이번 편에서는 React가 왜, 그리고 어떻게 32비트 정수 하나로 수십 개의 독립 업데이트를 조율하는지 — 그 설계 철학의 뿌리부터 실제 동작 원리까지 탐구합니다.

---

## 우선순위를 숫자로 표현하면 무슨 문제가 생기는가

소프트웨어 시스템에서 "우선순위"를 표현하는 가장 자연스러운 방법은 숫자입니다. 큰 값이면 높은 우선순위, 혹은 그 반대. 운영체제 스케줄러도, 작업 큐도 대부분 이렇게 시작합니다. React 역시 마찬가지였습니다.

React 16의 Fiber 재작성과 함께 도입된 Concurrent Mode의 첫 번째 우선순위 시스템은 **Expiration Time**이었습니다. 각 업데이트에 `현재 시각 + 허용 지연`으로 만료 시간을 부여하고, 숫자가 작을수록 더 급한 업데이트로 취급했습니다. 직관적이고 구현도 간단했습니다.

그런데 Concurrent Mode가 실제로 하고 싶은 일을 생각해보면 문제가 보입니다. Concurrent Mode의 핵심 약속은 "여러 업데이트가 동시에, 독립적으로 진행될 수 있다"는 것입니다. 탭을 전환하는 도중에 또 다른 탭으로 바꿀 수 있어야 하고, 검색어를 타이핑하면서 백그라운드에서 무거운 목록이 렌더링되고 있어야 합니다.

그런데 단일 숫자로는 "지금 어떤 업데이트들이 동시에 진행 중인가"를 표현할 수 없습니다. 숫자는 상태의 스냅샷 하나만 담을 수 있기 때문입니다. 이것은 마치 여러 악기가 동시에 연주되는 오케스트라 상태를 단 하나의 음표로 표기하려는 것과 같습니다.

구체적인 실패 시나리오를 떠올려보면 이해가 됩니다. 사용자가 탭 A로 전환하는 `startTransition`을 실행했는데, 렌더링이 절반쯤 진행되던 중 탭 B로 다시 전환하기로 마음을 바꿉니다. React는 탭 A의 렌더 결과를 버리고 탭 B를 처음부터 렌더해야 합니다. 그런데 Expiration Time 방식에서는 두 Transition이 동일한 타임스탬프 범위 안에 있으면 "같은 작업"으로 묶여버렸습니다. 서로 다른 탭 전환을 구별할 열쇠가 없었던 것입니다.

여기에 더해 배치 처리 로직도 임의적이었습니다. "250ms 이내 업데이트는 같이 처리한다"는 임계값은 자의적이었고, 다양한 엣지 케이스를 만들어냈습니다. React 팀은 2020년, 이 모든 문제를 해결하기 위해 완전히 다른 접근법으로 전환했습니다. 바로 **Lane 비트마스크**입니다.

---

## 비트마스크가 가져온 패러다임 전환

Lane 시스템의 핵심 인사이트는 단순하지만 강력합니다. 우선순위를 하나의 숫자가 아닌 **비트 집합**으로 표현하면, 여러 업데이트가 동시에, 독립적으로 존재할 수 있습니다.

32비트 정수는 32개의 독립 비트를 가집니다. 각 비트 위치를 하나의 "레인"으로 사용하면, 단 하나의 변수만으로 "현재 이 레인들의 업데이트가 동시에 진행 중"이라는 상태를 완벽하게 표현할 수 있습니다. 고속도로를 상상해보면 좋습니다. Expiration Time은 도로 위의 차 한 대 속도를 숫자로 나타낸 것이고, Lane은 고속도로의 각 차선이 사용 중인지 아닌지를 한 번에 보여주는 신호판입니다.

React 18은 이 아이디어를 정교하게 구체화했습니다. 31개의 비트 위치(0번~30번)에 각각의 우선순위 의미를 부여했는데, 비트 위치가 낮을수록 더 높은 우선순위입니다. 가장 낮은 비트(bit 0)가 가장 긴급한 SyncHydrationLane이고, 가장 높은 비트들이 백그라운드 Idle 작업에 해당합니다.

이 구조 덕분에 React는 `root.pendingLanes`라는 단 하나의 정수만 보고도 "지금 어떤 우선순위의 업데이트들이 대기 중인가"를 즉시 파악합니다. 여러 Lane이 동시에 켜져 있으면 여러 종류의 업데이트가 동시에 진행 중이라는 의미입니다.

Lane은 크게 다섯 그룹으로 나뉩니다. 가장 높은 우선순위인 **SyncLane**은 버튼 클릭, 키 입력처럼 사용자가 즉각적인 반응을 기대하는 이산적(discrete) 이벤트에 할당됩니다. 그 다음 **InputContinuousLane**은 드래그, 스크롤처럼 연속적으로 발생하는 이벤트를 담당합니다. **DefaultLane**은 이벤트 핸들러 밖에서 발생하는 일반 `setState`에 사용됩니다. **TransitionLane**은 16개의 레인 풀로 구성되어 있으며 `startTransition`으로 표시된 비긴급 업데이트에 배정됩니다. 마지막으로 **IdleLane**과 **OffscreenLane**은 브라우저가 완전히 한가할 때만 처리해도 되는 백그라운드 작업에 쓰입니다.

---

## 최고 우선순위를 찾는 아름다운 연산

Lane 시스템에서 가장 자주 사용되는 연산 중 하나는 "현재 대기 중인 Lane들 중 가장 높은 우선순위, 즉 가장 낮은 비트 위치의 Lane을 하나 추출하는 것"입니다. React는 이 작업을 놀라울 만큼 단순한 방식으로 구현합니다.

2의 보수(Two's Complement) 표현법에는 재미있는 성질이 있습니다. 어떤 정수 `n`에 대해 `n & -n`을 계산하면, 정확히 `n`의 가장 낮은 비트 하나만 남습니다. 비트 연산 특성상 이 과정에서 분기(if문)는 전혀 필요하지 않습니다. 단 하나의 AND 연산으로 완성됩니다.

```javascript
function getHighestPriorityLane(lanes) {
  return lanes & -lanes;
}
```

이 코드에서 핵심은 `-lanes`가 2의 보수, 즉 `~lanes + 1`이라는 점입니다. 예를 들어 SyncLane(값 2)과 DefaultLane(값 32)이 동시에 대기 중이라면 `pendingLanes = 34`입니다. `34 & -34`를 계산하면 정확히 `2`, 즉 SyncLane만 남습니다. 매 렌더 사이클마다 수백 번 호출되는 핫 패스에서 분기 없는 단일 연산은 의미 있는 성능 차이를 만들어냅니다.

---

## React가 다음에 무엇을 처리할지 결정하는 방법

`getNextLanes`는 React가 다음 렌더링 사이클에서 어떤 Lane을 처리할지 결정하는 알고리즘입니다. 이 함수의 설계는 Lane 시스템의 정교함이 집약된 곳이기도 합니다.

결정 과정은 여러 단계를 거칩니다. 먼저 대기 중인 Lane들을 확인하고, 그 중 Suspense 때문에 블로킹된 것들을 제외합니다. Suspense로 블로킹된 Lane은 Promise가 resolve되어 "핑(ping)"을 받기 전까지는 처리할 수 없기 때문입니다. Idle보다 높은 우선순위 작업이 있다면 Idle보다 먼저 처리합니다.

여기서 흥미로운 부분은 인터럽트 판단 로직입니다. 현재 렌더가 진행 중인 상황에서 새로운 업데이트가 들어오면, 기존 렌더를 중단해야 할까요? React의 대답은 "항상 그런 건 아닙니다"입니다.

새 업데이트의 우선순위가 현재 진행 중인 작업보다 낮거나 같다면, 굳이 중단할 이유가 없습니다. 특히 흥미로운 예외 규칙이 하나 있습니다. 일반 `setState`가 발생해서 DefaultLane이 추가되더라도, 이미 TransitionLane 렌더링이 진행 중이라면 이를 인터럽트하지 않습니다. DefaultLane 업데이트는 Transition 렌더가 끝난 뒤 함께 반영될 수 있기 때문입니다. 쓸데없는 중단을 피해 렌더링 효율을 높이는 섬세한 설계입니다.

이 외에도 `getNextLanes`는 InputContinuousLane 처리 시 DefaultLane을 배치로 묶는 최적화, 그리고 Entanglement(아래에서 설명)를 반영하는 처리를 수행합니다.

---

## setState가 어떤 Lane을 받는지 결정하는 순간

`setState`를 호출하는 순간, React는 이 업데이트가 얼마나 급한지 판단해야 합니다. 이 판단을 담당하는 함수가 `requestUpdateLane`입니다.

가장 먼저 확인하는 것은 현재 컨텍스트입니다. Legacy Mode(`ReactDOM.render`)라면 무조건 SyncLane입니다. Concurrent Mode라면 여러 가능성을 순서대로 확인합니다.

현재 `startTransition` 블록 안에서 실행 중이라면 TransitionLane을 할당합니다. `flushSync`처럼 명시적으로 우선순위를 강제한 컨텍스트라면 그 우선순위를 따릅니다. 그 어느 것도 아니라면, React는 현재 처리 중인 DOM 이벤트 타입을 보고 우선순위를 추론합니다.

DOM 이벤트 타입과 Lane의 대응 관계는 직관적입니다. `click`, `keydown`, `mousedown`처럼 사용자가 즉각적인 반응을 기대하는 이산 이벤트는 SyncLane을 받습니다. `mousemove`, `scroll`, `drag`처럼 연속으로 발생하는 이벤트는 InputContinuousLane을 받습니다. 그리고 `setTimeout`이나 `Promise.then` 안에서 발생하는 `setState`처럼 이벤트 핸들러 밖에서 호출되는 경우는 DefaultLane을 받습니다.

이 설계의 핵심은 "사용자가 기대하는 반응 속도"를 시스템이 자동으로 추론한다는 점입니다. 개발자가 매번 우선순위를 명시하지 않아도, React가 맥락을 읽고 적절한 레인을 결정합니다.

---

## Transition은 왜 16개의 레인이 필요한가

`startTransition`을 호출할 때마다 React는 16개의 TransitionLane 풀에서 레인 하나를 순환 방식(round-robin)으로 할당합니다. 그런데 왜 굳이 16개나 될까요?

탭 전환 시나리오를 다시 떠올려봅시다. 사용자가 탭 A로 전환하는 Transition을 시작했는데, 렌더가 완료되기 전에 탭 B로 전환하는 Transition을 또 시작합니다. 만약 두 Transition이 같은 Lane을 사용한다면, React는 이 두 작업을 구별할 수 없습니다. 탭 A 렌더를 버리고 탭 B를 처음부터 시작해야 하는지, 아니면 탭 A를 완료한 뒤 탭 B를 처리해야 하는지 알 방법이 없습니다.

서로 다른 Lane을 배정받으면 이야기가 달라집니다. TransitionLane1이 탭 A 전환 중이라는 것을 알고, TransitionLane2가 탭 B로의 전환임을 별도로 추적할 수 있습니다. 새 Transition이 들어오면 이전 Transition의 렌더를 인터럽트하고 새 Lane으로 다시 시작할 수 있습니다.

16개라는 숫자는 실용적 타협입니다. 32비트 중 SyncLane, InputContinuous, Default, Retry(5개), Idle, Offscreen 등을 제외하고 남은 비트 중 16개를 Transition에 배정했습니다. 실제 사용 패턴에서 동시에 16개 이상의 서로 다른 Transition이 겹치는 경우는 거의 없고, 풀이 순환되기 전에 이전 Transition들이 완료되는 것이 일반적입니다.

동일한 이벤트 안에서 여러 `startTransition`을 호출하면 어떻게 될까요? React는 하나의 이벤트 안에서는 같은 TransitionLane을 공유합니다. 이벤트가 끝나면 레인 캐시를 초기화하고, 다음 이벤트부터 새 레인을 할당합니다. 이 덕분에 같은 이벤트에서 발생한 여러 Transition은 자연스럽게 하나의 배치로 묶입니다.

---

## childLanes: 변경이 없는 서브트리를 통째로 건너뛰는 비법

React가 전체 컴포넌트 트리를 매번 순회하지 않는다는 것은 알려진 사실입니다. 그런데 어떻게 "이 서브트리 안에는 변경이 없다"는 것을 효율적으로 알 수 있을까요?

비밀은 `childLanes`라는 필드에 있습니다. `setState`가 특정 Fiber에서 발생하면, React는 해당 Fiber의 `lanes`를 업데이트하는 데 그치지 않고, 루트까지의 모든 조상 Fiber의 `childLanes`에도 같은 Lane을 추가합니다. 이 과정을 `markUpdateLaneFromFiberToRoot`라 합니다.

그 결과, 루트 Fiber를 보는 것만으로 "이 트리 안의 어딘가에 N번 레인의 업데이트가 있다"는 사실을 알 수 있습니다. 렌더링 중에 특정 Fiber의 `childLanes`를 현재 렌더링 중인 Lane과 비교했을 때 교집합이 없다면, 그 서브트리 전체를 재귀 없이 즉시 건너뜁니다. 크고 복잡한 트리에서 실제 변경이 발생한 Fiber 하나만을 효율적으로 찾아낼 수 있는 이유입니다.

이 메커니즘은 React의 선택적 렌더링(selective rendering)을 실제로 구현하는 핵심입니다. `React.memo`나 `shouldComponentUpdate` 같은 최적화는 이 위에 추가로 얹힌 레이어이고, 아래에서 `childLanes` 비교가 서브트리 전체를 먼저 거르고 있습니다.

---

## Entanglement: "이 업데이트들은 반드시 함께 화면에 나타나야 한다"

화면에 중간 상태가 노출되는 것은 사용자 경험에 치명적입니다. 목록이 절반만 업데이트된 상태, 버튼은 눌렸는데 스피너가 뜨지 않은 상태 — 이런 순간들은 앱이 깨진 것처럼 보이게 만듭니다.

React의 Entanglement 시스템은 이 문제를 구조적으로 방지합니다. "이 Lane들은 반드시 같은 커밋(commit)에서 함께 처리되어야 한다"는 제약을 시스템 수준에서 강제하는 메커니즘입니다.

탭 전환 시나리오에서 Entanglement가 어떻게 작동하는지 살펴봅시다. 같은 상태를 건드리는 두 Transition이 있을 때 — 탭 A 전환(TransitionLane1)이 진행 중인데 탭 B 전환(TransitionLane2)이 시작되면 — React는 이 두 Lane을 서로 얽습니다. 얽힌 Lane들은 한쪽을 처리할 때 다른 쪽도 반드시 포함해야 합니다. 이 덕분에 탭 A의 절반만 렌더된 중간 상태가 화면에 나타나는 일이 없습니다.

Entanglement에는 전이성(transitivity)이 있습니다. A와 B가 얽혀 있고, B와 C가 얽혀 있다면 A와 C도 자동으로 얽힙니다. `markRootEntangled`는 이 전이적 관계를 매번 계산하여 `entanglements` 배열(각 Lane 인덱스를 키로 쓰는 31개짜리 배열)에 기록합니다.

`useTransition`의 `isPending` 상태도 Entanglement를 활용합니다. `setPending(true)`는 SyncLane으로 즉시 실행되어 사용자에게 로딩 스피너를 바로 보여주고, `setPending(false)`는 실제 콘텐츠 업데이트와 같은 TransitionLane에 얽혀 있어 콘텐츠가 준비되기 전에는 절대 스피너가 사라지지 않습니다. 이 보장을 코드 한 줄로 주입한 것이 아니라, Lane 시스템의 Entanglement 구조로 자연스럽게 달성한다는 점이 설계의 우아함입니다.

---

## 기아(Starvation): 낮은 우선순위 작업이 영원히 밀리지 않도록

Concurrent Mode에서 고우선순위 업데이트가 계속 들어온다면, 낮은 우선순위의 Transition은 언제 처리될까요? 이론적으로는 영원히 밀릴 수 있습니다. 이것이 **기아(Starvation)** 문제입니다.

React는 각 Lane에 만료 시간을 부여하여 이 문제를 해결합니다. 처음 업데이트가 등록될 때는 만료 시간이 없습니다. 그런데 첫 번째 렌더 시도 때 `markStarvedLanesAsExpired`가 호출되면서 카운트다운이 시작됩니다. DefaultLane과 TransitionLane은 5초, SyncLane 계열은 즉시, Idle과 Retry Lane은 만료가 없습니다.

Transition 업데이트가 5초 동안 처리되지 못하고 계속 밀리면, 해당 Lane은 `expiredLanes`로 이동합니다. 만료된 Lane은 다음 번 렌더 결정 시 강제로 선택되며, time-slicing 없이 동기적으로 즉시 완료됩니다. 더 이상 밀릴 수 없습니다.

주목할 부분은 Suspense로 인해 블로킹된 Lane은 타이머가 멈춘다는 점입니다. 데이터가 아직 없어서 렌더를 진행할 수 없는 상태에서 만료 카운트다운을 진행하는 것은 의미가 없기 때문입니다. Promise가 resolve되어 핑을 받으면 그때부터 다시 카운트다운이 시작됩니다.

---

## Concurrent Mode의 심장: 5ms마다 브라우저에 제어권을 돌려주기

React의 Concurrent Mode가 "부드러운 사용자 경험"을 약속할 수 있는 물리적 근거는 **시간 슬라이싱(time-slicing)**입니다. 무거운 렌더링 작업을 5ms짜리 조각으로 잘라서, 각 조각 사이에 브라우저가 화면을 그리고 사용자 입력을 처리할 기회를 줍니다.

60fps를 위해 브라우저는 약 16.67ms마다 한 번씩 화면을 그려야 합니다. React가 이 시간을 독점하면 화면이 버벅입니다. 5ms씩 작업하고 나머지 11ms를 브라우저에 양보하면, 브라우저는 매 프레임을 제때 그릴 수 있습니다.

5ms라는 숫자는 경험적 최적값입니다. 1ms는 너무 짧아서 스케줄링 오버헤드가 실제 작업 시간을 초과합니다. 16ms는 너무 길어서 브라우저가 렌더링 기회를 잃습니다. 5ms는 의미 있는 Fiber 작업량을 처리하면서도 브라우저에 충분한 시간을 남기는 실용적 타협점입니다.

이 시간 제한을 구현하는 `shouldYieldToHost`는 단순합니다. `performance.now()`로 현재 시각을 측정해서 현재 배치가 시작된 이후 5ms가 지났으면 `true`를 반환합니다. 렌더 루프는 매 Fiber 작업 후 이 함수를 확인하고, `true`라면 즉시 루프를 탈출합니다. 탈출한 후에는 자신의 다음 실행 함수(continuation)를 반환하고, Scheduler가 이를 받아 다음 MessageChannel 메시지에서 재개합니다.

---

## MessageChannel: setTimeout이 아닌 이유

비동기 스케줄링을 구현할 때 가장 먼저 떠오르는 도구는 `setTimeout(fn, 0)`입니다. 그런데 React Scheduler는 이 대신 `MessageChannel`을 사용합니다.

이유는 브라우저 스펙에 있습니다. W3C 명세는 `setTimeout`이 5회 이상 중첩 호출되면 최소 4ms의 지연을 강제하도록 규정합니다. 5ms 슬라이스를 목표로 하는데 콜백 대기에만 4ms를 쓴다면, 실제 React 작업에는 1ms밖에 남지 않습니다.

`requestAnimationFrame`은 어떨까요? 이것은 브라우저의 페인트 사이클(~16.67ms)에 묶여 있습니다. 페인트와 무관한 계산 작업도 16ms마다 한 번씩만 실행할 수 있고, 백그라운드 탭에서는 실행이 중단되거나 크게 느려집니다.

`MessageChannel`은 macrotask를 생성하지만 타이머 스로틀링이 없습니다. 이벤트 루프의 다음 사이클에서 즉시 실행되며, 지연이 0.1ms 수준입니다. 페인트와 독립적으로 실행되어 백그라운드 탭에서도 동작합니다. React는 `channel.port2.postMessage(null)` 한 줄로 다음 작업 배치를 예약하고, `channel.port1.onmessage`에 등록된 핸들러가 5ms 작업 루프를 수행합니다.

이벤트 루프의 관점에서 보면, macrotask(MessageChannel) → microtask 소진(Promise.then) → 렌더링 기회(레이아웃, 페인트) → 다음 macrotask의 순서가 반복됩니다. React의 작업 배치는 macrotask 자리를 차지하므로, 매 배치 후 브라우저는 자연스럽게 렌더링 기회를 얻습니다.

---

## Scheduler의 두 개의 Min-heap

React와 별도 패키지로 분리된 `scheduler`는 두 개의 최소 힙(min-heap)으로 태스크를 관리합니다. 하나는 지금 즉시 실행 가능한 태스크를 담는 `taskQueue`이고, 다른 하나는 `delay` 옵션 때문에 아직 시작할 수 없는 태스크를 담는 `timerQueue`입니다.

`taskQueue`의 정렬 기준은 만료 시간(expirationTime)이고, `timerQueue`의 정렬 기준은 시작 시간(startTime)입니다. `advanceTimers` 함수가 주기적으로 `timerQueue`를 확인하여 `startTime <= currentTime`이 된 태스크를 `taskQueue`로 이동시킵니다.

우선순위별 만료 시간은 다음과 같습니다. ImmediatePriority는 -1ms 즉시 만료, UserBlockingPriority는 250ms, NormalPriority는 5000ms, IdlePriority는 사실상 무한(약 12일)입니다. ImmediatePriority의 음수 timeout은 의도적입니다. 태스크가 생성되는 순간 이미 만료 상태이므로, 시간 슬라이스를 무시하고 즉시 강제 실행됩니다.

힙 구현은 배열 기반의 이진 힙입니다. `push`와 `pop` 연산이 O(log n)이고, 최솟값 조회가 O(1)입니다. 태스크 취소는 특이하게도 힙에서 제거하는 대신 `task.callback = null`로 표시하는 방식입니다. 실제 제거는 `pop` 시점에 자연스럽게 일어납니다. 이 덕분에 취소 연산이 O(1)로 처리됩니다.

---

## SyncLane은 Scheduler를 우회한다

SyncLane 업데이트는 Scheduler의 MessageChannel 기반 비동기 흐름을 완전히 건너뜁니다. 대신 마이크로태스크(microtask)를 통해 처리됩니다.

이벤트 루프에서 마이크로태스크는 현재 실행 중인 JavaScript가 끝난 직후, 렌더링 기회 이전에 소진됩니다. SyncLane 업데이트를 마이크로태스크로 등록한다는 것은 "현재 이벤트 핸들러가 끝나는 즉시, 브라우저가 화면을 그리기 전에 반드시 처리한다"는 의미입니다.

`flushSync`가 `performSyncWorkOnRoot`를 즉시 실행하는 것과 달리, 일반 SyncLane 업데이트는 `Promise.resolve().then(flushSyncCallbacks)` 형태로 등록됩니다. 이것은 같은 이벤트 핸들러 안에서 발생하는 여러 SyncLane 업데이트를 자동으로 배치(batch)처리하기 위한 선택입니다. 핸들러가 끝나고 나서 한 번에 모아 처리하는 것이 매번 즉시 처리하는 것보다 효율적입니다.

React 18에서 `createRoot`를 사용하면 이벤트 핸들러 외부(`setTimeout`, `fetch` 콜백 등)에서도 자동 배치가 적용됩니다. 이 역시 같은 마이크로태스크 스케줄링 메커니즘 덕분입니다.

---

## Lane의 탄생과 소멸: 완전한 생명 주기

하나의 Lane이 시스템 안에서 어떤 경로를 거치는지 처음부터 끝까지 따라가 봅시다.

`setState`가 호출되면 해당 Fiber에 Lane이 부여되고, `markRootUpdated`를 통해 `root.pendingLanes`에 비트가 켜집니다. 이와 동시에 조상 Fiber들의 `childLanes`도 업데이트됩니다.

렌더링이 시작되면 이 Lane은 진행 중인 상태가 됩니다. 만약 Suspense 경계를 만나 Promise를 throw하면, `markRootSuspended`가 호출되어 해당 Lane이 `suspendedLanes`로 이동합니다. 만료 타이머도 멈춥니다. 데이터가 없는 상태에서 타이머를 돌리는 것은 의미가 없기 때문입니다.

Promise가 resolve되면 `markRootPinged`가 `pingedLanes`를 업데이트합니다. 다음 `getNextLanes`는 이 pinged Lane을 선택하여 렌더를 재시도합니다.

렌더가 성공적으로 완료되면 `commitRoot`에서 `markRootFinished`가 호출됩니다. 완료된 Lane은 `pendingLanes`에서 제거되고, 관련 만료 타이머가 초기화되며, Entanglement 배열에서도 해당 Lane과의 연결이 모두 해제됩니다. Lane은 32비트 정수에서 비트가 꺼지는 것으로 소멸합니다.

---

## 전체 그림: 버튼 클릭부터 화면 갱신까지

모든 개념을 하나의 흐름으로 연결해봅시다. 사용자가 버튼을 클릭해서 `setState`를 호출하는 가장 단순한 시나리오입니다.

클릭 이벤트 핸들러 안에서 `setState`가 호출됩니다. `requestUpdateLane`은 현재 이벤트가 `click`임을 감지하고 SyncLane을 배정합니다. 해당 Fiber의 UpdateQueue에 새 Update가 추가되고, `markUpdateLaneFromFiberToRoot`가 루트까지의 모든 조상 `childLanes`를 업데이트합니다.

`ensureRootIsScheduled`는 SyncLane임을 확인하고 Scheduler를 우회하여 `performSyncWorkOnRoot`를 마이크로태스크로 등록합니다. 이벤트 핸들러가 끝납니다.

마이크로태스크 큐가 실행되면서 `flushSyncCallbacks`가 `performSyncWorkOnRoot`를 호출합니다. `renderRootSync`가 `workLoopSync`를 통해 Fiber 트리를 순회합니다. `childLanes`가 0인 서브트리는 통째로 건너뜁니다. 변경이 필요한 Fiber만 재렌더됩니다.

렌더가 완료되면 `commitRoot`가 시작됩니다. DOM 변경이 일어나고, `useLayoutEffect`가 실행됩니다. `root.current`가 새 Fiber 트리로 교체됩니다. `markRootFinished`로 SyncLane이 `pendingLanes`에서 제거됩니다. `useEffect`는 별도 NormalPriority Scheduler 태스크로 예약됩니다.

렌더링 기회에서 브라우저가 변경된 DOM을 화면에 반영합니다. 그 뒤 MessageChannel macrotask에서 `flushPassiveEffects`가 `useEffect`를 실행합니다.

`startTransition`을 사용하는 경우라면 흐름이 달라집니다. TransitionLane이 배정되고, `ensureRootIsScheduled`는 NormalPriority Scheduler 태스크로 등록합니다. 5ms마다 브라우저에 제어권을 돌려주면서 Fiber를 조금씩 처리하고, 중간에 더 높은 우선순위 업데이트가 들어오면 TransitionLane 렌더를 인터럽트합니다. 이 과정에서 `prepareFreshStack`이 WIP 트리를 버리고 새 우선순위로 처음부터 시작합니다.

---

## Lane 시스템이 달성한 것들

React의 Lane 시스템은 비트 연산이라는 저수준 도구를 활용해 매우 높은 수준의 사용자 경험 보장을 달성합니다.

**O(1) 우선순위 결정**: `lanes & -lanes` 단 하나의 연산으로 가장 높은 우선순위 Lane을 추출합니다. 매 렌더 사이클마다 반복되는 이 연산에 분기가 없습니다.

**선택적 렌더링**: `childLanes`를 통해 변경이 없는 서브트리 전체를 O(1)로 건너뜁니다. 트리가 아무리 커도 변경된 Fiber만 찾아갑니다.

**중간 상태 방지**: Entanglement가 관련 업데이트들의 커밋을 원자적으로 묶습니다. 절반만 업데이트된 UI가 사용자에게 노출되지 않습니다.

**기아 방지**: 만료 시스템이 낮은 우선순위 작업도 최대 5초 안에 반드시 처리되도록 강제합니다.

**부드러운 인터랙션**: 5ms 시간 슬라이싱과 continuation 패턴으로 무거운 렌더링 중에도 사용자 입력에 즉각 반응합니다.

이 모든 것이 32비트 정수 하나와 비트 연산의 조합으로 구현되어 있습니다. 추상적인 "동시성"이라는 개념이 실제로 비트 수준에서 어떻게 구현되는지를 보면, 좋은 시스템 설계란 올바른 추상화를 선택하는 일임을 다시 한번 실감하게 됩니다.

---

## 더 알아보기

- **이전 편**: [Hooks 시스템](./react-architecture-03-hooks-system.md) — Fiber 위에서 연결 리스트로 상태를 관리하는 방식
- **다음 편**: [렌더링 사이클](./react-architecture-05-rendering-cycle.md) — beginWork, completeWork, commitRoot 전체 흐름
- **관련 소스**: `packages/react-reconciler/src/ReactFiberLane.js`, `packages/scheduler/src/forks/Scheduler.js`
- **참고 자료**:
  - [React 18 Lane Model Deep Dive — goidle.github.io](https://goidle.github.io/react/in-depth-react18-lane/)
  - [What are Lanes in React source code? — jser.dev](https://jser.dev/react/2022/03/26/lanes-in-react)
  - [How React Scheduler works internally — jser.dev](https://jser.dev/react/2022/03/16/how-react-scheduler-works/)
  - [New feature: startTransition — reactwg Discussion](https://github.com/reactwg/react-18/discussions/41)