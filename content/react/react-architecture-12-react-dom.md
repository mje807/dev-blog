# React 아키텍처 심층 분석 (12/14): React DOM 렌더러 — 브라우저와 Fiber를 잇는 최종 다리

> **React 아키텍처 심층 분석** 시리즈의 열두 번째 글이다. 앞선 편들에서 Fiber 트리, 스케줄러, Reconciler, Commit Phase를 추적했다면, 이번 편에서는 그 모든 추상화가 **실제 브라우저 DOM과 만나는 접점** — `react-dom` 패키지를 완전히 해부한다. 이벤트 위임 시스템이 단 하나의 리스너로 모든 이벤트를 처리하는 방법, 합성 이벤트가 네이티브 이벤트를 감싸는 메커니즘, DOM 속성 diff 알고리즘, 그리고 제어 컴포넌트의 내부 동작까지 — `react-dom.development.js` 29,923줄의 실제 코드를 라인 단위로 추적한다.

> **분석 대상**: `react-dom@18.3.1` — `react-dom.development.js` (29,923 lines)

---

## 목차

1. [react-dom 패키지 진입점 구조](#1-react-dom-패키지-진입점-구조)
2. [DOM 노드와 Fiber의 양방향 링크](#2-dom-노드와-fiber의-양방향-링크)
3. [이벤트 위임 시스템 — listenToAllSupportedEvents](#3-이벤트-위임-시스템--listentoallsupportedevents)
4. [이벤트 우선순위와 리스너 래퍼](#4-이벤트-우선순위와-리스너-래퍼)
5. [이벤트 디스패치 파이프라인](#5-이벤트-디스패치-파이프라인)
6. [합성 이벤트 — createSyntheticEvent](#6-합성-이벤트--createsyntheticEvent)
7. [이벤트 리스너 수집 — Fiber 트리 순회](#7-이벤트-리스너-수집--fiber-트리-순회)
8. [DOM 속성 관리 — diffProperties](#8-dom-속성-관리--diffproperties)
9. [스타일 처리 — setValueForStyles와 단위 없는 속성](#9-스타일-처리--setvalueforstyles와-단위-없는-속성)
10. [속성 설정 — setValueForProperty](#10-속성-설정--setvalueforproperty)
11. [DOM 요소 생성과 초기화](#11-dom-요소-생성과-초기화)
12. [폼 요소 — 제어 컴포넌트의 내부](#12-폼-요소--제어-컴포넌트의-내부)
13. [Host Config — Reconciler와의 계약](#13-host-config--reconciler와의-계약)
14. [전체 아키텍처 종합](#14-전체-아키텍처-종합)

---

## 1. react-dom 패키지 진입점 구조

### 1.1 파일 구성

`react-dom@18.3.1`의 디렉토리 구조를 보면, 여러 진입점이 존재한다:

```
react-dom/
├── index.js              ← 메인 진입점 (legacy render, hydrate)
├── client.js             ← createRoot, hydrateRoot (React 18+)
├── server.js             ← SSR 진입점 (Node.js)
├── server.browser.js     ← SSR 진입점 (브라우저 환경)
├── server.node.js        ← SSR 진입점 (Node.js 전용)
├── profiling.js          ← 프로파일링 빌드
├── test-utils.js         ← 테스트 유틸리티
├── cjs/                  ← CommonJS 빌드
│   ├── react-dom.development.js         (29,923줄)
│   ├── react-dom.production.min.js
│   ├── react-dom-server.browser.development.js
│   └── ...
└── umd/                  ← UMD 빌드
```

### 1.2 exports 구조

React 18에서 `createRoot`를 `react-dom/client`에서 import하도록 한 이유가 소스에 명확히 드러난다:

```javascript
// L29848 — createRoot$1 (react-dom에서 직접 import 시)
function createRoot$1(container, options) {
  {
    if (!Internals.usingClientEntryPoint && !false) {
      error('You are importing createRoot from "react-dom" which is not supported. ' +
            'You should instead import it from "react-dom/client".');
    }
  }
  return createRoot(container, options);
}

// L29903 — 최종 exports
exports.createRoot = createRoot$1;
exports.hydrateRoot = hydrateRoot$1;
exports.createPortal = createPortal$1;
exports.findDOMNode = findDOMNode;
exports.flushSync = flushSync$1;
exports.render = render;               // legacy
exports.hydrate = hydrate;             // legacy
exports.unmountComponentAtNode = unmountComponentAtNode; // legacy
exports.unstable_batchedUpdates = batchedUpdates$1;
```

`client.js`가 `Internals.usingClientEntryPoint = true`를 먼저 설정한 후 `createRoot`를 호출하므로, `react-dom/client`에서 import하면 경고가 뜨지 않는다. 이 패턴은 점진적 마이그레이션을 위한 의도적 설계다.

### 1.3 createRoot의 핵심 — 이벤트 시스템 초기화

```javascript
// L29382 — createRoot 본체
function createRoot(container, options) {
  // ...옵션 파싱...

  var root = createContainer(
    container,
    ConcurrentRoot,   // ← React 18 Concurrent Mode
    null,
    isStrictMode,
    concurrentUpdatesByDefaultOverride,
    identifierPrefix,
    onRecoverableError
  );

  markContainerAsRoot(root.current, container);  // DOM → Fiber 연결

  var rootContainerElement = container.nodeType === COMMENT_NODE
    ? container.parentNode
    : container;

  listenToAllSupportedEvents(rootContainerElement);  // ★ 이벤트 위임 등록

  return new ReactDOMRoot(root);
}
```

`createRoot`가 호출되는 순간 두 가지 핵심 작업이 일어난다:
1. `markContainerAsRoot` — 컨테이너 DOM 노드에 `__reactContainer$` 프로퍼티로 FiberRoot 연결
2. `listenToAllSupportedEvents` — 루트 컨테이너에 모든 네이티브 이벤트 리스너 등록

---

## 2. DOM 노드와 Fiber의 양방향 링크

React DOM의 핵심 메커니즘 중 하나는 DOM 노드와 Fiber 노드 사이의 양방향 참조다. 이 연결이 없으면 네이티브 이벤트에서 React 컴포넌트를 찾을 수 없다.

### 2.1 숨겨진 프로퍼티 키

```javascript
// L11480
var randomKey = Math.random().toString(36).slice(2);
var internalInstanceKey   = '__reactFiber$' + randomKey;
var internalPropsKey      = '__reactProps$' + randomKey;
var internalContainerInstanceKey = '__reactContainer$' + randomKey;
var internalEventHandlersKey    = '__reactEvents$' + randomKey;
var internalEventHandlerListenersKey = '__reactListeners$' + randomKey;
var internalEventHandlesSetKey  = '__reactHandles$' + randomKey;
```

`randomKey`를 매번 생성하는 이유: 같은 페이지에서 여러 React 인스턴스가 동작할 때 프로퍼티가 충돌하지 않도록 하기 위해서다. `Math.random().toString(36).slice(2)`는 `"k7f3x2m"`과 같은 짧은 랜덤 문자열을 생성한다.

```
DOM 노드와 Fiber의 양방향 연결:

┌──────────────────┐         ┌──────────────────┐
│   Fiber Node     │         │    DOM Node      │
│                  │         │                  │
│  stateNode ──────┼────────>│  <div>           │
│                  │         │                  │
│                  │<────────┼── __reactFiber$   │
│                  │         │   __reactProps$   │
│                  │         │   __reactEvents$  │
└──────────────────┘         └──────────────────┘

Fiber → DOM:  fiber.stateNode = domElement
DOM → Fiber:  domElement[__reactFiber$xxx] = fiber
DOM → Props:  domElement[__reactProps$xxx] = props
```

### 2.2 Fiber에서 DOM으로 — precacheFiberNode

```javascript
// L11498
function precacheFiberNode(hostInst, node) {
  node[internalInstanceKey] = hostInst;
}
```

`createInstance` (L10924)에서 DOM 요소를 생성할 때 즉시 호출된다:

```javascript
function createInstance(type, props, rootContainerInstance, hostContext, internalInstanceHandle) {
  var domElement = createElement(type, props, rootContainerInstance, parentNamespace);
  precacheFiberNode(internalInstanceHandle, domElement);  // DOM → Fiber 연결
  updateFiberProps(domElement, props);                     // DOM → Props 연결
  return domElement;
}
```

### 2.3 DOM에서 Fiber로 — getClosestInstanceFromNode

이벤트 디스패치의 첫 번째 단계. 클릭이 발생한 DOM 노드에서 가장 가까운 React Fiber를 찾는다.

```javascript
// L11515
function getClosestInstanceFromNode(targetNode) {
  var targetInst = targetNode[internalInstanceKey];

  if (targetInst) {
    return targetInst;  // 직접 연결된 Fiber가 있으면 바로 반환
  }

  // React가 관리하지 않는 DOM 노드일 수 있다 → 부모를 탐색
  var parentNode = targetNode.parentNode;

  while (parentNode) {
    targetInst = parentNode[internalContainerInstanceKey]
              || parentNode[internalInstanceKey];

    if (targetInst) {
      // Suspense 하이드레이션 경계 확인
      var alternate = targetInst.alternate;
      if (targetInst.child !== null || (alternate !== null && alternate.child !== null)) {
        var suspenseInstance = getParentSuspenseInstance(targetNode);
        while (suspenseInstance !== null) {
          var targetSuspenseInst = suspenseInstance[internalInstanceKey];
          if (targetSuspenseInst) {
            return targetSuspenseInst;
          }
          suspenseInstance = getParentSuspenseInstance(suspenseInstance);
        }
      }
      return targetInst;
    }

    targetNode = parentNode;
    parentNode = targetNode.parentNode;
  }

  return null;
}
```

이 함수가 복잡한 이유: SSR 하이드레이션 중에는 아직 Fiber가 연결되지 않은 DOM 노드가 있을 수 있고, Suspense 경계를 고려해야 하기 때문이다.

### 2.4 Props 저장과 조회

```javascript
// L11627
function getFiberCurrentPropsFromNode(node) {
  return node[internalPropsKey] || null;
}

// L11630
function updateFiberProps(node, props) {
  node[internalPropsKey] = props;
}
```

이벤트 핸들러가 DOM 노드의 어트리뷰트가 아닌 `__reactProps$`에 저장되는 이유가 바로 여기 있다. `getListener` (L4032)가 이 props에서 `onClick`, `onChange` 같은 핸들러를 꺼내 쓴다:

```javascript
// L4032
function getListener(inst, registrationName) {
  var stateNode = inst.stateNode;
  if (stateNode === null) return null;

  var props = getFiberCurrentPropsFromNode(stateNode);  // __reactProps$에서 조회
  if (props === null) return null;

  var listener = props[registrationName];  // props.onClick 등
  // ...
  return listener;
}
```

### 2.5 정리 — detachDeletedInstance

컴포넌트가 언마운트될 때 양방향 참조를 모두 해제한다:

```javascript
// L11488
function detachDeletedInstance(node) {
  delete node[internalInstanceKey];
  delete node[internalPropsKey];
  delete node[internalEventHandlersKey];
  delete node[internalEventHandlerListenersKey];
  delete node[internalEventHandlesSetKey];
}
```

메모리 누수를 방지하기 위한 필수 작업이다. DOM 노드가 제거되더라도 `__reactFiber$` 참조가 남아 있으면 Fiber 트리 전체가 GC되지 않는다.

---

## 3. 이벤트 위임 시스템 — listenToAllSupportedEvents

React의 이벤트 시스템은 개별 DOM 요소가 아닌 **루트 컨테이너에서 모든 이벤트를 위임** 처리한다. 이 설계의 핵심이 `listenToAllSupportedEvents`다.

### 3.1 이벤트 등록 기초

모든 것은 `allNativeEvents`라는 전역 Set에서 시작한다:

```javascript
// L157
var allNativeEvents = new Set();
```

이 Set은 React가 지원하는 모든 네이티브 이벤트 이름을 담고 있다. `registerSimpleEvent`를 통해 채워진다:

```javascript
// L8820 — simpleEventPluginEvents 배열
var simpleEventPluginEvents = [
  'abort', 'auxClick', 'cancel', 'canPlay', 'canPlayThrough',
  'click', 'close', 'contextMenu', 'copy', 'cut', 'drag', 'dragEnd',
  'dragEnter', 'dragExit', 'dragLeave', 'dragOver', 'dragStart', 'drop',
  'durationChange', 'emptied', 'encrypted', 'ended', 'error',
  'gotPointerCapture', 'input', 'invalid', 'keyDown', 'keyPress', 'keyUp',
  'load', 'loadedData', 'loadedMetadata', 'loadStart', 'lostPointerCapture',
  'mouseDown', 'mouseMove', 'mouseOut', 'mouseOver', 'mouseUp', 'paste',
  'pause', 'play', 'playing', 'pointerCancel', 'pointerDown', 'pointerMove',
  'pointerOut', 'pointerOver', 'pointerUp', 'progress', 'rateChange',
  'reset', 'resize', 'seeked', 'seeking', 'stalled', 'submit', 'suspend',
  'timeUpdate', 'touchCancel', 'touchEnd', 'touchStart', 'volumeChange',
  'scroll', 'toggle', 'touchMove', 'waiting', 'wheel'
];

function registerSimpleEvent(domEventName, reactName) {
  topLevelEventsToReactNames.set(domEventName, reactName);
  registerTwoPhaseEvent(reactName, [domEventName]);  // capture + bubble 모두 등록
}

// L173
function registerTwoPhaseEvent(registrationName, dependencies) {
  registerDirectEvent(registrationName, dependencies);
  registerDirectEvent(registrationName + 'Capture', dependencies);
}

// L177
function registerDirectEvent(registrationName, dependencies) {
  registrationNameDependencies[registrationName] = dependencies;
  for (var i = 0; i < dependencies.length; i++) {
    allNativeEvents.add(dependencies[i]);  // ← 네이티브 이벤트 이름을 Set에 추가
  }
}
```

### 3.2 listenToAllSupportedEvents — 루트에 모든 리스너 등록

```javascript
// L9132
function listenToAllSupportedEvents(rootContainerElement) {
  if (!rootContainerElement[listeningMarker]) {
    rootContainerElement[listeningMarker] = true;  // 중복 등록 방지

    allNativeEvents.forEach(function (domEventName) {
      if (domEventName !== 'selectionchange') {
        if (!nonDelegatedEvents.has(domEventName)) {
          listenToNativeEvent(domEventName, false, rootContainerElement); // bubble
        }
        listenToNativeEvent(domEventName, true, rootContainerElement);   // capture
      }
    });

    // selectionchange는 document에서만 발생
    var ownerDocument = rootContainerElement.nodeType === DOCUMENT_NODE
      ? rootContainerElement
      : rootContainerElement.ownerDocument;

    if (ownerDocument !== null) {
      if (!ownerDocument[listeningMarker]) {
        ownerDocument[listeningMarker] = true;
        listenToNativeEvent('selectionchange', false, ownerDocument);
      }
    }
  }
}
```

핵심 포인트:
- `allNativeEvents`의 모든 이벤트에 대해 **capture + bubble** 두 번 등록
- `nonDelegatedEvents`에 속하는 이벤트는 bubble 등록을 건너뜀
- `selectionchange`는 특별히 document에 등록

### 3.3 위임되지 않는 이벤트들

```javascript
// L9043
var nonDelegatedEvents = new Set([
  'cancel', 'close', 'invalid', 'load', 'scroll', 'toggle'
].concat(mediaEventTypes));

var mediaEventTypes = [
  'abort', 'canplay', 'canplaythrough', 'durationchange', 'emptied',
  'encrypted', 'ended', 'error', 'loadeddata', 'loadedmetadata',
  'loadstart', 'pause', 'play', 'playing', 'progress', 'ratechange',
  'resize', 'seeked', 'seeking', 'stalled', 'suspend', 'timeupdate',
  'volumechange', 'waiting'
];
```

이 이벤트들은 DOM에서 일관되게 bubble하지 않기 때문에, `setInitialProperties`에서 **개별 DOM 요소에 직접** 등록된다:

```javascript
// L9826 — setInitialProperties 내부
case 'video':
case 'audio':
  for (var i = 0; i < mediaEventTypes.length; i++) {
    listenToNonDelegatedEvent(mediaEventTypes[i], domElement);
  }
  break;

case 'img':
case 'image':
case 'link':
  listenToNonDelegatedEvent('error', domElement);
  listenToNonDelegatedEvent('load', domElement);
  break;
```

### 3.4 전체 이벤트 위임 아키텍처

```
 React 이벤트 위임 아키텍처:

                    Root Container (#root)
                    ┌─────────────────────────┐
                    │ addEventListener('click',│
                    │   dispatchDiscreteEvent, │
                    │   false)                 │  ← bubble phase
                    │                          │
                    │ addEventListener('click',│
                    │   dispatchDiscreteEvent, │
                    │   true)                  │  ← capture phase
                    │                          │
                    │ addEventListener('scroll'│
                    │   dispatchEvent, true)   │  ← capture only (non-delegated)
                    │                          │
                    │ ... (모든 이벤트 타입)    │
                    └─────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
    ┌──────────┐       ┌──────────┐       ┌──────────┐
    │  <div>   │       │  <form>  │       │  <video> │
    │          │       │          │       │          │
    │ (onClick │       │(onSubmit │       │ ★ 개별   │
    │  in      │       │ in       │       │ 리스너   │
    │ __react  │       │ __react  │       │ (play,   │
    │  Props$) │       │  Props$) │       │  pause)  │
    └──────────┘       └──────────┘       └──────────┘
```

기존(React 16 이전)에는 `document`에 이벤트를 위임했지만, React 17부터 **루트 컨테이너**에 위임한다. 이렇게 바뀐 이유:
1. 한 페이지에 여러 React 루트가 공존할 수 있다
2. React 외부의 이벤트 시스템과 충돌을 줄인다
3. `stopPropagation`이 예상대로 동작한다

---

## 4. 이벤트 우선순위와 리스너 래퍼

### 4.1 이벤트 우선순위 정의

React 18의 이벤트 시스템은 각 이벤트에 Lane 기반 우선순위를 부여한다:

```javascript
// L5963
var DiscreteEventPriority   = SyncLane;              // 1
var ContinuousEventPriority = InputContinuousLane;    // 4
var DefaultEventPriority    = DefaultLane;            // 16
var IdleEventPriority       = IdleLane;               // 536870912
```

### 4.2 getEventPriority — 이벤트별 우선순위 매핑

```javascript
// L6569
function getEventPriority(domEventName) {
  switch (domEventName) {
    // ══════════════════════════════════════════════════
    // DiscreteEventPriority — 즉시 반응해야 하는 이벤트
    // ══════════════════════════════════════════════════
    case 'click':
    case 'keydown':
    case 'keyup':
    case 'mousedown':
    case 'mouseup':
    case 'input':
    case 'change':
    case 'focus':
    case 'blur':
    case 'submit':
    case 'reset':
    case 'touchstart':
    case 'touchend':
    case 'pointerdown':
    case 'pointerup':
    // ... 약 40개 이상의 이벤트
      return DiscreteEventPriority;

    // ══════════════════════════════════════════════════
    // ContinuousEventPriority — 연속 발생 이벤트
    // ══════════════════════════════════════════════════
    case 'drag':
    case 'dragover':
    case 'mousemove':
    case 'mouseout':
    case 'mouseover':
    case 'pointermove':
    case 'scroll':
    case 'touchmove':
    case 'wheel':
    case 'mouseenter':
    case 'mouseleave':
    case 'pointerenter':
    case 'pointerleave':
      return ContinuousEventPriority;

    // ══════════════════════════════════════════════════
    // DefaultEventPriority — 나머지 모든 이벤트
    // ══════════════════════════════════════════════════
    case 'message':
      // Scheduler의 현재 우선순위에 따라 동적으로 결정
      var schedulerPriority = getCurrentPriorityLevel();
      switch (schedulerPriority) {
        case ImmediatePriority: return DiscreteEventPriority;
        case UserBlockingPriority: return ContinuousEventPriority;
        default: return DefaultEventPriority;
      }

    default:
      return DefaultEventPriority;
  }
}
```

이 우선순위 분류의 실질적 의미:

```
이벤트 우선순위와 배칭 동작:

DiscreteEventPriority (SyncLane = 1)
├── click, keydown, input, change...
├── → 동기적 업데이트 트리거
└── → 다른 작업을 인터럽트 가능

ContinuousEventPriority (InputContinuousLane = 4)
├── mousemove, scroll, drag...
├── → 프레임 단위 배칭
└── → Discrete보다 낮은 우선순위

DefaultEventPriority (DefaultLane = 16)
├── message, 기타 이벤트
├── → 일반적인 배칭
└── → startTransition 내부와 동일 수준
```

### 4.3 createEventListenerWrapperWithPriority — 우선순위별 래퍼

각 이벤트 타입에 맞는 디스패치 함수를 선택하는 팩토리다:

```javascript
// L6402
function createEventListenerWrapperWithPriority(targetContainer, domEventName, eventSystemFlags) {
  var eventPriority = getEventPriority(domEventName);
  var listenerWrapper;

  switch (eventPriority) {
    case DiscreteEventPriority:
      listenerWrapper = dispatchDiscreteEvent;
      break;
    case ContinuousEventPriority:
      listenerWrapper = dispatchContinuousEvent;
      break;
    case DefaultEventPriority:
    default:
      listenerWrapper = dispatchEvent;
      break;
  }

  return listenerWrapper.bind(null, domEventName, eventSystemFlags, targetContainer);
}
```

`bind`로 `domEventName`, `eventSystemFlags`, `targetContainer`를 클로저에 고정하고, 나중에 브라우저가 네이티브 이벤트와 함께 호출한다.

### 4.4 세 가지 디스패치 함수

```javascript
// L6423
function dispatchDiscreteEvent(domEventName, eventSystemFlags, container, nativeEvent) {
  var previousPriority = getCurrentUpdatePriority();
  var prevTransition = ReactCurrentBatchConfig.transition;
  ReactCurrentBatchConfig.transition = null;

  try {
    setCurrentUpdatePriority(DiscreteEventPriority);  // ← SyncLane으로 설정
    dispatchEvent(domEventName, eventSystemFlags, container, nativeEvent);
  } finally {
    setCurrentUpdatePriority(previousPriority);
    ReactCurrentBatchConfig.transition = prevTransition;
  }
}

// L6437
function dispatchContinuousEvent(domEventName, eventSystemFlags, container, nativeEvent) {
  var previousPriority = getCurrentUpdatePriority();
  var prevTransition = ReactCurrentBatchConfig.transition;
  ReactCurrentBatchConfig.transition = null;

  try {
    setCurrentUpdatePriority(ContinuousEventPriority);  // ← InputContinuousLane
    dispatchEvent(domEventName, eventSystemFlags, container, nativeEvent);
  } finally {
    setCurrentUpdatePriority(previousPriority);
    ReactCurrentBatchConfig.transition = prevTransition;
  }
}
```

핵심 패턴: 각 래퍼는 `setCurrentUpdatePriority`로 우선순위를 설정한 뒤 `dispatchEvent`를 호출한다. 이 우선순위는 이벤트 핸들러 내부에서 `setState`가 호출될 때 해당 업데이트의 Lane을 결정하는 데 사용된다. `transition = null`로 설정하는 것은, 이벤트 핸들러 내에서 `startTransition` 없이 호출된 `setState`가 transition으로 취급되지 않도록 하기 위함이다.

---

## 5. 이벤트 디스패치 파이프라인

### 5.1 전체 파이프라인 개요

```
네이티브 이벤트 디스패치 파이프라인:

브라우저 click 발생
      │
      ▼
[1] dispatchDiscreteEvent()          ← 우선순위 설정
      │
      ▼
[2] dispatchEvent()                  ← 이벤트 가능 여부 확인
      │
      ▼
[3] findInstanceBlockingEvent()      ← 하이드레이션 블로킹 체크
      │  ├── getEventTarget(nativeEvent)
      │  └── getClosestInstanceFromNode(target)
      │
      ▼
[4] dispatchEventForPluginEventSystem()  ← 플러그인으로 위임
      │  └── Portal/Root 경계 추적
      │
      ▼
[5] batchedUpdates()                 ← 배치 컨텍스트 진입
      │
      ▼
[6] dispatchEventsForPlugins()       ← 이벤트 추출 + 디스패치
      │  ├── extractEvents$5()       ← 5개 플러그인에서 이벤트 추출
      │  │    ├── extractEvents$4()  ← SimpleEventPlugin
      │  │    ├── extractEvents$2()  ← ChangeEventPlugin
      │  │    ├── extractEvents$1()  ← BeforeInputEventPlugin
      │  │    ├── extractEvents$3()  ← SelectEventPlugin
      │  │    └── extractEvents()    ← EnterLeaveEventPlugin
      │  │
      │  └── processDispatchQueue()  ← 리스너 실행
      │       ├── capture: 역순 실행
      │       └── bubble: 정순 실행
      ▼
이벤트 핸들러 실행 완료
```

### 5.2 dispatchEvent — 진입점

```javascript
// L6451
function dispatchEvent(domEventName, eventSystemFlags, targetContainer, nativeEvent) {
  if (!_enabled) {
    return;  // Commit Phase 중에는 이벤트 처리 비활성화
  }

  dispatchEventWithEnableCapturePhaseSelectiveHydrationWithoutDiscreteEventReplay(
    domEventName, eventSystemFlags, targetContainer, nativeEvent
  );
}
```

`_enabled` 플래그는 `prepareForCommit` (L10910)에서 `false`로 설정되고 `resetAfterCommit` (L10918)에서 복원된다. Commit Phase 동안에는 DOM을 수정하고 있으므로 이벤트 처리를 차단한다.

### 5.3 findInstanceBlockingEvent — 하이드레이션과의 교차

```javascript
// L6540 — findInstanceBlockingEvent
function findInstanceBlockingEvent(domEventName, eventSystemFlags, targetContainer, nativeEvent) {
  return_targetInst = null;
  var nativeEventTarget = getEventTarget(nativeEvent);
  var targetInst = getClosestInstanceFromNode(nativeEventTarget);

  if (targetInst !== null) {
    var nearestMounted = getNearestMountedFiber(targetInst);

    if (nearestMounted === null) {
      targetInst = null;  // 이미 언마운트된 트리
    } else {
      var tag = nearestMounted.tag;

      if (tag === SuspenseComponent) {
        var instance = getSuspenseInstanceFromFiber(nearestMounted);
        if (instance !== null) {
          return instance;  // 아직 하이드레이션 안 됨 → 이벤트 큐잉
        }
      }
    }
  }

  return_targetInst = targetInst;
  return null;  // 블로킹 없음
}
```

`return_targetInst`라는 전역 변수가 사용되는 이유: JavaScript의 단일 스레드 특성을 활용한 성능 최적화로, 객체 할당 없이 두 값(블로킹 여부 + 타겟 인스턴스)을 반환한다.

### 5.4 dispatchEventForPluginEventSystem — Portal 경계 처리

```javascript
// L9200
function dispatchEventForPluginEventSystem(domEventName, eventSystemFlags,
                                           nativeEvent, targetInst, targetContainer) {
  var ancestorInst = targetInst;

  if (targetInst !== null) {
    var node = targetInst;

    // Portal 경계를 넘는 이벤트 버블링 처리
    mainLoop: while (true) {
      if (node === null) return;
      var nodeTag = node.tag;

      if (nodeTag === HostRoot || nodeTag === HostPortal) {
        var container = node.stateNode.containerInfo;

        if (isMatchingRootContainer(container, targetContainerNode)) {
          break;  // 현재 루트의 이벤트 → 정상 처리
        }

        if (nodeTag === HostPortal) {
          // Portal의 이벤트가 다른 루트로 전파되는 것을 방지
          var grandNode = node.return;
          while (grandNode !== null) {
            var grandTag = grandNode.tag;
            if (grandTag === HostRoot || grandTag === HostPortal) {
              var grandContainer = grandNode.stateNode.containerInfo;
              if (isMatchingRootContainer(grandContainer, targetContainerNode)) {
                return;  // 다른 루트의 이벤트 → 무시
              }
            }
            grandNode = grandNode.return;
          }
        }
        // ...
      }
      node = node.return;
    }
  }

  batchedUpdates(function () {
    return dispatchEventsForPlugins(domEventName, eventSystemFlags, nativeEvent, ancestorInst);
  });
}
```

### 5.5 dispatchEventsForPlugins와 processDispatchQueue

```javascript
// L9096
function dispatchEventsForPlugins(domEventName, eventSystemFlags,
                                  nativeEvent, targetInst, targetContainer) {
  var nativeEventTarget = getEventTarget(nativeEvent);
  var dispatchQueue = [];

  // 모든 플러그인에서 이벤트 추출
  extractEvents$5(dispatchQueue, domEventName, targetInst,
                  nativeEvent, nativeEventTarget, eventSystemFlags);

  // 수집된 이벤트를 순서대로 실행
  processDispatchQueue(dispatchQueue, eventSystemFlags);
}
```

`dispatchQueue`는 `{ event, listeners }` 쌍의 배열이다. 한 번의 네이티브 이벤트에서 여러 React 이벤트가 발생할 수 있다 (예: `keydown` → `onChange` + `onKeyDown`).

```javascript
// L9069
function processDispatchQueue(dispatchQueue, eventSystemFlags) {
  var inCapturePhase = (eventSystemFlags & IS_CAPTURE_PHASE) !== 0;

  for (var i = 0; i < dispatchQueue.length; i++) {
    var _dispatchQueue$i = dispatchQueue[i],
        event = _dispatchQueue$i.event,
        listeners = _dispatchQueue$i.listeners;
    processDispatchQueueItemsInOrder(event, listeners, inCapturePhase);
  }

  rethrowCaughtError();  // 이벤트 핸들러의 에러를 다시 throw
}

// L9049
function processDispatchQueueItemsInOrder(event, dispatchListeners, inCapturePhase) {
  var previousInstance;

  if (inCapturePhase) {
    // Capture: 루트에서 타겟 방향 (배열 역순)
    for (var i = dispatchListeners.length - 1; i >= 0; i--) {
      var _ref = dispatchListeners[i];
      if (_ref.instance !== previousInstance && event.isPropagationStopped()) {
        return;
      }
      executeDispatch(event, _ref.listener, _ref.currentTarget);
      previousInstance = _ref.instance;
    }
  } else {
    // Bubble: 타겟에서 루트 방향 (배열 정순)
    for (var _i = 0; _i < dispatchListeners.length; _i++) {
      var _ref2 = dispatchListeners[_i];
      if (_ref2.instance !== previousInstance && event.isPropagationStopped()) {
        return;
      }
      executeDispatch(event, _ref2.listener, _ref2.currentTarget);
      previousInstance = _ref2.instance;
    }
  }
}
```

`stopPropagation()`이 호출되면 `isPropagationStopped()`가 `true`를 반환하고, 다음 리스너부터는 실행되지 않는다. 이것은 React의 **가상 버블링** — 실제 DOM 전파가 아니라 Fiber 트리를 따라 리스너를 수집한 배열의 순회를 중단하는 것이다.

---

## 6. 합성 이벤트 — createSyntheticEvent

### 6.1 팩토리 패턴

```javascript
// L6820
function createSyntheticEvent(Interface) {
  function SyntheticBaseEvent(reactName, reactEventType, targetInst,
                              nativeEvent, nativeEventTarget) {
    this._reactName = reactName;          // 'onClick'
    this._targetInst = targetInst;        // Fiber 노드
    this.type = reactEventType;           // 'click'
    this.nativeEvent = nativeEvent;       // 원본 브라우저 이벤트
    this.target = nativeEventTarget;      // event.target
    this.currentTarget = null;            // 실행 중인 리스너의 DOM 노드

    // Interface에 정의된 속성 복사
    for (var _propName in Interface) {
      if (!Interface.hasOwnProperty(_propName)) continue;
      var normalize = Interface[_propName];

      if (normalize) {
        this[_propName] = normalize(nativeEvent);  // 정규화 함수 적용
      } else {
        this[_propName] = nativeEvent[_propName];  // 직접 복사
      }
    }

    // defaultPrevented 정규화
    var defaultPrevented = nativeEvent.defaultPrevented != null
      ? nativeEvent.defaultPrevented
      : nativeEvent.returnValue === false;

    this.isDefaultPrevented = defaultPrevented
      ? functionThatReturnsTrue
      : functionThatReturnsFalse;

    this.isPropagationStopped = functionThatReturnsFalse;
    return this;
  }

  assign(SyntheticBaseEvent.prototype, {
    preventDefault: function () {
      this.defaultPrevented = true;
      var event = this.nativeEvent;
      if (event.preventDefault) {
        event.preventDefault();
      } else if (typeof event.returnValue !== 'unknown') {
        event.returnValue = false;   // IE 호환
      }
      this.isDefaultPrevented = functionThatReturnsTrue;
    },

    stopPropagation: function () {
      var event = this.nativeEvent;
      if (event.stopPropagation) {
        event.stopPropagation();
      } else if (typeof event.cancelBubble !== 'unknown') {
        event.cancelBubble = true;   // IE 호환
      }
      this.isPropagationStopped = functionThatReturnsTrue;
    },

    persist: function () {
      // React 17+에서는 풀링을 사용하지 않으므로 no-op
    },

    isPersistent: functionThatReturnsTrue
  });

  return SyntheticBaseEvent;
}
```

`createSyntheticEvent`가 **팩토리 함수**인 이유가 코드 상단 주석에 명시되어 있다:

> "This is intentionally a factory so that we have different returned constructors. If we had a single constructor, it would be megamorphic and engines would deopt."

V8 같은 JS 엔진은 특정 생성자로 만든 객체가 항상 같은 shape(hidden class)를 가지면 최적화한다. 단일 생성자로 서로 다른 형태의 객체를 만들면 megamorphic 되어 성능이 떨어진다.

### 6.2 이벤트 타입별 Interface

```javascript
// L6930 — 기본 EventInterface
var EventInterface = {
  eventPhase: 0,
  bubbles: 0,
  cancelable: 0,
  timeStamp: function (event) { return event.timeStamp || Date.now(); },
  defaultPrevented: 0,
  isTrusted: 0
};
var SyntheticEvent = createSyntheticEvent(EventInterface);

// UIEventInterface — view, detail 추가
var UIEventInterface = assign({}, EventInterface, {
  view: 0,
  detail: 0
});
var SyntheticUIEvent = createSyntheticEvent(UIEventInterface);

// MouseEventInterface — 좌표 정보 등 추가
var MouseEventInterface = assign({}, UIEventInterface, {
  screenX: 0, screenY: 0,
  clientX: 0, clientY: 0,
  pageX: 0, pageY: 0,
  ctrlKey: 0, shiftKey: 0, altKey: 0, metaKey: 0,
  button: 0, buttons: 0,
  relatedTarget: function (event) {
    return event.relatedTarget === undefined
      ? event.fromElement === event.srcElement
        ? event.toElement : event.fromElement
      : event.relatedTarget;
  },
  movementX: function (event) { /* polyfill */ },
  movementY: function (event) { /* polyfill */ }
});
var SyntheticMouseEvent = createSyntheticEvent(MouseEventInterface);
```

Interface에서 `0`은 "네이티브 이벤트에서 그대로 복사"를 의미하고, 함수는 "정규화 로직 적용"을 의미한다.

### 6.3 전체 합성 이벤트 계층 구조

```
합성 이벤트 상속 트리:

EventInterface
├── SyntheticEvent                    (L6939)
├── UIEventInterface
│   ├── SyntheticUIEvent              (L6946)
│   ├── MouseEventInterface
│   │   ├── SyntheticMouseEvent       (L7008)
│   │   └── DragEventInterface
│   │       └── SyntheticDragEvent    (L7018)
│   ├── FocusEventInterface
│   │   └── SyntheticFocusEvent       (L7028)
│   ├── KeyboardEventInterface
│   │   └── SyntheticKeyboardEvent    (L7256)
│   ├── PointerEventInterface
│   │   └── SyntheticPointerEvent     (L7275)
│   └── TouchEventInterface
│       └── SyntheticTouchEvent       (L7292)
├── AnimationEventInterface
│   └── SyntheticAnimationEvent       (L7041)
├── ClipboardEventInterface
│   └── SyntheticClipboardEvent       (L7053)
├── CompositionEventInterface
│   └── SyntheticCompositionEvent     (L7063)
├── TransitionEventInterface
│   └── SyntheticTransitionEvent      (L7305)
└── WheelEventInterface
    └── SyntheticWheelEvent           (L7329)
```

### 6.4 extractEvents$4에서 적절한 생성자 선택

```javascript
// L8852
function extractEvents$4(dispatchQueue, domEventName, targetInst,
                         nativeEvent, nativeEventTarget, eventSystemFlags) {
  var reactName = topLevelEventsToReactNames.get(domEventName);
  if (reactName === undefined) return;

  var SyntheticEventCtor = SyntheticEvent;  // 기본값

  switch (domEventName) {
    case 'keydown':
    case 'keyup':
      SyntheticEventCtor = SyntheticKeyboardEvent; break;

    case 'click':
    case 'mousedown':
    case 'mousemove':
    case 'mouseup':
      SyntheticEventCtor = SyntheticMouseEvent; break;

    case 'drag':
    case 'dragend':
    case 'drop':
      SyntheticEventCtor = SyntheticDragEvent; break;

    case 'touchcancel':
    case 'touchend':
    case 'touchmove':
    case 'touchstart':
      SyntheticEventCtor = SyntheticTouchEvent; break;

    case 'scroll':
      SyntheticEventCtor = SyntheticUIEvent; break;

    case 'wheel':
      SyntheticEventCtor = SyntheticWheelEvent; break;

    case 'copy':
    case 'cut':
    case 'paste':
      SyntheticEventCtor = SyntheticClipboardEvent; break;

    case 'pointerdown':
    case 'pointermove':
    case 'pointerup':
      SyntheticEventCtor = SyntheticPointerEvent; break;
    // ...
  }

  var _listeners = accumulateSinglePhaseListeners(
    targetInst, reactName, nativeEvent.type, inCapturePhase, accumulateTargetOnly
  );

  if (_listeners.length > 0) {
    var _event = new SyntheticEventCtor(reactName, reactEventType, null,
                                        nativeEvent, nativeEventTarget);
    dispatchQueue.push({ event: _event, listeners: _listeners });
  }
}
```

---

## 7. 이벤트 리스너 수집 — Fiber 트리 순회

### 7.1 accumulateSinglePhaseListeners

대부분의 이벤트가 이 함수로 리스너를 수집한다. Fiber 트리를 타겟에서 루트까지 순회하면서 각 HostComponent에서 해당 이벤트의 리스너를 찾는다.

```javascript
// L9300
function accumulateSinglePhaseListeners(targetFiber, reactName, nativeEventType,
                                        inCapturePhase, accumulateTargetOnly, nativeEvent) {
  var captureName = reactName !== null ? reactName + 'Capture' : null;
  var reactEventName = inCapturePhase ? captureName : reactName;
  var listeners = [];
  var instance = targetFiber;
  var lastHostComponent = null;

  // 타겟 → 루트 방향 순회
  while (instance !== null) {
    var _instance2 = instance,
        stateNode = _instance2.stateNode,
        tag = _instance2.tag;

    if (tag === HostComponent && stateNode !== null) {
      lastHostComponent = stateNode;

      if (reactEventName !== null) {
        var listener = getListener(instance, reactEventName);

        if (listener != null) {
          listeners.push(
            createDispatchListener(instance, listener, lastHostComponent)
          );
        }
      }
    }

    if (accumulateTargetOnly) {
      break;  // scroll 이벤트 등은 타겟만 수집
    }

    instance = instance.return;  // 부모 Fiber로 이동
  }

  return listeners;
}
```

### 7.2 accumulateTwoPhaseListeners

`ChangeEventPlugin`, `SelectEventPlugin`, `BeforeInputEventPlugin`이 사용한다. bubble phase에서 호출되지만 capture 리스너도 함께 수집해야 하기 때문에 "two phase" 에뮬레이션을 한다.

```javascript
// L9344
function accumulateTwoPhaseListeners(targetFiber, reactName) {
  var captureName = reactName + 'Capture';
  var listeners = [];
  var instance = targetFiber;

  while (instance !== null) {
    var _instance3 = instance,
        stateNode = _instance3.stateNode,
        tag = _instance3.tag;

    if (tag === HostComponent && stateNode !== null) {
      var currentTarget = stateNode;

      // Capture 리스너 → 배열 앞에 삽입 (unshift)
      var captureListener = getListener(instance, captureName);
      if (captureListener != null) {
        listeners.unshift(createDispatchListener(instance, captureListener, currentTarget));
      }

      // Bubble 리스너 → 배열 뒤에 추가 (push)
      var bubbleListener = getListener(instance, reactName);
      if (bubbleListener != null) {
        listeners.push(createDispatchListener(instance, bubbleListener, currentTarget));
      }
    }

    instance = instance.return;
  }

  return listeners;
}
```

결과적으로 `listeners` 배열은 이런 순서가 된다:

```
accumulateTwoPhaseListeners 결과:

listeners 배열 순서:
[0] Root onClickCapture   ← unshift (맨 앞)
[1] Parent onClickCapture ← unshift (0번 뒤에)
[2] Target onClickCapture ← unshift (1번 뒤에)
[3] Target onClick        ← push
[4] Parent onClick        ← push
[5] Root onClick          ← push

정순 실행하면:
  Capture: Root → Parent → Target  (DOM 표준과 동일)
  Bubble:  Target → Parent → Root  (DOM 표준과 동일)
```

### 7.3 getListener의 동작

```javascript
// L4032
function getListener(inst, registrationName) {
  var stateNode = inst.stateNode;
  if (stateNode === null) return null;

  var props = getFiberCurrentPropsFromNode(stateNode);
  // → domElement.__reactProps$xxx를 조회

  if (props === null) return null;

  var listener = props[registrationName];
  // → props.onClick, props.onClickCapture 등

  if (shouldPreventMouseEvent(registrationName, inst.type, props)) {
    return null;
    // disabled된 <button>의 onClick 등은 무시
  }

  if (listener && typeof listener !== 'function') {
    throw new Error('Expected `' + registrationName + '` listener to be a function');
  }

  return listener;
}
```

`shouldPreventMouseEvent`가 `disabled` 요소의 마우스 이벤트를 차단하는 부분은 종종 개발자를 혼란스럽게 한다. `<button disabled onClick={handler}>`에서 `onClick`이 호출되지 않는 이유가 바로 여기에 있다.

---

## 8. DOM 속성 관리 — diffProperties

### 8.1 diffProperties — 변경 사항 계산

Reconciler가 HostComponent를 업데이트할 때, `diffProperties`는 이전 props와 다음 props의 차이를 `updatePayload`라는 평탄한 배열로 계산한다.

```javascript
// L9956
function diffProperties(domElement, tag, lastRawProps, nextRawProps, rootContainerElement) {
  var updatePayload = null;
  var lastProps;
  var nextProps;

  // 폼 요소는 특별한 props 변환이 필요
  switch (tag) {
    case 'input':
      lastProps = getHostProps(domElement, lastRawProps);
      nextProps = getHostProps(domElement, nextRawProps);
      updatePayload = [];   // ← 빈 배열로 초기화 (반드시 커밋 필요)
      break;
    case 'select':
      lastProps = getHostProps$1(domElement, lastRawProps);
      nextProps = getHostProps$1(domElement, nextRawProps);
      updatePayload = [];
      break;
    case 'textarea':
      lastProps = getHostProps$2(domElement, lastRawProps);
      nextProps = getHostProps$2(domElement, nextRawProps);
      updatePayload = [];
      break;
    default:
      lastProps = lastRawProps;
      nextProps = nextRawProps;
      break;
  }

  // === 1단계: 삭제된 속성 처리 ===
  for (propKey in lastProps) {
    if (nextProps.hasOwnProperty(propKey) || !lastProps.hasOwnProperty(propKey)
        || lastProps[propKey] == null) {
      continue;  // 새 props에도 있거나, 이전에도 없었으면 스킵
    }

    if (propKey === STYLE) {
      // 삭제된 스타일 → 빈 문자열로 초기화
      var lastStyle = lastProps[propKey];
      for (styleName in lastStyle) {
        if (lastStyle.hasOwnProperty(styleName)) {
          if (!styleUpdates) styleUpdates = {};
          styleUpdates[styleName] = '';
        }
      }
    } else if (propKey === DANGEROUSLY_SET_INNER_HTML || propKey === CHILDREN) {
      // 특별 처리: 별도 로직
    } else if (registrationNameDependencies.hasOwnProperty(propKey)) {
      // 이벤트 핸들러 변경 → 커밋 필요 (빈 payload)
      if (!updatePayload) updatePayload = [];
    } else {
      // 일반 속성 삭제
      (updatePayload = updatePayload || []).push(propKey, null);
    }
  }

  // === 2단계: 추가/변경된 속성 처리 ===
  for (propKey in nextProps) {
    var nextProp = nextProps[propKey];
    var lastProp = lastProps != null ? lastProps[propKey] : undefined;

    if (!nextProps.hasOwnProperty(propKey) || nextProp === lastProp
        || (nextProp == null && lastProp == null)) {
      continue;
    }

    if (propKey === STYLE) {
      if (lastProp) {
        // 삭제된 스타일 + 변경된 스타일 모두 수집
        for (styleName in lastProp) {
          if (lastProp.hasOwnProperty(styleName)
              && (!nextProp || !nextProp.hasOwnProperty(styleName))) {
            if (!styleUpdates) styleUpdates = {};
            styleUpdates[styleName] = '';   // 삭제
          }
        }
        for (styleName in nextProp) {
          if (nextProp.hasOwnProperty(styleName)
              && lastProp[styleName] !== nextProp[styleName]) {
            if (!styleUpdates) styleUpdates = {};
            styleUpdates[styleName] = nextProp[styleName];  // 변경
          }
        }
      } else {
        styleUpdates = nextProp;  // 이전에 style이 없었으면 전체 적용
      }
    } else if (propKey === DANGEROUSLY_SET_INNER_HTML) {
      var nextHtml = nextProp ? nextProp.__html : undefined;
      var lastHtml = lastProp ? lastProp.__html : undefined;
      if (nextHtml != null && lastHtml !== nextHtml) {
        (updatePayload = updatePayload || []).push(propKey, nextHtml);
      }
    } else if (propKey === CHILDREN) {
      if (typeof nextProp === 'string' || typeof nextProp === 'number') {
        (updatePayload = updatePayload || []).push(propKey, '' + nextProp);
      }
    } else if (registrationNameDependencies.hasOwnProperty(propKey)) {
      // 이벤트 핸들러 변경 → __reactProps$ 업데이트를 위해 커밋 필요
      if (nextProp != null && propKey === 'onScroll') {
        listenToNonDelegatedEvent('scroll', domElement);
      }
      if (!updatePayload && lastProp !== nextProp) {
        updatePayload = [];
      }
    } else {
      (updatePayload = updatePayload || []).push(propKey, nextProp);
    }
  }

  // 스타일 변경이 있으면 마지막에 추가
  if (styleUpdates) {
    (updatePayload = updatePayload || []).push(STYLE, styleUpdates);
  }

  return updatePayload;
  // 형태: ['className', 'new-class', 'style', {color: 'red'}, 'title', null]
  // 또는 null (변경 없음)
}
```

### 8.2 updatePayload의 구조

`updatePayload`는 `[key, value, key, value, ...]` 형태의 평탄한 배열이다:

```
updatePayload 예시:

이전 props: { className: 'old', style: {color: 'red'},  title: 'hello' }
다음 props: { className: 'new', style: {color: 'blue'} }

updatePayload = [
  'title',     null,              // 삭제
  'className', 'new',             // 변경
  'style',     {color: 'blue'}    // 변경
]

인덱스:  0     1     2     3     4     5
         key  value  key  value  key  value
```

이 구조를 사용하는 이유: 객체 할당 비용을 줄이고, `updateDOMProperties`에서 `i += 2`로 빠르게 순회할 수 있다.

### 8.3 updateDOMProperties — 실제 DOM 반영

```javascript
// L9725
function updateDOMProperties(domElement, updatePayload,
                             wasCustomComponentTag, isCustomComponentTag) {
  for (var i = 0; i < updatePayload.length; i += 2) {
    var propKey = updatePayload[i];
    var propValue = updatePayload[i + 1];

    if (propKey === STYLE) {
      setValueForStyles(domElement, propValue);
    } else if (propKey === DANGEROUSLY_SET_INNER_HTML) {
      setInnerHTML(domElement, propValue);
    } else if (propKey === CHILDREN) {
      setTextContent(domElement, propValue);
    } else {
      setValueForProperty(domElement, propKey, propValue, isCustomComponentTag);
    }
  }
}
```

### 8.4 commitUpdate에서의 호출 흐름

```javascript
// L11045
function commitUpdate(domElement, updatePayload, type, oldProps, newProps,
                      internalInstanceHandle) {
  // 1. diff 결과를 DOM에 적용
  updateProperties(domElement, updatePayload, type, oldProps, newProps);

  // 2. __reactProps$ 업데이트 (이벤트 핸들러 참조 갱신)
  updateFiberProps(domElement, newProps);
}

// L10132
function updateProperties(domElement, updatePayload, tag, lastRawProps, nextRawProps) {
  // input의 checked는 name보다 먼저 업데이트해야 한다
  if (tag === 'input' && nextRawProps.type === 'radio' && nextRawProps.name != null) {
    updateChecked(domElement, nextRawProps);
  }

  updateDOMProperties(domElement, updatePayload, wasCustom, isCustom);

  // 폼 요소의 후처리
  switch (tag) {
    case 'input':
      updateWrapper(domElement, nextRawProps);  // value, checked 동기화
      break;
    case 'textarea':
      updateWrapper$1(domElement, nextRawProps);
      break;
    case 'select':
      postUpdateWrapper(domElement, nextRawProps);  // option 선택 상태 동기화
      break;
  }
}
```

```
DOM 속성 업데이트 전체 흐름:

Reconciler                 react-dom
   │                          │
   │ completeWork()           │
   │ ├── diffProperties()  ──>│ updatePayload 계산
   │ │   return [k,v,k,v...]  │
   │ │                        │
   │ └── fiber.updateQueue    │
   │     = updatePayload      │
   │                          │
   │ commitUpdate()           │
   │ ├── updateProperties() ─>│ DOM에 적용
   │ │   ├── updateDOMProperties()
   │ │   │   ├── setValueForStyles()
   │ │   │   ├── setInnerHTML()
   │ │   │   ├── setTextContent()
   │ │   │   └── setValueForProperty()
   │ │   │
   │ │   └── updateWrapper()  │ (input/textarea/select)
   │ │                        │
   │ └── updateFiberProps() ─>│ __reactProps$ 갱신
   │                          │
```

---

## 9. 스타일 처리 — setValueForStyles와 단위 없는 속성

### 9.1 setValueForStyles

```javascript
// L2804
function setValueForStyles(node, styles) {
  var style = node.style;

  for (var styleName in styles) {
    if (!styles.hasOwnProperty(styleName)) continue;

    var isCustomProperty = styleName.indexOf('--') === 0;  // CSS 변수 판별

    var styleValue = dangerousStyleValue(styleName, styles[styleName], isCustomProperty);

    if (styleName === 'float') {
      styleName = 'cssFloat';  // JavaScript에서 'float'은 예약어
    }

    if (isCustomProperty) {
      style.setProperty(styleName, styleValue);  // CSS 변수: setProperty 사용
    } else {
      style[styleName] = styleValue;  // 일반 속성: 직접 할당
    }
  }
}
```

CSS 변수(`--custom-color` 등)는 `style.setProperty`로만 설정할 수 있고, 일반 속성은 `style.backgroundColor = 'red'`처럼 직접 할당한다.

### 9.2 dangerousStyleValue — 단위 자동 추가

```javascript
// L2620
function dangerousStyleValue(name, value, isCustomProperty) {
  var isEmpty = value == null || typeof value === 'boolean' || value === '';

  if (isEmpty) {
    return '';
  }

  // CSS 변수가 아니고, 숫자이고, 0이 아니고, unitless 목록에 없으면 → 'px' 자동 추가
  if (!isCustomProperty && typeof value === 'number' && value !== 0
      && !(isUnitlessNumber.hasOwnProperty(name) && isUnitlessNumber[name])) {
    return value + 'px';
  }

  return ('' + value).trim();
}
```

### 9.3 isUnitlessNumber — 단위가 필요 없는 CSS 속성 목록

```javascript
// L2540
var isUnitlessNumber = {
  animationIterationCount: true,
  aspectRatio: true,
  borderImageOutset: true,
  borderImageSlice: true,
  borderImageWidth: true,
  boxFlex: true,
  boxFlexGroup: true,
  boxOrdinalGroup: true,
  columnCount: true,
  columns: true,
  flex: true,
  flexGrow: true,
  flexPositive: true,
  flexShrink: true,
  flexNegative: true,
  flexOrder: true,
  gridArea: true,
  gridRow: true,
  gridRowEnd: true,
  gridRowSpan: true,
  gridRowStart: true,
  gridColumn: true,
  gridColumnEnd: true,
  gridColumnSpan: true,
  gridColumnStart: true,
  fontWeight: true,
  lineClamp: true,
  lineHeight: true,
  opacity: true,
  order: true,
  orphans: true,
  tabSize: true,
  widows: true,
  zIndex: true,
  zoom: true,
  // SVG
  fillOpacity: true,
  floodOpacity: true,
  stopOpacity: true,
  strokeDasharray: true,
  strokeDashoffset: true,
  strokeMiterlimit: true,
  strokeOpacity: true,
  strokeWidth: true
};

// 벤더 프리픽스 자동 생성
var prefixes = ['Webkit', 'ms', 'Moz', 'O'];
Object.keys(isUnitlessNumber).forEach(function (prop) {
  prefixes.forEach(function (prefix) {
    isUnitlessNumber[prefixKey(prefix, prop)] = isUnitlessNumber[prop];
    // WebkitFontWeight, msFontWeight 등이 자동으로 추가
  });
});
```

이 목록의 실질적 의미:

```javascript
// 개발자가 작성한 코드:
<div style={{ width: 100, opacity: 0.5, zIndex: 10 }} />

// React가 실제로 설정하는 값:
style.width   = '100px';   // ← unitless 목록에 없음 → 'px' 추가
style.opacity = '0.5';     // ← unitless 목록에 있음 → 그대로
style.zIndex  = '10';      // ← unitless 목록에 있음 → 그대로
```

---

## 10. 속성 설정 — setValueForProperty

### 10.1 Property vs Attribute vs Boolean

DOM API에는 속성을 설정하는 두 가지 방법이 있다:
1. **Property** — `node.checked = true` (JavaScript 객체 속성)
2. **Attribute** — `node.setAttribute('checked', '')` (HTML 어트리뷰트)

React는 속성 유형에 따라 적절한 방법을 선택한다:

```javascript
// L775
function setValueForProperty(node, name, value, isCustomComponentTag) {
  var propertyInfo = getPropertyInfo(name);

  if (shouldIgnoreAttribute(name, propertyInfo, isCustomComponentTag)) {
    return;  // key, ref, __self, __source 등 React 전용 속성은 무시
  }

  if (shouldRemoveAttribute(name, value, propertyInfo, isCustomComponentTag)) {
    value = null;  // NaN, 잘못된 타입 등은 제거
  }

  // === 커스텀 컴포넌트 또는 알 수 없는 속성 ===
  if (isCustomComponentTag || propertyInfo === null) {
    if (isAttributeNameSafe(name)) {
      if (value === null) {
        node.removeAttribute(name);
      } else {
        node.setAttribute(name, '' + value);
      }
    }
    return;
  }

  // === mustUseProperty — checked, value, selected 등 ===
  var mustUseProperty = propertyInfo.mustUseProperty;

  if (mustUseProperty) {
    var propertyName = propertyInfo.propertyName;
    if (value === null) {
      var type = propertyInfo.type;
      node[propertyName] = type === BOOLEAN ? false : '';
    } else {
      node[propertyName] = value;  // node.checked = true
    }
    return;
  }

  // === 일반 속성 — setAttribute 사용 ===
  var attributeName = propertyInfo.attributeName;

  if (value === null) {
    node.removeAttribute(attributeName);
  } else {
    var _type = propertyInfo.type;
    var attributeValue;

    if (_type === BOOLEAN || (_type === OVERLOADED_BOOLEAN && value === true)) {
      attributeValue = '';  // <input disabled /> → setAttribute('disabled', '')
    } else {
      attributeValue = '' + value;

      if (propertyInfo.sanitizeURL) {
        sanitizeURL(attributeValue.toString());  // XSS 방지
      }
    }

    node.setAttribute(attributeName, attributeValue);
  }
}
```

속성 타입별 처리 방식:

```
속성 처리 전략:

┌────────────────────┬──────────────────┬───────────────────┐
│ 타입               │ 예시             │ DOM API           │
├────────────────────┼──────────────────┼───────────────────┤
│ mustUseProperty    │ checked, value,  │ node[prop] = val  │
│                    │ selected, muted  │                   │
├────────────────────┼──────────────────┼───────────────────┤
│ BOOLEAN            │ disabled,        │ setAttribute('',  │
│                    │ readOnly         │ '') / remove      │
├────────────────────┼──────────────────┼───────────────────┤
│ OVERLOADED_BOOLEAN │ capture, download│ true → ''         │
│                    │                  │ string → value    │
├────────────────────┼──────────────────┼───────────────────┤
│ 일반 문자열        │ className, id,   │ setAttribute(     │
│                    │ href, src        │   name, value)    │
├────────────────────┼──────────────────┼───────────────────┤
│ 이벤트 핸들러      │ onClick,         │ __reactProps$에   │
│                    │ onChange          │ 저장 (DOM 미반영) │
├────────────────────┼──────────────────┼───────────────────┤
│ 스타일             │ style            │ setValueForStyles │
├────────────────────┼──────────────────┼───────────────────┤
│ 특수               │ dangerously      │ innerHTML         │
│                    │ SetInnerHTML     │                   │
└────────────────────┴──────────────────┴───────────────────┘
```

---

## 11. DOM 요소 생성과 초기화

### 11.1 createElement

```javascript
// L9756
function createElement(type, props, rootContainerElement, parentNamespace) {
  var ownerDocument = getOwnerDocumentFromRootContainer(rootContainerElement);
  var domElement;
  var namespaceURI = parentNamespace;

  if (namespaceURI === HTML_NAMESPACE) {
    namespaceURI = getIntrinsicNamespace(type);
  }

  if (namespaceURI === HTML_NAMESPACE) {
    if (type === 'script') {
      // script 태그는 innerHTML로 생성해야 parser-inserted 플래그가 설정된다
      var div = ownerDocument.createElement('div');
      div.innerHTML = '<script><' + '/script>';
      var firstChild = div.firstChild;
      domElement = div.removeChild(firstChild);
    } else if (typeof props.is === 'string') {
      // Web Components: createElement(type, { is: 'my-component' })
      domElement = ownerDocument.createElement(type, { is: props.is });
    } else {
      domElement = ownerDocument.createElement(type);

      // select의 multiple/size는 option 삽입 전에 설정해야 한다
      if (type === 'select') {
        var node = domElement;
        if (props.multiple) {
          node.multiple = true;
        } else if (props.size) {
          node.size = props.size;
        }
      }
    }
  } else {
    // SVG, MathML 등은 createElementNS 사용
    domElement = ownerDocument.createElementNS(namespaceURI, type);
  }

  return domElement;
}
```

### 11.2 setInitialProperties — 초기 속성 설정

```javascript
// L9826
function setInitialProperties(domElement, tag, rawProps, rootContainerElement) {
  var isCustomComponentTag = isCustomComponent(tag, rawProps);
  var props;

  // 1단계: 태그별 특수 이벤트 등록
  switch (tag) {
    case 'dialog':
      listenToNonDelegatedEvent('cancel', domElement);
      listenToNonDelegatedEvent('close', domElement);
      props = rawProps;
      break;

    case 'iframe':
    case 'object':
    case 'embed':
      listenToNonDelegatedEvent('load', domElement);
      props = rawProps;
      break;

    case 'video':
    case 'audio':
      // 모든 미디어 이벤트를 개별 등록
      for (var i = 0; i < mediaEventTypes.length; i++) {
        listenToNonDelegatedEvent(mediaEventTypes[i], domElement);
      }
      props = rawProps;
      break;

    case 'input':
      initWrapperState(domElement, rawProps);
      props = getHostProps(domElement, rawProps);
      listenToNonDelegatedEvent('invalid', domElement);
      break;

    case 'select':
      initWrapperState$1(domElement, rawProps);
      props = getHostProps$1(domElement, rawProps);
      listenToNonDelegatedEvent('invalid', domElement);
      break;

    case 'textarea':
      initWrapperState$2(domElement, rawProps);
      props = getHostProps$2(domElement, rawProps);
      listenToNonDelegatedEvent('invalid', domElement);
      break;

    default:
      props = rawProps;
  }

  // 2단계: 속성 설정
  setInitialDOMProperties(tag, domElement, rootContainerElement, props, isCustomComponentTag);

  // 3단계: 폼 요소 후처리
  switch (tag) {
    case 'input':
      track(domElement);              // value 추적 시작
      postMountWrapper(domElement, rawProps, false);
      break;
    case 'textarea':
      track(domElement);
      postMountWrapper$3(domElement);
      break;
    case 'select':
      postMountWrapper$2(domElement, rawProps);
      break;
    default:
      if (typeof props.onClick === 'function') {
        trapClickOnNonInteractiveElement(domElement);
        // Safari에서 비-인터랙티브 요소의 click 이벤트가 발생하도록
      }
      break;
  }
}
```

### 11.3 setInitialDOMProperties

```javascript
// L9670
function setInitialDOMProperties(tag, domElement, rootContainerElement,
                                 nextProps, isCustomComponentTag) {
  for (var propKey in nextProps) {
    if (!nextProps.hasOwnProperty(propKey)) continue;
    var nextProp = nextProps[propKey];

    if (propKey === STYLE) {
      if (nextProp) Object.freeze(nextProp);  // 스타일 객체 변이 방지
      setValueForStyles(domElement, nextProp);
    }
    else if (propKey === DANGEROUSLY_SET_INNER_HTML) {
      var nextHtml = nextProp ? nextProp.__html : undefined;
      if (nextHtml != null) setInnerHTML(domElement, nextHtml);
    }
    else if (propKey === CHILDREN) {
      if (typeof nextProp === 'string') {
        var canSetTextContent = tag !== 'textarea' || nextProp !== '';
        if (canSetTextContent) setTextContent(domElement, nextProp);
      } else if (typeof nextProp === 'number') {
        setTextContent(domElement, '' + nextProp);
      }
    }
    else if (propKey === SUPPRESS_CONTENT_EDITABLE_WARNING
             || propKey === SUPPRESS_HYDRATION_WARNING) {
      // React 전용 props — DOM에 반영하지 않음
    }
    else if (propKey === AUTOFOCUS) {
      // autoFocus는 commitMount에서 별도 처리
    }
    else if (registrationNameDependencies.hasOwnProperty(propKey)) {
      // 이벤트 핸들러 → DOM에 직접 등록하지 않음
      // __reactProps$에 저장되어 위임 시스템에서 사용
      if (nextProp != null && propKey === 'onScroll') {
        listenToNonDelegatedEvent('scroll', domElement);
      }
    }
    else if (nextProp != null) {
      setValueForProperty(domElement, propKey, nextProp, isCustomComponentTag);
    }
  }
}
```

### 11.4 createInstance — 모든 것을 조립

```javascript
// L10924
function createInstance(type, props, rootContainerInstance, hostContext, internalInstanceHandle) {
  // 1. DOM 요소 생성
  var domElement = createElement(type, props, rootContainerInstance, parentNamespace);

  // 2. Fiber → DOM 양방향 링크 설정
  precacheFiberNode(internalInstanceHandle, domElement);  // DOM.__reactFiber$
  updateFiberProps(domElement, props);                     // DOM.__reactProps$

  return domElement;
}
```

---

## 12. 폼 요소 — 제어 컴포넌트의 내부

### 12.1 제어 컴포넌트의 원리

React의 제어 컴포넌트(controlled component)는 "진실의 단일 원천(single source of truth)"을 React state에 둔다. 이를 구현하기 위해 react-dom은 input, textarea, select에 대해 특별한 래퍼 로직을 적용한다.

```
제어 컴포넌트 동작 원리:

사용자 입력 "abc"
      │
      ▼
[1] 브라우저가 DOM input.value = "abc" 설정
      │
      ▼
[2] React input 이벤트 → onChange 핸들러
      │
      ▼
[3] onChange에서 setState("abc")
      │
      ▼
[4] Re-render → diffProperties
      │  props.value = "abc"
      │  DOM input.value = "abc"  (동일하므로 변경 없음)
      │
      ▼
[5] 만약 onChange에서 setState("AB")로 변경했다면:
      │  props.value = "AB"
      │  DOM input.value = "AB"  ← React가 DOM을 덮어씀
      │
      ▼
결과: React state가 DOM을 제어
```

### 12.2 input — initWrapperState & updateWrapper

```javascript
// L1744 — isControlled: value 또는 checked가 있으면 제어 컴포넌트
function isControlled(props) {
  var usesChecked = props.type === 'checkbox' || props.type === 'radio';
  return usesChecked ? props.checked != null : props.value != null;
}

// L1770 — getHostProps: props 변환
function getHostProps(element, props) {
  var node = element;
  var checked = props.checked;
  var hostProps = assign({}, props, {
    defaultChecked: undefined,
    defaultValue: undefined,
    value: undefined,
    checked: checked != null ? checked : node._wrapperState.initialChecked
  });
  return hostProps;
}

// L1783 — initWrapperState: 초기 상태 저장
function initWrapperState(element, props) {
  var node = element;
  var defaultValue = props.defaultValue == null ? '' : props.defaultValue;

  node._wrapperState = {
    initialChecked: props.checked != null ? props.checked : props.defaultChecked,
    initialValue: getToStringValue(props.value != null ? props.value : defaultValue),
    controlled: isControlled(props)
  };
}
```

`_wrapperState`는 DOM 노드에 직접 붙는 React 전용 메타데이터다. 하이드레이션 시 서버 렌더링 값과 클라이언트 초기값을 비교하는 데 사용된다.

```javascript
// L1820 — updateWrapper: 업데이트 시 DOM 동기화
function updateWrapper(element, props) {
  var node = element;

  // 제어 ↔ 비제어 전환 경고
  {
    var controlled = isControlled(props);
    if (!node._wrapperState.controlled && controlled && !didWarnUncontrolledToControlled) {
      error('A component is changing an uncontrolled input to be controlled...');
    }
  }

  updateChecked(element, props);
  var value = getToStringValue(props.value);
  var type = props.type;

  if (value != null) {
    if (type === 'number') {
      if (value === 0 && node.value === '' || node.value != value) {
        node.value = toString(value);
      }
    } else if (node.value !== toString(value)) {
      node.value = toString(value);
    }
  } else if (type === 'submit' || type === 'reset') {
    node.removeAttribute('value');
    return;
  }

  // defaultValue 동기화
  if (props.hasOwnProperty('value')) {
    setDefaultValue(node, props.type, value);
  } else if (props.hasOwnProperty('defaultValue')) {
    setDefaultValue(node, props.type, getToStringValue(props.defaultValue));
  }

  // checked 동기화
  if (props.checked == null && props.defaultChecked != null) {
    node.defaultChecked = !!props.defaultChecked;
  }
}
```

핵심: `node.value !== toString(value)` 비교 후에만 DOM을 업데이트한다. 이 최적화 덕분에 같은 값을 다시 설정할 때 불필요한 DOM 변경을 피한다.

### 12.3 select — option 동기화

```javascript
// L2175
function getHostProps$1(element, props) {
  return assign({}, props, {
    value: undefined  // select의 value는 option 선택으로 처리
  });
}

// L2199
function postMountWrapper$2(element, props) {
  var node = element;
  node.multiple = !!props.multiple;
  var value = props.value;

  if (value != null) {
    updateOptions(node, !!props.multiple, value, false);
  } else if (props.defaultValue != null) {
    updateOptions(node, !!props.multiple, props.defaultValue, true);
  }
}

// L2220
function postUpdateWrapper(element, props) {
  var node = element;
  var wasMultiple = node._wrapperState.wasMultiple;
  node._wrapperState.wasMultiple = !!props.multiple;
  var value = props.value;

  if (value != null) {
    updateOptions(node, !!props.multiple, value, false);
  } else if (wasMultiple !== !!props.multiple) {
    if (props.defaultValue != null) {
      updateOptions(node, !!props.multiple, props.defaultValue, true);
    } else {
      updateOptions(node, !!props.multiple, props.multiple ? [] : '', false);
    }
  }
}
```

`select`의 `value` props가 `getHostProps$1`에서 `undefined`로 제거되는 이유: `select.value`를 직접 설정하면 브라우저의 option 선택 로직과 충돌할 수 있다. 대신 `updateOptions`에서 각 `<option>`의 `selected` 속성을 개별 설정한다.

### 12.4 textarea — 특수한 children 처리

```javascript
// L2278
function getHostProps$2(element, props) {
  var node = element;

  if (props.dangerouslySetInnerHTML != null) {
    throw new Error('`dangerouslySetInnerHTML` does not make sense on <textarea>.');
  }

  var hostProps = assign({}, props, {
    value: undefined,
    defaultValue: undefined,
    children: toString(node._wrapperState.initialValue)
    // textarea의 children은 initialValue로 대체
  });

  return hostProps;
}

// L2309
function initWrapperState$2(element, props) {
  var initialValue = props.value;

  if (initialValue == null) {
    var children = props.children;
    var defaultValue = props.defaultValue;

    if (children != null) {
      // <textarea>text</textarea> 형태 지원 (deprecated)
      if (isArray(children)) {
        if (children.length > 1) {
          throw new Error('<textarea> can only have at most one child.');
        }
        children = children[0];
      }
      defaultValue = children;
    }

    if (defaultValue == null) defaultValue = '';
    initialValue = defaultValue;
  }

  node._wrapperState = {
    initialValue: getToStringValue(initialValue)
  };
}
```

---

## 13. Host Config — Reconciler와의 계약

### 13.1 Host Config이란

react-dom은 React Reconciler가 정의한 "Host Config" 인터페이스를 구현한다. 이 인터페이스가 React를 플랫폼 독립적으로 만드는 핵심이다. react-dom이 구현하는 주요 함수들:

```
Host Config 인터페이스 (react-dom 구현):

┌─────────────────────────────────┬────────────────────┬────────┐
│ 함수                            │ 역할               │ 라인   │
├─────────────────────────────────┼────────────────────┼────────┤
│ createInstance()                │ DOM 요소 생성       │ L10924 │
│ createTextInstance()            │ 텍스트 노드 생성    │ L10959 │
│ appendInitialChild()            │ 초기 자식 추가      │ L10953 │
│ finalizeInitialChildren()       │ 초기 속성 설정      │ L10949 │
│ prepareUpdate()                 │ diff 계산          │ diffP. │
│ commitUpdate()                  │ DOM 업데이트 반영   │ L11045 │
│ commitMount()                   │ autoFocus 등       │ L11017 │
│ commitTextUpdate()              │ 텍스트 변경         │ L11053 │
│ appendChild()                   │ 자식 추가          │ L11058 │
│ appendChildToContainer()        │ 컨테이너에 추가     │ L11061 │
│ insertBefore()                  │ 자식 삽입          │ 근처   │
│ removeChild()                   │ 자식 제거          │ 근처   │
│ prepareForCommit()              │ 이벤트 비활성화     │ L10910 │
│ resetAfterCommit()              │ 이벤트 복원         │ L10918 │
│ shouldSetTextContent()          │ 텍스트 최적화 판단  │ L10979 │
│ getPublicInstance()             │ ref 반환값         │ 근처   │
└─────────────────────────────────┴────────────────────┴────────┘
```

### 13.2 prepareForCommit / resetAfterCommit

```javascript
// L10910
function prepareForCommit(containerInfo) {
  eventsEnabled = isEnabled();
  selectionInformation = getSelectionInformation();  // 현재 선택 영역 저장
  var activeInstance = null;

  setEnabled(false);  // ★ 이벤트 처리 비활성화
  return activeInstance;
}

// L10918
function resetAfterCommit(containerInfo) {
  restoreSelection(selectionInformation);  // 선택 영역 복원
  setEnabled(eventsEnabled);               // ★ 이벤트 처리 복원
  eventsEnabled = null;
  selectionInformation = null;
}
```

Commit Phase 동안 이벤트를 비활성화하는 이유: DOM을 변경하는 동안 발생하는 이벤트(focus, blur 등)가 React 상태와 불일치를 일으킬 수 있기 때문이다. 선택 영역(selection)을 저장/복원하는 이유: DOM 조작 중에 텍스트 선택이 해제되는 것을 방지하기 위해서다.

### 13.3 commitMount — autoFocus 처리

```javascript
// L11017
function commitMount(domElement, type, newProps, internalInstanceHandle) {
  // autoFocus는 mount 시에만 동작해야 한다
  switch (type) {
    case 'button':
    case 'input':
    case 'select':
    case 'textarea':
      if (newProps.autoFocus) {
        domElement.focus();
      }
      return;
    case 'img':
      // img의 경우 추가 처리 없음
      return;
  }
}
```

`autoFocus`가 `setInitialDOMProperties`에서 무시되고 `commitMount`에서 처리되는 이유: DOM 요소가 실제로 문서에 삽입된 후에만 `focus()`가 동작하기 때문이다.

### 13.4 shouldSetTextContent — 텍스트 최적화

```javascript
// L10979
function shouldSetTextContent(type, props) {
  return type === 'textarea'
    || type === 'noscript'
    || typeof props.children === 'string'
    || typeof props.children === 'number'
    || (typeof props.dangerouslySetInnerHTML === 'object'
        && props.dangerouslySetInnerHTML !== null
        && props.dangerouslySetInnerHTML.__html != null);
}
```

이 함수가 `true`를 반환하면 Reconciler는 해당 요소의 children을 위한 별도의 Fiber를 만들지 않고, 텍스트를 직접 DOM 요소의 `textContent`로 설정한다. `<div>Hello</div>`에서 "Hello"에 대한 별도의 텍스트 Fiber가 생기지 않는 이유가 바로 이것이다.

---

## 14. 전체 아키텍처 종합

### 14.1 react-dom의 역할 요약

```
React 전체 아키텍처에서 react-dom의 위치:

┌─────────────────────────────────────────────────┐
│                    react                         │
│  (JSX, Hooks, createElement, Component)          │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│              react-reconciler                    │
│  (Fiber 트리, 스케줄러 연동, beginWork,           │
│   completeWork, commitWork)                      │
│                                                  │
│  Host Config 인터페이스 호출:                     │
│  ├── createInstance()                            │
│  ├── finalizeInitialChildren()                   │
│  ├── prepareUpdate() → diffProperties()          │
│  ├── commitUpdate()                              │
│  └── ...                                         │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│                  react-dom                       │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │ 이벤트 시스템                             │    │
│  │ ├── listenToAllSupportedEvents()         │    │
│  │ ├── createEventListenerWrapperWithPri()  │    │
│  │ ├── dispatchDiscreteEvent()              │    │
│  │ ├── getClosestInstanceFromNode()         │    │
│  │ ├── accumulateSinglePhaseListeners()     │    │
│  │ └── processDispatchQueue()               │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │ DOM 조작                                  │    │
│  │ ├── createElement() / createTextNode()   │    │
│  │ ├── setInitialProperties()               │    │
│  │ ├── diffProperties()                     │    │
│  │ ├── updateDOMProperties()                │    │
│  │ ├── setValueForProperty()                │    │
│  │ └── setValueForStyles()                  │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │ 폼 요소                                   │    │
│  │ ├── input: initWrapperState/updateWrapper│    │
│  │ ├── select: initWrapperState$1/postUpdate│    │
│  │ └── textarea: initWrapperState$2/update  │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │ DOM-Fiber 링크                            │    │
│  │ ├── __reactFiber$xxx (DOM → Fiber)       │    │
│  │ ├── __reactProps$xxx (DOM → Props)       │    │
│  │ └── __reactContainer$xxx (Container)     │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  Browser DOM    │
              └─────────────────┘
```

### 14.2 이벤트 전체 흐름 (click 예시)

```
사용자가 <button onClick={handleClick}>을 클릭:

[Browser]
 │ click 이벤트 발생
 │
 ▼
[Root Container]
 │ addEventListener('click', dispatchDiscreteEvent, false)
 │ → 이미 createRoot() 시점에 등록됨
 │
 ▼
[dispatchDiscreteEvent]              L6423
 │ setCurrentUpdatePriority(SyncLane)
 │
 ▼
[dispatchEvent]                      L6451
 │ _enabled 체크
 │
 ▼
[findInstanceBlockingEvent]          L6540
 │ getEventTarget(nativeEvent) → <button> DOM
 │ getClosestInstanceFromNode(<button>) → button Fiber
 │
 ▼
[dispatchEventForPluginEventSystem]  L9200
 │ Portal 경계 확인
 │ batchedUpdates() 진입
 │
 ▼
[dispatchEventsForPlugins]           L9096
 │
 ├─[extractEvents$5]                 L9000
 │  ├─ extractEvents$4 (SimpleEventPlugin)
 │  │   domEventName='click' → SyntheticMouseEvent
 │  │   accumulateSinglePhaseListeners()
 │  │   └─ Fiber 트리 순회: button → div → App → Root
 │  │      각 HostComponent에서 getListener('onClick')
 │  │      └─ getFiberCurrentPropsFromNode() → __reactProps$
 │  │         → props.onClick = handleClick
 │  │
 │  ├─ extractEvents$2 (ChangeEventPlugin) → 해당 없음
 │  ├─ extractEvents$1 (BeforeInputEventPlugin) → 해당 없음
 │  ├─ extractEvents$3 (SelectEventPlugin) → 해당 없음
 │  └─ extractEvents (EnterLeaveEventPlugin) → 해당 없음
 │
 └─[processDispatchQueue]
    │ inCapturePhase = false (bubble)
    │
    └─ listeners 정순 실행:
       [0] handleClick(syntheticEvent)
       │   syntheticEvent.target = <button>
       │   syntheticEvent.currentTarget = <button>
       │   syntheticEvent.nativeEvent = MouseEvent
       │
       └─ 핸들러 내부에서 setState() 호출 시:
          → currentUpdatePriority = SyncLane (DiscreteEvent)
          → requestUpdateLane() → SyncLane 할당
          → 동기적 re-render 예약
```

### 14.3 DOM 업데이트 전체 흐름

```
Re-render로 className이 변경되는 경우:

[beginWork - updateHostComponent]
 │ 새로운 children props 처리
 │
 ▼
[completeWork - HostComponent]
 │ updateHostComponent$1()
 │ 이전 props vs 현재 props 비교
 │
 ├─[diffProperties()]               L9956
 │  │ tag별 props 변환 (input → getHostProps 등)
 │  │
 │  │ 1단계: lastProps 순회 → 삭제된 속성 수집
 │  │ 2단계: nextProps 순회 → 변경된 속성 수집
 │  │
 │  └─ return ['className', 'new-value']
 │
 └─ workInProgress.updateQueue = updatePayload
    workInProgress.flags |= Update
                              │
                              ▼
[commitMutationEffects]
 │
 ├─[commitUpdate()]              L11045
 │  │
 │  ├─ updateProperties()        L10132
 │  │   ├─ updateDOMProperties() L9725
 │  │   │   └─ setValueForProperty(node, 'className', 'new-value')
 │  │   │       └─ node.className = 'new-value'
 │  │   │
 │  │   └─ (input/select/textarea 후처리)
 │  │
 │  └─ updateFiberProps(domElement, newProps)
 │      └─ domElement.__reactProps$xxx = newProps
 │
 ▼
DOM 반영 완료
```

### 14.4 핵심 설계 원칙

**1. 이벤트 위임으로 메모리 효율화**: 1000개의 `<li onClick>`이 있어도 실제 이벤트 리스너는 루트에 하나만 존재한다. 리스너는 `__reactProps$`에서 동적으로 조회된다.

**2. updatePayload로 최소 변경**: `diffProperties`가 변경된 속성만 정확히 추출하고, `updateDOMProperties`가 해당 속성만 DOM에 반영한다. 배열 구조로 객체 할당 오버헤드를 줄인다.

**3. 합성 이벤트로 크로스 브라우저 추상화**: `SyntheticEvent`가 브라우저 차이를 정규화한다. IE의 `returnValue`, `cancelBubble` 같은 레거시 API도 투명하게 처리한다.

**4. 제어 컴포넌트로 단방향 데이터 흐름**: `initWrapperState` → `updateWrapper` 사이클이 "React state → DOM"의 단방향 흐름을 강제한다. 사용자 입력은 반드시 이벤트 핸들러를 통해 state를 거쳐 DOM에 반영된다.

**5. Host Config으로 플랫폼 추상화**: `createInstance`, `commitUpdate` 같은 함수를 다른 구현으로 교체하면 React Native, React Three Fiber 같은 다른 렌더러가 된다. react-dom은 이 계약의 "브라우저용 구현체"다.

---

## 마무리

react-dom은 React의 추상적인 Fiber 트리와 실제 브라우저 DOM 사이의 번역기다. 29,923줄이라는 방대한 코드 속에 이벤트 위임, 합성 이벤트, DOM diff, 폼 제어, 하이드레이션 등 웹 애플리케이션의 핵심 문제들이 모두 녹아 있다.

특히 이벤트 시스템의 설계가 인상적이다. 하나의 루트 리스너가 모든 이벤트를 잡고, `__reactFiber$`로 DOM에서 Fiber를 찾고, Fiber 트리를 순회하며 리스너를 수집하고, 우선순위에 따라 업데이트를 스케줄링한다. 이 모든 과정이 사용자가 `<button onClick={fn}>`을 쓸 때 투명하게 일어난다.

다음 편에서는 React DOM의 또 다른 얼굴인 **SSR(Server-Side Rendering)**의 스트리밍 렌더링과 선택적 하이드레이션을 다룬다.

---

> **시리즈 네비게이션**
> - 이전: [11편 — Context와 상태 관리](./react-architecture-11-context.md)
> - 다음: [13편 — SSR 스트리밍과 선택적 하이드레이션](./react-architecture-13-ssr-streaming.md)
