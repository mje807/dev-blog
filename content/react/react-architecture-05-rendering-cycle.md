# React 렌더링 사이클의 내부: beginWork가 세상을 만드는 방식

> **시리즈**: React 아키텍처 심층 분석 5편
> **이전**: [Lane 스케줄링 시스템](./react-architecture-04-lane-scheduling.md)
> **다음**: [Commit Phase](./react-architecture-06-commit-phase.md)

---

## 들어가며

4편에서 우리는 Lane이라는 우선순위 시스템이 어떻게 "어떤 작업을 언제 실행할지"를 결정하는지 살펴봤습니다. 이제 실제로 Scheduler가 React에게 실행 권한을 넘겨준 이후의 이야기를 살펴볼 차례입니다.

Render Phase는 React가 **"화면이 어떻게 바뀌어야 하는가"를 계산하는 단계**입니다. DOM을 직접 건드리지 않습니다. 순수하게 Fiber 트리를 탐색하고, 컴포넌트를 실행하고, 변경 사항을 비트 플래그로 기록합니다. 이 계산은 중단될 수 있고, 버려질 수 있고, 처음부터 다시 시작될 수 있습니다.

이 편에서는 Render Phase의 심장부인 `workLoop`와 `beginWork`, 그리고 최적화의 핵심인 bailout 시스템을 소스 코드 수준에서 분석합니다.

---

## 1. Work Loop: 렌더링 엔진의 심장

### 1.1 두 가지 루프의 근본적 차이

React의 Work Loop는 두 가지 버전이 존재합니다. 둘의 차이는 단 하나의 조건문이지만, 그 의미는 근본적으로 다릅니다.

```javascript
// packages/react-reconciler/src/ReactFiberWorkLoop.js

// 동기 루프: 끝날 때까지 절대 멈추지 않는다
function workLoopSync() {
  while (workInProgress !== null) {
    performUnitOfWork(workInProgress);
  }
}

// 동시성 루프: 매 단위 작업마다 "지금 멈춰야 하는가?"를 묻는다
function workLoopConcurrent() {
  while (workInProgress !== null && !shouldYield()) {
    performUnitOfWork(workInProgress);
  }
}
```

`shouldYield()`는 Scheduler 패키지가 제공하는 함수입니다. 내부적으로 현재 시간이 해당 프레임의 데드라인(일반적으로 5ms 슬라이스)을 초과했는지, 또는 사용자 입력이 대기 중인지(`scheduling.isInputPending()`) 확인합니다.

`true`가 반환되는 순간 루프가 깨집니다. `workInProgress`는 현재 처리 중이던 Fiber를 가리킨 채로 남습니다. React는 나중에 이 포인터를 보고 중단됐던 곳에서 재개합니다.

### 1.2 renderRootSync vs renderRootConcurrent

Work Loop를 감싸는 함수는 두 종류입니다. 어떤 함수가 호출되는지는 Lane에 의해 결정됩니다.

```javascript
function performConcurrentWorkOnRoot(root, didTimeout) {
  // blocking Lane이거나 만료됐으면 동기로 전환
  const shouldTimeSlice =
    !includesBlockingLane(root, lanes) &&
    !includesExpiredLane(root, lanes) &&
    !didTimeout;

  let exitStatus = shouldTimeSlice
    ? renderRootConcurrent(root, lanes)  // Time slicing 가능
    : renderRootSync(root, lanes);       // 동기 (중단 없음)
}
```

실제 운영에서 각 Lane이 어느 함수로 처리되는지:

| Lane 종류 | 진입 경로 | Time Slicing |
|-----------|-----------|:---:|
| SyncLane (setState) | performSyncWorkOnRoot → renderRootSync | ✗ |
| InputContinuousLane (연속 입력) | performConcurrentWorkOnRoot → renderRootSync | ✗ |
| DefaultLane (일반 업데이트) | performConcurrentWorkOnRoot → renderRootSync | ✗ |
| TransitionLane (useTransition) | performConcurrentWorkOnRoot → renderRootConcurrent | ✓ |
| RetryLane (Suspense 재시도) | performConcurrentWorkOnRoot → renderRootConcurrent | ✓ |

흥미롭게도 "Concurrent Mode"를 사용해도 대부분의 업데이트는 `renderRootSync`로 처리됩니다. 실제로 Time Slicing이 작동하는 건 `useTransition`을 명시적으로 사용하거나 Suspense 재시도가 일어날 때입니다.

### 1.3 RootExitStatus: 렌더 결과의 7가지 상태

`renderRootConcurrent`는 단순히 성공/실패를 반환하지 않습니다. 훨씬 세분화된 상태를 반환합니다.

```javascript
// 렌더가 어떻게 끝났는지를 나타내는 상태값
const RootInProgress         = 0;  // Time slicing으로 yield됨 (아직 진행 중)
const RootFatalErrored       = 1;  // 복구 불가능한 에러
const RootErrored            = 2;  // Error Boundary로 처리 가능한 에러
const RootSuspended          = 3;  // Suspense 경계에서 중단
const RootSuspendedWithDelay = 4;  // 의도적 지연 (startTransition + 느린 데이터)
const RootCompleted          = 5;  // 정상 완료
const RootDidNotComplete     = 6;  // 타임아웃으로 인한 포기
```

`RootInProgress`가 반환되면 React는 커밋을 하지 않고 다음 Scheduler 틱에서 다시 시작합니다. `RootCompleted`만이 `commitRoot`로 이어집니다.

### 1.4 performUnitOfWork: 작업의 최소 단위

```javascript
function performUnitOfWork(unitOfWork: Fiber): void {
  // alternate: 현재 화면에 렌더된 버전의 Fiber (더블 버퍼링)
  const current = unitOfWork.alternate;

  // ─── Begin Work: "이 Fiber를 처리해라" ───
  const next = beginWork(current, unitOfWork, renderLanes);

  // beginWork가 완료되면 pendingProps는 이제 확정된 props
  unitOfWork.memoizedProps = unitOfWork.pendingProps;

  if (next === null) {
    // 자식이 없음 (리프 노드) → 이 Fiber를 완료하고 형제/부모로 이동
    completeUnitOfWork(unitOfWork);
  } else {
    // 자식이 있음 → 자식으로 내려가서 계속 처리
    workInProgress = next;
  }
}
```

`beginWork`가 반환하는 `next`는 다음에 처리해야 할 Fiber입니다. `null`을 반환하면 "이 방향으로 더 내려갈 곳 없음"을 의미합니다.

트리 순회 패턴은 깊이 우선 탐색(DFS)입니다:

```
Begin:    HostRoot → App → Header → Nav
Complete: Nav → Header (Nav의 형제 없음, Header로 돌아옴)
Begin:    Main (Header의 형제) → Content
Complete: Content → Main
Begin:    Footer (Main의 형제) → Links
Complete: Links → Footer → App → HostRoot
```

---

## 2. beginWork: Fiber 타입별 처리의 스위치 보드

### 2.1 이중 bailout 구조

`beginWork`는 진입하자마자 두 단계의 bailout 가능성을 검사합니다.

