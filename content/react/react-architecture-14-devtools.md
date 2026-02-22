---
title: "React DevTools는 어떻게 React의 내부를 들여다보는가"
date: "2025-02-20"
tags: [React, DevTools, Architecture, Fiber, Profiler]
series: "React 아키텍처 심층 분석"
---

React DevTools를 처음 열었을 때의 경험은 꽤 신기합니다. 컴포넌트 트리가 실시간으로 펼쳐지고, 어떤 DOM 요소를 클릭하면 해당 React 컴포넌트가 즉시 하이라이트됩니다. 상태 값을 패널에서 직접 수정하면 화면이 즉시 반응합니다. 프로파일러는 각 컴포넌트가 렌더링에 몇 밀리초를 썼는지 플레임차트로 보여줍니다.

이 모든 것이 어떻게 가능한 걸까요?

DevTools가 브라우저 확장 프로그램 형태로 "외부에서" React 앱을 들여다보는 것이라고 생각하기 쉽습니다. 하지만 실제는 그 반대입니다. **React 런타임 자체가 DevTools를 위한 코드를 내장하고 있습니다.** DevTools는 React 위에 얹힌 플러그인이 아니라, React 아키텍처에 처음부터 설계된 관측 시스템(Observability System)입니다.

이 글에서는 `react-dom` 소스 코드를 따라가며, DevTools와 React 런타임이 어떤 원리로 연결되는지, 왜 이런 설계를 선택했는지를 탐구합니다.

---

## 두 세계를 연결하는 전역 훅

브라우저 탭 하나를 상상해봅시다. 그 안에는 React 앱이 돌아가고 있고, 브라우저에는 DevTools 확장 프로그램이 설치되어 있습니다. 이 둘은 서로 다른 코드베이스에서 만들어졌고, 서로의 존재를 미리 알 수 없습니다. 그렇다면 어떻게 연결될까요?

React 팀이 선택한 방법은 전역 변수를 매개체로 사용하는 것입니다. DevTools 확장이 설치된 브라우저에서 페이지가 로드되면, content script가 `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`이라는 전역 객체를 만들어둡니다. 이것은 일종의 "우편함"입니다. DevTools가 미리 우편함을 설치해두고, React가 나중에 여기에 메시지를 넣는 구조입니다.

React DOM이 모듈 초기화를 마칠 때, 맨 마지막 단계에서 이 전역 변수의 존재를 확인합니다. 만약 우편함이 있다면, React는 자신의 내부 함수들을 담은 `internals` 객체를 건네줍니다. DevTools는 이 객체를 받아 React의 내부와 직접 연결됩니다. 이 순간, 양방향 채널이 열립니다.

이 패턴의 우아함은 **선택적 연결**에 있습니다. DevTools가 설치되지 않은 환경에서는 전역 변수가 없으므로 React는 아무것도 하지 않습니다. 성능 오버헤드도 없고, 에러도 없습니다. DevTools가 있을 때만 조용히 연결됩니다. React 코드 어디서도 "DevTools가 없으면 에러를 던지자"는 코드를 찾아볼 수 없는 이유입니다.

또 다른 장점은 **버전 독립성**입니다. React 18과 DevTools 5.x가 서로의 내부 구현을 몰라도 약속된 인터페이스를 통해 소통합니다. 마치 USB 표준처럼, 연결 방식만 합의되어 있으면 서로 다른 제조사의 기기가 통신할 수 있습니다.

---

## 렌더러 식별자: 여러 React가 공존할 때

한 페이지에 React 앱이 하나만 있으리라는 보장은 없습니다. 마이크로 프론트엔드 아키텍처에서는 여러 React 인스턴스가 같은 페이지에 존재할 수 있습니다. 3D 씬을 위한 `react-three-fiber`, 네이티브 스타일의 `react-native-web`이 메인 앱과 함께 실행될 수도 있습니다.

DevTools는 이 모든 렌더러를 구분해야 합니다. 이를 위해 React가 `internals`를 전달할 때, DevTools는 고유한 숫자 ID(`rendererID`)를 반환합니다. 이후 React가 DevTools에 이벤트를 보낼 때마다 이 ID를 첫 번째 인자로 넣습니다. DevTools는 ID를 보고 어떤 앱에서 온 이벤트인지 정확히 구분합니다.

