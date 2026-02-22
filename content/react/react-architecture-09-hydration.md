# React 아키텍처 심층 분석 (9/14): Hydration 시스템 -- SSR HTML에 생명을 불어넣는 과정

> 시리즈: React 아키텍처 심층 분석 - 9편
> 분석 대상: React 18.3.1 (react-dom)
> 소스 경로: `node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/cjs/react-dom.development.js`

---

## 들어가며

서버에서 렌더링된 HTML은 사용자에게 빠르게 콘텐츠를 보여주지만, 그 자체로는 "죽은 문서"에 불과하다. 클릭해도 반응하지 않고, 상태 변경이 불가능하며, React가 관리하는 그 어떤 동적 행위도 수행할 수 없다. 이 정적 HTML에 React의 이벤트 시스템, 상태 관리, 재조정(Reconciliation) 기능을 연결하는 과정이 바로 **Hydration**이다.

Hydration은 단순히 이벤트 리스너를 달아주는 것이 아니다. Fiber 트리를 구축하면서 기존 DOM 노드를 "재사용"하고, 서버/클라이언트 간 불일치를 감지하며, Suspense 경계 단위로 점진적(Selective)으로 처리되는 정교한 메커니즘이다. React 18에서는 여기에 이벤트 리플레이와 우선순위 기반 Hydration까지 추가되어 복잡도가 한층 높아졌다.

이 글에서는 `react-dom.development.js` 29,923줄의 소스 코드를 직접 추적하며 다음을 심층 분석한다:

1. `hydrateRoot` 진입점에서 Fiber Root 생성까지의 초기화 흐름
2. Hydration Context가 DOM 트리와 Fiber 트리를 동시에 순회하는 메커니즘
3. Selective Hydration이 사용자 상호작용 우선순위에 따라 동작하는 방식
4. Mismatch 감지/복구의 전략과 Concurrent Mode에서의 차이
5. 이벤트 리플레이 시스템의 큐잉-재생 아키텍처
6. Dehydrated Suspense 경계의 마커 체계와 라이프사이클

---

## 1. hydrateRoot 진입점: SSR HTML에서 Fiber Root까지

### 1.1 hydrateRoot API의 내부 구조

`hydrateRoot`는 React 18에서 도입된 Concurrent Hydration의 진입점이다. `createRoot`와 달리 기존 DOM을 파괴하지 않고 React 트리에 "접합"하는 것이 핵심 차이다.

```
hydrateRoot(container, <App />)
      │
      ▼
createHydrationContainer(...)    ← hydrate = true로 FiberRoot 생성
      │
      ▼
createFiberRoot(...)             ← isDehydrated: true 상태로 초기화
      │
      ▼
scheduleInitialHydrationOnRoot() ← 일반 update와 다른 특수 스케줄링
      │
      ▼
listenToAllSupportedEvents()     ← 이벤트 위임 등록
      │
      ▼
new ReactDOMHydrationRoot(root)  ← 외부에 반환되는 Root 객체
```

실제 소스를 보자. `hydrateRoot` 함수는 line 29440에 정의되어 있다:

```javascript
// line 29440
function hydrateRoot(container, initialChildren, options) {
  if (!isValidContainer(container)) {
    throw new Error('hydrateRoot(...): Target container is not a DOM element.');
  }
  // ... 옵션 파싱 (identifierPrefix, onRecoverableError 등)

  var root = createHydrationContainer(
    initialChildren, null, container, ConcurrentRoot,
    hydrationCallbacks, isStrictMode,
    concurrentUpdatesByDefaultOverride,
    identifierPrefix, onRecoverableError
  );

  markContainerAsRoot(root.current, container);
  listenToAllSupportedEvents(container);  // ← 이벤트 위임 등록

  return new ReactDOMHydrationRoot(root);
}
```

여기서 주목할 점은 세 가지다:

1. **`ConcurrentRoot` 태그**: Hydration은 항상 Concurrent Mode로 동작한다. Legacy `ReactDOM.hydrate()`는 deprecated되었고, 내부적으로 `LegacyRoot`를 사용하지만 같은 경로를 탄다.
2. **`markContainerAsRoot`**: DOM 노드에 `__reactContainer$` 프로퍼티를 설정해서 이후 이벤트 디스패치 시 해당 컨테이너를 React root로 식별할 수 있게 한다.
3. **`listenToAllSupportedEvents`**: Hydration 완료 전이라도 이벤트를 캡처할 수 있도록 미리 이벤트 위임을 등록한다. 이것이 이벤트 리플레이의 전제 조건이다.

### 1.2 createHydrationContainer: hydrate 플래그의 의미

`createHydrationContainer`(line 28826)는 `createContainer`와 거의 동일하지만 결정적 차이가 하나 있다:

```javascript
// line 28826
function createHydrationContainer(initialChildren, callback, containerInfo,
    tag, hydrationCallbacks, isStrictMode, ...) {
  var hydrate = true;  // ← createContainer에서는 false
  var root = createFiberRoot(containerInfo, tag, hydrate, initialChildren, ...);

  root.context = getContextForSubtree(null);

  var current = root.current;
  var eventTime = requestEventTime();
  var lane = requestUpdateLane(current);
  var update = createUpdate(eventTime, lane);
  update.callback = callback !== undefined && callback !== null ? callback : null;
  enqueueUpdate(current, update, lane);
  scheduleInitialHydrationOnRoot(root, lane, eventTime);
  return root;
}
```

`hydrate = true`가 `createFiberRoot`(line 28695)로 전달되면, 초기 상태에서 `isDehydrated: true`가 설정된다:

```javascript
// line 28695
function createFiberRoot(containerInfo, tag, hydrate, initialChildren, ...) {
  var root = new FiberRootNode(containerInfo, tag, hydrate, ...);
  var uninitializedFiber = createHostRootFiber(tag, isStrictMode);
  root.current = uninitializedFiber;
  uninitializedFiber.stateNode = root;

  var _initialState = {
    element: initialChildren,
    isDehydrated: hydrate,  // ← true: 아직 hydration이 필요한 상태
    cache: null,
    transitions: null,
    pendingSuspenseBoundaries: null
  };
  uninitializedFiber.memoizedState = _initialState;

  initializeUpdateQueue(uninitializedFiber);
  return root;
}
```

`isDehydrated` 플래그는 이후 `beginWork`에서 HostRoot를 처리할 때 핵심적인 분기 조건이 된다. 이 값이 `true`이면 DOM을 새로 생성하지 않고 기존 DOM을 재사용하는 hydration 경로로 진입한다.

### 1.3 scheduleInitialHydrationOnRoot: 왜 별도 경로가 필요한가

일반적인 `scheduleUpdateOnFiber`와 달리 hydration 초기 렌더에는 전용 스케줄링 함수가 있다:

```javascript
// line 25584
function scheduleInitialHydrationOnRoot(root, lane, eventTime) {
  // 이 함수는 scheduleUpdateOnFiber의 특수 포크(fork)이다.
  // 최초 hydration만을 위해 사용된다.
  //
  // 별도 경로가 필요한 이유:
  // - 초기 자식들(initial children)을 이후 업데이트와 구별해야 한다
  // - 순수 클라이언트 렌더링(createRoot)에서는 모든 최상위 렌더가
  //   update로 모델링되지만, hydration root는 특별하다
  // - 초기 렌더가 서버에서 렌더된 것과 반드시 일치해야 하기 때문이다
  var current = root.current;
  current.lanes = lane;
  markRootUpdated(root, lane, eventTime);
  ensureRootIsScheduled(root, eventTime);
}
```

주석이 설계 의도를 명확히 드러낸다. Hydration의 초기 렌더는 "서버 렌더 결과와의 일치"라는 특수한 제약 조건 하에서 수행되므로, 일반 업데이트와 동일한 경로를 태우면 안 된다. `scheduleUpdateOnFiber`의 여러 부가 로직(예: 진행 중인 렌더 인터럽트, batching 최적화 등)을 건너뛰고 최소한의 스케줄링만 수행하는 것이다.

### 1.4 isRootDehydrated: hydration 상태 판별

이후 렌더링 과정에서 현재 root가 hydration이 필요한 상태인지 확인하는 함수는 간결하다:

```javascript
// line 6014
function isRootDehydrated(root) {
  var currentState = root.current.memoizedState;
  return currentState.isDehydrated;
}
```

이 함수는 이벤트 디스패치(`findInstanceBlockingEvent`), concurrent error recovery(`recoverFromConcurrentError`), 그리고 beginWork HostRoot 분기 등 여러 곳에서 호출된다.

---

## 2. Hydration Context: DOM 트리와 Fiber 트리의 병렬 순회

### 2.1 세 개의 전역 상태 변수

Hydration의 핵심은 "Fiber 트리를 구축하면서 동시에 기존 DOM 트리를 순회하며 매칭하는 것"이다. 이를 위해 세 개의 모듈 레벨 변수가 사용된다:

```javascript
// line 12247-12254
var hydrationParentFiber = null;     // 현재 hydration 중인 부모 Fiber
var nextHydratableInstance = null;   // 다음으로 매칭할 DOM 노드
var isHydrating = false;             // hydration 진행 중 여부 플래그

// 추가 상태
var didSuspendOrErrorDEV = false;    // 개발 모드: 오류/suspend 발생 여부
var hydrationErrors = null;          // 감지된 hydration 에러 배열
```

이 변수들이 어떻게 상호작용하는지를 ASCII 다이어그램으로 표현하면:

```
Server HTML:         Fiber Tree (구축 중):
<div id="root">     HostRoot
  <nav>               ├─ nav (HostComponent)
    <a>Home</a>       │   └─ a (HostComponent)
    <a>About</a>      │       └─ "Home" (HostText)
  </nav>              │   └─ a (HostComponent)
  <main>              │       └─ "About" (HostText)
    <h1>Title</h1>    ├─ main (HostComponent)
    <p>Content</p>    │   ├─ h1 (HostComponent)
  </main>             │   │   └─ "Title" (HostText)
</div>                │   └─ p (HostComponent)
                      │       └─ "Content" (HostText)

hydrationParentFiber ──→ 현재 처리 중인 부모 Fiber를 가리킴
nextHydratableInstance ──→ 다음에 매칭할 DOM 자식 노드를 가리킴
```

### 2.2 enterHydrationState: Hydration 시작점

HostRoot의 beginWork에서 `isDehydrated`가 true일 때 `enterHydrationState`가 호출되어 hydration을 시작한다:

```javascript
// line 12275
function enterHydrationState(fiber) {
  var parentInstance = fiber.stateNode.containerInfo;
  nextHydratableInstance = getFirstHydratableChildWithinContainer(parentInstance);
  hydrationParentFiber = fiber;
  isHydrating = true;
  hydrationErrors = null;
  didSuspendOrErrorDEV = false;
  return true;
}
```

`getFirstHydratableChildWithinContainer`는 컨테이너의 `firstChild`를 가져온 뒤, `getNextHydratable`로 hydratable한 노드를 찾는다:

```javascript
// line 11290
function getFirstHydratableChildWithinContainer(parentContainer) {
  return getNextHydratable(parentContainer.firstChild);
}

// line 11260
function getNextHydratable(node) {
  // hydratable하지 않은 노드를 건너뛴다
  for (; node != null; node = node.nextSibling) {
    var nodeType = node.nodeType;
    if (nodeType === ELEMENT_NODE || nodeType === TEXT_NODE) {
      break;
    }
    if (nodeType === COMMENT_NODE) {
      var nodeData = node.data;
      // Suspense 마커 주석은 hydratable
      if (nodeData === SUSPENSE_START_DATA ||
          nodeData === SUSPENSE_FALLBACK_START_DATA ||
          nodeData === SUSPENSE_PENDING_START_DATA) {
        break;
      }
      // Suspense 종료 마커를 만나면 null 반환
      if (nodeData === SUSPENSE_END_DATA) {
        return null;
      }
    }
  }
  return node;
}
```

이 함수가 보여주는 중요한 설계 결정이 있다:

- **ELEMENT_NODE(1), TEXT_NODE(3)**: 일반적인 hydratable 노드
- **COMMENT_NODE(8)**: Suspense 마커(`$`, `$?`, `$!`)인 경우만 hydratable
- **그 외 노드**: 건너뜀 (HTML 서버가 삽입하는 `<!DOCTYPE>` 등)

### 2.3 tryToClaimNextHydratableInstance: 핵심 매칭 로직

각 HostComponent, HostText, SuspenseComponent Fiber가 생성될 때 `tryToClaimNextHydratableInstance`가 호출되어 DOM 노드와의 매칭을 시도한다. 이 함수가 Hydration 시스템에서 가장 중요한 함수라 해도 과언이 아니다:

```javascript
// line 12510
function tryToClaimNextHydratableInstance(fiber) {
  if (!isHydrating) {
    return;  // hydration 모드가 아니면 즉시 반환
  }

  var nextInstance = nextHydratableInstance;

  if (!nextInstance) {
    // 매칭할 DOM 노드가 없다
    if (shouldClientRenderOnMismatch(fiber)) {
      warnNonhydratedInstance(hydrationParentFiber, fiber);
      throwOnHydrationMismatch();  // Concurrent Mode: 에러 throw → 클라이언트 렌더로 폴백
    }
    // Legacy Mode: insertion으로 전환
    insertNonHydratedInstance(hydrationParentFiber, fiber);
    isHydrating = false;
    hydrationParentFiber = fiber;
    return;
  }

  var firstAttemptedInstance = nextInstance;

  if (!tryHydrate(fiber, nextInstance)) {
    // 첫 번째 노드 매칭 실패
    if (shouldClientRenderOnMismatch(fiber)) {
      warnNonhydratedInstance(hydrationParentFiber, fiber);
      throwOnHydrationMismatch();
    }
    // 한 칸 건너뛰어 다음 형제 노드로 재시도
    nextInstance = getNextHydratableSibling(firstAttemptedInstance);
    var prevHydrationParentFiber = hydrationParentFiber;

    if (!nextInstance || !tryHydrate(fiber, nextInstance)) {
      // 두 번째 시도도 실패 → insertion 모드
      insertNonHydratedInstance(hydrationParentFiber, fiber);
      isHydrating = false;
      hydrationParentFiber = fiber;
      return;
    }
    // 두 번째 노드에서 매칭 성공 → 첫 번째는 불필요한 노드로 삭제 예약
    deleteHydratableInstance(prevHydrationParentFiber, firstAttemptedInstance);
  }
}
```

이 함수의 알고리즘을 단계별로 분석하면:

```
Step 1: nextHydratableInstance 확인
        ├─ null → Mismatch 처리 (throw 또는 insertion)
        └─ 존재 → Step 2

Step 2: tryHydrate(fiber, nextInstance) 첫 번째 시도
        ├─ 성공 → 완료 (fiber.stateNode = DOM 노드)
        └─ 실패 → Step 3

Step 3: 다음 형제 노드로 이동하여 두 번째 시도
        ├─ 성공 → 첫 번째 노드는 삭제 예약, 두 번째 노드 사용
        └─ 실패 → insertion 모드 (새 DOM 생성)
```

**왜 두 번 시도하는가?** 주석에 "This is based on intuition and not data"라고 솔직하게 적혀 있다. 서버가 클라이언트와 약간 다른 DOM을 생성했을 때(예: 서버에서만 추가된 노드가 하나 있을 때), 한 칸 건너뛰면 나머지가 정상 매칭될 확률이 높다는 휴리스틱이다.

### 2.4 tryHydrate: 태그 유형별 매칭

`tryHydrate`(line 12435)는 Fiber의 태그에 따라 서로 다른 매칭 전략을 사용한다:

```javascript
// line 12435
function tryHydrate(fiber, nextInstance) {
  switch (fiber.tag) {
    case HostComponent: {
      var type = fiber.type;
      var props = fiber.pendingProps;
      var instance = canHydrateInstance(nextInstance, type);
      if (instance !== null) {
        fiber.stateNode = instance;          // ← DOM 노드 연결!
        hydrationParentFiber = fiber;
        nextHydratableInstance = getFirstHydratableChild(instance);
        return true;
      }
      return false;
    }

    case HostText: {
      var text = fiber.pendingProps;
      var textInstance = canHydrateTextInstance(nextInstance, text);
      if (textInstance !== null) {
        fiber.stateNode = textInstance;
        hydrationParentFiber = fiber;
        nextHydratableInstance = null;  // 텍스트 노드에는 자식이 없다
        return true;
      }
      return false;
    }

    case SuspenseComponent: {
      var suspenseInstance = canHydrateSuspenseInstance(nextInstance);
      if (suspenseInstance !== null) {
        var suspenseState = {
          dehydrated: suspenseInstance,
          treeContext: getSuspendedTreeContext(),
          retryLane: OffscreenLane
        };
        fiber.memoizedState = suspenseState;

        // DehydratedFragment Fiber를 자식으로 생성
        var dehydratedFragment = createFiberFromDehydratedFragment(suspenseInstance);
        dehydratedFragment.return = fiber;
        fiber.child = dehydratedFragment;
        hydrationParentFiber = fiber;
        nextHydratableInstance = null;  // Suspense 내부는 나중에 처리
        return true;
      }
      return false;
    }

    default:
      return false;
  }
}
```

각 case에서 일어나는 일을 정리하면:

| Fiber 태그 | 매칭 조건 | 매칭 성공 시 동작 |
|-----------|----------|----------------|
| **HostComponent** | `nodeType === ELEMENT_NODE && nodeName === type` | `fiber.stateNode = DOM`, 자식으로 이동 |
| **HostText** | `nodeType === TEXT_NODE && text !== ''` | `fiber.stateNode = TextNode`, 자식 없음 |
| **SuspenseComponent** | `nodeType === COMMENT_NODE` | `dehydrated` 상태 설정, DehydratedFragment 생성 |

`canHydrateInstance`(line 11195)의 구현을 보면 매칭 기준이 명확하다:

```javascript
// line 11195
function canHydrateInstance(instance, type, props) {
  if (instance.nodeType !== ELEMENT_NODE ||
      type.toLowerCase() !== instance.nodeName.toLowerCase()) {
    return null;
  }
  return instance;
}
```

태그 이름만 비교한다. 속성(props)은 이 단계에서 검증하지 않는다. 속성 비교는 이후 `completeWork`에서 `prepareToHydrateHostInstance` -> `hydrateInstance` -> `diffHydratedProperties` 경로에서 수행된다.

### 2.5 popHydrationState: 부모로 돌아가기

`completeWork`에서 각 Fiber의 처리가 끝나면 `popHydrationState`(line 12653)가 호출되어 hydration 커서를 부모 방향으로 이동시킨다:

```javascript
// line 12653
function popHydrationState(fiber) {
  if (fiber !== hydrationParentFiber) {
    // 현재 hydration context보다 깊은 곳에 있다
    // (삽입된 노드 내부에 있는 경우)
    return false;
  }

  if (!isHydrating) {
    // hydration context 안에 있지만 현재 hydrating 중이 아니다
    // → insertion이었으므로 hydration을 재진입
    popToNextHostParent(fiber);
    isHydrating = true;
    return false;
  }

  // 남은 hydratable 자식이 있으면 삭제해야 한다
  // (head, body는 브라우저가 자동 삽입하는 노드가 있으므로 제외)
  if (fiber.tag !== HostRoot &&
      (fiber.tag !== HostComponent ||
       shouldDeleteUnhydratedTailInstances(fiber.type) &&
       !shouldSetTextContent(fiber.type, fiber.memoizedProps))) {
    var nextInstance = nextHydratableInstance;
    if (nextInstance) {
      if (shouldClientRenderOnMismatch(fiber)) {
        warnIfUnhydratedTailNodes(fiber);
        throwOnHydrationMismatch();
      } else {
        // 남은 DOM 노드를 하나씩 삭제 예약
        while (nextInstance) {
          deleteHydratableInstance(fiber, nextInstance);
          nextInstance = getNextHydratableSibling(nextInstance);
        }
      }
    }
  }

  popToNextHostParent(fiber);

  // Suspense의 경우: dehydrated 경계를 건너뛰어야 한다
  if (fiber.tag === SuspenseComponent) {
    nextHydratableInstance = skipPastDehydratedSuspenseInstance(fiber);
  } else {
    nextHydratableInstance = hydrationParentFiber
      ? getNextHydratableSibling(fiber.stateNode) : null;
  }

  return true;
}
```

`shouldDeleteUnhydratedTailInstances`(line 11386)의 구현이 흥미롭다:

```javascript
// line 11386
function shouldDeleteUnhydratedTailInstances(parentType) {
  return parentType !== 'head' && parentType !== 'body';
}
```

`<head>`와 `<body>` 내부에서는 남은 DOM 노드를 삭제하지 않는다. 브라우저가 자동으로 삽입하는 `<link>`, `<meta>`, 브라우저 확장 프로그램이 추가하는 노드 등이 있을 수 있기 때문이다.

