# React 18 다중 렌더러 아키텍처 분석

> 시리즈: React 아키텍처 심층 분석 - 13편
> 분석 대상: react-dom@18.3.1 기준 — 다른 렌더러들과의 비교
> 소스 경로: `node_modules/.pnpm/react-dom@18.3.1/node_modules/react-dom/cjs/react-dom.development.js`

---

## 도입: React는 DOM 라이브러리가 아니다

React를 "DOM 라이브러리"라고 부르는 것은 엔진을 "피스톤"이라고 부르는 것과 같다. 피스톤은 엔진의 핵심 부품이지만 엔진 그 자체는 아니다. 마찬가지로, DOM은 React가 출력할 수 있는 여러 타겟 중 하나에 불과하다.

React의 아키텍처는 처음부터 **Reconciler(재조정 엔진)**와 **Renderer(렌더러)**를 분리하도록 설계되었다. 1편에서 다룬 패키지 계층 구조를 떠올려보면, `react` 코어와 `react-reconciler`는 렌더 타겟에 대해 아무것도 모른다. DOM이든, 네이티브 뷰든, 터미널 텍스트든 — Reconciler가 요구하는 **Host Config 인터페이스**만 구현하면 어떤 플랫폼이든 React의 선언적 프로그래밍 모델을 사용할 수 있다.

```
┌─────────────────────────────────────────────────────────┐
│                     React Core (react)                   │
│              createElement, hooks, JSX 런타임             │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              React Reconciler (react-reconciler)         │
│        Fiber 트리, Diffing, Lane 스케줄링, Commit         │
│                                                          │
│    ┌──────────────────────────────────────────────┐     │
│    │           Host Config Interface              │     │
│    │  createInstance, appendChild, commitUpdate... │     │
│    └──────────────────────────────────────────────┘     │
└────────┬──────────┬──────────┬──────────┬───────────────┘
         │          │          │          │
         ▼          ▼          ▼          ▼
    ┌─────────┐ ┌────────┐ ┌────────┐ ┌──────────┐
    │react-dom│ │ Native │ │  Test  │ │커뮤니티  │
    │  (DOM)  │ │Renderer│ │Renderer│ │렌더러들  │
    └─────────┘ └────────┘ └────────┘ └──────────┘
         │          │          │          │
         ▼          ▼          ▼          ▼
     브라우저    iOS/Android   JSON 트리   3D/Canvas/
      DOM        네이티브 뷰              터미널/PDF...
```

이 글에서는 이 아키텍처의 핵심인 **Host Config 인터페이스**를 react-dom 소스 코드에서 구체적으로 분석하고, 이를 기준점으로 삼아 React Native, React ART, React Test Renderer, Noop Renderer, 그리고 커뮤니티 렌더러들이 같은 인터페이스를 어떻게 다르게 구현하는지 비교한다.

---

## 1. Host Config: 렌더러의 계약서

### 1.1 Host Config이란 무엇인가

`react-reconciler`는 플랫폼에 독립적인 재조정 알고리즘을 구현한다. 하지만 결국 실제 화면에 무언가를 그리려면 플랫폼 고유의 API를 호출해야 한다. 이 연결 지점이 바로 **Host Config**다.

Host Config은 Reconciler가 렌더러에게 요구하는 일종의 **계약서(Contract)**다. Reconciler는 "이 인스턴스를 만들어라", "이 자식을 추가해라", "이 속성을 업데이트해라"와 같은 명령을 내리고, 각 렌더러는 자신의 타겟 플랫폼에 맞게 이를 구현한다.

```
Host Config의 핵심 메서드 분류:

┌─────────────────────────────────────────────────────────┐
│                    Host Config Interface                  │
├─────────────────────┬───────────────────────────────────┤
│ 인스턴스 생성/관리   │ createInstance                     │
│                     │ createTextInstance                  │
│                     │ appendInitialChild                  │
│                     │ finalizeInitialChildren             │
│                     │ getPublicInstance                   │
├─────────────────────┼───────────────────────────────────┤
│ 트리 조작 (Mutation)│ appendChild                         │
│                     │ appendChildToContainer              │
│                     │ insertBefore                        │
│                     │ insertInContainerBefore             │
│                     │ removeChild                         │
│                     │ removeChildFromContainer            │
├─────────────────────┼───────────────────────────────────┤
│ 업데이트            │ prepareUpdate                       │
│                     │ commitUpdate                        │
│                     │ commitTextUpdate                    │
│                     │ commitMount                         │
│                     │ resetTextContent                    │
├─────────────────────┼───────────────────────────────────┤
│ 호스트 컨텍스트      │ getRootHostContext                  │
│                     │ getChildHostContext                 │
│                     │ shouldSetTextContent                │
├─────────────────────┼───────────────────────────────────┤
│ Commit 라이프사이클  │ prepareForCommit                   │
│                     │ resetAfterCommit                    │
│                     │ clearContainer                      │
├─────────────────────┼───────────────────────────────────┤
│ Visibility 제어     │ hideInstance                        │
│                     │ unhideInstance                      │
│                     │ hideTextInstance                    │
│                     │ unhideTextInstance                  │
├─────────────────────┼───────────────────────────────────┤
│ 스케줄링            │ scheduleTimeout                     │
│                     │ cancelTimeout                       │
│                     │ noTimeout                           │
│                     │ scheduleMicrotask                   │
│                     │ getCurrentEventPriority             │
├─────────────────────┼───────────────────────────────────┤
│ 기타                │ preparePortalMount                  │
│                     │ detachDeletedInstance               │
│                     │ isPrimaryRenderer                   │
└─────────────────────┴───────────────────────────────────┘
```

### 1.2 Mutation 모드 vs Persistence 모드

Reconciler는 호스트 환경의 특성에 따라 두 가지 모드를 지원한다.

**Mutation 모드**는 기존 인스턴스를 직접 변경(mutate)하는 방식이다. 브라우저 DOM이 대표적이다. `element.appendChild()`, `element.removeChild()`, `element.style.display = 'none'` 같은 명령형 API로 기존 노드를 직접 수정한다.

**Persistence 모드**는 기존 인스턴스를 수정하는 대신, 변경이 필요할 때마다 새로운 인스턴스를 생성하여 교체하는 방식이다. 불변(immutable) 호스트 환경에서 사용한다. React Native의 Fabric 렌더러가 C++ Shadow Tree에서 이 모드를 활용한다.

```
Mutation Mode (react-dom):
┌──────┐     ┌──────┐     ┌──────┐
│ div  │ ──▶ │ div  │ ──▶ │ div  │    같은 DOM 노드를
│ red  │     │ blue │     │green │    직접 수정
└──────┘     └──────┘     └──────┘
  동일 참조    동일 참조    동일 참조

Persistence Mode (Fabric Shadow Tree):
┌──────┐     ┌──────┐     ┌──────┐
│ View │     │ View │     │ View │    변경마다
│ red  │     │ blue │     │green │    새 인스턴스 생성
└──────┘     └──────┘     └──────┘
  참조 A       참조 B       참조 C
```

react-dom.development.js 21770행에서 이 선택이 명시적으로 드러난다:

```javascript
// react-dom.development.js, Line 21770
{
  // Mutation mode
  appendAllChildren = function (parent, workInProgress, needsVisibilityToggle, isHidden) {
    var node = workInProgress.child;
    while (node !== null) {
      if (node.tag === HostComponent || node.tag === HostText) {
        appendInitialChild(parent, node.stateNode);
      } else if (node.tag === HostPortal) ; else if (node.child !== null) {
        node.child.return = node;
        node = node.child;
        continue;
      }
      // ... 트리 순회 로직
    }
  };
```

이 코드 블록이 `{` 중괄호로 감싸져 있는 것에 주목하자. React 소스의 빌드 시스템에서 렌더러별로 Mutation 모드 또는 Persistence 모드 구현 중 하나를 선택적으로 포함시킨다. react-dom은 DOM의 특성상 항상 Mutation 모드를 사용한다.

---

## 2. react-dom: DOM 렌더러의 Host Config 심층 분석

react-dom.development.js에서 Host Config 함수들이 구현된 영역은 대략 **10862행 ~ 11600행** 구간이다. 이 구간이 React의 플랫폼 추상화가 DOM이라는 구체적 타겟과 만나는 접점이다.

### 2.1 인스턴스 생성: createInstance

```javascript
// react-dom.development.js, Line 10924
function createInstance(type, props, rootContainerInstance, hostContext, internalInstanceHandle) {
  var parentNamespace;
  {
    var hostContextDev = hostContext;
    validateDOMNesting(type, null, hostContextDev.ancestorInfo);

    if (typeof props.children === 'string' || typeof props.children === 'number') {
      var string = '' + props.children;
      var ownAncestorInfo = updatedAncestorInfo(hostContextDev.ancestorInfo, type);
      validateDOMNesting(null, string, ownAncestorInfo);
    }
    parentNamespace = hostContextDev.namespace;
  }

  var domElement = createElement(type, props, rootContainerInstance, parentNamespace);
  precacheFiberNode(internalInstanceHandle, domElement);
  updateFiberProps(domElement, props);
  return domElement;
}
```

