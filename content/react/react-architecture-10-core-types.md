---
title: "React가 세상을 분류하는 방법 — 핵심 타입 시스템 해부"
date: "2025-02-20"
tags: [React, TypeSystem, Fiber, Symbol, Architecture]
series: "React 아키텍처 심층 분석"
---

React 코드를 오래 짜다 보면 이런 당연한 사실을 잊게 됩니다. `<div>`와 `<App />`과 `{condition && <Child />}`와 `"텍스트"`가 모두 같은 JSX 트리 안에 공존한다는 것. React는 이 전혀 다른 것들을 어떻게 구분하고, 각각에 맞는 방식으로 처리할까요?

이 물음에 답하는 것이 React의 **타입 시스템**입니다. 오늘은 `react@18.3.1` 소스 코드를 통해, React가 세상을 어떻게 분류하고 표현하는지 그 설계 철학을 따라가 보겠습니다.

---

## 왜 타입 시스템이 필요한가

도서관 사서를 상상해 봅시다. 소설, 잡지, 지도, DVD, 악보가 모두 하나의 공간에 있습니다. 사서는 이것들을 눈으로 보는 즉시 구분할 수 있어야 하고, 각각에 맞는 방식으로 처리해야 합니다. 소설은 장르별로 분류하고, DVD는 케이스가 손상되지 않았는지 확인하고, 지도는 크기 때문에 별도 서랍에 보관합니다.

React의 렌더러가 정확히 이 상황입니다. 하나의 컴포넌트 트리 안에 DOM 엘리먼트(`<div>`), 함수 컴포넌트(`<App />`), 클래스 컴포넌트, Suspense 경계, Context Provider, Portal, 텍스트 노드, null, 배열이 섞여 있습니다. reconciler는 이것들을 순회하면서 각각에 전혀 다른 로직을 적용해야 합니다.

이를 가능하게 하는 것이 React의 **3층 타입 시스템**입니다.

첫 번째 층은 **Symbol 태깅**입니다. 객체가 "무엇인지" 신원을 확인합니다. 두 번째 층은 **ReactElement**로, JSX가 변환되는 불변 객체입니다. 세 번째 층은 **Fiber tag**로, reconciler가 실제로 사용하는 숫자 태그입니다. JSX로 작성한 코드는 이 세 층을 차례로 통과하며 브라우저에 그려질 준비를 마칩니다.

---

## Symbol 태깅 — React의 신분증 체계

### 왜 Symbol인가

React 18.3.1에는 정확히 13개의 Symbol이 있습니다. `react.element`, `react.portal`, `react.fragment`, `react.strict_mode`, `react.profiler`, `react.provider`, `react.context`, `react.forward_ref`, `react.suspense`, `react.suspense_list`, `react.memo`, `react.lazy`, `react.offscreen`. 이것이 React가 인식하는 타입의 전체 목록입니다.

여기서 흥미로운 점은 일반 `Symbol()`이 아니라 `Symbol.for()`를 사용한다는 것입니다. 두 방식의 차이는 **전역 레지스트리**에 있습니다. `Symbol()`은 호출할 때마다 유일한 Symbol을 생성하지만, `Symbol.for()`는 전역 레지스트리를 공유합니다. 같은 문자열 키로 `Symbol.for()`를 두 번 호출하면 정확히 동일한 Symbol을 얻습니다.

이것이 중요한 이유는 **마이크로 프론트엔드** 같은 환경 때문입니다. 하나의 페이지에 여러 React 인스턴스가 공존할 때, 각 인스턴스가 만든 엘리먼트를 서로 인식하려면 `$$typeof`가 같아야 합니다. `Symbol.for()`의 전역 레지스트리가 이 일관성을 보장합니다.

### Symbol 태그의 두 가지 역할

Symbol 태그가 사용되는 위치는 두 군데입니다. 이 구분이 중요합니다.

첫 번째는 `$$typeof` 필드입니다. "이 객체가 React 객체인가?"를 확인하는 신분증입니다. ReactElement와 ReactPortal이 각각 다른 `$$typeof` Symbol을 가집니다.

두 번째는 `type` 필드 또는 `type.$$typeof`입니다. "어떤 종류의 React 객체인가?"를 나타냅니다. Fragment는 `type` 자체가 Symbol이고, Provider나 forwardRef는 `type` 객체 안의 `$$typeof`가 Symbol입니다.

