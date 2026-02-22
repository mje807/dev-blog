# React 아키텍처 심층 분석 (3/14): Hooks 시스템 — "상태란 무엇인가"를 다시 묻다

> **React 아키텍처 심층 분석** 시리즈의 세 번째 글입니다. [2편](react-architecture-02-fiber-architecture.md)에서 우리는 Fiber가 어떻게 렌더링 작업을 중단·재개 가능한 단위로 쪼개는지 소스 코드로 추적했습니다. 이번 편에서는 그 Fiber 위에 구축된 **Hooks 시스템**의 내부를 해부합니다. Dispatcher 교체 메커니즘, Hook 연결 리스트, `dispatchSetState`의 Eager 최적화, Effect 원형 연결 리스트, 커밋 단계의 Effect 실행 순서, Rules of Hooks 강제 메커니즘, Concurrent Mode에서의 Tearing 방지까지 — 실제 React 18 소스 코드와 함께 추적합니다.

> **참조 소스**: `packages/react-reconciler/src/ReactFiberHooks.js` (React v18, 로컬 `react-dom.development.js` 직접 분석)

---

## 목차

1. [클래스 컴포넌트의 근본적 문제: Hooks가 탄생한 이유](#1-클래스-컴포넌트의-근본적-문제)
2. [모듈 레벨 변수: Hook 시스템의 전역 상태](#2-모듈-레벨-변수)
3. [Dispatcher 패턴: 렌더 시점에 따른 구현 교체](#3-dispatcher-패턴)
4. [renderWithHooks: Hook의 진입점](#4-renderwithHooks)
5. [Hook 연결 리스트: Fiber.memoizedState의 실제 구조](#5-hook-연결-리스트)
6. [mountWorkInProgressHook vs updateWorkInProgressHook](#6-mountworkinprogresshook-vs-updateworkinprogresshook)
7. [useState / useReducer: 상태 업데이트의 전체 흐름](#7-usestate--usereducer)
8. [dispatchSetState: Eager State 최적화와 Lane 할당](#8-dispatchsetstate)
9. [updateReducer: baseQueue와 Lane 필터링](#9-updatereducer)
10. [렌더 중 setState: RE_RENDER_LIMIT = 25](#10-렌더-중-setstate)
11. [useEffect 내부: Effect 원형 연결 리스트](#11-useeffect-내부)
12. [Effect 실행 타이밍: 3계층 구조](#12-effect-실행-타이밍)
13. [commitHookEffectListMount/Unmount: 커밋 단계의 Effect 처리](#13-commithookeffectlist)
14. [Passive Effects 비동기 스케줄링: MessageChannel](#14-passive-effects-비동기-스케줄링)
15. [Strict Mode의 Effect 이중 실행](#15-strict-mode의-effect-이중-실행)
16. [useMemo / useCallback: 메모이제이션의 실제 구현](#16-usememo--usecallback)
17. [useRef: 가장 단순하지만 가장 강력한 Hook](#17-useref)
18. [useContext: 컨텍스트 의존성 추적](#18-usecontext)
19. [Rules of Hooks: 정적 분석과 런타임 강제](#19-rules-of-hooks)
20. [Concurrent Mode와 Tearing: useSyncExternalStore](#20-concurrent-mode와-tearing)
21. [useId: 서버-클라이언트 일관성을 위한 결정론적 ID](#21-useid)
22. [Lane 시스템과 Hook 통합](#22-lane-시스템과-hook-통합)
23. [전체 흐름: 컴포넌트 렌더에서 화면까지](#23-전체-흐름)

---

## 1. 클래스 컴포넌트의 근본적 문제

Hooks가 2019년 React 16.8에 등장하기 전, 상태를 가진 컴포넌트는 클래스로만 작성할 수 있었습니다. 표면적으로는 편리해 보였지만, 클래스 컴포넌트는 세 가지 근본적인 문제를 가지고 있었습니다.

### 1-1. 논리의 분산: 생명주기 메서드

```javascript
class UserProfile extends React.Component {
  componentDidMount() {
    // 구독 설정
    this.subscription = userStore.subscribe(this.update);
    // 데이터 페칭
    fetchUser(this.props.userId).then(user => this.setState({ user }));
    // 문서 타이틀 설정
    document.title = 'Profile';
  }

  componentDidUpdate(prevProps) {
    // userId가 바뀌면 새로 페칭
    if (prevProps.userId !== this.props.userId) {
      fetchUser(this.props.userId).then(user => this.setState({ user }));
    }
  }

  componentWillUnmount() {
    // 구독 해제
    this.subscription.unsubscribe();
  }
}
```

"구독 설정"이라는 하나의 논리가 `componentDidMount`, `componentDidUpdate`, `componentWillUnmount` 세 곳에 분산됩니다. 수십 개의 기능이 하나의 컴포넌트에 모이면, 관련 없는 코드가 같은 메서드에 뒤섞이게 됩니다.

### 1-2. 재사용 불가: Wrapper Hell

상태 로직을 재사용하려면 Higher-Order Component(HOC)나 Render Props를 사용해야 했습니다.

```jsx
// HOC 패턴 - 컴포넌트를 래핑
const withUser = (Component) => (props) =>
  <UserContext.Consumer>
    {user => <Component {...props} user={user} />}
  </UserContext.Consumer>;

// 실제 사용 시 래핑이 중첩
withUser(withTheme(withRouter(withAnalytics(MyComponent))))
```

React DevTools에서 보면 "Wrapper Hell" — 의미 없는 컴포넌트 계층이 무한히 쌓입니다.

### 1-3. this 바인딩 문제

```javascript
class Counter extends React.Component {
  // 이렇게 하지 않으면 this가 undefined
  handleClick = () => {
    this.setState(prev => ({ count: prev.count + 1 }));
  };
}
```

`this`는 JavaScript의 언어적 개념이지 React의 개념이 아닙니다. 클래스가 도입한 우발적 복잡성입니다.

### 1-4. Hooks의 해결책: 관심사의 응집

```jsx
function useUser(userId) {
  const [user, setUser] = useState(null);

  useEffect(() => {
    const subscription = userStore.subscribe(() => {
      fetchUser(userId).then(setUser);
    });
    fetchUser(userId).then(setUser);
    document.title = 'Profile';

    return () => subscription.unsubscribe();  // 정리 로직도 함께
  }, [userId]);  // 의존성 명시

  return user;
}
```

관련 논리가 한 곳에 모이고, 재사용이 함수 호출로 가능해지며, `this`가 없어집니다. 그런데 이 마법 같은 동작은 어떻게 구현될까요?

---

## 2. 모듈 레벨 변수: Hook 시스템의 전역 상태

`ReactFiberHooks.js` 상단에는 모듈 스코프 변수들이 있습니다. 이것들이 Hook 시스템 전체의 "레지스터"입니다.

```javascript
// 현재 렌더링 중인 Fiber
let currentlyRenderingFiber: Fiber = (null: any);

// Current 트리의 Hook 포인터 (이전 렌더의 Hook 체인)
let currentHook: Hook | null = null;

// Work In Progress 트리의 Hook 포인터 (현재 렌더의 Hook 체인)
let workInProgressHook: Hook | null = null;

// 렌더 단계 업데이트 감지
let didScheduleRenderPhaseUpdate: boolean = false;
let didScheduleRenderPhaseUpdateDuringThisPass: boolean = false;

// 재렌더 횟수 제한
let numberOfReRenders: number = 0;
const RE_RENDER_LIMIT = 25;

// 현재 렌더 레인
let renderLanes: Lanes = NoLanes;
```

이 변수들은 함수 컴포넌트가 실행되는 동안만 유효한 상태를 담습니다. 렌더가 완료되면 모두 초기화됩니다.

**DEV 전용 변수들:**
```javascript
// DEV 모드에서 Hook 순서 추적
let currentHookNameInDev: ?HookType = null;
let hookTypesDev: HookType[] | null = null;         // 최초 마운트 시 Hook 이름 기록
let hookTypesUpdateIndexDev: number = -1;            // 업데이트 시 인덱스
```

이 DEV 변수들이 Rules of Hooks를 런타임에 강제하는 핵심입니다.

---

## 3. Dispatcher 패턴: 렌더 시점에 따른 구현 교체

`ReactCurrentDispatcher.current`는 현재 어떤 Hook 구현을 사용할지 결정합니다.

```javascript
// packages/react/src/ReactCurrentDispatcher.js
const ReactCurrentDispatcher = {
  current: (null: null | Dispatcher),
};
```

```javascript
// packages/react/src/ReactHooks.js
export function useState<S>(initialState: (() => S) | S) {
  const dispatcher = resolveDispatcher();
  return dispatcher.useState(initialState);
}

function resolveDispatcher() {
  const dispatcher = ReactCurrentDispatcher.current;
  if (dispatcher === null) {
    throw new Error('Invalid hook call. Hooks can only be called inside a function component.');
  }
  return dispatcher;
}
```

`useState`를 호출하면 `ReactCurrentDispatcher.current.useState`가 실행됩니다. React는 렌더 시점에 따라 이 포인터를 다른 객체로 교체합니다.

### Dispatcher 종류

| Dispatcher | 사용 시점 | useState 구현 |
|-----------|----------|--------------|
| `HooksDispatcherOnMount` | 첫 렌더링 | `mountState` |
| `HooksDispatcherOnUpdate` | 재렌더링 | `updateState → updateReducer` |
| `HooksDispatcherOnRerender` | 렌더 중 setState | `rerenderState → rerenderReducer` |
| `ContextOnlyDispatcher` | 렌더 외부 | `throwInvalidHookError` |

`ContextOnlyDispatcher`는 모든 Hook에 대해 에러를 던집니다:
```javascript
const ContextOnlyDispatcher: Dispatcher = {
  useState: throwInvalidHookError,
  useEffect: throwInvalidHookError,
  useMemo: throwInvalidHookError,
  // ... 모든 Hook이 에러
};

function throwInvalidHookError() {
  throw new Error(
    'Invalid hook call. Hooks can only be called inside of the body of a function component.'
  );
}
```

렌더가 끝나면 Dispatcher는 반드시 `ContextOnlyDispatcher`로 복귀합니다. 이것이 `useEffect` 콜백 내부에서 `useState`를 호출하면 에러가 나는 이유입니다.

---

## 4. renderWithHooks: Hook의 진입점

`beginWork`에서 함수 컴포넌트를 처리할 때 `renderWithHooks`가 호출됩니다.

```javascript
// ReactFiberHooks.js (React 18.3.1 기준)
export function renderWithHooks<Props, SecondArg>(
  current: Fiber | null,
  workInProgress: Fiber,
  Component: (p: Props, arg: SecondArg) => any,
  props: Props,
  secondArg: SecondArg,
  nextRenderLanes: Lanes,
): any {
  renderLanes = nextRenderLanes;
  currentlyRenderingFiber = workInProgress;

  // DEV: 이전 렌더의 Hook 타입 목록 복원
  if (__DEV__) {
    hookTypesDev = current !== null
      ? ((current._debugHookTypes: any): HookType[])
      : null;
    hookTypesUpdateIndexDev = -1;
    ignorePreviousDependencies =
      current !== null && current.type !== workInProgress.type;
  }

  // 1. Hook 체인 초기화 (매 렌더마다)
  workInProgress.memoizedState = null;
  workInProgress.updateQueue = null;
  workInProgress.lanes = NoLanes;

  // 2. Dispatcher 선택 (핵심!)
  if (__DEV__) {
    if (current !== null && current.memoizedState !== null) {
      ReactCurrentDispatcher.current = HooksDispatcherOnUpdateInDEV;
    } else if (hookTypesDev !== null) {
      ReactCurrentDispatcher.current = HooksDispatcherOnMountWithHookTypesInDEV;
    } else {
      ReactCurrentDispatcher.current = HooksDispatcherOnMountInDEV;
    }
  } else {
    ReactCurrentDispatcher.current =
      current === null || current.memoizedState === null
        ? HooksDispatcherOnMount
        : HooksDispatcherOnUpdate;
  }

  // 3. 컴포넌트 실행 (이 안에서 모든 Hook이 호출됨)
  let children = Component(props, secondArg);

  // 4. 렌더 중 setState 처리 (재렌더 루프)
  if (didScheduleRenderPhaseUpdateDuringThisPass) {
    let numberOfReRenders: number = 0;
    do {
      didScheduleRenderPhaseUpdateDuringThisPass = false;
      localIdCounter = 0;

      if (numberOfReRenders >= RE_RENDER_LIMIT) {
        throw new Error(
          'Too many re-renders. React limits the number of renders to prevent ' +
          'an infinite loop.'
        );
      }

      numberOfReRenders += 1;

      // Hook 포인터 리셋
      currentHook = null;
      workInProgressHook = null;

      workInProgress.updateQueue = null;

      ReactCurrentDispatcher.current = __DEV__
        ? HooksDispatcherOnRerenderInDEV
        : HooksDispatcherOnRerender;

      children = Component(props, secondArg);
    } while (didScheduleRenderPhaseUpdateDuringThisPass);
  }

  // 5. Dispatcher를 Invalid로 리셋 (렌더 외부 Hook 호출 방지)
  ReactCurrentDispatcher.current = ContextOnlyDispatcher;

  // 6. DEV: Hook 개수 감소 감지
  const didRenderTooFewHooks =
    currentHook !== null && currentHook.next !== null;

  // 7. 정리
  renderLanes = NoLanes;
  currentlyRenderingFiber = (null: any);
  currentHook = null;
  workInProgressHook = null;

  if (didRenderTooFewHooks) {
    throw new Error('Rendered fewer hooks than expected.');
  }

  return children;
}
```

이 함수의 핵심 설계 포인트:
- **Dispatcher는 렌더 전에 설정**: 컴포넌트 실행 전 `ReactCurrentDispatcher.current`를 교체하여 모든 Hook 호출이 올바른 구현을 사용하도록 합니다.
- **렌더 후 즉시 리셋**: 컴포넌트 실행이 끝나면 `ContextOnlyDispatcher`로 교체하여 비동기 컨텍스트에서의 Hook 호출을 차단합니다.
- **재렌더 루프**: `didScheduleRenderPhaseUpdateDuringThisPass`가 true면 최대 25번까지 재렌더합니다.

---

## 5. Hook 연결 리스트: Fiber.memoizedState의 실제 구조

각 Hook은 `Hook` 객체로 표현됩니다:

```typescript
interface Hook {
  memoizedState: any;       // 현재 저장된 값 (Hook마다 의미가 다름)
  baseState: any;           // 업데이트 계산의 기준 상태
  baseQueue: Update | null; // 이전 렌더에서 건너뛴 업데이트
  queue: any;               // 업데이트 큐 (useState/useReducer) 또는 null
  next: Hook | null;        // 다음 Hook (연결 리스트)
}
```

`memoizedState`는 Hook 종류에 따라 다른 값을 저장합니다:

| Hook | memoizedState 저장 값 |
|------|----------------------|
| `useState` / `useReducer` | 현재 상태 값 |
| `useEffect` / `useLayoutEffect` | `Effect` 객체 |
| `useMemo` | `[cachedValue, deps]` 배열 |
| `useCallback` | `[callback, deps]` 배열 |
| `useRef` | `{ current: value }` 객체 |
| `useContext` | 현재 컨텍스트 값 |
| `useId` | 생성된 ID 문자열 |

전체 Hook 체인의 메모리 레이아웃:

```
Fiber.memoizedState
        │
        ▼
┌──────────────────────────────────────────────────┐
│ Hook #1: useState(0)                              │
│  memoizedState: 42        ← 현재 카운터 값         │
│  baseState: 42            ← 업데이트 기준          │
│  baseQueue: null                                   │
│  queue: {                                          │
│    pending: null,         ← 대기 중 업데이트        │
│    lanes: 0,                                       │
│    dispatch: setState,    ← 바인딩된 setState       │
│    lastRenderedReducer: basicStateReducer,          │
│    lastRenderedState: 42                           │
│  }                                                 │
│  next: ──────────────────────────────────────────► │
└──────────────────────────────────────────────────┘
        ▼
┌──────────────────────────────────────────────────┐
│ Hook #2: useEffect(() => {...}, [dep])            │
│  memoizedState: {                                  │
│    tag: Passive | HasEffect,  ← 비트마스크 플래그  │
│    create: () => {...},       ← effect 함수        │
│    destroy: cleanup,          ← cleanup 함수       │
│    deps: [dep],               ← 의존성 배열        │
│    next: ──────────────►(원형 연결)                │
│  }                                                 │
│  next: ──────────────────────────────────────────► │
└──────────────────────────────────────────────────┘
        ▼
┌──────────────────────────────────────────────────┐
│ Hook #3: useMemo(() => compute(), [b])            │
│  memoizedState: [computedValue, [b]]              │
│  next: null                   ← 마지막 Hook        │
└──────────────────────────────────────────────────┘
```

---

## 6. mountWorkInProgressHook vs updateWorkInProgressHook

### 마운트: 새 Hook 생성

```javascript
// react-dom.development.js L15632
function mountWorkInProgressHook(): Hook {
  const hook: Hook = {
    memoizedState: null,
    baseState: null,
    baseQueue: null,
    queue: null,
    next: null,
  };

  if (workInProgressHook === null) {
    // 첫 번째 Hook: Fiber.memoizedState에 직접 연결
    currentlyRenderingFiber.memoizedState = workInProgressHook = hook;
  } else {
    // 이후 Hook: 체인 끝에 추가
    workInProgressHook = workInProgressHook.next = hook;
  }

  return workInProgressHook;
}
```

### 업데이트: 이전 Hook 복제

```javascript
// react-dom.development.js L15652
function updateWorkInProgressHook(): Hook {
  // 1. current 트리의 다음 Hook 결정
  let nextCurrentHook: null | Hook;
  if (currentHook === null) {
    // 첫 번째 Hook: current Fiber에서 시작
    const current = currentlyRenderingFiber.alternate;
    if (current !== null) {
      nextCurrentHook = current.memoizedState;  // current의 첫 Hook
    } else {
      nextCurrentHook = null;
    }
  } else {
    nextCurrentHook = currentHook.next;  // 다음 Hook
  }

  // 2. WIP 트리의 다음 Hook 결정 (재렌더 시 재사용 가능)
  let nextWorkInProgressHook: null | Hook;
  if (workInProgressHook === null) {
    nextWorkInProgressHook = currentlyRenderingFiber.memoizedState;
  } else {
    nextWorkInProgressHook = workInProgressHook.next;
  }

  if (nextWorkInProgressHook !== null) {
    // 재렌더 케이스: 이미 만들어진 WIP Hook 재사용
    workInProgressHook = nextWorkInProgressHook;
    nextWorkInProgressHook = workInProgressHook.next;
    currentHook = nextCurrentHook;
  } else {
    // 일반 업데이트: current Hook에서 복제
    if (nextCurrentHook === null) {
      // 이전 렌더보다 Hook이 더 많음!
      throw new Error('Rendered more hooks than during the previous render.');
    }

    currentHook = nextCurrentHook;

    const newHook: Hook = {
      memoizedState: currentHook.memoizedState,  // 상태 복사
      baseState: currentHook.baseState,
      baseQueue: currentHook.baseQueue,
      queue: currentHook.queue,    // 중요: 동일한 큐 참조!
      next: null,
    };

    // WIP 체인에 연결
    if (workInProgressHook === null) {
      currentlyRenderingFiber.memoizedState = workInProgressHook = newHook;
    } else {
      workInProgressHook = workInProgressHook.next = newHook;
    }
  }

  return workInProgressHook;
}
```

`queue`를 동일한 참조로 복사하는 것이 핵심입니다. 큐는 `setState`가 발생할 때마다 업데이트가 추가되는 살아있는 자료구조이며, current와 WIP가 이를 공유합니다.

---

## 7. useState / useReducer: 상태 업데이트의 전체 흐름

### mountState: 초기화

```javascript
// react-dom.development.js L16162
function mountState<S>(
  initialState: (() => S) | S,
): [S, Dispatch<BasicStateAction<S>>] {
  // 1. Hook 노드 생성
  const hook = mountWorkInProgressHook();

  // 2. Lazy 초기화 지원
  if (typeof initialState === 'function') {
    initialState = initialState();  // 함수면 즉시 실행
  }

  // 3. 초기 상태 저장
  hook.memoizedState = hook.baseState = initialState;

  // 4. 업데이트 큐 생성
  const queue: UpdateQueue<S, BasicStateAction<S>> = {
    pending: null,     // 대기 중인 업데이트 (원형 연결 리스트)
    interleaved: null, // 인터리브된 업데이트
    lanes: NoLanes,
    dispatch: null,
    lastRenderedReducer: basicStateReducer,
    lastRenderedState: (initialState: any),
  };
  hook.queue = queue;

  // 5. dispatch 함수 바인딩
  const dispatch: Dispatch<BasicStateAction<S>> = (queue.dispatch = (
    dispatchSetState.bind(null, currentlyRenderingFiber, queue)
  ));

  return [hook.memoizedState, dispatch];
}
```

`basicStateReducer`는 useState가 useReducer의 특수 케이스임을 보여줍니다:
```javascript
function basicStateReducer<S>(state: S, action: BasicStateAction<S>): S {
  // action이 함수면 함수형 업데이트 (prev => newValue)
  // 아니면 직접 새 값
  return typeof action === 'function' ? action(state) : action;
}
```

### useState vs useReducer의 실제 차이

```javascript
function updateState<S>(initialState: (() => S) | S): [S, Dispatch<...>] {
  return updateReducer(basicStateReducer, (initialState: any));
}

function updateReducer<S, I, A>(
  reducer: (S, A) => S,
  initialArg: I,
  init?: I => S,
): [S, Dispatch<A>] {
  // 두 함수 모두 updateReducer로 합류
  // 차이는 reducer 함수뿐
}
```

**실질적 차이**:
- `useState`: `reducer = basicStateReducer` (함수형 업데이트 + 직접 값 지원)
- `useReducer`: `reducer = 사용자 정의 함수` (복잡한 상태 전환 로직)

Eager State 최적화도 `useState`와 `useReducer` 모두에 적용되지만, `useReducer`의 경우 사용자 정의 reducer가 순수 함수가 아닐 수 있어 skip이 더 보수적으로 이루어집니다.

---

## 8. dispatchSetState: Eager State 최적화와 Lane 할당

`setState`를 호출하면 실제로는 `dispatchSetState`가 실행됩니다:

```javascript
function dispatchSetState<S, A>(
  fiber: Fiber,
  queue: UpdateQueue<S, A>,
  action: A,
): void {
  const lane = requestUpdateLane(fiber);  // 현재 컨텍스트의 우선순위 Lane

  const update: Update<S, A> = {
    lane,
    action,
    hasEagerState: false,
    eagerState: null,
    next: (null: any),
  };

  if (isRenderPhaseUpdate(fiber)) {
    // 렌더 중 setState: 동기적으로 처리
    enqueueRenderPhaseUpdate(queue, update);
  } else {
    const alternate = fiber.alternate;

    if (
      fiber.lanes === NoLanes &&
      (alternate === null || alternate.lanes === NoLanes)
    ) {
      // ★ Eager State 최적화 ★
      // 현재 Fiber에 대기 중인 업데이트가 없음 = 빠른 경로 가능
      const lastRenderedReducer = queue.lastRenderedReducer;
      if (lastRenderedReducer !== null) {
        let prevDispatcher;
        try {
          const currentState: S = (queue.lastRenderedState: any);
          // 새 상태를 미리 계산
          const eagerState = lastRenderedReducer(currentState, action);

          update.hasEagerState = true;
          update.eagerState = eagerState;

          if (is(eagerState, currentState)) {
            // 새 상태 === 현재 상태 → 렌더 완전 스킵!
            enqueueConcurrentHookUpdateAndEagerlyBailout(fiber, queue, update);
            return;  // scheduleUpdateOnFiber 호출 없음!
          }
        } catch (error) {
          // 에러는 무시 (실제 렌더에서 다시 처리됨)
        }
      }
    }

    // 일반 경로: 큐에 추가하고 스케줄링
    const root = enqueueConcurrentHookUpdate(fiber, queue, update, lane);
    if (root !== null) {
      const eventTime = requestEventTime();
      scheduleUpdateOnFiber(root, fiber, lane, eventTime);
      entangleTransitionUpdate(root, queue, lane);
    }
  }
}
```

### Eager State의 조건과 효과

Eager State가 적용되는 조건:
1. `fiber.lanes === NoLanes` — 현재 Fiber에 대기 중인 업데이트 없음
2. `alternate.lanes === NoLanes` — 반대편 트리에도 대기 없음
3. `is(eagerState, currentState)` — 새 상태 === 현재 상태 (`Object.is`)

이 조건이 모두 충족되면 **렌더링 자체가 건너뜁니다**. `scheduleUpdateOnFiber`가 호출되지 않으므로 Fiber Reconciler가 깨어나지 않습니다. 이것이 `setState(sameValue)`가 리렌더를 유발하지 않는 이유입니다.

```jsx
// 예시: Object.is로 false가 나오는 경우
const [obj, setObj] = useState({ count: 0 });

// Eager State 적용 안 됨 - 새 객체 참조
setObj({ count: 0 }); // 리렌더 발생!

// Eager State 적용됨 - 동일 참조
setObj(obj); // 리렌더 없음

// 함수형 업데이트: 동일 값을 반환해도 렌더 스킵
setObj(prev => prev); // 리렌더 없음 (is(prev, prev) === true)
```

### requestUpdateLane: 컨텍스트 기반 우선순위

```javascript
// react-dom.development.js L25430
function requestUpdateLane(fiber: Fiber): Lane {
  const mode = fiber.mode;

  // Legacy 모드: 항상 동기 (최고 우선순위)
  if ((mode & ConcurrentMode) === NoMode) {
    return (SyncLane: Lane);
  }

  // 렌더 중 setState: 현재 렌더의 Lane을 그대로 사용
  if (
    (executionContext & RenderContext) !== NoContext &&
    workInProgressRootRenderLanes !== NoLanes
  ) {
    return pickArbitraryLane(workInProgressRootRenderLanes);
  }

  // startTransition 내부: Transition Lane 할당
  const isTransition = requestCurrentTransition() !== NoTransition;
  if (isTransition) {
    if (currentEventTransitionLane === NoLane) {
      currentEventTransitionLane = claimNextTransitionLane();
    }
    return currentEventTransitionLane;
  }

  // 이벤트 핸들러 내부: 이벤트 우선순위 반영
  const updateLane: Lane = (getCurrentUpdatePriority(): any);
  if (updateLane !== NoLane) {
    return updateLane;
  }

  // React 외부 (setTimeout, fetch callback 등): DefaultLane
  const eventLane: Lane = (getCurrentEventPriority(): any);
  return eventLane;
}
```

같은 `setState`라도 호출 컨텍스트에 따라 다른 Lane이 할당됩니다:
- 버튼 클릭 이벤트 내부: `InputDiscreteLane` (높은 우선순위)
- `startTransition` 내부: `TransitionLane` (낮은 우선순위)
- `setTimeout` 내부: `DefaultLane` (중간 우선순위)

---

## 9. updateReducer: baseQueue와 Lane 필터링

렌더가 시작되면 `updateReducer`가 Hook의 업데이트 큐를 처리합니다:

```javascript
function updateReducer<S, I, A>(
  reducer: (S, A) => S,
  initialArg: I,
  init?: I => S,
): [S, Dispatch<A>] {
  const hook = updateWorkInProgressHook();
  const queue = hook.queue;

  queue.lastRenderedReducer = reducer;

  const current: Hook = (currentHook: any);

  // 1. baseQueue와 pending 큐 합치기
  let baseQueue = current.baseQueue;
  const pendingQueue = queue.pending;

  if (pendingQueue !== null) {
    if (baseQueue !== null) {
      // 두 원형 연결 리스트를 합침
      const baseFirst = baseQueue.next;
      const pendingFirst = pendingQueue.next;
      baseQueue.next = pendingFirst;  // baseQueue 끝 → pending 시작
      pendingQueue.next = baseFirst;  // pending 끝 → baseQueue 시작
    }
    current.baseQueue = baseQueue = pendingQueue;
    queue.pending = null;
  }

  if (baseQueue !== null) {
    const first = baseQueue.next;
    let newState = current.baseState;

    let newBaseState = null;
    let newBaseQueueFirst = null;
    let newBaseQueueLast = null;
    let update = first;

    // 2. 각 업데이트를 Lane 기준으로 처리
    do {
      const updateLane = update.lane;

      if (!isSubsetOfLanes(renderLanes, updateLane)) {
        // ★ 이번 렌더에서 처리하지 않을 업데이트 ★
        // (낮은 우선순위 업데이트를 높은 우선순위 렌더에서 건너뜀)
        const clone: Update<S, A> = {
          lane: updateLane,
          action: update.action,
          hasEagerState: update.hasEagerState,
          eagerState: update.eagerState,
          next: (null: any),
        };

        // baseQueue에 보존
        if (newBaseQueueLast === null) {
          newBaseQueueFirst = newBaseQueueLast = clone;
          newBaseState = newState;  // 기준 상태 저장
        } else {
          newBaseQueueLast = newBaseQueueLast.next = clone;
        }

        // 이 Fiber에 해당 Lane 유지 (다음 렌더에서 재처리)
        currentlyRenderingFiber.lanes = mergeLanes(
          currentlyRenderingFiber.lanes,
          updateLane,
        );
        markSkippedUpdateLanes(updateLane);
      } else {
        // 이번 렌더에서 처리할 업데이트
        if (newBaseQueueLast !== null) {
          // 앞에서 건너뛴 업데이트가 있었음
          // 이후 업데이트는 모두 baseQueue에 포함 (순서 보장)
          const clone: Update<S, A> = {
            lane: NoLane,  // Lane을 NoLane으로 → 항상 처리됨
            action: update.action,
            hasEagerState: update.hasEagerState,
            eagerState: update.eagerState,
            next: (null: any),
          };
          newBaseQueueLast = newBaseQueueLast.next = clone;
        }

        // 업데이트 적용
        if (update.hasEagerState) {
          // Eager State가 계산되어 있으면 바로 사용 (재계산 불필요)
          newState = ((update.eagerState: any): S);
        } else {
          const action = update.action;
          newState = reducer(newState, action);
        }
      }

      update = update.next;
    } while (update !== null && update !== first);

    // 3. 결과 저장
    if (newBaseQueueLast === null) {
      newBaseState = newState;  // 건너뛴 업데이트 없음
    } else {
      newBaseQueueLast.next = (newBaseQueueFirst: any);  // 원형으로 닫기
    }

    if (!is(newState, hook.memoizedState)) {
      markWorkInProgressReceivedUpdate();  // didReceiveUpdate = true
    }

    hook.memoizedState = newState;
    hook.baseState = newBaseState;
    hook.baseQueue = newBaseQueueLast;

    queue.lastRenderedState = newState;
  }

  const dispatch: Dispatch<A> = (queue.dispatch: any);
  return [hook.memoizedState, dispatch];
}
```

### Lane 필터링의 의미

높은 우선순위 렌더(`SyncLane`)에서 낮은 우선순위 업데이트(`TransitionLane`)를 만나면 건너뜁니다. 이 건너뛴 업데이트들은 `baseQueue`에 보존되어 다음 낮은 우선순위 렌더에서 처리됩니다.

```
High-Priority Render (SyncLane):
  update1 (SyncLane)   → 처리: state = 1
  update2 (TransitionLane) → 건너뜀, baseQueue에 보존
  update3 (SyncLane)   → 처리: state = 3
  결과: memoizedState = 3, baseState = 1, baseQueue = [update2, update3]

Low-Priority Render (TransitionLane):
  update2 (TransitionLane) → 처리: state = 2 (baseState=1에서)
  update3 (NoLane)     → 처리: state = 3 (항상 처리)
  결과: memoizedState = 3, baseState = 3, baseQueue = null
```

---

## 10. 렌더 중 setState: RE_RENDER_LIMIT = 25

렌더 함수 실행 중에 `setState`를 호출하면:

```javascript
function enqueueRenderPhaseUpdate<S, A>(
  queue: UpdateQueue<S, A>,
  update: Update<S, A>,
): void {
  didScheduleRenderPhaseUpdateDuringThisPass = true;  // 재렌더 트리거
  didScheduleRenderPhaseUpdate = true;

  const alternate = currentlyRenderingFiber.alternate;
  if (
    queue.pending === null ||
    (alternate !== null && queue === alternate.memoizedState?.queue)
  ) {
    // 렌더 단계 업데이트로 마킹
    renderPhaseUpdates = renderPhaseUpdates || new Map();
    const firstRenderPhaseUpdate = renderPhaseUpdates.get(queue);
    if (firstRenderPhaseUpdate === undefined) {
      renderPhaseUpdates.set(queue, update);
    } else {
      // 원형 연결 리스트에 추가
      let lastRenderPhaseUpdate = firstRenderPhaseUpdate;
      while (lastRenderPhaseUpdate.next !== firstRenderPhaseUpdate) {
        lastRenderPhaseUpdate = lastRenderPhaseUpdate.next;
      }
      lastRenderPhaseUpdate.next = update;
      update.next = firstRenderPhaseUpdate;
    }
  }
}
```

`didScheduleRenderPhaseUpdateDuringThisPass`가 true가 되면, `renderWithHooks`의 루프가 재실행됩니다. 단, **최대 25번** 이후에는:

```javascript
if (numberOfReRenders >= RE_RENDER_LIMIT) {
  throw new Error(
    'Too many re-renders. React limits the number of renders to prevent an infinite loop.'
  );
}
```

이 패턴은 파생 상태를 계산하는 컴포넌트에서 유용합니다:
```jsx
function DerivedState({ userId }) {
  const [prevUserId, setPrevUserId] = useState(null);
  const [user, setUser] = useState(null);

  // 렌더 중 setState (getDerivedStateFromProps 패턴)
  if (userId !== prevUserId) {
    setPrevUserId(userId);
    setUser(null); // userId 변경 시 user 리셋
  }
  // 이 경우 재렌더가 일어나지만 무한루프가 아님
}
```

---

## 11. useEffect 내부: Effect 원형 연결 리스트

### Effect 객체 구조

```typescript
interface Effect {
  tag: HookFlags;                           // 비트마스크 플래그
  create: () => (() => void) | void;        // effect 함수
  destroy: (() => void) | void;             // cleanup 함수 (create 반환값)
  deps: Array<mixed> | null;                // 의존성 배열
  next: Effect;                             // 다음 Effect (원형!)
}
```

HookFlags 비트마스크 (실제 값):
```javascript
// react-dom.development.js L6412-6428
const NoFlags  = 0b0000;  // 0 - 플래그 없음
const HasEffect = 0b0001; // 1 - 이번 커밋에서 실행 필요
const Insertion = 0b0010; // 2 - useInsertionEffect
const Layout    = 0b0100; // 4 - useLayoutEffect
const Passive   = 0b1000; // 8 - useEffect
```

`useEffect`는 `Passive | HasEffect = 0b1001 = 9`로 커밋 단계에서 필터링됩니다.

### pushEffect: Effect를 원형 연결 리스트에 추가

```javascript
// react-dom.development.js L7365
function pushEffect(
  tag: HookFlags,
  create: () => (() => void) | void,
  destroy: (() => void) | void,
  deps: Array<mixed> | null,
): Effect {
  const effect: Effect = {
    tag,
    create,
    destroy,
    deps,
    next: (null: any),
  };

  let componentUpdateQueue = currentlyRenderingFiber.updateQueue;

  if (componentUpdateQueue === null) {
    // 첫 번째 Effect: 큐 생성
    componentUpdateQueue = createFunctionComponentUpdateQueue();
    // { lastEffect: null, stores: null }
    currentlyRenderingFiber.updateQueue = componentUpdateQueue;
    componentUpdateQueue.lastEffect = effect.next = effect;  // 자기 자신 가리킴
  } else {
    const lastEffect = componentUpdateQueue.lastEffect;
    if (lastEffect === null) {
      componentUpdateQueue.lastEffect = effect.next = effect;
    } else {
      const firstEffect = lastEffect.next;  // 현재 첫 번째 저장
      lastEffect.next = effect;              // 이전 마지막 → 새 effect
      effect.next = firstEffect;             // 새 effect → 첫 번째
      componentUpdateQueue.lastEffect = effect;  // lastEffect 갱신
    }
  }

  return effect;
}
```

3개의 Effect(A, B, C)가 추가된 후:
```
updateQueue.lastEffect = C
    ↓
C → A → B → C (원형)
    ↑_____________|
```

순회: `first = lastEffect.next` (= A)로 시작, `effect !== first`가 false가 될 때까지 반복.

### mountEffect vs updateEffect: deps 비교

```javascript
// mount: 항상 HasEffect 포함
function mountEffectImpl(fiberFlags, hookFlags, create, deps) {
  const hook = mountWorkInProgressHook();
  const nextDeps = deps === undefined ? null : deps;
  currentlyRenderingFiber.flags |= fiberFlags;  // Fiber에 플래그 추가
  hook.memoizedState = pushEffect(
    HookHasEffect | hookFlags,  // HasEffect 항상 포함
    create,
    undefined,  // destroy는 나중에 설정
    nextDeps,
  );
}

// update: deps 비교 후 분기
function updateEffectImpl(fiberFlags, hookFlags, create, deps) {
  const hook = updateWorkInProgressHook();
  const nextDeps = deps === undefined ? null : deps;
  const prevEffect = currentHook.memoizedState;
  const destroy = prevEffect.destroy;  // 이전 cleanup 보존!

  if (nextDeps !== null) {
    const prevDeps = prevEffect.deps;
    if (areHookInputsEqual(nextDeps, prevDeps)) {
      // deps 동일: HasEffect 없이 등록 (실행되지 않음)
      hook.memoizedState = pushEffect(hookFlags, create, destroy, nextDeps);
      return;  // fiber.flags도 변경 안 함
    }
  }

  // deps 변경: HasEffect 포함
  currentlyRenderingFiber.flags |= fiberFlags;
  hook.memoizedState = pushEffect(
    HookHasEffect | hookFlags,
    create,
    destroy,     // 이전 cleanup 함수를 새 Effect에 전달
    nextDeps,
  );
}
```

중요한 통찰: **deps가 동일해도 Effect는 항상 원형 리스트에 등록됩니다**. `HasEffect` 비트가 없을 뿐입니다. 커밋 단계에서 이 비트를 체크하여 실행 여부를 결정합니다.

### deps 비교 알고리즘: Object.is

```javascript
// react-dom.development.js L15411
function areHookInputsEqual(
  nextDeps: Array<mixed>,
  prevDeps: Array<mixed> | null,
): boolean {
  if (prevDeps === null) {
    return false;  // 이전에 deps가 없었음 → 항상 실행
  }

  for (let i = 0; i < prevDeps.length && i < nextDeps.length; i++) {
    if (Object.is(nextDeps[i], prevDeps[i])) {
      continue;
    }
    return false;
  }
  return true;
}
```

`Object.is`의 특수 케이스:
```javascript
Object.is(NaN, NaN)   // true  (=== 과 다름)
Object.is(0, -0)      // false (=== 과 다름)
Object.is({}, {})     // false (참조 비교)
Object.is([], [])     // false (참조 비교)
```

이것이 `useEffect`의 deps에 객체/배열을 직접 넣으면 항상 재실행되는 이유입니다.

---

## 12. Effect 실행 타이밍: 3계층 구조

React는 세 종류의 Effect를 서로 다른 타이밍에 실행합니다:

```
커밋 단계 시작
│
├── [Before Mutation Phase]
│   └── getSnapshotBeforeUpdate (클래스 컴포넌트)
│
├── [Mutation Phase] DOM 변경
│   ├── useInsertionEffect cleanup ← DOM mutation 전에 cleanup
│   ├── useInsertionEffect create  ← DOM mutation 전에 실행 (CSS-in-JS 스타일 주입)
│   └── useLayoutEffect cleanup   ← DOM mutation 후에 cleanup만
│
├── FiberRoot.current = finishedWork (트리 전환)
│
├── [Layout Phase]
│   ├── useLayoutEffect create    ← DOM 변경 후, 페인트 전 동기 실행
│   ├── ref attach
│   └── componentDidMount/Update
│
├── requestPaint() ← 브라우저 페인트 기회
│
└── [Passive Phase] (비동기 - MessageChannel)
    ├── useEffect cleanup (전체 트리)
    └── useEffect create (전체 트리)
```

### useInsertionEffect: CSS-in-JS를 위한 타이밍

`useInsertionEffect`는 DOM이 변경되기 전, ref가 attach되기 전에 실행됩니다:

```jsx
// styled-components, emotion 같은 라이브러리 내부
function useCSS(rule) {
  useInsertionEffect(() => {
    // DOM mutation 전에 <style> 태그 삽입
    const styleTag = document.createElement('style');
    styleTag.textContent = rule;
    document.head.appendChild(styleTag);
    return () => styleTag.remove();
  }, [rule]);
}
```

이렇게 하면 `useLayoutEffect`에서 `getComputedStyle()`이나 `getBoundingClientRect()`를 호출할 때 최신 스타일이 반영된 값을 얻을 수 있습니다.

---

## 13. commitHookEffectListMount/Unmount: 커밋 단계의 Effect 처리

커밋 단계에서 Effect 원형 리스트를 순회합니다:

### Unmount: cleanup 실행

```javascript
// react-dom.development.js L14738
function commitHookEffectListUnmount(
  flags: HookFlags,
  finishedWork: Fiber,
  nearestMountedAncestor: Fiber | null,
) {
  const updateQueue: FunctionComponentUpdateQueue | null =
    (finishedWork.updateQueue: any);
  const lastEffect = updateQueue !== null ? updateQueue.lastEffect : null;

  if (lastEffect !== null) {
    const firstEffect = lastEffect.next;
    let effect = firstEffect;

    do {
      if ((effect.tag & flags) === flags) {  // 비트마스크 일치 확인
        const destroy = effect.destroy;
        effect.destroy = undefined;  // ★ 즉시 초기화 (중복 호출 방지)

        if (destroy !== undefined) {
          safelyCallDestroy(finishedWork, nearestMountedAncestor, destroy);
        }
      }
      effect = effect.next;
    } while (effect !== firstEffect);
  }
}
```

### Mount: effect 실행 및 destroy 저장

```javascript
// react-dom.development.js L14790
function commitHookEffectListMount(flags: HookFlags, finishedWork: Fiber) {
  const updateQueue: FunctionComponentUpdateQueue | null =
    (finishedWork.updateQueue: any);
  const lastEffect = updateQueue !== null ? updateQueue.lastEffect : null;

  if (lastEffect !== null) {
    const firstEffect = lastEffect.next;
    let effect = firstEffect;

    do {
      if ((effect.tag & flags) === flags) {
        const create = effect.create;
        effect.destroy = create();  // ★ 반환값이 cleanup 함수
      }
      effect = effect.next;
    } while (effect !== firstEffect);
  }
}
```

### cleanup 실행 순서: 전체 트리 unmount → 전체 트리 mount

`flushPassiveEffectsImpl`에서:
```javascript
// react-dom.development.js L19220
function flushPassiveEffectsImpl() {
  // 전체 트리의 모든 cleanup 먼저
  commitPassiveUnmountEffects(root.current);

  // 그 다음 전체 트리의 모든 create
  commitPassiveMountEffects(root, root.current, lanes, transitions);

  return true;
}
```

이 순서가 중요한 이유: A의 cleanup → B의 cleanup → A의 create → B의 create 순서로 실행됩니다. A의 create가 B의 cleanup이 완료된 상태를 전제로 할 수 있습니다.

### destroy의 생명주기

```
마운트:    effect.destroy = undefined
           create() 실행 → effect.destroy = cleanup 함수

다음 렌더: updateEffectImpl에서 prevEffect.destroy를 새 Effect에 복사
           새 effect.destroy = 이전 cleanup 함수

커밋:      commitHookEffectListUnmount:
             destroy = effect.destroy
             effect.destroy = undefined   ← 즉시 null화
             safelyCallDestroy(destroy)   ← cleanup 실행
           commitHookEffectListMount:
             effect.destroy = create()    ← 새 cleanup 저장
```

---

## 14. Passive Effects 비동기 스케줄링: MessageChannel

React 16에서는 `requestAnimationFrame`을 사용했지만, React 18에서는 **MessageChannel**로 전환했습니다:

```javascript
// react-dom.development.js L18941 (commitRootImpl 내)
function commitRootImpl(root, ...) {
  // 동기 작업들...
  commitMutationEffects(root, finishedWork, lanes);
  root.current = finishedWork;  // 트리 교체
  commitLayoutEffects(finishedWork, root, lanes);

  // Passive Effects는 비동기로 스케줄
  if (rootDoesHavePassiveEffects) {
    rootDoesHavePassiveEffects = false;
    rootWithPendingPassiveEffects = root;
    pendingPassiveEffectsLanes = lanes;
    scheduleCallback(NormalSchedulerPriority, () => {
      flushPassiveEffects();  // MessageChannel 통해 비동기 실행
      return null;
    });
  }

  // 페인트 기회
  requestPaint();
}
```

MessageChannel 기반 비동기:
```
commitRoot() [동기]
  └── scheduleCallback(NormalPriority, flushPassiveEffects)
        └── MessageChannel.postMessage()
              [이벤트 루프 - 현재 태스크 완료 후]
              └── message event 처리
                    └── flushPassiveEffects()
                          ├── commitPassiveUnmountEffects()
                          └── commitPassiveMountEffects()
```

### flushSync가 Passive Effects를 먼저 처리하는 이유

```javascript
// react-dom.development.js L18336
function flushSync(fn) {
  // 이전 렌더의 passive effects가 남아있으면 먼저 처리
  if (
    rootWithPendingPassiveEffects !== null &&
    rootWithPendingPassiveEffects.tag === LegacyRoot &&
    (executionContext & (RenderContext | CommitContext)) === NoContext
  ) {
    flushPassiveEffects();
  }
  // ...
}
```

이전 `useEffect`에서 `setState`를 호출했고 그 결과가 `flushSync`로 실행되는 코드에 필요한 경우, passive effects를 먼저 처리하지 않으면 stale 상태를 읽게 됩니다.

---

## 15. Strict Mode의 Effect 이중 실행

개발 모드의 Strict Mode에서 컴포넌트를 두 번 렌더하는 것은 잘 알려진 사실이지만, **Effect도 두 번 실행**됩니다:

```javascript
// react-dom.development.js L19497
function commitDoubleInvokeEffectsInDEV(
  fiber: Fiber,
  hasPassiveEffects: boolean,
) {
  // Layout effects: unmount → mount
  invokeEffectsInDev(fiber, MountLayoutDev, invokeLayoutEffectUnmountInDEV);
  invokeEffectsInDev(fiber, MountLayoutDev, invokeLayoutEffectMountInDEV);

  // Passive effects: unmount → mount
  if (hasPassiveEffects) {
    invokeEffectsInDev(fiber, MountPassiveDev, invokePassiveEffectUnmountInDEV);
    invokeEffectsInDev(fiber, MountPassiveDev, invokePassiveEffectMountInDEV);
  }
}
```

실행 순서:
```
마운트 (Strict Mode)
  1. useEffect create  ← 첫 번째 실행
  2. useEffect cleanup ← Strict Mode 이중 실행 (unmount)
  3. useEffect create  ← Strict Mode 이중 실행 (remount)
```

이것이 왜 중요한가: cleanup이 제대로 구현되지 않은 effect를 즉시 감지할 수 있습니다.

```jsx
// 버그: EventSource를 정리하지 않음
useEffect(() => {
  const es = new EventSource('/stream');
  es.onmessage = handleMessage;
  // cleanup 없음!
}, []);
// Strict Mode에서 두 번 실행 → 두 개의 EventSource 생성 → 버그 조기 발견!

// 올바른 구현
useEffect(() => {
  const es = new EventSource('/stream');
  es.onmessage = handleMessage;
  return () => es.close();  // cleanup 필수
}, []);
```

---

## 16. useMemo / useCallback: 메모이제이션의 실제 구현

### useMemo

```javascript
// mount
function mountMemo<T>(nextCreate: () => T, deps: Array<mixed> | void | null): T {
  const hook = mountWorkInProgressHook();
  const nextDeps = deps === undefined ? null : deps;
  const nextValue = nextCreate();  // 팩토리 함수 즉시 실행
  hook.memoizedState = [nextValue, nextDeps];  // [값, deps] 쌍으로 저장
  return nextValue;
}

// update
function updateMemo<T>(nextCreate: () => T, deps: Array<mixed> | void | null): T {
  const hook = updateWorkInProgressHook();
  const nextDeps = deps === undefined ? null : deps;
  const prevState = hook.memoizedState;

  if (prevState !== null) {
    if (nextDeps !== null) {
      const prevDeps: Array<mixed> | null = prevState[1];
      if (areHookInputsEqual(nextDeps, prevDeps)) {
        return prevState[0];  // ★ 캐시된 값 반환
      }
    }
  }

  const nextValue = nextCreate();  // 새로 계산
  hook.memoizedState = [nextValue, nextDeps];
  return nextValue;
}
```

### useCallback

```javascript
// mount
function mountCallback<T>(callback: T, deps: Array<mixed> | void | null): T {
  const hook = mountWorkInProgressHook();
  const nextDeps = deps === undefined ? null : deps;
  hook.memoizedState = [callback, nextDeps];  // 함수 자체를 저장
  return callback;
}
```

`useMemo`와 `useCallback`의 유일한 차이:
- `useMemo`: 팩토리 함수를 실행한 결과를 저장
- `useCallback`: 함수 자체를 저장

```javascript
useCallback(fn, deps)
// 완전히 동일
useMemo(() => fn, deps)
```

### 메모이제이션의 한계: 참조 동일성

```jsx
function Parent() {
  const [count, setCount] = useState(0);

  // 문제: 매 렌더마다 새 객체
  const config = { threshold: 0.5, root: null };

  // Object.is({...}, {...}) === false → 매번 재실행
  const result = useMemo(
    () => expensiveCalc(config),
    [config]  // 항상 새 객체 참조 → 항상 재실행됨
  );

  // 해결책: 원시값을 deps로 사용
  const result2 = useMemo(
    () => expensiveCalc({ threshold: 0.5, root: null }),
    []  // 변하지 않는 값
  );
}
```

---

## 17. useRef: 가장 단순하지만 가장 강력한 Hook

```javascript
// mount
function mountRef<T>(initialValue: T): {current: T} {
  const hook = mountWorkInProgressHook();
  const ref = {current: initialValue};
  hook.memoizedState = ref;  // 객체를 저장
  return ref;                // 동일한 객체 반환
}

// update - initialValue를 완전히 무시!
function updateRef<T>(initialValue: T): {current: T} {
  const hook = updateWorkInProgressHook();
  return hook.memoizedState;  // 최초 생성 객체 그대로
}
```

`updateRef`는 `initialValue`를 무시합니다. 이것이 `useRef`의 핵심 — 렌더 간 동일한 객체 참조를 제공합니다.

### Callback ref vs Object ref

```javascript
// react-dom.development.js L23662
function commitAttachRef(finishedWork: Fiber) {
  const ref = finishedWork.ref;
  if (ref !== null) {
    const instance = finishedWork.stateNode;
    const instanceToUse = getPublicInstance(instance);

    if (typeof ref === 'function') {
      // Callback ref: 함수 직접 호출
      ref(instanceToUse);
    } else {
      // Object ref: .current에 할당
      ref.current = instanceToUse;
    }
  }
}
```

언마운트 시:
```javascript
function safelyDetachRef(current: Fiber, nearestMountedAncestor: Fiber | null) {
  const ref = current.ref;
  if (ref !== null) {
    if (typeof ref === 'function') {
      ref(null);         // callback ref에 null 전달
    } else {
      ref.current = null; // object ref 초기화
    }
  }
}
```

### useImperativeHandle: useLayoutEffect로 구현

```javascript
function mountImperativeHandle<T>(
  ref: {current: T | null} | ((inst: T) => mixed) | null | void,
  create: () => T,
  deps: Array<mixed> | void | null,
): void {
  // deps에 ref를 추가
  const effectDeps =
    deps !== null && deps !== undefined ? deps.concat([ref]) : null;

  // ★ Layout 타이밍 = useLayoutEffect와 동일
  return mountEffectImpl(
    UpdateEffect,
    HookLayout,                                        // Layout 플래그
    imperativeHandleEffect.bind(null, create, ref),
    effectDeps,
  );
}

function imperativeHandleEffect<T>(create: () => T, ref: ...) {
  if (typeof ref === 'function') {
    const inst = create();
    ref(inst);
    return () => { ref(null); };
  } else if (ref !== null && ref !== undefined) {
    const inst = create();
    ref.current = inst;
    return () => { ref.current = null; };
  }
}
```

커밋 타이밍에서의 순서:
```
Layout Phase
  1. useLayoutEffect cleanup
  2. useImperativeHandle cleanup
  3. useLayoutEffect create
  4. useImperativeHandle create ← 부모가 자식 ref를 읽기 전에 설정 완료
  5. ref attach (commitAttachRef)
```

---

## 18. useContext: 컨텍스트 의존성 추적

```javascript
function readContext<T>(context: ReactContext<T>): T {
  const value = isPrimaryRenderer
    ? context._currentValue
    : context._currentValue2;

  // 이미 이 컨텍스트를 읽었는지 확인
  if (lastFullyObservedContext === context) {
    // 캐시된 값 사용
  } else {
    const contextItem = {
      context: ((context: any): ReactContext<mixed>),
      memoizedValue: value,
      next: null,
    };

    if (lastContextDependency === null) {
      // 첫 번째 컨텍스트 의존성
      lastContextDependency = contextItem;
      currentlyRenderingFiber.dependencies = {
        lanes: NoLanes,
        firstContext: contextItem,
      };
    } else {
      // 연결 리스트에 추가
      lastContextDependency = lastContextDependency.next = contextItem;
    }
  }

  return value;
}
```

컨텍스트 변경 시 `propagateContextChange`가 의존성 체인을 순회하여 관련 Fiber에 `lanes`를 설정합니다. 이 Fiber들은 다음 렌더 사이클에서 자동으로 재렌더됩니다.

---

## 19. Rules of Hooks: 정적 분석과 런타임 강제

### 런타임 강제: DEV 모드의 Hook 순서 추적

```javascript
// 마운트 시 Hook 이름 기록
function mountHookTypesDev() {
  const hookName = currentHookNameInDev;
  if (hookTypesDev === null) {
    hookTypesDev = [hookName];    // ['useState']
  } else {
    hookTypesDev.push(hookName);  // ['useState', 'useEffect', 'useMemo']
  }
}

// 업데이트 시 이름 비교
function updateHookTypesDev() {
  const hookName = currentHookNameInDev;
  if (hookTypesDev !== null) {
    hookTypesUpdateIndexDev++;
    // hookTypesDev[i] vs 현재 hookName 비교
    if (hookTypesDev[hookTypesUpdateIndexDev] !== hookName) {
      warnOnHookMismatchInDev(hookName);
    }
  }
}
```

불일치 감지 시 출력되는 경고:
```
React has detected a change in the order of Hooks called by MyComponent.

   Previous render            Next render
   ------------------------------------------------------
1. useState                    useState
2. useEffect                   useCallback  <-- 불일치!
   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

This will lead to bugs and errors if not fixed.
```

### 에러 발생 조건

```javascript
// "Rendered more hooks": 이전보다 Hook이 많음
if (nextCurrentHook === null) {
  throw new Error('Rendered more hooks than during the previous render.');
}

// "Rendered fewer hooks": 이전보다 Hook이 적음
const didRenderTooFewHooks =
  currentHook !== null && currentHook.next !== null;
if (didRenderTooFewHooks) {
  throw new Error('Rendered fewer hooks than expected.');
}
```

### 왜 순서가 불변이어야 하는가

```
마운트 시 Hook 체인:
Hook_1(useState=0) → Hook_2(useEffect=fn) → Hook_3(useState="hi")

업데이트 시 (조건부 useEffect 건너뜀):
읽기: Hook_1(useState=0)  ✓
건너뜀: useEffect
읽기: Hook_2(useEffect 데이터) ← 실제로는 이전 useEffect의 memoizedState!
결과: 세 번째 useState가 잘못된 값을 읽음 → 버그!
```

### 정적 분석: eslint-plugin-react-hooks

런타임 에러 외에도, ESLint 플러그인이 컴파일 타임에 감지합니다:

```javascript
// 정적 분석으로 감지되는 패턴들
function Component({ condition }) {
  // ❌ 조건부 Hook
  if (condition) {
    const [x] = useState(0); // ESLint 에러
  }

  // ❌ 반복문 내 Hook
  for (let i = 0; i < 3; i++) {
    useEffect(() => {}, []); // ESLint 에러
  }

  // ❌ 중첩 함수 내 Hook
  function helper() {
    const [y] = useState(0); // ESLint 에러
  }

  // ✓ 최상위 레벨
  const [z] = useState(0);
}
```

---

## 20. Concurrent Mode와 Tearing: useSyncExternalStore

Concurrent Mode에서는 렌더가 중단될 수 있습니다. 외부 스토어(Redux, Zustand 등)가 렌더 도중 변경되면 **Tearing** 현상이 발생합니다:

```
Concurrent 렌더 시작
  컴포넌트 A 렌더 → 스토어 값 읽기: count = 10
  [더 높은 우선순위 작업 → 렌더 중단]
  외부: store.count = 20
  렌더 재개
  컴포넌트 B 렌더 → 스토어 값 읽기: count = 20

최종 화면: A는 10, B는 20 → Tearing!
```

`useSyncExternalStore`는 이를 해결합니다:

```javascript
// react-dom.development.js L15957
function mountSyncExternalStore<T>(
  subscribe: (() => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
): T {
  const fiber = currentlyRenderingFiber;
  const hook = mountWorkInProgressHook();

  // 1. 현재 스냅샷 읽기
  const nextSnapshot = getSnapshot();

  hook.memoizedState = nextSnapshot;
  const inst = {value: nextSnapshot, getSnapshot};
  hook.queue = inst;

  // 2. 변경 구독
  mountEffect(
    subscribeToStore.bind(null, fiber, inst, subscribe),
    [subscribe],
  );

  // 3. ★ 커밋 직전 일관성 검사 (Tearing 방지 핵심)
  if (!includesBlockingLane(root, renderLanes)) {
    pushStoreConsistencyCheck(fiber, getSnapshot, nextSnapshot);
  }

  return nextSnapshot;
}
```

커밋 직전 일관성 검사:
```javascript
function checkIfSnapshotChanged(inst: StoreInstance<any>): boolean {
  const latestGetSnapshot = inst.getSnapshot;
  const prevValue = inst.value;
  try {
    const nextValue = latestGetSnapshot();
    return !is(prevValue, nextValue);  // 렌더 중 변경 감지!
  } catch (error) {
    return true;
  }
}
```

렌더 중 스토어가 변경되었으면 동기적으로 재렌더합니다. 이것이 Tearing 없이 외부 스토어를 읽는 안전한 방법입니다.

---

## 21. useId: 서버-클라이언트 일관성을 위한 결정론적 ID

```javascript
// react-dom.development.js L16569
function mountId(): string {
  const hook = mountWorkInProgressHook();
  const root = getWorkInProgressRoot();
  const identifierPrefix = root.identifierPrefix;

  let id;
  if (getIsHydrating()) {
    // ★ 서버 사이드: Fiber 트리 위치 기반 결정론적 ID
    const treeId = getTreeId();  // Fiber 경로를 비트 연산으로 인코딩
    id = ':' + identifierPrefix + 'R' + treeId;

    // 같은 컴포넌트 내 여러 useId
    const localId = localIdCounter++;
    if (localId > 0) {
      id += 'H' + localId.toString(32);  // 32진수로 인코딩
    }
    id += ':';
    // 예: ":R1:" ":R1H1:" ":R1H2:"
  } else {
    // 클라이언트 사이드 전용: 전역 카운터
    const globalClientId = globalClientIdCounter++;
    id = ':' + identifierPrefix + 'r' + globalClientId.toString(32) + ':';
    // 예: ":r0:" ":r1:" ":r2:"
  }

  hook.memoizedState = id;
  return id;
}

// 업데이트: ID는 변경되지 않음
function updateId(): string {
  const hook = updateWorkInProgressHook();
  return hook.memoizedState;  // 한 번 생성 후 고정
}
```

서버와 클라이언트가 동일한 Fiber 트리 구조를 가지면 `getTreeId()`가 동일한 값을 반환합니다. 이것이 Hydration 시 ID 불일치 없이 동작하는 원리입니다.

---

## 22. Lane 시스템과 Hook 통합

Lane은 업데이트의 "우선순위 채널"입니다. Hook은 `dispatchSetState`를 통해 Lane 시스템과 통합됩니다:

```javascript
// 실제 Lane 비트마스크 값
const SyncLane            = 0b0000000000000000000000000000001;
const InputContinuousLane = 0b0000000000000000000000000000100;
const DefaultLane         = 0b0000000000000000000000000010000;
const TransitionLane1     = 0b0000000000000000000000001000000;
// ... TransitionLane16 까지
const IdleLane            = 0b0100000000000000000000000000000;
```

```jsx
function SearchComponent() {
  const [immediate, setImmediate] = useState('');    // 입력: InputContinuousLane
  const [deferred, setDeferred] = useState('');      // 전환: TransitionLane

  const handleChange = (e) => {
    // 긴급 업데이트: InputContinuousLane
    setImmediate(e.target.value);

    // 전환 업데이트: TransitionLane (낮은 우선순위)
    startTransition(() => {
      setDeferred(e.target.value);
    });
  };
  // immediate는 즉시 반영, deferred는 CPU 여유가 있을 때 처리
}
```

`markUpdateLaneFromFiberToRoot`는 Lane을 Fiber에서 루트까지 버블링합니다:
```javascript
function markUpdateLaneFromFiberToRoot(sourceFiber: Fiber, lane: Lane) {
  sourceFiber.lanes = mergeLanes(sourceFiber.lanes, lane);
  let alternate = sourceFiber.alternate;
  if (alternate !== null) {
    alternate.lanes = mergeLanes(alternate.lanes, lane);
  }

  // 루트까지 childLanes 업데이트
  let node = sourceFiber;
  let parent = sourceFiber.return;
  while (parent !== null) {
    parent.childLanes = mergeLanes(parent.childLanes, lane);
    alternate = parent.alternate;
    if (alternate !== null) {
      alternate.childLanes = mergeLanes(alternate.childLanes, lane);
    }
    node = parent;
    parent = parent.return;
  }

  if (node.tag === HostRoot) {
    return node.stateNode;  // FiberRoot 반환
  }
}
```

---

## 23. 전체 흐름: 컴포넌트 렌더에서 화면까지

모든 조각을 연결해봅시다:

```
사용자: setState(newValue) 호출
│
├── [dispatchSetState]
│   ├── requestUpdateLane(fiber) → Lane 결정
│   ├── Eager State 체크
│   │   └── is(eagerState, currentState) → true? 종료 (렌더 없음!)
│   └── enqueueConcurrentHookUpdate(fiber, queue, update, lane)
│       └── scheduleUpdateOnFiber(root, fiber, lane, eventTime)
│
├── [ensureRootIsScheduled]
│   └── scheduleCallback(priority, performConcurrentWorkOnRoot)
│
├── [performConcurrentWorkOnRoot - MessageChannel 이후]
│   └── renderRootConcurrent()
│       └── workLoopConcurrent()
│           └── performUnitOfWork(workInProgress)
│               └── beginWork(workInProgress)
│                   └── renderWithHooks(current, wip, Component, ...)
│                       ├── Dispatcher 설정 (HooksDispatcherOnUpdate)
│                       ├── Component(props) 실행
│                       │   └── useState() → updateReducer()
│                       │       ├── baseQueue + pending 합치기
│                       │       ├── Lane 필터링으로 적용할 업데이트 선택
│                       │       └── reducer 적용 → newState
│                       └── Dispatcher를 ContextOnlyDispatcher로 리셋
│
├── [commitRoot]
│   ├── [Before Mutation Phase]
│   │   └── getSnapshotBeforeUpdate (클래스 컴포넌트)
│   │
│   ├── [Mutation Phase]
│   │   ├── useInsertionEffect cleanup
│   │   ├── useInsertionEffect create (CSS-in-JS 스타일 주입)
│   │   ├── DOM 변경 (appendChild, setAttribute 등)
│   │   └── useLayoutEffect cleanup
│   │
│   ├── root.current = finishedWork (트리 교체)
│   │
│   ├── [Layout Phase]
│   │   ├── useLayoutEffect create (DOM 측정 가능)
│   │   ├── useImperativeHandle
│   │   └── ref attach
│   │
│   └── [Passive Effects 스케줄]
│       └── scheduleCallback(NormalPriority, flushPassiveEffects)
│
├── 브라우저 페인트
│
└── [flushPassiveEffects - MessageChannel 이후]
    ├── commitPassiveUnmountEffects (전체 트리 cleanup)
    └── commitPassiveMountEffects (전체 트리 useEffect)
```

---

## 마치며: "Hook은 클로저가 아니다"

Hook을 처음 접하면 "클로저 기반의 상태 관리"라고 이해하기 쉽습니다. 하지만 내부를 들여다보면 전혀 다릅니다.

Hook의 상태는 **클로저에 캡처된 변수가 아니라 Fiber 노드의 memoizedState에 저장된 연결 리스트**입니다. `useState`가 반환하는 `setState`는 `dispatchSetState`를 Fiber와 큐에 바인딩한 함수이며, 각 `useEffect`는 Effect 원형 연결 리스트의 한 노드입니다.

Dispatcher 패턴은 동일한 `useState` 호출이 마운트인지 업데이트인지에 따라 완전히 다른 구현을 실행하게 해줍니다. Rules of Hooks는 이 연결 리스트의 순서가 렌더 간 일치해야 한다는 불변성에서 비롯됩니다.

Concurrent Mode에서의 Tearing 방지는 `useSyncExternalStore`의 커밋 직전 일관성 검사로, Hook이 단순한 상태 저장을 넘어 React의 Concurrent 렌더링 모델과 얼마나 깊이 통합되어 있는지를 보여줍니다.

다음 편에서는 이 Hook들이 속한 Fiber의 우선순위를 결정하는 **Lane 스케줄링 시스템** — 비트마스크로 표현된 31개의 우선순위 채널, Entanglement, 기아 방지 알고리즘을 소스 코드로 추적합니다.

---

> **참조 파일**: `packages/react-reconciler/src/ReactFiberHooks.js`, `packages/react-reconciler/src/ReactFiberCommitWork.js`, `packages/react/src/ReactCurrentDispatcher.js`
>
> **시리즈 링크**:
> - [1편: 패키지 계층 구조](react-architecture-01-package-structure.md)
> - [2편: Fiber 아키텍처](react-architecture-02-fiber-architecture.md)
> - **3편: Hooks 시스템** (현재)
> - [4편: Lane 스케줄링](react-architecture-04-lane-scheduling.md) (예정)

---

*작성일: 2026-02-20*
*분석 기반: React 18.3.1 (`react-dom.development.js` 직접 분석)*