### 2.6 전체 Hydration 순회 흐름

beginWork부터 completeWork까지의 전체 흐름을 HostRoot 기준으로 추적하면:

```
beginWork(HostRoot)
  │ prevState.isDehydrated === true
  │
  ├─ overrideState.isDehydrated = false   ← 플래그 해제
  ├─ enterHydrationState(workInProgress)  ← hydration 시작
  │    nextHydratableInstance = container.firstChild
  │    isHydrating = true
  │
  ├─ mountChildFibers(...)                ← 자식 Fiber 생성
  │    각 자식 Fiber에 Hydrating 플래그 설정
  │
  └─ 자식으로 이동

    beginWork(HostComponent: <nav>)
      │
      ├─ tryToClaimNextHydratableInstance(fiber)
      │    tryHydrate(fiber, <nav> DOM)
      │    fiber.stateNode = <nav> DOM    ← 매칭!
      │    nextHydratableInstance = <nav>.firstChild
      │
      └─ reconcileChildren(...)  → 자식으로 이동

        beginWork(HostComponent: <a>)
          │ tryToClaimNextHydratableInstance → 매칭
          ...

        completeWork(HostComponent: <a>)
          │ popHydrationState → 형제로 이동
          │ nextHydratableInstance = <a>.nextSibling
          ...

    completeWork(HostComponent: <nav>)
      │ popHydrationState
      │ nextHydratableInstance = <nav>.nextSibling
```

---

## 3. Hydration 완료 단계: diffHydratedProperties

### 3.1 completeWork에서의 Hydration 확정

`completeWork`(line 22200 부근)에서 HostComponent의 hydration이 확정된다:

```javascript
// line 22217 (completeWork 내부, HostComponent case)
var _wasHydrated = popHydrationState(workInProgress);

if (_wasHydrated) {
  if (prepareToHydrateHostInstance(
    workInProgress, rootContainerInstance, currentHostContext
  )) {
    // hydrated 노드에 변경이 필요하면 커밋 단계에서 처리
    markUpdate(workInProgress);
  }
} else {
  // hydration이 아닌 경우: 새 DOM 생성
  var instance = createInstance(type, newProps, ...);
  appendAllChildren(instance, workInProgress, false, false);
  workInProgress.stateNode = instance;
}
```

`prepareToHydrateHostInstance`(line 12560)는 실제 속성 비교를 수행한다:

```javascript
// line 12560
function prepareToHydrateHostInstance(fiber, rootContainerInstance, hostContext) {
  var instance = fiber.stateNode;
  var shouldWarnIfMismatchDev = !didSuspendOrErrorDEV;
  var updatePayload = hydrateInstance(
    instance, fiber.type, fiber.memoizedProps,
    rootContainerInstance, hostContext, fiber, shouldWarnIfMismatchDev
  );

  fiber.updateQueue = updatePayload;

  if (updatePayload !== null) {
    return true;  // 커밋 단계에서 DOM 업데이트 필요
  }
  return false;
}
```

### 3.2 diffHydratedProperties: 속성 차이 감지

`hydrateInstance`(line 11297)는 `diffHydratedProperties`(line 10178)를 호출하여 서버 렌더 DOM과 클라이언트 props를 비교한다. 이 함수는 200줄이 넘는 대형 함수인데, 핵심 로직을 추출하면:

```javascript
// line 10178 (축약)
function diffHydratedProperties(domElement, tag, rawProps,
    parentNamespace, rootContainerElement, isConcurrentMode, shouldWarnDev) {

  // 1단계: 특수 태그별 이벤트 리스너 등록
  switch (tag) {
    case 'dialog': listenToNonDelegatedEvent('cancel', domElement); break;
    case 'iframe': listenToNonDelegatedEvent('load', domElement); break;
    case 'input': initWrapperState(domElement, rawProps); break;
    case 'select': initWrapperState$1(domElement, rawProps); break;
    case 'textarea': initWrapperState$2(domElement, rawProps); break;
    // ...
  }

  // 2단계: 서버 DOM의 모든 attribute 수집 (개발 모드)
  extraAttributeNames = new Set();
  var attributes = domElement.attributes;
  for (var _i = 0; _i < attributes.length; _i++) {
    var name = attributes[_i].name.toLowerCase();
    // value, checked, selected는 제어 컴포넌트용으로 제외
    if (name !== 'value' && name !== 'checked' && name !== 'selected') {
      extraAttributeNames.add(attributes[_i].name);
    }
  }

  // 3단계: 클라이언트 props를 순회하며 비교
  var updatePayload = null;
  for (var propKey in rawProps) {
    var nextProp = rawProps[propKey];

    if (propKey === CHILDREN) {
      // 텍스트 콘텐츠 비교
      if (typeof nextProp === 'string') {
        if (domElement.textContent !== nextProp) {
          if (rawProps[SUPPRESS_HYDRATION_WARNING] !== true) {
            checkForUnmatchedText(
              domElement.textContent, nextProp,
              isConcurrentMode, shouldWarnDev
            );
          }
          updatePayload = [CHILDREN, nextProp];
        }
      }
    } else if (propKey === DANGEROUSLY_SET_INNER_HTML) {
      // innerHTML 비교
      var serverHTML = domElement.innerHTML;
      var expectedHTML = normalizeHTML(domElement, nextProp[HTML$1]);
      if (expectedHTML !== serverHTML) {
        warnForPropDifference(propKey, serverHTML, expectedHTML);
      }
    } else if (propKey === STYLE) {
      // 스타일 비교
      // ...
    }
    // ... 기타 속성 비교
  }

  // 4단계: 서버에만 있고 클라이언트에 없는 attribute 경고
  if (extraAttributeNames.size > 0 &&
      rawProps[SUPPRESS_HYDRATION_WARNING] !== true) {
    warnForExtraAttributes(extraAttributeNames);
  }

  return updatePayload;
}
```

`updatePayload`가 null이 아니면 커밋 단계에서 `commitUpdate`를 통해 DOM이 실제로 수정된다. 이것은 hydration이 "서버 DOM을 그대로 사용"하면서도 필요한 경우 패치할 수 있는 메커니즘이다.

---

## 4. Mismatch 감지와 복구 전략

### 4.1 Mismatch의 두 가지 모드

React 18에서 hydration mismatch 처리는 렌더 모드에 따라 극적으로 다르다:

```javascript
// line 12503
function shouldClientRenderOnMismatch(fiber) {
  return (fiber.mode & ConcurrentMode) !== NoMode &&
         (fiber.flags & DidCapture) === NoFlags;
}
```

| 모드 | Mismatch 시 동작 | 근거 |
|-----|-----------------|------|
| **Concurrent Mode** | Error throw → 가장 가까운 Suspense 경계에서 클라이언트 렌더로 폴백 | 일관성이 깨진 UI를 표시하는 것보다 클라이언트 렌더가 안전 |
| **Legacy Mode** | 경고 출력 후 DOM을 in-place 수정 (insertion/deletion) | 하위 호환성 유지 |

### 4.2 throwOnHydrationMismatch: Concurrent Mode의 강경 대응

```javascript
// line 12506
function throwOnHydrationMismatch(fiber) {
  throw new Error(
    'Hydration failed because the initial UI does not match ' +
    'what was rendered on the server.'
  );
}
```

이 에러가 throw되면 React의 에러 경계 처리 로직을 타고 올라가서 가장 가까운 Suspense 경계에서 `ForceClientRender` 플래그가 설정된다. 그러면 해당 Suspense 경계 내부 전체가 클라이언트에서 다시 렌더링된다.

### 4.3 insertNonHydratedInstance: Legacy Mode의 유연한 대처

```javascript
// line 12432
function insertNonHydratedInstance(returnFiber, fiber) {
  fiber.flags = fiber.flags & ~Hydrating | Placement;
  warnNonhydratedInstance(returnFiber, fiber);
}
```

`Hydrating` 플래그를 제거하고 `Placement` 플래그를 설정한다. 이는 "이 Fiber는 기존 DOM을 재사용하지 않고 새로 삽입해야 한다"는 의미다. 커밋 단계에서 실제 DOM 삽입이 일어난다.

### 4.4 텍스트 불일치: checkForUnmatchedText

텍스트 불일치는 가장 흔한 hydration mismatch 유형이다:

```javascript
// line 9626
function checkForUnmatchedText(serverText, clientText,
    isConcurrentMode, shouldWarnDev) {
  var normalizedClientText = normalizeMarkupForTextOrAttribute(clientText);
  var normalizedServerText = normalizeMarkupForTextOrAttribute(serverText);

  if (normalizedServerText === normalizedClientText) {
    return;  // 정규화 후 일치하면 OK
  }

  if (shouldWarnDev) {
    if (!didWarnInvalidHydration) {
      didWarnInvalidHydration = true;
      error('Text content did not match. Server: "%s" Client: "%s"',
            normalizedServerText, normalizedClientText);
    }
  }

  if (isConcurrentMode && enableClientRenderFallbackOnTextMismatch) {
    // Concurrent Mode: 에러 throw → Suspense 경계에서 클라이언트 렌더
    throw new Error('Text content does not match server-rendered HTML.');
  }
}
```

**정규화(normalize)**를 거친다는 점이 중요하다. 공백 차이 등 사소한 불일치는 무시된다. 하지만 Concurrent Mode에서는 `enableClientRenderFallbackOnTextMismatch` 플래그가 켜져 있으면 정규화 후에도 불일치가 있으면 에러를 throw한다.

### 4.5 개발 모드 경고 계층

개발 모드에서는 불일치 유형에 따라 다른 경고 함수가 호출된다:

```
warnNonhydratedInstance(returnFiber, fiber)
  ├─ HostRoot 내부:
  │   ├─ HostComponent → didNotFindHydratableInstanceWithinContainer
  │   └─ HostText → didNotFindHydratableTextInstanceWithinContainer
  ├─ HostComponent 내부:
  │   ├─ HostComponent → didNotFindHydratableInstance
  │   └─ HostText → didNotFindHydratableTextInstance
  └─ SuspenseComponent 내부:
      ├─ HostComponent → didNotFindHydratableInstanceWithinSuspenseInstance
      └─ HostText → didNotFindHydratableTextInstanceWithinSuspenseInstance
```

각 함수는 `suppressHydrationWarning` prop을 확인한다:

```javascript
// line 11457 (didNotFindHydratableInstance)
function didNotFindHydratableInstance(parentType, parentProps, parentInstance,
    type, props, isConcurrentMode) {
  if (isConcurrentMode || parentProps[SUPPRESS_HYDRATION_WARNING$1] !== true) {
    warnForInsertedHydratedElement(parentInstance, type);
  }
}
```