사원증 시스템과 비슷합니다. 회사에 입사하면(=렌더러가 DevTools에 등록하면) 고유한 사원증 번호(=rendererID)를 받고, 이후 모든 보고서에 이 번호를 기재합니다. 보고를 받는 본사(=DevTools)는 번호만 보면 어느 부서에서 온 보고인지 즉시 알 수 있습니다.

---

## 스택 트레이스로 모듈 경계를 표시하는 법

DevTools가 제공하는 기능 중에 컴포넌트 에러가 발생했을 때 스택 트레이스를 보여주는 것이 있습니다. 이때 React 내부 코드에서 발생한 프레임은 숨겨지고, 사용자 코드 프레임만 보여줍니다. 이것이 어떻게 가능한 걸까요?

`react-dom` 소스 파일의 맨 첫 줄과 맨 마지막 줄에는 각각 `registerInternalModuleStart`와 `registerInternalModuleStop`이라는 함수 호출이 있습니다. 흥미로운 것은 이 함수들에 `new Error()`를 전달한다는 점입니다.

Error 객체에는 생성 시점의 스택 트레이스가 담겨 있습니다. 파일 경로와 라인 번호가 포함되어 있죠. DevTools는 "모듈 시작" Error와 "모듈 끝" Error의 스택 트레이스를 분석하여, 그 사이에 있는 코드 범위를 "React 내부"로 표시해둡니다. 이후 어디선가 에러가 발생하면, 스택 프레임을 하나씩 확인하며 React 내부 범위에 해당하면 숨기고, 그 바깥이면 사용자 코드로 보여줍니다.

코드를 파싱하거나 심볼 테이블을 분석하는 대신, 이미 존재하는 Error 객체의 스택 트레이스를 재활용하는 이 방식은 매우 영리합니다. 런타임에서 추가 비용 없이 모듈 경계를 정확하게 파악할 수 있습니다.

---

## DOM 노드에 심어진 비밀 프로퍼티

DevTools에서 화면의 DOM 요소를 우클릭하고 "Inspect"를 선택하면, DevTools 패널에서 해당 React 컴포넌트가 자동으로 선택됩니다. DOM 노드에서 React Fiber를 찾아가는 것이죠. 이것이 어떻게 동작할까요?

React는 DOM 노드를 생성할 때, 그 노드에 Fiber를 가리키는 숨겨진 프로퍼티를 심어둡니다. 프로퍼티 이름은 `__reactFiber$k2f9a8b`처럼 생겼는데, 뒤의 랜덤 문자열은 매 페이지 로드마다 달라집니다. 이름표가 붙은 방식이 재미있습니다.

랜덤 접미사를 붙이는 이유가 있습니다. 같은 페이지에 여러 React 버전이 존재할 때, 모두 같은 이름의 프로퍼티를 사용하면 서로 덮어쓰는 충돌이 발생합니다. 각자 고유한 키를 사용하면 이 문제를 피할 수 있습니다. 또한 외부 라이브러리나 코드가 이 프로퍼티 이름을 하드코딩해서 의존할 수 없게 됩니다. React 내부 구현을 캡슐화하는 방법입니다.

DOM에서 Fiber를 찾는 알고리즘은 간단하면서도 영리합니다. 먼저 클릭된 노드에 직접 Fiber 프로퍼티가 있는지 확인합니다. 없다면 부모 노드로 올라가며 반복합니다. 루트까지 도달하면 멈춥니다. 텍스트 노드나 순수 CSS 레이아웃 용도의 중간 DOM 노드처럼 Fiber가 없는 노드도 이렇게 처리됩니다.

반대 방향, 즉 Fiber에서 DOM 노드를 찾는 것은 더 단순합니다. 각 HostComponent Fiber는 `stateNode` 필드에 실제 DOM 노드를 직접 참조합니다. Fiber 트리를 아래로 순회하며 가장 가까운 HostComponent를 찾으면 됩니다.

이 양방향 매핑 덕분에 DevTools는 컴포넌트를 클릭하면 해당 DOM 노드를 하이라이트하고, DOM 노드를 클릭하면 해당 컴포넌트를 패널에서 선택할 수 있습니다.

---

## React가 DevTools에 보내는 네 가지 신호

