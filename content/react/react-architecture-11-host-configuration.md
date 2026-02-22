# React 18 Host Configuration 소스 코드 분석

> 시리즈: React 아키텍처 심층 분석 - 11편
> 분석 대상: react-dom@18.3.1 — react-dom.development.js (29,923 lines)
> 소스 경로: `node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/cjs/`

---

## 들어가며

React가 "한 번 배우면 어디서든 쓴다(Learn Once, Write Anywhere)"를 달성할 수 있는 비밀은 **Host Configuration** 추상화 계층에 있다. Reconciler는 Virtual DOM 트리의 diff를 계산하지만, 실제로 화면에 무언가를 그리는 방법은 전혀 모른다. DOM이 뭔지도, Native View가 뭔지도 모른다. Reconciler가 아는 것은 오직 Host Config 인터페이스 — 즉 **60개 이상의 메서드 시그니처**뿐이다.

이 글에서는 react-dom 18.3.1의 실제 빌드 결과물을 열어 Host Config의 DOM 구현체가 어떻게 생겼는지 한 줄 한 줄 추적한다. 단순히 "createElement를 호출한다"는 수준이 아니라, Fiber 노드와 DOM 노드가 어떻게 양방향으로 연결되는지, diff 결과가 어떤 형태의 updatePayload로 변환되는지, 그리고 Commit Phase에서 이 payload가 어떻게 소비되는지까지 전체 파이프라인을 분석한다.

---

## 1. Host Config란 무엇인가

### 1.1 Reconciler와 Renderer의 경계

React의 아키텍처는 명확한 경계선으로 두 계층을 분리한다:

```
+----------------------------------------------------------+
|                    React Reconciler                       |
|  (Fiber 트리 구축, diff 계산, Effect 스케줄링)              |
|                                                          |
|  "이 노드는 type='div', props={className:'box'}로        |
|   새로 만들어야 해"                                       |
|  "이 노드의 children이 'hello'에서 'world'로 바뀌었어"     |
|                                                          |
+---------------------+------------------------------------+
                      |
            Host Config Interface
          (createInstance, appendChild,
           prepareUpdate, commitUpdate, ...)
                      |
+---------------------v------------------------------------+
|                    Host Renderer                         |
|                                                          |
|  react-dom    : document.createElement('div')            |
|  react-native : UIManager.createView(...)                |
|  react-three  : new THREE.Mesh(...)                      |
|  ink          : createTextNode(text)                     |
|                                                          |
+----------------------------------------------------------+
```

Reconciler는 플랫폼에 대해 아무것도 모른다. `createInstance`라는 함수를 호출하면 "어떤 인스턴스"가 반환된다는 것만 안다. 그 인스턴스가 `HTMLDivElement`인지 `UIView`인지 `THREE.Mesh`인지는 Renderer의 구현에 달려있다.

### 1.2 Fork 시스템: 빌드 타임 주입

React 소스 코드(GitHub)에서 Reconciler는 Host Config 함수들을 제네릭 임포트로 참조한다:

```
// React 소스 코드의 Reconciler 내부 (원본)
import {
  createInstance,
  createTextInstance,
  appendChild,
  ...
} from './ReactFiberHostConfig';
```

`ReactFiberHostConfig`는 실제 파일이 아니다. **빌드 시점에** 대상 플랫폼의 구현체로 교체(fork)된다:

```
ReactFiberHostConfig
    |
    +-- react-dom 빌드    --> ReactDOMHostConfig (DOM API)
    +-- react-native 빌드 --> ReactFabricHostConfig (Fabric)
    +-- react-test 빌드   --> ReactTestHostConfig (JSON 트리)
    +-- react-art 빌드    --> ReactARTHostConfig (Canvas/SVG)
```

react-dom의 프로덕션 빌드에서는 이 fork가 이미 해소되어 있다. 우리가 분석하는 `react-dom.development.js`는 29,923줄의 단일 파일로, Reconciler 코드와 DOM Host Config 코드가 하나로 번들링되어 있다. 따라서 `createInstance` 같은 함수가 파일 내에서 직접 정의되어 있고, Reconciler가 이를 직접 호출하는 형태를 볼 수 있다.

### 1.3 모드 플래그

Host Config는 단순히 메서드만 제공하는 것이 아니다. 렌더러가 어떤 "모드"를 지원하는지 선언하는 플래그도 포함한다. react-dom의 경우 빌드 결과물에 이 플래그들이 상수로 인라인되어 있다:

| 플래그                | react-dom 값 | 의미                          |
|----------------------|-------------|-------------------------------|
| `supportsMutation`   | `true`      | DOM 노드를 직접 변경(mutate)     |
| `supportsPersistence`| `false`     | 불변 트리를 매번 새로 생성하지 않음  |
| `supportsHydration`  | `true`      | SSR HTML에서 재활용 가능          |
| `supportsMicrotasks` | (암묵적)     | queueMicrotask 사용 가능        |

react-dom은 **Mutation Mode** 렌더러다. 기존 DOM 노드를 직접 수정한다. 반면 React Native의 Fabric은 **Persistence Mode**를 사용해 불변 Shadow Tree를 매번 새로 구성한다. Reconciler 내부에서 이 플래그에 따라 완전히 다른 코드 경로를 타게 된다:

```javascript
// L21769 — Mutation mode 분기
{
  // Mutation mode
  appendAllChildren = function (parent, workInProgress, ...) {
    var node = workInProgress.child;
    while (node !== null) {
      if (node.tag === HostComponent || node.tag === HostText) {
        appendInitialChild(parent, node.stateNode);
      } else if (node.tag === HostPortal) {
        // Portal은 건너뜀
      } else if (node.child !== null) {
        node.child.return = node;
        node = node.child;
        continue;
      }
      // ... sibling 순회
    }
  };
}
```

이 코드 블록은 `supportsMutation`이 `true`인 경우에만 존재하는 Mutation Mode 전용 구현이다. Persistence Mode에서는 완전히 다른 `appendAllChildren`가 정의된다(clone + append 방식).

---

## 2. DOM 노드와 Fiber의 양방향 연결

Host Config에서 가장 핵심적이면서도 간과되기 쉬운 부분이 **DOM 노드와 Fiber 노드의 양방향 연결**이다.

### 2.1 Internal Key 시스템

```javascript
// L11479-11485
var randomKey = Math.random().toString(36).slice(2);
var internalInstanceKey = '__reactFiber$' + randomKey;
var internalPropsKey = '__reactProps$' + randomKey;
var internalContainerInstanceKey = '__reactContainer$' + randomKey;
var internalEventHandlersKey = '__reactEvents$' + randomKey;
var internalEventHandlerListenersKey = '__reactListeners$' + randomKey;
```

페이지가 로드될 때마다 **랜덤 키**가 생성되고, 이 키를 접미사로 사용해 DOM 노드에 프로퍼티를 심는다. 왜 랜덤일까? 같은 페이지에서 여러 React 인스턴스가 동시에 돌아갈 수 있기 때문이다. 각 React 인스턴스가 고유한 키를 가져야 DOM 노드에서 올바른 Fiber를 찾을 수 있다.

실제 DOM 노드를 브라우저 DevTools에서 열어보면 이런 프로퍼티를 직접 확인할 수 있다:

```
<div class="my-component">
  __reactFiber$abc123: FiberNode { tag: 5, type: "div", ... }
  __reactProps$abc123: { className: "my-component", onClick: f }
  __reactEvents$abc123: Set(3) { ... }
```

### 2.2 precacheFiberNode — Fiber를 DOM에 심기

```javascript
// L11496
function precacheFiberNode(hostInst, node) {
  node[internalInstanceKey] = hostInst;
}
```

단 한 줄이다. DOM 노드의 `__reactFiber$xxx` 프로퍼티에 Fiber 인스턴스를 할당한다. 이 함수는 다음 시점에 호출된다:

