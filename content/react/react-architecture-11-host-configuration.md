---
title: "React는 DOM을 어떻게 모르면서 DOM을 그리는가 — Host Configuration 아키텍처"
date: "2025-02-20"
tags: [React, Architecture, Reconciler, HostConfig, Renderer]
series: "React 아키텍처 심층 분석"
---

React를 처음 배울 때 우리는 JSX를 작성하면 화면에 무언가 나타난다는 사실을 당연하게 받아들입니다. 그런데 조금 더 깊이 파고들면 이상한 점이 눈에 띕니다. React는 웹 브라우저뿐 아니라 iOS, Android, 터미널, PDF, Canvas, 심지어 Figma 플러그인에서도 동작합니다. 어떻게 하나의 프레임워크가 이렇게 다양한 환경을 지원할 수 있을까요? 더 근본적인 질문으로 가면, React의 핵심 엔진인 Reconciler는 `document.createElement`라는 함수를 단 한 번도 직접 호출하지 않습니다. 그렇다면 DOM은 대체 누가 만드는 걸까요?

이 질문의 답이 바로 **Host Configuration**입니다.

## "Learn Once, Write Anywhere"의 비밀

2015년 React Native 발표 당시 Facebook은 "Write Once, Run Anywhere"가 아니라 "Learn Once, Write Anywhere"라는 슬로건을 내세웠습니다. 미묘하지만 중요한 차이입니다. 코드를 그대로 재사용하겠다는 약속이 아니라, 동일한 사고 방식과 패턴으로 어느 플랫폼이든 다룰 수 있다는 약속이었습니다.

이 약속을 가능하게 하는 건 기술적인 마법이 아니라 오래된 소프트웨어 공학 원칙인 **관심사의 분리**입니다. React 아키텍처는 두 계층 사이에 명확한 경계선을 그어두었습니다. 하나는 "무엇이 변했는가"를 계산하는 계층이고, 다른 하나는 "그 변화를 실제로 적용하는" 계층입니다. 전자가 Reconciler이고, 후자가 Renderer입니다. 그리고 둘 사이를 연결하는 계약이 바로 Host Configuration입니다.

비유하자면 Reconciler는 훌륭한 지휘자입니다. 악보를 읽고 각 파트가 언제 어떤 음을 연주해야 하는지 정확히 알고 있습니다. 하지만 지휘자 자신은 악기를 연주하지 않습니다. 오케스트라 단원들, 즉 바이올린 섹션과 첼로 섹션이 각자의 방식으로 소리를 만들어냅니다. Host Configuration은 지휘자와 단원 사이의 악보 언어, 즉 "피치포르테"나 "스타카토" 같은 공통 기호 체계에 해당합니다. 지휘자는 이 기호가 현악기에서 어떤 활 움직임으로 구현되는지 알 필요가 없습니다.

## Reconciler는 무엇을 모르는가

React Reconciler의 소스 코드를 들여다보면 놀라운 사실을 발견할 수 있습니다. 29,000줄이 넘는 react-dom 빌드 결과물 어디에도 Reconciler 내부에서 `document.createElement`를 직접 부르는 코드는 없습니다. 대신 Reconciler는 `createInstance`라는 추상 함수를 호출합니다. DOM이 뭔지도, Native View가 뭔지도 모릅니다. 그저 "이런 타입의 인스턴스를 만들어줘"라고 요청할 뿐입니다.

Reconciler가 실제로 아는 것은 60개 이상의 메서드 시그니처, 즉 Host Config 인터페이스뿐입니다. `createInstance`, `createTextInstance`, `appendChild`, `removeChild`, `prepareUpdate`, `commitUpdate`... Reconciler는 이 함수들을 호출하면 "어떤 인스턴스"가 만들어지거나, "어떤 구조"가 바뀐다는 것만 압니다. 반환된 인스턴스가 `HTMLDivElement`인지, Fabric의 Shadow Node인지, `THREE.Mesh`인지는 전혀 모릅니다.

이것이 React가 "DOM을 모르면서 DOM을 그리는" 메커니즘의 핵심입니다.

## 빌드 타임 의존성 주입: Fork 시스템

Reconciler가 Host Config 함수들을 어떻게 주입받는지가 또 하나의 흥미로운 설계 결정입니다. 런타임 다형성(인터페이스 + 구현체)이 아니라 **빌드 타임 fork** 방식을 선택했습니다.

