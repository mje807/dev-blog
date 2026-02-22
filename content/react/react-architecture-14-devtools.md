# React 18 DevTools 아키텍처 소스 코드 분석

> 시리즈: React 아키텍처 심층 분석 - 14편 (최종편)
> 분석 대상: react-dom@18.3.1 -- DevTools 통합 코드 분석
> 소스 경로: `node_modules/.pnpm/react-dom@18.3.1/node_modules/react-dom/cjs/react-dom.development.js`

---

## 들어가며

React DevTools는 단순한 디버깅 도구가 아니다. React 내부 아키텍처에 깊이 연결된 **관측 시스템(Observability System)** 이다. DevTools가 컴포넌트 트리를 실시간으로 보여주고, props/state를 편집하고, 렌더링 성능을 프로파일링할 수 있는 이유는 React 런타임 자체에 DevTools를 위한 코드가 내장되어 있기 때문이다.

이 글에서는 react-dom 18.3.1 소스 코드(29,923줄)에서 DevTools 관련 코드를 모두 추적하며 다음 질문에 답한다:

1. DevTools는 어떻게 React에 자신을 등록하는가?
2. React는 커밋할 때마다 DevTools에 무엇을 알려주는가?
3. DOM 노드에서 Fiber를 어떻게 찾는가?
4. DevTools는 어떻게 props/state/hooks를 실시간으로 편집하는가?
5. Profiler는 어떤 데이터를 수집하고, 어떻게 시각화에 제공하는가?
6. Timeline Profiler는 어떤 원리로 동작하는가?

---

## 1. 전체 아키텍처 개요

DevTools와 React 런타임의 관계를 다이어그램으로 그리면 다음과 같다:

```
+------------------------------------------------------------------+
|                        Browser Extension                          |
|  +-------------------+    +--------+    +----------------------+  |
|  |    DevTools UI     |<-->| Bridge |<-->|      Backend         |  |
|  |   (Frontend)       |    | (port) |    |  (Content Script)    |  |
|  +-------------------+    +--------+    +----------+-----------+  |
+-----------------------------------------------|-------------------+
                                                |
                            window.__REACT_DEVTOOLS_GLOBAL_HOOK__
                                                |
+-----------------------------------------------v-------------------+
|                         React Runtime                              |
|                                                                    |
|  Module Start                                                      |
|  registerInternalModuleStart(new Error())  ----+                   |
|                                                |                   |
|  injectInternals(internals)                    |  Stack Trace      |
|       |                                        |  기반 모듈 경계   |
|       +-- hook.inject(internals) --> rendererID|  추적             |
|       +-- injectedHook = hook                  |                   |
|                                                |                   |
|  Reconciler Loop:                              |                   |
|    onScheduleRoot(root, element)               |                   |
|    onCommitRoot(root, priority)                |                   |
|    onPostCommitRoot(root)                      |                   |
|    onCommitUnmount(fiber)                      |                   |
|                                                |                   |
|  Module End                                    |                   |
|  registerInternalModuleStop(new Error())  -----+                   |
+--------------------------------------------------------------------+
```

핵심 통신 흐름은 다음과 같다:

```
DevTools Backend                 React DOM
     |                              |
     |-- inject content script ---> |
     |                              |
     |   window.__REACT_DEVTOOLS    |
     |   _GLOBAL_HOOK__ 설정        |
     |                              |
     |                   <--------- | hook.inject(internals)
     |                              |   rendererID 반환
     |                              |
     |                   <--------- | onCommitFiberRoot(id, root, priority, didError)
     |                   <--------- | onCommitFiberUnmount(id, fiber)
     |                   <--------- | onPostCommitFiberRoot(id, root)
     |                              |
     | --- overrideHookState -----> |
     | --- overrideProps ---------> |
     | --- scheduleUpdate --------> |
     |                              |
```

---

## 2. 모듈 경계 등록: registerInternalModule

React DOM 소스 코드의 가장 바깥쪽, 즉 모듈의 시작과 끝에 DevTools를 위한 코드가 있다:

```javascript
// L18-24: 모듈 시작 지점
/* global __REACT_DEVTOOLS_GLOBAL_HOOK__ */
if (
  typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined' &&
  typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart ===
    'function'
) {
  __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart(new Error());
}
```

```javascript
// L29913-29919: 모듈 끝 지점
if (
  typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined' &&
  typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop ===
    'function'
) {
  __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop(new Error());
}
```

`new Error()`를 전달하는 이유가 흥미롭다. Error 객체에는 **스택 트레이스**가 포함되어 있고, 이 스택 트레이스에서 파일 경로와 라인 번호를 추출할 수 있다. DevTools는 이를 이용해 "이 코드가 React 내부 모듈에서 온 것인지"를 판별한다. 사용자 코드와 React 내부 코드를 구분하는 데 쓰이며, 컴포넌트 스택 트레이스에서 React 내부 프레임을 필터링할 때 활용된다.

```
registerInternalModuleStart(err1)  -- err1.stack에서 시작 파일/라인 추출
     ... React DOM 내부 코드 전체 ...
registerInternalModuleStop(err2)   -- err2.stack에서 끝 파일/라인 추출

=> 이 범위 안의 스택 프레임 = React 내부 코드 (DevTools에서 숨김 처리)
```

---

## 3. 전역 훅과 렌더러 등록

### 3.1 `__REACT_DEVTOOLS_GLOBAL_HOOK__`

DevTools 확장이 설치되면, 페이지 로드 시 content script가 `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`이라는 전역 객체를 생성한다. 이 객체는 다음과 같은 인터페이스를 갖는다:

```
__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  isDisabled: boolean,
  supportsFiber: boolean,
  inject: (internals) => rendererID,
  onCommitFiberRoot: (rendererID, root, priority, didError) => void,
  onCommitFiberUnmount: (rendererID, fiber) => void,
  onPostCommitFiberRoot: (rendererID, root) => void,
  onScheduleFiberRoot: (rendererID, root, children) => void,
  setStrictMode: (rendererID, isStrict) => void,
  registerInternalModuleStart: (error) => void,
  registerInternalModuleStop: (error) => void,
  checkDCE: boolean,          // Dead Code Elimination 체크
  ...
}
```

React DOM은 이 전역 훅의 존재 여부를 딱 **한 곳**에서 검사한다:

```javascript
// L4777
var isDevToolsPresent = typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined';
```

이 변수는 이후 DevTools 전용 로직의 게이트로 사용된다. 예를 들어, `addFiberToLanesMap` 같은 비용이 있는 추적 작업은 DevTools가 없으면 아예 건너뛴다:

```javascript
// L5915-5917
function addFiberToLanesMap(root, fiber, lanes) {
  if (!isDevToolsPresent) {
    return;  // DevTools 없으면 추적 안 함 -> 성능 오버헤드 제거
  }
  var pendingUpdatersLaneMap = root.pendingUpdatersLaneMap;
  while (lanes > 0) {
    var index = laneToIndex(lanes);
    var lane = 1 << index;
    var updaters = pendingUpdatersLaneMap[index];
    updaters.add(fiber);
    lanes &= ~lane;
  }
}
```

### 3.2 `injectInternals`: React가 DevTools에 자신을 등록하는 순간