React의 렌더링 사이클을 이해했다면, DevTools가 컴포넌트 트리를 실시간으로 반영할 수 있는 이유를 생각해볼 수 있습니다. 렌더링이 일어날 때마다 DevTools가 어떻게 알 수 있을까요?

React는 중요한 순간마다 DevTools에 콜백을 호출합니다. 네 가지 시점이 있습니다.

**첫 번째**는 렌더링이 예약될 때입니다. `ReactDOM.render()`나 `root.render()`가 호출되면, React는 DevTools에 "이 루트에 이 엘리먼트가 렌더링될 예정이다"라고 알립니다. DevTools는 이 순간부터 해당 루트를 추적 대상으로 등록합니다.

**두 번째이자 가장 중요한** 시점은 커밋 완료 직후입니다. React가 DOM에 변경사항을 모두 반영하고 나면, `onCommitFiberRoot`를 호출하며 FiberRoot 전체를 전달합니다. DevTools는 이 FiberRoot를 순회하며 변경된 컴포넌트들을 파악하고 패널의 트리를 업데이트합니다. 이 콜백에는 어떤 우선순위로 렌더링이 일어났는지(`schedulerPriority`), Error Boundary에서 에러가 포착되었는지(`didError`)도 함께 전달됩니다.

**세 번째**는 컴포넌트가 언마운트될 때입니다. Fiber가 트리에서 제거되는 시점에 `onCommitFiberUnmount`가 호출됩니다. DevTools는 이 신호를 받아 패널에서 해당 컴포넌트를 제거하고, 관련 참조를 정리합니다. 이 정리가 없으면 삭제된 Fiber가 메모리에 계속 남아 있는 누수가 발생합니다.

**네 번째**는 passive effects가 모두 실행된 직후입니다. `useEffect` 콜백들이 완료되면 `onPostCommitRoot`가 호출됩니다. Profiler는 이 시점에 passive effect의 실행 시간을 수집합니다. `effectDuration` 값이 리셋되기 직전에 호출되기 때문에, 이 값을 읽을 수 있는 마지막 기회입니다.

이 네 신호의 타이밍 관계를 이해하면, DevTools Profiler의 데이터가 왜 그렇게 정확한지 알 수 있습니다. React가 의도적으로 적절한 시점에 DevTools를 호출하도록 설계되어 있기 때문입니다.

---

## 컴포넌트 이름은 어디서 오는가

DevTools 패널에서 "MyComponent", "Fragment", "Suspense.Provider" 같은 이름을 볼 수 있습니다. 이 이름들은 어디서 결정되는 걸까요?

`getComponentNameFromFiber`라는 함수가 이 역할을 합니다. Fiber의 `tag` 필드에 따라 분기합니다. `tag`는 Fiber의 종류를 나타내는 정수입니다. `HostComponent`(실제 DOM 엘리먼트)이면 `'div'`, `'span'` 같은 태그 이름을 그대로 반환합니다. `SuspenseComponent`이면 `'Suspense'`를 반환합니다. `ContextProvider`이면 `'MyContext.Provider'` 형태로 Context의 displayName을 조합합니다.

사용자가 정의한 컴포넌트는 이름 해석의 우선순위 체인을 따릅니다. 먼저 `type.displayName`을 확인합니다. 없으면 `type.name`, 즉 함수의 이름을 사용합니다. 둘 다 없으면 null이 반환되어 DevTools에서 "Anonymous"로 표시됩니다.

`memo()`나 `forwardRef()`로 감싼 컴포넌트의 경우, 래퍼 컴포넌트의 이름과 안쪽 컴포넌트의 이름을 조합합니다. `memo(() => <div/>)`처럼 익명 함수를 전달하면 안쪽 이름이 없으므로 "Anonymous"가 됩니다. 이것이 DevTools에서 `displayName`을 명시적으로 설정해야 하는 이유입니다.

```javascript
// displayName을 설정하면 DevTools에서 이름이 정확히 표시됩니다
const UserCard = memo(function UserCard({ user }) {
  return <div>{user.name}</div>;
});
```

이 코드에서 핵심은 함수에 이름(`UserCard`)이 있다는 점입니다. 화살표 함수를 전달하면 `type.name`이 빈 문자열이 되어 DevTools에서 이름을 표시할 수 없습니다.