React GitHub 소스 코드에서 Reconciler는 `ReactFiberHostConfig`라는 이름으로 Host Config를 import합니다. 그런데 이 파일은 실제로 존재하지 않습니다. 빌드 스크립트가 대상 플랫폼에 따라 이 import를 실제 구현체로 교체합니다. react-dom을 빌드하면 DOM 구현체로, react-native를 빌드하면 Fabric 구현체로 바뀝니다. 우리가 npm install로 받는 react-dom.development.js는 이미 이 fork가 완료된 상태의 단일 번들 파일입니다. 29,923줄 안에 Reconciler 코드와 DOM Host Config 코드가 하나로 녹아 있는 이유가 바로 이것입니다.

왜 런타임 주입 대신 빌드 타임 fork를 선택했을까요? 성능 때문입니다. 런타임에 인터페이스를 통해 가상 함수 호출을 하면 JavaScript 엔진의 최적화(인라이닝, JIT 컴파일)가 어려워집니다. 빌드 타임에 코드 경로가 확정되면 엔진이 훨씬 적극적으로 최적화할 수 있습니다. React가 성능을 위해 코드 유지보수성의 일부를 기꺼이 희생한 흔적입니다.

## 두 가지 렌더러 모드

Host Config는 단순히 함수 구현만 제공하는 게 아닙니다. 렌더러가 어떤 "성격"인지를 선언하는 플래그도 포함합니다. react-dom의 경우 `supportsMutation: true`, `supportsPersistence: false`, `supportsHydration: true`입니다.

이 중 가장 중요한 게 Mutation Mode와 Persistence Mode의 구분입니다. react-dom은 Mutation Mode 렌더러입니다. 기존 DOM 노드를 직접 수정(mutate)합니다. `className`이 바뀌면 해당 DOM 노드의 `className` 속성을 직접 변경합니다. 반면 React Native의 Fabric 렌더러는 Persistence Mode를 사용합니다. 기존 노드를 수정하지 않고, 변경된 부분을 반영한 새 노드를 clone해서 완전히 새로운 트리를 구성한 뒤 한 번에 교체합니다.

마치 문서를 편집하는 두 가지 방식과 같습니다. 하나는 종이에 직접 지우고 쓰는 방식(Mutation)이고, 다른 하나는 복사본을 만들어 수정한 뒤 원본과 교체하는 방식(Persistence)입니다. Reconciler 내부에서는 이 플래그에 따라 완전히 다른 코드 경로를 탑니다. 같은 "자식 노드 추가" 작업이지만, Mutation Mode에서는 기존 노드에 `appendChild`를 호출하고, Persistence Mode에서는 부모 노드를 clone하고 새 자식을 포함시킵니다.

## Fiber와 DOM의 양방향 연결: 보이지 않는 다리

Host Configuration에서 가장 핵심적이면서도 외부에 잘 드러나지 않는 부분이 **Fiber 노드와 DOM 노드의 양방향 연결**입니다. React는 두 개의 트리를 동시에 관리합니다. 메모리 내의 Fiber 트리와 실제 화면을 구성하는 DOM 트리입니다. 이 둘 사이를 빠르게 오갈 수 있어야 이벤트 처리, ref, DevTools 등이 동작합니다.

React가 선택한 방법은 DOM 노드에 직접 속성을 심는 것입니다. 애플리케이션이 로드될 때 랜덤 문자열이 생성되고, 이를 접미사로 한 특수 키가 만들어집니다. 브라우저 DevTools에서 아무 React 엘리먼트나 콘솔에서 조회해보면 `__reactFiber$abc123` 같은 이름의 숨겨진 속성을 발견할 수 있습니다. 이 속성이 바로 해당 DOM 노드에 대응하는 Fiber 노드를 가리키는 포인터입니다. 마찬가지로 `__reactProps$abc123`에는 현재 props 객체가 저장됩니다.

왜 랜덤 키를 사용할까요? 한 페이지에서 여러 React 인스턴스가 동시에 실행될 수 있기 때문입니다. 마이크로프론트엔드 아키텍처나 레거시 코드에 React를 점진적으로 도입하는 경우가 이에 해당합니다. 각 React 인스턴스가 고유한 키를 가져야, 동일한 DOM 노드에서 올바른 인스턴스의 Fiber를 찾을 수 있습니다.