1. **createInstance** (L10942) — 새 DOM 노드 생성 시
2. **createTextInstance** (L10989) — 텍스트 노드 생성 시
3. **hydrateInstance** (L11292) — SSR HTML을 재활용할 때
4. **hydrateTextInstance** (L11309) — SSR 텍스트 노드 재활용 시
5. **hydrateSuspenseInstance** (L11316) — Suspense 경계 재활용 시

모든 경로에서 빠짐없이 Fiber를 DOM에 연결한다.

### 2.3 updateFiberProps — Props를 DOM에 심기

```javascript
// L11630
function updateFiberProps(node, props) {
  node[internalPropsKey] = props;
}
```

역시 단 한 줄. DOM 노드의 `__reactProps$xxx`에 현재 props 객체를 저장한다. 호출 시점:

1. **createInstance** (L10943) — 초기 생성
2. **commitUpdate** (L11050) — 업데이트 커밋 시
3. **hydrateInstance** (L11295) — hydration 시

왜 props를 DOM에 저장할까? **이벤트 시스템** 때문이다. React 18의 이벤트 위임 시스템은 document 레벨에서 이벤트를 캡처한 뒤, `event.target`의 DOM 노드에서 `__reactProps$xxx`를 읽어 해당 컴포넌트의 이벤트 핸들러를 찾는다. 이것이 없으면 이벤트 버블링 시뮬레이션이 불가능하다.

### 2.4 getClosestInstanceFromNode — DOM에서 Fiber 찾기 (역방향)

```javascript
// L11515
function getClosestInstanceFromNode(targetNode) {
  var targetInst = targetNode[internalInstanceKey];

  if (targetInst) {
    return targetInst;
  }

  // DOM 트리를 올라가며 React 소유 노드 탐색
  var parentNode = targetNode.parentNode;

  while (parentNode) {
    targetInst = parentNode[internalContainerInstanceKey]
              || parentNode[internalInstanceKey];

    if (targetInst) {
      // dehydrated Suspense 경계 처리...
      var alternate = targetInst.alternate;
      if (targetInst.child !== null ||
          (alternate !== null && alternate.child !== null)) {
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

이 함수는 이벤트 핸들링의 시작점이다. 클릭 이벤트가 발생하면:

```
DOM 이벤트 발생
    |
    v
event.target (DOM 노드)
    |
    v
getClosestInstanceFromNode(event.target)
    |
    v
Fiber 노드 획득
    |
    v
__reactProps$xxx 에서 onClick 핸들러 추출
    |
    v
Synthetic Event 생성 + 핸들러 실행
```

주목할 점은 **dehydrated Suspense 경계를 별도로 처리**한다는 것이다. SSR로 전달된 HTML 중 아직 hydrate되지 않은 부분에서 이벤트가 발생하면, Suspense 경계의 Comment 노드까지 추적해 올라가야 한다.

### 2.5 양방향 연결 전체 그림

```
Fiber Tree                            DOM Tree
==========                            ========

FiberNode (div)                       <div>
  tag: 5 (HostComponent)                __reactFiber$x: ──> FiberNode
  stateNode: ─────────────────────>     __reactProps$x: { className, onClick }
  memoizedProps: { className, ... }     __reactEvents$x: Set(...)
  child: FiberNode (span)               |
    |                                   +── <span>
    v                                        __reactFiber$x: ──> FiberNode (span)
FiberNode (span)                             __reactProps$x: { children: "hello" }
  tag: 5                                     |
  stateNode: ───────────────────────────>    +── "hello"
  child: FiberNode (text)                         __reactFiber$x: ──> FiberNode (text)
    |
    v
FiberNode (text)
  tag: 6 (HostText)
  stateNode: ────────────────────────────────────> TextNode