React DOM 모듈의 맨 마지막 부분에서, 초기화 시점에 `injectIntoDevTools`가 호출된다:

```javascript
// L29880-29885
var foundDevTools = injectIntoDevTools({
  findFiberByHostInstance: getClosestInstanceFromNode,
  bundleType: 1,        // 1 = development, 0 = production
  version: ReactVersion,
  rendererPackageName: 'react-dom'
});
```

`bundleType: 1`은 development 빌드임을 알려준다. Production 빌드에서는 이 값이 0이 된다. DevTools가 설치되지 않았을 때는 콘솔에 다운로드 안내 메시지를 표시한다:

```javascript
// L29887-29901
if (!foundDevTools && canUseDOM && window.top === window.self) {
  if (navigator.userAgent.indexOf('Chrome') > -1 &&
      navigator.userAgent.indexOf('Edge') === -1 ||
      navigator.userAgent.indexOf('Firefox') > -1) {
    var protocol = window.location.protocol;
    if (/^(https?|file):$/.test(protocol)) {
      console.info(
        '%cDownload the React DevTools for a better development experience: ...',
        'font-weight:bold'
      );
    }
  }
}
```

`injectIntoDevTools`는 내부적으로 `injectInternals`를 호출한다:

```javascript
// L29277-29307
function injectIntoDevTools(devToolsConfig) {
  var findFiberByHostInstance = devToolsConfig.findFiberByHostInstance;
  var ReactCurrentDispatcher = ReactSharedInternals.ReactCurrentDispatcher;
  return injectInternals({
    bundleType: devToolsConfig.bundleType,
    version: devToolsConfig.version,
    rendererPackageName: devToolsConfig.rendererPackageName,
    rendererConfig: devToolsConfig.rendererConfig,
    overrideHookState: overrideHookState,
    overrideHookStateDeletePath: overrideHookStateDeletePath,
    overrideHookStateRenamePath: overrideHookStateRenamePath,
    overrideProps: overrideProps,
    overridePropsDeletePath: overridePropsDeletePath,
    overridePropsRenamePath: overridePropsRenamePath,
    setErrorHandler: setErrorHandler,
    setSuspenseHandler: setSuspenseHandler,
    scheduleUpdate: scheduleUpdate,
    currentDispatcherRef: ReactCurrentDispatcher,
    findHostInstanceByFiber: findHostInstanceByFiber,
    findFiberByHostInstance: findFiberByHostInstance || emptyFindFiberByHostInstance,
    // React Refresh
    findHostInstancesForRefresh: findHostInstancesForRefresh,
    scheduleRefresh: scheduleRefresh,
    scheduleRoot: scheduleRoot,
    setRefreshHandler: setRefreshHandler,
    // DevTools가 owner 스택을 오류 메시지에 추가할 수 있게 함
    getCurrentFiber: getCurrentFiberForDevTools,
    // 렌더러 버전이 아닌 reconciler 버전 감지용
    reconcilerVersion: ReactVersion
  });
}
```

이 `internals` 객체가 DevTools에 전달되는 핵심 인터페이스다. 주목할 점은 DevTools가 React 내부의 **양방향 채널**을 확보한다는 것이다:

```
React -> DevTools (관측용):
  - getCurrentFiber: 현재 렌더링 중인 Fiber
  - findHostInstanceByFiber: Fiber에서 DOM 노드 찾기
  - findFiberByHostInstance: DOM 노드에서 Fiber 찾기

DevTools -> React (조작용):
  - overrideHookState: Hook 상태 편집
  - overrideProps: Props 편집
  - scheduleUpdate: 강제 리렌더링
  - setErrorHandler: 에러 핸들러 주입
  - setSuspenseHandler: Suspense 핸들러 주입

React Refresh (HMR):
  - scheduleRefresh, scheduleRoot, setRefreshHandler
```

### 3.3 `hook.inject()`와 rendererID

```javascript
// L4778-4828
function injectInternals(internals) {
  if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ === 'undefined') {
    return false;  // DevTools 없음
  }

  var hook = __REACT_DEVTOOLS_GLOBAL_HOOK__;

  if (hook.isDisabled) {
    return true;  // 의도적 비활성화
  }

  if (!hook.supportsFiber) {
    error('The installed version of React DevTools is too old...');
    return true;  // Fiber 미지원 버전
  }

  try {
    if (enableSchedulingProfiler) {
      // Timeline profiler가 지원되는 빌드인 경우에만 주입
      internals = assign({}, internals, {
        getLaneLabelMap: getLaneLabelMap,
        injectProfilingHooks: injectProfilingHooks
      });
    }

    rendererID = hook.inject(internals);  // 핵심! DevTools에 등록
    injectedHook = hook;                  // 이후 콜백 호출용 참조 저장
  } catch (err) {
    error('React instrumentation encountered an error: %s.', err);
  }

  if (hook.checkDCE) {
    return true;   // 진짜 DevTools
  } else {
    return false;  // Fast Refresh 런타임일 수 있음
  }
}
```

여기서 **rendererID**가 매우 중요하다. 하나의 페이지에 여러 React 렌더러가 공존할 수 있기 때문이다:

```
페이지 내 렌더러들:
  rendererID=1: react-dom (메인 앱)
  rendererID=2: react-dom (마이크로 프론트엔드)
  rendererID=3: react-three-fiber (3D 캔버스)
  rendererID=4: react-native-web (하이브리드 컴포넌트)
```

각 렌더러가 `hook.inject()`를 호출하면 고유한 rendererID를 받고, 이후 모든 콜백에서 이 ID를 첫 번째 인자로 전달한다. DevTools Backend는 이 ID로 어떤 렌더러에서 온 이벤트인지 구분한다.

---

## 4. Fiber-to-DOM 연결: 숨겨진 프로퍼티 키

DevTools의 "Inspect Element" 기능은 DOM 노드를 클릭하면 해당 React 컴포넌트를 하이라이트한다. 이것이 가능한 이유는 React가 모든 DOM 노드에 비밀 프로퍼티를 심어두기 때문이다:

```javascript
// L11480-11486
var randomKey = Math.random().toString(36).slice(2);
var internalInstanceKey = '__reactFiber$' + randomKey;
var internalPropsKey = '__reactProps$' + randomKey;
var internalContainerInstanceKey = '__reactContainer$' + randomKey;
var internalEventHandlersKey = '__reactEvents$' + randomKey;
var internalEventHandlerListenersKey = '__reactListeners$' + randomKey;
var internalEventHandlesSetKey = '__reactHandles$' + randomKey;
```

`randomKey`는 매 페이지 로드마다 달라지는 랜덤 문자열이다. 이로 인해 실제 DOM 노드의 프로퍼티 이름은 `__reactFiber$k2f9a8b`처럼 된다. 랜덤 접미사를 붙이는 이유는 다음과 같다:

1. **다중 React 인스턴스 충돌 방지**: 같은 페이지에 여러 React 버전이 있을 때 프로퍼티 충돌 방지
2. **외부 코드의 의존 방지**: 키 이름이 매번 바뀌므로 외부 라이브러리가 이 프로퍼티에 의존할 수 없음

### 4.1 DOM -> Fiber 연결 설정