### 4.6 Hydration 실패 시 전체 Root 폴백

가장 극단적인 경우, Suspense 경계 밖에서 mismatch가 발생하면 전체 root가 클라이언트 렌더링으로 전환된다:

```javascript
// line 19878 (beginWork - HostRoot)
if (workInProgress.flags & ForceClientRender) {
  var recoverableError = createCapturedValueAtFiber(
    new Error('There was an error while hydrating. Because the error ' +
      'happened outside of a Suspense boundary, the entire root ' +
      'will switch to client rendering.'),
    workInProgress
  );
  return mountHostRootWithoutHydrating(
    current, workInProgress, nextChildren, renderLanes, recoverableError
  );
}
```

`mountHostRootWithoutHydrating`(line 19925)은 hydration 상태를 완전히 리셋하고 일반 렌더 경로로 전환한다:

```javascript
// line 19925
function mountHostRootWithoutHydrating(current, workInProgress,
    nextChildren, renderLanes, recoverableError) {
  resetHydrationState();
  queueHydrationError(recoverableError);
  workInProgress.flags |= ForceClientRender;
  reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  return workInProgress.child;
}
```

이때 `queueHydrationError`로 에러가 큐잉되고, 커밋 단계에서 `upgradeHydrationErrorsToRecoverable`(line 12720)로 복구 가능한 에러로 승격된다:

```javascript
// line 12720
function upgradeHydrationErrorsToRecoverable() {
  if (hydrationErrors !== null) {
    queueRecoverableErrors(hydrationErrors);
    hydrationErrors = null;
  }
}
```

이 에러들은 최종적으로 `onRecoverableError` 콜백을 통해 애플리케이션 레벨로 전달된다.

---

## 5. Selective Hydration: 사용자 상호작용 우선순위

### 5.1 아키텍처 개요

React 18의 Selective Hydration은 "모든 것을 한 번에 hydrate하지 않는다"는 원칙에 기반한다. Suspense 경계 단위로 hydration을 분할하고, 사용자 상호작용이 발생한 영역을 우선 처리한다.

```
페이지 로드 완료
       │
       ▼
┌──────────────────────────────────────────────┐
│ 1. Shell Hydration (Root ~ 첫 번째 Suspense)  │
│    enterHydrationState → tryHydrate ...       │
│    이벤트 위임은 이미 등록됨                     │
└──────────────────────────────────────────────┘
       │
       ├─── 사용자 클릭 발생 ──────────────────┐
       │                                      │
       ▼                                      ▼
┌──────────────────┐            ┌──────────────────────┐
│ 2. 백그라운드      │            │ 3. 긴급 Hydration     │
│    Hydration      │            │    (동기 처리)         │
│    (Idle 우선순위) │            │                      │
│                  │            │ attemptSynchronous   │
│ 나머지 Suspense   │            │ Hydration(fiber)     │
│ 경계들            │            │                      │
└──────────────────┘            │ → 클릭 영역 즉시 hydrate│
                                │ → 이벤트 리플레이       │
                                └──────────────────────┘
```

### 5.2 이벤트 디스패치 경로에서의 Hydration 트리거

사용자 이벤트가 발생하면 `dispatchEvent` -> `findInstanceBlockingEvent` 경로를 타는데, 이 과정에서 hydration이 필요한 Suspense 경계를 만나면 이벤트를 블록하고 hydration을 트리거한다:

```javascript
// line 6515
function findInstanceBlockingEvent(domEventName, eventSystemFlags,
    targetContainer, nativeEvent) {
  return_targetInst = null;
  var nativeEventTarget = getEventTarget(nativeEvent);
  var targetInst = getClosestInstanceFromNode(nativeEventTarget);

  if (targetInst !== null) {
    var nearestMounted = getNearestMountedFiber(targetInst);

    if (nearestMounted === null) {
      targetInst = null;  // 언마운트된 트리
    } else {
      var tag = nearestMounted.tag;

      if (tag === SuspenseComponent) {
        var instance = getSuspenseInstanceFromFiber(nearestMounted);
        if (instance !== null) {
          // Dehydrated Suspense 경계 발견!
          // → 이벤트를 블록하고 나중에 리플레이
          return instance;
        }
        targetInst = null;
      } else if (tag === HostRoot) {
        var root = nearestMounted.stateNode;
        if (isRootDehydrated(root)) {
          // Root 자체가 아직 dehydrated
          return getContainerFromFiber(nearestMounted);
        }
        targetInst = null;
      }
    }
  }

  return_targetInst = targetInst;
  return null;  // 블록되지 않음
}
```

`findInstanceBlockingEvent`가 non-null을 반환하면, 상위 함수에서 이벤트 유형에 따라 다른 hydration 전략을 적용한다:

```javascript
// line 6462 (dispatchEventWithEnableCapturePhase... 함수 내)
var blockedOn = findInstanceBlockingEvent(domEventName, eventSystemFlags,
    targetContainer, nativeEvent);

if (blockedOn === null) {
  // 블록되지 않음 → 정상 디스패치
  dispatchEventForPluginEventSystem(...);
  clearIfContinuousEvent(domEventName, nativeEvent);
  return;
}

if (queueIfContinuousEvent(blockedOn, domEventName, ...)) {
  // continuous 이벤트 → 큐잉 후 리턴
  nativeEvent.stopPropagation();
  return;
}

clearIfContinuousEvent(domEventName, nativeEvent);

// Discrete 이벤트 + 캡처 단계 → 동기 hydration
if (eventSystemFlags & IS_CAPTURE_PHASE &&
    isDiscreteEventThatRequiresHydration(domEventName)) {
  while (blockedOn !== null) {
    var fiber = getInstanceFromNode(blockedOn);
    if (fiber !== null) {
      attemptSynchronousHydration(fiber);  // ← 동기 hydration!
    }
    var nextBlockedOn = findInstanceBlockingEvent(...);
    if (nextBlockedOn === null) {
      dispatchEventForPluginEventSystem(...);  // hydration 후 즉시 디스패치
    }
    if (nextBlockedOn === blockedOn) break;
    blockedOn = nextBlockedOn;
  }
  if (blockedOn !== null) {
    nativeEvent.stopPropagation();
  }
}
```

### 5.3 queuedExplicitHydrationTargets: 우선순위 큐

명시적 hydration 타겟은 우선순위 큐로 관리된다:

```javascript
// line 6057
var queuedExplicitHydrationTargets = [];

// line 6228
function queueExplicitHydrationTarget(target) {
  var updatePriority = getCurrentUpdatePriority$1();
  var queuedTarget = {
    blockedOn: null,
    target: target,
    priority: updatePriority
  };

  // 우선순위 순서로 삽입 (높은 우선순위가 앞)
  var i = 0;
  for (; i < queuedExplicitHydrationTargets.length; i++) {
    if (!isHigherEventPriority(updatePriority,
        queuedExplicitHydrationTargets[i].priority)) {
      break;
    }
  }
  queuedExplicitHydrationTargets.splice(i, 0, queuedTarget);

  if (i === 0) {
    // 최고 우선순위 → 즉시 hydration 시도
    attemptExplicitHydrationTarget(queuedTarget);
  }
}
```

### 5.4 attemptExplicitHydrationTarget: 타겟 기반 Hydration

```javascript
// line 6185
function attemptExplicitHydrationTarget(queuedTarget) {
  var targetInst = getClosestInstanceFromNode(queuedTarget.target);

  if (targetInst !== null) {
    var nearestMounted = getNearestMountedFiber(targetInst);

    if (nearestMounted !== null) {
      var tag = nearestMounted.tag;

      if (tag === SuspenseComponent) {
        var instance = getSuspenseInstanceFromFiber(nearestMounted);

        if (instance !== null) {
          // 아직 hydration 대기 중
          queuedTarget.blockedOn = instance;
          attemptHydrationAtPriority(queuedTarget.priority, function () {
            attemptHydrationAtCurrentPriority(nearestMounted);
          });
          return;
        }
      } else if (tag === HostRoot) {
        var root = nearestMounted.stateNode;
        if (isRootDehydrated(root)) {
          queuedTarget.blockedOn = getContainerFromFiber(nearestMounted);
          return;
        }
      }
    }
  }

  queuedTarget.blockedOn = null;  // 이미 hydrated
}
```

여기서 `attemptHydrationAtPriority`가 주어진 우선순위에서 `attemptHydrationAtCurrentPriority`를 실행하는 구조가 핵심이다. 이벤트 유형에 따라 다른 우선순위로 hydration이 스케줄링된다.

### 5.5 Hydration 우선순위 체계

```javascript
// line 6019-6033
var _attemptSynchronousHydration;
function attemptSynchronousHydration(fiber) {
  _attemptSynchronousHydration(fiber);
}

var attemptContinuousHydration;
function setAttemptContinuousHydration(fn) {
  attemptContinuousHydration = fn;
}

var attemptHydrationAtCurrentPriority;
function setAttemptHydrationAtCurrentPriority(fn) {
  attemptHydrationAtCurrentPriority = fn;
}
```

세 단계의 hydration 우선순위가 존재한다:

| 함수 | 우선순위 | 사용되는 이벤트 |
|-----|---------|--------------|
| `attemptSynchronousHydration` | 동기 (가장 높음) | Discrete 이벤트 (click, keydown 등) |
| `attemptContinuousHydration` | Continuous | 연속 이벤트 (mouseover, scroll 등) |
| `attemptHydrationAtCurrentPriority` | 현재 업데이트 우선순위 | 명시적 hydration 타겟 |

이 함수들은 `setAttemptSynchronousHydration` 등을 통해 reconciler 측에서 주입된다. 이렇게 의존성 역전(IoC)을 사용하는 이유는 이벤트 시스템(react-dom-bindings)과 reconciler(react-reconciler)가 서로 직접 참조하지 않는 아키텍처를 유지하기 위해서다.

### 5.6 unstable_scheduleHydration: 프로그래밍 방식의 Hydration

`ReactDOMHydrationRoot`는 프로그래밍 방식으로 특정 DOM 노드의 hydration을 요청할 수 있는 API를 제공한다:

```javascript
// line 29429
function ReactDOMHydrationRoot(internalRoot) {
  this._internalRoot = internalRoot;
}

function scheduleHydration(target) {
  if (target) {
    queueExplicitHydrationTarget(target);
  }
}

// line 29439
ReactDOMHydrationRoot.prototype.unstable_scheduleHydration = scheduleHydration;
```