이 연결의 핵심은 단 두 개의 함수로 구현됩니다. `precacheFiberNode`는 DOM 노드에 Fiber 참조를 저장하고, `updateFiberProps`는 최신 props를 저장합니다. 각각 한 줄짜리 함수입니다. 복잡해 보이는 이벤트 시스템과 ref 시스템이 이 두 줄 위에 세워진 것입니다.

```javascript
// Host Config 내부: DOM 노드에 Fiber를 연결하는 두 줄
function precacheFiberNode(hostInst, node) {
  node[internalInstanceKey] = hostInst;
}

function updateFiberProps(node, props) {
  node[internalPropsKey] = props;
}
```

이 코드에서 핵심은 `internalInstanceKey`가 `'__reactFiber$' + randomKey` 형태의 동적으로 생성된 키라는 점입니다. 런타임에 결정되므로 외부에서 예측하거나 충돌시키기가 어렵습니다.

이 양방향 연결이 실제로 어떻게 활용되는지는 이벤트 처리에서 가장 잘 드러납니다. 사용자가 버튼을 클릭하면, 이벤트는 document 레벨에서 위임 처리됩니다. `event.target`이 가리키는 DOM 노드에서 `__reactFiber$xxx`를 읽어 해당 Fiber를 찾고, `__reactProps$xxx`에서 `onClick` 핸들러를 꺼내 실행합니다. React의 이벤트 시스템 전체가 이 연결 위에서 동작합니다.

## 인스턴스 생성: DOM 노드가 태어나는 순간

새 컴포넌트가 화면에 처음 나타날 때 Reconciler는 `createInstance`를 호출합니다. 이 함수는 `type`(HTML 태그명), `props`(React props), `rootContainerInstance`(루트 DOM 컨테이너), `hostContext`(부모로부터 전달된 컨텍스트 정보), 그리고 `internalInstanceHandle`(이 노드에 해당하는 Fiber 노드)을 인자로 받습니다. 그리고 실제 DOM 엘리먼트를 반환합니다.

내부적으로 세 단계를 거칩니다. 첫째, DEV 모드에서는 DOM 중첩 규칙을 검증합니다(예: `<p>` 안에 `<div>`를 넣으려 하면 경고). 둘째, 실제 DOM 엘리먼트를 생성합니다. 셋째, 방금 만든 DOM 노드에 Fiber를 연결합니다.

실제 DOM 엘리먼트를 생성하는 과정에는 흥미로운 예외 처리들이 있습니다. `<script>` 태그는 `document.createElement('script')`로 만들면 parser-inserted 플래그가 `false`가 되어 브라우저가 즉시 실행하려 할 수 있습니다. 그래서 `<div>`를 만들고 innerHTML로 `<script>` 태그를 삽입한 뒤 꺼내는 우회 방법을 씁니다. `<select>` 태그는 `option` 자식들이 삽입되기 전에 `multiple`과 `size` 속성을 미리 설정해야 합니다. 그러지 않으면 브라우저가 첫 번째 option을 자동으로 선택하는 버그가 발생합니다. 그리고 SVG 내부의 엘리먼트들은 `document.createElement` 대신 `document.createElementNS`로 만들어야 합니다.

이 마지막 케이스를 올바르게 처리하기 위해 Host Context가 필요합니다.

## Host Context: 조상의 기억을 자손에게

DOM 트리를 렌더링할 때 어떤 정보는 조상 엘리먼트로부터 자손에게 전달되어야 합니다. 대표적인 게 XML 네임스페이스입니다. `<svg>` 태그 내부의 모든 자손 엘리먼트는 `createElementNS`로 SVG 네임스페이스를 명시해서 만들어야 합니다. 그러지 않으면 아무것도 화면에 렌더링되지 않는 치명적인 버그가 발생합니다.

Host Context는 Fiber 트리를 내려가면서 컨텍스트를 전파하는 메커니즘입니다. `getRootHostContext`가 루트의 컨텍스트(초기 네임스페이스)를 만들고, `getChildHostContext`가 각 노드를 방문할 때마다 컨텍스트를 갱신합니다. `<div>` 안에 `<svg>`가 나타나면 컨텍스트의 namespace가 HTML에서 SVG로 바뀌고, `<svg>` 안의 `<foreignObject>` 내부에 `<div>`가 나타나면 다시 HTML로 복귀합니다.