---

## 현재 렌더링 중인 컴포넌트를 추적하는 방법

오류가 발생했을 때 "어느 컴포넌트를 렌더링하는 중에 발생했다"고 정확히 알려줄 수 있는 이유가 있습니다. React는 모듈 수준에 `current`라는 변수 하나를 유지합니다. 각 Fiber를 처리하기 시작할 때 이 변수에 현재 Fiber를 할당하고, 처리가 끝나면 null로 리셋합니다.

DevTools는 `getCurrentFiber` 함수를 통해 이 값을 언제든 읽을 수 있습니다. 에러가 발생했을 때 이 함수를 호출하면 "지금 React가 어느 컴포넌트를 처리 중인지" 정확하게 알 수 있습니다.

여기서 `_debugOwner`라는 개념도 등장합니다. 이것은 Fiber 트리의 구조적 부모와는 다릅니다. 구조적 부모(`return`)는 DOM 트리의 부모와 비슷하게, 위에 있는 Fiber를 가리킵니다. 반면 `_debugOwner`는 JSX를 작성한 컴포넌트, 즉 "이 컴포넌트를 코드로 렌더링한 책임자"를 가리킵니다.

예를 들어, `App`이 `Layout`을 렌더링하고 `Layout`이 `Button`을 렌더링한다면, `Button`의 `_debugOwner`는 `Layout`입니다. DevTools에서 "Owner"를 보여줄 때 이 정보를 활용합니다. 코드 추적에 매우 유용한 정보입니다.

---

## 실시간 편집은 어떻게 작동하는가

DevTools 패널에서 상태 값을 클릭하고 수정하면 컴포넌트가 즉시 리렌더링됩니다. 이것은 단순히 "값을 바꾸고 렌더링을 요청한다"는 설명보다 훨씬 정교한 메커니즘으로 동작합니다.

Hook 상태를 편집할 때를 생각해봅시다. React의 Hook 시스템에서 각 컴포넌트의 Hook 목록은 연결 리스트로 저장됩니다. 첫 번째 Hook이 `memoizedState`에 있고, 다음 Hook은 `next`로 연결됩니다. DevTools가 "세 번째 Hook의 값을 바꾸고 싶다"면, 이 리스트를 세 번 순회하여 해당 Hook을 찾습니다.

찾은 후에는 단순히 값을 덮어쓰는 게 아닙니다. 불변성을 유지하며 새로운 객체를 만들어야 합니다. `copyWithSet` 함수가 이 역할을 합니다. 중첩된 객체에서 특정 경로의 값만 바꾸면서 나머지는 그대로 유지하는 불변 업데이트를 수행합니다.

여기서 흥미로운 설계 포인트가 있습니다. Hook 상태를 바꾸면 React가 리렌더링을 건너뛸 수 있습니다. React의 reconciler는 props가 이전과 같은 참조라면 컴포넌트를 재사용합니다(bailout). Hook만 바뀌고 props는 그대로라면 bailout이 일어나 변경이 반영되지 않습니다. 이를 방지하기 위해 DevTools는 Hook 상태를 바꿀 때 `fiber.memoizedProps`를 새 객체로 얕은 복사합니다. 내용은 같지만 참조가 달라지므로, React는 "props가 바뀌었다"고 판단하여 bailout을 건너뜁니다.

마지막 단계는 `SyncLane`으로 업데이트를 예약하는 것입니다. SyncLane은 React의 우선순위 체계에서 가장 높은 우선순위입니다. DevTools에서 값을 편집하면 다음 프레임이 아니라 **즉시** 반영되는 이유입니다.

---

## Profiler가 측정하는 것들

Profiler가 각 컴포넌트의 렌더링 시간을 어떻게 측정하는지 이해하면, 그 데이터를 더 잘 해석할 수 있습니다.

각 FiberNode에는 네 가지 타이밍 필드가 있습니다. `actualDuration`은 이번 렌더에서 이 Fiber와 하위 트리를 처리하는 데 걸린 실제 시간입니다. `actualStartTime`은 이 Fiber의 렌더가 시작된 시각입니다. `selfBaseDuration`은 이 Fiber 자체만의 렌더링 시간(하위 트리 제외)이고, `treeBaseDuration`은 이 Fiber와 전체 하위 트리의 시간 합계입니다.