```

---

## 3. 인스턴스 생성: createInstance와 createTextInstance

### 3.1 createInstance — DOM 엘리먼트 생성

```javascript
// L10924
function createInstance(type, props, rootContainerInstance,
                        hostContext, internalInstanceHandle) {
  var parentNamespace;

  {
    // DEV 모드: DOM 중첩 규칙 검증
    var hostContextDev = hostContext;
    validateDOMNesting(type, null, hostContextDev.ancestorInfo);

    if (typeof props.children === 'string' ||
        typeof props.children === 'number') {
      var string = '' + props.children;
      var ownAncestorInfo = updatedAncestorInfo(
        hostContextDev.ancestorInfo, type
      );
      validateDOMNesting(null, string, ownAncestorInfo);
    }

    parentNamespace = hostContextDev.namespace;
  }

  // 핵심: 실제 DOM 엘리먼트 생성
  var domElement = createElement(
    type, props, rootContainerInstance, parentNamespace
  );

  // Fiber <-> DOM 양방향 연결
  precacheFiberNode(internalInstanceHandle, domElement);
  updateFiberProps(domElement, props);

  return domElement;
}
```

이 함수의 시그니처를 분해하면:

| 파라미터                   | 의미                      | 예시                    |
|--------------------------|--------------------------|------------------------|
| `type`                   | HTML 태그명               | `"div"`, `"span"`      |
| `props`                  | React props              | `{ className: "box" }` |
| `rootContainerInstance`  | 루트 DOM 컨테이너          | `document.getElementById('root')` |
| `hostContext`            | 부모로부터 전달된 컨텍스트    | `{ namespace, ancestorInfo }` |
| `internalInstanceHandle` | 이 노드의 Fiber           | `FiberNode`            |

반환값은 **실제 DOM 엘리먼트**다. 이 반환값이 Fiber의 `stateNode`에 저장된다.

### 3.2 createElement — 실제 DOM API 호출

```javascript
// L9743
function createElement(type, props, rootContainerElement, parentNamespace) {
  var isCustomComponentTag;
  var ownerDocument = getOwnerDocumentFromRootContainer(rootContainerElement);
  var domElement;
  var namespaceURI = parentNamespace;

  if (namespaceURI === HTML_NAMESPACE) {
    namespaceURI = getIntrinsicNamespace(type);
  }

  if (namespaceURI === HTML_NAMESPACE) {
    // HTML 네임스페이스인 경우
    if (type === 'script') {
      // script 태그 특수 처리: innerHTML로 생성해 parser-inserted 플래그 설정
      var div = ownerDocument.createElement('div');
      div.innerHTML = '<script><' + '/script>';
      var firstChild = div.firstChild;
      domElement = div.removeChild(firstChild);
    } else if (typeof props.is === 'string') {
      // Web Components의 is 속성 지원
      domElement = ownerDocument.createElement(type, { is: props.is });
    } else {
      domElement = ownerDocument.createElement(type);

      // select 엘리먼트 특수 처리
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
    // SVG, MathML 등 비-HTML 네임스페이스
    domElement = ownerDocument.createElementNS(namespaceURI, type);
  }

  return domElement;
}
```

흥미로운 디테일:
- **script 태그**는 `innerHTML`을 통해 생성한다. `document.createElement('script')`로 만들면 parser-inserted 플래그가 `false`가 되어 즉시 실행될 수 있기 때문이다.
- **select 태그**는 `option` 자식이 삽입되기 전에 `multiple`과 `size`를 먼저 설정해야 한다. 그렇지 않으면 브라우저가 첫 번째 option을 자동 선택하는 버그가 발생한다 (GitHub issue #13222, #14239).
- **SVG 엘리먼트**는 `createElementNS`로 생성한다. `hostContext`의 namespace 정보가 이를 위해 존재한다.

### 3.3 createTextInstance — 텍스트 노드 생성

```javascript
// L10982
function createTextInstance(text, rootContainerInstance,
                            hostContext, internalInstanceHandle) {
  {
    var hostContextDev = hostContext;
    validateDOMNesting(null, text, hostContextDev.ancestorInfo);
  }

  var textNode = createTextNode(text, rootContainerInstance);
  precacheFiberNode(internalInstanceHandle, textNode);
  return textNode;
}

// L9823
function createTextNode(text, rootContainerElement) {
  return getOwnerDocumentFromRootContainer(rootContainerElement)
    .createTextNode(text);
}
```

텍스트 노드는 단순하다. `document.createTextNode()`를 호출하고 Fiber를 연결한다. 주의할 점은 `updateFiberProps`는 호출하지 않는다는 것이다. 텍스트 노드에는 props가 없고, 텍스트 내용 자체가 Fiber의 `memoizedProps`에 직접 저장된다.

### 3.4 shouldSetTextContent — 텍스트 최적화 판단

```javascript
// L10980
function shouldSetTextContent(type, props) {
  return type === 'textarea' ||
    type === 'noscript' ||
    typeof props.children === 'string' ||
    typeof props.children === 'number' ||
    typeof props.dangerouslySetInnerHTML === 'object' &&
      props.dangerouslySetInnerHTML !== null &&
      props.dangerouslySetInnerHTML.__html != null;
}
```

이 함수는 Reconciler가 자식 노드를 처리하기 전에 호출된다. `true`를 반환하면 **별도의 텍스트 Fiber를 만들지 않고** 부모 엘리먼트에 직접 `textContent`를 설정한다. `<div>hello</div>`에서 "hello"를 위해 별도의 텍스트 Fiber를 만들 필요가 없다는 최적화다.

---

## 4. Host Context: 조상 정보의 전파

### 4.1 getRootHostContext — 루트 컨텍스트 생성

```javascript
// L10862
function getRootHostContext(rootContainerInstance) {
  var type;
  var namespace;
  var nodeType = rootContainerInstance.nodeType;

  switch (nodeType) {
    case DOCUMENT_NODE:        // 9
    case DOCUMENT_FRAGMENT_NODE: // 11
      type = nodeType === DOCUMENT_NODE ? '#document' : '#fragment';
      var root = rootContainerInstance.documentElement;
      namespace = root ? root.namespaceURI
                       : getChildNamespace(null, '');
      break;

    default:
      var container = nodeType === COMMENT_NODE
        ? rootContainerInstance.parentNode
        : rootContainerInstance;
      var ownNamespace = container.namespaceURI || null;
      type = container.tagName;
      namespace = getChildNamespace(ownNamespace, type);
      break;
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

DOM 렌더러에서 Host Context는 두 가지 정보를 담는다:

1. **namespace** — HTML, SVG, MathML 중 어느 네임스페이스인지. `<svg>` 내부에서 `<div>`를 만들면 `createElementNS`를 사용해야 하기 때문에 필수적이다.
2. **ancestorInfo** (DEV only) — 조상 태그 정보. `<p>` 안에 `<div>`를 넣는 것 같은 잘못된 DOM 중첩을 경고하기 위해 사용한다.

### 4.2 getChildHostContext — 컨텍스트 전파

```javascript
// L10896
function getChildHostContext(parentHostContext, type, rootContainerInstance) {
  {
    var parentHostContextDev = parentHostContext;
    var namespace = getChildNamespace(parentHostContextDev.namespace, type);
    var ancestorInfo = updatedAncestorInfo(
      parentHostContextDev.ancestorInfo, type
    );
    return {
      namespace: namespace,
      ancestorInfo: ancestorInfo
    };
  }
}
```

트리를 내려갈 때마다 namespace를 갱신한다. 예를 들어:

```
<div>                    namespace: HTML
  <svg>                  namespace: SVG  (HTML -> SVG 전환)
    <foreignObject>      namespace: SVG
      <div>              namespace: HTML (SVG -> HTML 복귀)
```

이 컨텍스트 전파가 없으면 SVG 내부의 `<rect>`를 `document.createElement('rect')`로 만들어 아무것도 렌더링되지 않는 치명적인 버그가 발생한다.

---

## 5. Commit 준비: prepareForCommit / resetAfterCommit

### 5.1 커밋 전 환경 보존

```javascript
// L10910
function prepareForCommit(containerInfo) {
  eventsEnabled = isEnabled();
  selectionInformation = getSelectionInformation();
  var activeInstance = null;

  setEnabled(false);
  return activeInstance;
}
```

Commit Phase가 시작되기 전에 두 가지를 수행한다:

1. **이벤트 비활성화** — `setEnabled(false)`로 DOM 변경 중 이벤트가 발생하는 것을 방지. DOM을 조작하는 도중에 `focus`, `blur` 같은 이벤트가 발생하면 예측 불가능한 상태가 된다.
2. **선택 정보 저장** — 사용자가 텍스트를 드래그 선택한 상태에서 React가 DOM을 업데이트하면 선택이 사라진다. 커밋 전에 `getSelectionInformation()`으로 현재 선택 범위를 저장해두고, 커밋 후에 복원한다.

### 5.2 커밋 후 환경 복원

```javascript
// L10918
function resetAfterCommit(containerInfo) {
  restoreSelection(selectionInformation);
  setEnabled(eventsEnabled);
  eventsEnabled = null;
  selectionInformation = null;
}
```

저장했던 선택 정보를 복원하고, 이벤트를 다시 활성화한다. 사용자는 React가 DOM을 변경하는 동안 텍스트 선택이 사라지는 현상을 경험하지 않는다.

---

## 6. 초기 속성 설정: setInitialProperties

`createInstance`가 빈 DOM 엘리먼트를 만들면, `finalizeInitialChildren`이 호출되어 속성을 설정한다:

```javascript
// L10952
function finalizeInitialChildren(domElement, type, props,
                                  rootContainerInstance, hostContext) {
  setInitialProperties(domElement, type, props, rootContainerInstance);

  switch (type) {
    case 'button':
    case 'input':
    case 'select':
    case 'textarea':
      return !!props.autoFocus;
    case 'img':
      return true;
    default:
      return false;
  }
}
```

반환값이 `true`이면 Reconciler가 `Update` 이펙트를 스케줄링하고, Commit Phase에서 `commitMount`가 호출된다. `autoFocus`를 가진 input이나 `src`를 가진 img가 이에 해당한다.

### 6.1 setInitialProperties 내부

```javascript
// L9826
function setInitialProperties(domElement, tag, rawProps, rootContainerElement) {
  var isCustomComponentTag = isCustomComponent(tag, rawProps);
  var props;

  switch (tag) {
    case 'dialog':
      listenToNonDelegatedEvent('cancel', domElement);
      listenToNonDelegatedEvent('close', domElement);
      props = rawProps;
      break;

    case 'iframe': case 'object': case 'embed':
      listenToNonDelegatedEvent('load', domElement);
      props = rawProps;
      break;

    case 'video': case 'audio':
      for (var i = 0; i < mediaEventTypes.length; i++) {
        listenToNonDelegatedEvent(mediaEventTypes[i], domElement);
      }
      props = rawProps;
      break;

    case 'img': case 'image': case 'link':
      listenToNonDelegatedEvent('error', domElement);
      listenToNonDelegatedEvent('load', domElement);
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

  assertValidProps(tag, props);
  setInitialDOMProperties(tag, domElement, rootContainerElement,
                           props, isCustomComponentTag);

  // 후처리: input/textarea의 controlled component 초기화
  switch (tag) {
    case 'input':
      track(domElement);
      postMountWrapper(domElement, rawProps, false);
      break;
    case 'textarea':
      track(domElement);
      postMountWrapper$3(domElement);
      break;
    // ...
  }
}
```

여기서 볼 수 있는 핵심 패턴:

1. **Non-delegated 이벤트 등록** — 대부분의 이벤트는 root에 위임(delegate)하지만, `load`, `error`, `cancel`, `close`, `invalid` 같은 이벤트는 버블링하지 않아서 각 엘리먼트에 직접 등록해야 한다.

2. **Controlled Component 초기화** — `input`, `select`, `textarea`는 React의 controlled component 패턴을 위한 래퍼 로직이 별도로 존재한다.

### 6.2 setInitialDOMProperties — 개별 프로퍼티 설정

```javascript
// L9670
function setInitialDOMProperties(tag, domElement, rootContainerElement,
                                  nextProps, isCustomComponentTag) {
  for (var propKey in nextProps) {
    if (!nextProps.hasOwnProperty(propKey)) continue;
    var nextProp = nextProps[propKey];

    if (propKey === STYLE) {
      setValueForStyles(domElement, nextProp);
    } else if (propKey === DANGEROUSLY_SET_INNER_HTML) {
      var nextHtml = nextProp ? nextProp[HTML$1] : undefined;
      if (nextHtml != null) {
        setInnerHTML(domElement, nextHtml);
      }
    } else if (propKey === CHILDREN) {
      if (typeof nextProp === 'string') {
        var canSetTextContent = tag !== 'textarea' || nextProp !== '';
        if (canSetTextContent) {
          setTextContent(domElement, nextProp);
        }
      } else if (typeof nextProp === 'number') {
        setTextContent(domElement, '' + nextProp);
      }
    } else if (propKey === SUPPRESS_CONTENT_EDITABLE_WARNING ||
               propKey === SUPPRESS_HYDRATION_WARNING) {
      // 무시
    } else if (propKey === AUTOFOCUS) {
      // 무시 (commitMount에서 처리)
    } else if (registrationNameDependencies.hasOwnProperty(propKey)) {
      // 이벤트 핸들러는 여기서 설정하지 않음
      // (이벤트 위임 시스템이 __reactProps에서 읽어감)
      if (propKey === 'onScroll') {
        listenToNonDelegatedEvent('scroll', domElement);
      }
    } else if (nextProp != null) {
      setValueForProperty(domElement, propKey, nextProp, isCustomComponentTag);
    }
  }
}
```

주목: **이벤트 핸들러(`onClick` 등)는 DOM attribute로 설정하지 않는다.** React 18의 이벤트 시스템은 root에 이벤트를 위임하고, 이벤트 발생 시 `__reactProps$xxx`에서 핸들러를 읽는다. 따라서 `onClick`을 만나면 그냥 넘어간다. 예외는 `onScroll`뿐인데, scroll 이벤트는 버블링하지 않아서 직접 등록해야 한다.

---

## 7. Props Diffing: prepareUpdate와 diffProperties

### 7.1 prepareUpdate — Render Phase에서의 diff

업데이트 시 Reconciler는 Render Phase(completeWork)에서 `prepareUpdate`를 호출한다:

```javascript
// L10966
function prepareUpdate(domElement, type, oldProps, newProps,
                        rootContainerInstance, hostContext) {
  {
    var hostContextDev = hostContext;
    if (typeof newProps.children !== typeof oldProps.children &&
        (typeof newProps.children === 'string' ||
         typeof newProps.children === 'number')) {
      var string = '' + newProps.children;
      var ownAncestorInfo = updatedAncestorInfo(
        hostContextDev.ancestorInfo, type
      );
      validateDOMNesting(null, string, ownAncestorInfo);
    }
  }

  return diffProperties(domElement, type, oldProps, newProps);
}
```

핵심은 `diffProperties`의 반환값이다. 이것이 바로 **updatePayload** — Fiber의 `updateQueue`에 저장되는 변경 사항 목록이다.

### 7.2 diffProperties — 세밀한 diff 엔진

```javascript
// L9956
function diffProperties(domElement, tag, lastRawProps, nextRawProps,
                          rootContainerElement) {
  var updatePayload = null;
  var lastProps;
  var nextProps;

  // 폼 엘리먼트는 controlled wrapper를 통해 변환
  switch (tag) {
    case 'input':
      lastProps = getHostProps(domElement, lastRawProps);
      nextProps = getHostProps(domElement, nextRawProps);
      updatePayload = [];
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
      if (typeof lastProps.onClick !== 'function' &&
          typeof nextProps.onClick === 'function') {
        trapClickOnNonInteractiveElement(domElement);
      }
      break;
  }

  var propKey;
  var styleName;
  var styleUpdates = null;

  // 1단계: 삭제된 props 탐지
  for (propKey in lastProps) {
    if (nextProps.hasOwnProperty(propKey) ||
        !lastProps.hasOwnProperty(propKey) ||
        lastProps[propKey] == null) {
      continue;
    }
    // 삭제된 prop -> [propKey, null]
    if (propKey === STYLE) {
      var lastStyle = lastProps[propKey];
      for (styleName in lastStyle) {
        if (lastStyle.hasOwnProperty(styleName)) {
          if (!styleUpdates) styleUpdates = {};
          styleUpdates[styleName] = '';
        }
      }
    } else {
      (updatePayload = updatePayload || []).push(propKey, null);
    }
  }

  // 2단계: 추가/변경된 props 탐지
  for (propKey in nextProps) {
    var nextProp = nextProps[propKey];
    var lastProp = lastProps != null ? lastProps[propKey] : undefined;

    if (!nextProps.hasOwnProperty(propKey) ||
        nextProp === lastProp ||
        (nextProp == null && lastProp == null)) {
      continue;
    }

    if (propKey === STYLE) {
      // 스타일은 개별 속성 단위로 diff
      if (lastProp) {
        for (styleName in lastProp) {
          if (lastProp.hasOwnProperty(styleName) &&
              (!nextProp || !nextProp.hasOwnProperty(styleName))) {
            if (!styleUpdates) styleUpdates = {};
            styleUpdates[styleName] = '';
          }
        }
        for (styleName in nextProp) {
          if (nextProp.hasOwnProperty(styleName) &&
              lastProp[styleName] !== nextProp[styleName]) {
            if (!styleUpdates) styleUpdates = {};
            styleUpdates[styleName] = nextProp[styleName];
          }
        }
      } else {
        styleUpdates = nextProp;
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
      // 이벤트 핸들러가 변경되면 빈 updatePayload라도 반환
      if (!updatePayload && lastProp !== nextProp) {
        updatePayload = [];
      }
    } else {
      (updatePayload = updatePayload || []).push(propKey, nextProp);
    }
  }

  if (styleUpdates) {
    (updatePayload = updatePayload || []).push(STYLE, styleUpdates);
  }

  return updatePayload;
}
```

**updatePayload의 형태**: `[key1, value1, key2, value2, ...]` — 플랫 배열이다.

예를 들어 `className`이 `"a"`에서 `"b"`로 바뀌고, `style.color`가 `"red"`에서 `"blue"`로 바뀌면:

```javascript
updatePayload = [
  'className', 'b',
  'style', { color: 'blue' }
]
```

이 구조의 장점:
- **메모리 효율**: 오브젝트 대신 플랫 배열 사용
- **순회 효율**: `i += 2`로 키-값 쌍 순회
- **lazy 생성**: 변경이 없으면 `null` 반환 (커밋 불필요)

### 7.3 이벤트 핸들러의 특수 처리

```javascript
if (registrationNameDependencies.hasOwnProperty(propKey)) {
  if (!updatePayload && lastProp !== nextProp) {
    updatePayload = [];  // 빈 배열!
  }
}
```

이벤트 핸들러(`onClick`, `onChange` 등)가 변경되면 `updatePayload`에 키-값을 추가하지 않고 **빈 배열만 반환**한다. 왜? 이벤트 핸들러는 DOM attribute가 아니라 `__reactProps$xxx`에서 읽기 때문이다. 하지만 `commitUpdate`가 호출되어야 `updateFiberProps`로 최신 props가 DOM에 저장된다. 빈 배열이라도 truthy이므로 `commitUpdate`가 트리거된다.

---

## 8. Commit Phase: 실제 DOM 변경

Render Phase에서 계산된 변경 사항이 Commit Phase에서 실제 DOM에 반영된다.

### 8.1 commitUpdate — 속성 변경 적용

```javascript
// L11045
function commitUpdate(domElement, updatePayload, type,
                       oldProps, newProps, internalInstanceHandle) {
  // 1. diff를 DOM에 적용
  updateProperties(domElement, updatePayload, type, oldProps, newProps);

  // 2. __reactProps 갱신 (이벤트 시스템용)
  updateFiberProps(domElement, newProps);
}
```

단 두 줄이다. `updateProperties`가 실제 DOM 속성을 변경하고, `updateFiberProps`가 이벤트 시스템이 참조할 최신 props를 갱신한다.

### 8.2 updateProperties — updatePayload 소비

```javascript
// L10132
function updateProperties(domElement, updatePayload, tag,
                            lastRawProps, nextRawProps) {
  // radio input은 checked를 name보다 먼저 업데이트
  if (tag === 'input' && nextRawProps.type === 'radio' &&
      nextRawProps.name != null) {
    updateChecked(domElement, nextRawProps);
  }

  var wasCustomComponentTag = isCustomComponent(tag, lastRawProps);
  var isCustomComponentTag = isCustomComponent(tag, nextRawProps);

  // updatePayload 배열을 순회하며 DOM 변경
  updateDOMProperties(domElement, updatePayload,
                       wasCustomComponentTag, isCustomComponentTag);

  // 폼 엘리먼트 후처리
  switch (tag) {
    case 'input':
      updateWrapper(domElement, nextRawProps);
      break;
    case 'textarea':
      updateWrapper$1(domElement, nextRawProps);
      break;
    case 'select':
      postUpdateWrapper(domElement, nextRawProps);
      break;
  }
}
```

### 8.3 updateDOMProperties — 최종 DOM 조작

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
      setValueForProperty(domElement, propKey, propValue,
                           isCustomComponentTag);
    }
  }
}
```

`i += 2` 패턴으로 `[key, value, key, value, ...]` 배열을 소비한다. 각 prop 타입에 따라 다른 DOM API를 호출한다:

```
propKey          -->  DOM API
-------               -------
'style'          -->  domElement.style[name] = value
'dangerouslySet' -->  domElement.innerHTML = value
'children'       -->  domElement.textContent = value
기타 속성         -->  domElement.setAttribute(name, value)
                      또는 domElement[name] = value