이 함수가 하는 일을 분해하면:

1. **DOM 네스팅 검증** (`validateDOMNesting`): `<p>` 안에 `<div>`를 넣는 것 같은 잘못된 HTML 구조를 개발 모드에서 경고한다.
2. **네임스페이스 결정** (`parentNamespace`): SVG (`<svg>`) 내부의 요소들은 HTML 네임스페이스가 아닌 SVG 네임스페이스를 사용해야 한다. Host Context를 통해 이를 전파한다.
3. **DOM 요소 생성** (`createElement`): 실제 `document.createElement()` 호출이 여기서 일어난다.
4. **Fiber 노드 캐싱** (`precacheFiberNode`): DOM 노드에 `__reactFiber$` 프로퍼티로 Fiber 참조를 저장한다. 이벤트 시스템이 DOM 이벤트에서 해당 Fiber를 빠르게 찾기 위함이다.
5. **Props 캐싱** (`updateFiberProps`): DOM 노드에 `__reactProps$` 프로퍼티로 현재 props를 저장한다.

핵심 인사이트: DOM 렌더러의 `createInstance`는 단순히 DOM 노드를 만드는 것 이상의 일을 한다. **이벤트 시스템과의 통합**을 위해 DOM 노드와 Fiber 노드 사이에 양방향 참조를 설정한다. 이것은 DOM 렌더러만의 고유한 요구사항이다.

### 2.2 호스트 컨텍스트: 렌더러별 환경 정보

```javascript
// react-dom.development.js, Line 10862
function getRootHostContext(rootContainerInstance) {
  var type;
  var namespace;
  var nodeType = rootContainerInstance.nodeType;

  switch (nodeType) {
    case DOCUMENT_NODE:
    case DOCUMENT_FRAGMENT_NODE: {
      type = nodeType === DOCUMENT_NODE ? '#document' : '#fragment';
      var root = rootContainerInstance.documentElement;
      namespace = root ? root.namespaceURI : getChildNamespace(null, '');
      break;
    }
    default: {
      var container = nodeType === COMMENT_NODE
        ? rootContainerInstance.parentNode
        : rootContainerInstance;
      var ownNamespace = container.namespaceURI || null;
      type = container.tagName;
      namespace = getChildNamespace(ownNamespace, type);
      break;
    }
  }
  {
    var validatedTag = type.toLowerCase();
    var ancestorInfo = updatedAncestorInfo(null, validatedTag);
    return {
      namespace: namespace,
      ancestorInfo: ancestorInfo
    };
  }
}
```

DOM 렌더러의 Host Context는 두 가지 정보를 담는다:
- **namespace**: HTML vs SVG vs MathML 네임스페이스. `<svg>` 내부에서 `<circle>`을 만들 때 올바른 네임스페이스를 사용하기 위함이다.
- **ancestorInfo**: DOM 네스팅 규칙 검증용 조상 정보. 이 정보가 Fiber 트리를 내려가며 `getChildHostContext`를 통해 전파된다.

```javascript
// react-dom.development.js, Line 10896
function getChildHostContext(parentHostContext, type, rootContainerInstance) {
  {
    var parentHostContextDev = parentHostContext;
    var namespace = getChildNamespace(parentHostContextDev.namespace, type);
    var ancestorInfo = updatedAncestorInfo(parentHostContextDev.ancestorInfo, type);
    return {
      namespace: namespace,
      ancestorInfo: ancestorInfo
    };
  }
}
```

이 패턴은 Reconciler가 트리를 순회하면서 각 깊이에서의 플랫폼별 컨텍스트를 축적할 수 있게 해준다. 다른 렌더러에서는 완전히 다른 정보를 담는다:
- **React Native**: 텍스트 컨텍스트 (텍스트 내부인지 여부)
- **react-three-fiber**: 부모 Object3D 참조
- **ink (터미널)**: 현재 레이아웃 컨텍스트

### 2.3 트리 조작: Mutation 연산들

```javascript
// react-dom.development.js, Line 11058
function appendChild(parentInstance, child) {
  parentInstance.appendChild(child);
}

// Line 11061
function appendChildToContainer(container, child) {
  var parentNode;
  if (container.nodeType === COMMENT_NODE) {
    parentNode = container.parentNode;
    parentNode.insertBefore(child, container);
  } else {
    parentNode = container;
    parentNode.appendChild(child);
  }
  // 포털 컨테이너의 click 이벤트 버블링 보장
  var reactRootContainer = container._reactRootContainer;
  if ((reactRootContainer === null || reactRootContainer === undefined)
      && parentNode.onclick === null) {
    trapClickOnNonInteractiveElement(parentNode);
  }
}

// Line 11087
function insertBefore(parentInstance, child, beforeChild) {
  parentInstance.insertBefore(child, beforeChild);
}

// Line 11098
function removeChild(parentInstance, child) {
  parentInstance.removeChild(child);
}
```

DOM 렌더러의 트리 조작은 브라우저 DOM API에 대한 얇은 래퍼다. 하지만 `appendChildToContainer`에서 포털의 `COMMENT_NODE` 처리와 Mobile Safari의 click 이벤트 버블링 워크어라운드가 포함된 것을 볼 수 있다. 이런 브라우저 고유의 quirk 처리가 Host Config 레이어에서 캡슐화된다.

### 2.4 업데이트: prepareUpdate와 commitUpdate

업데이트 사이클은 두 단계로 나뉜다:

```javascript
// react-dom.development.js, Line 10966
function prepareUpdate(domElement, type, oldProps, newProps, rootContainerInstance, hostContext) {
  {
    var hostContextDev = hostContext;
    if (typeof newProps.children !== typeof oldProps.children &&
        (typeof newProps.children === 'string' || typeof newProps.children === 'number')) {
      var string = '' + newProps.children;
      var ownAncestorInfo = updatedAncestorInfo(hostContextDev.ancestorInfo, type);
      validateDOMNesting(null, string, ownAncestorInfo);
    }
  }
  return diffProperties(domElement, type, oldProps, newProps);
}
```

`prepareUpdate`는 Render Phase(비동기, 중단 가능)에서 호출된다. DOM을 직접 수정하지 않고, 변경해야 할 속성들의 **diff 결과**만 계산하여 반환한다. `diffProperties`가 `[propKey1, propValue1, propKey2, propValue2, ...]` 형태의 배열을 반환하거나, 변경이 없으면 `null`을 반환한다.

```javascript
// react-dom.development.js, Line 11045
function commitUpdate(domElement, updatePayload, type, oldProps, newProps, internalInstanceHandle) {
  // diff 결과를 DOM에 적용
  updateProperties(domElement, updatePayload, type, oldProps, newProps);
  // 이벤트 핸들러 조회를 위한 props 캐시 갱신
  updateFiberProps(domElement, newProps);
}
```

`commitUpdate`는 Commit Phase(동기, 중단 불가)에서 호출된다. `prepareUpdate`에서 계산한 updatePayload를 받아 실제 DOM을 변경한다.

```
업데이트 흐름 (2단계 분리):

  Render Phase (비동기)              Commit Phase (동기)
  ┌───────────────────┐            ┌───────────────────┐
  │  prepareUpdate()  │            │  commitUpdate()   │
  │                   │            │                   │
  │  oldProps:        │            │  updatePayload:   │
  │  {color: 'red'}   │ ────────▶ │  ['color','blue'] │
  │                   │  payload   │                   │
  │  newProps:        │            │  updateProperties()│
  │  {color: 'blue'}  │            │  ▼                │
  │                   │            │  DOM 직접 수정     │
  │  diffProperties() │            │                   │
  └───────────────────┘            └───────────────────┘

  ※ Render Phase는 중단/재시작될 수 있으므로
     부수효과(DOM 변경)를 일으키면 안 된다
```

### 2.5 Commit 라이프사이클

```javascript
// react-dom.development.js, Line 10910
function prepareForCommit(containerInfo) {
  eventsEnabled = isEnabled();
  selectionInformation = getSelectionInformation();
  var activeInstance = null;
  setEnabled(false);
  return activeInstance;
}

// Line 10918
function resetAfterCommit(containerInfo) {
  restoreSelection(selectionInformation);
  setEnabled(eventsEnabled);
  eventsEnabled = null;
  selectionInformation = null;
}
```

DOM 렌더러의 Commit 라이프사이클은 특별한 작업을 수행한다:
- **prepareForCommit**: 현재 텍스트 선택 상태를 저장하고, 이벤트를 비활성화한다. DOM 변경 중에 이벤트가 발생하면 일관성 없는 상태를 관찰할 수 있기 때문이다.
- **resetAfterCommit**: 텍스트 선택 상태를 복원하고, 이벤트를 다시 활성화한다.

이것은 DOM 환경만의 고유한 문제다. React Native에서는 텍스트 선택이나 이벤트 비활성화 같은 개념이 필요 없으므로, 이 함수들이 비어 있거나 다른 로직을 수행한다.

### 2.6 Visibility 제어