측정 메커니즘은 스톱워치를 여러 개 중첩하는 것과 비슷합니다. 부모 Fiber를 처리하기 시작하면 타이머를 시작합니다. 자식 Fiber를 처리하기 위해 넘어가면 부모 타이머를 일시 정지하고 기록한 뒤, 자식 타이머를 시작합니다. 자식 처리가 끝나면 부모 타이머를 다시 시작합니다. 이렇게 하면 각 Fiber의 자체 처리 시간이 정확히 측정됩니다.

완료 단계에서는 이 값들이 부모로 버블링됩니다. 자식의 `actualDuration`이 부모에 더해집니다. 결국 루트 Fiber의 `actualDuration`은 전체 렌더 트리의 총 렌더링 시간이 됩니다. DevTools의 Flamegraph는 이 계층적 데이터를 시각화한 것입니다.

FiberNode 초기화에서 흥미로운 V8 엔진 최적화가 있습니다. 타이밍 필드들을 처음에 `NaN`으로 설정했다가 곧바로 `0`으로 덮어씁니다. 순서가 중요합니다. V8 엔진의 숨겨진 클래스(hidden class) 최적화와 관련된 이슈입니다. 필드가 처음부터 부동소수점(NaN)으로 설정되면, 이후 정수(0)가 들어와도 이미 "이 필드는 double 타입"으로 정해진 hidden class가 유지됩니다. 만약 반대 순서였다면 타이밍 측정 중 타입이 바뀌면서 hidden class가 새로 생성되고 성능이 저하됩니다. 이 두 줄이 V8 성능을 위한 의도적 선택입니다.

---

## Timeline Profiler: 더 세밀한 추적

React 18에서 도입된 Timeline Profiler는 기존 Profiler보다 훨씬 세밀한 데이터를 제공합니다. 여기서는 별도의 이벤트 시스템이 동작합니다.

기존 Profiler가 "이번 커밋에서 각 컴포넌트가 몇 ms 걸렸다"는 요약 데이터를 제공한다면, Timeline Profiler는 "렌더가 시작된 정확한 시각, 중간에 Time Slicing으로 양보한 시점, 커밋이 시작된 시점, Layout Effect가 끝난 시점"을 타임라인 형태로 기록합니다.

이를 위해 `injectedProfilingHooks`라는 별도 객체가 사용됩니다. DevTools가 Timeline Profiler를 활성화하면 이 객체를 설정하고, React는 18가지 이상의 세밀한 이벤트를 이 객체의 메서드로 호출합니다. 렌더 시작, 렌더 양보, 컴포넌트별 렌더 시작/종료, 커밋 시작/종료, Layout Effect 시작/종료, Passive Effect 시작/종료, 에러, Suspense 발생 등이 포함됩니다.

중요한 설계 결정은 이 시스템의 오버헤드 처리 방식입니다. 모든 이벤트 메서드는 시작에서 `injectedProfilingHooks !== null`을 확인합니다. Timeline Profiler가 비활성화된 상태에서는 이 체크 하나로 즉시 반환됩니다. 조건문 하나의 비용만으로 전체 프로파일링 시스템을 우회합니다.

Lane 정보가 이벤트와 함께 전달된다는 점도 중요합니다. 어떤 업데이트가 어느 우선순위에서 발생했는지가 타임라인에 시각화됩니다. 클릭 이벤트(Sync Lane)와 백그라운드 데이터 로드(Default Lane)가 타임라인에서 서로 다른 레인으로 구분되어 보입니다.

---

## "왜 이 컴포넌트가 리렌더링되었는가"

DevTools Profiler의 "Why did this render?" 기능은 `memoizedUpdaters`라는 데이터 구조로 동작합니다.

`setState`가 호출될 때마다, React는 호출을 발생시킨 Fiber를 `pendingUpdatersLaneMap`에 기록합니다. 이것은 Lane별로 나뉜 Set의 배열입니다. 여러 업데이트가 같은 렌더 사이클에 합쳐질 때, 각 Lane마다 어떤 Fiber들이 업데이트를 트리거했는지 추적합니다.