이름에 `unstable_` 접두사가 붙어 있어 공식 API는 아니지만, 특정 영역의 hydration을 미리 트리거해야 하는 고급 시나리오에서 사용할 수 있다.

---

## 6. 이벤트 리플레이 시스템

### 6.1 왜 이벤트 리플레이가 필요한가

Selective Hydration은 일부 영역이 아직 hydrate되지 않은 상태에서 사용자 상호작용이 발생할 수 있다는 것을 전제한다. 이때 이벤트를 단순히 무시하면 사용자 경험이 나빠진다. React 18은 이벤트를 큐에 저장했다가 hydration 완료 후 재생(replay)하는 메커니즘을 구현했다.

```
사용자 클릭 → dehydrated 영역
        │
        ▼
findInstanceBlockingEvent → Suspense 인스턴스 반환 (blocked)
        │
        ├─ Discrete 이벤트? → queuedDiscreteEvents에 저장
        │                    + attemptSynchronousHydration
        │
        └─ Continuous 이벤트? → queuedFocus/queuedDrag/queuedMouse에 저장
                               + attemptContinuousHydration
        │
        ▼
Hydration 완료 → retryIfBlockedOn(unblocked)
        │
        ▼
scheduleCallbackIfUnblocked → replayUnblockedEvents 스케줄
        │
        ▼
이벤트 재생: nativeEvent.target.dispatchEvent(nativeEventClone)
```

### 6.2 이벤트 큐의 구조

```javascript
// line 6047-6057
var queuedDiscreteEvents = [];    // Discrete 이벤트 큐 (배열)

// Continuous 이벤트: 각 유형당 하나만 저장 (최신 것으로 교체)
var queuedFocus = null;
var queuedDrag = null;
var queuedMouse = null;
var queuedPointers = new Map();   // pointerId별 저장
var queuedPointerCaptures = new Map();

var queuedExplicitHydrationTargets = [];  // 명시적 hydration 타겟
```

Discrete 이벤트(click, keydown 등)는 배열에 모두 쌓인다. 하나도 놓치면 안 되기 때문이다. 반면 Continuous 이벤트(mousemove, scroll 등)는 최신 것 하나만 유지한다. 중간 이벤트는 의미가 없기 때문이다.

### 6.3 Discrete 이벤트 목록

```javascript
// line 6058
var discreteReplayableEvents = [
  'mousedown', 'mouseup', 'touchcancel', 'touchend', 'touchstart',
  'auxclick', 'dblclick', 'pointercancel', 'pointerdown', 'pointerup',
  'dragend', 'dragstart', 'drop',
  'compositionend', 'compositionstart',
  'keydown', 'keypress', 'keyup',
  'input', 'textInput',
  'copy', 'cut', 'paste',
  'click', 'change', 'contextmenu', 'reset', 'submit'
];
```

이 목록에 있는 이벤트들은 hydration이 완료될 때까지 큐잉된다.

### 6.4 Continuous 이벤트 큐잉

`queueIfContinuousEvent`(line 6135)는 이벤트 유형에 따라 적절한 큐에 저장한다:

```javascript
// line 6135 (축약)
function queueIfContinuousEvent(blockedOn, domEventName, eventSystemFlags,
    targetContainer, nativeEvent) {
  switch (domEventName) {
    case 'focusin': {
      queuedFocus = accumulateOrCreateContinuousQueuedReplayableEvent(
        queuedFocus, blockedOn, domEventName,
        eventSystemFlags, targetContainer, nativeEvent);
      return true;
    }
    case 'dragenter': {
      queuedDrag = accumulateOrCreateContinuousQueuedReplayableEvent(
        queuedDrag, blockedOn, ...);
      return true;
    }
    case 'mouseover': {
      queuedMouse = accumulateOrCreateContinuousQueuedReplayableEvent(
        queuedMouse, blockedOn, ...);
      return true;
    }
    case 'pointerover': {
      var pointerId = nativeEvent.pointerId;
      queuedPointers.set(pointerId,
        accumulateOrCreateContinuousQueuedReplayableEvent(
          queuedPointers.get(pointerId) || null, blockedOn, ...));
      return true;
    }
    // gotpointercapture도 유사
  }
  return false;
}
```

`accumulateOrCreateContinuousQueuedReplayableEvent`(line 6107)는 같은 네이티브 이벤트가 여러 이벤트 시스템(capture/bubble)에서 중복 처리되는 것을 방지한다:

```javascript
// line 6107
function accumulateOrCreateContinuousQueuedReplayableEvent(
    existingQueuedEvent, blockedOn, domEventName,
    eventSystemFlags, targetContainer, nativeEvent) {

  if (existingQueuedEvent === null ||
      existingQueuedEvent.nativeEvent !== nativeEvent) {
    // 새 이벤트 생성
    var queuedEvent = createQueuedReplayableEvent(
      blockedOn, domEventName, eventSystemFlags,
      targetContainer, nativeEvent);

    if (blockedOn !== null) {
      var _fiber2 = getInstanceFromNode(blockedOn);
      if (_fiber2 !== null) {
        attemptContinuousHydration(_fiber2);  // ← hydration 우선순위 상승
      }
    }
    return queuedEvent;
  }

  // 동일한 네이티브 이벤트 → flags와 targetContainers만 누적
  existingQueuedEvent.eventSystemFlags |= eventSystemFlags;
  var targetContainers = existingQueuedEvent.targetContainers;
  if (targetContainer !== null &&
      targetContainers.indexOf(targetContainer) === -1) {
    targetContainers.push(targetContainer);
  }
  return existingQueuedEvent;
}
```

### 6.5 replayUnblockedEvents: 이벤트 재생

Hydration이 완료되면 `retryIfBlockedOn`(line 6329)이 호출되어 블록 해제와 재생을 트리거한다:

```javascript
// line 6329
function retryIfBlockedOn(unblocked) {
  // 1. Discrete 이벤트 큐 처리
  if (queuedDiscreteEvents.length > 0) {
    scheduleCallbackIfUnblocked(queuedDiscreteEvents[0], unblocked);
    for (var i = 1; i < queuedDiscreteEvents.length; i++) {
      var queuedEvent = queuedDiscreteEvents[i];
      if (queuedEvent.blockedOn === unblocked) {
        queuedEvent.blockedOn = null;
      }
    }
  }

  // 2. Continuous 이벤트 큐 처리
  if (queuedFocus !== null) scheduleCallbackIfUnblocked(queuedFocus, unblocked);
  if (queuedDrag !== null) scheduleCallbackIfUnblocked(queuedDrag, unblocked);
  if (queuedMouse !== null) scheduleCallbackIfUnblocked(queuedMouse, unblocked);

  queuedPointers.forEach(function (queuedEvent) {
    return scheduleCallbackIfUnblocked(queuedEvent, unblocked);
  });
  queuedPointerCaptures.forEach(function (queuedEvent) {
    return scheduleCallbackIfUnblocked(queuedEvent, unblocked);
  });

  // 3. 명시적 hydration 타겟 처리
  for (var _i = 0; _i < queuedExplicitHydrationTargets.length; _i++) {
    var queuedTarget = queuedExplicitHydrationTargets[_i];
    if (queuedTarget.blockedOn === unblocked) {
      queuedTarget.blockedOn = null;
    }
  }

  // 4. 블록 해제된 명시적 타겟 즉시 처리
  while (queuedExplicitHydrationTargets.length > 0) {
    var nextExplicitTarget = queuedExplicitHydrationTargets[0];
    if (nextExplicitTarget.blockedOn !== null) {
      break;  // 아직 블록됨
    }
    attemptExplicitHydrationTarget(nextExplicitTarget);
    if (nextExplicitTarget.blockedOn === null) {
      queuedExplicitHydrationTargets.shift();
    }
  }
}
```

`scheduleCallbackIfUnblocked`(line 6316)는 재생을 스케줄링한다:

```javascript
// line 6316
function scheduleCallbackIfUnblocked(queuedEvent, unblocked) {
  if (queuedEvent.blockedOn === unblocked) {
    queuedEvent.blockedOn = null;

    if (!hasScheduledReplayAttempt) {
      hasScheduledReplayAttempt = true;
      Scheduler.unstable_scheduleCallback(
        Scheduler.unstable_NormalPriority,
        replayUnblockedEvents
      );
    }
  }
}
```

실제 재생은 `replayUnblockedEvents`(line 6295)에서 수행된다:

```javascript
// line 6295
function replayUnblockedEvents() {
  hasScheduledReplayAttempt = false;

  if (queuedFocus !== null &&
      attemptReplayContinuousQueuedEvent(queuedFocus)) {
    queuedFocus = null;
  }
  if (queuedDrag !== null &&
      attemptReplayContinuousQueuedEvent(queuedDrag)) {
    queuedDrag = null;
  }
  if (queuedMouse !== null &&
      attemptReplayContinuousQueuedEvent(queuedMouse)) {
    queuedMouse = null;
  }

  queuedPointers.forEach(attemptReplayContinuousQueuedEventInMap);
  queuedPointerCaptures.forEach(attemptReplayContinuousQueuedEventInMap);
}
```

`attemptReplayContinuousQueuedEvent`(line 6253)에서 실제 이벤트 재디스패치가 일어난다:

```javascript
// line 6253
function attemptReplayContinuousQueuedEvent(queuedEvent) {
  if (queuedEvent.blockedOn !== null) {
    return false;
  }

  var targetContainers = queuedEvent.targetContainers;
  while (targetContainers.length > 0) {
    var targetContainer = targetContainers[0];
    var nextBlockedOn = findInstanceBlockingEvent(
      queuedEvent.domEventName, queuedEvent.eventSystemFlags,
      targetContainer, queuedEvent.nativeEvent);

    if (nextBlockedOn === null) {
      // 블록 해제! 이벤트를 클론하여 재디스패치
      var nativeEvent = queuedEvent.nativeEvent;
      var nativeEventClone = new nativeEvent.constructor(
        nativeEvent.type, nativeEvent
      );
      setReplayingEvent(nativeEventClone);
      nativeEvent.target.dispatchEvent(nativeEventClone);
      resetReplayingEvent();
    } else {
      // 여전히 블록됨
      var _fiber3 = getInstanceFromNode(nextBlockedOn);
      if (_fiber3 !== null) {
        attemptContinuousHydration(_fiber3);
      }
      queuedEvent.blockedOn = nextBlockedOn;
      return false;
    }

    targetContainers.shift();
  }
  return true;
}
```