```javascript
function beginWork(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
): Fiber | null {
  // ─── 1단계: Early Bailout (업데이트 경로에서만) ───
  if (current !== null) {
    const oldProps = current.memoizedProps;
    const newProps = workInProgress.pendingProps;

    if (
      oldProps === newProps &&          // props 참조가 동일 (불변성 전제)
      !hasLegacyContextChanged() &&     // Legacy Context 미변경
      (workInProgress.flags & DidCapture) === NoFlags  // Error 캡처 중 아님
    ) {
      // 스케줄된 업데이트나 Context 변경이 없다면 bailout
      didReceiveUpdate = false;
      return attemptEarlyBailoutIfNoScheduledUpdate(
        current, workInProgress, renderLanes
      );
    }
  }

  // ─── 렌더 경로 진입 ───
  didReceiveUpdate = false;

  // ─── 2단계: Fiber 타입별 처리 ───
  switch (workInProgress.tag) {
    case FunctionComponent:
      return updateFunctionComponent(current, workInProgress, ...);
    case ClassComponent:
      return updateClassComponent(current, workInProgress, ...);
    case HostRoot:
      return updateHostRoot(current, workInProgress, renderLanes);
    case HostComponent:
      return updateHostComponent(current, workInProgress, renderLanes);
    case HostText:
      return updateHostText(current, workInProgress);
    case MemoComponent:
      return updateMemoComponent(current, workInProgress, ...);
    case SimpleMemoComponent:
      return updateSimpleMemoComponent(current, workInProgress, ...);
    case ContextProvider:
      return updateContextProvider(current, workInProgress, renderLanes);
    case ContextConsumer:
      return updateContextConsumer(current, workInProgress, renderLanes);
    case SuspenseComponent:
      return updateSuspenseComponent(current, workInProgress, renderLanes);
    // ... (20개 이상의 타입)
  }
}
```

### 2.2 didReceiveUpdate: 숨겨진 통신 채널

`didReceiveUpdate`는 모듈 수준의 전역 변수입니다. `beginWork`와 `renderWithHooks` 사이의 통신 채널 역할을 합니다.

```
beginWork 진입
    │
    ├─ oldProps !== newProps → didReceiveUpdate = true
    └─ oldProps === newProps → didReceiveUpdate = false
              │
              ▼
         renderWithHooks 실행 (컴포넌트 함수 호출)
              │
              │ useState/useReducer에서 상태 변경 감지 시
              └─ didReceiveUpdate = true 로 덮어쓰기
              │
              ▼
         renderWithHooks 반환 후
              │
              ├─ didReceiveUpdate === false → bailoutHooks → bailout
              └─ didReceiveUpdate === true  → reconcileChildren 진행
```

props는 같지만 state가 변경된 경우(즉, `setState`로 인한 재렌더)를 처리하는 핵심 메커니즘입니다. `renderWithHooks`가 실행되어 Hook의 큐를 처리하는 도중 실제 상태 변경이 있었다면 `didReceiveUpdate`를 `true`로 설정합니다.

### 2.3 FunctionComponent: renderWithHooks와 Dispatcher

```javascript
function updateFunctionComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  Component: Function,
  nextProps: any,
  renderLanes: Lanes,
): Fiber | null {
  // prepareToReadContext: Context 의존성 목록 초기화
  prepareToReadContext(workInProgress, renderLanes);

  // 컴포넌트 함수 실행 (Hooks 포함)
  const nextChildren = renderWithHooks(
    current, workInProgress, Component, nextProps, undefined, renderLanes
  );

  // 업데이트 경로에서 Hook 결과가 변경 없으면 bailout
  if (current !== null && !didReceiveUpdate) {
    bailoutHooks(current, workInProgress, renderLanes);
    return bailoutOnAlreadyFinishedWork(current, workInProgress, renderLanes);
  }

  workInProgress.flags |= PerformedWork;

  // 자식 Fiber 생성/재조정
  reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  return workInProgress.child;
}
```

`renderWithHooks` 내부에서는 Dispatcher를 교체합니다:

```javascript
function renderWithHooks(current, workInProgress, Component, props, ...) {
  currentlyRenderingFiber = workInProgress;

  // mount vs update: 서로 다른 Dispatcher 사용
  ReactCurrentDispatcher.current =
    current === null || current.memoizedState === null
      ? HooksDispatcherOnMount    // 최초 마운트
      : HooksDispatcherOnUpdate;  // 이후 업데이트

  // ─── 컴포넌트 함수 실행 ───
  let children = Component(props, secondArg);

  // RE_RENDER 처리 (렌더 중 setState 호출 시)
  // RE_RENDER_LIMIT = 25 초과 시 에러
  if (didScheduleRenderPhaseUpdateDuringThisPass) {
    do {
      didScheduleRenderPhaseUpdateDuringThisPass = false;
      localIdCounter = 0;
      if (numberOfReRenders >= RE_RENDER_LIMIT) {
        throw new Error('Too many re-renders. React limits the number...');
      }
      numberOfReRenders += 1;
      currentHook = null;
      workInProgressHook = null;
      workInProgress.updateQueue = null;

      ReactCurrentDispatcher.current = HooksDispatcherOnRerender;
      children = Component(props, secondArg);
    } while (didScheduleRenderPhaseUpdateDuringThisPass);
  }

  // Dispatcher를 "사용 불가" 상태로 복원
  // (렌더 외부에서 Hook 호출 방지)
  ReactCurrentDispatcher.current = ContextOnlyDispatcher;

  currentlyRenderingFiber = null;
  currentHook = null;
  workInProgressHook = null;

  return children;
}
```

`ContextOnlyDispatcher`는 모든 Hook을 `throwInvalidHookError`로 대체합니다. 컴포넌트 밖에서 `useState()`를 호출하면 "Invalid hook call" 에러가 나는 이유가 여기 있습니다.

### 2.4 HostRoot: UpdateQueue 처리

```javascript
function updateHostRoot(current, workInProgress, renderLanes) {
  // HostRoot는 업데이트 큐를 가짐 (root.render(element) 등)
  const prevState = workInProgress.memoizedState;
  const prevChildren = prevState.element;

  // Clone하여 WIP에 적용
  cloneUpdateQueue(current, workInProgress);

  // 큐의 모든 업데이트를 처리하여 새 상태 계산
  processUpdateQueue(workInProgress, nextProps, null, renderLanes);

  const nextState = workInProgress.memoizedState;
  const nextChildren = nextState.element; // render(<App/>)에서 전달된 ReactElement

  if (nextChildren === prevChildren) {
    // element가 동일하면 bailout
    return bailoutOnAlreadyFinishedWork(current, workInProgress, renderLanes);
  }

  reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  return workInProgress.child;
}
```

### 2.5 HostComponent: shouldSetTextContent 최적화

DOM 요소(`<div>`, `<span>` 등)를 처리합니다.

```javascript
function updateHostComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  const type = workInProgress.type;      // 'div', 'span', 'input', ...
  const nextProps = workInProgress.pendingProps;
  const prevProps = current !== null ? current.memoizedProps : null;

  let nextChildren = nextProps.children;

  // 단순 텍스트 자식 최적화
  // <div>Hello</div> → children을 별도 HostText Fiber 없이 처리
  const isDirectTextChild = shouldSetTextContent(type, nextProps);

  if (isDirectTextChild) {
    nextChildren = null; // 자식 Fiber를 만들지 않음 (DOM에서 직접 처리)
  } else if (prevProps !== null && shouldSetTextContent(type, prevProps)) {
    // 이전에 텍스트였는데 이제 아님 → 텍스트 초기화 플래그
    workInProgress.flags |= ContentReset;
  }

  reconcileChildren(current, workInProgress, nextChildren, renderLanes);
  return workInProgress.child;
}
```