```javascript
// L11498
function precacheFiberNode(hostInst, node) {
  node[internalInstanceKey] = hostInst;  // DOM 노드에 Fiber 참조 저장
}
```

```javascript
// L11500-11502
function markContainerAsRoot(hostRoot, node) {
  node[internalContainerInstanceKey] = hostRoot;  // 루트 컨테이너 마킹
}
```

### 4.2 DOM -> Fiber 검색 알고리즘

`getClosestInstanceFromNode`는 DevTools에서 DOM 노드를 Fiber로 변환하는 핵심 함수다:

```javascript
// L11516-11590 (간략화)
function getClosestInstanceFromNode(targetNode) {
  // 1단계: 직접 매핑된 Fiber가 있는지 확인
  var targetInst = targetNode[internalInstanceKey];
  if (targetInst) {
    return targetInst;
  }

  // 2단계: 부모 노드를 따라 올라가며 검색
  var parentNode = targetNode.parentNode;
  while (parentNode) {
    targetInst = parentNode[internalContainerInstanceKey]
              || parentNode[internalInstanceKey];

    if (targetInst) {
      // 3단계: Suspense 경계 처리 (hydration 전 노드)
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

이 함수의 알고리즘을 시각화하면:

```
DOM Tree                            Fiber Tree
---------                           -----------
<div id="root">                     FiberRoot
  |- <div>  __reactFiber$xxx -----> HostComponent(div)
  |   |- <span>  (no fiber) ---+        |
  |   |   |- "text"            |    HostComponent(span)
  |   |                        |
  |   +-- 부모를 따라 올라감 ---+
  |
  |- <!-- Suspense -->             SuspenseComponent
  |   |- <div> (hydration 전)      DehydratedFragment
```

Suspense 경계 처리가 복잡한 이유는, hydration이 아직 완료되지 않은 DOM 노드는 `internalInstanceKey`를 가지지 않기 때문이다. 이 경우 부모 Suspense 경계를 찾아서 반환한다.

### 4.3 Fiber -> DOM 검색

반대 방향의 검색은 더 단순하다:

```javascript
// L29260-29266
function findHostInstanceByFiber(fiber) {
  var hostFiber = findCurrentHostFiber(fiber);
  if (hostFiber === null) {
    return null;
  }
  return hostFiber.stateNode;  // Fiber의 stateNode가 DOM 노드
}
```

`findCurrentHostFiber`는 Fiber 트리를 아래로 순회하며 가장 가까운 HostComponent(실제 DOM 노드를 가진 Fiber)를 찾는다.

---

## 5. 커밋 단계 훅: React가 DevTools에 알리는 순간들

React 런타임에서 DevTools로 콜백이 호출되는 네 가지 시점이 있다.

### 5.1 `onScheduleRoot` -- 렌더링 요청 시점

```javascript
// L4831-4843
function onScheduleRoot(root, children) {
  if (injectedHook && typeof injectedHook.onScheduleFiberRoot === 'function') {
    try {
      injectedHook.onScheduleFiberRoot(rendererID, root, children);
    } catch (err) {
      if (!hasLoggedError) {
        hasLoggedError = true;
        error('React instrumentation encountered an error: %s', err);
      }
    }
  }
}
```

호출 시점:

```javascript
// L28849 - updateContainer 내부
function updateContainer(element, container, parentComponent, callback) {
  {
    onScheduleRoot(container, element);  // DevTools에 렌더 스케줄 알림
  }
  var current$1 = container.current;
  var eventTime = requestEventTime();
  var lane = requestUpdateLane(current$1);
  // ...
}
```

`updateContainer`는 `ReactDOM.render()` 또는 `root.render()`가 호출될 때 실행된다. DevTools는 이 시점에 "어떤 루트에 어떤 엘리먼트가 렌더링 예정인지"를 알게 된다.

### 5.2 `onCommitRoot` -- 커밋 완료 시점

가장 중요한 훅이다. React가 DOM에 변경사항을 반영한 직후 호출된다:

```javascript
// L4846-4884
function onCommitRoot(root, eventPriority) {
  if (injectedHook && typeof injectedHook.onCommitFiberRoot === 'function') {
    try {
      var didError = (root.current.flags & DidCapture) === DidCapture;

      if (enableProfilerTimer) {
        var schedulerPriority;

        switch (eventPriority) {
          case DiscreteEventPriority:
            schedulerPriority = ImmediatePriority;
            break;
          case ContinuousEventPriority:
            schedulerPriority = UserBlockingPriority;
            break;
          case DefaultEventPriority:
            schedulerPriority = NormalPriority;
            break;
          case IdleEventPriority:
            schedulerPriority = IdlePriority;
            break;
          default:
            schedulerPriority = NormalPriority;
            break;
        }

        injectedHook.onCommitFiberRoot(
          rendererID, root, schedulerPriority, didError
        );
      } else {
        injectedHook.onCommitFiberRoot(
          rendererID, root, undefined, didError
        );
      }
    } catch (err) { /* ... */ }
  }
}
```

호출 위치는 `commitRootImpl`의 거의 마지막이다:

```javascript
// L26926
onCommitRoot(finishedWork.stateNode, renderPriorityLevel);

// L26929-26931 - DevTools를 위한 updaters 추적 정리
if (isDevToolsPresent) {
  root.memoizedUpdaters.clear();
}

// L26935 - 테스트 프레임워크용 commit hook
onCommitRoot$1();
```

DevTools가 `onCommitFiberRoot`를 받으면 **FiberRoot를 순회**하여 변경된 Fiber들을 감지하고, 컴포넌트 트리 UI를 갱신한다. 전달되는 정보를 정리하면:

```
onCommitFiberRoot(rendererID, root, schedulerPriority, didError)
  |
  |-- rendererID: 어떤 렌더러인지
  |-- root: FiberRoot (root.current = 현재 Fiber 트리)
  |   |-- root.current: HostRoot Fiber
  |   |-- root.current.alternate: 이전 Fiber 트리 (비교용)
  |   |-- root.memoizedUpdaters: 이번 커밋을 트리거한 Fiber들
  |-- schedulerPriority: 이벤트 우선순위
  |   |-- ImmediatePriority (1): 클릭, 입력 등 discrete 이벤트
  |   |-- UserBlockingPriority (2): 스크롤 등 continuous 이벤트
  |   |-- NormalPriority (3): 기본 우선순위
  |   |-- IdlePriority (5): 유휴 시간 업데이트
  |-- didError: Error Boundary에서 에러가 캡처되었는지
```

### 5.3 `onPostCommitRoot` -- Passive Effects 완료 후

```javascript
// L4891-4904
function onPostCommitRoot(root) {
  if (injectedHook && typeof injectedHook.onPostCommitFiberRoot === 'function') {
    try {
      injectedHook.onPostCommitFiberRoot(rendererID, root);
    } catch (err) { /* ... */ }
  }
}
```

이 훅은 `flushPassiveEffects` 완료 후 호출된다:

```javascript
// L27120
onPostCommitRoot(root);