```

### 8.4 commitTextUpdate — 텍스트 변경

```javascript
// L11055
function commitTextUpdate(textInstance, oldText, newText) {
  textInstance.nodeValue = newText;
}
```

한 줄. `textNode.nodeValue`를 직접 변경한다.

### 8.5 commitMount — 마운트 후처리

```javascript
// L11017
function commitMount(domElement, type, newProps, internalInstanceHandle) {
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
      if (newProps.src) {
        domElement.src = newProps.src;
      }
      return;
  }
}
```

`finalizeInitialChildren`이 `true`를 반환한 엘리먼트에 대해서만 호출된다. `autoFocus` 속성이 있는 폼 엘리먼트에 실제 `focus()`를 호출하고, `img` 엘리먼트의 `src`를 설정한다.

---

## 9. DOM 트리 조작: appendChild, insertBefore, removeChild

### 9.1 기본 조작 함수

```javascript
// L11058
function appendChild(parentInstance, child) {
  parentInstance.appendChild(child);
}

// L11087
function insertBefore(parentInstance, child, beforeChild) {
  parentInstance.insertBefore(child, beforeChild);
}

// L11098
function removeChild(parentInstance, child) {
  parentInstance.removeChild(child);
}
```

놀라울 정도로 단순하다. 네이티브 DOM API를 그대로 호출할 뿐이다.

### 9.2 Container 변형 — Portal과 Comment Node 처리

```javascript
// L11061
function appendChildToContainer(container, child) {
  var parentNode;

  if (container.nodeType === COMMENT_NODE) {
    // SSR의 경우 container가 Comment 노드일 수 있다
    parentNode = container.parentNode;
    parentNode.insertBefore(child, container);
  } else {
    parentNode = container;
    parentNode.appendChild(child);
  }

  // Mobile Safari 클릭 이벤트 버블링 버그 우회
  var reactRootContainer = container._reactRootContainer;
  if ((reactRootContainer === null || reactRootContainer === undefined) &&
      parentNode.onclick === null) {
    trapClickOnNonInteractiveElement(parentNode);
  }
}