`shouldSetTextContent`는 `children`이 문자열이나 숫자인 경우 `true`를 반환합니다. 이 경우 React는 별도의 `HostText` Fiber를 만들지 않고 DOM 노드의 `textContent`를 직접 설정합니다. `<div>Hello</div>`와 `<div><span>Hello</span></div>`의 처리 방식이 다른 이유입니다.

### 2.6 ClassComponent: getDerivedStateFromProps와 shouldComponentUpdate

```javascript
function updateClassComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  Component: any,
  nextProps: any,
  renderLanes: Lanes,
) {
  const instance = workInProgress.stateNode; // 클래스 인스턴스

  let shouldUpdate;

  if (instance === null) {
    // ─── 마운트 경로 ───
    constructClassInstance(workInProgress, Component, nextProps);
    mountClassInstance(workInProgress, Component, nextProps, renderLanes);
    shouldUpdate = true;
  } else if (current === null) {
    // ─── 이전에 중단됐다가 재개 ───
    shouldUpdate = resumeMountClassInstance(workInProgress, Component, ...);
  } else {
    // ─── 업데이트 경로 ───
    shouldUpdate = updateClassInstance(current, workInProgress, Component, ...);
  }

  return finishClassComponent(
    current, workInProgress, Component, shouldUpdate, hasContext, renderLanes
  );
}

function updateClassInstance(current, workInProgress, Component, ...) {
  const instance = workInProgress.stateNode;

  const prevProps = workInProgress.memoizedProps;
  const nextProps = workInProgress.pendingProps;

  // 1. getDerivedStateFromProps (static 메서드)
  if (typeof Component.getDerivedStateFromProps === 'function') {
    applyDerivedStateFromProps(
      workInProgress, Component, getDerivedStateFromProps, nextProps,
    );
  }

  // 2. shouldComponentUpdate 판단
  const shouldUpdate = checkShouldComponentUpdate(
    workInProgress, Component,
    prevProps, nextProps,
    oldState, newState, nextContext,
  );

  if (shouldUpdate) {
    // lifecycle 플래그 설정
    if (!hasNewLifecycles && typeof instance.componentDidUpdate === 'function') {
      workInProgress.flags |= Update;
    }
    if (typeof instance.getSnapshotBeforeUpdate === 'function') {
      workInProgress.flags |= Snapshot;
    }
  }

  return shouldUpdate;
}
```

### 2.7 MemoComponent vs SimpleMemoComponent

React.memo는 두 가지 다른 WorkTag로 처리됩니다.

```javascript
// React.memo(fn) 최초 마운트 시 결정 로직
function resolveLazyComponentTag(Component) {
  if (typeof Component === 'function') {
    // 함수라면 클래스인지 함수형인지 판단
    return shouldConstruct(Component) ? ClassComponent : FunctionComponent;
  }
  if (Component !== undefined && Component !== null) {
    const $$typeof = Component.$$typeof;
    if ($$typeof === REACT_FORWARD_REF_TYPE) return ForwardRef;
    if ($$typeof === REACT_MEMO_TYPE) {
      return Component.compare === null
        ? SimpleMemoComponent  // 커스텀 compare 없음
        : MemoComponent;       // 커스텀 compare 있음
    }
  }
}
```

**MemoComponent** (tag=14): `React.memo(fn, customCompare)`
**SimpleMemoComponent** (tag=15): `React.memo(fn)` — 더 최적화된 경로

```javascript
function updateSimpleMemoComponent(current, workInProgress, Component, ...) {
  if (current !== null) {
    const prevProps = current.memoizedProps;
    const nextProps = workInProgress.pendingProps;

    if (
      shallowEqual(prevProps, nextProps) &&
      current.ref === workInProgress.ref &&
      workInProgress.type === current.type  // 타입 변경 감지
    ) {
      didReceiveUpdate = false;

      // props가 같아도 state/context 변경이 있을 수 있음
      if (!checkScheduledUpdateOrContext(current, renderLanes)) {
        workInProgress.lanes = current.lanes;
        return bailoutOnAlreadyFinishedWork(current, workInProgress, renderLanes);
      } else if ((current.flags & ForceUpdateForLegacySuspense) !== NoFlags) {
        // Legacy Suspense를 위한 특수 케이스: 강제 업데이트
        didReceiveUpdate = true;
      }
    }
  }

  return updateFunctionComponent(current, workInProgress, Component, ...);
}
```

| 특성 | MemoComponent (14) | SimpleMemoComponent (15) |
|------|-------------------|--------------------------|
| 생성 조건 | `React.memo(fn, compare)` | `React.memo(fn)` |
| 비교 방식 | 커스텀 compare 또는 shallowEqual | shallowEqual 고정 |
| Fiber 구조 | 래퍼 Fiber + 내부 Fiber | 단일 Fiber |
| 최적화 | 표준 경로 | 더 짧은 코드 경로 |

### 2.8 ContextProvider: pushProvider와 propagateContextChange

```javascript
function updateContextProvider(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
) {
  // React 18: $$typeof === REACT_PROVIDER_TYPE
  // React 19: Provider가 Context 자체
  const context = workInProgress.type._context;

  const newProps = workInProgress.pendingProps;
  const oldProps = workInProgress.memoizedProps;
  const newValue = newProps.value;

  // 1. 새 값을 Context 스택에 push
  // → 하위 컴포넌트의 useContext()가 이 값을 읽음
  pushProvider(workInProgress, context, newValue);

  if (oldProps !== null) {
    const oldValue = oldProps.value;

    if (Object.is(oldValue, newValue)) {
      // 값 동일 + children 동일 → 완전한 bailout
      if (oldProps.children === newProps.children && !hasLegacyContextChanged()) {
        return bailoutOnAlreadyFinishedWork(current, workInProgress, renderLanes);
      }
    } else {
      // 값 변경! → 모든 구독자(consumer)를 찾아 업데이트 표시
      propagateContextChange(workInProgress, context, renderLanes);
    }
  }

  reconcileChildren(current, workInProgress, newProps.children, renderLanes);
  return workInProgress.child;
}
```

**Context 스택 메커니즘:**

```javascript
// Context.Provider가 중첩될 때 스택이 쌓임
function pushProvider(providerFiber, context, nextValue) {
  if (isPrimaryRenderer) {
    push(valueCursor, context._currentValue, providerFiber);
    context._currentValue = nextValue; // 현재 렌더링 중 이 값을 읽게 됨
  }
}

// Provider의 subtree 처리가 끝날 때 (completeWork 시점)
function popProvider(context, providerFiber) {
  context._currentValue = valueCursor.current; // 이전 값 복원
  pop(valueCursor, providerFiber);
}
```

useContext(MyContext)는 내부적으로 `context._currentValue`를 직접 읽습니다. O(1) 접근입니다. 스택 덕분에 중첩 Provider도 올바르게 작동합니다.

---

## 3. propagateContextChange: 구독자 탐색의 비밀