```javascript
// react-dom.development.js, Line 11153
function hideInstance(instance) {
  instance = instance;
  var style = instance.style;
  if (typeof style.setProperty === 'function') {
    style.setProperty('display', 'none', 'important');
  } else {
    style.display = 'none';
  }
}

// Line 11165
function hideTextInstance(textInstance) {
  textInstance.nodeValue = '';
}

// Line 11168
function unhideInstance(instance, props) {
  instance = instance;
  var styleProp = props[STYLE$1];
  var display = styleProp !== undefined && styleProp !== null
    && styleProp.hasOwnProperty('display') ? styleProp.display : null;
  instance.style.display = dangerousStyleValue('display', display);
}
```

Suspense의 fallback 전환 시 사용되는 visibility 제어다. DOM에서는 `display: none`으로 숨기고, 원래 display 값으로 복원하는 방식이다. React Native에서는 `opacity: 0`이나 뷰 계층에서의 제거로 구현된다.

### 2.7 전체 Host Config 요약표 (DOM 기준)

| 함수 | 소스 위치(행) | DOM 구현 | 핵심 역할 |
|------|-------------|----------|----------|
| `getRootHostContext` | 10862 | namespace + ancestorInfo 반환 | 루트 컨텍스트 초기화 |
| `getChildHostContext` | 10896 | 부모 컨텍스트에서 namespace 파생 | 자식 컨텍스트 계산 |
| `createInstance` | 10924 | `createElement` + Fiber 캐싱 | DOM 요소 생성 |
| `createTextInstance` | 10982 | `createTextNode` + Fiber 캐싱 | 텍스트 노드 생성 |
| `appendInitialChild` | 10946 | `parentInstance.appendChild(child)` | 초기 자식 추가 |
| `finalizeInitialChildren` | 10949 | 속성 설정 + autoFocus 플래그 반환 | 초기 속성 적용 |
| `prepareUpdate` | 10966 | `diffProperties()` | props diff 계산 |
| `commitUpdate` | 11045 | `updateProperties()` | DOM에 diff 적용 |
| `commitTextUpdate` | 11055 | `textInstance.nodeValue = newText` | 텍스트 업데이트 |
| `commitMount` | 11017 | autoFocus 처리 | 마운트 후 부수효과 |
| `appendChild` | 11058 | `parentInstance.appendChild(child)` | 자식 추가 |
| `insertBefore` | 11087 | `parentInstance.insertBefore(...)` | 특정 위치에 삽입 |
| `removeChild` | 11098 | `parentInstance.removeChild(child)` | 자식 제거 |
| `hideInstance` | 11153 | `display: none !important` | Suspense 숨김 |
| `prepareForCommit` | 10910 | 선택 저장 + 이벤트 비활성화 | Commit 준비 |
| `resetAfterCommit` | 10918 | 선택 복원 + 이벤트 활성화 | Commit 완료 |
| `clearContainer` | 11177 | `textContent = ''` | 컨테이너 비우기 |
| `preparePortalMount` | 11476 | `listenToAllSupportedEvents()` | 포털 이벤트 리스닝 |

---

## 3. 렌더러 초기화 패턴: createContainer → updateContainer

모든 React 렌더러는 동일한 진입 패턴을 따른다. react-dom의 `createRoot`를 분석하면 이 패턴이 명확히 드러난다.

```javascript
// react-dom.development.js, Line 29382
function createRoot(container, options) {
  // 1. 유효한 DOM 컨테이너인지 검증
  if (!isValidContainer(container)) {
    throw new Error('createRoot(...): Target container is not a DOM element.');
  }

  // 2. 옵션 파싱 (strictMode, identifierPrefix, onRecoverableError 등)
  var isStrictMode = false;
  // ...옵션 처리...

  // 3. Reconciler에게 FiberRoot 생성 요청
  var root = createContainer(
    container,        // containerInfo: 호스트 환경의 루트 컨테이너
    ConcurrentRoot,   // tag: 동시성 모드
    null,             // hydrationCallbacks
    isStrictMode,
    concurrentUpdatesByDefaultOverride,
    identifierPrefix,
    onRecoverableError
  );

  // 4. 양방향 참조 설정
  markContainerAsRoot(root.current, container);

  // 5. 이벤트 시스템 초기화 (DOM 고유)
  var rootContainerElement = container.nodeType === COMMENT_NODE
    ? container.parentNode : container;
  listenToAllSupportedEvents(rootContainerElement);

  // 6. ReactDOMRoot 래퍼 반환
  return new ReactDOMRoot(root);
}
```

```javascript
// react-dom.development.js, Line 28821
function createContainer(containerInfo, tag, hydrationCallbacks, isStrictMode,
    concurrentUpdatesByDefaultOverride, identifierPrefix, onRecoverableError, transitionCallbacks) {
  var hydrate = false;
  var initialChildren = null;
  return createFiberRoot(containerInfo, tag, hydrate, initialChildren, ...);
}
```

그리고 `root.render(element)`가 호출되면:

```javascript
// react-dom.development.js, Line 29324
ReactDOMRoot.prototype.render = function (children) {
  var root = this._internalRoot;
  // ...검증...
  updateContainer(children, root, null, null);
};
```

```javascript
// react-dom.development.js, Line 28847
function updateContainer(element, container, parentComponent, callback) {
  var current$1 = container.current;   // rootFiber
  var eventTime = requestEventTime();
  var lane = requestUpdateLane(current$1);

  var update = createUpdate(eventTime, lane);
  update.payload = { element: element };  // <App /> 같은 React 엘리먼트

  var root = enqueueUpdate(current$1, update, lane);
  if (root !== null) {
    scheduleUpdateOnFiber(root, current$1, lane, eventTime);
  }
}
```

이 패턴을 일반화하면 모든 렌더러의 초기화 흐름은 다음과 같다:

```
모든 렌더러의 초기화 패턴:

1. createContainer(containerInfo, ...)
   └─▶ createFiberRoot()
       └─▶ FiberRoot + rootFiber 생성

2. 플랫폼별 초기화
   └─▶ DOM: listenToAllSupportedEvents()
   └─▶ Native: 네이티브 뷰 계층 연결
   └─▶ Test: JSON 트리 버퍼 초기화

3. updateContainer(element, root, ...)
   └─▶ createUpdate() → enqueueUpdate() → scheduleUpdateOnFiber()
   └─▶ 재조정 시작 → Host Config 메서드 호출 → Commit
```

---

## 4. React Native Renderer: Fabric vs Legacy

### 4.1 레거시 아키텍처 (UIManager + Bridge)

React Native의 초기 렌더러는 **Bridge 아키텍처** 위에 구축되었다. JavaScript와 네이티브 코드 사이에 비동기 JSON 직렬화 브릿지가 존재했다.

```
레거시 React Native 아키텍처:

┌───────────────────────────────┐
│        JavaScript Thread       │
│  ┌─────────────────────────┐  │
│  │   React Reconciler      │  │
│  │   (Fiber 트리 관리)      │  │
│  └──────────┬──────────────┘  │
│             │ Host Config      │
│  ┌──────────▼──────────────┐  │
│  │  React Native Renderer  │  │
│  │  UIManager.createView() │  │
│  │  UIManager.updateView() │  │
│  │  UIManager.setChildren()│  │
│  └──────────┬──────────────┘  │
└─────────────┼─────────────────┘
              │ 비동기 JSON 직렬화
              │ (Bridge)
┌─────────────▼─────────────────┐
│         Native Thread          │
│  ┌─────────────────────────┐  │
│  │  UIManager (Java/ObjC)  │  │
│  │  실제 뷰 생성/업데이트    │  │
│  └──────────┬──────────────┘  │
│             │                  │
│  ┌──────────▼──────────────┐  │
│  │  Native View Hierarchy  │  │
│  │  (UIView/android.View)  │  │
│  └─────────────────────────┘  │
└────────────────────────────────┘
```

레거시 렌더러에서 Host Config의 `createInstance`는 이런 식으로 동작했다:

```javascript
// 레거시 React Native Renderer (개념적 코드)
function createInstance(type, props, rootContainerInstance, hostContext, fiber) {
  var tag = allocateTag();  // 고유한 정수 태그 할당
  var viewConfig = ReactNativeViewConfigRegistry.get(type);

  // UIManager에 네이티브 뷰 생성 명령을 Bridge를 통해 전달
  UIManager.createView(
    tag,                    // 뷰 식별자
    viewConfig.uiViewClassName,  // 'RCTView', 'RCTText' 등
    rootContainerInstance,  // 루트 태그
    updatePayload           // 직렬화된 props
  );

  return {
    _children: [],
    _nativeTag: tag,
    viewConfig: viewConfig
  };
}
```

**핵심 차이점**: DOM 렌더러의 `createInstance`가 실제 DOM 노드를 **동기적으로** 반환하는 반면, 레거시 Native 렌더러는 정수 태그를 가진 **경량 JavaScript 객체**를 반환한다. 실제 네이티브 뷰 생성은 Bridge를 통해 **비동기적으로** 발생한다.

