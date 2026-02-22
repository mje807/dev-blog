# React 18 Suspense & Error Boundary 소스 코드 분석

> 분석 대상: `react-dom@18.3.1` — `react-dom.development.js` (29,923 lines)
> 분석 날짜: 2026-02-20

---

## 목차

1. [전체 메커니즘 개요](#1-전체-메커니즘-개요)
2. [SuspendedReason 상수 목록](#2-suspendedreason-상수-목록)
3. [throwException 함수 전체 구조](#3-throwexception-함수-전체-구조)
4. [handleError 함수와 workLoop try-catch](#4-handleerror-함수와-workloop-try-catch)
5. [unwindWork / unwindInterruptedWork](#5-unwindwork--unwindinterruptedwork)
6. [updateSuspenseComponent 처리 흐름](#6-updatesuspensecomponent-처리-흐름)
7. [Ping & Retry 해소 흐름](#7-ping--retry-해소-흐름)
8. [Error Boundary: createClassErrorUpdate](#8-error-boundary-createclasserrorupdate)
9. [Fiber Flags 상수](#9-fiber-flags-상수)
10. [전체 플로우 시퀀스 다이어그램](#10-전체-플로우-시퀀스-다이어그램)

---

## 1. 전체 메커니즘 개요

React 18의 Suspense와 Error Boundary는 모두 **throw 기반의 예외 버블링**으로 동작한다. 컴포넌트가 Promise(Wakeable)나 Error를 throw하면, React의 렌더 루프가 이를 catch하여 파이버 트리를 거슬러 올라가며 적절한 바운더리를 찾는다.

```
컴포넌트 throw (Promise or Error)
  └─ workLoopConcurrent/Sync catch
       └─ handleError(root, thrownValue)
            └─ throwException(root, returnFiber, sourceFiber, value, lanes)
                 ├─ [Promise] getNearestSuspenseBoundaryToCapture()
                 │    └─ ShouldCapture flag 설정
                 │    └─ attachPingListener(root, wakeable, lanes)
                 │    └─ attachRetryListener(suspenseBoundary, root, wakeable)
                 └─ [Error] 조상 루프 → ClassComponent/HostRoot ShouldCapture
            └─ completeUnitOfWork(erroredWork)
                 └─ unwindWork() → ShouldCapture → DidCapture 전환
                      └─ 해당 바운더리 fiber 반환 → beginWork 재시작
                           └─ updateSuspenseComponent(): showFallback=true 분기
```

---

## 2. SuspendedReason 상수 목록

React 18.3.1 소스에서 `workInProgressSuspendedReason`이라는 전역 변수 이름은 **React 19 실험 브랜치**에서 도입된 개념이다. React 18.3.1에서는 이에 해당하는 상태를 `workInProgressRootExitStatus` 로 관리한다.

**L25323–L25329**: `workInProgressRootExitStatus` 열거값

```javascript
// L25323
var RootInProgress = 0;          // 렌더 진행 중
var RootFatalErrored = 1;        // 복구 불가 에러 (조상 바운더리 없음)
var RootErrored = 2;             // Error Boundary가 캡처한 에러
var RootSuspended = 3;           // Suspense 발생 (fallback 커밋 가능)
var RootSuspendedWithDelay = 4;  // Suspense + 지연 허용 (Transition 등)
var RootCompleted = 5;           // 렌더 완료
var RootDidNotComplete = 6;      // 렌더 미완료 (yield)
```

### 각 상태의 처리 방식

| 상태 | 트리거 함수 | 의미 |
|------|-----------|------|
| `RootInProgress` | 초기값 | 아직 아무것도 throw하지 않음 |
| `RootSuspended` | `renderDidSuspend()` (L26398) | Suspense 바운더리가 캡처 완료. fallback 렌더 예약 |
| `RootSuspendedWithDelay` | `renderDidSuspendDelayIfPossible()` (L26401–L26416) | Transition/delay 가능. 더 오래 기다려 UX 개선 |
| `RootErrored` | `renderDidError()` (L26422–L26430) | Error Boundary가 캡처. 재렌더 예약 |
| `RootFatalErrored` | `handleError` 내부 (L26318) | 루트까지 전파된 에러. 앱 크래시 |

**L26395–L26416**: `renderDidSuspend` vs `renderDidSuspendDelayIfPossible`

```javascript
// L26395
function renderDidSuspend() {
  if (workInProgressRootExitStatus === RootInProgress) {
    workInProgressRootExitStatus = RootSuspended;
  }
}

// L26401
function renderDidSuspendDelayIfPossible() {
  if (
    workInProgressRootExitStatus === RootInProgress ||
    workInProgressRootExitStatus === RootSuspended ||
    workInProgressRootExitStatus === RootErrored
  ) {
    workInProgressRootExitStatus = RootSuspendedWithDelay;
  }
  // 스킵된 lanes가 있으면 root를 suspended로 마킹해 즉시 재시작 유도
  if (workInProgressRoot !== null && (
    includesNonIdleWork(workInProgressRootSkippedLanes) ||
    includesNonIdleWork(workInProgressRootInterleavedUpdatedLanes)
  )) {
    markRootSuspended$1(workInProgressRoot, workInProgressRootRenderLanes);
  }
}
```

---

## 3. throwException 함수 전체 구조

**L19017–L19148**: `throwException` — Suspense와 Error Boundary의 핵심 진입점

```javascript
// L19017
function throwException(root, returnFiber, sourceFiber, value, rootRenderLanes) {
  // 1단계: sourceFiber를 Incomplete로 마킹
  sourceFiber.flags |= Incomplete;
```

### 3.1 Thenable(Promise) vs Error 분기

```javascript
  // L19028: value가 Promise(Wakeable)인지 판별
  if (value !== null && typeof value === 'object' && typeof value.then === 'function') {
    // ---- Suspense 경로 ----
    var wakeable = value;

    // Legacy Mode 훅 컴포넌트를 위한 상태 리셋
    resetSuspendedComponent(sourceFiber);

    // 가장 가까운 SuspenseBoundary 탐색
    var suspenseBoundary = getNearestSuspenseBoundaryToCapture(returnFiber);

    if (suspenseBoundary !== null) {
      suspenseBoundary.flags &= ~ForceClientRender;

      // ShouldCapture 플래그 설정 (unwindWork에서 DidCapture로 전환됨)
      markSuspenseBoundaryShouldCapture(
        suspenseBoundary, returnFiber, sourceFiber, root, rootRenderLanes
      );

      // Concurrent Mode에서만 Ping 리스너 등록
      if (suspenseBoundary.mode & ConcurrentMode) {
        attachPingListener(root, wakeable, rootRenderLanes);
      }

      // Retry 리스너 등록 (fallback 커밋 후 재시도)
      attachRetryListener(suspenseBoundary, root, wakeable);
      return;
    } else {
      // SuspenseBoundary 없음
      if (!includesSyncLane(rootRenderLanes)) {
        // Async 렌더: ping 후 루트부터 재시작
        attachPingListener(root, wakeable, rootRenderLanes);
        renderDidSuspendDelayIfPossible();
        return;
      }
      // Sync 렌더: Error로 변환하여 Error Boundary로 전달
      value = new Error(
        'A component suspended while responding to synchronous input...'
      );
    }
  } else {
    // ---- Error Boundary 경로 (일반 에러) ----
    if (getIsHydrating() && sourceFiber.mode & ConcurrentMode) {
      // Hydration 에러: SuspenseBoundary로 클라이언트 렌더 전환
      var _suspenseBoundary = getNearestSuspenseBoundaryToCapture(returnFiber);
      if (_suspenseBoundary !== null) {
        _suspenseBoundary.flags |= ForceClientRender;
        markSuspenseBoundaryShouldCapture(...);
        queueHydrationError(createCapturedValueAtFiber(value, sourceFiber));
        return;
      }
    }
  }
```

### 3.2 SuspenseComponent 탐색 루프

**L18891–L18905**: `getNearestSuspenseBoundaryToCapture`

```javascript
// L18891
function getNearestSuspenseBoundaryToCapture(returnFiber) {
  var node = returnFiber;
  do {
    // tag === SuspenseComponent(13)이고 캡처 가능한 경계 탐색
    if (node.tag === SuspenseComponent && shouldCaptureSuspense(node)) {
      return node;
    }
    // 이미 이번 렌더에서 캡처한 경계는 건너뜀
    node = node.return;
  } while (node !== null);
  return null;
}
```

**L15175–L15198**: `shouldCaptureSuspense` — 캡처 가능 여부 판단

```javascript
// L15175
function shouldCaptureSuspense(workInProgress, hasInvisibleParent) {
  var nextState = workInProgress.memoizedState;

  if (nextState !== null) {
    if (nextState.dehydrated !== null) {
      // Dehydrated 경계는 항상 캡처
      return true;
    }
    // 이미 fallback 표시 중이면 캡처하지 않음 (상위로 버블)
    return false;
  }

  // DEV 빌드에서 일반 경계는 항상 캡처
  // Production에서는 invisible parent 여부 등 추가 로직
  {
    return true;
  }
}
```

### 3.3 attachPingListener: RetryQueue 구조

**L18805–L18848**: `attachPingListener`

```javascript
// L18805
function attachPingListener(root, wakeable, lanes) {
  // root.pingCache: WeakMap<wakeable, Set<lanes>>
  var pingCache = root.pingCache;
  var threadIDs;

  if (pingCache === null) {
    pingCache = root.pingCache = new PossiblyWeakMap$1();
    threadIDs = new Set();
    pingCache.set(wakeable, threadIDs);
  } else {
    threadIDs = pingCache.get(wakeable);
    if (threadIDs === undefined) {
      threadIDs = new Set();
      pingCache.set(wakeable, threadIDs);
    }
  }

  if (!threadIDs.has(lanes)) {
    // lanes를 "thread ID"로 사용해 중복 리스너 방지
    threadIDs.add(lanes);
    var ping = pingSuspendedRoot.bind(null, root, wakeable, lanes);
    wakeable.then(ping, ping); // resolve/reject 모두 동일 핸들러
  }
}
```

**L18850–L18870**: `attachRetryListener` — `fiber.updateQueue`가 RetryQueue

```javascript
// L18850
function attachRetryListener(suspenseBoundary, root, wakeable, lanes) {
  // suspenseBoundary.updateQueue = Set<Wakeable> (RetryQueue)
  var wakeables = suspenseBoundary.updateQueue;

  if (wakeables === null) {
    var updateQueue = new Set();
    updateQueue.add(wakeable);
    suspenseBoundary.updateQueue = updateQueue;
  } else {
    wakeables.add(wakeable);
  }
}
```

> `updateQueue`는 일반 ClassComponent에서 업데이트 링크드 리스트로 쓰이지만, SuspenseComponent에서는 **`Set<Wakeable>`** 로 재사용된다.

### 3.4 Error Boundary 탐색 루프 (throwException 하단)

**L19103–L19148**:

```javascript
  // value를 CapturedValue로 래핑
  value = createCapturedValueAtFiber(value, sourceFiber);
  renderDidError(value);

  // 부모 트리를 순회하며 캡처 가능한 바운더리 탐색
  var workInProgress = returnFiber;
  do {
    switch (workInProgress.tag) {
      case HostRoot: {
        // 루트까지 올라온 에러: CaptureUpdate 예약
        workInProgress.flags |= ShouldCapture;
        var lane = pickArbitraryLane(rootRenderLanes);
        workInProgress.lanes = mergeLanes(workInProgress.lanes, lane);
        var update = createRootErrorUpdate(workInProgress, errorInfo, lane);
        enqueueCapturedUpdate(workInProgress, update);
        return;
      }
      case ClassComponent: {
        var ctor = workInProgress.type;
        var instance = workInProgress.stateNode;
        // getDerivedStateFromError 또는 componentDidCatch 구현 여부 확인
        if (
          (workInProgress.flags & DidCapture) === NoFlags &&
          (typeof ctor.getDerivedStateFromError === 'function' ||
            (instance !== null &&
              typeof instance.componentDidCatch === 'function' &&
              !isAlreadyFailedLegacyErrorBoundary(instance)))
        ) {
          workInProgress.flags |= ShouldCapture;
          var _lane = pickArbitraryLane(rootRenderLanes);
          workInProgress.lanes = mergeLanes(workInProgress.lanes, _lane);
          // CaptureUpdate 생성 및 큐에 추가
          var _update = createClassErrorUpdate(workInProgress, errorInfo, _lane);
          enqueueCapturedUpdate(workInProgress, _update);
          return;
        }
        break;
      }
    }
    workInProgress = workInProgress.return;
  } while (workInProgress !== null);
```

---

## 4. handleError 함수와 workLoop try-catch

### 4.1 renderRootConcurrent의 try-catch 구조

**L26509–L26555**: `renderRootConcurrent`

```javascript
// L26509
function renderRootConcurrent(root, lanes) {
  // ...준비 작업...

  do {
    try {
      workLoopConcurrent(); // while (workInProgress !== null && !shouldYield())
      break;
    } catch (thrownValue) {
      handleError(root, thrownValue); // 에러/Promise 처리
    }
  } while (true); // 에러 처리 후 workLoop 재개

  // ...
}
```

**중요**: `do { try { workLoop } catch { handleError } } while(true)` 패턴은 에러 처리 후 자동으로 `workLoopConcurrent`를 **재개**한다. `handleError` 내부에서 `workInProgress`를 적절히 설정하면 렌더를 이어서 진행할 수 있다.

### 4.2 handleError 상세 흐름

**L26302–L26370**: `handleError`

```javascript
// L26302
function handleError(root, thrownValue) {
  do {
    var erroredWork = workInProgress;

    try {
      // 렌더 중 모듈 상태 리셋
      resetContextDependencies();
      resetHooksAfterThrow();
      resetCurrentFiber();
      ReactCurrentOwner$2.current = null;

      if (erroredWork === null || erroredWork.return === null) {
        // 루트 fiber에서 에러: 복구 불가
        workInProgressRootExitStatus = RootFatalErrored;
        workInProgressRootFatalError = thrownValue;
        workInProgress = null;
        return;
      }

      // Profiler 타이머 처리 (DEV)
      if (enableProfilerTimer && erroredWork.mode & ProfileMode) {
        stopProfilerTimerIfRunningAndRecordDelta(erroredWork, true);
      }

      // DevTools/Scheduling Profiler 통보
      if (enableSchedulingProfiler) {
        markComponentRenderStopped();
        if (typeof thrownValue?.then === 'function') {
          markComponentSuspended(erroredWork, thrownValue, workInProgressRootRenderLanes);
        } else {
          markComponentErrored(erroredWork, thrownValue, workInProgressRootRenderLanes);
        }
      }

      // 핵심 호출: throwException이 ShouldCapture 플래그 설정
      throwException(
        root,
        erroredWork.return,  // returnFiber
        erroredWork,         // sourceFiber
        thrownValue,
        workInProgressRootRenderLanes
      );

      // completeUnitOfWork → unwindWork 호출로 스택 되감기
      completeUnitOfWork(erroredWork);

    } catch (yetAnotherThrownValue) {
      // 에러 처리 경로 자체에서 에러 발생 시
      thrownValue = yetAnotherThrownValue;
      if (workInProgress === erroredWork && erroredWork !== null) {
        // 같은 fiber에서 재발: 부모로 올라감
        erroredWork = erroredWork.return;
        workInProgress = erroredWork;
      } else {
        erroredWork = workInProgress;
      }
      continue;
    }

    return; // 정상 처리 완료: workLoopConcurrent 재개
  } while (true);
}
```

### 4.3 handleError → throwException → completeUnitOfWork 연쇄

```
handleError(root, thrownValue)
  │
  ├─ throwException(root, erroredWork.return, erroredWork, thrownValue, lanes)
  │   ├─ [Promise] SuspenseBoundary.flags |= ShouldCapture
  │   │           attachPingListener()
  │   │           attachRetryListener()
  │   └─ [Error]  ClassComponent/HostRoot.flags |= ShouldCapture
  │               enqueueCapturedUpdate()
  │
  └─ completeUnitOfWork(erroredWork)
      └─ completeWork() 순회 중 ShouldCapture 있는 fiber에서
         └─ unwindWork() 호출
              └─ ShouldCapture → DidCapture 전환 + fiber 반환
                   └─ workInProgress = fiber (해당 바운더리로 재시작)
```

---

## 5. unwindWork / unwindInterruptedWork

### 5.1 unwindWork — ShouldCapture → DidCapture 전환

**L22680–L22795**: `unwindWork`

```javascript
// L22680
function unwindWork(current, workInProgress, renderLanes) {
  popTreeContext(workInProgress);

  switch (workInProgress.tag) {

    case ClassComponent: {
      var Component = workInProgress.type;
      if (isContextProvider(Component)) {
        popContext(workInProgress); // Context 스택 팝
      }
      var flags = workInProgress.flags;
      if (flags & ShouldCapture) {
        // ShouldCapture → DidCapture 전환 (Error Boundary 활성화)
        workInProgress.flags = flags & ~ShouldCapture | DidCapture;
        if ((workInProgress.mode & ProfileMode) !== NoMode) {
          transferActualDuration(workInProgress);
        }
        return workInProgress; // 이 fiber로 렌더 재시작
      }
      return null;
    }

    case HostRoot: {
      var root = workInProgress.stateNode;
      popHostContainer(workInProgress);   // Host 컨테이너 스택 팝
      popTopLevelContextObject(workInProgress);
      resetWorkInProgressVersions();
      var _flags = workInProgress.flags;
      if ((_flags & ShouldCapture) !== NoFlags && (_flags & DidCapture) === NoFlags) {
        // 루트에서 에러: DidCapture로 전환
        workInProgress.flags = _flags & ~ShouldCapture | DidCapture;
        return workInProgress;
      }
      return null;
    }

    case HostComponent: {
      popHostContext(workInProgress);
      return null; // HostComponent는 에러 캡처 안 함
    }

    case SuspenseComponent: {
      popSuspenseContext(workInProgress); // Suspense Context 스택 팝
      var suspenseState = workInProgress.memoizedState;
      if (suspenseState !== null && suspenseState.dehydrated !== null) {
        if (workInProgress.alternate === null) {
          throw new Error('Threw in newly mounted dehydrated component...');
        }
        resetHydrationState();
      }
      var _flags2 = workInProgress.flags;
      if (_flags2 & ShouldCapture) {
        // ShouldCapture → DidCapture: fallback 렌더 신호
        workInProgress.flags = _flags2 & ~ShouldCapture | DidCapture;
        if ((workInProgress.mode & ProfileMode) !== NoMode) {
          transferActualDuration(workInProgress);
        }
        return workInProgress; // SuspenseComponent fiber 반환 → beginWork 재시작
      }
      return null;
    }

    case SuspenseListComponent: {
      popSuspenseContext(workInProgress);
      // SuspenseList는 직접 캡처하지 않고 내부 바운더리에 위임
      return null;
    }

    case HostPortal:
      popHostContainer(workInProgress);
      return null;

    case ContextProvider:
      var context = workInProgress.type._context;
      popProvider(context, workInProgress);
      return null;

    case OffscreenComponent:
    case LegacyHiddenComponent:
      popRenderLanes(workInProgress);
      return null;

    default:
      return null;
  }
}
```

### 5.2 unwindInterruptedWork — 중단된 작업 정리

**L22796–L22860**: `unwindInterruptedWork`

중단된 렌더를 버릴 때 스택만 정리하고 ShouldCapture 전환은 하지 않는다.

```javascript
// L22796
function unwindInterruptedWork(current, interruptedWork, renderLanes) {
  popTreeContext(interruptedWork);

  switch (interruptedWork.tag) {
    case ClassComponent: {
      var childContextTypes = interruptedWork.type.childContextTypes;
      if (childContextTypes !== null && childContextTypes !== undefined) {
        popContext(interruptedWork); // 컨텍스트 스택만 팝
      }
      break;
    }
    case HostRoot: {
      popHostContainer(interruptedWork);
      popTopLevelContextObject(interruptedWork);
      resetWorkInProgressVersions();
      break;
    }
    case HostComponent:
      popHostContext(interruptedWork);
      break;
    case HostPortal:
      popHostContainer(interruptedWork);
      break;
    case SuspenseComponent:
      popSuspenseContext(interruptedWork); // Suspense 컨텍스트 스택만 팝
      break;
    case SuspenseListComponent:
      popSuspenseContext(interruptedWork);
      break;
    case ContextProvider:
      var context = interruptedWork.type._context;
      popProvider(context, interruptedWork);
      break;
    case OffscreenComponent:
    case LegacyHiddenComponent:
      popRenderLanes(interruptedWork);
      break;
    // default: 아무것도 안 함
  }
}
```

**unwindWork vs unwindInterruptedWork 비교**

| 항목 | `unwindWork` | `unwindInterruptedWork` |
|------|-------------|------------------------|
| 목적 | 에러/Suspense 캡처 후 스택 되감기 | 렌더 중단 시 스택 정리 |
| ShouldCapture 처리 | `ShouldCapture → DidCapture` 전환 | 없음 |
| 반환값 | 캡처 fiber 또는 null | void |
| 호출 시점 | `completeUnitOfWork` 내 에러 경로 | `prepareFreshStack` 등 |

---

## 6. updateSuspenseComponent 처리 흐름

**L20308–L20428**: `updateSuspenseComponent`

### 6.1 DidCapture 플래그 확인

```javascript
// L20308
function updateSuspenseComponent(current, workInProgress, renderLanes) {
  var nextProps = workInProgress.pendingProps;

  // DEV: DevTools가 강제로 fallback 표시 요청 시
  {
    if (shouldSuspend(workInProgress)) {
      workInProgress.flags |= DidCapture;
    }
  }

  var suspenseContext = suspenseStackCursor.current;
  var showFallback = false;

  // unwindWork에서 ShouldCapture → DidCapture로 전환된 플래그 확인
  var didSuspend = (workInProgress.flags & DidCapture) !== NoFlags;

  if (didSuspend || shouldRemainOnFallback(suspenseContext, current)) {
    // 자식 트리에서 Suspend 발생: fallback 렌더링
    showFallback = true;
    workInProgress.flags &= ~DidCapture; // 플래그 소비
  } else {
    // Primary 렌더 시도
    if (current === null || current.memoizedState !== null) {
      // 신규 마운트 또는 이미 fallback 표시 중
      suspenseContext = addSubtreeSuspenseContext(
        suspenseContext,
        InvisibleParentSuspenseContext // 자식에게 "보이지 않는 부모" 신호
      );
    }
  }

  suspenseContext = setDefaultShallowSuspenseContext(suspenseContext);
  pushSuspenseContext(workInProgress, suspenseContext);
```

### 6.2 showFallback vs showPrimary 분기

```javascript
  if (current === null) {
    // ---- 초기 마운트 ----
    tryToClaimNextHydratableInstance(workInProgress); // SSR 지원

    if (showFallback) {
      // Fallback 렌더: OffscreenFiber(hidden) + FallbackFiber
      var fallbackFragment = mountSuspenseFallbackChildren(
        workInProgress, nextProps.children, nextProps.fallback, renderLanes
      );
      var primaryChildFragment = workInProgress.child; // OffscreenFiber
      primaryChildFragment.memoizedState = mountSuspenseOffscreenState(renderLanes);
      workInProgress.memoizedState = SUSPENDED_MARKER; // Suspense 상태 마킹
      return fallbackFragment; // FallbackFiber 반환
    } else {
      // Primary 렌더: OffscreenFiber(visible)만 생성
      return mountSuspensePrimaryChildren(workInProgress, nextProps.children);
    }

  } else {
    // ---- 업데이트 ----
    var prevState = current.memoizedState; // null이면 primary, 있으면 fallback

    if (showFallback) {
      // Primary → Fallback 전환 또는 Fallback 유지
      var fallbackChildFragment = updateSuspenseFallbackChildren(
        current, workInProgress,
        nextProps.children,   // primary (hidden으로 유지)
        nextProps.fallback,   // fallback (표시)
        renderLanes
      );
      var _primaryChildFragment2 = workInProgress.child;

      // OffscreenFiber의 memoizedState: baseLanes 추적
      _primaryChildFragment2.memoizedState =
        prevOffscreenState === null
          ? mountSuspenseOffscreenState(renderLanes)
          : updateSuspenseOffscreenState(prevOffscreenState, renderLanes);

      _primaryChildFragment2.childLanes = getRemainingWorkInPrimaryTree(current, renderLanes);
      workInProgress.memoizedState = SUSPENDED_MARKER;
      return fallbackChildFragment;
    } else {
      // Fallback → Primary 전환 (Promise resolved)
      var _primaryChildFragment3 = updateSuspensePrimaryChildren(
        current, workInProgress, nextProps.children, renderLanes
      );
      workInProgress.memoizedState = null; // SUSPENDED_MARKER 제거
      return _primaryChildFragment3;
    }
  }
}
```

### 6.3 OffscreenFiber와 FallbackFiber의 구조

**SuspenseComponent의 Fiber 트리 구조**:

```
SuspenseComponent (fiber)
  └─ child: OffscreenComponent (primaryChildFragment)
       │  mode: 'hidden' (fallback 표시 중) | 'visible' (primary 표시 중)
       │  memoizedState: { baseLanes, cachePool, transitions }
       └─ sibling: Fragment (fallbackChildFragment) ← fallback UI
```

**L20258–L20281**: SUSPENDED_MARKER와 OffscreenState

```javascript
// L20258: SuspenseComponent.memoizedState 값
var SUSPENDED_MARKER = {
  dehydrated: null,
  treeContext: null,
  retryLane: NoLane  // 재시도 Lane
};

// L20264: OffscreenFiber.memoizedState 값
function mountSuspenseOffscreenState(renderLanes) {
  return {
    baseLanes: renderLanes,   // 숨겨진 트리가 렌더해야 할 기본 lanes
    cachePool: getSuspendedCache(),
    transitions: null
  };
}
```

**completeWork에서 DidCapture 재처리** (L22315–L22325):

```javascript
// L22315 (completeWork, SuspenseComponent case)
if ((workInProgress.flags & DidCapture) !== NoFlags) {
  // Suspend 발생: fallback으로 재렌더 신호
  workInProgress.lanes = renderLanes;
  // bubbleProperties 호출 없이 즉시 반환
  // → beginWork에서 updateSuspenseComponent 다시 호출됨
  return workInProgress;
}
```

---

## 7. Ping & Retry 해소 흐름

### 7.1 Promise 해소 시: pingSuspendedRoot

**L27217–L27250**: `pingSuspendedRoot`

```javascript
// L27217
function pingSuspendedRoot(root, wakeable, pingedLanes) {
  var pingCache = root.pingCache;
  if (pingCache !== null) {
    // 해소된 wakeable의 캐시 엔트리 삭제
    pingCache.delete(wakeable);
  }

  var eventTime = requestEventTime();
  markRootPinged(root, pingedLanes);

  if (
    workInProgressRoot === root &&
    isSubsetOfLanes(workInProgressRootRenderLanes, pingedLanes)
  ) {
    // 현재 렌더 중인 root와 동일한 우선순위에서 ping 수신
    if (
      workInProgressRootExitStatus === RootSuspendedWithDelay ||
      (workInProgressRootExitStatus === RootSuspended &&
        includesOnlyRetries(workInProgressRootRenderLanes) &&
        now() - globalMostRecentFallbackTime < FALLBACK_THROTTLE_MS)
    ) {
      // 지금 바로 루트부터 재시작
      prepareFreshStack(root, NoLanes);
    } else {
      // 나중에 재시작할 수 있도록 pingedLanes 기록
      workInProgressRootPingedLanes = mergeLanes(
        workInProgressRootPingedLanes,
        pingedLanes
      );
    }
  }

  ensureRootIsScheduled(root, eventTime);
}
```

### 7.2 Fallback 커밋 후: resolveRetryWakeable

**L27282–L27312**: `resolveRetryWakeable`

```javascript
// L27282
function resolveRetryWakeable(boundaryFiber, wakeable) {
  var retryLane = NoLane;
  var retryCache;

  switch (boundaryFiber.tag) {
    case SuspenseComponent:
      retryCache = boundaryFiber.stateNode; // WeakSet<Wakeable>
      var suspenseState = boundaryFiber.memoizedState;
      if (suspenseState !== null) {
        retryLane = suspenseState.retryLane; // 이전에 배정된 retry lane
      }
      break;
    case SuspenseListComponent:
      retryCache = boundaryFiber.stateNode;
      break;
  }

  if (retryCache !== null) {
    retryCache.delete(wakeable); // 중복 retry 방지
  }

  retryTimedOutBoundary(boundaryFiber, retryLane);
}

// L27251
function retryTimedOutBoundary(boundaryFiber, retryLane) {
  if (retryLane === NoLane) {
    retryLane = requestRetryLane(boundaryFiber);
  }
  var eventTime = requestEventTime();
  var root = enqueueConcurrentRenderForLane(boundaryFiber, retryLane);
  if (root !== null) {
    markRootUpdated(root, retryLane, eventTime);
    ensureRootIsScheduled(root, eventTime);
  }
}
```

### 7.3 Commit Phase: attachSuspenseRetryListeners

**L24240–L24277**: fallback 커밋 시 retry 리스너 등록

```javascript
// L24240
function attachSuspenseRetryListeners(finishedWork) {
  // finishedWork.updateQueue = Set<Wakeable> (attachRetryListener에서 채워진 것)
  var wakeables = finishedWork.updateQueue;

  if (wakeables !== null) {
    finishedWork.updateQueue = null;
    var retryCache = finishedWork.stateNode; // WeakSet 형태의 캐시

    if (retryCache === null) {
      retryCache = finishedWork.stateNode = new PossiblyWeakSet();
    }

    wakeables.forEach(function (wakeable) {
      // resolveRetryWakeable를 바인딩한 retry 함수
      var retry = resolveRetryWakeable.bind(null, finishedWork, wakeable);

      if (!retryCache.has(wakeable)) {
        retryCache.add(wakeable); // 중복 방지
        wakeable.then(retry, retry); // Promise resolve/reject 모두 처리
      }
    });
  }
}
```

---

## 8. Error Boundary: createClassErrorUpdate

**L18743–L18805**: `createClassErrorUpdate`

```javascript
// L18743
function createClassErrorUpdate(fiber, errorInfo, lane) {
  var update = createUpdate(NoTimestamp, lane);
  update.tag = CaptureUpdate; // CaptureUpdate = 3 (L14546)

  var getDerivedStateFromError = fiber.type.getDerivedStateFromError;

  if (typeof getDerivedStateFromError === 'function') {
    var error$1 = errorInfo.value;
    // payload는 함수: processUpdateQueue에서 호출되어 새 상태 반환
    update.payload = function () {
      return getDerivedStateFromError(error$1);
    };
    update.callback = function () {
      markFailedErrorBoundaryForHotReloading(fiber);
      logCapturedError(fiber, errorInfo);
    };
  }

  var inst = fiber.stateNode;
  if (inst !== null && typeof inst.componentDidCatch === 'function') {
    update.callback = function callback() {
      markFailedErrorBoundaryForHotReloading(fiber);
      logCapturedError(fiber, errorInfo);

      if (typeof getDerivedStateFromError !== 'function') {
        // componentDidCatch만 구현한 경우: legacy 에러 경계로 표시
        markLegacyErrorBoundaryAsFailed(this);
      }

      var error$1 = errorInfo.value;
      var stack = errorInfo.stack;
      // componentDidCatch(error, { componentStack }) 호출
      this.componentDidCatch(error$1, {
        componentStack: stack !== null ? stack : ''
      });
    };
  }

  return update;
}
```

**L18724–L18742**: `createRootErrorUpdate` — 루트까지 전파된 에러

```javascript
// L18724
function createRootErrorUpdate(fiber, errorInfo, lane) {
  var update = createUpdate(NoTimestamp, lane);
  update.tag = CaptureUpdate;

  // 루트를 null 렌더로 언마운트
  update.payload = { element: null };

  var error = errorInfo.value;
  update.callback = function () {
    onUncaughtError(error);    // 개발자 콘솔 에러 출력
    logCapturedError(fiber, errorInfo);
  };

  return update;
}
```

### Update Tag 상수 (L14543–L14546)

```javascript
var UpdateState = 0;    // setState 등 일반 업데이트
var ReplaceState = 1;   // replaceState (legacy)
var ForceUpdate = 2;    // forceUpdate
var CaptureUpdate = 3;  // Error Boundary 캡처 업데이트
```

---

## 9. Fiber Flags 상수

**L4356–L4408**: 핵심 플래그 값

```javascript
var Placement           = 2;       // DOM 삽입
var Update              = 4;       // DOM 업데이트
var ChildDeletion       = 16;      // 자식 삭제
var DidCapture          = 128;     // 에러/Suspense 캡처 완료
var ForceClientRender   = 256;     // Hydration 실패 → 클라이언트 렌더
var Incomplete          = 32768;   // 렌더 미완료 (throw 발생)
var ShouldCapture       = 65536;   // 캡처 예정 (throwException에서 설정)
var ForceUpdateForLegacySuspense = 131072; // Legacy Suspense 강제 업데이트
```

### ShouldCapture → DidCapture 전환 흐름

```
throwException()
  │  suspenseBoundary.flags |= ShouldCapture (L18935 또는 L19010)
  │  (또는 ClassComponent.flags |= ShouldCapture at L19131)
  │
  └─ completeUnitOfWork(erroredWork)
       └─ unwindWork(current, workInProgress, renderLanes)
            └─ if (flags & ShouldCapture):
                 workInProgress.flags = flags & ~ShouldCapture | DidCapture
                 return workInProgress  ← 이 fiber가 재시작 지점
```

---

## 10. 전체 플로우 시퀀스 다이어그램

### Suspense(Promise) 처리 전체 흐름

```
[컴포넌트] throw Promise (Wakeable)
     │
     ▼
[renderRootConcurrent] catch (thrownValue)
     │
     ▼
[handleError(root, thrownValue)]
     │  ├─ resetContextDependencies()
     │  ├─ resetHooksAfterThrow()
     │  └─ throwException(root, erroredWork.return, erroredWork, thrownValue, lanes)
     │       │
     │       ├─ sourceFiber.flags |= Incomplete
     │       ├─ getNearestSuspenseBoundaryToCapture(returnFiber)
     │       │    └─ 순회: node.tag === SuspenseComponent && shouldCaptureSuspense()
     │       │
     │       ├─ markSuspenseBoundaryShouldCapture()
     │       │    └─ [ConcurrentMode] suspenseBoundary.flags |= ShouldCapture
     │       │    └─ [LegacyMode]    suspenseBoundary.flags |= DidCapture (직접)
     │       │
     │       ├─ attachPingListener(root, wakeable, lanes)
     │       │    └─ root.pingCache WeakMap에 등록
     │       │    └─ wakeable.then(pingSuspendedRoot, pingSuspendedRoot)
     │       │
     │       └─ attachRetryListener(suspenseBoundary, root, wakeable)
     │            └─ suspenseBoundary.updateQueue (Set) 에 wakeable 추가
     │
     └─ completeUnitOfWork(erroredWork)
          │  (Incomplete 파이버부터 completeWork → unwindWork 순회)
          │
          └─ unwindWork(current, SuspenseBoundaryFiber, lanes)
               └─ flags & ShouldCapture → flags = ~ShouldCapture | DidCapture
               └─ popSuspenseContext()
               └─ return SuspenseBoundaryFiber  ← workInProgress로 설정
                    │
                    ▼
               [workLoopConcurrent 재개]
                    │
                    ▼
               [beginWork → updateSuspenseComponent(current, workInProgress, lanes)]
                    │  didSuspend = (flags & DidCapture) !== 0  → true
                    │  showFallback = true
                    │  workInProgress.flags &= ~DidCapture  (플래그 소비)
                    │
                    ├─ [초기 마운트] mountSuspenseFallbackChildren()
                    │    └─ OffscreenFiber(mode='hidden') + FallbackFiber
                    │    └─ workInProgress.memoizedState = SUSPENDED_MARKER
                    │
                    └─ [업데이트] updateSuspenseFallbackChildren()
                         └─ 기존 OffscreenFiber 재사용(mode='hidden')
                         └─ FallbackFiber 생성 또는 재사용

     ▼ (Commit Phase)
[commitMutationEffects → attachSuspenseRetryListeners]
     └─ finishedWork.updateQueue(Set<Wakeable>) 순회
     └─ wakeable.then(resolveRetryWakeable, resolveRetryWakeable)

     ▼ (Promise Resolved)
[pingSuspendedRoot(root, wakeable, lanes)]  ← attachPingListener 경로
     └─ pingCache.delete(wakeable)
     └─ RootSuspendedWithDelay → prepareFreshStack() 즉시 재시작
     └─ ensureRootIsScheduled(root, eventTime)

[resolveRetryWakeable(boundaryFiber, wakeable)]  ← attachSuspenseRetryListeners 경로
     └─ retryCache.delete(wakeable)
     └─ retryTimedOutBoundary(boundaryFiber, retryLane)
          └─ enqueueConcurrentRenderForLane()
          └─ markRootUpdated()
          └─ ensureRootIsScheduled()

     ▼ (재렌더)
[updateSuspenseComponent: showFallback=false]
     └─ updateSuspensePrimaryChildren(): OffscreenFiber(mode='visible')
     └─ workInProgress.memoizedState = null  (SUSPENDED_MARKER 제거)
```

### Error Boundary 처리 흐름

```
[컴포넌트] throw Error

[handleError → throwException]
     └─ getNearestSuspenseBoundaryToCapture()  실패 (에러이므로)
     └─ renderDidError(createCapturedValueAtFiber(value, sourceFiber))
     └─ 조상 루프:
          ClassComponent with getDerivedStateFromError/componentDidCatch:
            workInProgress.flags |= ShouldCapture
            enqueueCapturedUpdate(workInProgress, createClassErrorUpdate(...))
            return

[completeUnitOfWork → unwindWork]
     └─ ClassComponent.flags: ShouldCapture → DidCapture
     └─ return ClassComponentFiber

[beginWork → updateClassComponent]
     └─ processUpdateQueue()
          └─ CaptureUpdate.payload() → getDerivedStateFromError(error)
     └─ render(): 에러 UI 반환

[Commit Phase]
     └─ commitLifeCycles → componentDidCatch(error, { componentStack })
```

---

## 핵심 인사이트 정리

### 1. Throw는 제어 흐름이다

React가 `throw`를 에러가 아닌 **비동기 제어 흐름**으로 활용한다는 점이 핵심이다. Promise를 throw하면 React가 catch하여 대기 상태를 관리하고, Promise가 resolve되면 자동으로 재렌더를 스케줄링한다.

### 2. 두 개의 리스너 전략

| 리스너 | 등록 함수 | 저장 위치 | 역할 |
|--------|---------|---------|------|
| Ping Listener | `attachPingListener` | `root.pingCache` (WeakMap) | 렌더 중 바로 재시작 또는 lanes 기록 |
| Retry Listener | `attachRetryListener` (render) + `attachSuspenseRetryListeners` (commit) | `fiber.stateNode` (WeakSet) | fallback 커밋 후 boundary 재렌더 |

### 3. ShouldCapture → DidCapture 두 단계

`ShouldCapture`는 "이 파이버가 캡처해야 한다"는 의도 표시이고, `unwindWork`를 거쳐 `DidCapture`로 전환될 때 실제로 "캡처했다"는 상태가 된다. `updateSuspenseComponent`는 `DidCapture`를 읽어 `showFallback`을 결정하고, 이 플래그를 소비(`&= ~DidCapture`)한다.

### 4. OffscreenComponent: 숨겨진 Primary 트리

Suspense가 fallback을 표시할 때 primary 트리를 버리지 않는다. `OffscreenComponent`(tag=22)로 감싸서 `mode='hidden'`으로 유지한다. Promise가 resolve되면 `mode='visible'`로 전환하여 primary 트리를 재사용한다.

### 5. Legacy vs Concurrent Mode 차이

| 항목 | Legacy Mode | Concurrent Mode |
|------|------------|----------------|
| Ping Listener | 불필요 (sync commit) | `attachPingListener` 등록 |
| ShouldCapture 처리 | 즉시 `DidCapture` 설정 | unwindWork에서 전환 |
| Fallback 커밋 | 동기적 즉시 | 지연 가능 (RootSuspendedWithDelay) |
| Primary 트리 | Incomplete 상태로 커밋 | 완전히 숨김(OffscreenLane) |