이벤트 리플레이의 핵심은 **네이티브 이벤트를 클론하여 원래 타겟에 dispatchEvent**하는 것이다. 이렇게 하면 React의 이벤트 위임 시스템이 이벤트를 정상적으로 처리할 수 있다.

---

## 7. Dehydrated Suspense: 마커 체계와 라이프사이클

### 7.1 HTML 주석 마커

서버 렌더링 시 Suspense 경계는 HTML 주석으로 표시된다:

```javascript
// line 10855-10858
var SUSPENSE_START_DATA = '$';
var SUSPENSE_END_DATA = '/$';
var SUSPENSE_PENDING_START_DATA = '$?';
var SUSPENSE_FALLBACK_START_DATA = '$!';
```

| 마커 | 의미 | HTML 예시 |
|-----|------|----------|
| `<!--$-->` | Suspense 콘텐츠 시작 (resolved) | `<!--$--><div>Content</div><!--/$-->` |
| `<!--$?-->` | Pending Suspense (서버에서 아직 미완료) | `<!--$?--><template id="B:0"></template>Loading...<!--/$-->` |
| `<!--$!-->` | Fallback 표시 중 (서버에서 에러/타임아웃) | `<!--$!--><div>Error fallback</div><!--/$-->` |
| `<!--/$-->` | Suspense 경계 끝 | |

이 마커들이 실제 DOM에서 어떤 구조를 형성하는지 보자:

```html
<!-- 완전히 resolve된 Suspense -->
<!--$-->
  <div class="content">
    <h1>Article Title</h1>
    <p>Article body...</p>
  </div>
<!--/$-->

<!-- 서버에서 pending (스트리밍 대기) -->
<!--$?-->
  <template id="B:0"></template>
  <div class="skeleton">Loading...</div>
<!--/$-->

<!-- 서버에서 에러 발생 -->
<!--$!-->
  <div class="error-fallback">Something went wrong</div>
<!--/$-->
```

### 7.2 canHydrateSuspenseInstance: Suspense 매칭

```javascript
// line 11207
function canHydrateSuspenseInstance(instance) {
  if (instance.nodeType !== COMMENT_NODE) {
    return null;
  }
  return instance;
}

// line 11213
function isSuspenseInstancePending(instance) {
  return instance.data === SUSPENSE_PENDING_START_DATA;
}

// line 11216
function isSuspenseInstanceFallback(instance) {
  return instance.data === SUSPENSE_FALLBACK_START_DATA;
}
```

Comment 노드의 `data` 속성으로 Suspense의 상태를 판별한다. `$`이면 resolved, `$?`이면 pending, `$!`이면 fallback.

### 7.3 DehydratedFragment Fiber

`tryHydrate`에서 SuspenseComponent를 매칭할 때 `createFiberFromDehydratedFragment`(line 28572)가 호출된다:

```javascript
// line 28572
function createFiberFromDehydratedFragment(dehydratedNode) {
  var fiber = createFiber(DehydratedFragment, null, null, NoMode);
  fiber.stateNode = dehydratedNode;
  return fiber;
}
```

`DehydratedFragment`는 특수한 Fiber 태그로, 아직 hydrate되지 않은 서버 렌더 콘텐츠를 나타낸다. 이 Fiber의 `stateNode`는 Suspense 시작 주석 노드를 가리킨다.

커밋 단계에서 dehydrated fragment가 삭제될 때는 `clearSuspenseBoundary`(line 11110)가 호출되어 주석 마커 사이의 모든 DOM 노드를 제거한다:

```javascript
// line 11110 (축약)
function clearSuspenseBoundary(parentInstance, suspenseInstance) {
  var node = suspenseInstance;
  var depth = 0;

  do {
    var nextNode = node.nextSibling;
    parentInstance.removeChild(node);

    if (nextNode && nextNode.nodeType === COMMENT_NODE) {
      var data = nextNode.data;
      if (data === SUSPENSE_END_DATA) {
        if (depth === 0) {
          parentInstance.removeChild(nextNode);
          retryIfBlockedOn(suspenseInstance);  // ← 이벤트 리플레이 트리거
          return;
        } else {
          depth--;
        }
      } else if (data === SUSPENSE_START_DATA ||
                 data === SUSPENSE_PENDING_START_DATA ||
                 data === SUSPENSE_FALLBACK_START_DATA) {
        depth++;  // 중첩된 Suspense 경계 추적
      }
    }
    node = nextNode;
  } while (node);

  retryIfBlockedOn(suspenseInstance);
}
```

`depth` 카운터로 중첩된 Suspense 경계를 올바르게 처리하는 것이 핵심이다.

### 7.4 updateDehydratedSuspenseComponent: 핵심 분기 로직

이 함수(line 20669)는 Dehydrated Suspense가 처음 begin 또는 재렌더될 때 호출되며, 여러 상황에 따라 다른 전략을 취한다:

```javascript
// line 20669
function updateDehydratedSuspenseComponent(current, workInProgress,
    didSuspend, nextProps, suspenseInstance, suspenseState, renderLanes) {

  if (!didSuspend) {
    // === 첫 번째 렌더 패스: Hydration 시도 ===

    warnIfHydrating();

    // Case 1: Legacy Mode
    if ((workInProgress.mode & ConcurrentMode) === NoMode) {
      return retrySuspenseComponentWithoutHydrating(
        current, workInProgress, renderLanes, null);
    }

    // Case 2: 서버에서 fallback 상태
    if (isSuspenseInstanceFallback(suspenseInstance)) {
      // 서버에서 에러/타임아웃으로 fallback을 보냈다
      // → 클라이언트에서도 렌더링할 수 없으므로 클라이언트 렌더로 전환
      var error = new Error(
        'The server could not finish this Suspense boundary...'
      );
      return retrySuspenseComponentWithoutHydrating(
        current, workInProgress, renderLanes,
        createCapturedValue(error, digest, stack));
    }

    // Case 3: 컨텍스트 변경으로 재렌더 필요
    if (didReceiveUpdate || hasContextChanged) {
      // 더 높은 우선순위에서 hydration 재시도 스케줄
      var attemptHydrationAtLane = getBumpedLaneForHydration(root, renderLanes);
      if (attemptHydrationAtLane !== NoLane) {
        suspenseState.retryLane = attemptHydrationAtLane;
        scheduleUpdateOnFiber(root, current, attemptHydrationAtLane, ...);
      }
      // 타임아웃까지 기다려보되, 필요하면 클라이언트 렌더로 전환
      renderDidSuspendDelayIfPossible();
      return retrySuspenseComponentWithoutHydrating(
        current, workInProgress, renderLanes, capturedValue);
    }

    // Case 4: 서버에서 아직 pending (스트리밍 대기)
    if (isSuspenseInstancePending(suspenseInstance)) {
      workInProgress.flags |= DidCapture;
      workInProgress.child = current.child;
      // 서버 응답 도착 시 retry 콜백 등록
      var retry = retryDehydratedSuspenseBoundary.bind(null, current);
      registerSuspenseInstanceRetry(suspenseInstance, retry);
      return null;
    }

    // Case 5: 정상 hydration 진행
    reenterHydrationStateFromDehydratedSuspenseInstance(
      workInProgress, suspenseInstance, suspenseState.treeContext);
    var primaryChildren = nextProps.children;
    var primaryChildFragment = mountSuspensePrimaryChildren(
      workInProgress, primaryChildren);
    primaryChildFragment.flags |= Hydrating;
    return primaryChildFragment;

  } else {
    // === 두 번째 렌더 패스: Hydration 실패 후 재시도 ===

    if (workInProgress.flags & ForceClientRender) {
      // Case 6: hydration 중 에러 발생 → 클라이언트 렌더
      workInProgress.flags &= ~ForceClientRender;
      return retrySuspenseComponentWithoutHydrating(
        current, workInProgress, renderLanes,
        createCapturedValue(new Error(
          'There was an error while hydrating...')));
    }

    if (workInProgress.memoizedState !== null) {
      // Case 7: 여전히 dehydrated 상태로 유지
      workInProgress.child = current.child;
      workInProgress.flags |= DidCapture;
      return null;
    }

    // Case 8: dehydrated 해제 → fallback 렌더
    var fallbackChildFragment =
      mountSuspenseFallbackAfterRetryWithoutHydrating(
        current, workInProgress, ...);
    workInProgress.memoizedState = SUSPENDED_MARKER;
    return fallbackChildFragment;
  }
}
```

이 함수의 Case들을 의사결정 트리로 정리하면:

```
updateDehydratedSuspenseComponent
├─ didSuspend === false (첫 번째 패스)
│   ├─ Legacy Mode? → 클라이언트 렌더
│   ├─ 서버 fallback ($!)? → 클라이언트 렌더
│   ├─ 컨텍스트 변경? → 높은 우선순위로 재스케줄 + 클라이언트 렌더
│   ├─ 서버 pending ($?)? → 대기 (retry 콜백 등록)
│   └─ 정상 → hydration 진행
│
└─ didSuspend === true (두 번째 패스)
    ├─ ForceClientRender? → 클라이언트 렌더
    ├─ 여전히 dehydrated? → dehydrated 유지
    └─ dehydrated 해제 → fallback 렌더
```

### 7.5 reenterHydrationStateFromDehydratedSuspenseInstance

정상 hydration 경로(Case 5)에서는 Suspense 경계 내부로 hydration을 "재진입"한다:

```javascript
// line 12286
function reenterHydrationStateFromDehydratedSuspenseInstance(
    fiber, suspenseInstance, treeContext) {
  nextHydratableInstance =
    getFirstHydratableChildWithinSuspenseInstance(suspenseInstance);
  hydrationParentFiber = fiber;
  isHydrating = true;
  hydrationErrors = null;
  didSuspendOrErrorDEV = false;

  if (treeContext !== null) {
    restoreSuspendedTreeContext(fiber, treeContext);
  }
  return true;
}
```

`getFirstHydratableChildWithinSuspenseInstance`(line 11293)는 Suspense 시작 주석 바로 다음 형제부터 탐색을 시작한다:

```javascript
// line 11293
function getFirstHydratableChildWithinSuspenseInstance(parentInstance) {
  return getNextHydratable(parentInstance.nextSibling);
}
```

### 7.6 completeDehydratedSuspenseBoundary

completeWork에서 Dehydrated Suspense 경계의 완료 처리를 담당한다:

```javascript
// line 22018
function completeDehydratedSuspenseBoundary(current, workInProgress, nextState) {
  // 1. 미처리 hydratable 노드가 남아있으면 mismatch
  if (hasUnhydratedTailNodes() &&
      (workInProgress.mode & ConcurrentMode) !== NoMode &&
      (workInProgress.flags & DidCapture) === NoFlags) {
    warnIfUnhydratedTailNodes(workInProgress);
    resetHydrationState();
    workInProgress.flags |= ForceClientRender | Incomplete | ShouldCapture;
    return false;
  }

  var wasHydrated = popHydrationState(workInProgress);

  if (nextState !== null && nextState.dehydrated !== null) {
    if (current === null) {
      // 초기 마운트: dehydrated 상태 유지
      if (!wasHydrated) {
        throw new Error('A dehydrated suspense component was completed ' +
          'without a hydrated node.');
      }
      prepareToHydrateHostSuspenseInstance(workInProgress);
      bubbleProperties(workInProgress);
      return false;
    } else {
      // 업데이트: hydration 상태 리셋 후 완료
      resetHydrationState();
      if ((workInProgress.flags & DidCapture) === NoFlags) {
        workInProgress.memoizedState = null;
      }
      workInProgress.flags |= Update;
      bubbleProperties(workInProgress);
      return false;
    }
  } else {
    // 완전히 hydrated → recoverable errors 처리
    upgradeHydrationErrorsToRecoverable();
    return true;  // normal Suspense path로 계속
  }
}
```

### 7.7 registerSuspenseInstanceRetry: 스트리밍 연동

서버에서 pending 상태(`$?`)인 Suspense 경계에 대해 retry 콜백을 등록한다:

```javascript
// line 11247
function registerSuspenseInstanceRetry(instance, callback) {
  instance._reactRetry = callback;
}
```

서버에서 해당 Suspense 경계의 콘텐츠가 준비되면, 스트리밍 프로토콜을 통해 새 HTML이 전송되고, 클라이언트의 런타임 스크립트가 `_reactRetry`를 호출하여 hydration을 트리거한다. 이것이 Fizz 스트리밍과 Selective Hydration이 연결되는 지점이다.

---

## 8. HostRoot의 Hydration 경로: beginWork 상세 분석

### 8.1 HostRoot beginWork의 Hydration 분기

line 19858 부근의 beginWork에서 HostRoot 처리 시, `isDehydrated` 플래그에 따라 완전히 다른 경로를 탄다:

```javascript
// line 19858
if (prevState.isDehydrated) {
  // 1. isDehydrated 플래그 해제
  var overrideState = {
    element: nextChildren,
    isDehydrated: false,
    cache: nextState.cache,
    pendingSuspenseBoundaries: nextState.pendingSuspenseBoundaries,
    transitions: nextState.transitions
  };
  updateQueue.baseState = overrideState;
  workInProgress.memoizedState = overrideState;

  // 2. 에러 체크
  if (workInProgress.flags & ForceClientRender) {
    // 이전 hydration 시도에서 에러 발생
    return mountHostRootWithoutHydrating(
      current, workInProgress, nextChildren, renderLanes,
      createCapturedValueAtFiber(
        new Error('There was an error while hydrating...'),
        workInProgress));
  }

  if (nextChildren !== prevChildren) {
    // 초기 hydration 전에 업데이트가 들어옴
    return mountHostRootWithoutHydrating(
      current, workInProgress, nextChildren, renderLanes,
      createCapturedValueAtFiber(
        new Error('This root received an early update...'),
        workInProgress));
  }

  // 3. 정상 Hydration 시작
  enterHydrationState(workInProgress);

  var child = mountChildFibers(workInProgress, null, nextChildren, renderLanes);
  workInProgress.child = child;

  // 4. 모든 자식에 Hydrating 플래그 설정
  var node = child;
  while (node) {
    node.flags = node.flags & ~Placement | Hydrating;
    node = node.sibling;
  }
} else {
  // Root가 이미 hydrated → 일반 업데이트 경로
  resetHydrationState();
  if (nextChildren === prevChildren) {
    return bailoutOnAlreadyFinishedWork(...);
  }
  reconcileChildren(current, workInProgress, nextChildren, renderLanes);
}
```

`Hydrating` 플래그(`node.flags = node.flags & ~Placement | Hydrating`)는 이 Fiber가 hydration 트리의 일부임을 나타낸다. 이 플래그는 두 가지 목적으로 사용된다:

1. **마운트 완료 판별**: 자식 노드가 완전히 마운트되었는지 확인할 때 사용
2. **이벤트 리플레이 스케줄링**: hydrating 중인 서브트리에 도달한 이벤트를 큐잉할지 결정

### 8.2 recoverFromConcurrentError: Hydration 실패 복구

Concurrent 렌더링 중 hydration 에러가 발생하면 `recoverFromConcurrentError`(line 25869)가 호출된다:

```javascript
// line 25869
function recoverFromConcurrentError(root, errorRetryLanes) {
  var errorsFromFirstAttempt = workInProgressRootConcurrentErrors;

  if (isRootDehydrated(root)) {
    // root가 아직 dehydrated → ForceClientRender 설정 후 동기 재렌더
    // prepareFreshStack으로 work-in-progress 리셋
    // ...
  }
  // 에러 없이 동기 렌더 재시도
  // 실패하면 onRecoverableError 콜백으로 에러 전달
}
```

이 함수는 "hydration 실패 → 클라이언트 렌더 폴백"이라는 React 18의 핵심 복구 전략을 구현한다.

---

## 9. getClosestInstanceFromNode: 이벤트와 Hydration의 접점

### 9.1 DOM 노드에서 Fiber 인스턴스 찾기

이벤트 디스패치의 첫 단계는 이벤트 타겟(DOM 노드)에서 대응하는 Fiber 인스턴스를 찾는 것이다. `getClosestInstanceFromNode`(line 11530 부근)는 dehydrated 경계를 올바르게 처리해야 하므로 복잡한 로직을 포함한다:

```javascript
// line 11530 부근 (축약)
function getClosestInstanceFromNode(targetNode) {
  var targetInst = targetNode[internalInstanceKey];

  if (targetInst) {
    return targetInst;
  }

  // React가 소유하지 않는 DOM 노드 → 부모 탐색
  var parentNode = targetNode.parentNode;

  while (parentNode) {
    targetInst = parentNode[internalContainerInstanceKey] ||
                 parentNode[internalInstanceKey];

    if (targetInst) {
      var alternate = targetInst.alternate;

      if (targetInst.child !== null ||
          (alternate !== null && alternate.child !== null)) {
        // dehydrated Suspense 경계 내부인지 확인
        var suspenseInstance = getParentSuspenseInstance(targetNode);

        while (suspenseInstance !== null) {
          // Suspense 인스턴스에 대응하는 Fiber 찾기
          var targetSuspenseInst = suspenseInstance[internalInstanceKey];
          if (targetSuspenseInst) {
            return targetSuspenseInst;
          }
          // 더 상위 Suspense 경계 확인
          suspenseInstance = getParentSuspenseInstance(
            suspenseInstance);
        }
      }

      return targetInst;
    }

    targetNode = parentNode;
    parentNode = parentNode.parentNode;
  }

  return null;
}
```

`internalInstanceKey`(`__reactFiber$` + 랜덤키)와 `internalContainerInstanceKey`(`__reactContainer$` + 랜덤키)는 DOM 노드에 저장된 React 내부 참조다. Hydration 시 `precacheFiberNode`(line 11501)로 설정된다:

```javascript
// line 11501
function precacheFiberNode(hostInst, node) {
  node[internalInstanceKey] = hostInst;
}
```

### 9.2 getParentSuspenseInstance: Suspense 경계 역추적

```javascript
// line 11332 (축약)
function getParentSuspenseInstance(targetInstance) {
  var node = targetInstance.previousSibling;
  var depth = 0;

  while (node) {
    if (node.nodeType === COMMENT_NODE) {
      var data = node.data;
      if (data === SUSPENSE_START_DATA ||
          data === SUSPENSE_FALLBACK_START_DATA ||
          data === SUSPENSE_PENDING_START_DATA) {
        if (depth === 0) {
          return node;  // 현재 Suspense 경계의 시작 마커
        } else {
          depth--;
        }
      } else if (data === SUSPENSE_END_DATA) {
        depth++;  // 중첩된 Suspense 경계 건너뛰기
      }
    }
    node = node.previousSibling;
  }
  return null;
}
```

`previousSibling`을 역순으로 탐색하면서 `depth` 카운터로 중첩 경계를 추적한다. `<!--$-->` 또는 `<!--$?-->` 또는 `<!--$!-->`를 만나면 현재 Suspense 경계의 시작 마커이므로 이를 반환한다.

---

## 10. 커밋 단계의 Hydration 처리

### 10.1 commitHydratedContainer와 commitHydratedSuspenseInstance

Hydration이 성공적으로 완료되면 커밋 단계에서 이벤트 리플레이를 트리거한다:

```javascript
// line 11377
function commitHydratedContainer(container) {
  retryIfBlockedOn(container);
}

// line 11381
function commitHydratedSuspenseInstance(suspenseInstance) {
  retryIfBlockedOn(suspenseInstance);
}
```

두 함수 모두 `retryIfBlockedOn`을 호출한다. 이것이 "hydration 완료 → 이벤트 재생" 연결의 커밋 단계 진입점이다.

### 10.2 커밋 시 Hydration 업데이트 적용

`diffHydratedProperties`에서 반환된 `updatePayload`가 있으면 커밋 단계에서 실제 DOM 수정이 일어난다:

```javascript
// line 24410 (commitMutationEffectsOnFiber 내부, HostComponent case)
if (flags & Update) {
  var _instance4 = finishedWork.stateNode;
  if (_instance4 != null) {
    var newProps = finishedWork.memoizedProps;
    // hydration에서는 updatePath를 재사용하되,
    // oldProps를 newProps로 처리한다
    var oldProps = current !== null ? current.memoizedProps : newProps;
    var type = finishedWork.type;
    var updatePayload = finishedWork.updateQueue;
    finishedWork.updateQueue = null;

    if (updatePayload !== null) {
      commitUpdate(_instance4, updatePayload, type, oldProps, newProps,
        finishedWork);
    }
  }
}
```

주석이 핵심을 말해준다: "For hydration we reuse the update path but we treat the oldProps as the newProps." Hydration에서는 서버 DOM이 이미 올바른 상태라고 가정하므로, oldProps와 newProps를 동일하게 취급한다. `updatePayload`에 담긴 것은 서버/클라이언트 간 차이가 있는 속성들뿐이다.

### 10.3 DehydratedFragment 삭제 처리

클라이언트 렌더로 폴백할 때 DehydratedFragment를 삭제해야 한다:

```javascript
// line 24077 (commitDeletionEffects 내부)
case DehydratedFragment: {
  if (hostParent !== null) {
    if (hostParentIsContainer) {
      clearSuspenseBoundaryFromContainer(hostParent,
        deletedFiber.stateNode);
    } else {
      clearSuspenseBoundary(hostParent, deletedFiber.stateNode);
    }
  }
  return;
}
```

`clearSuspenseBoundary`가 마커 사이의 모든 DOM 노드를 제거하고, `retryIfBlockedOn`으로 블록된 이벤트의 재생을 트리거한다.

---

## 11. suppressHydrationWarning의 내부 동작

### 11.1 어디서 체크되는가

`suppressHydrationWarning` prop은 세 곳에서 체크된다:

```javascript
// 1. diffHydratedProperties (line 10309) - 텍스트 콘텐츠 불일치
if (rawProps[SUPPRESS_HYDRATION_WARNING] !== true) {
  checkForUnmatchedText(domElement.textContent, nextProp, ...);
}

// 2. didNotMatchHydratedTextInstance (line 11392) - 텍스트 노드 불일치
if (parentProps[SUPPRESS_HYDRATION_WARNING$1] !== true) {
  checkForUnmatchedText(textInstance.nodeValue, text, ...);
}

// 3. didNotHydrateInstance (line 11422) - 노드 삭제 경고
if (isConcurrentMode || parentProps[SUPPRESS_HYDRATION_WARNING$1] !== true) {
  // 경고 출력
}
```

중요한 점은 `suppressHydrationWarning`이 **경고만 억제**한다는 것이다. Concurrent Mode에서 실제 mismatch로 인한 클라이언트 렌더 폴백은 억제하지 못한다. `checkForUnmatchedText`의 마지막 부분에서 `isConcurrentMode && enableClientRenderFallbackOnTextMismatch`일 때 에러를 throw하는 것은 `suppressHydrationWarning`과 무관하게 동작한다.

---

## 12. 성능 관점: Hydration의 비용과 최적화

### 12.1 Hydration의 실제 비용

Hydration은 "DOM을 생성하지 않는다"는 점에서 순수 클라이언트 렌더보다 빠르다고 흔히 알려져 있지만, 실제로는 다음의 비용이 발생한다:

1. **Fiber 트리 전체 구축**: 모든 컴포넌트를 실행해야 한다
2. **DOM 트리 순회**: `nextSibling`, `firstChild` 호출
3. **속성 비교**: `diffHydratedProperties`에서 모든 props를 비교
4. **이벤트 리스너 등록**: 개별 요소의 non-delegated 이벤트 등록

### 12.2 Suspense 경계 배치 전략

Selective Hydration의 효과를 극대화하려면 Suspense 경계를 전략적으로 배치해야 한다:

```
좋은 배치:
<App>
  <Header />                    ← 즉시 hydrate (상호작용 필요)
  <Suspense fallback={...}>
    <MainContent />             ← lazy hydrate (스크롤 시)
  </Suspense>
  <Suspense fallback={...}>
    <Sidebar />                 ← lazy hydrate (상호작용 시)
  </Suspense>
  <Suspense fallback={...}>
    <Comments />                ← lazy hydrate (필요 시)
  </Suspense>
</App>
```

각 Suspense 경계는 독립적으로 hydrate되므로:
- 사용자가 댓글 영역을 클릭하면 → `Comments`만 동기 hydrate
- 나머지는 idle 시간에 백그라운드로 진행
- 서버에서 `$?` 마커로 보낸 경계는 콘텐츠 도착 시 자동 hydrate

### 12.3 흔한 Hydration Mismatch 원인과 해결

| 원인 | 예시 | 해결 |
|-----|------|------|
| 타임스탬프/날짜 | `Date.now()`, `new Date()` | `useEffect`에서 설정 |
| 랜덤값 | `Math.random()`, UUID 생성 | 서버에서 생성하여 전달 |
| 브라우저 전용 API | `window.innerWidth` | `useEffect` + state |
| 로케일 차이 | `toLocaleDateString()` | `suppressHydrationWarning` 또는 서버 로케일 통일 |
| 서드파티 확장 | 브라우저 확장이 DOM 수정 | `<head>`, `<body>` 외부에 중요 콘텐츠 배치 |
| 조건부 렌더링 | `typeof window !== 'undefined'` | 초기값 통일 후 `useEffect`에서 변경 |

---

## 13. 전체 흐름 요약: 처음부터 끝까지

```
┌─────────────────────────────────────────────────────────────┐
│ 서버                                                        │
│   renderToPipeableStream(<App />)                           │
│   → HTML 생성: <!--$-->, <!--$?-->, <!--/$--> 마커 포함     │
│   → 스트리밍 전송                                            │
└─────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│ 브라우저: HTML 파싱 → DOM 트리 구축 → 화면에 표시 (FCP)       │
│   이 시점에서는 상호작용 불가능                                 │
└─────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│ JS 번들 로드 + 실행                                          │
│                                                             │
│ hydrateRoot(container, <App />)                             │
│   │                                                         │
│   ├─ createHydrationContainer()                             │
│   │    createFiberRoot(hydrate=true)                        │
│   │    _initialState.isDehydrated = true                    │
│   │    scheduleInitialHydrationOnRoot()                     │
│   │                                                         │
│   ├─ markContainerAsRoot()                                  │
│   │    container.__reactContainer$ = root.current           │
│   │                                                         │
│   └─ listenToAllSupportedEvents(container)                  │
│        → 이벤트 위임 등록 (이벤트 캡처 가능 상태)              │
└─────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│ Render Phase (Concurrent)                                   │
│                                                             │
│ beginWork(HostRoot)                                         │
│   isDehydrated → true                                       │
│   enterHydrationState()                                     │
│     nextHydratableInstance = container.firstChild            │
│     isHydrating = true                                      │
│                                                             │
│   mountChildFibers()                                        │
│   각 자식에 Hydrating 플래그 설정                              │
│                                                             │
│ beginWork(HostComponent: <div>)                             │
│   tryToClaimNextHydratableInstance()                        │
│     tryHydrate() → canHydrateInstance()                     │
│     fiber.stateNode = DOM 노드                              │
│     nextHydratableInstance = firstChild                     │
│                                                             │
│ beginWork(SuspenseComponent)                                │
│   tryToClaimNextHydratableInstance()                        │
│     tryHydrate() → canHydrateSuspenseInstance()             │
│     ├─ <!--$--> → 정상 hydration 진행                       │
│     ├─ <!--$?--> → pending 대기                             │
│     └─ <!--$!--> → 클라이언트 렌더 폴백                      │
│                                                             │
│ completeWork(HostComponent)                                 │
│   popHydrationState()                                       │
│   prepareToHydrateHostInstance()                            │
│     hydrateInstance() → diffHydratedProperties()            │
│     → updatePayload (속성 차이 목록)                         │
│                                                             │
│ completeWork(SuspenseComponent)                             │
│   completeDehydratedSuspenseBoundary()                      │
│     prepareToHydrateHostSuspenseInstance()                  │
└─────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│ Commit Phase                                                │
│                                                             │
│ commitMutationEffects                                       │
│   ├─ HostComponent + Update:                                │
│   │    commitUpdate(instance, updatePayload, ...)           │
│   │    → 서버/클라이언트 차이 속성 패치                       │
│   │                                                         │
│   ├─ DehydratedFragment 삭제 (폴백 시):                     │
│   │    clearSuspenseBoundary()                              │
│   │    retryIfBlockedOn()                                   │
│   │                                                         │
│   └─ SuspenseComponent:                                     │
│        commitHydratedSuspenseInstance()                     │
│        retryIfBlockedOn() → 이벤트 리플레이 트리거            │
│                                                             │
│ → 상호작용 가능 (TTI)                                        │
└─────────────────────────────────────────────────────────────┘
                    │
                    ▼ (사용자가 아직 dehydrated 영역 클릭 시)
┌─────────────────────────────────────────────────────────────┐
│ Selective Hydration + Event Replay                          │
│                                                             │
│ dispatchEvent()                                             │
│   findInstanceBlockingEvent()                               │
│     → SuspenseComponent의 dehydrated 인스턴스 반환           │
│                                                             │
│ Discrete Event:                                             │
│   attemptSynchronousHydration(fiber) → 동기 hydration       │
│   → 완료 후 즉시 이벤트 디스패치                               │
│                                                             │
│ Continuous Event:                                           │
│   queuedFocus/queuedDrag/queuedMouse에 저장                │
│   attemptContinuousHydration(fiber)                         │
│   → hydration 완료 후 replayUnblockedEvents()               │
│                                                             │
│ retryIfBlockedOn(unblocked)                                 │
│   scheduleCallbackIfUnblocked()                             │
│   → Scheduler.unstable_scheduleCallback(NormalPriority,     │
│       replayUnblockedEvents)                                │
│   → nativeEvent.target.dispatchEvent(nativeEventClone)      │
└─────────────────────────────────────────────────────────────┘
```

---

## 마무리: Hydration은 왜 이렇게 복잡한가

Hydration이 복잡한 근본적 이유는 "두 개의 서로 다른 환경(서버와 클라이언트)에서 생산된 결과물을 하나로 합치는" 작업이기 때문이다. 서버는 HTML 문자열만 만들 수 있고, 클라이언트는 이벤트와 상태를 관리해야 한다. 이 간극을 메우는 과정에서 필연적으로 다음 문제들이 발생한다:

1. **불일치 가능성**: 서버와 클라이언트의 실행 환경이 다르므로 동일한 코드가 다른 결과를 낼 수 있다
2. **점진적 처리 필요**: 전체를 한 번에 hydrate하면 메인 스레드가 블록되므로 Suspense 단위 분할이 필요하다
3. **이벤트 시간성**: hydration이 완료되기 전에 사용자 이벤트가 발생할 수 있으므로 큐잉과 리플레이가 필요하다
4. **에러 복구**: hydration 실패 시 전체가 아닌 부분적 클라이언트 렌더로 복구해야 한다

React 18의 Hydration 시스템은 이 모든 문제를 Fiber 아키텍처, Lane 우선순위 시스템, Suspense 경계라는 기존 인프라 위에서 해결한다. 결과적으로 코드는 복잡하지만, 사용자 입장에서는 "서버에서 빠르게 보이고, 상호작용이 자연스럽게 이어지는" 경험을 얻게 된다.

---

[← 이전: SSR](./react-architecture-08-ssr.md) | [다음: 상태 관리 라이브러리 →](./react-architecture-10-state-management.md)