이 비동기성이 문제의 근원이었다:
- **레이아웃 지연**: JS가 "이 뷰를 만들어라"라고 보내면, 네이티브 측에서 뷰를 만들고 레이아웃을 계산한 결과가 다시 Bridge를 통해 돌아와야 했다.
- **프레임 드롭**: 스크롤이나 제스처처럼 빠른 인터랙션에서 Bridge의 비동기 직렬화가 병목이 되었다.
- **동시성 불가**: Bridge가 단일 큐이므로, 우선순위가 높은 업데이트도 큐 뒤에서 기다려야 했다.

### 4.2 Fabric 아키텍처 (C++ Shadow Tree + JSI)

Fabric은 React Native의 새로운 렌더링 시스템으로, Bridge를 **JSI(JavaScript Interface)**로 대체하고, **C++ Shadow Tree**를 도입했다.

```
Fabric 아키텍처:

┌───────────────────────────────┐
│        JavaScript Thread       │
│  ┌─────────────────────────┐  │
│  │   React Reconciler      │  │
│  │   (Fiber 트리 관리)      │  │
│  └──────────┬──────────────┘  │
│             │ Host Config      │
│  ┌──────────▼──────────────┐  │
│  │  Fabric Renderer (JS)   │  │
│  │  C++ Shadow Node 참조   │  │
│  └──────────┬──────────────┘  │
└─────────────┼─────────────────┘
              │ JSI (동기 호출, 직렬화 없음)
              │
┌─────────────▼─────────────────┐
│       C++ Shadow Tree          │
│  ┌─────────────────────────┐  │
│  │  ShadowNode 트리         │  │
│  │  (불변, 구조적 공유)      │  │
│  │                          │  │
│  │  Yoga 레이아웃 엔진       │  │
│  │  (동기 레이아웃 계산)     │  │
│  └──────────┬──────────────┘  │
└─────────────┼─────────────────┘
              │ 동기 마운트
              │
┌─────────────▼─────────────────┐
│         Native Thread          │
│  ┌─────────────────────────┐  │
│  │  Native View Hierarchy  │  │
│  │  (UIView/android.View)  │  │
│  └─────────────────────────┘  │
└────────────────────────────────┘
```

Fabric에서 Host Config의 핵심 변경:

```javascript
// Fabric Renderer (개념적 코드)
function createInstance(type, props, rootContainerInstance, hostContext, fiber) {
  // JSI를 통해 C++ ShadowNode를 동기적으로 생성
  var shadowNode = ShadowNodeRegistry.createNode(
    tag,
    type,        // 'View', 'Text', 'Image' 등
    rootTag,
    props,       // 직렬화 없이 직접 전달
    fiber        // Fiber 참조도 직접 전달 가능
  );

  return {
    node: shadowNode,  // C++ 객체에 대한 JSI 참조
    canonical: {
      nativeTag: tag,
      viewConfig: viewConfig,
      currentProps: props
    }
  };
}
```

**Fabric과 DOM 렌더러의 Host Config 비교:**

| 관점 | react-dom | Legacy Native | Fabric |
|------|-----------|--------------|--------|
| `createInstance` 반환값 | DOM 노드 | JS 객체 (태그) | JSI C++ Shadow Node |
| 통신 방식 | 동기 (같은 스레드) | 비동기 Bridge | 동기 JSI |
| 데이터 직렬화 | 불필요 | JSON 직렬화 | 불필요 |
| Mutation 모드 | O (DOM 직접 변경) | O (UIManager 명령) | △ (Shadow Tree는 Persistent) |
| 레이아웃 | 브라우저 엔진 | Yoga (비동기) | Yoga (동기) |
| 이벤트 시스템 | SyntheticEvent | Bridge 이벤트 | JSI 직접 호출 |

Fabric의 가장 혁신적인 측면은 **C++ Shadow Tree의 불변성(Immutability)**이다. Shadow Tree는 Persistence 모드처럼 동작한다 — 업데이트 시 기존 트리를 변경하는 대신 새로운 트리를 생성하고, 변경되지 않은 서브트리는 구조적으로 공유한다.

```
Fabric Shadow Tree의 구조적 공유:

  Tree V1          Tree V2 (color만 변경)
  ┌───────┐        ┌───────┐
  │ Root  │        │ Root' │ ←── 새로 생성
  └───┬───┘        └───┬───┘
    ┌─┴──┐           ┌─┴──┐
    │    │           │    │
  ┌─▼─┐┌▼──┐     ┌──▼┐┌─▼──┐
  │ A ││ B │     │ A ││ B' │ ←── 변경된 노드만
  └───┘│red│     └───┘│blue│     새로 생성
       └───┘          └────┘
    ↑                 ↑
    └─────────────────┘
      A는 동일 참조 (구조적 공유)
```

이 불변 구조 덕분에:
1. **동시성 안전**: 여러 스레드가 동시에 트리를 읽어도 안전하다
2. **즉시 롤백**: 트랜잭션 실패 시 이전 트리로 즉시 복원 가능
3. **효율적 비교**: 참조 비교만으로 서브트리 변경 여부를 판단

---

## 5. React ART: 벡터 그래픽 렌더러

React ART는 Canvas와 SVG 위에 벡터 그래픽을 렌더링하는 공식 렌더러다. DOM이나 네이티브 뷰가 아닌 **드로잉 커맨드**를 타겟으로 한다는 점에서 Host Config 구현이 상당히 다르다.

### 5.1 ART의 컴포넌트 모델

```
React ART의 컴포넌트 계층:

  <Surface>              ─── 최상위 캔버스/SVG 컨테이너
    <Group>              ─── 변환(transform) 그룹
      <Shape>            ─── 경로(path) 기반 도형
        d="M10 80 C 40 10, 65 10, 95 80 S 150 150, 180 80"
        fill="blue"
        stroke="red"
      </Shape>
      <Text>             ─── 벡터 텍스트
        font={{ fontSize: 14 }}
        fill="black"
        Hello Vector
      </Text>
    </Group>
  </Surface>
```

### 5.2 Host Config 비교

```javascript
// React ART의 createInstance (개념적)
function createInstance(type, props) {
  switch (type) {
    case 'Group':
      return new GroupNode();         // 변환 행렬을 가진 그룹 노드
    case 'Shape':
      return new ShapeNode(props.d);  // SVG 경로 데이터를 파싱
    case 'Text':
      return new TextNode(props.font); // 폰트 메트릭으로 경로 생성
    default:
      throw new Error('Unknown type: ' + type);
  }
}

// commitUpdate: 경로나 색상 변경 시 다시 그리기
function commitUpdate(instance, updatePayload, type, oldProps, newProps) {
  if (type === 'Shape') {
    if (oldProps.d !== newProps.d) {
      instance.setPath(newProps.d);     // 경로 재설정
    }
    if (oldProps.fill !== newProps.fill) {
      instance.setFill(newProps.fill);  // 채우기 색상 변경
    }
  }
  // Surface에 다시 그리기를 트리거
  instance.markDirty();
}
```

**DOM 렌더러와의 핵심 차이:**

| 관점 | react-dom | React ART |
|------|-----------|-----------|
| 인스턴스 타입 | DOM Element | Drawing Node (JS 객체) |
| 렌더링 타겟 | 브라우저 DOM 트리 | Canvas 2D Context / SVG |
| 업데이트 방식 | 개별 속성 patch | 전체 다시 그리기(redraw) |
| 텍스트 처리 | Text Node | 폰트 경로로 변환 |
| 레이아웃 | 브라우저 레이아웃 엔진 | 수동 좌표 계산 |
| 이벤트 | DOM 이벤트 위임 | 히트 테스트 기반 |

React ART의 가장 독특한 점은 **텍스트를 경로(path)로 변환**한다는 것이다. DOM에서 텍스트는 텍스트 노드로 존재하지만, ART에서는 폰트의 글리프 메트릭을 사용하여 벡터 경로로 렌더링한다. 이것이 ART 렌더러가 `shouldSetTextContent`에서 항상 `false`를 반환하는 이유다 — 텍스트 자식이 있다면 별도의 Text 인스턴스로 처리해야 한다.

---

## 6. React Test Renderer: DOM 없는 테스팅

### 6.1 존재 이유

React Test Renderer는 DOM이나 네이티브 환경 없이 React 컴포넌트를 순수 **JSON 트리**로 렌더링한다. 브라우저 없이 Node.js 환경에서 컴포넌트의 출력을 검증할 수 있게 해준다.

```javascript
import TestRenderer from 'react-test-renderer';

const renderer = TestRenderer.create(
  <div className="container">
    <h1>Hello</h1>
    <button onClick={() => {}}>Click</button>
  </div>
);

console.log(renderer.toJSON());
// {
//   type: 'div',
//   props: { className: 'container' },
//   children: [
//     { type: 'h1', props: {}, children: ['Hello'] },
//     { type: 'button', props: { onClick: [Function] }, children: ['Click'] }
//   ]
// }
```

### 6.2 Host Config 구현

Test Renderer의 Host Config은 모든 렌더러 중 가장 단순하다. 실제 플랫폼 API 호출이 전혀 없고, 순수 JavaScript 객체만 조작한다.