DEV 모드에서는 여기에 `ancestorInfo`도 추가됩니다. 조상 태그들의 정보를 누적해서 `<p>` 안에 `<div>`를 넣거나 `<table>` 안에 올바르지 않은 자식을 넣는 등의 잘못된 DOM 중첩을 감지하고 경고를 출력합니다. 실제 브라우저에서 이런 마크업은 에러 없이 렌더링되지만 파서가 DOM을 자동으로 보정하면서 React가 예상하는 트리와 달라질 수 있습니다. Host Context의 검증이 이런 조용한 버그를 미리 막아줍니다.

## Props Diff: 변화를 수학적으로 계산하기

컴포넌트가 업데이트될 때 모든 props를 다시 DOM에 적용하는 건 비효율적입니다. React는 Render Phase에서 `prepareUpdate`를 호출해, 이전 props와 새 props 사이의 차이만 계산합니다. 그 결과물이 `updatePayload`입니다.

`updatePayload`의 형태는 플랫 배열입니다: `[key1, value1, key2, value2, ...]`. 오브젝트 대신 플랫 배열을 선택한 이유는 메모리 효율과 순회 효율 때문입니다. 키-값 쌍을 인덱스로 접근(`payload[i]`, `payload[i+1]`)하는 게 오브젝트의 프로퍼티 접근보다 JavaScript 엔진이 최적화하기 유리합니다. 변경이 없으면 `null`을 반환해서 Commit Phase 자체를 건너뜁니다.

스타일 속성은 특별히 처리됩니다. `style` 오브젝트 전체를 교체하는 대신, 변경된 개별 스타일 속성만 추출합니다. `{ color: 'red', fontSize: 14 }`에서 `{ color: 'blue', fontSize: 14 }`로 바뀌면 updatePayload에는 `['style', { color: 'blue' }]`만 들어갑니다. `fontSize`는 변경이 없으므로 포함되지 않습니다.

이벤트 핸들러(`onClick` 등)가 변경될 때의 처리는 더 흥미롭습니다. 이벤트 핸들러는 DOM attribute가 아니라 `__reactProps$xxx`에서 읽히기 때문에, updatePayload에 키-값을 추가하지 않습니다. 하지만 완전히 무시하지도 않습니다. 빈 배열(`[]`)을 반환합니다. 왜일까요? Commit Phase에서 `commitUpdate`가 호출되어야 `updateFiberProps`로 최신 props가 DOM 노드에 저장됩니다. 빈 배열이라도 null이 아니면 `commitUpdate`가 트리거되고, 그 과정에서 최신 이벤트 핸들러가 DOM 노드의 `__reactProps$xxx`에 갱신됩니다.

## Commit Phase: 계산에서 현실로

Render Phase에서 계산된 `updatePayload`는 Fiber의 `updateQueue`에 저장됩니다. 실제 DOM 변경은 Commit Phase에서 일어납니다. 이 2-Phase 구조가 Concurrent Mode의 핵심입니다. Render Phase는 중단했다가 재개할 수 있지만, Commit Phase는 반드시 동기적으로, 중단 없이 완료됩니다.

Commit Phase가 시작되기 직전, `prepareForCommit`이 호출됩니다. 두 가지 중요한 일을 합니다. 첫째, 이벤트 시스템을 비활성화합니다. DOM을 조작하는 도중에 `focus`, `blur` 같은 이벤트가 발생하면 예측 불가능한 상태가 될 수 있기 때문입니다. 둘째, 현재 텍스트 선택(selection) 상태를 저장합니다. 사용자가 텍스트를 드래그 선택한 상태에서 DOM이 바뀌면 선택이 사라지는데, 커밋 전에 저장해뒀다가 커밋 후에 복원합니다. 사용자는 React가 DOM을 조작하는 동안 선택이 사라지는 현상을 경험하지 않습니다.