// 직후에 effect duration 리셋
var stateNode = root.current.stateNode;
stateNode.effectDuration = 0;
stateNode.passiveEffectDuration = 0;
```

`useEffect` 콜백들이 모두 실행된 후이므로, DevTools Profiler는 이 시점에 passive effect의 실행 시간을 수집할 수 있다. `effectDuration`과 `passiveEffectDuration`이 리셋되기 **직전**에 호출되므로, DevTools가 이 값들을 읽을 수 있는 마지막 기회다.

### 5.4 `onCommitUnmount` -- Fiber 언마운트 시점

```javascript
// L4906-4915
function onCommitUnmount(fiber) {
  if (injectedHook && typeof injectedHook.onCommitFiberUnmount === 'function') {
    try {
      injectedHook.onCommitFiberUnmount(rendererID, fiber);
    } catch (err) { /* ... */ }
  }
}
```

컴포넌트가 트리에서 제거될 때 호출된다. DevTools는 이 콜백으로 컴포넌트 트리에서 해당 노드를 제거하고, 관련 리소스를 정리한다.

### 5.5 네 훅의 타이밍 관계

```
updateContainer() 호출
    |
    v
onScheduleRoot(root, element)     <-- "렌더링 예정이야"
    |
    v
[Render Phase - work loop]
    |
    v
[Commit Phase]
    |- commitMutationEffects       <-- DOM 변경
    |- onCommitUnmount(fiber)      <-- 삭제된 컴포넌트 알림
    |- commitLayoutEffects         <-- useLayoutEffect 실행
    |- onCommitRoot(root, pri)     <-- "커밋 끝났어"
    |
    v
[Passive Effects - 비동기]
    |- flushPassiveEffects          <-- useEffect 실행
    |- onPostCommitRoot(root)       <-- "passive effect도 끝났어"
```

---

## 6. 컴포넌트 이름 해석

DevTools에서 컴포넌트 트리에 표시되는 이름은 `getComponentNameFromFiber` 함수가 결정한다:

```javascript
// L1405-1497 (간략화)
function getComponentNameFromFiber(fiber) {
  var tag = fiber.tag, type = fiber.type;

  switch (tag) {
    case CacheComponent:        return 'Cache';
    case ContextConsumer:       return getContextName$1(type) + '.Consumer';
    case ContextProvider:       return getContextName$1(type._context) + '.Provider';
    case DehydratedFragment:    return 'DehydratedFragment';
    case ForwardRef:            return getWrappedName$1(type, type.render, 'ForwardRef');
    case Fragment:              return 'Fragment';
    case HostComponent:         return type;  // 'div', 'span' 등
    case HostPortal:            return 'Portal';
    case HostRoot:              return 'Root';
    case HostText:              return 'Text';
    case LazyComponent:         return getComponentNameFromType(type);
    case Mode:
      if (type === REACT_STRICT_MODE_TYPE) return 'StrictMode';
      return 'Mode';
    case OffscreenComponent:    return 'Offscreen';
    case Profiler:              return 'Profiler';
    case ScopeComponent:        return 'Scope';
    case SuspenseComponent:     return 'Suspense';
    case SuspenseListComponent: return 'SuspenseList';
    case TracingMarkerComponent: return 'TracingMarker';

    // 사용자 정의 컴포넌트
    case ClassComponent:
    case FunctionComponent:
    case IncompleteClassComponent:
    case IndeterminateComponent:
    case MemoComponent:
    case SimpleMemoComponent:
      if (typeof type === 'function') {
        return type.displayName || type.name || null;
      }
      if (typeof type === 'string') {
        return type;
      }
      break;
  }
  return null;
}
```

이름 해석의 우선순위 체인을 정리하면:

```
사용자 컴포넌트 이름 해석:
  1. type.displayName    (명시적 설정)
  2. type.name           (함수 이름)
  3. null                (익명 컴포넌트)

래퍼 컴포넌트 이름 해석:
  - ForwardRef:  "ForwardRef(InnerName)"
  - Memo:        type.displayName || "Memo"
  - Lazy:        init(payload)의 이름 해석 시도
  - Context:     "ContextDisplayName.Provider" / ".Consumer"
```

이것이 바로 DevTools에서 "Anonymous"나 "ForwardRef"만 표시될 때, `displayName`을 설정해야 하는 이유다:

```javascript
// 이렇게 하면 DevTools에서 'Anonymous'로 표시됨
const MyComponent = memo(() => <div/>);

// displayName을 설정하면 'MyComponent'로 표시됨
const MyComponent = memo(() => <div/>);
MyComponent.displayName = 'MyComponent';
```

---

## 7. 현재 Fiber 추적: `getCurrentFiber`

DevTools가 오류 발생 시 컴포넌트 스택을 보여줄 수 있는 이유는 `current`라는 모듈 수준 변수 때문이다:

```javascript
// L1496
var current = null;
var isRendering = false;

// L1526-1537
function resetCurrentFiber() {
  ReactDebugCurrentFrame.getCurrentStack = null;
  current = null;
  isRendering = false;
}

function setCurrentFiber(fiber) {
  ReactDebugCurrentFrame.getCurrentStack = getCurrentFiberStackInDev;
  current = fiber;
}
```

React가 각 Fiber를 처리할 때 `setCurrentFiber(fiber)`를 호출하고, 처리가 끝나면 `resetCurrentFiber()`를 호출한다. DevTools는 `getCurrentFiberForDevTools`를 통해 이 값을 읽는다:

```javascript
// L29272-29274
function getCurrentFiberForDevTools() {
  return current;
}
```

이 함수는 `injectIntoDevTools`에서 `getCurrentFiber`라는 이름으로 DevTools에 전달된다. DevTools는 이를 통해 **지금 이 순간 React가 어떤 컴포넌트를 처리하고 있는지** 알 수 있다.

### 7.1 `_debugOwner`: 소유자 추적

```javascript
// L1503-1511
function getCurrentFiberOwnerNameInDevOrNull() {
  if (current === null) {
    return null;
  }
  var owner = current._debugOwner;
  if (owner !== null && typeof owner !== 'undefined') {
    return getComponentNameFromFiber(owner);
  }
  return null;
}
```

`_debugOwner`는 FiberNode의 DEV 전용 필드로, "이 컴포넌트를 JSX로 렌더링한 부모 컴포넌트"를 가리킨다:

```javascript
// L28128-28131 - FiberNode 생성자
this._debugSource = null;       // 소스 파일 위치
this._debugOwner = null;        // 소유자 Fiber
this._debugNeedsRemount = false; // HMR 리마운트 필요 여부
this._debugHookTypes = null;     // Hook 타입 배열
```

`_debugOwner`는 `parent`와 다르다. `parent`(Fiber에서는 `return`)는 Fiber 트리의 구조적 부모이고, `_debugOwner`는 JSX를 생성한 컴포넌트다:

```
// <App>이 <Layout>을 렌더링하고, <Layout>이 <div>를 렌더링한 경우:
//
// Fiber.return (구조적 부모):  div -> Layout -> App -> HostRoot
// _debugOwner (JSX 소유자):   div._debugOwner = Layout
//                             Layout._debugOwner = App
```

---

## 8. Props/State/Hooks 실시간 편집

DevTools에서 가장 인상적인 기능 중 하나는 컴포넌트의 props, state, hooks 값을 실시간으로 편집할 수 있다는 것이다. 이것이 가능한 이유는 React가 DevTools에 편집 함수를 제공하기 때문이다.

### 8.1 Hook 검색: `findHook`

```javascript
// L29127-29134
var findHook = function (fiber, id) {
  // id는 stateful hook의 인덱스 (0부터 시작)
  var currentHook = fiber.memoizedState;

  while (currentHook !== null && id > 0) {
    currentHook = currentHook.next;
    id--;
  }

  return currentHook;
};
```

이 함수는 Fiber의 `memoizedState` 연결 리스트를 순회한다. Hook 시스템에서 `memoizedState`는 첫 번째 hook을 가리키고, 각 hook은 `next`로 다음 hook을 가리킨다:

```
fiber.memoizedState
    |
    v
  Hook #0 (useState)
    |  .memoizedState = "hello"
    |  .next --------+
    |                 |
    v                 v
  Hook #1 (useEffect)
    |  .memoizedState = {...}
    |  .next --------+
    |                 |
    v                 v
  Hook #2 (useMemo)
    |  .memoizedState = [cachedValue, deps]
    |  .next = null