```javascript
// React Test Renderer의 Host Config (개념적)

function createInstance(type, props, rootContainerInstance, hostContext, fiber) {
  return {
    type: type,           // 'div', 'span', 'button' 등
    props: props,         // className, onClick 등
    children: [],         // 자식 인스턴스 배열
    rootContainerInstance: rootContainerInstance,
    tag: 'INSTANCE'       // 인스턴스 타입 식별
  };
}

function createTextInstance(text) {
  return {
    text: text,
    tag: 'TEXT'
  };
}

function appendChild(parentInstance, child) {
  var index = parentInstance.children.indexOf(child);
  if (index !== -1) {
    parentInstance.children.splice(index, 1);
  }
  parentInstance.children.push(child);
}

function removeChild(parentInstance, child) {
  var index = parentInstance.children.indexOf(child);
  parentInstance.children.splice(index, 1);
}

function commitUpdate(instance, updatePayload, type, oldProps, newProps) {
  instance.type = type;
  instance.props = newProps;
}

function commitTextUpdate(textInstance, oldText, newText) {
  textInstance.text = newText;
}

// 아무것도 하지 않는 함수들
function prepareForCommit() { return null; }
function resetAfterCommit() {}
function getRootHostContext() { return emptyContext; }
function getChildHostContext() { return emptyContext; }
```

```
Test Renderer vs DOM Renderer의 createInstance 비교:

DOM Renderer:
  createInstance('div', {className: 'box'}, ...)
    │
    ├── validateDOMNesting()      ← DOM 고유 검증
    ├── createElement()           ← document.createElement('div')
    ├── precacheFiberNode()       ← DOM 노드에 Fiber 참조 저장
    └── updateFiberProps()        ← DOM 노드에 props 캐시
    │
    ▼
    HTMLDivElement (실제 DOM 노드)

Test Renderer:
  createInstance('div', {className: 'box'}, ...)
    │
    └── 단순 JS 객체 생성
    │
    ▼
    { type: 'div', props: {className: 'box'}, children: [], tag: 'INSTANCE' }
```

### 6.3 스냅샷 테스팅과 act()

Test Renderer는 두 가지 핵심 테스팅 패턴을 가능하게 한다:

**스냅샷 테스팅**: `toJSON()`으로 렌더 결과를 직렬화하여 이전 스냅샷과 비교한다.

```javascript
import TestRenderer from 'react-test-renderer';

function Link({ page, children }) {
  return <a href={page}>{children}</a>;
}

test('Link renders correctly', () => {
  const tree = TestRenderer.create(
    <Link page="https://react.dev">React</Link>
  ).toJSON();

  expect(tree).toMatchSnapshot();
  // 저장된 스냅샷:
  // {
  //   type: 'a',
  //   props: { href: 'https://react.dev' },
  //   children: ['React']
  // }
});
```

**act() 유틸리티**: 상태 업데이트와 렌더링이 완전히 완료될 때까지 기다린 후 어서션을 실행한다.

```javascript
import TestRenderer, { act } from 'react-test-renderer';

function Counter() {
  const [count, setCount] = React.useState(0);
  return (
    <button onClick={() => setCount(c => c + 1)}>
      {count}
    </button>
  );
}

test('Counter increments', () => {
  let renderer;

  act(() => {
    renderer = TestRenderer.create(<Counter />);
  });

  const button = renderer.root.findByType('button');
  expect(button.children).toEqual(['0']);

  act(() => {
    button.props.onClick();  // 상태 업데이트 트리거
  });
  // act() 블록이 끝나면 모든 업데이트가 flushed

  expect(button.children).toEqual(['1']);
});
```

```
act()의 동작 흐름:

  act(() => {
    button.props.onClick();
  })
    │
    ▼
  ┌─────────────────────────┐
  │ 1. 콜백 실행             │
  │    → setState 호출됨     │
  │    → 업데이트 큐에 적재   │
  │                          │
  │ 2. 보류 중인 작업 확인    │
  │    → 스케줄된 작업이 있나? │
  │                          │
  │ 3. 모든 작업 동기 실행    │
  │    → Render Phase 실행   │
  │    → Commit Phase 실행   │
  │    → Effect 실행         │
  │                          │
  │ 4. 추가 작업 확인         │
  │    → 더 이상 없으면 종료  │
  └─────────────────────────┘
    │
    ▼
  어서션 실행 (일관된 상태 보장)
```

`act()`는 사실 Test Renderer뿐 아니라 react-dom/test-utils에도 있다. Reconciler 수준의 스케줄러 통합 기능이기 때문이다. 하지만 Test Renderer 환경에서 특히 중요한 이유는, 브라우저 환경이 없으므로 `requestAnimationFrame`이나 `MessageChannel` 같은 비동기 스케줄링 메커니즘이 없기 때문이다. `act()`가 이 부재를 메꿔준다.

---

## 7. Noop Renderer: Reconciler의 순수 테스트 도구

### 7.1 존재 이유

Noop("No Operation") Renderer는 **아무것도 렌더링하지 않는** 렌더러다. 왜 이런 것이 필요할까?

React 코어 팀이 Reconciler 자체를 테스트하고 벤치마킹하기 위해서다. DOM이나 네이티브 뷰 같은 실제 호스트 환경의 복잡성을 제거하고, Reconciler의 알고리즘(Fiber 트리 구성, Lane 스케줄링, 재조정 로직)만 순수하게 검증할 수 있다.

```javascript
// React 소스 코드의 ReactNoop.js (개념적)
import Reconciler from 'react-reconciler';

const NoopRenderer = Reconciler({
  // 모든 Host Config을 최소한으로 구현

  createInstance(type, props) {
    return { id: instanceCounter++, type, props, children: [] };
  },

  createTextInstance(text) {
    return { id: instanceCounter++, text };
  },

  appendChild(parent, child) {
    parent.children.push(child);
  },

  removeChild(parent, child) {
    var index = parent.children.indexOf(child);
    if (index !== -1) parent.children.splice(index, 1);
  },

  commitUpdate(instance, updatePayload, type, oldProps, newProps) {
    instance.props = newProps;
  },

  // 아무것도 하지 않는 구현들
  prepareForCommit() { return null; },
  resetAfterCommit() {},
  prepareUpdate() { return true; },  // 항상 업데이트 필요하다고 보고
  shouldSetTextContent() { return false; },

  getRootHostContext() { return null; },
  getChildHostContext() { return null; },
  getPublicInstance(inst) { return inst; },

  supportsMutation: true,

  // 스케줄링을 완전히 제어 가능하게 만들기
  now: () => fakeTime,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  scheduleMicrotask: (fn) => Promise.resolve().then(fn),
});
```

### 7.2 테스트에서의 활용

```javascript
// React 내부 테스트 코드 (개념적)
it('reconciles child fibers correctly', () => {
  const root = NoopRenderer.createContainer(rootContainer);

  // 초기 렌더
  NoopRenderer.updateContainer(
    <div>
      <span key="a">A</span>
      <span key="b">B</span>
    </div>,
    root
  );
  NoopRenderer.flushAll();

  expect(rootContainer.children).toEqual([
    { type: 'div', children: [
      { type: 'span', props: { children: 'A' } },
      { type: 'span', props: { children: 'B' } }
    ]}
  ]);

  // 순서 변경 — key 기반 재조정 검증
  NoopRenderer.updateContainer(
    <div>
      <span key="b">B</span>
      <span key="a">A</span>
    </div>,
    root
  );
  NoopRenderer.flushAll();

  // Reconciler가 key를 사용해 이동만 하고 재생성하지 않는지 확인
});
```

**Noop Renderer의 특수 기능:**
- **시간 제어**: `fakeTime`을 수동으로 진행시켜 타이머 기반 로직을 결정론적으로 테스트
- **스케줄링 투명성**: `flushAll()`, `flushSync()`, `flushNumberOfYields()` 같은 API로 스케줄링을 정밀하게 제어
- **Fiber 트리 검사**: 내부 Fiber 트리 구조를 직접 검사하여 Reconciler의 동작을 검증

```
렌더러 스펙트럼 (복잡도 순):

  최소 ◄──────────────────────────────────────► 최대

  Noop      Test        ART       Native     DOM
  Renderer  Renderer   Renderer   Renderer  Renderer
    │          │          │          │         │
    │          │          │          │         ├ 이벤트 위임 시스템
    │          │          │          │         ├ Hydration
    │          │          │          │         ├ 텍스트 선택 보존
    │          │          │          ├─────────┤ 네임스페이스 관리
    │          │          │          ├─────────┤ 멀티스레드 통신
    │          │          ├──────────┤         │ 레이아웃 엔진 통합
    │          │          ├──────────┤         │ 드로잉 커맨드
    │          ├──────────┤          │         │ toJSON 직렬화
    │          ├──────────┤          │         │ 스냅샷 비교
    ├──────────┤          │          │         │ 스케줄링 제어
    ├──────────┤          │          │         │ 시간 제어
    │          │          │          │         │
  순수 JS     순수 JS    Canvas/   네이티브    브라우저
  객체만      객체만     SVG       뷰 계층    DOM
```

---

## 8. 커뮤니티 렌더러: 무한 확장의 세계

React의 렌더러 아키텍처가 진정으로 빛나는 곳은 커뮤니티다. `react-reconciler` 패키지를 직접 사용하여 누구나 커스텀 렌더러를 만들 수 있다.