Context 값이 변경됐을 때 React는 Provider의 하위 트리 전체를 DFS로 순회하여 해당 Context를 구독하는 Fiber를 찾아냅니다.

### 3.1 DFS 순회 구현

```javascript
function propagateContextChange_eager(workInProgress, context, renderLanes) {
  let fiber = workInProgress.child;

  while (fiber !== null) {
    let nextFiber;

    // 이 Fiber가 context를 구독하는지 확인
    const list = fiber.dependencies; // Context 의존성 연결 리스트
    if (list !== null) {
      nextFiber = fiber.child;

      // firstContext부터 시작하는 연결 리스트 순회
      let dependency = list.firstContext;
      while (dependency !== null) {
        if (dependency.context === context) {
          // !! 이 Fiber가 변경된 Context를 구독 중

          // ClassComponent: ForceUpdate를 큐에 추가
          if (fiber.tag === ClassComponent) {
            const lane = pickArbitraryLane(renderLanes);
            const update = createUpdate(lane);
            update.tag = ForceUpdate;
            enqueueUpdate(fiber, update, lane);
          }

          // lanes 표시: 이 Fiber는 이 렌더에서 반드시 재처리
          fiber.lanes = mergeLanes(fiber.lanes, renderLanes);
          if (fiber.alternate !== null) {
            fiber.alternate.lanes = mergeLanes(fiber.alternate.lanes, renderLanes);
          }

          // 조상 경로에 childLanes 버블링 (bailout 우회를 위해 필수!)
          scheduleContextWorkOnParentPath(
            fiber.return, renderLanes, workInProgress
          );
          break;
        }
        dependency = dependency.next;
      }
    } else if (fiber.tag === ContextProvider) {
      // 동일 Context의 중첩 Provider 발견
      // → 그 아래는 다른 Provider가 제공하는 값이므로 탐색 중단
      nextFiber = fiber.type === workInProgress.type ? null : fiber.child;
    } else {
      nextFiber = fiber.child;
    }

    // DFS 순회: child → sibling → uncle
    if (nextFiber !== null) {
      nextFiber.return = fiber;
    } else {
      nextFiber = fiber;
      while (nextFiber !== null) {
        if (nextFiber === workInProgress) { nextFiber = null; break; }
        const sibling = nextFiber.sibling;
        if (sibling !== null) {
          sibling.return = nextFiber.return;
          nextFiber = sibling;
          break;
        }
        nextFiber = nextFiber.return;
      }
    }
    fiber = nextFiber;
  }
}
```

### 3.2 Context 의존성 연결 리스트

각 Fiber의 `dependencies.firstContext`는 해당 컴포넌트가 구독하는 모든 Context의 연결 리스트입니다.

```
Fiber.dependencies
  └── firstContext: ContextDependency
        ├── context: ThemeContext  ← Object 참조로 비교
        ├── memoizedValue: 'dark'  ← 마지막으로 읽은 값 (미래 최적화용)
        └── next: ContextDependency
              ├── context: UserContext
              ├── memoizedValue: { id: 42 }
              └── next: null
```

이 리스트는 컴포넌트 렌더 중 `useContext(MyContext)`가 호출될 때마다 추가됩니다:

```javascript
function readContext(context) {
  const value = context._currentValue; // O(1) 읽기

  // 현재 렌더 중인 Fiber에 dependency 등록
  const contextItem = {
    context: context,
    memoizedValue: value,
    next: null,
  };

  if (lastContextDependency === null) {
    // 첫 번째 Context 의존성
    currentlyRenderingFiber.dependencies = {
      lanes: NoLanes,
      firstContext: contextItem,
    };
    lastContextDependency = contextItem;
  } else {
    // 기존 리스트에 추가
    lastContextDependency = lastContextDependency.next = contextItem;
  }

  return value;
}
```

### 3.3 scheduleContextWorkOnParentPath: 조상 경로 마킹

Consumer Fiber에 lanes를 표시하는 것만으로는 부족합니다. `bailoutOnAlreadyFinishedWork`는 조상의 `childLanes`를 보고 서브트리 전체를 건너뛰기 때문입니다. 조상 경로의 `childLanes`도 모두 업데이트해야 합니다.

```javascript
function scheduleContextWorkOnParentPath(parent, renderLanes, propagationRoot) {
  let node = parent;
  while (node !== null) {
    const alternate = node.alternate;

    if (!isSubsetOfLanes(node.childLanes, renderLanes)) {
      // 이 조상의 childLanes에 renderLanes를 추가
      node.childLanes = mergeLanes(node.childLanes, renderLanes);
      if (alternate !== null) {
        alternate.childLanes = mergeLanes(alternate.childLanes, renderLanes);
      }
    }

    if (node === propagationRoot) break; // Provider까지 올라왔으면 중단

    node = node.return;
  }
}
```

---

## 4. bailoutOnAlreadyFinishedWork: 서브트리 단위 최적화

### 4.1 childLanes를 이용한 서브트리 skip

```javascript
function bailoutOnAlreadyFinishedWork(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
): Fiber | null {
  // context 의존성을 current에서 복사 (bailout 중에도 의존성 유지)
  if (current !== null) {
    workInProgress.dependencies = current.dependencies;
  }

  // 핵심: 이 Fiber의 후손 중 renderLanes에 해당하는 작업이 있는가?
  if (!includesSomeLane(renderLanes, workInProgress.childLanes)) {
    // 없다! → 자식 전체를 건너뜀 (null 반환 = 자식 방문 안 함)
    return null;
  }

  // 있다! → 이 Fiber는 bailout이지만, 자식은 방문해야 함
  // current.child를 WIP에 복사 (얕은 복사)
  cloneChildFibers(current, workInProgress);
  return workInProgress.child;
}
```

`childLanes`는 해당 Fiber의 **모든 후손**이 가진 lanes의 OR 합집합입니다. 이 값은 `scheduleUpdateOnFiber`가 호출될 때 루트 방향으로 모든 조상의 `childLanes`를 갱신하면서 유지됩니다.

```
루트 (childLanes: 0b0110)
 └─ A (childLanes: 0b0110)   ← B와 D의 lanes를 포함
     ├─ B (lanes: 0b0010)    ← setState 호출됨
     └─ C (childLanes: 0b0100)
         └─ D (lanes: 0b0100) ← 별개의 setState
```

`renderLanes`가 `0b0010` (B의 업데이트만 처리)라면:

- A: `includesSomeLane(0b0010, 0b0110)` = `true` → 자식 방문
- B: 실제 업데이트 처리
- C: `includesSomeLane(0b0010, 0b0100)` = `false` → **서브트리 전체 skip**

### 4.2 실제 성능 영향

현실적인 React 앱에서 하나의 `setState`는 전체 Fiber 트리의 **1~5%** 정도만 실제로 재렌더합니다. 수천 개 노드 중 실제로 컴포넌트 함수가 재실행되는 건 수십 개에 불과합니다. 나머지는 `bailoutOnAlreadyFinishedWork`가 처리합니다.

### 4.3 attemptEarlyBailoutIfNoScheduledUpdate

`beginWork`의 최상단 early bailout 경로에서 호출됩니다:

```javascript
function attemptEarlyBailoutIfNoScheduledUpdate(current, workInProgress, renderLanes) {
  // 타입별 특수 처리
  switch (workInProgress.tag) {
    case ContextProvider: {
      // Provider bailout: 스택은 여전히 push해야 함
      const newValue = workInProgress.pendingProps.value;
      pushProvider(workInProgress, workInProgress.type._context, newValue);
      break;
    }
    case SuspenseComponent: {
      // Suspense bailout: dehydration 상태 처리
      const state = workInProgress.memoizedState;
      if (state !== null) {
        if (state.dehydrated !== null) {
          // Server-side dehydrated Suspense는 bailout 불가
          return updateDehydratedSuspenseComponent(
            current, workInProgress, false, null, renderLanes
          );
        }
      }
      break;
    }
    // ...
  }

  return bailoutOnAlreadyFinishedWork(current, workInProgress, renderLanes);
}
```

ContextProvider는 bailout 상황에서도 `pushProvider`를 반드시 호출해야 합니다. 하위 컴포넌트의 `useContext`가 스택에서 값을 읽기 때문입니다.

---

## 5. reconcileChildFibers vs mountChildFibers

### 5.1 shouldTrackSideEffects로 생성되는 두 버전

```javascript
// packages/react-reconciler/src/ReactChildFiber.js

// 두 버전 모두 동일한 팩토리에서 생성 — boolean 하나가 모든 차이를 만든다
export const reconcileChildFibers: ChildReconciler =
  createChildReconciler(true);   // 업데이트 경로: Placement 플래그 추적

export const mountChildFibers: ChildReconciler =
  createChildReconciler(false);  // 마운트 경로: 플래그 추적 안 함
```

`shouldTrackSideEffects = false`의 핵심 차이점:

```javascript
function createChildReconciler(shouldTrackSideEffects: boolean) {

  function placeSingleChild(newFiber: Fiber): Fiber {
    // 업데이트 경로에서, 새로 생성된 Fiber에만 Placement 설정
    if (shouldTrackSideEffects && newFiber.alternate === null) {
      newFiber.flags |= Placement | PlacementDEV;
    }
    return newFiber;
  }

  function placeChild(newFiber, lastPlacedIndex, newIndex) {
    newFiber.index = newIndex;

    if (!shouldTrackSideEffects) {
      // 마운트 시: Placement 플래그 설정 안 함
      // 부모가 통째로 삽입될 것이므로 개별 Placement 불필요
      newFiber.flags |= Forked; // 서버 렌더링 등 추적용
      return lastPlacedIndex;
    }

    const current = newFiber.alternate;
    if (current !== null) {
      // 재사용된 Fiber: 이전 위치와 현재 위치 비교
      const oldIndex = current.index;
      if (oldIndex < lastPlacedIndex) {
        // 이전 위치가 더 앞 → 뒤로 이동 → Placement 필요
        newFiber.flags |= Placement;
        return lastPlacedIndex;
      } else {
        return oldIndex; // 제자리 또는 앞으로 → 이동 불필요
      }
    } else {
      // 새로 생성된 Fiber → 삽입
      newFiber.flags |= Placement;
      return lastPlacedIndex;
    }
  }
```

### 5.2 mountChildFibers를 쓰는 이유: O(N) vs O(1) DOM 삽입

```
reconcileChildFibers를 마운트에 사용할 경우 (비효율):

App (Placement)
├── Header (Placement)   → appendChild 호출
│   └── Nav (Placement)  → appendChild 호출
├── Main (Placement)     → appendChild 호출
│   └── Content (Placement) → appendChild 호출
└── Footer (Placement)   → appendChild 호출

= 5번의 실제 DOM API 호출

mountChildFibers 사용 시 (실제 동작):

App: HostRoot의 자식이므로 HostRoot.current가 존재 → reconcileChildFibers
  App (Placement 설정) ← 이것 하나만

App의 자식들: mountChildFibers
  Header (플래그 없음)  → Placement 없음
  Main (플래그 없음)    → Placement 없음
  Footer (플래그 없음)  → Placement 없음

completeWork에서 메모리 상에서 DOM 트리 조립:
  Nav → Header에 appendChild (메모리 내)
  Content → Main에 appendChild (메모리 내)
  ...

최종적으로 App 하나를 실제 DOM에 삽입 (단 1번!)
```

### 5.3 배열 자식 처리: 2-pass 알고리즘

배열로 주어진 자식들의 재조정은 두 단계로 이루어집니다:

```javascript
function reconcileChildrenArray(returnFiber, currentFirstChild, newChildren, lanes) {
  // ─── 1단계: 선형 순회 (key 없는 경우 최적화) ───
  let oldFiber = currentFirstChild;
  let lastPlacedIndex = 0;
  let newIdx = 0;
  let nextOldFiber = null;

  // 이전/새 자식을 같은 인덱스에서 비교
  for (; oldFiber !== null && newIdx < newChildren.length; newIdx++) {
    if (oldFiber.index > newIdx) {
      nextOldFiber = oldFiber;
      oldFiber = null;
    } else {
      nextOldFiber = oldFiber.sibling;
    }

    const newFiber = updateSlot(returnFiber, oldFiber, newChildren[newIdx], lanes);

    if (newFiber === null) {
      // key가 맞지 않음 → 1단계 루프 중단
      if (oldFiber === null) oldFiber = nextOldFiber;
      break;
    }

    if (shouldTrackSideEffects && oldFiber && newFiber.alternate === null) {
      deleteChild(returnFiber, oldFiber); // 재사용 안 됨 → 삭제
    }
    lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
    // ... 연결
  }

  // ─── 1단계 조기 종료 처리 ───
  if (newIdx === newChildren.length) {
    // 새 자식을 모두 처리함 → 남은 이전 자식은 삭제
    deleteRemainingChildren(returnFiber, oldFiber);
    return resultingFirstChild;
  }

  if (oldFiber === null) {
    // 이전 자식이 없음 → 나머지 새 자식은 삽입
    for (; newIdx < newChildren.length; newIdx++) {
      const newFiber = createChild(returnFiber, newChildren[newIdx], lanes);
      if (newFiber === null) continue;
      lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
      // ... 연결
    }
    return resultingFirstChild;
  }

  // ─── 2단계: key 기반 Map으로 처리 (순서 변경 등) ───
  // 남은 이전 Fiber들을 key(또는 index)를 키로 하는 Map에 저장
  const existingChildren = mapRemainingChildren(returnFiber, oldFiber);

  for (; newIdx < newChildren.length; newIdx++) {
    const newFiber = updateFromMap(
      existingChildren, returnFiber, newIdx, newChildren[newIdx], lanes
    );
    if (newFiber !== null) {
      if (shouldTrackSideEffects && newFiber.alternate !== null) {
        // 재사용된 Fiber는 Map에서 제거 (나중에 남은 것들 삭제)
        existingChildren.delete(newFiber.key === null ? newIdx : newFiber.key);
      }
      lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
      // ... 연결
    }
  }

  // Map에 남은 Fiber들 = 새 children에 없음 → 삭제
  if (shouldTrackSideEffects) {
    existingChildren.forEach(child => deleteChild(returnFiber, child));
  }

  return resultingFirstChild;
}
```