비유하자면, 첫 번째는 "여권을 가진 사람인가?"를 확인하는 것이고, 두 번째는 "어느 나라 여권인가?"를 확인하는 것입니다. React는 이 두 단계 확인을 통해 모든 타입을 정확히 분류합니다.

---

## ReactElement — 불변성과 보안 설계

### 엘리먼트는 불변이어야 한다

`createElement`나 JSX Transform의 `jsxDEV`가 반환하는 ReactElement는 다섯 개의 핵심 필드로 구성됩니다. `$$typeof`(신원), `type`(종류), `key`(리스트 식별자), `ref`(DOM 참조), `props`(속성). DEV 모드에서는 여기에 파일 위치 정보(`_source`), 소유자 컴포넌트(`_owner`), 검증 상태(`_store`) 같은 디버그 필드가 추가됩니다.

흥미로운 것은 DEV 모드에서 `Object.freeze`로 엘리먼트와 props를 동결한다는 점입니다. React의 설계 원칙에서 엘리먼트는 순간의 스냅샷입니다. 특정 시점에 "이런 UI를 원한다"는 의도를 담은 불변 명세서입니다. 명세서를 작성한 뒤에 내용을 바꾸면 혼란이 생기므로, DEV 모드에서는 이를 물리적으로 차단합니다.

### $$typeof가 Symbol인 진짜 이유 — XSS 방어

`$$typeof`를 Symbol로 선택한 것은 단순한 관행이 아니라 **보안 설계**입니다. 이해하려면 공격 시나리오를 먼저 알아야 합니다.

서버가 사용자 프로필 데이터를 JSON으로 반환한다고 가정합시다. 악의적인 사용자가 자신의 프로필 데이터로 React 엘리먼트처럼 생긴 JSON 객체를 심어놓습니다. 만약 `$$typeof`가 문자열이었다면, `JSON.parse`로 역직렬화된 이 객체가 React 엘리먼트로 인식되어 XSS 공격이 성공할 수 있었습니다.

Symbol은 JSON으로 직렬화할 수 없습니다. 서버 응답에 `"$$typeof": "react.element"` 같은 문자열을 심어도, React의 유효성 검사는 Symbol 비교를 수행하므로 이를 진짜 React 엘리먼트로 인식하지 않습니다. 공격 경로가 타입 시스템 자체에 의해 구조적으로 차단됩니다.

`isValidElement` 함수는 단 세 가지만 확인합니다. 객체인가, null이 아닌가, `$$typeof`가 `REACT_ELEMENT_TYPE` Symbol인가. `type`이나 `props` 같은 다른 필드는 검사하지 않습니다. Symbol 하나로 모든 인증이 완료되는 것입니다.

### createElement와 jsxDEV의 차이

React 18에서 엘리먼트를 만드는 경로는 두 가지입니다. 레거시 `createElement`와 새로운 JSX Transform의 `jsxDEV`(또는 프로덕션의 `jsx`/`jsxs`)입니다. 두 함수의 가장 큰 차이는 `key`의 처리 방식입니다.

`createElement`에서는 key가 config 객체 안에 섞여 있습니다. `jsxDEV`에서는 key를 별도의 인자로 받습니다. 이 분리는 `<div {...props} key="hi" />` 같은 패턴에서 key가 spread로 전달되는 것을 감지하고 경고하기 위해서입니다. key는 React 내부 메커니즘을 위한 것이지 컴포넌트 props가 아니므로, 컴파일러가 이를 명시적으로 분리해 줍니다.

두 경로 모두 최종적으로 동일한 `ReactElement` 팩토리를 호출하고, 구조적으로 완전히 같은 객체를 만들어냅니다.

---

## Portal — 다른 세계로의 탈출구

Portal은 ReactElement가 아닙니다. 이 점이 핵심입니다. `createPortal`이 반환하는 객체의 `$$typeof`는 `REACT_ELEMENT_TYPE`이 아니라 `REACT_PORTAL_TYPE`입니다.

