---
title: "React DOM 렌더러: Fiber 트리와 브라우저 사이의 번역가"
date: "2025-02-20"
tags: [React, react-dom, 이벤트 시스템, Fiber, DOM]
series: "React 아키텍처 심층 분석"
---

> **React 아키텍처 심층 분석** 시리즈의 열두 번째 글입니다. 앞선 편들에서 Fiber 트리, 스케줄러, Reconciler, Commit Phase의 내부 동작을 추적했다면, 이번 편에서는 그 모든 추상화가 **실제 브라우저 DOM과 만나는 접점** — `react-dom` 패키지의 설계 철학을 깊이 들여다봅니다.

---

## 두 세계의 충돌

React는 근본적으로 두 개의 세계를 다룹니다. 하나는 React가 스스로 설계한 세계 — Fiber 노드로 구성된 가상의 트리 구조 — 이고, 다른 하나는 브라우저가 오랫동안 지배해온 세계 — DOM API, 이벤트 버블링, 속성과 어트리뷰트의 미묘한 구분 — 입니다. 이 두 세계는 서로 다른 언어로 말합니다.

Fiber는 `stateNode`라는 필드에 무언가를 담을 수 있지만, 그것이 실제로 무엇인지는 알지 못합니다. `click` 이벤트가 발생했을 때 어떤 핸들러를 실행해야 하는지도 모릅니다. `className`을 어떻게 DOM에 반영해야 하는지도 알 바가 아닙니다. 그것은 Reconciler의 관심사가 아닙니다.

`react-dom`은 바로 이 간극을 메우는 번역가입니다. React 18 기준으로 약 30,000줄에 달하는 이 패키지의 존재 이유는 하나입니다 — Fiber 트리의 언어를 브라우저 DOM의 언어로 변환하는 것. 그리고 이 번역 과정에서 내려진 수많은 설계 결정들이 오늘날 React의 동작 방식을 규정하고 있습니다.

---

## 두 세계를 잇는 비밀 연결고리

번역이 작동하려면 두 세계 사이에 참조가 있어야 합니다. Fiber 노드에서 DOM 요소로, DOM 요소에서 다시 Fiber 노드로 — 이 양방향 연결이 `react-dom`의 모든 것을 가능하게 합니다.

단순하게 생각하면 `Map`이나 `WeakMap` 같은 자료구조를 쓸 수 있을 것입니다. 하지만 `react-dom`은 다른 방법을 선택했습니다. DOM 노드 객체에 직접 숨겨진 프로퍼티를 붙이는 방식입니다. `__reactFiber$`, `__reactProps$`, `__reactContainer$` 같은 이름의 프로퍼티가 그것입니다. 여기서 `$` 뒤에 붙는 랜덤 문자열이 흥미롭습니다.

이 랜덤 접미사는 `Math.random().toString(36).slice(2)`로 앱이 시작될 때 딱 한 번 생성됩니다. 목적은 단 하나 — 같은 페이지에서 여러 React 인스턴스가 공존할 때 프로퍼티 충돌을 방지하는 것입니다. 두 개의 서로 다른 React 번들이 같은 DOM 요소를 두고 서로의 데이터를 덮어쓰는 사고를 막습니다. 이것은 작은 디테일이지만, 마이크로프론트엔드 아키텍처나 점진적 React 마이그레이션 시나리오에서 결정적인 역할을 합니다.

이 연결고리의 실질적 의미는 이렇습니다. 브라우저에서 `click` 이벤트가 발생하면, React는 이벤트가 발생한 DOM 노드에서 `__reactFiber$` 프로퍼티를 읽어 해당 Fiber 노드를 즉시 찾아냅니다. 별도의 탐색이나 매핑 없이, O(1)에 Fiber에 도달합니다. 그리고 `__reactProps$`에서 현재 컴포넌트의 모든 props — `onClick`, `onChange`, `onMouseEnter` 등의 핸들러 포함 — 를 꺼냅니다.

반대 방향도 마찬가지입니다. Fiber 노드의 `stateNode` 필드는 자신에 대응하는 DOM 노드를 가리킵니다. Reconciler가 변경을 커밋할 때 `fiber.stateNode`로 직접 DOM 요소에 접근해 속성을 업데이트합니다.