```

DevTools에서 "Hook #0의 값을 변경"하면, `findHook(fiber, 0)`으로 첫 번째 hook을 찾고, 그 `memoizedState`를 직접 수정한다.

### 8.2 `overrideHookState`: Hook 상태 편집

```javascript
// L29136-29156
overrideHookState = function (fiber, id, path, value) {
  var hook = findHook(fiber, id);

  if (hook !== null) {
    var newState = copyWithSet(hook.memoizedState, path, value);
    hook.memoizedState = newState;
    hook.baseState = newState;

    // 중요: bailout 방지를 위해 props를 shallow clone
    fiber.memoizedProps = assign({}, fiber.memoizedProps);

    var root = enqueueConcurrentRenderForLane(fiber, SyncLane);
    if (root !== null) {
      scheduleUpdateOnFiber(root, fiber, SyncLane, NoTimestamp);
    }
  }
};
```

여기서 `path`가 핵심이다. `copyWithSet`은 불변성을 유지하면서 중첩된 객체의 특정 경로를 수정한다:

```javascript
// L29117-29122
var copyWithSet = function (obj, path, value) {
  return copyWithSetImpl(obj, path, 0, value);
};

var copyWithSetImpl = function (obj, path, index, value) {
  if (index >= path.length) {
    return value;
  }
  var key = path[index];
  var updated = isArray(obj) ? obj.slice() : assign({}, obj);
  updated[key] = copyWithSetImpl(obj[key], path, index + 1, value);
  return updated;
};
```

예를 들어, DevTools에서 `useState({ user: { name: "Alice" } })`의 `name`을 "Bob"으로 바꾸면:

```
overrideHookState(fiber, 0, ['user', 'name'], 'Bob')
  |
  +-- findHook(fiber, 0)  ->  Hook { memoizedState: { user: { name: "Alice" } } }
  +-- copyWithSet({ user: { name: "Alice" } }, ['user', 'name'], 'Bob')
  |     -> { user: { name: "Bob" } }  (불변 복사)
  +-- hook.memoizedState = newState
  +-- hook.baseState = newState
  +-- fiber.memoizedProps = assign({}, fiber.memoizedProps)  // bailout 방지!
  +-- scheduleUpdateOnFiber(root, fiber, SyncLane, NoTimestamp)
```

**bailout 방지**가 중요하다. React의 reconciler는 `memoizedProps === pendingProps`이면 컴포넌트를 건너뛸 수 있다 (bailout). Hook 상태만 바꾸면 props는 동일하므로 React가 "변경 없음"으로 판단할 수 있다. 이를 막기 위해 props 객체를 새로 만든다 (`assign({}, fiber.memoizedProps)`). 참조가 달라지므로 bailout이 발생하지 않는다.

### 8.3 `overrideProps`: Props 편집

```javascript
// L29200-29213
overrideProps = function (fiber, path, value) {
  fiber.pendingProps = copyWithSet(fiber.memoizedProps, path, value);

  if (fiber.alternate) {
    fiber.alternate.pendingProps = fiber.pendingProps;
  }

  var root = enqueueConcurrentRenderForLane(fiber, SyncLane);
  if (root !== null) {
    scheduleUpdateOnFiber(root, fiber, SyncLane, NoTimestamp);
  }
};
```

Props 편집은 `pendingProps`를 직접 수정한다. `alternate`(double buffering의 반대쪽 Fiber)도 함께 수정하는 것에 주목하자. 이렇게 하지 않으면 다음 렌더에서 `alternate`의 이전 props가 사용될 수 있다.

### 8.4 `scheduleUpdate`: 강제 리렌더링

```javascript
// L29242-29247
scheduleUpdate = function (fiber) {
  var root = enqueueConcurrentRenderForLane(fiber, SyncLane);
  if (root !== null) {
    scheduleUpdateOnFiber(root, fiber, SyncLane, NoTimestamp);
  }
};
```

모든 편집 함수의 마지막 단계는 `scheduleUpdateOnFiber`를 `SyncLane`으로 호출하는 것이다. SyncLane은 가장 높은 우선순위이므로, DevTools의 편집은 **즉시** 반영된다.

### 8.5 에러/Suspense 핸들러 주입

```javascript
// L29250-29256
setErrorHandler = function (newShouldErrorImpl) {
  shouldErrorImpl = newShouldErrorImpl;
};

setSuspenseHandler = function (newShouldSuspendImpl) {
  shouldSuspendImpl = newShouldSuspendImpl;
};
```

이 두 함수는 DevTools의 "Suspend this component" 또는 "Force error" 기능에 사용된다. DevTools가 특정 컴포넌트에서 에러를 발생시키거나 Suspense 상태로 전환할 수 있게 한다.

---

## 9. Profiler 타이밍 데이터

### 9.1 FiberNode의 프로파일링 필드

```javascript
// L28113-28123 - FiberNode 생성자
{
  // V8 성능 절벽 방지를 위한 초기화 전략
  // Object.preventExtension()과 관련된 V8 버그로 인해
  // NaN으로 먼저 초기화한 후 smi(small integer)로 덮어씀
  this.actualDuration = Number.NaN;
  this.actualStartTime = Number.NaN;
  this.selfBaseDuration = Number.NaN;
  this.treeBaseDuration = Number.NaN;

  // NaN -> 0으로 즉시 덮어씀
  this.actualDuration = 0;
  this.actualStartTime = -1;
  this.selfBaseDuration = 0;
  this.treeBaseDuration = 0;
}
```

V8 성능 최적화에 관한 흥미로운 코멘트가 있다. V8 엔진에서 `Object.preventExtensions()`를 사용하면 객체의 hidden class가 변경되는데, 필드가 처음에 smi(small integer)로 설정되었다가 나중에 double로 바뀌면 **별도의 hidden class**가 생성되어 성능이 급격히 떨어진다. 이를 방지하기 위해 먼저 `NaN`(double)으로 초기화한 후 0(smi)으로 덮어쓴다.

각 필드의 의미:

```
actualDuration: 이번 렌더에서 이 Fiber와 하위 트리를 렌더링하는 데 걸린 실제 시간
actualStartTime: 이번 렌더에서 이 Fiber의 렌더링이 시작된 시점
selfBaseDuration: 이 Fiber 자체(하위 트리 제외)의 가장 최근 렌더링 시간
treeBaseDuration: 이 Fiber와 전체 하위 트리의 가장 최근 렌더링 시간 합계
```

### 9.2 타이밍 측정 메커니즘

```javascript
// L17677-17698
function startProfilerTimer(fiber) {
  profilerStartTime = now$1();

  if (fiber.actualStartTime < 0) {
    fiber.actualStartTime = now$1();
  }
}