`commitUpdate`는 두 단계로 구성됩니다. `updateProperties`가 `updatePayload` 배열을 순회하며 실제 DOM 속성을 변경하고, `updateFiberProps`가 DOM 노드에 최신 props를 저장합니다. 플랫 배열을 `i += 2`로 순회하며 각 키에 맞는 DOM API를 호출합니다. `style`이면 `domElement.style[name] = value`, `dangerouslySetInnerHTML`이면 `domElement.innerHTML = value`, 나머지는 `setAttribute` 또는 직접 프로퍼티 할당입니다.

기본 DOM 조작 함수들(`appendChild`, `insertBefore`, `removeChild`)은 놀라울 정도로 단순합니다. 네이티브 DOM API를 그대로 위임합니다. 복잡성은 Portal과 SSR 처리를 위한 Container 변형 함수들에 있습니다. Portal의 컨테이너가 Comment 노드일 경우(`<!-- -->`) 부모 노드를 한 단계 올라가서 조작해야 합니다. 또한 Mobile Safari에서 비대화형 엘리먼트(예: `<div>`)에 클릭 이벤트가 버블링되지 않는 오래된 브라우저 버그를 우회하기 위해 빈 `onclick` 핸들러를 설정하는 코드도 있습니다. 수년간 쌓인 브라우저 호환성 대응의 흔적입니다.

## Suspense와 Visibility 관리

Suspense가 fallback으로 전환될 때, React는 기존 콘텐츠를 제거하지 않고 단순히 숨깁니다. 이렇게 해야 컨텐츠가 다시 나타날 때 DOM 노드를 재사용할 수 있고, 내부 상태(예: 스크롤 위치, 포커스)가 보존됩니다.

`hideInstance`는 `display: none !important`를 설정합니다. `!important`를 붙이는 이유가 있습니다. 해당 엘리먼트에 이미 인라인 스타일로 `display: flex`가 설정되어 있을 수 있습니다. `!important` 없이 `display: none`을 설정하면 인라인 스타일이 우선 적용되어 숨김 처리가 무시됩니다. `unhideInstance`는 원래 props의 `style.display` 값을 참조해서 정확히 원래 상태로 복원합니다. 숨기기 전이 `flex`였다면 `flex`로, `grid`였다면 `grid`로 돌아옵니다.

텍스트 노드의 숨김/표시는 더 단순합니다. `hideTextInstance`는 `textNode.nodeValue = ''`로 텍스트를 비우고, `unhideTextInstance`는 원래 텍스트를 복원합니다. DOM에서 텍스트 노드를 `display: none`으로 처리할 수 없기 때문에 내용을 비우는 방식을 선택한 것입니다.

## SSR과 Hydration: 서버의 선물을 받아들이는 방법

서버사이드 렌더링(SSR)은 서버에서 미리 HTML을 만들어 클라이언트에 보냅니다. 클라이언트에서 React가 로드되면 이 HTML을 새로 만들지 않고 재활용합니다. 이 과정이 Hydration입니다.

Host Config는 Hydration을 위한 전용 메서드 집합을 제공합니다. `canHydrateInstance`는 SSR이 만든 DOM 노드와 React가 만들려는 노드의 태그명이 일치하는지 확인합니다. 일치하면 `hydrateInstance`가 호출되어, 새 DOM 노드 생성 없이 기존 노드에 Fiber를 연결합니다. `createInstance` 대신 `hydrateInstance`를 쓰는 것입니다. 이후 `diffHydratedProperties`가 서버에서 렌더링한 속성과 클라이언트 props를 비교해 불일치를 감지하고 경고를 출력합니다.

SSR HTML에는 React가 삽입한 Comment 노드들이 있습니다(`<!--$-->`, `<!--/$-->` 등). 이 Comment 노드들이 Suspense 경계를 표시합니다. `getNextHydratable` 함수는 DOM을 순회하면서 Element 노드, Text 노드, 그리고 Suspense를 나타내는 특정 Comment 노드만 Hydration 대상으로 인식합니다. 나머지 Comment 노드는 건너뜁니다. Hydration 과정에서 이벤트가 발생하면 어떻게 될까요? 아직 Hydrate되지 않은 Suspense 경계 내부의 DOM 노드에서 이벤트가 발생하면, `getClosestInstanceFromNode`가 DOM 트리를 거슬러 올라가며 Suspense Comment 노드까지 추적해서 가장 가까운 Fiber를 찾아냅니다.