컴포넌트가 언마운트될 때 이 양방향 참조를 명시적으로 해제하는 것도 이 때문입니다. `__reactFiber$` 프로퍼티가 남아 있으면 DOM 노드가 화면에서 사라진 후에도 Fiber 트리 전체가 가비지 컬렉션되지 않아 메모리 누수가 발생합니다.

---

## 이벤트 위임: 한 명이 모든 전화를 받는 이유

대형 건물의 전화 교환원을 상상해보십시오. 건물에 있는 수백 개의 방 각각에 전화기가 있지만, 외부에서 걸려오는 모든 전화는 먼저 1층 교환원에게 연결됩니다. 교환원은 "당신이 찾는 사람이 어느 방에 있는지" 알고 있으므로, 전화를 적절한 곳으로 연결해줍니다.

React의 이벤트 시스템이 정확히 이렇게 작동합니다. 화면에 `<button>`이 천 개 있어도, 각 버튼에 개별 이벤트 리스너를 붙이지 않습니다. 대신 `createRoot()`가 호출되는 순간, React는 루트 컨테이너 하나에 지원하는 **모든** 네이티브 이벤트 리스너를 등록합니다. 이것을 이벤트 위임(event delegation)이라고 부릅니다.

이 설계가 가진 힘은 수치로 명확합니다. 만약 1,000개의 버튼이 각자의 `onClick` 핸들러를 개별 DOM 리스너로 등록한다면, 브라우저는 1,000개의 리스너를 관리해야 합니다. React의 방식에서는 `click` 이벤트에 대해 루트에 단 두 개의 리스너만 있습니다 — capture phase 하나, bubble phase 하나.

단, 모든 이벤트가 이 위임 방식으로 처리되는 것은 아닙니다. `scroll`, `load`, 미디어 관련 이벤트들은 DOM에서 일관되게 버블되지 않으므로, 해당 요소에 직접 리스너를 등록합니다. `<video>` 요소의 `onPlay`, `onPause` 같은 핸들러는 video 요소 자체에 붙는 이유가 여기 있습니다.

React 16 이하에서는 이 위임 대상이 `document`였습니다. React 17부터 루트 컨테이너로 바뀐 것은 중요한 아키텍처 변경이었습니다. 이유는 세 가지입니다. 첫째, 한 페이지에 여러 React 앱(예: 마이크로프론트엔드)이 공존할 때 각자의 이벤트 경계를 명확히 분리할 수 있습니다. 둘째, React 외부의 이벤트 시스템과 충돌이 줄어듭니다. 셋째, `event.stopPropagation()`이 개발자의 직관대로 동작합니다 — 이전에는 `document`에 이미 이벤트가 도달한 후여서 stopPropagation이 다른 React 루트까지 차단하는 버그가 있었습니다.

---

## 이벤트의 등급: 모든 클릭이 같은 우선순위는 아니다

`click`과 `mousemove`는 둘 다 사용자 상호작용에 의해 발생하지만, React는 이 둘을 다르게 취급합니다. 이것은 Concurrent Mode의 핵심 아이디어와 직결됩니다.

버튼 클릭에 대한 응답은 즉각적이어야 합니다. 사용자가 버튼을 눌렀는데 UI가 200ms 후에 반응한다면 앱이 느리다고 느낍니다. 반면 마우스를 움직일 때마다 발생하는 `mousemove`는 초당 수십 번 발생하는 연속 이벤트입니다. 모든 `mousemove`를 동기적으로 처리하면 오히려 렌더링이 막힙니다.

React는 이를 `DiscreteEventPriority`, `ContinuousEventPriority`, `DefaultEventPriority` 세 단계로 분류합니다. `click`, `keydown`, `input`, `submit` 같은 이벤트는 최고 우선순위(SyncLane)를 받아 즉각적인 업데이트를 보장합니다. `mousemove`, `scroll`, `drag` 같은 연속 이벤트는 중간 우선순위를 받아 프레임 단위로 배칭됩니다.

이 우선순위 정보는 이벤트 핸들러 내부에서 `setState`가 호출될 때 해당 업데이트의 Lane을 결정하는 데 사용됩니다. 즉, 같은 `setState` 호출이라도 어떤 이벤트에서 호출되었느냐에 따라 다른 우선순위 Lane에 배정됩니다. 이것이 React가 "긴급한 업데이트"와 "지연 가능한 업데이트"를 구분하는 실질적인 메커니즘입니다.