function stopProfilerTimerIfRunningAndRecordDelta(fiber, overrideBaseTime) {
  if (profilerStartTime >= 0) {
    var elapsedTime = now$1() - profilerStartTime;
    fiber.actualDuration += elapsedTime;

    if (overrideBaseTime) {
      fiber.selfBaseDuration = elapsedTime;
    }

    profilerStartTime = -1;
  }
}
```

타이밍 측정의 핵심 로직:

```
Fiber A 렌더 시작
  |-- startProfilerTimer(A)
  |     profilerStartTime = now()
  |     A.actualStartTime = now()     (첫 렌더 시작만)
  |
  |-- [Fiber A의 render 함수 실행]
  |
  |-- Fiber B (A의 자식) 렌더 시작
  |     stopProfilerTimerIfRunningAndRecordDelta(A, false)
  |       A.actualDuration += (now - profilerStartTime)
  |     startProfilerTimer(B)
  |
  |     [Fiber B의 render 함수 실행]
  |
  |     stopProfilerTimerIfRunningAndRecordDelta(B, true)
  |       B.actualDuration += elapsed
  |       B.selfBaseDuration = elapsed  (overrideBaseTime=true)
  |
  |-- startProfilerTimer(A)  -- A의 나머지 처리 재개
  |
  |-- stopProfilerTimerIfRunningAndRecordDelta(A, false)
  |     A.actualDuration += elapsed (누적)
```

### 9.3 `actualDuration` 버블링

커밋 단계에서 각 Fiber의 `actualDuration`은 부모로 버블링된다:

```javascript
// L21933-21954 - bubbleProperties 내부
if ((completedWork.mode & ProfileMode) !== NoMode) {
  var actualDuration = completedWork.actualDuration;
  var treeBaseDuration = completedWork.selfBaseDuration;
  var child = completedWork.child;

  while (child !== null) {
    newChildLanes = mergeLanes(newChildLanes,
                    mergeLanes(child.lanes, child.childLanes));
    subtreeFlags |= child.subtreeFlags;
    subtreeFlags |= child.flags;

    // 자식의 actualDuration을 부모에 합산
    actualDuration += child.actualDuration;
    treeBaseDuration += child.treeBaseDuration;
    child = child.sibling;
  }

  completedWork.actualDuration = actualDuration;
  completedWork.treeBaseDuration = treeBaseDuration;
}
```

이 버블링 덕분에 루트 Fiber의 `actualDuration`은 전체 렌더 트리의 총 렌더링 시간이 된다. DevTools Profiler의 Flamegraph는 이 계층적 데이터를 시각화한 것이다.

### 9.4 Profiler 컴포넌트의 `onRender` 콜백

```javascript
// L23481
if (typeof onRender === 'function') {
  onRender(
    finishedWork.memoizedProps.id,   // Profiler id
    phase,                            // 'mount' | 'update' | 'nested-update'
    finishedWork.actualDuration,      // 이번 커밋의 렌더 시간
    finishedWork.treeBaseDuration,    // 전체 서브트리의 기본 렌더 시간
    finishedWork.actualStartTime,     // 렌더 시작 시점
    commitTime                        // 커밋 시점
  );
}
```

`phase`는 세 가지 값을 가진다:
- `mount`: 최초 마운트
- `update`: 일반적인 업데이트
- `nested-update`: 커밋 중에 발생한 중첩 업데이트 (예: `useLayoutEffect` 내의 setState)

### 9.5 Effect Duration 추적

```javascript
// L17713-17740
function recordLayoutEffectDuration(fiber) {
  if (layoutEffectStartTime >= 0) {
    var elapsedTime = now$1() - layoutEffectStartTime;
    layoutEffectStartTime = -1;

    // 가장 가까운 Profiler 조상 또는 루트에 저장
    var parentFiber = fiber.return;
    while (parentFiber !== null) {
      switch (parentFiber.tag) {
        case HostRoot:
          var root = parentFiber.stateNode;
          root.effectDuration += elapsedTime;
          return;
        case Profiler:
          var parentStateNode = parentFiber.stateNode;
          parentStateNode.effectDuration += elapsedTime;
          return;
      }
      parentFiber = parentFiber.return;
    }
  }
}
```

`recordPassiveEffectDuration`도 동일한 패턴으로 동작한다. Effect duration은 가장 가까운 Profiler 조상으로 버블링되므로, `<Profiler>` 컴포넌트의 `onCommit` 콜백에서 해당 서브트리의 총 effect 실행 시간을 받을 수 있다.

---

## 10. Timeline Profiler: Scheduling Profiler Hooks

React 18에서 추가된 실험적 기능인 Timeline Profiler는 더 세밀한 추적을 위해 별도의 **injectedProfilingHooks** 시스템을 사용한다.

### 10.1 프로파일링 훅 주입

```javascript
// L4947-4948
function injectProfilingHooks(profilingHooks) {
  injectedProfilingHooks = profilingHooks;
}
```

이 함수는 `injectInternals` 시점에 DevTools에 전달된다:

```javascript
// L4803-4810
if (enableSchedulingProfiler) {
  internals = assign({}, internals, {
    getLaneLabelMap: getLaneLabelMap,
    injectProfilingHooks: injectProfilingHooks
  });
}
```

`getLaneLabelMap`은 Lane 비트마스크를 사람이 읽을 수 있는 이름으로 매핑한다:

```javascript
// L4951-4963
function getLaneLabelMap() {
  var map = new Map();
  var lane = 1;

  for (var index = 0; index < TotalLanes; index++) {
    var label = getLabelForLane(lane);
    map.set(lane, label);
    lane *= 2;
  }

  return map;
}
```

### 10.2 프로파일링 이벤트 종류

`injectedProfilingHooks`를 통해 DevTools에 전달되는 이벤트는 총 18가지다:

```
[렌더 단계]
  markRenderStarted(lanes)              -- 렌더 시작
  markRenderYielded()                   -- 렌더 양보 (Time Slicing)
  markRenderStopped()                   -- 렌더 종료
  markComponentRenderStarted(fiber)     -- 컴포넌트 렌더 시작
  markComponentRenderStopped()          -- 컴포넌트 렌더 종료

[커밋 단계]
  markCommitStarted(lanes)              -- 커밋 시작
  markCommitStopped()                   -- 커밋 종료
  markLayoutEffectsStarted(lanes)       -- Layout Effect 시작
  markLayoutEffectsStopped()            -- Layout Effect 종료
  markPassiveEffectsStarted(lanes)      -- Passive Effect 시작
  markPassiveEffectsStopped()           -- Passive Effect 종료