일반 ReactElement에는 `type`과 `props`가 있지만, Portal에는 이것들이 없습니다. 대신 `containerInfo`가 있습니다. 자식을 렌더링할 대상 DOM 노드입니다. 모달 다이얼로그나 툴팁이 `document.body` 아래에 마운트되는 것은, `containerInfo`가 현재 컴포넌트 트리의 DOM 위치가 아닌 다른 노드를 가리키기 때문입니다.

reconciler는 자식을 처리할 때 `$$typeof`를 먼저 확인합니다. `REACT_PORTAL_TYPE`을 발견하면 일반 엘리먼트 처리 경로가 아닌 Portal 전용 경로로 분기합니다. 같은 컴포넌트 트리 안에 있지만, DOM 위치는 완전히 다른 곳에 마운트되는 것입니다.

---

## Context — 전역 상태를 트리에 흘려보내는 방법

### 두 개의 currentValue가 존재하는 이유

`createContext`의 소스를 보면 이상한 점이 있습니다. `_currentValue`와 `_currentValue2`, 두 개의 현재 값 필드가 있습니다. 왜 하나로 충분하지 않을까요?

이것은 **동시 렌더러** 지원을 위한 설계입니다. React는 같은 컴포넌트 트리를 두 렌더러가 동시에 처리할 수 있습니다. React DOM과 React ART를 함께 쓰거나, React Native와 Fabric을 함께 쓰는 경우입니다. 두 렌더러가 같은 Context 객체를 공유하는데, 각자 독립적인 Provider 스택을 유지해야 합니다. 저장소가 하나라면 서로 덮어쓰게 됩니다.

해결책은 단순합니다. 1차 렌더러(React DOM, React Native)는 `_currentValue`를 쓰고, 2차 렌더러(React ART, Fabric)는 `_currentValue2`를 씁니다. 두 렌더러가 같은 Context를 공유하면서도 독립적인 값을 유지합니다.

### Provider와 Consumer는 다른 타입이다

`createContext`가 반환하는 객체를 보면, `Provider`와 `Consumer`가 `$$typeof`가 다릅니다. `Provider`는 `REACT_PROVIDER_TYPE`을, `Consumer`는 `REACT_CONTEXT_TYPE`을 가집니다. 이 차이가 Fiber 생성 단계에서 서로 다른 처리 경로를 만들어냅니다.

`Provider`와 `Consumer` 모두 `_context` 필드로 원본 Context 객체를 참조합니다. 순환 참조처럼 보이지만, 이 설계 덕분에 `<Context.Provider value={...}>`의 `type`에서 항상 원본 Context 객체를 역추적할 수 있습니다. Fiber 처리 단계에서 Provider가 어떤 Context에 값을 공급하는지 즉시 알 수 있습니다.

### Context 값이 저장되는 방식 — 직접 변이의 역설

Context 값이 변경될 때 React는 놀랍게도 `context._currentValue`를 **직접 변이**합니다. 불변성을 강조하는 React에서 왜 이런 선택을 했을까요?

`pushProvider`는 Provider Fiber를 만날 때 호출됩니다. 현재 값을 별도의 cursor 스택에 백업한 뒤, `context._currentValue`를 새 값으로 직접 교체합니다. `popProvider`는 스택에서 이전 값을 꺼내 복원합니다.

이유는 **성능**입니다. Context 값은 컴포넌트를 렌더링할 때마다 읽힙니다. 스택을 매번 탐색하는 것보다 전역 변수에 현재 값을 유지하는 것이 O(1)으로 훨씬 빠릅니다. 트리 순회(DFS)와 push/pop 스택이 완벽하게 맞물리기 때문에, `beginWork`에서 Provider를 만나면 push하고 `completeWork`에서 pop하면 이전 값이 정확히 복원됩니다.

### Context 소비자는 의존성을 등록한다

`readContext`는 단순히 값을 반환하는 것이 아닙니다. 현재 렌더링 중인 Fiber의 `dependencies` 연결 리스트에 해당 Context를 등록합니다. 이 등록 행위가 나중에 Context 값이 변경됐을 때 어떤 컴포넌트를 다시 렌더링해야 하는지 판단하는 근거가 됩니다.