// L11090
function insertInContainerBefore(container, child, beforeChild) {
  if (container.nodeType === COMMENT_NODE) {
    container.parentNode.insertBefore(child, beforeChild);
  } else {
    container.insertBefore(child, beforeChild);
  }
}

// L11101
function removeChildFromContainer(container, child) {
  if (container.nodeType === COMMENT_NODE) {
    container.parentNode.removeChild(child);
  } else {
    container.removeChild(child);
  }
}
```

Container 변형은 두 가지 추가 처리를 한다:

1. **Comment Node 처리** — SSR에서 root container가 `<!-- -->` Comment 노드인 경우, 부모를 한 단계 올라가서 조작한다.
2. **Mobile Safari 버그 우회** — `trapClickOnNonInteractiveElement`는 빈 `onclick` 핸들러를 설정해 Mobile Safari에서 클릭 이벤트가 버블링되지 않는 버그를 우회한다.

### 9.3 Reconciler에서의 사용: commitPlacement

```javascript
// L23863
function commitPlacement(finishedWork) {
  var parentFiber = getHostParentFiber(finishedWork);

  switch (parentFiber.tag) {
    case HostComponent: {
      var parent = parentFiber.stateNode;

      if (parentFiber.flags & ContentReset) {
        resetTextContent(parent);
        parentFiber.flags &= ~ContentReset;
      }

      var before = getHostSibling(finishedWork);
      insertOrAppendPlacementNode(finishedWork, before, parent);
      break;
    }

    case HostRoot:
    case HostPortal: {
      var _parent = parentFiber.stateNode.containerInfo;
      var _before = getHostSibling(finishedWork);
      insertOrAppendPlacementNodeIntoContainer(
        finishedWork, _before, _parent
      );
      break;
    }
  }
}
```

`commitPlacement`는 `Placement` 이펙트가 있는 Fiber에 대해 호출된다. 부모가 일반 Host Component이면 `insertOrAppendPlacementNode`를, Root/Portal이면 `insertOrAppendPlacementNodeIntoContainer`를 사용한다:

```javascript
// L23944
function insertOrAppendPlacementNode(node, before, parent) {
  var tag = node.tag;
  var isHost = tag === HostComponent || tag === HostText;

  if (isHost) {
    var stateNode = node.stateNode;
    if (before) {
      insertBefore(parent, stateNode, before);
    } else {
      appendChild(parent, stateNode);
    }
  } else if (tag === HostPortal) {
    // Portal은 건너뜀
  } else {
    // Function/Class Component 등은 자식을 재귀 탐색
    var child = node.child;
    if (child !== null) {
      insertOrAppendPlacementNode(child, before, parent);
      var sibling = child.sibling;
      while (sibling !== null) {
        insertOrAppendPlacementNode(sibling, before, parent);
        sibling = sibling.sibling;
      }
    }
  }
}
```

**Function/Class Component는 DOM 노드를 가지지 않으므로**, 재귀적으로 자식을 탐색해 실제 Host Component나 Host Text를 찾아야 한다. 이것이 `getHostSibling`이 복잡한 이유이기도 하다 — Fiber 트리에서 "다음 형제"는 DOM 트리에서의 "다음 형제"와 일치하지 않을 수 있다.

---

## 10. Visibility 관리: hide/unhide

Suspense의 fallback 전환 시 기존 콘텐츠를 숨기고 보여주는 데 사용된다:

```javascript
// L11153
function hideInstance(instance) {
  instance = instance;
  var style = instance.style;

  if (typeof style.setProperty === 'function') {
    style.setProperty('display', 'none', 'important');
  } else {
    style.display = 'none';
  }
}