[컴포넌트 수준 Effect 추적]
  markComponentLayoutEffectMountStarted(fiber)
  markComponentLayoutEffectMountStopped()
  markComponentLayoutEffectUnmountStarted(fiber)
  markComponentLayoutEffectUnmountStopped()
  markComponentPassiveEffectMountStarted(fiber)
  markComponentPassiveEffectMountStopped()
  markComponentPassiveEffectUnmountStarted(fiber)
  markComponentPassiveEffectUnmountStopped()

[스케줄링]
  markRenderScheduled(lane)             -- setState 호출 시
  markForceUpdateScheduled(fiber, lane) -- forceUpdate 호출 시
  markStateUpdateScheduled(fiber, lane) -- 상태 업데이트 스케줄 시

[에러/Suspense]
  markComponentErrored(fiber, thrownValue, lanes)
  markComponentSuspended(fiber, wakeable, lanes)
```

이 이벤트들의 실제 호출 패턴 예시:

```javascript
// L4968-4970
function markCommitStarted(lanes) {
  if (injectedProfilingHooks !== null &&
      typeof injectedProfilingHooks.markCommitStarted === 'function') {
    injectedProfilingHooks.markCommitStarted(lanes);
  }
}
```

모든 프로파일링 훅은 동일한 패턴을 따른다:
1. `injectedProfilingHooks`가 null이 아닌지 확인
2. 해당 메서드가 함수인지 확인
3. 호출

이 guard 패턴이 중요한 이유는, Timeline Profiler가 활성화되지 않으면 `injectedProfilingHooks`가 null이므로 **첫 번째 null 체크에서 바로 빠져나온다**. 조건문 하나의 비용만 발생하므로 프로덕션에서도 부담이 적다.

### 10.3 Timeline의 Lane 추적

```javascript
// L5115-5117
function markRenderScheduled(lane) {
  if (injectedProfilingHooks !== null &&
      typeof injectedProfilingHooks.markRenderScheduled === 'function') {
    injectedProfilingHooks.markRenderScheduled(lane);
  }
}
```

Lane 정보가 전달되므로, Timeline Profiler는 "이 업데이트가 어떤 우선순위인지"를 시각화할 수 있다:

```
Timeline Profiler 시각화:

시간 -->
|=================|================|=============|
|   Sync Lane     |  Default Lane  |  Idle Lane  |
|  (클릭 이벤트)   |  (데이터 로드)   | (프리페치)   |
|=================|================|=============|
|                 |                |             |
| Render  Commit  | Render  Commit | Render      |
| 2ms     1ms     | 5ms     2ms    | 8ms         |
```

---

## 11. `memoizedUpdaters`: 업데이트 원인 추적

DevTools Profiler의 "Why did this render?" 기능은 `memoizedUpdaters`를 통해 동작한다:

```javascript
// L5931-5952
function movePendingFibersToMemoized(root, lanes) {
  if (!isDevToolsPresent) {
    return;  // DevTools 없으면 완전 스킵
  }

  var pendingUpdatersLaneMap = root.pendingUpdatersLaneMap;
  var memoizedUpdaters = root.memoizedUpdaters;

  while (lanes > 0) {
    var index = laneToIndex(lanes);
    var lane = 1 << index;
    var updaters = pendingUpdatersLaneMap[index];

    if (updaters.size > 0) {
      updaters.forEach(function (fiber) {
        var alternate = fiber.alternate;
        // alternate가 이미 set에 있으면 중복 추가 방지
        if (alternate === null || !memoizedUpdaters.has(alternate)) {
          memoizedUpdaters.add(fiber);
        }
      });
      updaters.clear();
    }

    lanes &= ~lane;
  }
}
```

이 데이터의 흐름:

```
1. setState() 호출
   -> addFiberToLanesMap(root, fiber, lane)
   -> pendingUpdatersLaneMap[laneIndex].add(fiber)

2. 렌더 시작 (prepareFreshStack)
   -> movePendingFibersToMemoized(root, lanes)
   -> memoizedUpdaters = { fiberA, fiberB, ... }

3. 커밋 완료 (commitRootImpl)
   -> onCommitRoot(root, priority)  // DevTools에 전달
   -> root.memoizedUpdaters.clear()  // 다음 커밋을 위해 초기화
```

DevTools는 `onCommitFiberRoot`에서 `root.memoizedUpdaters`를 읽어 "이번 커밋이 어떤 컴포넌트의 setState에 의해 트리거되었는지"를 보여준다.

---

## 12. Strict Mode와 DevTools

```javascript
// L4920-4940
function setIsStrictModeForDevtools(newIsStrictMode) {
  if (typeof unstable_yieldValue === 'function') {
    // 테스트 환경: Scheduler의 yield를 비활성화하고 경고 억제
    unstable_setDisableYieldValue(newIsStrictMode);
    setSuppressWarning(newIsStrictMode);
  }

  if (injectedHook && typeof injectedHook.setStrictMode === 'function') {
    try {
      injectedHook.setStrictMode(rendererID, newIsStrictMode);
    } catch (err) { /* ... */ }
  }
}
```

StrictMode에서 React는 컴포넌트를 의도적으로 두 번 렌더링한다. DevTools에 `setStrictMode`를 알려주는 이유는, DevTools가 두 번째 렌더를 "정상적인 리렌더"가 아닌 "StrictMode 검증"으로 인식해야 하기 때문이다. 이를 모르면 Profiler에서 모든 컴포넌트가 두 번씩 렌더링된 것으로 보여 혼란을 준다.

---

## 13. 전체 데이터 흐름 종합

지금까지 분석한 내용을 하나의 시퀀스로 종합하면:

```
[페이지 로드]
  1. DevTools content script 실행
     -> window.__REACT_DEVTOOLS_GLOBAL_HOOK__ 생성

  2. React DOM 모듈 로드 시작
     -> registerInternalModuleStart(new Error())

  3. React DOM 초기화 완료
     -> injectIntoDevTools({...})
        -> injectInternals(internals)
           -> hook.inject(internals) => rendererID
           -> injectedHook = hook

  4. React DOM 모듈 로드 완료
     -> registerInternalModuleStop(new Error())

[사용자 인터랙션 -> 렌더링]
  5. ReactDOM.createRoot(container).render(<App/>)
     -> updateContainer(element, container)
        -> onScheduleRoot(container, element)

  6. Render Phase
     -> markRenderStarted(lanes)
     -> 각 Fiber마다:
        setCurrentFiber(fiber)
        startProfilerTimer(fiber)
        markComponentRenderStarted(fiber)
        [render 실행]
        markComponentRenderStopped()
        stopProfilerTimerIfRunningAndRecordDelta(fiber, ...)
        resetCurrentFiber()
     -> markRenderStopped()

  7. Commit Phase
     -> markCommitStarted(lanes)
     -> commitMutationEffects
        -> 삭제된 Fiber마다: onCommitUnmount(fiber)
     -> commitLayoutEffects
        -> markLayoutEffectsStarted(lanes)
        -> 각 Effect: markComponentLayoutEffectMountStarted(fiber) / Stopped
        -> markLayoutEffectsStopped()
     -> onCommitRoot(root, priority)
     -> markCommitStopped()

  8. Passive Effects (비동기)
     -> markPassiveEffectsStarted(lanes)
     -> 각 Effect: markComponentPassiveEffectMountStarted(fiber) / Stopped
     -> markPassiveEffectsStopped()
     -> onPostCommitRoot(root)