루트 리스너가 등록될 때부터 이 우선순위가 고려됩니다. 이벤트 타입에 따라 `dispatchDiscreteEvent`, `dispatchContinuousEvent`, `dispatchEvent` 중 적절한 래퍼 함수가 선택되고, 이 래퍼가 현재 업데이트 우선순위를 설정한 상태에서 실제 이벤트 처리를 시작합니다.

```javascript
function dispatchDiscreteEvent(domEventName, eventSystemFlags, container, nativeEvent) {
  var previousPriority = getCurrentUpdatePriority();
  try {
    setCurrentUpdatePriority(DiscreteEventPriority);
    dispatchEvent(domEventName, eventSystemFlags, container, nativeEvent);
  } finally {
    setCurrentUpdatePriority(previousPriority);
  }
}
```

이 코드에서 핵심은 `try/finally` 구조입니다. 우선순위를 설정한 후 이벤트를 처리하고, 처리가 끝나면 반드시 이전 우선순위로 복원합니다. 이벤트 핸들러 안에서 예외가 발생해도 우선순위 컨텍스트가 오염되지 않도록 보장하는 방어적 설계입니다.

---

## 이벤트가 실제 핸들러에 도달하기까지

브라우저에서 `click`이 발생한 순간부터 여러분이 작성한 `onClick` 함수가 실행되기까지, React 내부에서는 여러 단계의 파이프라인이 작동합니다.

첫 번째 단계는 "어떤 React 컴포넌트를 향한 이벤트인가"를 파악하는 것입니다. 이벤트가 발생한 DOM 노드에서 `__reactFiber$` 프로퍼티를 읽어 대응하는 Fiber를 찾습니다. 만약 Suspense 하이드레이션이 진행 중이라면 이 단계에서 이벤트를 큐에 담아두기도 합니다 — 컴포넌트가 아직 완전히 준비되지 않은 상태에서 이벤트를 처리하면 안 되기 때문입니다.

두 번째 단계는 Portal 경계를 확인하는 것입니다. `createPortal`로 다른 DOM 트리에 렌더링된 컴포넌트의 이벤트가 React 컴포넌트 트리를 따라 버블되어야 하는지, 또는 다른 React 루트로 새어나가지 않아야 하는지를 판단합니다.

세 번째 단계가 가장 흥미롭습니다. `extractEvents`라고 불리는 여러 플러그인이 순서대로 실행되며, 각 플러그인은 이 네이티브 이벤트에서 어떤 React 이벤트가 발생해야 하는지를 결정합니다. `click` 하나가 `SimpleEventPlugin`을 통해 `onClick`으로 변환됩니다. `input` 이벤트는 `ChangeEventPlugin`을 통해 `onChange`로 변환되기도 합니다. 한 번의 네이티브 이벤트가 여러 React 이벤트를 유발할 수 있습니다.

네 번째 단계에서 Fiber 트리 순회가 일어납니다. 이벤트 타겟 Fiber에서 시작해 루트 방향으로 트리를 거슬러 올라가면서, 각 HostComponent(실제 DOM 요소에 대응하는 Fiber)에서 해당 이벤트에 등록된 핸들러를 `__reactProps$`에서 조회해 수집합니다. 결과는 `{ instance, listener, currentTarget }` 형태의 배열이 됩니다.

마지막으로 이 배열을 순회하며 핸들러를 실행합니다. Bubble phase라면 배열을 앞에서부터, Capture phase라면 뒤에서부터 순회합니다. 누군가 `event.stopPropagation()`을 호출하면 다음 순번부터는 실행이 중단됩니다.

여기서 중요한 점은 이 "버블링"이 실제 DOM 이벤트 버블링이 아니라는 것입니다. 루트 컨테이너에 이미 이벤트가 도달한 후의 일입니다. React는 Fiber 트리를 따라 미리 리스너를 수집한 다음, 그 배열의 순회를 멈추는 방식으로 버블링을 시뮬레이션합니다. 이것이 React의 이벤트 전파가 때때로 네이티브 DOM 이벤트 전파와 미묘하게 다르게 동작하는 이유입니다.