## 커스텀 렌더러: Host Config가 열어주는 가능성

`react-reconciler` npm 패키지는 Host Config 인터페이스를 직접 구현해서 나만의 렌더러를 만들 수 있게 해줍니다. react-three-fiber는 이 방식으로 Three.js 씬 그래프를 React 컴포넌트로 선언적으로 작성할 수 있게 해줍니다. Ink는 터미널 UI를 React로 만들 수 있게 합니다. react-pdf는 PDF 문서를 JSX로 작성합니다. react-figma는 Figma 플러그인을 React 컴포넌트 트리로 표현합니다.

이들 모두 동일한 `react-reconciler`를 사용하고, Host Config만 다르게 구현합니다. `createInstance`에서 `document.createElement` 대신 `new THREE.Mesh()`를 호출하거나 터미널 텍스트 박스를 만들면 됩니다. 그러면 React의 상태 관리, Hooks, Suspense, Concurrent Mode, 자동 배칭, 우선순위 기반 스케줄링이 공짜로 딸려 옵니다. Host Config 60개 메서드를 구현하는 비용으로 React 생태계 전체를 얻는 거래입니다.

```javascript
// 가장 단순한 커스텀 렌더러의 핵심 구조
import Reconciler from 'react-reconciler';

const HostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,

  createInstance(type, props) {
    // DOM 대신 자신의 플랫폼 객체 생성
    return { type, props, children: [] };
  },
  appendChild(parent, child) {
    parent.children.push(child);
  },
  commitUpdate(instance, updatePayload, type, oldProps, newProps) {
    instance.props = newProps;
  },
  // ... 나머지 필수 메서드들
};

const MyRenderer = Reconciler(HostConfig);
```

이 코드에서 핵심은 `createInstance`의 반환값이 아무 JavaScript 객체여도 된다는 점입니다. DOM 노드일 필요가 전혀 없습니다. Reconciler는 이 객체를 Fiber의 `stateNode`에 저장하고, 이후 `commitUpdate` 등을 호출할 때 첫 번째 인자로 다시 건네줄 뿐입니다.

## 설계 원칙의 정수

Host Configuration 아키텍처를 전체적으로 바라보면 몇 가지 일관된 설계 원칙이 보입니다.

**완전한 분리**: Reconciler는 추상 인터페이스만 알고, 구체적인 플랫폼 API는 전혀 모릅니다. 이 경계가 React가 단순한 웹 프레임워크를 넘어 범용 UI 런타임이 될 수 있었던 근거입니다.

**2-Phase 설계**: 변화를 계산하는 단계(Render Phase)와 적용하는 단계(Commit Phase)를 분리했습니다. 계산은 중단했다가 재개할 수 있고, 적용은 동기적으로 완료됩니다. 이 분리가 Concurrent Mode의 인터럽트 가능한 렌더링을 가능하게 합니다.

**성능을 위한 인프라**: 플랫 배열 `updatePayload`, 랜덤 키 기반 양방향 연결, 빌드 타임 fork — 모두 런타임 성능을 위한 선택입니다. 더 우아한 추상화 대신 JavaScript 엔진이 최적화하기 좋은 형태를 선택했습니다.

**세심한 엣지 케이스 처리**: `<script>` 태그 생성 방식, `<select>`의 속성 순서, Mobile Safari 클릭 버블링 버그, `display: none !important` — 수년간의 운영 경험에서 쌓인 브라우저 호환성 노하우가 코드 곳곳에 숨어 있습니다.

Host Configuration을 이해하고 나면 "React가 DOM을 어떻게 조작하는가"라는 질문에서 "React가 *왜* 이렇게 설계되었는가"로 질문이 바뀝니다. 그리고 그 답은 단순히 기술적 선택의 집합이 아니라, "한 번 배우면 어디서든 쓴다"는 약속을 지키기 위한 일관된 철학의 표현입니다. React가 DOM을 모르면서 DOM을 그리는 것은 의도된 무지입니다. 그 무지가 자유를 만들었습니다.

---

> **다음 편 예고**: React 18의 이벤트 시스템 — Host Config의 `__reactProps$`에서 시작되는 Synthetic Event의 여정. 클릭 이벤트 하나가 document에서 컴포넌트 핸들러까지 도달하는 전체 경로를 추적합니다.