[DevTools 사용자 조작]
  9. 컴포넌트 트리에서 컴포넌트 클릭
     -> findFiberByHostInstance(domNode) -> Fiber
     -> Fiber의 props, memoizedState, _debugOwner 등 읽기

 10. props/state 편집
     -> overrideHookState(fiber, hookId, path, value)
        또는 overrideProps(fiber, path, value)
     -> scheduleUpdateOnFiber(root, fiber, SyncLane)
     -> 즉시 리렌더 트리거

 11. Profiler 데이터 표시
     -> onCommitFiberRoot에서 root.current 순회
     -> 각 Fiber의 actualDuration, treeBaseDuration 읽기
     -> root.memoizedUpdaters로 업데이트 원인 파악
     -> Flamegraph / Ranked Chart 시각화
```

---

## 14. DevTools가 React에 미치는 성능 영향

DevTools 통합 코드가 React 런타임에 미치는 오버헤드를 분석해보자.

### 14.1 DevTools가 없을 때 (Production)

```javascript
var isDevToolsPresent = typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined';
// -> false

// addFiberToLanesMap: 첫 줄에서 return
// movePendingFibersToMemoized: 첫 줄에서 return
// onCommitRoot: injectedHook이 null이므로 조건문 실패
// 프로파일링 훅: injectedProfilingHooks가 null이므로 즉시 return
```

Production 빌드에서는:
- `isDevToolsPresent`가 false이므로 Lane 추적 완전 스킵
- `injectedHook`이 null이므로 커밋 훅 호출 안 함
- `injectedProfilingHooks`가 null이므로 프로파일링 이벤트 안 보냄
- 하지만 `enableProfilerTimer`가 true인 DEV 빌드에서는 actualDuration 등의 계산이 여전히 수행됨

### 14.2 DevTools가 있을 때

```
추가 비용:
  - 매 커밋: onCommitFiberRoot 호출 (1회)
  - 매 언마운트: onCommitFiberUnmount 호출 (삭제 Fiber 수만큼)
  - 매 passive effect 완료: onPostCommitRoot 호출 (1회)
  - 매 setState: addFiberToLanesMap (업데이트 트리거 Fiber 추적)
  - Lane 추적: pendingUpdatersLaneMap에 Set.add() 연산
```

대부분의 비용은 DevTools Backend가 `onCommitFiberRoot`를 받고 **Fiber 트리를 순회하는 과정**에서 발생한다. React 런타임 자체의 오버헤드는 매우 작다.

### 14.3 DEV 전용 필드

FiberNode에는 DEV 빌드에서만 존재하는 필드가 있다:

```javascript
// L28128-28131
this._debugSource = null;        // JSX 소스 위치 (파일, 줄, 칼럼)
this._debugOwner = null;         // JSX를 생성한 컴포넌트
this._debugNeedsRemount = false; // HMR 리마운트 플래그
this._debugHookTypes = null;     // ['useState', 'useEffect', ...] 배열
```

`_debugHookTypes`는 렌더링 중에 사용된 Hook 타입을 기록한다:

```javascript
// L15451
hookTypesDev = current !== null ? current._debugHookTypes : null;

// L15529
workInProgress._debugHookTypes = hookTypesDev;
```

이 배열은 DevTools가 Hook 목록을 표시할 때 사용된다:
```
Component Inspector:
  hooks
    0: State = "hello"      <- _debugHookTypes[0] = 'useState'
    1: Effect               <- _debugHookTypes[1] = 'useEffect'
    2: Memo = 42            <- _debugHookTypes[2] = 'useMemo'
```

---

## 15. `detachDeletedInstance`: DOM 정리

컴포넌트가 삭제될 때, DOM 노드에 심어둔 Fiber 참조도 정리해야 한다:

```javascript
// L11489-11496
function detachDeletedInstance(node) {
  delete node[internalInstanceKey];
  delete node[internalPropsKey];
  delete node[internalEventHandlersKey];
  delete node[internalEventHandlerListenersKey];
  delete node[internalEventHandlesSetKey];
}
```

이 함수가 호출되지 않으면 삭제된 DOM 노드가 Fiber에 대한 참조를 유지하게 되고, Fiber는 다시 부모 Fiber, 형제 Fiber, props, state 등을 참조하므로 **대규모 메모리 누수**가 발생할 수 있다. DevTools는 `onCommitFiberUnmount`를 받으면 자신이 가진 Fiber 참조도 정리한다.

---

## 16. 정리: React와 DevTools의 공생 관계

React DevTools의 아키텍처를 소스 코드 수준에서 분석한 결과, 다음과 같은 설계 원칙이 드러난다:

### 16.1 최소 침습 원칙

DevTools 코드는 React 런타임의 핫 패스(hot path)에 최소한의 오버헤드만 추가한다:

```
if (injectedHook) { ... }     -- null 체크 하나
if (!isDevToolsPresent) return;  -- boolean 체크 하나
```

### 16.2 역전된 제어 흐름

일반적인 디버거와 달리, React DevTools는 **대상 프로그램이 디버거를 호출하는** 구조다:

```
일반 디버거:  디버거 -> 대상 프로그램 (중단점 설정, 메모리 읽기)
React DevTools: React -> DevTools (이벤트 전달, 데이터 노출)
                DevTools -> React (편집 함수 호출)
```

React가 DevTools에 `internals` 객체를 inject하면서 양방향 채널을 열어주는 이 패턴은, 디버깅 도구와 런타임의 **공생 관계**를 가능하게 한다.

### 16.3 전역 훅 패턴의 우아함

`__REACT_DEVTOOLS_GLOBAL_HOOK__`이라는 전역 변수 하나로 모든 것이 연결된다. 이 패턴의 장점:

1. **선택적 연결**: DevTools가 없으면 React는 정상 동작
2. **버전 독립적**: React와 DevTools가 서로 다른 버전이어도 동작
3. **다중 렌더러 지원**: 같은 페이지에서 여러 React 렌더러 공존 가능
4. **배포 형태 무관**: 브라우저 확장, 독립 앱, npm 패키지 모두 같은 인터페이스

### 16.4 시리즈를 마치며

이 시리즈 14편에 걸쳐 React 18의 핵심 아키텍처를 소스 코드 수준에서 분석했다. 패키지 구조에서 시작해, Fiber 아키텍처, Hooks 시스템, Lane 스케줄링, 렌더링 사이클, 커밋 단계, Suspense/ErrorBoundary, SSR을 거쳐, 마지막으로 이 모든 것을 관측하는 DevTools까지.

React는 단순한 UI 라이브러리가 아니다. 스케줄러, reconciler, 렌더러, 디버깅 도구가 정교하게 엮인 **소프트웨어 시스템**이다. 소스 코드를 읽는 것은 이 시스템의 설계 결정을 이해하는 가장 확실한 방법이며, 그 과정에서 얻는 통찰은 더 나은 React 코드를 작성하는 데 직접적으로 도움이 된다.