---

## 합성 이벤트: 크로스 브라우저 번역기

핸들러에 전달되는 `event` 객체는 브라우저의 네이티브 `MouseEvent`나 `KeyboardEvent`가 아닙니다. `SyntheticEvent`라는 React가 만든 래퍼 객체입니다.

이 결정의 역사적 배경을 이해하는 것이 중요합니다. React가 처음 등장했던 2013년 무렵, 브라우저 호환성은 지금과 비교할 수 없을 만큼 열악했습니다. IE8의 이벤트 시스템은 표준과 전혀 달랐고, `stopPropagation` 대신 `cancelBubble`, `preventDefault` 대신 `returnValue`를 사용해야 했습니다. 합성 이벤트는 이 혼란을 단일한 인터페이스로 추상화하는 해결책이었습니다.

오늘날에는 브라우저 표준화가 상당히 진행되었지만, 합성 이벤트는 여전히 중요한 역할을 합니다. `relatedTarget` 같은 속성은 브라우저마다 다르게 구현된 부분을 정규화합니다. `timeStamp`는 일부 브라우저에서 `event.timeStamp`가 없을 때 `Date.now()`로 폴백합니다. `movementX`, `movementY` 같은 Pointer Lock 관련 속성은 벤더 프리픽스 버전을 통합해 하나의 인터페이스로 제공합니다.

합성 이벤트가 팩토리 함수 `createSyntheticEvent`로 생성되는 이유도 흥미롭습니다. 단일 생성자로 `SyntheticMouseEvent`, `SyntheticKeyboardEvent`, `SyntheticTouchEvent` 등을 모두 만들면 V8 같은 JS 엔진 입장에서 이 생성자는 "megamorphic" 상태가 됩니다 — 항상 다른 형태의 객체를 만드는 생성자는 엔진이 최적화를 포기합니다. 이벤트 타입별로 별도의 생성자를 두면 각 생성자는 항상 같은 shape의 객체를 만들어 엔진 최적화가 가능해집니다.

---

## DOM 속성 diff: 변경된 것만 정확하게

Reconciler가 두 Fiber를 비교해 변경 사항을 파악했다면, 그것을 실제 DOM에 어떻게 반영할까요? 모든 속성을 지우고 다시 쓰는 방법이 가장 단순하지만, 명백히 비효율적입니다.

`react-dom`은 `diffProperties`라는 함수로 변경된 속성만 정확히 추출합니다. 이전 props와 다음 props를 비교해, 삭제된 속성과 추가/변경된 속성을 찾아냅니다. 결과는 `updatePayload`라는 평탄한 배열로 표현됩니다 — `[속성명, 새값, 속성명, 새값, ...]` 형태입니다.

이 배열 구조는 의도적인 최적화입니다. `{ className: 'new', title: null }` 같은 객체 대신 `['className', 'new', 'title', null]` 배열을 쓰는 이유는 두 가지입니다. 첫째, 배열이 객체보다 메모리 효율이 좋습니다. 둘째, 인덱스를 2씩 증가시키며 순회하는 것이 객체 키를 열거하는 것보다 빠릅니다.

폼 요소(`input`, `select`, `textarea`)는 이 단계에서 특별히 취급됩니다. 이들의 `updatePayload`는 변경 사항이 없어도 항상 빈 배열(`[]`)로 초기화됩니다. React가 Commit Phase에서 이 요소들을 반드시 방문하도록 강제하는 것입니다. 왜냐하면 브라우저가 내부적으로 관리하는 폼 요소의 상태(예: `input.value`)는 React가 관리하는 상태와 일치하도록 항상 동기화해야 하기 때문입니다.

스타일 처리에는 두 가지 편의 기능이 숨어 있습니다. 첫째, 숫자 값에 자동으로 `px` 단위가 붙습니다. `width: 100`을 쓰면 DOM에는 `'100px'`로 설정됩니다. 단, `zIndex`, `opacity`, `flexGrow` 같이 단위가 없어야 하는 CSS 속성들은 예외 목록에 등록되어 단위 추가 없이 그대로 씁니다. 둘째, CSS 커스텀 프로퍼티(`--custom-color` 같은 변수)는 직접 할당 대신 `style.setProperty()`를 사용합니다 — 이것이 CSS 변수를 설정하는 올바른 방법이기 때문입니다.