Provider의 value가 변경되면, React는 하위 트리를 순회하며 각 Fiber의 의존성 체인을 확인합니다. 변경된 Context를 구독 중인 Fiber를 발견하면 재렌더링을 예약합니다. 단, 같은 종류의 Provider를 만나면 그 아래는 탐색하지 않습니다. 해당 Provider가 값을 덮어쓰므로, 그 아래의 소비자들은 다른 값을 받기 때문입니다.

Context 값 비교에는 `Object.is`를 사용합니다. `===`와 거의 같지만, `NaN`을 `NaN`과 같다고 보고 `+0`과 `-0`을 다르다고 봅니다. 이 미묘한 차이가 `NaN`을 value로 가진 Context가 무한 루프에 빠지지 않도록 보호합니다.

---

## React.lazy — 상태 머신으로 구현된 지연 로딩

`React.lazy`의 내부 구조는 교과서적인 상태 머신입니다. 네 가지 상태가 있습니다. 아직 로딩을 시작하지 않은 `Uninitialized(-1)`, Promise를 기다리는 `Pending(0)`, 성공한 `Resolved(1)`, 실패한 `Rejected(2)`.

흥미로운 점은 `_result` 필드 하나가 상태에 따라 완전히 다른 것을 저장한다는 것입니다. 처음에는 import 함수 자체를 담습니다. Promise가 시작되면 그 Promise를 담습니다. 성공하면 로드된 모듈 객체를 담고, 실패하면 에러 객체를 담습니다. 어느 시점에도 하나의 상태에만 있을 수 있으므로, 필드 하나를 재활용하는 것이 메모리 효율적입니다.

```javascript
// _result 필드가 상태에 따라 저장하는 것
Uninitialized: () => import('./Component')  // import 함수
Pending:        Promise<...>                 // 진행 중인 Promise
Resolved:       { default: Component }      // 로드된 모듈
Rejected:       Error                        // 실패 에러
```

이 코드에서 핵심은 `_result` 하나로 네 가지 상태를 표현한다는 것입니다. Union type의 실용적 구현이라 할 수 있습니다.

### Suspense와의 연결 — throw로 통신하다

lazy가 Pending 상태일 때 `lazyInitializer`는 Promise를 `throw`합니다. Rejected 상태일 때는 Error를 `throw`합니다. 이 throw가 Suspense 바운더리와 Error Boundary와의 통신 수단입니다.

Promise를 throw하면 가장 가까운 Suspense 바운더리가 이를 catch하고 fallback을 보여줍니다. Error를 throw하면 Error Boundary가 catch합니다. lazy는 이 패턴을 통해 Suspense 시스템에 자연스럽게 통합됩니다. 특별한 API가 필요하지 않습니다. throw 하나면 충분합니다.

---

## memo와 forwardRef — 감싸는 타입들

`memo`와 `forwardRef`는 컴포넌트를 감싸는 래퍼 객체를 만듭니다. 컴포넌트 자체를 변경하는 것이 아니라, 그 컴포넌트를 가리키는 특별한 객체를 반환합니다.

`memo`가 반환하는 객체는 `$$typeof: REACT_MEMO_TYPE`과 원본 컴포넌트(`type`)와 커스텀 비교 함수(`compare`)를 가집니다. `forwardRef`가 반환하는 객체는 `$$typeof: REACT_FORWARD_REF_TYPE`과 렌더 함수(`render`)를 가집니다.

### 순서가 중요하다

`forwardRef(memo(render))`는 잘못된 순서입니다. React 소스코드에서 이것을 감지하고 경고합니다. 올바른 순서는 `memo(forwardRef(render))`입니다.

이유는 평가 순서입니다. `memo`가 바깥에 있어야 props 비교가 먼저 수행되어 불필요한 렌더링을 방지할 수 있습니다. `forwardRef`가 바깥에 있으면 memo의 비교 로직이 건너뛰어집니다. 래퍼를 중첩할 때 바깥쪽이 먼저 처리된다는 점을 기억하면 됩니다.

합성 타입이 중첩될 때의 구조는 러시아 마트료시카 인형과 같습니다. `memo`가 바깥 인형, `forwardRef`가 안쪽 인형, 실제 렌더 함수가 가장 안쪽에 있습니다. reconciler는 바깥부터 열면서 안쪽 타입을 파악합니다.

---

## reconcileChildFibers — 모든 분기가 만나는 곳