**key의 역할이 명확해지는 순간**: 2단계에서 `mapRemainingChildren`이 만드는 Map의 키가 바로 Fiber의 `key` prop입니다. key가 있으면 위치가 바뀌어도 같은 Fiber를 재사용할 수 있습니다. key가 없으면 인덱스를 키로 사용하여 위치 이동 시 재사용 실패, 불필요한 DOM 삭제/삽입이 발생합니다.

---

## 6. completeWork: 아래에서 위로 올라오는 단계

### 6.1 마운트 vs 업데이트 경로

```javascript
function completeWork(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
): Fiber | null {
  const newProps = workInProgress.pendingProps;

  switch (workInProgress.tag) {
    case HostComponent: {
      const type = workInProgress.type;
      const rootContainerInstance = getRootHostContainer();

      if (current !== null && workInProgress.stateNode != null) {
        // ─── 업데이트 경로 ───
        // DOM 노드는 이미 있음 → props 차이만 계산
        updateHostComponent(
          current, workInProgress, type, newProps, rootContainerInstance
        );

        if (current.ref !== workInProgress.ref) {
          markRef(workInProgress); // Ref 플래그 설정
        }
      } else {
        // ─── 마운트 경로 ───
        if (!newProps) {
          bubbleProperties(workInProgress);
          return null; // 재사용 중
        }

        // 1. DOM 노드 생성
        const instance = createInstance(
          type, newProps, rootContainerInstance, currentHostContext, workInProgress
        );

        // 2. 자식 DOM 노드들을 instance에 추가 (appendAllChildren)
        appendAllChildren(instance, workInProgress, false, false);

        // 3. WIP에 DOM 노드 연결
        workInProgress.stateNode = instance;

        // 4. 초기 props 설정 (setAttribute 등)
        if (finalizeInitialChildren(instance, type, newProps, ...)) {
          // autoFocus가 필요한 경우
          markUpdate(workInProgress);
        }

        if (workInProgress.ref !== null) {
          markRef(workInProgress);
        }
      }

      bubbleProperties(workInProgress); // ← 항상 마지막에
      return null;
    }

    case HostText: {
      const newText = newProps as string;

      if (current !== null && workInProgress.stateNode != null) {
        // 업데이트: 텍스트 변경 여부 확인
        const oldText = current.memoizedProps;
        if (oldText !== newText) {
          markUpdate(workInProgress);
        }
      } else {
        // 마운트: 텍스트 노드 생성
        workInProgress.stateNode = createTextInstance(newText, ...);
      }

      bubbleProperties(workInProgress);
      return null;
    }

    // FunctionComponent, ClassComponent 등: 대부분 bubbleProperties만 호출
    case FunctionComponent:
    case ClassComponent:
    // ...
      bubbleProperties(workInProgress);
      return null;
  }
}
```

### 6.2 appendAllChildren: 메모리상 DOM 트리 조립

마운트 경로에서 새 DOM 노드를 만든 직후 `appendAllChildren`이 호출됩니다. 이 함수는 이미 `completeWork`를 마친 자식 Fiber들의 DOM 노드를 찾아 현재 노드에 붙입니다.

```javascript
function appendAllChildren(
  parent: Instance,
  workInProgress: Fiber,
  needsVisibilityToggle: boolean,
  isHidden: boolean,
) {
  // 자식 Fiber부터 시작
  let node = workInProgress.child;

  while (node !== null) {
    if (node.tag === HostComponent || node.tag === HostText) {
      // 직접적인 DOM 노드 → 부모에 추가
      appendInitialChild(parent, node.stateNode);
    } else if (node.tag === HostPortal) {
      // Portal은 다른 컨테이너에 삽입되므로 건너뜀
    } else if (node.child !== null) {
      // 함수형 컴포넌트 등 DOM 노드가 없는 경우 → 자식으로 내려감
      node.child.return = node;
      node = node.child;
      continue;
    }

    if (node === workInProgress) return;

    // 형제가 없으면 부모로 올라가서 형제 탐색
    while (node.sibling === null) {
      if (node.return === null || node.return === workInProgress) return;
      node = node.return;
    }
    node.sibling.return = node.return;
    node = node.sibling;
  }
}
```

이 함수가 실행되는 시점에 자식들은 이미 `completeWork`를 마쳤습니다(DFS 특성상 아래에서 위로 완료됨). 따라서 자식 DOM 노드들은 메모리에 이미 존재합니다. `appendAllChildren`은 이 노드들을 메모리 상에서 트리로 조립합니다. 실제 DOM에 붙이는 작업은 Commit Phase에서 한 번만 일어납니다.

### 6.3 updateHostComponent: diffProperties와 updatePayload

업데이트 경로의 `completeWork`에서 props 차이를 계산합니다:

```javascript
function updateHostComponent(current, workInProgress, type, newProps, ...) {
  const oldProps = current.memoizedProps;

  if (oldProps === newProps) {
    // 객체 참조 동일 → 변경 없음 확정
    return;
  }

  // DOM 속성 diff 계산
  const updatePayload = prepareUpdate(
    instance, type, oldProps, newProps, rootContainerInstance, currentHostContext
  );

  // updatePayload를 updateQueue에 저장
  // → Commit Phase의 commitUpdate에서 실제 DOM에 반영
  workInProgress.updateQueue = updatePayload;

  if (updatePayload !== null) {
    markUpdate(workInProgress); // flags |= Update
  }
}
```

`diffProperties`가 생성하는 `updatePayload`는 `[key, value, key, value, ...]` 형태의 배열입니다:

```javascript
// 예시:
// 이전: <div className="old" style={{color: 'blue'}} />
// 새:   <div className="new" style={{color: 'red', fontSize: '16px'}} />

updatePayload = [
  'className', 'new',
  'style', { color: 'red', fontSize: '16px' },
]
```

이벤트 핸들러(`onClick`, `onChange` 등)는 updatePayload에 들어가지 않습니다. React의 이벤트 시스템은 이벤트 위임(Event Delegation)으로 구현되어 있어, 모든 이벤트를 root 컨테이너에서 처리합니다. `onClick` prop이 변경되어도 DOM API 호출은 필요 없습니다.

### 6.4 bubbleProperties: subtreeFlags 집계

```javascript
function bubbleProperties(completedWork: Fiber) {
  const didBailout =
    completedWork.alternate !== null &&
    completedWork.alternate.child === completedWork.child;

  let newChildLanes: Lanes = NoLanes;
  let subtreeFlags: Flags = NoFlags;

  if (!didBailout) {
    // 실제 재처리된 경우: 자식 전체 순회
    let child = completedWork.child;
    while (child !== null) {
      newChildLanes = mergeLanes(
        newChildLanes,
        mergeLanes(child.lanes, child.childLanes)
      );

      // 자식의 subtreeFlags + 자식 자신의 flags를 부모 subtreeFlags에 포함
      subtreeFlags |= child.subtreeFlags;
      subtreeFlags |= child.flags;

      child.return = completedWork; // return 포인터 확인
      child = child.sibling;
    }
  } else {
    // bailout인 경우: StaticMask만 전파 (성능 최적화)
    let child = completedWork.child;
    while (child !== null) {
      newChildLanes = mergeLanes(
        newChildLanes,
        mergeLanes(child.lanes, child.childLanes)
      );

      // StaticMask: 한 번 설정되면 변하지 않는 플래그들만 전파
      subtreeFlags |= child.subtreeFlags & StaticMask;
      subtreeFlags |= child.flags & StaticMask;

      child.return = completedWork;
      child = child.sibling;
    }
  }

  completedWork.subtreeFlags |= subtreeFlags;
  completedWork.childLanes = newChildLanes;

  return didBailout;
}
```