---

## 속성과 어트리뷰트: 두 개의 DOM API

브라우저 DOM에는 속성을 설정하는 방법이 두 가지 있습니다. `element.checked = true`처럼 JavaScript 객체 속성으로 직접 접근하는 방법과, `element.setAttribute('checked', '')`처럼 HTML 어트리뷰트로 설정하는 방법입니다. 이 둘은 비슷해 보이지만 동작이 미묘하게 다릅니다.

`checked`, `value`, `selected`, `muted` 같은 속성들은 반드시 JavaScript 속성으로 설정해야 합니다(`mustUseProperty`). 이런 속성들은 HTML 어트리뷰트가 초기값을 설정하는 역할을 하고, JavaScript 속성이 현재값을 나타내기 때문입니다. `input.setAttribute('checked', '')`는 `defaultChecked`를 설정하는 것이고, `input.checked = true`는 현재 체크 상태를 바꾸는 것입니다.

`disabled`, `readOnly` 같은 Boolean 속성들은 값이 `true`일 때 `setAttribute('disabled', '')`처럼 빈 문자열로 설정하고, `false`일 때는 `removeAttribute('disabled')`로 제거합니다. HTML에서 Boolean 어트리뷰트는 존재 여부가 의미이지, 값이 의미가 아니기 때문입니다.

이벤트 핸들러(`onClick`, `onChange` 등)는 어느 방법으로도 DOM에 반영되지 않습니다. 단지 `__reactProps$` 프로퍼티에 저장될 뿐입니다. 이것이 React의 이벤트 위임 시스템이 동작하는 방식 — DOM 이벤트 리스너 대신 중앙 집중식 위임으로 props에서 핸들러를 동적으로 조회합니다.

`href`, `src` 같이 URL을 담는 속성들은 XSS 방지를 위한 검증을 거칩니다. `javascript:` 프로토콜로 시작하는 값은 차단됩니다. 이 검증이 `setValueForProperty` 내부에 투명하게 녹아 있어 개발자가 별도로 신경 쓰지 않아도 됩니다.

---

## 제어 컴포넌트: 진실은 하나여야 한다

React의 제어 컴포넌트(controlled component)는 "진실의 단일 원천(single source of truth)"이라는 철학의 구현입니다. 폼 요소의 현재 값은 DOM이 아닌 React state에 있어야 합니다.

문제는 브라우저가 이 철학에 동의하지 않는다는 것입니다. 사용자가 input에 글자를 입력하면, 브라우저는 즉시 `input.value`를 변경합니다. React state가 업데이트되기 전에 DOM이 먼저 변하는 것입니다.

`react-dom`은 이 문제를 다소 거칠지만 효과적인 방법으로 해결합니다. 사용자가 입력하면 `onChange` 핸들러가 발화되고, 핸들러가 `setState`를 호출하고, React가 다시 렌더링하면서 `input.value`를 React state의 값으로 덮어씁니다. 만약 `onChange` 핸들러에서 `setState`를 호출하지 않거나, 다른 값으로 설정한다면, DOM은 React state의 값으로 강제 되돌아옵니다.

이 동작을 구현하는 `updateWrapper` 함수는 항상 현재 DOM 값과 다음 props의 값을 비교한 후에만 `node.value`를 변경합니다. 불필요한 DOM 변경을 피하는 최적화지만, 동시에 제어 컴포넌트의 핵심 불변식 — "DOM은 React state를 반영해야 한다" — 을 유지합니다.

`select` 요소는 더 복잡합니다. `select.value`를 직접 설정하면 브라우저의 option 선택 로직과 충돌하기 때문에, React는 `select`의 `value` prop을 DOM에 직접 반영하지 않습니다. 대신 각 `<option>` 요소의 `selected` 속성을 개별적으로 설정하는 방식으로 선택 상태를 관리합니다. `getHostProps$1` 함수가 `select`의 props에서 `value`를 `undefined`로 제거하는 이유가 여기 있습니다.