지금까지 살펴본 모든 타입 정보가 실제로 사용되는 핵심 지점이 `reconcileChildFibers`입니다. 부모 Fiber의 자식을 처리할 때 이 함수가 호출되고, 자식의 타입에 따라 완전히 다른 경로로 분기합니다.

분기는 계층적입니다. 먼저 자식이 객체인지 문자열인지 숫자인지 확인합니다. 객체라면 `$$typeof`를 확인합니다. `REACT_ELEMENT_TYPE`이면 단일 엘리먼트 처리, `REACT_PORTAL_TYPE`이면 Portal 처리, `REACT_LAZY_TYPE`이면 lazy를 해결하고 **재귀 호출**합니다. 배열이거나 이터러블이면 각 항목을 순회합니다. 문자열이나 숫자면 텍스트 노드를 만듭니다. null, undefined, boolean은 자식이 없는 것으로 처리합니다.

### Lazy만 재귀 호출인 이유

`REACT_LAZY_TYPE`을 만났을 때만 `reconcileChildFibers`를 재귀 호출합니다. 다른 타입들은 전용 함수를 직접 호출하는데 왜 Lazy만 다를까요?

lazy는 "아직 무엇인지 모르는 타입"이기 때문입니다. lazy를 해결(`init(payload)`)하면 일반 컴포넌트 함수가 나올 수도 있고, throw가 발생할 수도 있습니다. 해결된 결과가 무엇이든 그것을 다시 `reconcileChildFibers`에 넘기면, 기존의 모든 분기 로직이 그대로 작동합니다. 재귀 호출 하나로 lazy의 결과를 투명하게 처리할 수 있습니다.

---

## createFiberFromTypeAndProps — Symbol에서 숫자로

ReactElement의 `type`을 Fiber의 숫자 tag로 변환하는 것이 `createFiberFromTypeAndProps`입니다. 이 함수가 React 타입 시스템의 2층과 3층을 연결합니다.

변환 규칙은 체계적입니다. `type`이 함수이면서 `prototype.isReactComponent`가 있으면 ClassComponent(1), 그냥 함수면 아직 모르는 IndeterminateComponent(2), 문자열이면 HostComponent(5), `REACT_FRAGMENT_TYPE` Symbol이면 Fragment(7), `REACT_SUSPENSE_TYPE`이면 SuspenseComponent(13). `type`이 객체라면 `type.$$typeof`를 다시 확인합니다. PROVIDER_TYPE이면 ContextProvider(10), CONTEXT_TYPE이면 ContextConsumer(9), FORWARD_REF_TYPE이면 ForwardRef(11), MEMO_TYPE이면 MemoComponent(14), LAZY_TYPE이면 LazyComponent(16).

### IndeterminateComponent가 존재하는 이유

처음 함수 컴포넌트를 만나면 FunctionComponent(0)가 아니라 IndeterminateComponent(2)로 분류됩니다. 왜 바로 결정하지 않을까요?

레거시 호환성 때문입니다. 일부 함수가 JSX 대신 클래스 인스턴스를 반환하는 오래된 패턴이 있습니다. `prototype.isReactComponent` 확인만으로는 이런 경우를 잡을 수 없습니다. 그래서 첫 렌더링에서 실제로 함수를 호출해보고, 반환값을 확인한 후에야 FunctionComponent인지 ClassComponent인지 최종 결정합니다. 이 지연 분류가 레거시 코드와의 호환성을 보장합니다.

---

## beginWork — 모든 타입의 최종 처리

Fiber tag가 부여되면 `beginWork`의 거대한 switch 문에서 최종 처리가 시작됩니다. 각 tag는 정확히 하나의 처리 함수와 매핑됩니다.

하지만 beginWork는 단순한 switch 문이 아닙니다. switch 이전에 **bailout 판단**이 있습니다. props가 변경됐는지, Context가 바뀌었는지, 타입이 같은지 확인합니다. 변화가 없고 스케줄된 업데이트도 없다면, 해당 서브트리 전체를 건너뜁니다. React 성능의 핵심 메커니즘입니다.

Context Provider를 처리하는 `updateContextProvider`는 이 흐름의 좋은 예입니다. `pushProvider`로 새 값을 스택에 올린 뒤, 이전 값과 `Object.is`로 비교합니다. 같다면 바로 bailout합니다. 다르다면 모든 소비자에게 변경을 전파합니다. 값이 실제로 바뀔 때만 비용이 드는 전파를 수행합니다.