### 8.1 react-three-fiber: React로 3D 씬을 선언하다

[react-three-fiber](https://github.com/pmndrs/react-three-fiber) (R3F)는 Three.js 위에 React 렌더러를 구축한다. DOM 요소 대신 Three.js 객체(Mesh, Light, Camera 등)를 인스턴스로 사용한다.

```jsx
import { Canvas } from '@react-three/fiber';

function Scene() {
  return (
    <Canvas>
      <ambientLight intensity={0.5} />
      <mesh position={[0, 0, 0]} rotation={[0, Math.PI / 4, 0]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="orange" />
      </mesh>
    </Canvas>
  );
}
```

이 JSX가 DOM 렌더러를 거치지 않고 직접 Three.js 씬 그래프로 변환된다:

```
R3F의 Host Config 매핑:

  JSX                          Three.js
  ────────────────────────────────────────
  <mesh>                  →    new THREE.Mesh()
  <boxGeometry>           →    new THREE.BoxGeometry(1,1,1)
  <meshStandardMaterial>  →    new THREE.MeshStandardMaterial({color:'orange'})
  <ambientLight>          →    new THREE.AmbientLight(0.5)
  <group>                 →    new THREE.Group()
```

```javascript
// R3F의 Host Config (간략화)
const hostConfig = {
  createInstance(type, props, rootContainer) {
    // Three.js 카탈로그에서 생성자 조회
    const target = catalogue[type];
    if (!target) throw new Error(`Unknown element: ${type}`);

    // args prop을 생성자 인자로 전달
    const instance = new target(...(props.args || []));

    // 나머지 props를 Three.js 객체의 속성으로 설정
    applyProps(instance, props);

    return instance;
  },

  appendChild(parent, child) {
    if (child instanceof THREE.Object3D) {
      parent.add(child);          // Three.js의 씬 그래프에 추가
    } else if (child instanceof THREE.BufferGeometry) {
      parent.geometry = child;    // Mesh의 geometry로 설정
    } else if (child instanceof THREE.Material) {
      parent.material = child;    // Mesh의 material로 설정
    }
  },

  removeChild(parent, child) {
    if (child instanceof THREE.Object3D) {
      parent.remove(child);
      child.dispose?.();          // Three.js 리소스 정리
    }
  },

  commitUpdate(instance, updatePayload, type, oldProps, newProps) {
    applyProps(instance, newProps);
    instance.needsUpdate = true;  // Three.js에게 다시 그리라고 알림
  },

  // Three.js에는 텍스트 인스턴스가 없다
  createTextInstance() {
    throw new Error('Text is not allowed in R3F');
  },

  // 호스트 컨텍스트로 부모 Object3D 전달
  getChildHostContext(parentContext, type) {
    return parentContext;
  },
};
```

**R3F의 독창적인 설계 결정들:**

1. **attach 패턴**: Three.js에서 Geometry와 Material은 `add()`가 아니라 속성 할당으로 연결된다. R3F는 `appendChild` 내에서 자식 타입을 확인하여 적절한 연결 방식을 선택한다. 또한 `attach` prop으로 이를 명시적으로 제어할 수 있다:

```jsx
<mesh>
  <boxGeometry attach="geometry" />
  <meshStandardMaterial attach="material" />
</mesh>
```

2. **프레임 루프 통합**: R3F는 자체 `requestAnimationFrame` 루프를 운영하며, React의 Commit 후 자동으로 씬을 다시 렌더링한다. `useFrame` 훅으로 매 프레임 로직을 선언적으로 작성할 수 있다.

3. **이벤트 시스템**: Three.js에는 DOM 이벤트가 없으므로, R3F가 자체 Raycasting 기반 이벤트 시스템을 구현한다. `onClick`, `onPointerOver` 같은 props가 3D 객체에서 작동한다.

### 8.2 react-konva: Canvas 2D 그래픽

[react-konva](https://github.com/konvajs/react-konva)는 Konva.js 캔버스 라이브러리 위에 React 렌더러를 구축한다.

```jsx
import { Stage, Layer, Rect, Circle, Text } from 'react-konva';

function CanvasScene() {
  const [color, setColor] = React.useState('green');

  return (
    <Stage width={500} height={500}>
      <Layer>
        <Rect
          x={20} y={20}
          width={100} height={100}
          fill={color}
          onClick={() => setColor('red')}
        />
        <Circle x={200} y={100} radius={50} fill="blue" />
        <Text x={20} y={150} text="Hello Canvas" fontSize={20} />
      </Layer>
    </Stage>
  );
}
```

```javascript
// react-konva의 Host Config (간략화)
const hostConfig = {
  createInstance(type, props) {
    const NodeClass = Konva[type];          // Konva.Rect, Konva.Circle 등
    const instance = new NodeClass(props);
    return instance;
  },

  appendChild(parent, child) {
    parent.add(child);             // Konva 노드 트리에 추가
    updatePicture(parent);         // Canvas 다시 그리기 트리거
  },

  commitUpdate(instance, updatePayload, type, oldProps, newProps) {
    instance.setAttrs(newProps);   // Konva 속성 일괄 업데이트
    updatePicture(instance);       // Canvas 다시 그리기
  },

  // Konva는 자체 이벤트 시스템이 있으므로 props에서 이벤트 핸들러를 연결
  finalizeInitialChildren(instance, type, props) {
    // onClick, onMouseEnter 등을 Konva 이벤트로 변환
    bindEvents(instance, props);
    return false;
  },
};
```

### 8.3 ink: 터미널에서 React를

[ink](https://github.com/vadimdemedes/ink)는 React를 사용하여 터미널 UI를 구축하는 렌더러다. DOM 대신 ANSI 이스케이프 코드로 터미널에 그린다.

```jsx
import React, { useState, useEffect } from 'react';
import { render, Text, Box, useInput } from 'ink';

function Counter() {
  const [count, setCount] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setCount(c => c + 1);
    if (key.downArrow) setCount(c => c - 1);
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="green">Counter: {count}</Text>
      <Text dimColor>Use arrow keys to change</Text>
    </Box>
  );
}

render(<Counter />);
```

```
ink의 렌더링 파이프라인:

  React 컴포넌트
       │
       ▼
  Fiber 트리 (Reconciler)
       │
       ▼
  ink Host Config
  ┌─────────────────────────────┐
  │ createInstance('Box', ...)  │
  │  → { yogaNode, style, ... }│
  │                             │
  │ Yoga 레이아웃 엔진으로       │
  │ Flexbox 레이아웃 계산        │
  └──────────┬──────────────────┘
             │
             ▼
  터미널 출력 버퍼
  ┌─────────────────────────────┐
  │ ANSI 이스케이프 코드 생성    │
  │ \x1b[32m  (초록색)          │
  │ \x1b[1;1H (커서 이동)       │
  │ 텍스트 출력                  │
  └─────────────────────────────┘
             │
             ▼
  process.stdout.write()
```

ink의 독특한 점:
- **Yoga 레이아웃**: 브라우저처럼 Flexbox 레이아웃을 사용하지만, CSS가 아닌 Yoga (C++ 레이아웃 엔진)로 계산한다
- **diff 기반 출력**: 전체 화면을 매번 다시 그리지 않고, 변경된 영역만 업데이트한다
- **stdin 이벤트**: 키보드 입력을 `useInput` 훅으로 처리한다

### 8.4 react-pdf: 선언적 PDF 생성

[react-pdf](https://github.com/diegomura/react-pdf)는 React 컴포넌트로 PDF 문서를 생성한다.

```jsx
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

const styles = StyleSheet.create({
  page: { padding: 30 },
  title: { fontSize: 24, marginBottom: 10 },
  text: { fontSize: 12, lineHeight: 1.5 },
});

function MyDocument() {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View>
          <Text style={styles.title}>React PDF Report</Text>
          <Text style={styles.text}>
            This PDF was generated using React components.
          </Text>
        </View>
      </Page>
    </Document>
  );
}
```

```javascript
// react-pdf의 Host Config (개념적)
const hostConfig = {
  createInstance(type, props) {
    switch (type) {
      case 'PAGE':     return new PageNode(props);
      case 'VIEW':     return new ViewNode(props);
      case 'TEXT':     return new TextNode(props);
      case 'IMAGE':    return new ImageNode(props);
      case 'LINK':     return new LinkNode(props);
      default: throw new Error(`Unknown type: ${type}`);
    }
  },

  // PDF는 일회성 렌더링이므로 업데이트 로직이 단순
  commitUpdate(instance, updatePayload, type, oldProps, newProps) {
    instance.update(newProps);
  },

  // 최종 출력: PDF 바이너리 생성
  // (resetAfterCommit에서 PDF 직렬화를 트리거할 수 있음)
  resetAfterCommit(container) {
    container.render();  // 트리 → PDF 바이너리 변환
  },
};
```

### 8.5 react-figma: 디자인 도구 통합

[react-figma](https://github.com/react-figma/react-figma)는 Figma 플러그인에서 React로 디자인을 생성한다.

```jsx
import { Page, Frame, Rectangle, Text } from 'react-figma';

function Design() {
  return (
    <Page name="Main">
      <Frame name="Card" style={{ width: 300, height: 200 }}>
        <Rectangle
          style={{ width: 300, height: 200 }}
          fills={[{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]}
          cornerRadius={8}
        />
        <Text
          style={{ fontSize: 16, fontWeight: 'bold' }}
          characters="Hello from React"
        />
      </Frame>
    </Page>
  );
}
```

### 8.6 커뮤니티 렌더러 비교표

| 렌더러 | 타겟 환경 | createInstance 반환값 | 트리 조작 방식 | 이벤트 시스템 |
|--------|----------|---------------------|---------------|-------------|
| react-dom | 브라우저 | DOM Element | `appendChild/removeChild` | 이벤트 위임 |
| React Native | iOS/Android | Shadow Node | Bridge/JSI | 네이티브 이벤트 |
| react-three-fiber | WebGL | Three.js Object3D | `add/remove` | Raycasting |
| react-konva | Canvas 2D | Konva Node | `add/remove` + redraw | 히트 테스트 |
| ink | 터미널 | Yoga Node + 스타일 | 노드 트리 + ANSI 출력 | stdin 키 이벤트 |
| react-pdf | PDF 파일 | PDF 노드 | 트리 조립 → 직렬화 | 없음 (정적 출력) |
| react-figma | Figma 플러그인 | Figma 노드 | Figma API 호출 | 없음 (디자인 도구) |
| React ART | Canvas/SVG | Drawing Node | 드로잉 커맨드 | 히트 테스트 |
| Noop | 없음 | JS 객체 | 배열 조작 | 없음 |
| Test Renderer | 없음 | JS 객체 | 배열 조작 | 없음 (수동 호출) |

---

## 9. 커스텀 렌더러 만들기: 최소 구현

`react-reconciler`를 사용하여 커스텀 렌더러를 만드는 최소 코드를 살펴보자. 이를 통해 Host Config의 필수 요소가 무엇인지 실감할 수 있다.

```javascript
import Reconciler from 'react-reconciler';

// ─── Host Config 정의 ──────────────────────────────

const hostConfig = {

  // ★ 필수: 인스턴스 생성
  createInstance(type, props, rootContainer, hostContext, fiber) {
    return { type, props, children: [] };
  },

  createTextInstance(text, rootContainer, hostContext, fiber) {
    return { text };
  },

  // ★ 필수: 트리 조작 (Mutation 모드)
  appendInitialChild(parent, child) {
    parent.children.push(child);
  },

  appendChild(parent, child) {
    parent.children.push(child);
  },

  appendChildToContainer(container, child) {
    container.children.push(child);
  },

  removeChild(parent, child) {
    const idx = parent.children.indexOf(child);
    if (idx !== -1) parent.children.splice(idx, 1);
  },

  removeChildFromContainer(container, child) {
    const idx = container.children.indexOf(child);
    if (idx !== -1) container.children.splice(idx, 1);
  },

  insertBefore(parent, child, beforeChild) {
    const idx = parent.children.indexOf(beforeChild);
    parent.children.splice(idx, 0, child);
  },

  insertInContainerBefore(container, child, beforeChild) {
    const idx = container.children.indexOf(beforeChild);
    container.children.splice(idx, 0, child);
  },

  // ★ 필수: 업데이트
  prepareUpdate(instance, type, oldProps, newProps) {
    return newProps;  // 모든 변경을 업데이트로 처리
  },

  commitUpdate(instance, updatePayload, type, oldProps, newProps) {
    instance.props = newProps;
  },

  commitTextUpdate(textInstance, oldText, newText) {
    textInstance.text = newText;
  },

  // ★ 필수: 컨텍스트와 설정
  getRootHostContext() { return {}; },
  getChildHostContext() { return {}; },
  getPublicInstance(instance) { return instance; },
  shouldSetTextContent() { return false; },
  finalizeInitialChildren() { return false; },

  // ★ 필수: Commit 라이프사이클
  prepareForCommit() { return null; },
  resetAfterCommit() {},
  clearContainer(container) { container.children = []; },

  // ★ 필수: 스케줄링
  supportsMutation: true,       // Mutation 모드 사용
  isPrimaryRenderer: true,
  supportsPersistence: false,
  supportsHydration: false,

  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  scheduleMicrotask: queueMicrotask,

  getCurrentEventPriority() { return 0b0000000000000000000000000010000; }, // DefaultEventPriority
  getInstanceFromNode() { return null; },
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},
  prepareScopeUpdate() {},
  getInstanceFromScope() { return null; },
  detachDeletedInstance() {},

  preparePortalMount() {},
  resetTextContent() {},
  commitMount() {},
  hideInstance() {},
  unhideInstance() {},
  hideTextInstance() {},
  unhideTextInstance() {},
};

// ─── Reconciler 인스턴스 생성 ──────────────────────

const MyReconciler = Reconciler(hostConfig);

// ─── 렌더 함수 정의 ────────────────────────────────

function render(element, container) {
  // container가 이미 root를 가지고 있는지 확인
  if (!container._rootContainer) {
    container._rootContainer = MyReconciler.createContainer(
      container, 0, null, false, false, '', console.error
    );
  }

  MyReconciler.updateContainer(element, container._rootContainer, null, null);
  return container;
}

// ─── 사용 ──────────────────────────────────────────

const root = { children: [] };
render(
  React.createElement('div', { className: 'app' },
    React.createElement('h1', null, 'Hello'),
    React.createElement('p', null, 'Custom Renderer!')
  ),
  root
);

console.log(JSON.stringify(root, null, 2));
// {
//   "children": [{
//     "type": "div",
//     "props": { "className": "app", "children": [...] },
//     "children": [
//       { "type": "h1", "props": {...}, "children": [{ "text": "Hello" }] },
//       { "type": "p", "props": {...}, "children": [{ "text": "Custom Renderer!" }] }
//     ]
//   }]
// }
```

이 최소 구현만으로도 React의 전체 기능(hooks, state, context, Suspense 등)이 작동한다. Reconciler가 모든 복잡성을 처리하고, 렌더러는 순수한 출력 레이어 역할만 하기 때문이다.

```
커스텀 렌더러에서 "공짜로" 얻는 것들:

  ┌─ Reconciler가 제공 ──────────────────────┐
  │                                           │
  │  ✓ useState, useEffect, useContext ...    │
  │  ✓ Fiber 기반 재조정 (key 매칭)           │
  │  ✓ Lane 기반 우선순위 스케줄링             │
  │  ✓ Suspense, ErrorBoundary               │
  │  ✓ Concurrent Features (useTransition)   │
  │  ✓ Context API                            │
  │  ✓ Ref 관리                               │
  │  ✓ 배치 업데이트                           │
  │                                           │
  └───────────────────────────────────────────┘

  ┌─ 렌더러가 구현해야 하는 것 ───────────────┐
  │                                           │
  │  ◆ 인스턴스 생성 (createInstance)          │
  │  ◆ 트리 조작 (appendChild 등)             │
  │  ◆ 속성 업데이트 (commitUpdate)            │
  │  ◆ 이벤트 시스템 (필요 시)                 │
  │  ◆ 레이아웃 (필요 시)                      │
  │                                           │
  └───────────────────────────────────────────┘
```

---

## 10. 렌더러 간 상호운용: Portal과 다중 렌더러

### 10.1 같은 앱에서 여러 렌더러 사용

React는 하나의 앱에서 여러 렌더러를 동시에 사용하는 것을 지원한다. 가장 흔한 예가 react-dom과 react-three-fiber의 조합이다:

```jsx
function App() {
  const [color, setColor] = useState('orange');

  return (
    <div>                                {/* ← react-dom이 렌더링 */}
      <button onClick={() => setColor('blue')}>
        Change Color
      </button>
      <Canvas>                           {/* ← R3F가 렌더링 */}
        <mesh>
          <boxGeometry />
          <meshStandardMaterial color={color} />
        </mesh>
      </Canvas>
    </div>
  );
}
```

이것이 가능한 이유는 `<Canvas>` 컴포넌트가 내부적으로 별도의 Reconciler 인스턴스를 생성하기 때문이다:

```
다중 렌더러 구조:

  ┌─── react-dom Fiber 트리 ───────────────────────┐
  │                                                 │
  │  FiberRoot (dom)                                │
  │    └─ <div>                                     │
  │         ├─ <button>                             │
  │         │    └─ "Change Color"                  │
  │         └─ <Canvas>  ◄── 이 컴포넌트 내부에서    │
  │              │           R3F Reconciler 생성     │
  └──────────────┼──────────────────────────────────┘
                 │
                 │  context/state 공유 (React 코어 통해)
                 │
  ┌──────────────▼──────────────────────────────────┐
  │  FiberRoot (r3f)                                │
  │    └─ <Scene>         ◄── R3F Fiber 트리        │
  │         └─ <mesh>                               │
  │              ├─ <boxGeometry>                    │
  │              └─ <meshStandardMaterial>           │
  └─────────────────────────────────────────────────┘
```

Host Config의 `isPrimaryRenderer` 플래그가 이 시나리오에서 중요한 역할을 한다:

- `isPrimaryRenderer: true` — react-dom. Hooks의 dispatcher를 제어한다.
- `isPrimaryRenderer: false` — R3F 같은 보조 렌더러. 기본 렌더러의 dispatcher를 존중한다.

### 10.2 Portal: 렌더러 경계를 넘는 렌더링

react-dom의 Portal은 Fiber 트리의 위치와 DOM 트리의 위치를 분리한다:

```javascript
// react-dom.development.js, Line 11476
function preparePortalMount(portalInstance) {
  listenToAllSupportedEvents(portalInstance);
}
```

Portal 컨테이너에 이벤트 리스닝을 설정하는 이 한 줄이 핵심이다. Fiber 트리에서는 Portal의 자식이 부모 밑에 있으므로 이벤트가 Fiber 트리를 따라 버블링되지만, DOM에서는 완전히 다른 위치에 렌더링된다. `preparePortalMount`가 새로운 DOM 컨테이너에서도 이벤트를 캡처할 수 있게 보장한다.

```
Portal의 이중 트리 구조:

  Fiber 트리 (논리적)           DOM 트리 (물리적)
  ─────────────────            ─────────────────
  <App>                        <body>
    <div>                        <div id="root">
      <Modal>                      <div>
        <Portal>                     (Modal은 여기 없음!)
          <div>Dialog</div>        </div>
        </Portal>                </div>
      </Modal>                   <div id="modal-root">
    </div>                         <div>Dialog</div>  ◄─ 여기에 렌더링
  </App>                         </div>
                               </body>

  이벤트 버블링:
  <div>Dialog</div>에서 클릭 →
    Fiber 트리를 따라 <Modal> → <div> → <App>으로 버블링
    (DOM 트리의 #modal-root → body 경로가 아님!)
```

---

## 11. 아키텍처 인사이트: 왜 이 설계인가

### 11.1 관심사 분리의 실용적 이점

React의 Reconciler-Renderer 분리는 교과서적 관심사 분리가 아니라, 실용적 필요에서 비롯되었다.

**1. 플랫폼 확장성**: React Native가 존재할 수 있는 이유다. 2015년에 React 팀이 "Reconciler를 분리하면 네이티브 모바일에서도 React를 쓸 수 있다"고 판단했고, 이 결정이 React 생태계를 웹을 넘어 확장시켰다.

**2. 테스트 용이성**: Noop Renderer와 Test Renderer가 존재할 수 있는 이유다. DOM이나 네이티브 환경 없이 Reconciler 로직을 순수하게 테스트할 수 있다.

**3. 혁신 속도**: Fabric이 Bridge를 대체할 때, Reconciler 코드는 거의 변경하지 않았다. Host Config 구현만 교체하면 되었기 때문이다.

### 11.2 두 단계 업데이트의 보편성

모든 렌더러에서 반복되는 패턴이 하나 있다: `prepareUpdate`(Render Phase)와 `commitUpdate`(Commit Phase)의 분리다.

```
보편적 2단계 업데이트 패턴:

  ┌── Render Phase (중단 가능) ──┐   ┌── Commit Phase (동기) ──┐
  │                               │   │                         │
  │  "무엇이 변경되었는지 계산"    │ → │  "변경을 실제로 적용"    │
  │                               │   │                         │
  │  DOM:  diffProperties()       │   │  DOM:  updateProperties()│
  │  R3F:  diff Three.js attrs    │   │  R3F:  applyProps()     │
  │  Konva: diff Konva attrs      │   │  Konva: setAttrs()      │
  │  ink:  diff Yoga props        │   │  ink:  reflow + render  │
  │  PDF:  diff node props        │   │  PDF:  node.update()    │
  │                               │   │                         │
  └───────────────────────────────┘   └─────────────────────────┘

  이 분리가 중요한 이유:
  - Render Phase는 Concurrent Mode에서 중단/재시작될 수 있음
  - 부수효과(실제 뷰 변경)는 Commit Phase에서만 발생해야 함
  - 이 계약을 지키는 한, 어떤 렌더러든 동시성을 "공짜로" 얻음
```

### 11.3 Host Config의 설계 원칙

react-dom.development.js를 분석하면서 발견한 Host Config의 설계 원칙을 정리하면:

**최소 인터페이스 원칙**: 렌더러가 구현해야 하는 메서드를 최소화한다. `prepareForCommit`이나 `resetAfterCommit` 같은 함수는 대부분의 렌더러에서 빈 구현이다. DOM 렌더러에서만 텍스트 선택 보존이라는 특수한 요구사항이 있을 뿐이다.

**모드 선택 원칙**: `supportsMutation`과 `supportsPersistence` 플래그로 렌더러가 자신의 호스트 환경에 맞는 모드를 선택한다. 모든 렌더러가 두 모드를 다 구현할 필요가 없다.

**점진적 복잡성 원칙**: Hydration(`supportsHydration`), Persistence(`supportsPersistence`) 같은 고급 기능은 선택적이다. 기본 Mutation 모드만 구현해도 완전히 작동하는 렌더러를 만들 수 있다.

---

## 12. 전체 렌더러 아키텍처 조감도

```
┌─────────────────────────────────────────────────────────────────────┐
│                         사용자 코드                                 │
│  function App() { return <div><h1>Hello</h1></div>; }              │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ JSX → React.createElement()
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        React Core (react)                           │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌────────────────────┐ │
│  │createElement│ │  Hooks   │ │  Context  │ │ ReactSharedInternals│ │
│  └───────────┘ └───────────┘ └───────────┘ └────────────────────┘ │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ React Element
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   React Reconciler (react-reconciler)               │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Render Phase                                                  │  │
│  │  ┌──────────┐  ┌───────────┐  ┌────────────────────────┐    │  │
│  │  │beginWork │──│reconcile  │──│ prepareUpdate          │    │  │
│  │  │          │  │Children   │  │ (Host Config 호출)     │    │  │
│  │  └──────────┘  └───────────┘  └────────────────────────┘    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Commit Phase                                                  │  │
│  │  ┌────────────────┐  ┌──────────────┐  ┌─────────────────┐  │  │
│  │  │beforeMutation  │──│ mutation     │──│ layout          │  │  │
│  │  │                │  │commitUpdate  │  │commitMount      │  │  │
│  │  │prepareForCommit│  │appendChild   │  │resetAfterCommit │  │  │
│  │  │(Host Config)   │  │removeChild   │  │(Host Config)    │  │  │
│  │  │                │  │(Host Config) │  │                 │  │  │
│  │  └────────────────┘  └──────────────┘  └─────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌── Host Config Interface ─────────────────────────────────────┐  │
│  │ createInstance | appendChild | commitUpdate | prepareForCommit│  │
│  │ createTextInstance | removeChild | commitTextUpdate | ...     │  │
│  └──────────┬──────────┬──────────┬──────────┬──────────┬───────┘  │
└─────────────┼──────────┼──────────┼──────────┼──────────┼──────────┘
              │          │          │          │          │
     ┌────────▼───┐ ┌───▼────┐ ┌──▼───┐ ┌───▼────┐ ┌──▼──────────┐
     │ react-dom  │ │ Native │ │ ART  │ │ Test   │ │ 커뮤니티     │
     │            │ │        │ │      │ │Renderer│ │ R3F, ink,   │
     │ DOM API    │ │ JSI +  │ │Canvas│ │ JSON   │ │ Konva, PDF, │
     │ 이벤트 위임 │ │ Fabric │ │ SVG  │ │ 트리   │ │ Figma, ...  │
     └────────────┘ └────────┘ └──────┘ └────────┘ └─────────────┘
           │            │          │         │            │
           ▼            ▼          ▼         ▼            ▼
       브라우저     iOS/Android  벡터     테스트      무한한
        DOM        네이티브 뷰   그래픽    어서션      가능성
```

---

## 정리

React의 다중 렌더러 아키텍처는 단순한 플러그인 시스템이 아니다. 이것은 **선언적 프로그래밍 모델을 모든 출력 타겟에 적용할 수 있게 하는 범용 추상화**다.

react-dom.development.js의 10862행부터 시작되는 Host Config 함수들은 이 추상화의 DOM 구현체다. `createInstance`가 `document.createElement`를 호출하고, `appendChild`가 `parentNode.appendChild`를 호출하고, `commitUpdate`가 `updateProperties`를 호출하는 — 이 단순한 매핑이 React와 브라우저를 연결한다.

같은 자리에 Three.js의 `new Mesh()`를 넣으면 3D 렌더러가 되고, Konva의 `new Rect()`를 넣으면 Canvas 렌더러가 되고, 단순 JS 객체를 넣으면 테스트 렌더러가 된다. Reconciler의 Fiber 트리 구성, Lane 스케줄링, hooks 시스템, Suspense, Concurrent Features — 이 모든 것이 렌더러에 "공짜로" 따라온다.

이것이 React가 단순한 UI 라이브러리를 넘어, **범용 선언적 런타임**으로 진화한 핵심 설계 결정이다.

---

> **시리즈 네비게이션**
> - 이전 글: React 아키텍처 심층 분석 12편
> - 다음 글: React 아키텍처 심층 분석 14편 (시리즈 마무리)