`uncontrolled`에서 `controlled`로, 또는 반대로 전환할 때 경고가 표시되는 것도 이 내부 동작 때문입니다. `_wrapperState.controlled`가 초기화 시점에 기록되고, 이후 업데이트마다 현재 props와 비교됩니다. 이 전환을 허용하는 것은 기술적으로 불가능하지 않지만, 두 가지 진실 원천이 충돌하는 예측 불가능한 상태로 이어질 수 있어 React가 적극적으로 경고하는 것입니다.

---

## Host Config: 브라우저용 구현체라는 정체성

`react-dom`의 정체성을 가장 명확하게 보여주는 것이 Host Config 인터페이스입니다. React Reconciler는 플랫폼에 독립적으로 설계되어 있습니다. `createInstance`, `commitUpdate`, `appendChild`, `removeChild` 같은 함수들의 시그니처를 정의하지만, 그 구현은 외부에 위임합니다. `react-dom`은 이 인터페이스의 "브라우저용 구현체"입니다.

이 분리의 증거가 React Native입니다. React Native는 동일한 React Reconciler를 사용하지만 Host Config는 다르게 구현합니다. `createInstance`가 DOM 요소 대신 네이티브 뷰를 생성하고, `setValueForProperty`가 CSS 속성 대신 네이티브 스타일링 API를 호출합니다. React Three Fiber도 마찬가지로 3D 씬 그래프를 위한 Host Config를 구현합니다.

Commit Phase 동안 이벤트 처리를 비활성화하는 것도 Host Config의 일부입니다. `prepareForCommit`이 이벤트 시스템을 끄고, `resetAfterCommit`이 복원합니다. DOM을 직접 수정하는 동안 발생하는 `focus`, `blur` 같은 이벤트가 React 상태와 불일치를 일으킬 수 있기 때문입니다. 텍스트 선택 영역(`selection`)을 저장하고 복원하는 것도 이 단계에서 일어납니다 — DOM 조작 중에 사용자의 텍스트 선택이 해제되는 것을 막기 위해서입니다.

`shouldSetTextContent`라는 함수도 눈에 띄는 최적화입니다. `<div>Hello</div>`처럼 순수 텍스트만 담는 요소는, 자식을 위한 별도의 Fiber 노드를 만들지 않고 `element.textContent`를 직접 설정합니다. 컴포넌트 트리를 탐색하다 보면 텍스트 노드에 대응하는 Fiber를 찾기 어려운 경우가 있는데, 이 최적화 때문입니다.

---

## 아키텍처가 말하는 것

`react-dom`을 이해하고 나면, React 사용 중 마주치는 여러 동작들이 새롭게 보입니다.

`<button disabled onClick={handler}>`에서 `onClick`이 실행되지 않는 이유는 React가 `getListener` 함수 내부에서 `disabled` 요소의 마우스 이벤트 핸들러 조회를 차단하기 때문입니다. 이것은 React 레벨의 결정이지, 브라우저의 동작이 아닙니다.

이벤트 핸들러 안에서 `setState`를 여러 번 호출해도 렌더링이 한 번만 일어나는 것은, 이벤트 디스패치가 `batchedUpdates` 컨텍스트 안에서 실행되기 때문입니다. 단, `setTimeout`이나 `fetch` 콜백에서는 이 배칭 컨텍스트가 없었습니다 — React 18의 Automatic Batching이 이 제약을 해소한 것입니다.

`event.currentTarget`이 이벤트 핸들러 밖에서 `null`이 되는 것은 합성 이벤트가 현재 실행 중인 리스너의 DOM 요소를 `currentTarget`에 동적으로 설정하기 때문입니다. 리스너 실행이 끝나면 초기화됩니다.

이 모든 동작은 임의적인 결정이 아닙니다. "단방향 데이터 흐름", "선언적 UI", "최소한의 DOM 변경" — React가 표방하는 철학들이 30,000줄의 코드로 구체화된 결과입니다. `react-dom`은 그 철학을 브라우저의 언어로 번역하는 가장 중요한 번역가입니다.

---

> **시리즈 네비게이션**
> - 이전: [11편 — Context와 상태 관리](./react-architecture-11-context.md)
> - 다음: [13편 — SSR 스트리밍과 선택적 하이드레이션](./react-architecture-13-ssr-streaming.md)