// L11165
function hideTextInstance(textInstance) {
  textInstance.nodeValue = '';
}

// L11168
function unhideInstance(instance, props) {
  instance = instance;
  var styleProp = props[STYLE$1];
  var display = styleProp !== undefined && styleProp !== null &&
    styleProp.hasOwnProperty('display') ? styleProp.display : null;
  instance.style.display = dangerousStyleValue('display', display);
}

// L11174
function unhideTextInstance(textInstance, text) {
  textInstance.nodeValue = text;
}
```

몇 가지 세심한 처리가 눈에 띈다:

- `hideInstance`는 `display: none !important`를 사용한다. `!important`를 붙이는 이유는 사용자의 인라인 스타일이나 CSS 클래스가 `display`를 설정하고 있더라도 반드시 숨겨야 하기 때문이다.
- `unhideInstance`는 원래 props의 `style.display` 값을 복원한다. 숨기기 전에 `display: flex`였다면 다시 `flex`로 복원해야 한다.
- `hideTextInstance`는 텍스트를 비우고(`''`), `unhideTextInstance`는 원래 텍스트를 복원한다.

---

## 11. Hydration: SSR HTML 재활용

### 11.1 canHydrateInstance — 재활용 가능성 판단

```javascript
// L11186
function canHydrateInstance(instance, type, props) {
  if (instance.nodeType !== ELEMENT_NODE ||
      type.toLowerCase() !== instance.nodeName.toLowerCase()) {
    return null;
  }
  return instance;
}
```

SSR이 생성한 HTML 노드와 React가 만들려는 노드의 태그명이 일치하는지 확인한다. 일치하면 해당 노드를 그대로 재활용한다.

### 11.2 hydrateInstance — 기존 노드 차용

```javascript
// L11291
function hydrateInstance(instance, type, props, rootContainerInstance,
                          hostContext, internalInstanceHandle, shouldWarnDev) {
  // Fiber <-> DOM 양방향 연결
  precacheFiberNode(internalInstanceHandle, instance);
  updateFiberProps(instance, props);

  var parentNamespace;
  {
    var hostContextDev = hostContext;
    parentNamespace = hostContextDev.namespace;
  }

  var isConcurrentMode =
    (internalInstanceHandle.mode & ConcurrentMode) !== NoMode;

  return diffHydratedProperties(
    instance, type, props, parentNamespace,
    rootContainerInstance, isConcurrentMode, shouldWarnDev
  );
}
```

새 DOM 노드를 만드는 대신, SSR이 이미 만들어둔 노드에 Fiber를 연결한다. `diffHydratedProperties`는 서버에서 렌더링한 속성과 클라이언트 props를 비교해 불일치(mismatch)를 감지하고 경고를 출력한다.

### 11.3 hydration 순회 도우미

```javascript
// L11279
function getNextHydratableSibling(instance) {
  return getNextHydratable(instance.nextSibling);
}

function getFirstHydratableChild(parentInstance) {
  return getNextHydratable(parentInstance.firstChild);
}

function getNextHydratable(node) {
  for (; node != null; node = node.nextSibling) {
    var nodeType = node.nodeType;

    if (nodeType === ELEMENT_NODE || nodeType === TEXT_NODE) {
      break;
    }

    if (nodeType === COMMENT_NODE) {
      var nodeData = node.data;
      if (nodeData === SUSPENSE_START_DATA ||
          nodeData === SUSPENSE_FALLBACK_START_DATA ||
          nodeData === SUSPENSE_PENDING_START_DATA) {
        break;
      }
      if (nodeData === SUSPENSE_END_DATA) {
        return null;
      }
    }
  }
  return node;
}
```

SSR HTML에는 React가 삽입한 Comment 노드들이 있다 (`<!--$-->`, `<!--/$-->` 등). `getNextHydratable`은 Element, Text, Suspense Comment만 hydration 대상으로 인식하고 나머지는 건너뛴다.

---

## 12. completeWork에서의 Host Config 호출 흐름

Reconciler의 `completeWork` 함수(L22103)에서 Host Config 함수들이 어떤 순서로 호출되는지 정리하면:

### 12.1 새 HostComponent 마운트

```
completeWork (HostComponent, current === null)
    |
    +-- popHydrationState()  -- hydration 모드인지 확인
    |
    +-- createInstance(type, newProps, rootContainer, hostContext, fiber)
    |       |
    |       +-- createElement(type, props, rootContainer, namespace)
    |       +-- precacheFiberNode(fiber, domElement)
    |       +-- updateFiberProps(domElement, props)
    |
    +-- appendAllChildren(instance, workInProgress)
    |       |
    |       +-- 자식 Fiber를 순회하며 appendInitialChild(parent, child.stateNode)
    |
    +-- workInProgress.stateNode = instance  -- Fiber에 DOM 노드 저장
    |
    +-- finalizeInitialChildren(instance, type, newProps, rootContainer)
            |
            +-- setInitialProperties(domElement, type, props, rootContainer)
            |       |
            |       +-- setInitialDOMProperties(...)  -- 각 prop을 DOM에 적용
            |
            +-- return !!props.autoFocus  -- true이면 markUpdate
```

### 12.2 기존 HostComponent 업데이트

```
completeWork (HostComponent, current !== null)
    |
    +-- updateHostComponent$1(current, workInProgress, type, newProps, rootContainer)
            |
            +-- oldProps === newProps?  -- 참조 동일하면 bailout
            |
            +-- prepareUpdate(instance, type, oldProps, newProps, rootContainer, hostContext)
            |       |
            |       +-- diffProperties(domElement, type, oldProps, newProps)
            |       +-- return updatePayload  // [key, val, key, val, ...] 또는 null
            |
            +-- workInProgress.updateQueue = updatePayload
            |
            +-- if (updatePayload) markUpdate(workInProgress)
```

### 12.3 새 HostText 마운트

```
completeWork (HostText, current === null)
    |
    +-- createTextInstance(newText, rootContainer, hostContext, fiber)
    |       |
    |       +-- document.createTextNode(text)
    |       +-- precacheFiberNode(fiber, textNode)
    |
    +-- workInProgress.stateNode = textNode
```

### 12.4 기존 HostText 업데이트

```
completeWork (HostText, current !== null)
    |
    +-- if (oldText !== newText) markUpdate(workInProgress)
```

텍스트 업데이트는 diff가 필요 없다. 단순 문자열 비교로 변경 여부만 판단한다.

---

## 13. Commit Phase에서의 Host Config 호출 흐름

commitMutationEffectsOnFiber(L24320)에서의 흐름:

### 13.1 HostComponent 커밋

```
commitMutationEffectsOnFiber (HostComponent)
    |
    +-- recursivelyTraverseMutationEffects()  -- 자식 먼저
    |
    +-- commitReconciliationEffects()
    |       |
    |       +-- if (Placement) commitPlacement()
    |               |
    |               +-- insertOrAppendPlacementNode()
    |                       |
    |                       +-- appendChild() 또는 insertBefore()
    |
    +-- if (ContentReset) resetTextContent(instance)
    |
    +-- if (Update && updatePayload !== null)
            |
            +-- commitUpdate(instance, updatePayload, type, oldProps, newProps)
                    |
                    +-- updateProperties(domElement, updatePayload, ...)
                    |       |
                    |       +-- updateDOMProperties(domElement, updatePayload, ...)
                    |               |
                    |               +-- setValueForStyles / setInnerHTML /
                    |                   setTextContent / setValueForProperty
                    |
                    +-- updateFiberProps(domElement, newProps)
```

### 13.2 HostText 커밋

```
commitMutationEffectsOnFiber (HostText)
    |
    +-- recursivelyTraverseMutationEffects()
    |
    +-- commitReconciliationEffects()
    |
    +-- if (Update)
            |
            +-- commitTextUpdate(textInstance, oldText, newText)
                    |
                    +-- textInstance.nodeValue = newText