렌더가 시작되기 직전, 이 정보가 `memoizedUpdaters`로 옮겨집니다. 커밋이 완료되어 DevTools에 알림이 가면, DevTools는 `root.memoizedUpdaters`를 읽어 "이번 커밋이 어느 컴포넌트의 setState에 의해 시작되었는지"를 파악합니다. Profiler에서 특정 커밋을 클릭할 때 원인 컴포넌트가 표시되는 것이 이 메커니즘 덕분입니다.

이 추적은 DevTools가 설치되어 있을 때만 활성화됩니다.

```javascript
function addFiberToLanesMap(root, fiber, lanes) {
  if (!isDevToolsPresent) {
    return; // DevTools가 없으면 추적 비용을 아예 지불하지 않습니다
  }
  // ...
}
```

이 코드에서 핵심은 첫 번째 줄입니다. DevTools가 없는 환경(프로덕션 포함)에서는 Lane 추적 자체를 건너뜁니다. 추적 비용을 DevTools 사용자만 지불합니다.

---

## DevTools가 React에 미치는 영향

"DevTools를 열어두면 앱이 느려진다"는 이야기가 있습니다. 어느 정도 사실이지만, 오버헤드의 출처를 정확히 이해하는 것이 중요합니다.

React 런타임 자체의 오버헤드는 매우 작습니다. 커밋마다 `onCommitFiberRoot` 한 번, 언마운트마다 `onCommitFiberUnmount` 한 번, passive effect 완료마다 `onPostCommitRoot` 한 번이 전부입니다. 각 setState마다 Set에 Fiber를 추가하는 비용도 있지만, 이 역시 작습니다.

진짜 오버헤드는 DevTools Backend에서 발생합니다. `onCommitFiberRoot`를 받으면 DevTools는 FiberRoot 전체를 직접 순회하며 변경된 컴포넌트를 찾고 직렬화합니다. 이 과정이 크고 복잡한 컴포넌트 트리에서는 시간이 걸립니다. React 런타임 코드가 아니라 DevTools 확장 코드에서 발생하는 비용입니다.

또한 DEV 빌드에서만 존재하는 필드들이 있습니다. `_debugSource`(JSX 소스 위치), `_debugOwner`(JSX를 작성한 컴포넌트), `_debugHookTypes`(이 컴포넌트가 사용한 Hook 목록)가 각 Fiber에 추가됩니다. 특히 `_debugHookTypes`는 렌더링 중 Hook이 호출될 때마다 배열에 추가됩니다. 이 오버헤드는 Production 빌드에서 완전히 사라집니다.

---

## React와 DevTools의 공생 관계

React DevTools가 인상적인 이유는 단순한 디버깅 도구가 아니기 때문입니다. React의 설계 철학이 적용된 관측 시스템입니다.

일반적인 디버거는 대상 프로그램의 실행을 중단시키고, 메모리를 직접 읽고, 중단점을 심는 방식으로 동작합니다. React DevTools는 다릅니다. React가 자발적으로 DevTools에 이벤트를 알리고, DevTools가 요청할 때 React가 정해진 함수를 실행합니다. 대상 프로그램이 디버거를 호출하는 구조입니다.

이 역전된 제어 흐름 덕분에 React는 "DevTools가 알아야 할 것"을 정확히 제어할 수 있습니다. 구현 세부사항을 감추면서 필요한 인터페이스만 노출합니다. DevTools는 React 내부에 직접 접근하는 것이 아니라, React가 허용한 채널로만 소통합니다.

전역 훅 패턴, 랜덤 접미사 키, null 체크 패턴, SyncLane 업데이트, V8 hidden class 최적화까지, React DevTools 코드에는 작은 결정 하나하나가 이유 있게 설계되어 있습니다. 이것이 소스 코드를 직접 읽는 것의 가치입니다. 단순히 "어떻게 동작하는지"를 넘어, "왜 이렇게 결정했는지"를 이해할 수 있게 됩니다.

React는 UI를 그리는 라이브러리이면서, 동시에 그 자신을 관측하는 도구를 설계 시점부터 품고 있습니다. DevTools와 React의 관계는 공생(symbiosis)입니다. React가 DevTools 없이도 완벽하게 동작하지만, DevTools가 있을 때 비로소 React의 내부가 투명하게 드러납니다.