`subtreeFlags`가 왜 중요한지는 Commit Phase에서 드러납니다:

```javascript
// commitRoot 진입 시 전체 트리를 순회할 필요 없이:
if (
  (finishedWork.subtreeFlags & MutationMask) === NoFlags &&
  (finishedWork.flags & MutationMask) === NoFlags
) {
  // DOM 변경이 전혀 없음 → Mutation Phase 전체 skip!
}

// Mutation Phase 순회 중:
function recursivelyTraverseMutationEffects(root, parentFiber, lanes) {
  if (parentFiber.subtreeFlags & MutationMask) {
    // 변경 있는 자식만 방문
    let child = parentFiber.child;
    while (child !== null) {
      commitMutationEffectsOnFiber(child, root, lanes);
      child = child.sibling;
    }
  }
  // subtreeFlags에 변경 없으면 자식 전체 건너뜀!
}
```

---

## 7. ReactFiberFlags: 비트마스크 플래그 시스템

### 7.1 전체 플래그 목록

```javascript
// packages/react-reconciler/src/ReactFiberFlags.js

// 기본 마킹
const NoFlags          = 0b00000000000000000000000000000;
const PerformedWork    = 0b00000000000000000000000000001;  // 1: React DevTools용

// DOM 변경
const Placement        = 0b00000000000000000000000000010;  // 2: DOM 삽입
const Update           = 0b00000000000000000000000000100;  // 4: DOM 업데이트
const ChildDeletion    = 0b00000000000000000000000001000;  // 8: 자식 삭제 (부모에 설정)
const ContentReset     = 0b00000000000000000000000010000;  // 16: textContent 초기화
const Ref              = 0b00000000000000000000000100000;  // 32: ref 갱신

// 에러 처리
const DidCapture       = 0b00000000000000000000010000000;  // Error/Suspense 캡처됨
const ShouldCapture    = 0b00000000000000100000000000000;  // 캡처 예정

// Effects
const Snapshot         = 0b00000000000000000001000000000;  // getSnapshotBeforeUpdate
const Passive          = 0b00000000000000000010000000000;  // useEffect
const Visibility       = 0b00000000000000000100000000000;  // Offscreen 가시성
const Callback         = 0b00000000000000000000001000000;  // setState 콜백

// Commit Phase 마스크 (각 단계에서 관련 플래그를 AND로 체크)
const BeforeMutationMask = Snapshot | Passive;
const MutationMask       = Placement | Update | ChildDeletion |
                           ContentReset | Ref | Visibility | Hydrating;
const LayoutMask         = Update | Callback | Ref | Visibility;
const PassiveMask        = Passive | ChildDeletion;
```

### 7.2 플래그가 설정되는 시점

| 플래그 | 설정 위치 | 설정 조건 |
|--------|-----------|-----------|
| `Placement` | reconcileChildFibers → placeChild | 새 Fiber 삽입 또는 이동 |
| `Update` | completeWork → markUpdate | DOM 속성 변경 (updatePayload != null) |
| `ChildDeletion` | reconcileChildFibers → deleteChild | 자식 제거 (부모에 설정) |
| `ContentReset` | beginWork → updateHostComponent | 텍스트→비텍스트 변경 |
| `Ref` | completeWork → markRef | ref prop 변경 |
| `Snapshot` | updateClassComponent | getSnapshotBeforeUpdate 있음 |
| `Passive` | renderWithHooks → mountEffect/updateEffect | useEffect 의존성 변경 |
| `DidCapture` | throwException | Error Boundary가 에러 캡처 |
| `Visibility` | updateOffscreenComponent | Offscreen 가시성 토글 |

### 7.3 subtreeFlags와 플래그 마스크의 조합

```
처리 전 Fiber 트리 (subtreeFlags 포함):

Root (subtreeFlags: Placement | Passive | Update)
├── A (subtreeFlags: Placement | Passive)
│   ├── B (flags: Placement)              ← 새로 삽입됨
│   └── C (subtreeFlags: Passive)
│       └── D (flags: Passive)            ← useEffect 실행 필요
└── E (subtreeFlags: Update)
    └── F (flags: Update)                 ← DOM 업데이트 필요
```

Commit Phase의 Before Mutation 단계:
- `BeforeMutationMask = Snapshot | Passive`
- Root.subtreeFlags & BeforeMutationMask = Passive ≠ 0 → 탐색
- A.subtreeFlags & BeforeMutationMask = Passive ≠ 0 → 탐색
- C.subtreeFlags & BeforeMutationMask = Passive ≠ 0 → D 방문 (Passive 처리)
- E.subtreeFlags & BeforeMutationMask = 0 → **E 서브트리 전체 skip**

---

## 8. shallowEqual: React.memo의 비교 엔진

### 8.1 Object.is 기반 구현

```javascript
// packages/shared/shallowEqual.js

function shallowEqual(objA: mixed, objB: mixed): boolean {
  // 1단계: 완전 동일 (원시값 또는 참조 동일)
  if (Object.is(objA, objB)) return true;

  // 2단계: 타입 가드
  if (
    typeof objA !== 'object' || objA === null ||
    typeof objB !== 'object' || objB === null
  ) {
    return false;
  }

  // 3단계: 키 개수 비교
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;

  // 4단계: 각 값을 Object.is로 비교
  for (let i = 0; i < keysA.length; i++) {
    const currentKey = keysA[i];
    if (
      !hasOwnProperty.call(objB, currentKey) ||
      !Object.is(objA[currentKey], objB[currentKey])
    ) {
      return false;
    }
  }

  return true;
}
```

`Object.is`와 `===`의 차이:

```javascript
NaN === NaN        // false (잘못된 결과)
Object.is(NaN, NaN) // true  (올바른 결과)

+0 === -0          // true  (수학적으로 다름)
Object.is(+0, -0)  // false (올바른 결과)
```

NaN이 포함된 상태값이 있을 때 `===` 비교는 항상 false를 반환하여 매번 재렌더가 트리거됩니다. `Object.is` 기반 비교는 이를 방지합니다.

### 8.2 React.memo custom compare 함수의 반환 시맨틱

**중요**: React.memo의 compare 함수는 `shouldComponentUpdate`와 **반대** 시맨틱입니다.

```javascript
// shouldComponentUpdate: "업데이트해야 하는가?"
// → true = 렌더, false = 건너뜀

// React.memo compare: "같은가?"
// → true = 같다 = 건너뜀 (bailout)
// → false = 다르다 = 렌더

const MyComponent = React.memo(Component, (prevProps, nextProps) => {
  // ✓ 올바른 사용: "같을 때 true 반환"
  return prevProps.id === nextProps.id && prevProps.version === nextProps.version;
});

// ✗ 흔한 실수: shouldComponentUpdate 시맨틱으로 작성
const WrongMemo = React.memo(Component, (prev, next) => {
  return prev.id !== next.id; // 다를 때 true → "같다"로 판단 → 업데이트 안 됨!
});
```

내부 처리:

```javascript
function updateMemoComponent(current, workInProgress, Component, ...) {
  const compare = Component.compare;
  const customCompare = compare !== null ? compare : shallowEqual;

  if (customCompare(prevProps, nextProps)) {
    // compare가 true = "props가 같다" = bailout
    return bailoutOnAlreadyFinishedWork(...);
  }
  // compare가 false = "props가 다르다" = 렌더 진행
  return updateFunctionComponent(...);
}
```

### 8.3 의존성 배열 비교: areHookInputsEqual

useEffect, useMemo, useCallback의 의존성 배열은 `shallowEqual`이 아닌 `areHookInputsEqual`로 비교합니다:

```javascript
function areHookInputsEqual(nextDeps: Array<mixed>, prevDeps: Array<mixed> | null) {
  if (prevDeps === null) return false; // 첫 렌더

  for (let i = 0; i < prevDeps.length && i < nextDeps.length; i++) {
    if (Object.is(nextDeps[i], prevDeps[i])) continue;
    return false;
  }
  return true;
}
```

차이점:
- `shallowEqual`: Object.keys 기반, 순서 무관, 객체 허용
- `areHookInputsEqual`: 인덱스 기반, 순서 중요, 배열만 허용

의존성 배열에서 순서가 다른 경우 다른 배열로 취급됩니다. `[a, b]`와 `[b, a]`는 같은 값이어도 다른 deps입니다.

---

## 9. 렌더 사이클의 멱등성

### 9.1 왜 컴포넌트 함수는 순수해야 하는가

Concurrent Mode에서 React는 단일 업데이트에 대해 렌더 함수를 **여러 번** 호출할 수 있습니다. 의도적 설계입니다:

1. **Time Slicing으로 중단 후 재개**: 중단 시점까지의 결과를 버리고 처음부터 다시 시작
2. **Suspense 재시도**: Promise resolve 후 동일 컴포넌트 재렌더
3. **Offscreen 사전 렌더링**: 아직 보이지 않는 화면을 미리 렌더
4. **Strict Mode double invoke**: 순수성 검증 (개발 환경)

멱등성이란 같은 입력에 대해 항상 같은 출력을 보장하는 성질입니다:

```javascript
// ✓ 멱등: 같은 count → 항상 같은 JSX
function Counter({ count }) {
  return <div>{count}</div>;
}

// ✗ 비멱등: 렌더 횟수에 따라 출력이 달라짐
let renderCount = 0;
function BadCounter({ count }) {
  renderCount++; // 외부 상태 변경!
  console.log('rendered'); // 부수 효과!
  return <div>{count} (rendered: {renderCount})</div>;
}
```

### 9.2 Strict Mode Double Invoke 구현

```javascript
// renderWithHooks 내부 (개발 환경)
let children = Component(props, secondArg);

if (
  debugRenderPhaseSideEffectsForStrictMode &&
  workInProgress.mode & StrictLegacyMode
) {
  setIsStrictModeForDevtools(true);
  try {
    // 두 번째 호출 — 결과는 실제로 버려짐
    children = Component(props, secondArg);
  } finally {
    setIsStrictModeForDevtools(false);
  }
}

return children;
```

두 번째 호출 결과는 버려집니다. React가 확인하는 건 "두 번 호출했을 때 부수 효과가 발생하는가"입니다. 콘솔 로그가 두 번 찍히거나, 외부 API가 두 번 호출되거나, 컴포넌트가 다르게 동작한다면 순수성 위반 신호입니다.

---

## 10. 전체 Render Phase 흐름 종합

```
setState() 호출
    │
    ▼
enqueueUpdate(fiber, update, lane)
    │ fiber.lanes 설정, 루트까지 childLanes 버블링
    ▼
ensureRootIsScheduled()
    │
    ├─ SyncLane → scheduleMicrotask → flushSyncCallbacks
    └─ 기타   → Scheduler.scheduleCallback(priority, callback)
    │
    ▼
performConcurrentWorkOnRoot(root)
    │
    ├─ shouldTimeSlice? → renderRootConcurrent (TransitionLane만)
    └─ 나머지          → renderRootSync
    │
    ▼
workLoopConcurrent / workLoopSync
    │
    ▼
performUnitOfWork(WIP)
    │
    ├── beginWork(current, WIP, renderLanes)
    │       │
    │       ├── [Early Bailout]
    │       │   oldProps === newProps && !scheduledUpdate
    │       │   → attemptEarlyBailoutIfNoScheduledUpdate
    │       │   → bailoutOnAlreadyFinishedWork
    │       │       → childLanes ⊄ renderLanes → null (서브트리 skip)
    │       │       → childLanes ⊇ renderLanes → cloneChildFibers → 자식 방문
    │       │
    │       └── [WorkTag 분기]
    │             FunctionComponent → renderWithHooks
    │               → didReceiveUpdate 체크
    │               → reconcileChildren
    │             HostRoot → processUpdateQueue → reconcileChildren
    │             HostComponent → shouldSetTextContent → reconcileChildren
    │             ClassComponent → getDerivedStateFromProps → shouldComponentUpdate
    │             MemoComponent → shallowEqual → bailout or render
    │             ContextProvider → pushProvider → propagateContextChange
    │               → DFS로 consumer 탐색 → scheduleContextWorkOnParentPath
    │
    └── completeWork(current, WIP, renderLanes)
            │
            ├── HostComponent 마운트: createInstance → appendAllChildren → stateNode 설정
            ├── HostComponent 업데이트: diffProperties → updatePayload → markUpdate
            ├── HostText: 텍스트 변경 시 markUpdate
            └── bubbleProperties: subtreeFlags 집계 (Commit Phase 최적화의 핵심)
    │
    ▼
commitRoot()
    │ subtreeFlags & (MutationMask | LayoutMask | PassiveMask) 체크
    ├── commitBeforeMutationEffects (Snapshot, Passive 마킹)
    ├── commitMutationEffects (DOM 실제 변경)
    └── commitLayoutEffects (useLayoutEffect, ref 갱신)
```

---

## 마치며

React의 Render Phase는 "변경 사항을 최대한 작게 만들기"라는 철학의 구현체입니다.

**세 레벨의 최적화**가 동시에 작동합니다:

1. **Lane 레벨**: `childLanes`로 서브트리 전체를 O(1)에 skip
2. **컴포넌트 레벨**: `shallowEqual`, `didReceiveUpdate`, `shouldComponentUpdate`로 개별 bailout
3. **Commit 레벨**: `subtreeFlags`로 부작용 있는 서브트리만 정밀 탐색

이 세 레이어가 함께 작동할 때, 수천 개 노드의 Fiber 트리에서도 실제 DOM 작업은 변경된 소수의 노드에만 집중됩니다. 95~99%의 Fiber는 bailout 경로로 처리됩니다.

다음 편에서는 Render Phase가 계산한 결과를 실제 DOM에 반영하는 **Commit Phase**를 다룹니다. Mutation, Layout, Passive Effects의 세 단계가 왜 분리되어 있고, 각각 무엇을 보장하는지 살펴봅니다.

---

*소스 참조: `packages/react-reconciler/src/ReactFiberWorkLoop.js`, `ReactFiberBeginWork.js`, `ReactFiberCompleteWork.js`, `ReactChildFiber.js`, `ReactFiberNewContext.js`*