```

---

## 14. clearContainer와 기타 유틸리티

```javascript
// L11177
function clearContainer(container) {
  if (container.nodeType === ELEMENT_NODE) {
    container.textContent = '';
  } else if (container.nodeType === DOCUMENT_NODE) {
    if (container.documentElement) {
      container.removeChild(container.documentElement);
    }
  }
}
```

`clearContainer`는 React root의 기존 내용을 비울 때 사용한다. `container.textContent = ''`는 모든 자식을 한 번에 제거하는 가장 빠른 방법이다.

```javascript
// L10907
function getPublicInstance(instance) {
  return instance;
}
```

DOM에서는 public instance와 internal instance가 동일하다. `ref.current`에 할당되는 값이 바로 DOM 노드 그 자체다. React Native에서는 이 함수가 Native View의 public API만 노출하도록 래핑한다.

---

## 15. 스케줄링 인프라

Host Config는 타이밍 관련 API도 제공한다:

```javascript
// L11008-11014
var scheduleTimeout = typeof setTimeout === 'function'
  ? setTimeout : undefined;
var cancelTimeout = typeof clearTimeout === 'function'
  ? clearTimeout : undefined;
var noTimeout = -1;

var localPromise = typeof Promise === 'function' ? Promise : undefined;

var scheduleMicrotask = typeof queueMicrotask === 'function'
  ? queueMicrotask
  : typeof localPromise !== 'undefined'
    ? function (callback) {
        return localPromise.resolve(null)
          .then(callback)
          .catch(handleErrorInNextTick);
      }
    : scheduleTimeout;
```

Reconciler가 마이크로태스크를 스케줄링해야 할 때 이 함수들을 사용한다. 환경에 따라 `queueMicrotask` -> `Promise.resolve().then()` -> `setTimeout` 순으로 폴백한다.

```javascript
// L10994
function getCurrentEventPriority() {
  var currentEvent = window.event;

  if (currentEvent === undefined) {
    return DefaultEventPriority;
  }

  return getEventPriority(currentEvent.type);
}
```

이벤트 우선순위 결정도 Host Config의 몫이다. DOM에서는 `window.event`를 통해 현재 처리 중인 이벤트 타입을 알아내고, 이를 React의 우선순위 시스템(Lane)으로 매핑한다.

---

## 16. 커스텀 렌더러: react-reconciler 패키지

이 모든 Host Config 인터페이스를 직접 구현하면 **나만의 렌더러**를 만들 수 있다. `react-reconciler` npm 패키지가 이를 위해 공개되어 있다:

```javascript
// 커스텀 렌더러 구현 예시 (개념적)
import Reconciler from 'react-reconciler';

const HostConfig = {
  // === 필수 메서드 ===
  createInstance(type, props, rootContainer, hostContext, fiber) {
    // 플랫폼 인스턴스 생성
    return { type, props, children: [] };
  },

  createTextInstance(text, rootContainer, hostContext, fiber) {
    return { text };
  },

  appendInitialChild(parent, child) {
    parent.children.push(child);
  },

  appendChild(parent, child) {
    parent.children.push(child);
  },

  removeChild(parent, child) {
    const idx = parent.children.indexOf(child);
    parent.children.splice(idx, 1);
  },

  insertBefore(parent, child, beforeChild) {
    const idx = parent.children.indexOf(beforeChild);
    parent.children.splice(idx, 0, child);
  },

  prepareUpdate(instance, type, oldProps, newProps) {
    // 변경 사항 계산
    return shallowDiff(oldProps, newProps);
  },

  commitUpdate(instance, updatePayload, type, oldProps, newProps) {
    instance.props = newProps;
  },

  commitTextUpdate(textInstance, oldText, newText) {
    textInstance.text = newText;
  },

  // === 모드 플래그 ===
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,

  // === 컨텍스트 ===
  getRootHostContext() { return {}; },
  getChildHostContext() { return {}; },

  // === 기타 필수 ===
  getPublicInstance(instance) { return instance; },
  prepareForCommit() { return null; },
  resetAfterCommit() {},
  finalizeInitialChildren() { return false; },
  shouldSetTextContent() { return false; },
  clearContainer() {},

  // === 스케줄링 ===
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  scheduleMicrotask: queueMicrotask,
  getCurrentEventPriority() { return DefaultEventPriority; },

  // ... 총 60+ 메서드
};

const MyRenderer = Reconciler(HostConfig);
```

### 16.1 실제 커스텀 렌더러 사례

| 렌더러              | 타겟 플랫폼       | Host Instance        |
|--------------------|-----------------|---------------------|
| **react-dom**      | 브라우저 DOM      | `HTMLElement`        |
| **react-native**   | iOS/Android     | Shadow Node (Fabric) |
| **react-three-fiber** | WebGL (Three.js) | `THREE.Object3D`  |
| **ink**            | 터미널 CLI        | Text Box 노드        |
| **react-konva**    | 2D Canvas       | `Konva.Shape`        |
| **react-pdf**      | PDF 문서          | PDF Page/Text 노드   |
| **react-figma**    | Figma 플러그인    | Figma Scene Node     |

이들 모두 같은 `react-reconciler`를 사용하고, Host Config만 다르게 구현한다. React의 상태 관리, hooks, Suspense, Concurrent Mode 같은 기능을 공짜로 얻는다.

---

## 17. 렌더러 비교: Mutation vs Persistence

### 17.1 Mutation Mode (react-dom)

```
Render Phase                          Commit Phase
==========                            ============

prepareUpdate()                       commitUpdate()
  -> diffProperties()                   -> updateProperties()
  -> return updatePayload                  -> domElement.setAttribute(...)
                                           -> domElement.style.color = ...

                                      commitPlacement()
                                        -> parentNode.appendChild(child)
                                        -> parentNode.insertBefore(child, before)

                                      commitDeletion()
                                        -> parentNode.removeChild(child)
```

기존 DOM 노드를 직접 변경(mutate)한다.

### 17.2 Persistence Mode (React Native Fabric, 개념적)

```
Render Phase                          Commit Phase
==========                            ============

cloneInstance(instance, newProps)      replaceContainerChildren()
  -> new ShadowNode(...)                -> 전체 트리를 한 번에 교체
  -> return newInstance

cloneHiddenInstance(instance)
  -> clone + hidden flag
```

Persistence Mode에서는 기존 노드를 변경하지 않고 **새 노드를 clone**한다. 불변 데이터 구조와 유사한 방식이다. 전체 트리가 구성된 후 한 번에 네이티브 뷰에 반영한다.

```
Mutation Mode:                    Persistence Mode:

  [A] [B] [C]                      [A] [B] [C]     (이전 트리, 불변)
       |                                |
  B.text = "new"                   [A] [B'] [C]     (B' = clone of B)
  (직접 변경)                       (새 트리 구성 후 한 번에 교체)