Context Consumer의 `updateContextConsumer`는 render prop 패턴을 그대로 구현합니다. `readContext`로 현재 값을 읽고(이때 의존성 등록도 함께), children으로 전달받은 함수에 값을 넘겨 호출합니다. 함수의 반환값이 자식 엘리먼트가 됩니다.

---

## 전체 파이프라인을 하나의 그림으로

React 타입 시스템을 관통하는 흐름을 요약하면 이렇습니다.

```
JSX 작성 → 컴파일러 변환 → createElement / jsxDEV 호출
    ↓
ReactElement 생성 ($$typeof = REACT_ELEMENT_TYPE, type = ...)
    ↓
reconcileChildFibers ($$typeof에 따라 분기)
    ↓
createFiberFromTypeAndProps (type → Fiber tag 숫자로 변환)
    ↓
FiberNode 생성 (tag: 0~22)
    ↓
beginWork switch (tag에 따라 처리 함수 호출)
    ↓
실제 렌더링 / DOM 반영
```

이 파이프라인 어디에도 마법은 없습니다. Symbol을 신분증으로 쓰고, 숫자를 분류 코드로 쓰고, switch 문으로 분기합니다. 단순한 도구들의 체계적인 조합입니다.

---

## 설계 트레이드오프 — 실용주의가 이긴 곳들

React 타입 시스템에는 이론적 순수함보다 실용적 선택이 이긴 지점들이 있습니다.

**Context의 직접 변이**는 불변성 원칙에 위배됩니다. 하지만 Context는 렌더링마다 읽힙니다. 스택 탐색 대신 전역 변수를 쓰는 O(1) 접근이 트리 순회 성능에 직접적인 영향을 미칩니다.

**`_result` 필드 재활용**은 타입 안전성을 희생합니다. 상태에 따라 완전히 다른 것을 담으므로, 잘못된 상태에서 읽으면 예상치 못한 값을 얻습니다. 하지만 메모리를 아끼고 객체 구조를 단순하게 유지합니다.

**`IndeterminateComponent`의 지연 분류**는 복잡성을 추가합니다. 하지만 수년간 쌓인 레거시 코드와의 호환성을 유지하면서 새로운 함수 컴포넌트 패러다임으로 전환하는 현실적인 방법입니다.

이 트레이드오프들이 React가 실제 프로덕션에서 오래 살아남은 이유이기도 합니다. 완벽한 이론보다 실제로 동작하는 시스템을 택했습니다.

---

## 마무리

React의 핵심 타입 시스템은 세 개의 층으로 구성됩니다.

첫 번째 층인 Symbol 태깅은 객체의 신원을 확인합니다. JSON 직렬화가 불가능한 Symbol의 특성이 XSS 공격을 구조적으로 차단하는 보안 장치가 됩니다. 13개의 Symbol이 React 18.3.1이 인식하는 세상의 전부입니다.

두 번째 층인 ReactElement는 JSX가 변환되는 불변 명세서입니다. DEV 모드에서 `Object.freeze`로 동결되고, 5개의 핵심 필드와 디버그 필드로 구성됩니다. `createElement`와 `jsxDEV` 두 경로 모두 동일한 팩토리를 호출합니다.

세 번째 층인 Fiber tag는 reconciler의 언어입니다. `createFiberFromTypeAndProps`에서 `type`을 분석해 0부터 22까지의 숫자로 변환하고, `beginWork`의 switch 문이 이 숫자에 따라 정확한 처리 로직을 실행합니다.

이 세 층의 변환이 React 렌더링의 첫 번째 관문입니다. 타입 시스템이라는 토대 위에서 Fiber 재조정, 동시성 모드, Suspense가 모두 동작합니다. JSX 한 줄이 화면에 그려지기까지의 여정은, 세 개의 층을 차례로 통과하며 점점 더 구체적인 형태로 변환되는 과정입니다.

---

> 이전 글: React 아키텍처 심층 분석 (9/14): Suspense와 Error Boundary
> 다음 글: React 아키텍처 심층 분석 (11/14): Host Configuration — 플랫폼 독립성의 비밀