```

---

## 18. 전체 Host Config 메서드 카탈로그

react-dom이 구현하는 Host Config 메서드를 카테고리별로 정리하면:

### 인스턴스 생성/관리

| 메서드                        | 라인    | 역할                              |
|------------------------------|--------|----------------------------------|
| `createInstance`             | L10924 | DOM 엘리먼트 생성                    |
| `createTextInstance`         | L10982 | 텍스트 노드 생성                     |
| `appendInitialChild`         | L10947 | 초기 자식 추가                       |
| `finalizeInitialChildren`    | L10952 | 초기 속성 설정, autoFocus 감지        |
| `shouldSetTextContent`       | L10980 | 텍스트 직접 설정 여부 판단             |
| `getPublicInstance`          | L10907 | ref에 노출할 인스턴스 반환             |

### 트리 조작 (Mutation Mode)

| 메서드                            | 라인    | 역할                           |
|----------------------------------|--------|-------------------------------|
| `appendChild`                    | L11058 | 자식 추가                       |
| `appendChildToContainer`         | L11061 | 컨테이너에 자식 추가              |
| `insertBefore`                   | L11087 | 특정 위치에 삽입                  |
| `insertInContainerBefore`        | L11090 | 컨테이너 내 특정 위치에 삽입        |
| `removeChild`                    | L11098 | 자식 제거                       |
| `removeChildFromContainer`       | L11101 | 컨테이너에서 자식 제거             |
| `clearContainer`                 | L11177 | 컨테이너 비우기                  |
| `resetTextContent`               | L11043 | 텍스트 내용 초기화                |

### 커밋 Phase

| 메서드                   | 라인    | 역할                               |
|-------------------------|--------|-----------------------------------|
| `prepareForCommit`      | L10910 | 커밋 전 환경 보존 (이벤트 비활성화 등) |
| `resetAfterCommit`      | L10918 | 커밋 후 환경 복원                    |
| `prepareUpdate`         | L10966 | props diff 계산                    |
| `commitUpdate`          | L11045 | DOM 속성 변경 적용                   |
| `commitTextUpdate`      | L11055 | 텍스트 변경 적용                     |
| `commitMount`           | L11017 | 마운트 후처리 (autoFocus 등)          |

### 컨텍스트

| 메서드                   | 라인    | 역할                             |
|-------------------------|--------|--------------------------------|
| `getRootHostContext`    | L10862 | 루트 컨텍스트 생성 (namespace 등)   |
| `getChildHostContext`   | L10896 | 자식 컨텍스트 전파                  |

### Visibility

| 메서드                   | 라인    | 역할                         |
|-------------------------|--------|------------------------------|
| `hideInstance`          | L11153 | 엘리먼트 숨기기 (display:none)  |
| `hideTextInstance`      | L11165 | 텍스트 숨기기 (nodeValue='')   |
| `unhideInstance`        | L11168 | 엘리먼트 다시 보이기             |
| `unhideTextInstance`    | L11174 | 텍스트 다시 보이기              |

### Hydration

| 메서드                                           | 라인    | 역할                         |
|-------------------------------------------------|--------|------------------------------|
| `canHydrateInstance`                            | L11186 | 재활용 가능 여부 판단            |
| `hydrateInstance`                               | L11291 | 기존 노드에 Fiber 연결          |
| `hydrateTextInstance`                           | L11308 | 기존 텍스트 노드에 Fiber 연결    |
| `getNextHydratableSibling`                      | L11279 | 다음 hydration 대상 탐색        |
| `getFirstHydratableChild`                       | L11282 | 첫 번째 hydration 대상 탐색     |
| `getFirstHydratableChildWithinContainer`        | L11285 | 컨테이너 내 첫 hydration 대상   |
| `getFirstHydratableChildWithinSuspenseInstance` | L11288 | Suspense 내 첫 hydration 대상  |

### Fiber-DOM 브리지

| 메서드/변수                       | 라인    | 역할                               |
|---------------------------------|--------|-----------------------------------|
| `precacheFiberNode`             | L11496 | DOM 노드에 Fiber 참조 저장           |
| `updateFiberProps`              | L11630 | DOM 노드에 props 저장               |
| `getClosestInstanceFromNode`    | L11515 | DOM에서 가장 가까운 Fiber 찾기        |
| `getInstanceFromNode`           | L11598 | DOM에서 정확한 Fiber 찾기            |
| `getNodeFromInstance`           | L11618 | Fiber에서 DOM 노드 찾기             |
| `getFiberCurrentPropsFromNode`  | L11627 | DOM에서 현재 props 읽기              |
| `internalInstanceKey`           | L11481 | `__reactFiber$` + randomKey       |
| `internalPropsKey`              | L11482 | `__reactProps$` + randomKey       |
| `internalContainerInstanceKey`  | L11483 | `__reactContainer$` + randomKey   |
| `internalEventHandlersKey`      | L11484 | `__reactEvents$` + randomKey      |

---

## 19. 전체 파이프라인 시각화

`<div className="a">` 가 `<div className="b">`로 변경될 때 전체 흐름:

```
[1] setState({ className: 'b' })
         |
         v
[2] Scheduler: Lane 할당 + Work 스케줄링
         |
         v
[3] Render Phase: beginWork → reconcileChildren → completeWork
         |
         |  completeWork (HostComponent, current !== null)
         |    |
         |    +-- updateHostComponent$1()
         |          |
         |          +-- prepareUpdate(domElement, 'div',
         |          |     { className: 'a' },
         |          |     { className: 'b' })
         |          |       |
         |          |       +-- diffProperties()
         |          |       +-- return ['className', 'b']
         |          |
         |          +-- workInProgress.updateQueue = ['className', 'b']
         |          +-- markUpdate(workInProgress)
         |                (flags |= Update)
         |
         v
[4] Commit Phase: commitMutationEffectsOnFiber
         |
         |  case HostComponent:
         |    |
         |    +-- if (flags & Update)
         |          |
         |          +-- commitUpdate(domElement,
         |                ['className', 'b'],
         |                'div',
         |                { className: 'a' },
         |                { className: 'b' },
         |                fiber)
         |              |
         |              +-- updateProperties(domElement, ['className', 'b'], ...)
         |              |     |
         |              |     +-- updateDOMProperties(domElement, ['className', 'b'], ...)
         |              |           |
         |              |           +-- setValueForProperty(domElement, 'className', 'b')
         |              |                 |
         |              |                 +-- domElement.setAttribute('class', 'b')
         |              |
         |              +-- updateFiberProps(domElement, { className: 'b' })
         |                    |
         |                    +-- domElement.__reactProps$xxx = { className: 'b' }
         |
         v
[5] 화면에 className="b" 반영 완료
```

---

## 마무리

Host Configuration은 React 아키텍처의 **플랫폼 추상화 계층**이다. 그 설계 원칙을 정리하면:

1. **완전한 분리**: Reconciler는 `createInstance`, `appendChild` 같은 추상 인터페이스만 알고, 구체적인 DOM API는 전혀 모른다. 이 분리 덕분에 동일한 Reconciler 위에 DOM, Native, WebGL, Terminal 등 다양한 렌더러를 구축할 수 있다.

2. **양방향 연결**: DOM 노드에 `__reactFiber$`와 `__reactProps$`를 심어 Fiber 트리와 DOM 트리 사이의 양방향 참조를 유지한다. 이 연결이 이벤트 위임, ref, DevTools 등 모든 것의 기반이다.

3. **2-Phase 커밋**: Render Phase에서 `diffProperties`로 변경 사항을 계산하고(`updatePayload`), Commit Phase에서 `commitUpdate`로 한 번에 적용한다. 계산과 적용의 분리가 Concurrent Mode에서의 중단/재개를 가능하게 한다.

4. **모드 기반 분기**: `supportsMutation`, `supportsPersistence`, `supportsHydration` 플래그로 렌더러의 특성을 선언하면, Reconciler가 해당 모드에 맞는 코드 경로를 선택한다.

5. **빌드 타임 Fork**: 제네릭 import를 빌드 시점에 플랫폼별 구현체로 교체하는 시스템으로, 런타임 오버헤드 없이 다형성을 달성한다.

Host Config 인터페이스를 이해하고 나면 "React가 DOM을 어떻게 조작하는가"에서 한 단계 더 나아가 "React가 *아무 플랫폼이든* 어떻게 조작할 수 있는가"라는 아키텍처적 통찰에 도달하게 된다. 그리고 이것이 바로 React가 단순한 웹 프레임워크를 넘어 범용 UI 런타임으로 자리매김한 근본적인 이유다.

---

> 다음 편 예고: React 18의 이벤트 시스템 — Host Config의 `__reactProps$`에서 시작되는 Synthetic Event의 여정을 추적한다.
