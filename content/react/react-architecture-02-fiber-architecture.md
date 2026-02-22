# React 아키텍처 심층 분석 (2/14): Fiber 아키텍처 — 소스 코드로 파고드는 내부 구현

> **React 아키텍처 심층 분석** 시리즈의 두 번째 글입니다. [1편](react-architecture-01-package-structure.md)에서 우리는 React의 패키지 구조가 What/How/When/Where라는 네 가지 질문을 분리하기 위해 설계되었음을 확인했습니다. 이번 편에서는 그 중 "How" — `react-reconciler`의 심장부인 **Fiber 아키텍처**를 소스 코드 수준에서 해부합니다. FiberNode 생성자의 모든 필드, `beginWork`의 전체 스위치-케이스, 자식 조정 알고리즘, UpdateQueue의 원형 연결 리스트, Lane 할당 흐름까지 — React 내부를 실제 코드와 함께 추적합니다.

> **참조 소스**: `packages/react-reconciler/src/` (React v19 기준)

---

## 목차

1. [멈출 수 없는 렌더링: Stack Reconciler의 근본적 한계](#1-멈출-수-없는-렌더링)
2. [재귀를 루프로: Fiber의 핵심 통찰](#2-재귀를-루프로)
3. [FiberNode 생성자: 27개 필드의 실제 초기화](#3-fibernode-생성자)
4. [Fiber 트리 구조: LCRS Tree와 3개 포인터](#4-fiber-트리-구조)
5. [createFiberFromTypeAndProps: 타입에서 Fiber로](#5-createfiberfromtypeandprops)
6. [beginWork: 27가지 태그별 분기의 전체 구조](#6-beginwork)
7. [reconcileChildFibers vs mountChildFibers: ChildReconciler 클로저 패턴](#7-reconcilechilfibers-vs-mountchildfibers)
8. [자식 조정 알고리즘: 단일 엘리먼트와 배열의 2패스 Diff](#8-자식-조정-알고리즘)
9. [Bailout 최적화: checkScheduledUpdateOrContext와 didReceiveUpdate](#9-bailout-최적화)
10. [completeWork: DOM 생성과 subtreeFlags 버블링](#10-completework)
11. [UpdateQueue: 원형 연결 리스트의 실제 구현](#11-updatequeue)
12. [Lane 할당 흐름: requestUpdateLane → ensureRootIsScheduled](#12-lane-할당-흐름)
13. [performConcurrentWorkOnRoot: 완료 상태별 처리](#13-performconcurrentworkonroot)
14. [더블 버퍼링: GPU에서 빌려온 설계](#14-더블-버퍼링)
15. [Commit Phase: 3단계의 실제 작업](#15-commit-phase)
16. [V8 엔진 최적화와 FiberNode 설계](#16-v8-엔진-최적화)
17. [Concurrent Features의 근원](#17-concurrent-features)
18. [전체 흐름: 업데이트에서 화면까지](#18-전체-흐름)

---

## 1. 멈출 수 없는 렌더링: Stack Reconciler의 근본적 한계

2017년 이전의 React를 떠올려봅시다. 사용자가 검색창에 글자를 입력합니다. 입력 이벤트가 발생하고, 상태가 갱신되며, 컴포넌트 트리 전체의 재조정(reconciliation)이 시작됩니다. 문제는 이 재조정이 **한번 시작되면 끝날 때까지 멈출 수 없었다**는 것입니다.

Stack Reconciler라는 이름이 모든 것을 말해줍니다. JavaScript의 콜 스택에 의존하는 재귀 호출이었습니다.

```javascript
// Stack Reconciler의 개념적 구현
function reconcileChildren(element) {
  const children = element.props.children;
  for (const child of children) {
    updateComponent(child);       // 재귀
    reconcileChildren(child);     // 재귀
  }
}
```

이 코드에서 `reconcileChildren`이 자기 자신을 호출하면 콜 스택에 프레임이 하나 쌓입니다. 1000개의 컴포넌트를 가진 트리라면 1000개의 스택 프레임이 쌓이고, 모든 프레임이 `return`될 때까지 JavaScript 엔진은 다른 일을 할 수 없습니다. 브라우저는 16.67ms(60fps 기준 한 프레임) 안에 레이아웃, 페인트, 사용자 입력 처리를 모두 해야 하는데, 재조정이 이 시간을 독점하면 화면이 얼어붙습니다.

```
Stack Reconciler가 브라우저 프레임을 독점하는 문제

Frame N       │████████████████████████████████████▓▓▓▓│ 재조정이 프레임 초과
              0ms                               16.67ms  30ms
                                                         ↑ 다음 프레임이 밀림

Frame N+1     │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ 브라우저 렌더 없음
              ↑ 여전히 JS 실행 중

Frame N+2     │────────── 재조정 완료 ──────────│레이아웃│페인트│
                                                            ↑ 뒤늦게 화면 반영 → 화면 끊김

범례:  ████ = 재조정(JS 실행)   ▓▓▓▓ = 초과된 JS 실행
       ░░░░ = 밀린 브라우저 작업  ────  = 이상적인 JS 실행
```

`requestAnimationFrame`이나 `requestIdleCallback`도 해결책이 아니었습니다. 이미 시작된 재귀를 중간에 끊는 방법이 없었기 때문입니다. 문제의 본질은 타이밍이 아니라 **작업의 분할 불가능성**에 있었습니다. JavaScript 콜 스택이 작업의 진행 상태를 추적하는 한, 중단 가능한 렌더링은 불가능했습니다.

---

## 2. 재귀를 루프로: Fiber의 핵심 통찰

Fiber 아키텍처의 핵심 아이디어는 단순합니다. **콜 스택이 해주던 일을 힙(heap)에 있는 객체가 대신하게 하자.**

콜 스택의 각 프레임이 하는 일을 분석하면:
1. 현재 실행 중인 함수의 지역 변수를 보관 → Fiber 객체의 필드
2. 함수가 끝나면 어디로 돌아갈지(return address)를 기억 → `fiber.return` 포인터

이 전환의 결정적 차이는 **제어권**입니다. 콜 스택은 JavaScript 엔진이 관리하므로 애플리케이션이 개입할 수 없습니다. 반면 힙의 객체는 우리가 만든 것이므로, 언제든 "지금 여기까지 했으니 잠시 멈추자"고 결정할 수 있습니다. 덕분에 깊은 재귀가 단순한 `while` 루프로 바뀝니다.

```javascript
// packages/react-reconciler/src/ReactFiberWorkLoop.js

// 동기 실행 경로 - 절대 양보 없음
function workLoop() {
  while (workInProgress !== null) {
    performUnitOfWork(workInProgress);
  }
}

// Concurrent 실행 경로 - 매 반복마다 양보 여부 확인
function workLoopConcurrent() {
  while (workInProgress !== null && !shouldYield()) {
    performUnitOfWork(workInProgress);
  }
}
```

`!shouldYield()` -- 이 단 하나의 조건절 차이가 React Concurrent Mode 전체를 가능하게 합니다. 루프의 매 반복마다 "브라우저에 제어권을 돌려줘야 하는가?"를 확인하고, 그렇다면 루프를 빠져나옵니다. `workInProgress` 변수에 "다음에 처리해야 할 Fiber"가 저장되어 있으므로, 나중에 루프를 다시 시작하면 정확히 멈춘 지점부터 이어갈 수 있습니다.

이것이 "Fiber"라는 이름이 붙은 이유입니다. 운영체제 이론에서 Fiber는 **스레드보다 가벼운, 사용자 공간에서 협력적으로 스케줄링되는 실행 단위**입니다. React의 Fiber는 "렌더링이라는 실행 컨텍스트를 작은 단위로 분해하고, 협력적으로 스케줄링한다"는 동일한 개념을 JavaScript 런타임 위에 구현한 것입니다.

### shouldYield()의 실제 구현: 5ms의 근거

```javascript
// packages/scheduler/src/forks/Scheduler.js

let frameInterval = 5; // ms (기본값)

function shouldYieldToHost(): boolean {
  const timeElapsed = getCurrentTime() - startTime;
  if (timeElapsed < frameInterval) {
    return false;  // 아직 시간 남음 → 계속
  }
  // navigator.scheduling.isInputPending() API 연동
  if (enableIsInputPending) {
    if (isInputPending !== null) {
      return isInputPending(); // 사용자 입력 대기 중이면 즉시 양보
    }
  }
  return true; // 5ms 초과 → 양보
}
```

왜 5ms인가? 60fps 기준 한 프레임은 16.67ms입니다. 120fps 디스플레이에서는 8.33ms입니다. React가 5ms를 사용하면 나머지 시간으로 레이아웃과 페인트를 처리할 수 있습니다. 5ms는 60fps와 120fps 모두에서 유효한 균형점입니다.

### MessageChannel을 선택한 이유

작업 재개 시 React는 `MessageChannel`을 통해 다음 작업을 예약합니다.

```javascript
// packages/scheduler/src/forks/Scheduler.js

const channel = new MessageChannel();
const port = channel.port2;
channel.port1.onmessage = performWorkUntilDeadline;

function schedulePerformWorkUntilDeadline() {
  port.postMessage(null); // 즉시 다음 태스크 큐에 등록
}
```

`setTimeout(fn, 0)`은 HTML 스펙에 의해 중첩 호출 시 최소 4ms 지연이 강제됩니다. 5ms 타임슬라이스에서 4ms 오버헤드는 낭비입니다. `requestIdleCallback`은 Safari 미지원, 무기한 지연 가능, 50ms 기본 타임아웃. `requestAnimationFrame`은 16.67ms 주기에 묶입니다. `MessageChannel`은 마이크로태스크 직후 최소 지연으로 실행됩니다.

---

## 3. FiberNode 생성자: 27개 필드의 실제 초기화

Fiber 노드는 JavaScript 객체입니다. 모든 필드를 생성자에서 초기화하는 이유는 단순한 관례가 아닌 **V8 엔진의 Hidden Class(Shape) 최적화**를 위해서입니다(자세한 이유는 [16절](#16-v8-엔진-최적화)에서).

```javascript
// packages/react-reconciler/src/ReactFiber.js

function FiberNode(
  this: $FlowFixMe,
  tag: WorkTag,
  pendingProps: mixed,
  key: null | string,
  mode: TypeOfMode,
) {
  // ═══════════════════════════════════════
  // [1] 인스턴스 식별 (Identity)
  // ═══════════════════════════════════════
  this.tag = tag;           // WorkTag: Fiber 종류 (FunctionComponent=0, HostComponent=5 등)
  this.key = key;           // React key prop — 재조정 시 동일성 판단
  this.elementType = null;  // JSX 타입 (React.memo 래퍼 포함된 원본)
  this.type = null;         // 실제 컴포넌트 함수/클래스/태그 문자열

  // ═══════════════════════════════════════
  // [2] 렌더러 바인딩 (Renderer Binding)
  // ═══════════════════════════════════════
  this.stateNode = null;    // DOM 노드 | Class 인스턴스 | FiberRoot 참조

  // ═══════════════════════════════════════
  // [3] Fiber 트리 구조 (LCRS Tree)
  // ═══════════════════════════════════════
  this.return = null;       // 부모 Fiber — "작업 완료 후 돌아갈 주소"
  this.child = null;        // 첫 번째 자식 Fiber
  this.sibling = null;      // 다음 형제 Fiber
  this.index = 0;           // 형제 중 위치 인덱스

  // ═══════════════════════════════════════
  // [4] Ref
  // ═══════════════════════════════════════
  this.ref = null;
  this.refCleanup = null;   // React 19+: ref cleanup 함수

  // ═══════════════════════════════════════
  // [5] Props & State
  // ═══════════════════════════════════════
  this.pendingProps = pendingProps;  // "이 props로 렌더하라"는 명령
  this.memoizedProps = null;         // 마지막으로 DOM에 커밋된 props
  this.updateQueue = null;           // UpdateQueue (원형 연결 리스트)
  this.memoizedState = null;         // Hooks 연결 리스트 헤드 | Class state
  this.dependencies = null;          // Context dependencies

  // ═══════════════════════════════════════
  // [6] 렌더링 모드
  // ═══════════════════════════════════════
  this.mode = mode;  // ConcurrentMode | StrictMode | NoMode

  // ═══════════════════════════════════════
  // [7] 사이드 이펙트 플래그 (Effects)
  // ═══════════════════════════════════════
  this.flags = NoFlags;        // 이 Fiber에 필요한 작업 비트마스크
  this.subtreeFlags = NoFlags; // 하위 트리 전체 flags 합집합
  this.deletions = null;       // 삭제할 자식 Fiber 배열

  // ═══════════════════════════════════════
  // [8] 스케줄링 (Lanes)
  // ═══════════════════════════════════════
  this.lanes = NoLanes;        // 이 Fiber에 예약된 작업의 우선순위
  this.childLanes = NoLanes;   // 하위 트리의 예약된 작업 우선순위

  // ═══════════════════════════════════════
  // [9] 더블 버퍼링 (Double Buffering)
  // ═══════════════════════════════════════
  this.alternate = null;  // current.alternate = WIP, WIP.alternate = current
}
```

### 각 필드 범주의 역할

| 범주 | 필드 | 역할 |
|------|------|------|
| **인스턴스 식별** | `tag`, `key`, `elementType`, `type` | Fiber가 무엇인지 식별 |
| **렌더러 바인딩** | `stateNode` | 플랫폼 구현체(DOM/인스턴스) 연결 |
| **트리 구조** | `return`, `child`, `sibling`, `index` | LCRS Tree 형성 |
| **Props/State** | `pendingProps`, `memoizedProps`, `memoizedState`, `updateQueue` | 처리 중/확정된 데이터 |
| **이펙트** | `flags`, `subtreeFlags`, `deletions` | 커밋 단계 작업 목록 |
| **스케줄링** | `lanes`, `childLanes` | 우선순위 관리 |
| **더블 버퍼링** | `alternate` | 트리 전환 |

### pendingProps vs memoizedProps: 의도와 현실의 분리

props가 두 벌 존재하는 이유는 Concurrent Mode에서 렌더가 중단될 수 있기 때문입니다.

```
pendingProps / memoizedProps 상태 전이

setState() 호출
    │
    ▼
pendingProps 설정 ← "목표 상태" 기록
    │
    ▼
Render Phase (중단 가능)
    ├─ 정상 완료 → Commit Phase → memoizedProps 갱신
    └─ 고우선순위 작업 등장 → 현재 렌더 폐기
                               pendingProps 보존 (다음 렌더 때 재사용)
                               memoizedProps 보존 (화면은 그대로)

핵심: pendingProps == memoizedProps → bailout 가능
      pendingProps != memoizedProps → 업데이트 필요
```

React는 `pendingProps === memoizedProps` 비교로 bailout(서브트리 스킵)을 판단합니다. `React.memo`, `PureComponent`, `useMemo`는 모두 이 bailout 경로를 활성화하기 위한 도구들입니다.

### memoizedState: Hook 연결 리스트의 헤드

함수형 컴포넌트에서 `memoizedState`는 훅들의 연결 리스트 헤드를 가리킵니다.

```
Fiber 노드
└─ memoizedState ──► Hook #1 (useState)
                      ├─ memoizedState: "hello"
                      ├─ queue: UpdateQueue (원형 연결 리스트)
                      └─ next ──► Hook #2 (useEffect)
                                   ├─ memoizedState: {create, destroy, deps}
                                   └─ next ──► Hook #3 (useMemo)
                                                ├─ memoizedState: [cachedValue, deps]
                                                └─ next ──► null
```

React가 Hook을 이름이 아닌 **호출 순서**로만 추적하는 이유가 여기에 있습니다. "Hook은 항상 같은 순서로 호출되어야 한다"는 규칙은 임의적 제약이 아니라 연결 리스트 기반 설계의 구조적 귀결입니다.

### flags와 subtreeFlags: 비트마스크가 만드는 성능 차이

```javascript
// packages/react-reconciler/src/ReactFiberFlags.js (일부)
export const NoFlags          = 0b00000000000000000000000000;
export const Placement        = 0b00000000000000000000000010;  // 새로 삽입
export const Update           = 0b00000000000000000000000100;  // 갱신 필요
export const ChildDeletion    = 0b00000000000000000000010000;  // 자식 삭제
export const ContentReset     = 0b00000000000000000000100000;  // 텍스트 초기화
export const Ref              = 0b00000000000000001000000000;  // ref 갱신
export const Visibility       = 0b00000000000010000000000000;  // 가시성 변경

// Commit Phase에서 각 단계별로 검사하는 마스크
export const MutationMask = Placement | Update | ChildDeletion | ...;
export const LayoutMask   = Update | Callback | Ref | Visibility;
export const PassiveMask  = Passive | ChildDeletion;
```

`subtreeFlags`는 **하위 트리 전체의 flags를 합산**한 것입니다. `completeWork`에서 상위로 버블링됩니다.

```javascript
// completeWork에서 자식의 flags를 부모로 버블링
workInProgress.subtreeFlags |= child.subtreeFlags | child.flags;
```

커밋 단계에서 `subtreeFlags`가 0인 가지를 통째로 건너뜁니다. 1000개 컴포넌트 중 3개만 변경되었다면, 세그먼트 트리의 lazy propagation과 유사하게 변경 없는 서브트리를 방문하지 않습니다.

```
subtreeFlags 버블링 — 변경된 노드를 상위로 전파

HostRoot  [subtreeFlags: 0b100]     ← 아래 변경 정보가 버블링됨
    │
   App    [subtreeFlags: 0b100]
    ├─── Header [flags:0, subtreeFlags:0]   ← Commit Phase에서 통째로 건너뜀
    └─── Main   [subtreeFlags: 0b100]
              ├─── Article [subtreeFlags:0]
              │        └── Content [flags: Update=0b100]  ← 실제 변경
              └─── Sidebar [flags: Update=0b100]          ← 실제 변경

Commit Phase:
  HostRoot → subtreeFlags != 0 → 진입
    Header → subtreeFlags == 0 → 건너뜀 (서브트리 전체 스킵)
    Main   → subtreeFlags != 0 → 진입
      Content → flags: Update  → DOM 갱신
      Sidebar → flags: Update  → DOM 갱신
```

---

## 4. Fiber 트리 구조: LCRS Tree와 3개 포인터

Fiber 트리는 세 가지 포인터로 구성됩니다. 이 구조는 컴퓨터 과학에서 **LCRS Tree(Left-Child Right-Sibling Tree)**라고 부르는 고전적 표현법입니다. 임의 개수의 자식을 가진 N-ary 트리를, 각 노드가 최대 두 개의 포인터만 갖는 이진 트리로 변환하는 기법입니다.

```
        HostRoot
        │
        ▼ child
       App
        │
        ▼ child
      Header ──sibling──► Main ──sibling──► Footer
        │                  │                  │
        ▼ child            ▼ child            ▼ child
       Nav              Article ──sibling──► Sidebar
                          │
                          ▼ child
                        Title ──sibling──► Content

    (모든 노드는 return 포인터로 부모를 가리킴)
```

`return` 포인터의 이름이 의미심장합니다. "parent"가 아닌 "return"인 이유는, 이 포인터가 콜 스택에서 함수가 끝난 후 **돌아갈 주소(return address)**와 동일한 역할을 하기 때문입니다. Fiber의 작업이 완료되면 `return` 포인터를 따라 부모로 올라가서 다음 할 일을 결정합니다.

```javascript
// packages/react-reconciler/src/ReactFiberWorkLoop.js

function performUnitOfWork(unitOfWork: Fiber): void {
  const current = unitOfWork.alternate; // current 트리의 대응 Fiber
  const next = beginWork(current, unitOfWork, renderLanes); // 자식 반환

  unitOfWork.memoizedProps = unitOfWork.pendingProps; // props 확정

  if (next === null) {
    // 자식 없음 → 현재 Fiber 완료 후 형제/부모로
    completeUnitOfWork(unitOfWork);
  } else {
    // 자식 있음 → 자식으로 내려감
    workInProgress = next;
  }
}

function completeUnitOfWork(unitOfWork: Fiber): void {
  let completedWork: Fiber = unitOfWork;
  do {
    completeWork(completedWork.alternate, completedWork, renderLanes);

    const sibling = completedWork.sibling;
    if (sibling !== null) {
      // 형제가 있으면 형제의 beginWork로 이동
      workInProgress = sibling;
      return;
    }
    // 형제 없음 → 부모로 올라감 (return 포인터)
    completedWork = completedWork.return;
    workInProgress = completedWork;
  } while (completedWork !== null);
}
```

이 순회 알고리즘으로 스택 없이 전체 트리를 DFS로 방문합니다.

```
순회 순서 (위 트리 예시):
Begin:    HostRoot → App → Header → Nav
Complete: Nav → Header
Begin:    Main → Article → Title
Complete: Title
Begin:    Content
Complete: Content → Article
Begin:    Sidebar
Complete: Sidebar → Main
Begin:    Footer
Complete: Footer → App → HostRoot
```

---

## 5. createFiberFromTypeAndProps: 타입에서 Fiber로

JSX 엘리먼트로부터 Fiber를 생성하는 과정을 추적합니다.

```javascript
// packages/react-reconciler/src/ReactFiber.js

export function createFiberFromTypeAndProps(
  type: any,
  key: null | string,
  pendingProps: any,
  mode: TypeOfMode,
  lanes: Lanes,
): Fiber {
  let fiberTag: WorkTag = IndeterminateComponent; // 기본값: 미결정
  let resolvedType = type;

  if (typeof type === 'function') {
    // 함수: 클래스 vs 함수형 컴포넌트 구분
    if (shouldConstruct(type)) {
      // prototype.isReactComponent가 있으면 클래스 컴포넌트
      fiberTag = ClassComponent;
    } else {
      // 함수형은 실제 실행 전까지 IndeterminateComponent
      fiberTag = IndeterminateComponent;
    }
  } else if (typeof type === 'string') {
    // 문자열: DOM 호스트 요소
    if (supportsResources && supportsSingletons) {
      // React 19: 특수 DOM 요소 처리
      const hostContext = getHostContext();
      fiberTag = isHostHoistableType(type, pendingProps, hostContext)
        ? HostHoistable   // <link>, <style>, <script>, <title> → 문서 헤드로 호이스팅
        : isHostSingletonType(type)
        ? HostSingleton   // <html>, <head>, <body> → 전역 싱글톤
        : HostComponent;  // 일반 DOM 요소
    } else {
      fiberTag = HostComponent;
    }
  } else {
    // 특수 React 타입 객체
    getTag: switch (type) {
      case REACT_FRAGMENT_TYPE:
        return createFiberFromFragment(pendingProps.children, mode, lanes, key);
      case REACT_STRICT_MODE_TYPE:
        fiberTag = Mode;
        mode |= StrictLegacyMode | StrictEffectsMode;
        break;
      case REACT_SUSPENSE_TYPE:
        return createFiberFromSuspense(pendingProps, mode, lanes, key);
      default: {
        if (typeof type === 'object' && type !== null) {
          switch (type.$$typeof) {
            case REACT_PROVIDER_TYPE:
            case REACT_CONTEXT_TYPE:
              fiberTag = ContextProvider; break getTag;
            case REACT_CONSUMER_TYPE:
              fiberTag = ContextConsumer; break getTag;
            case REACT_FORWARD_REF_TYPE:
              fiberTag = ForwardRef;
              resolvedType = type.render; break getTag;
            case REACT_MEMO_TYPE:
              fiberTag = MemoComponent; break getTag;
            case REACT_LAZY_TYPE:
              fiberTag = LazyComponent;
              resolvedType = null; break getTag;
          }
        }
      }
    }
  }

  const fiber = createFiber(fiberTag, pendingProps, key, mode);
  fiber.elementType = type;     // React.memo 등 래퍼 포함된 원본 타입
  fiber.type = resolvedType;    // 실제 컴포넌트 함수/클래스
  fiber.lanes = lanes;
  return fiber;
}
```

`elementType`과 `type`이 다른 경우가 있습니다. `React.memo(Component)`를 사용하면 `elementType`은 memo 래퍼 객체이고, `type`은 원본 `Component` 함수입니다. `elementType`은 재조정 시 컴포넌트 동일성을 비교하는 데 사용됩니다.

---

## 6. beginWork: 27가지 태그별 분기의 전체 구조

`beginWork`는 Fiber 트리의 하강 단계에서 실행되며, 각 WorkTag에 따라 서로 다른 처리 함수로 분기합니다.

```javascript
// packages/react-reconciler/src/ReactFiberBeginWork.js

// 모듈 수준 변수 — 현재 Fiber가 업데이트를 받았는지 추적
let didReceiveUpdate: boolean = false;

function beginWork(
  current: Fiber | null,   // 현재 화면에 표시된 Fiber (null이면 최초 마운트)
  workInProgress: Fiber,   // 작업 중인 Fiber
  renderLanes: Lanes,      // 현재 렌더링 우선순위
): Fiber | null {

  // ── 업데이트 경로에서의 early bailout 검사 ──
  if (current !== null) {
    const oldProps = current.memoizedProps;
    const newProps = workInProgress.pendingProps;

    if (oldProps !== newProps || hasLegacyContextChanged()) {
      // props 또는 context 변경 → 렌더 필요
      didReceiveUpdate = true;
    } else {
      // checkScheduledUpdateOrContext: lanes와 context 변경 여부 확인
      const hasScheduledUpdate = checkScheduledUpdateOrContext(current, renderLanes);
      if (!hasScheduledUpdate) {
        didReceiveUpdate = false;
        // Bailout! 이 서브트리는 건너뜀
        return attemptEarlyBailoutIfNoScheduledUpdate(
          current, workInProgress, renderLanes,
        );
      }
      didReceiveUpdate = false;
    }
  } else {
    didReceiveUpdate = false; // 최초 마운트
  }

  workInProgress.lanes = NoLanes; // lanes 초기화 (처리 시작)

  // ── WorkTag별 처리 함수 분기 ──
  switch (workInProgress.tag) {
    case IndeterminateComponent:   // tag=2: 최초 마운트 시 함수/클래스 구분 전
      return mountIndeterminateComponent(
        current, workInProgress, workInProgress.type, renderLanes
      );

    case LazyComponent:            // tag=16: React.lazy()
      return mountLazyComponent(
        current, workInProgress, workInProgress.elementType, renderLanes
      );

    case FunctionComponent: {      // tag=0: 함수형 컴포넌트
      const Component = workInProgress.type;
      const resolvedProps = resolveDefaultProps(Component, workInProgress.pendingProps);
      return updateFunctionComponent(
        current, workInProgress, Component, resolvedProps, renderLanes
      );
    }

    case ClassComponent: {         // tag=1: 클래스형 컴포넌트
      const Component = workInProgress.type;
      const resolvedProps = resolveDefaultProps(Component, workInProgress.pendingProps);
      return updateClassComponent(
        current, workInProgress, Component, resolvedProps, renderLanes
      );
    }

    case HostRoot:                 // tag=3: ReactDOM.createRoot()의 루트
      return updateHostRoot(current, workInProgress, renderLanes);

    case HostPortal:               // tag=4: ReactDOM.createPortal()
      return updatePortalComponent(current, workInProgress, renderLanes);

    case HostComponent:            // tag=5: <div>, <span> 등 DOM 요소
      return updateHostComponent(current, workInProgress, renderLanes);

    case HostText:                 // tag=6: 텍스트 노드
      return updateHostText(current, workInProgress);

    case Fragment:                 // tag=7: <></>
      return updateFragment(current, workInProgress, renderLanes);

    case Mode:                     // tag=8: <StrictMode>
      return updateMode(current, workInProgress, renderLanes);

    case ContextConsumer:          // tag=9: Context.Consumer
      return updateContextConsumer(current, workInProgress, renderLanes);

    case ContextProvider:          // tag=10: Context.Provider
      return updateContextProvider(current, workInProgress, renderLanes);

    case ForwardRef: {             // tag=11: React.forwardRef()
      const type = workInProgress.type;
      const render = type.render;
      return updateForwardRef(current, workInProgress, type, render, renderLanes);
    }

    case Profiler:                 // tag=12: <Profiler>
      return updateProfiler(current, workInProgress, renderLanes);

    case SuspenseComponent:        // tag=13: <Suspense>
      return updateSuspenseComponent(current, workInProgress, renderLanes);

    case MemoComponent: {          // tag=14: React.memo() + 커스텀 compare
      const type = workInProgress.type;
      const resolvedProps = resolveDefaultProps(type.type, workInProgress.pendingProps);
      return updateMemoComponent(
        current, workInProgress, type, resolvedProps, renderLanes
      );
    }

    case SimpleMemoComponent:      // tag=15: React.memo() (compare 없음)
      return updateSimpleMemoComponent(
        current, workInProgress,
        workInProgress.type, workInProgress.pendingProps, renderLanes
      );

    case SuspenseListComponent:    // tag=19: <SuspenseList>
      return updateSuspenseListComponent(current, workInProgress, renderLanes);

    case OffscreenComponent:       // tag=22: <Offscreen> (Activity API)
      return updateOffscreenComponent(current, workInProgress, renderLanes);

    case HostHoistable:            // tag=26: React 19, <title> 등 호이스팅 요소
      return updateHostHoistableComponent(current, workInProgress, renderLanes);

    case HostSingleton:            // tag=27: React 19, <html>, <head>, <body>
      return updateHostSingleton(current, workInProgress, renderLanes);
  }

  throw new Error(`Unknown unit of work tag (${workInProgress.tag}).`);
}
```

### IndeterminateComponent (tag=2): 결정 전의 상태

함수 컴포넌트는 최초 마운트 시 `FunctionComponent(0)` 태그가 아니라 `IndeterminateComponent(2)` 태그로 시작합니다. `mountIndeterminateComponent` 내부에서 실제로 컴포넌트를 호출한 뒤 반환값이 `{render}` 형태이면 클래스로, 그렇지 않으면 함수로 확정되어 태그가 변경됩니다. 이 태그는 두 번 이상 나타나지 않습니다.

### MemoComponent vs SimpleMemoComponent의 실제 bailout 경로

```javascript
// packages/react-reconciler/src/ReactFiberBeginWork.js

function updateSimpleMemoComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  Component: any,
  nextProps: any,
  renderLanes: Lanes,
): null | Fiber {
  if (current !== null) {
    const prevProps = current.memoizedProps;

    if (shallowEqual(prevProps, nextProps) && current.ref === workInProgress.ref) {
      didReceiveUpdate = false;

      // !! 중요: props가 같아도 checkScheduledUpdateOrContext는 반드시 실행
      // → Context 변경이나 setState로 인한 업데이트가 있을 수 있음
      if (!checkScheduledUpdateOrContext(current, renderLanes)) {
        workInProgress.lanes = current.lanes;
        return bailoutOnAlreadyFinishedWork(current, workInProgress, renderLanes);
      }
    }
  }

  // 렌더링 진행
  return updateFunctionComponent(
    current, workInProgress, Component, nextProps, renderLanes
  );
}

function updateMemoComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  Component: any,
  nextProps: any,
  renderLanes: Lanes,
): null | Fiber {
  const prevProps = current.memoizedProps;
  let compare = Component.compare;
  compare = compare !== null ? compare : shallowEqual; // 커스텀 또는 기본값

  if (compare(prevProps, nextProps) && current.ref === workInProgress.ref) {
    return bailoutOnAlreadyFinishedWork(current, workInProgress, renderLanes);
  }

  didReceiveUpdate = true;
  // 렌더링 진행...
}
```

`SimpleMemoComponent`는 내부 처리가 약간 더 단순합니다. `React.memo(Component, customCompare)`처럼 커스텀 비교 함수를 전달하면 `MemoComponent(14)`, 그렇지 않으면 `SimpleMemoComponent(15)`가 됩니다.

---

## 7. reconcileChildFibers vs mountChildFibers: ChildReconciler 클로저 패턴

자식 Fiber를 생성하거나 재사용하는 조정(reconciliation) 과정은 두 가지 변형이 존재합니다.

```javascript
// packages/react-reconciler/src/ReactChildFiber.js

// 동일한 팩토리 함수에서 생성 — shouldTrackSideEffects 값만 다름
export const reconcileChildFibers: ChildReconciler =
  createChildReconciler(true);   // 업데이트 경로: Placement/Deletion flag 설정
export const mountChildFibers: ChildReconciler =
  createChildReconciler(false);  // 마운트 경로: flag 설정 안 함
```

`shouldTrackSideEffects`가 `false`인 이유는 성능 때문입니다. 최초 마운트 시 모든 Fiber에 `Placement` flag를 설정하면 커밋 단계에서 수천 번의 DOM 삽입이 발생합니다. 대신 `HostRoot`의 자식(`<App/>`) 하나에만 `Placement`를 설정하여 완성된 DOM 서브트리를 한 번에 삽입합니다.

```javascript
// ChildReconciler 내부 핵심 함수들

function deleteChild(returnFiber: Fiber, childToDelete: Fiber): void {
  if (!shouldTrackSideEffects) {
    return; // 마운트 시: 삭제할 기존 Fiber가 없으므로 무시
  }
  // 업데이트 시: ChildDeletion flag 설정
  const deletions = returnFiber.deletions;
  if (deletions === null) {
    returnFiber.deletions = [childToDelete];
    returnFiber.flags |= ChildDeletion;
  } else {
    deletions.push(childToDelete);
  }
}

function placeSingleChild(newFiber: Fiber): Fiber {
  // 새로 생성된 Fiber(alternate === null)에만 Placement flag 설정
  if (shouldTrackSideEffects && newFiber.alternate === null) {
    newFiber.flags |= Placement | PlacementDEV;
  }
  return newFiber;
}
```

### reconcileChildren 진입점

```javascript
// packages/react-reconciler/src/ReactFiberBeginWork.js

function reconcileChildren(
  current: Fiber | null,
  workInProgress: Fiber,
  nextChildren: any,
  renderLanes: Lanes,
) {
  if (current === null) {
    // 최초 마운트: Placement flag 설정 안 함
    workInProgress.child = mountChildFibers(
      workInProgress,
      null,          // 기존 자식 없음
      nextChildren,
      renderLanes,
    );
  } else {
    // 업데이트: Placement/Deletion flag 설정
    workInProgress.child = reconcileChildFibers(
      workInProgress,
      current.child, // 기존 첫 번째 자식
      nextChildren,
      renderLanes,
    );
  }
}
```

**HostRoot만 예외인 이유:** `createRoot()` 시점에 이미 current fiber가 생성되어 있습니다. 따라서 최초 렌더링이라도 `current !== null`이어서 `reconcileChildFibers`가 호출되고, `<App/>` fiber 하나에만 `Placement` flag가 붙습니다.

---

## 8. 자식 조정 알고리즘: 단일 엘리먼트와 배열의 2패스 Diff

### 8-1. 단일 자식: reconcileSingleElement

```javascript
// packages/react-reconciler/src/ReactChildFiber.js

function reconcileSingleElement(
  returnFiber: Fiber,
  currentFirstChild: Fiber | null,
  element: ReactElement,
  lanes: Lanes,
): Fiber {
  const key = element.key;
  let child = currentFirstChild;

  // 기존 자식들을 순회하면서 재사용 가능한 Fiber 탐색
  while (child !== null) {
    if (child.key === key) {
      // key 일치 → type 확인
      if (child.elementType === element.type) {
        // type도 일치 → 기존 Fiber 재사용!
        deleteRemainingChildren(returnFiber, child.sibling); // 나머지 형제 삭제
        const existing = useFiber(child, element.props);     // 클론
        existing.ref = coerceRef(returnFiber, child, element);
        existing.return = returnFiber;
        return existing;
      }
      // key는 같지만 type 다름 → 기존 Fiber 모두 삭제 후 새로 생성
      deleteRemainingChildren(returnFiber, child);
      break;
    } else {
      // key 불일치 → 이 자식만 삭제하고 계속 탐색
      deleteChild(returnFiber, child);
    }
    child = child.sibling;
  }

  // 재사용 불가 → 새 Fiber 생성
  const created = createFiberFromElement(element, returnFiber.mode, lanes);
  created.ref = coerceRef(returnFiber, currentFirstChild, element);
  created.return = returnFiber;
  return created;
}
```

### 8-2. 배열 자식: 2패스 Diff 알고리즘

배열 자식의 경우 두 번의 패스로 처리합니다.

```javascript
// packages/react-reconciler/src/ReactChildFiber.js

function reconcileChildrenArray(
  returnFiber: Fiber,
  currentFirstChild: Fiber | null,
  newChildren: Array<any>,
  lanes: Lanes,
): Fiber | null {
  let resultingFirstChild: Fiber | null = null;
  let previousNewFiber: Fiber | null = null;
  let oldFiber = currentFirstChild;
  let lastPlacedIndex = 0; // 마지막으로 제자리에 있던 old fiber의 index
  let newIdx = 0;

  // ─── 첫 번째 패스: 앞에서부터 순서대로 key 비교 ───
  for (; oldFiber !== null && newIdx < newChildren.length; newIdx++) {
    // updateSlot: key가 같으면 fiber 재사용, 다르면 null 반환
    const newFiber = updateSlot(returnFiber, oldFiber, newChildren[newIdx], lanes);

    if (newFiber === null) {
      // key 불일치 → 첫 번째 패스 종료, 두 번째 패스로
      if (oldFiber === null) oldFiber = nextOldFiber;
      break;
    }

    if (shouldTrackSideEffects) {
      if (oldFiber && newFiber.alternate === null) {
        // key는 같지만 type이 달라 새 fiber 생성된 경우
        deleteChild(returnFiber, oldFiber);
      }
    }

    // placeChild: 위치 변경 여부 판단 → Placement flag 설정
    lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);

    if (previousNewFiber === null) {
      resultingFirstChild = newFiber;
    } else {
      previousNewFiber.sibling = newFiber;
    }
    previousNewFiber = newFiber;
    oldFiber = oldFiber.sibling;
  }

  // 새 자식 다 처리 → 남은 old fiber 삭제
  if (newIdx === newChildren.length) {
    deleteRemainingChildren(returnFiber, oldFiber);
    return resultingFirstChild;
  }

  // 기존 자식 없음 (최초 마운트) → 모두 새로 생성
  if (oldFiber === null) {
    for (; newIdx < newChildren.length; newIdx++) {
      const newFiber = createChild(returnFiber, newChildren[newIdx], lanes);
      if (newFiber === null) continue;
      lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
      // fiber 연결...
    }
    return resultingFirstChild;
  }

  // ─── 두 번째 패스: Map 기반 key 탐색 ───
  // 남은 old fiber들을 Map에 저장 {key → Fiber}
  const existingChildren: Map<string | number, Fiber> =
    mapRemainingChildren(returnFiber, oldFiber);

  // new children의 나머지를 Map에서 탐색
  for (; newIdx < newChildren.length; newIdx++) {
    const newFiber = updateFromMap(
      existingChildren, returnFiber, newIdx, newChildren[newIdx], lanes,
    );

    if (newFiber !== null) {
      if (shouldTrackSideEffects && newFiber.alternate !== null) {
        existingChildren.delete(newFiber.key === null ? newIdx : newFiber.key);
      }
      lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
      // fiber 연결...
    }
  }

  // Map에 남아있는 fiber = 더 이상 필요 없음 → 삭제
  if (shouldTrackSideEffects) {
    existingChildren.forEach(child => deleteChild(returnFiber, child));
  }

  return resultingFirstChild;
}
```

### lastPlacedIndex로 이동 여부 판단

`placeChild`에서 `lastPlacedIndex`를 기준으로 DOM 이동이 필요한지 결정합니다.

```
예: [A, B, C, D] → [A, C, B, D]

첫 번째 패스:
  newIdx=0: old=A, key='A' 일치 → 재사용
    A.alternate.index=0, lastPlacedIndex=max(0,0)=0
  newIdx=1: old=B, new='C' → key 불일치 → 패스 종료

두 번째 패스 (Map: {B:fiberB, C:fiberC, D:fiberD}):
  newIdx=1: new='C' → Map['C']=fiberC 재사용
    fiberC.alternate.index=2, lastPlacedIndex=0
    2 >= 0 → 이동 불필요, lastPlacedIndex=2
  newIdx=2: new='B' → Map['B']=fiberB 재사용
    fiberB.alternate.index=1, lastPlacedIndex=2
    1 < 2  → 이동 필요! → Placement flag 설정
  newIdx=3: new='D' → Map['D']=fiberD 재사용
    fiberD.alternate.index=3, lastPlacedIndex=2
    3 >= 2 → 이동 불필요, lastPlacedIndex=3

결과: C는 제자리, B만 이동, D는 제자리
```

이것이 "key가 없으면 모든 자식을 불필요하게 재생성한다"는 이유입니다. key 없이는 인덱스를 key로 사용하는데, 배열 중간에 삽입/삭제하면 모든 인덱스가 밀려 재사용이 불가합니다.

---

## 9. Bailout 최적화: checkScheduledUpdateOrContext와 didReceiveUpdate

```javascript
// packages/react-reconciler/src/ReactFiberBeginWork.js

function checkScheduledUpdateOrContext(
  current: Fiber,
  renderLanes: Lanes,
): boolean {
  // 이 Fiber에 현재 렌더링 우선순위에 해당하는 예약된 업데이트가 있는지
  const updateLanes = current.lanes;
  if (includesSomeLane(updateLanes, renderLanes)) {
    return true; // setState 등으로 업데이트가 예약된 경우
  }

  // Context 구독 변경 여부 확인 (lazy propagation 모드)
  if (enableLazyContextPropagation) {
    const dependencies = current.dependencies;
    if (dependencies !== null && checkIfContextChanged(dependencies)) {
      return true;
    }
  }

  return false;
}

function bailoutOnAlreadyFinishedWork(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
): Fiber | null {
  // childLanes 확인: 자식에 업데이트가 있으면 자식은 처리해야 함
  if (!includesSomeLane(renderLanes, workInProgress.childLanes)) {
    // 자식도 업데이트 없음 → 이 서브트리 전체 건너뜀
    return null; // null 반환 = 자식 처리 안 함
  }

  // 이 Fiber는 변경 없지만 자식에는 업데이트 있음
  // → 현재 Fiber의 자식 clone해서 workInProgress에 연결
  cloneChildFibers(current, workInProgress);
  return workInProgress.child; // 자식 처리 계속
}
```

```
Bailout 결정 흐름

beginWork 진입
  ├── current === null → 최초 마운트 → 반드시 렌더링
  └── current !== null
        ├── oldProps !== newProps → didReceiveUpdate=true → 렌더링
        ├── hasLegacyContextChanged → didReceiveUpdate=true → 렌더링
        └── props 동일
              └── checkScheduledUpdateOrContext
                    ├── lanes 있음 → 렌더링
                    ├── context 변경됨 → 렌더링
                    └── 아무것도 없음 → attemptEarlyBailoutIfNoScheduledUpdate
                          └── bailoutOnAlreadyFinishedWork
                                ├── childLanes 없음 → null (서브트리 전체 스킵!)
                                └── childLanes 있음 → cloneChildFibers → 자식 처리
```

---

## 10. completeWork: DOM 생성과 subtreeFlags 버블링

`completeWork`는 Fiber 트리의 상승 단계에서 실행됩니다. 여기서 실제 DOM 인스턴스가 생성됩니다 — 단, 아직 실제 DOM 트리에 삽입되지는 않습니다.

```javascript
// packages/react-reconciler/src/ReactFiberCompleteWork.js (개념적 흐름)

function completeWork(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
): Fiber | null {
  switch (workInProgress.tag) {
    case HostComponent: {
      const type = workInProgress.type;
      if (current !== null && workInProgress.stateNode != null) {
        // ── 업데이트 경로 ──
        // prepareUpdate: oldProps vs newProps 비교 → updatePayload 반환
        const updatePayload = prepareUpdate(
          instance, type, oldProps, newProps, rootContainerInstance,
        );
        // updatePayload는 [key, value, key, value, ...] 형태의 배열
        // 예: ['className', 'new-class', 'style', {color: 'red'}]
        workInProgress.updateQueue = updatePayload;
        if (updatePayload !== null) {
          markUpdate(workInProgress); // Update flag 설정
        }
      } else {
        // ── 마운트 경로 ──
        // 실제 DOM 노드 생성
        const instance = createInstance(
          type, newProps, rootContainerInstance, currentHostContext, workInProgress,
        );
        // 이미 완성된 자식 DOM 노드들을 부모 DOM 노드에 조립
        // (completeWork는 아래에서 위로 실행되므로 자식이 먼저 완성됨)
        appendAllChildren(instance, workInProgress, false, false);
        workInProgress.stateNode = instance;
        // 초기 DOM 프로퍼티 설정 (style, className, event listeners 등)
        finalizeInitialChildren(instance, type, newProps, rootContainerInstance);
      }
      // subtreeFlags 버블링
      bubbleProperties(workInProgress);
      break;
    }
    case HostText: {
      // 텍스트 노드 생성
      workInProgress.stateNode = createTextInstance(newText, ...);
      bubbleProperties(workInProgress);
      break;
    }
    // ... 다른 태그들
  }
}

function bubbleProperties(completedWork: Fiber) {
  let subtreeFlags = NoFlags;
  let newChildLanes = NoLanes;
  let child = completedWork.child;

  while (child !== null) {
    // 자식의 subtreeFlags와 flags를 부모로 버블링
    subtreeFlags |= child.subtreeFlags;
    subtreeFlags |= child.flags;
    newChildLanes = mergeLanes(newChildLanes, mergeLanes(child.lanes, child.childLanes));
    child = child.sibling;
  }

  completedWork.subtreeFlags |= subtreeFlags;
  completedWork.childLanes = newChildLanes;
}
```

`completeWork`에서 생성된 DOM 노드가 **아직 실제 DOM 트리에 삽입되지 않는다**는 점이 핵심입니다. 메모리상에 완전한 DOM 서브트리가 조립되지만, 화면에는 반영되지 않습니다. 이것이 Render Phase(순수 계산)와 Commit Phase(부수효과 실행)를 물리적으로 나누는 경계입니다.

---

## 11. UpdateQueue: 원형 연결 리스트의 실제 구현

`setState` 호출이 실제로 어떻게 큐에 삽입되는지 추적합니다.

### UpdateQueue 타입 구조

```javascript
// packages/react-reconciler/src/ReactFiberClassUpdateQueue.js

type SharedQueue<State> = {
  pending: Update<State> | null,  // 원형 연결 리스트의 tail 포인터
  lanes: Lanes,
  hiddenCallbacks: Array<() => mixed> | null,
};

type UpdateQueue<State> = {
  baseState: State,                   // 이전 렌더에서 확정된 상태값 (reduce 시작점)
  firstBaseUpdate: Update<State> | null, // 건너뛴 업데이트 체인 시작
  lastBaseUpdate: Update<State> | null,  // 건너뛴 업데이트 체인 끝
  shared: SharedQueue<State>,         // current/workInProgress 간 공유
  callbacks: Array<() => mixed> | null,
};

type Update<State> = {
  lane: Lane,           // 이 업데이트의 우선순위
  tag: 0 | 1 | 2 | 3,  // UpdateState | ReplaceState | ForceUpdate | CaptureUpdate
  payload: any,
  callback: (() => mixed) | null,
  next: Update<State> | null, // 연결 리스트의 다음 노드
};
```

### enqueueUpdate: 왜 원형 연결 리스트인가

```javascript
// packages/react-reconciler/src/ReactFiberClassUpdateQueue.js

export function enqueueUpdate<State>(
  fiber: Fiber,
  update: Update<State>,
  lane: Lane,
): FiberRoot | null {
  const updateQueue = fiber.updateQueue;
  if (updateQueue === null) return null; // unmounted fiber

  const sharedQueue: SharedQueue<State> = updateQueue.shared;
  const pending = sharedQueue.pending;

  if (pending === null) {
    // 첫 번째 업데이트: 자기 자신을 가리켜 원형 구조 형성
    update.next = update;             // U1 → U1 (자기 참조)
  } else {
    // 기존 tail의 next는 현재 head를 가리킴
    // 새 업데이트를 tail과 head 사이에 삽입
    update.next = pending.next;       // newUpdate → head
    pending.next = update;            // 기존 tail → newUpdate
  }
  sharedQueue.pending = update;       // pending은 항상 최신(tail)을 가리킴

  return markUpdateLaneFromFiberToRoot(fiber, lane);
}
```

왜 head 없이 tail(`pending`)만 저장하는가?

```
tail(pending) 하나로 O(1) 접근:
  head = tail.next  (tail의 next가 항상 head를 가리킴)
  새 업데이트 삽입: tail.next = newUpdate (head 앞에 삽입), pending = newUpdate

삽입 전: pending→U3→U1→U2→U3 (U3이 tail, U1이 head)
새 U4 삽입:
  U4.next = pending.next = U1  (U4가 새 head 직전)
  pending.next = U4            (U3이 U4를 가리킴)
  pending = U4                 (U4가 새 tail)
삽입 후: pending→U4→U1→U2→U3→U4 (원형)
```

### processUpdateQueue: Lane 우선순위로 필터링하는 reduce

```javascript
export function processUpdateQueue<State>(
  workInProgress: Fiber,
  props: any,
  instance: any,
  renderLanes: Lanes,
): void {
  const queue: UpdateQueue<State> = workInProgress.updateQueue;

  // 1단계: pending 원형 리스트를 잘라서 baseQueue 끝에 연결
  let pendingQueue = queue.shared.pending;
  if (pendingQueue !== null) {
    queue.shared.pending = null;

    // 원형을 선형으로 변환
    const lastPendingUpdate = pendingQueue;           // tail
    const firstPendingUpdate = lastPendingUpdate.next; // head = tail.next
    lastPendingUpdate.next = null;                     // 원형 끊기

    // baseQueue 끝에 append
    if (queue.lastBaseUpdate === null) {
      queue.firstBaseUpdate = firstPendingUpdate;
    } else {
      queue.lastBaseUpdate.next = firstPendingUpdate;
    }
    queue.lastBaseUpdate = lastPendingUpdate;

    // current fiber에도 동기화 (렌더 중 인터럽트 대비)
    const current = workInProgress.alternate;
    if (current !== null) {
      // current도 동일하게 업데이트 (생략)
    }
  }

  // 2단계: baseState에서 시작하여 각 업데이트를 순서대로 reduce
  if (queue.firstBaseUpdate !== null) {
    let newState = queue.baseState;    // reduce 초기값
    let newFirstBaseUpdate = null;     // 건너뛴 업데이트의 시작
    let newLastBaseUpdate = null;
    let newBaseState = null;

    let update = queue.firstBaseUpdate;
    do {
      const updateLane = update.lane;

      if (!isSubsetOfLanes(renderLanes, updateLane)) {
        // ── 낮은 우선순위: 이 업데이트 건너뜀 ──
        if (newLastBaseUpdate === null) {
          // 처음으로 건너뛰는 업데이트 → 이 시점의 상태를 스냅샷
          newFirstBaseUpdate = update;
          newBaseState = newState; // 다음 렌더 시작점
        }
        // 건너뛴 업데이트를 baseQueue에 복사 (다음 렌더에서 재처리)
        newLastBaseUpdate = /* clone of update */;
      } else {
        // ── 높은 우선순위: 처리 ──
        if (newLastBaseUpdate !== null) {
          // 이미 건너뛴 게 있다면 이 업데이트도 baseQueue에 복사
          // (순서 의존성 보장: B를 건너뛴 후 C를 적용하면 중간 상태가 달라짐)
          newLastBaseUpdate = newLastBaseUpdate.next = /* clone with NoLane */;
        }
        // 실제 상태 계산
        newState = getStateFromUpdate(
          workInProgress, queue, update, newState, props, instance,
        );
      }

      update = update.next;
      if (update === null) break;
    } while (true);

    // 3단계: 결과 저장
    queue.baseState = newBaseState !== null ? newBaseState : newState;
    queue.firstBaseUpdate = newFirstBaseUpdate;
    queue.lastBaseUpdate = newLastBaseUpdate;
    workInProgress.memoizedState = newState; // 최종 상태 확정
  }
}
```

```
낮은 우선순위 업데이트를 baseQueue에 남기는 이유:

업데이트 순서: A(고), B(저), C(고)
1차 렌더 (고우선순위만):
  baseState = 0
  A 처리: newState = 1
  B 건너뜀: newBaseState = 1 스냅샷 저장, B를 baseQueue에 복사
  C 처리: newState = 3, C도 baseQueue에 복사(NoLane)
  memoizedState = 3, baseState = 1, baseQueue = [B, C(NoLane)]

2차 렌더 (저우선순위 포함):
  baseState = 1 (저장된 스냅샷)
  B 처리: newState = 1 + B = 결정론적 결과
  C 처리: newState = (1+B) + C = 최종 결정론적 결과

이렇게 해야 우선순위와 무관하게 최종 결과가 항상 동일함
```

---

## 12. Lane 할당 흐름: requestUpdateLane → ensureRootIsScheduled

### requestUpdateLane: 어떤 이벤트에 어떤 Lane인가

```javascript
// packages/react-reconciler/src/ReactFiberWorkLoop.js

export function requestUpdateLane(fiber: Fiber): Lane {
  const mode = fiber.mode;

  // 1. Legacy 모드 (ReactDOM.render — Concurrent 미지원)
  if ((mode & ConcurrentMode) === NoMode) {
    return (SyncLane: Lane);
  }

  // 2. Render Phase Update (렌더 도중 setState 호출)
  if (
    (executionContext & RenderContext) !== NoContext &&
    workInProgressRootRenderLanes !== NoLanes
  ) {
    return pickArbitraryLane(workInProgressRootRenderLanes);
  }

  // 3. startTransition 내부
  const isTransition = requestCurrentTransition() !== NoTransition;
  if (isTransition) {
    const actionScopeLane = peekEntangledActionLane();
    return actionScopeLane !== NoLane
      ? actionScopeLane          // Action scope가 있으면 그 lane 재사용
      : requestTransitionLane(); // 16개 Transition Lane 중 하나 순환 할당
  }

  // 4. React 이벤트 핸들러 내부 (ReactDOM이 설정한 우선순위)
  const updateLane: Lane = (getCurrentUpdatePriority(): any);
  if (updateLane !== NoLane) {
    return updateLane;
  }

  // 5. React 외부 (setTimeout, fetch callback 등)
  const eventLane: Lane = (getCurrentEventPriority(): any);
  return eventLane;
}
```

**이벤트별 Lane 할당:**

| 이벤트 컨텍스트 | Lane | 비트값 |
|---|---|---|
| `click`, `keydown`, `input`, `focus` | `SyncLane` | `0b0000001` |
| `mousemove`, `scroll`, `drag` | `InputContinuousLane` | `0b0000100` |
| `setTimeout`, `fetch` 콜백 | `DefaultLane` | `0b0010000` |
| `startTransition` 내부 | `TransitionLane1~16` | `0b1000000~` |
| `ReactDOM.createRoot()` 없는 Legacy | `SyncLane` (강제) | `0b0000001` |

### markUpdateLaneFromFiberToRoot: childLanes 버블링

```javascript
// packages/react-reconciler/src/ReactFiberConcurrentUpdates.js

function markUpdateLaneFromFiberToRoot(sourceFiber: Fiber, lane: Lane): void {
  // 업데이트 발생 Fiber의 lanes에 추가
  sourceFiber.lanes = mergeLanes(sourceFiber.lanes, lane);
  let alternate = sourceFiber.alternate;
  if (alternate !== null) {
    alternate.lanes = mergeLanes(alternate.lanes, lane);
  }

  // 부모 방향으로 올라가면서 childLanes 업데이트
  let node = sourceFiber.return;
  while (node !== null) {
    node.childLanes = mergeLanes(node.childLanes, lane);
    if (node.alternate !== null) {
      node.alternate.childLanes = mergeLanes(node.alternate.childLanes, lane);
    }
    node = node.return;
  }
}
```

```
버블링 시각화:
  [HostRoot]   childLanes: SyncLane 추가됨
      └─[App]      childLanes: SyncLane 추가됨
          └─[Main]     childLanes: SyncLane 추가됨
              └─[Counter]  lanes: SyncLane (setState 호출)

이 버블링 덕분에 beginWork에서
  includesSomeLane(renderLanes, workInProgress.childLanes)
이 false이면 해당 서브트리 전체를 bailout할 수 있음
```

### ensureRootIsScheduled: Scheduler에 작업 등록

```javascript
function ensureRootIsScheduled(root: FiberRoot): void {
  const nextLanes = getNextLanes(root, ...);
  if (nextLanes === NoLanes) {
    // 처리할 것 없음 → 기존 스케줄 취소
    if (existingCallbackNode !== null) cancelCallback(existingCallbackNode);
    return;
  }

  const newCallbackPriority = getHighestPriorityLane(nextLanes);

  // 기존 스케줄과 우선순위가 같으면 재사용
  if (existingCallbackPriority === newCallbackPriority) return;

  if (existingCallbackNode != null) cancelCallback(existingCallbackNode);

  let newCallbackNode;
  if (newCallbackPriority === SyncLane) {
    // SyncLane → 마이크로태스크 큐에 등록
    scheduleSyncCallback(performSyncWorkOnRoot.bind(null, root));
    scheduleMicrotask(flushSyncCallbacks); // queueMicrotask 사용
    newCallbackNode = null;
  } else {
    // 그 외 → Scheduler에 등록 (Lane → Scheduler 우선순위 변환)
    let schedulerPriorityLevel;
    switch (lanesToEventPriority(nextLanes)) {
      case DiscreteEventPriority:   // SyncLane
        schedulerPriorityLevel = ImmediateSchedulerPriority; break;
      case ContinuousEventPriority: // InputContinuousLane
        schedulerPriorityLevel = UserBlockingSchedulerPriority; break;
      case DefaultEventPriority:    // DefaultLane
        schedulerPriorityLevel = NormalSchedulerPriority; break;
      case IdleEventPriority:
        schedulerPriorityLevel = IdleSchedulerPriority; break;
    }
    newCallbackNode = scheduleCallback(
      schedulerPriorityLevel,
      performConcurrentWorkOnRoot.bind(null, root),
    );
  }

  root.callbackPriority = newCallbackPriority;
  root.callbackNode = newCallbackNode;
}
```

---

## 13. performConcurrentWorkOnRoot: 완료 상태별 처리

```javascript
// packages/react-reconciler/src/ReactFiberWorkLoop.js

function performConcurrentWorkOnRoot(
  root: FiberRoot,
  didTimeout: boolean,
): RenderTaskFn | null {

  // 1. 처리할 Lane 결정
  const lanes = getNextLanes(root, ...);
  if (lanes === NoLanes) return null;

  // 2. Time Slicing 여부 결정
  const shouldTimeSlice =
    !includesBlockingLane(root, lanes) && // SyncLane/InputContinuousLane/DefaultLane 없음
    !includesExpiredLane(root, lanes) &&  // 만료된 lane 없음
    !didTimeout;                          // Scheduler 타임아웃 아님

  // 3. 렌더 실행
  let exitStatus = shouldTimeSlice
    ? renderRootConcurrent(root, lanes)  // 인터럽트 가능
    : renderRootSync(root, lanes);       // 블로킹

  // 4. 완료 상태별 처리
  if (exitStatus !== RootInProgress) {

    if (exitStatus === RootErrored) {
      // 에러 → 동기로 재시도 (Error Boundary 탐색)
      exitStatus = recoverFromConcurrentError(root, ...);
    }

    if (exitStatus === RootFatalErrored) {
      throw workInProgressRootFatalError;
    }

    if (exitStatus === RootDidNotComplete) {
      // Suspense에 의한 중단 (데이터 대기)
      markRootSuspended(root, lanes, workInProgressDeferredLane);
    } else {
      // RootCompleted: 렌더 완료 → Commit Phase 진입
      const finishedWork = root.current.alternate;
      root.finishedWork = finishedWork;
      root.finishedLanes = lanes;
      finishConcurrentRender(root, exitStatus, finishedWork, lanes);
    }
  }

  // 5. 추가 작업 있으면 다시 스케줄
  ensureRootIsScheduled(root);
  return getContinuationForRoot(root, originalCallbackNode);
}
```

**완료 상태별 처리:**

| ExitStatus | 처리 방식 |
|---|---|
| `RootInProgress (0)` | Time slice 완료, 다음 프레임에서 재개 |
| `RootCompleted (5)` | Commit Phase 진입 |
| `RootSuspended (3)` | Suspense fallback, Promise resolve 대기 |
| `RootErrored (1)` | 동기 재시도 → Error Boundary |
| `RootFatalErrored (2)` | 앱 전체 크래시 |
| `RootDidNotComplete (6)` | Offscreen 작업 불완전 |

---

## 14. 더블 버퍼링: GPU에서 빌려온 설계

Fiber 아키텍처에서 가장 우아한 설계 중 하나입니다. GPU 렌더링에서 더블 버퍼링은 화면 깜빡임을 방지합니다. 모니터가 표시 중인 **Front Buffer**와 GPU가 다음 프레임을 렌더링하는 **Back Buffer**가 존재하고, V-Sync 시점에 포인터를 교체합니다.

React는 이 원리를 Fiber 트리에 적용합니다.

```
┌─────────────────────┐     alternate     ┌─────────────────────┐
│   current 트리       │◄────────────────►│  workInProgress 트리  │
│   (화면에 보이는 것)  │                   │  (다음 상태를 계산 중)│
│                      │                   │                      │
│   FiberRoot          │                   │                      │
│   └── App            │                   │   └── App'           │
│       ├── Header     │                   │       ├── Header'    │
│       ├── Main       │                   │       ├── Main'      │
│       └── Footer     │                   │       └── Footer'    │
└─────────────────────┘                   └─────────────────────┘

        ▲ FiberRoot.current (이 포인터 하나가 "현재 트리"를 결정)
```

커밋이 완료되면 `FiberRoot.current` 포인터를 workInProgress 트리로 교체합니다. **포인터 교체 한 번으로 전체 트리가 전환됩니다.** GPU의 버퍼 스왑과 정확히 같은 원리입니다.

### createWorkInProgress: 객체 재사용의 실제 구현

```javascript
// packages/react-reconciler/src/ReactFiber.js

export function createWorkInProgress(current: Fiber, pendingProps: any): Fiber {
  let workInProgress = current.alternate;

  if (workInProgress === null) {
    // 최초에만 새 객체 생성
    workInProgress = createFiber(
      current.tag, pendingProps, current.key, current.mode,
    );
    workInProgress.elementType = current.elementType;
    workInProgress.type = current.type;
    workInProgress.stateNode = current.stateNode; // DOM 노드 공유!

    // 쌍방 alternate 연결
    workInProgress.alternate = current;
    current.alternate = workInProgress;
  } else {
    // 이후에는 재사용하며 필드만 갱신 (GC 압력 최소화)
    workInProgress.pendingProps = pendingProps;
    workInProgress.type = current.type;
    workInProgress.flags = NoFlags;       // 이펙트 플래그 초기화
    workInProgress.subtreeFlags = NoFlags;
    workInProgress.deletions = null;
  }

  // current에서 복사
  workInProgress.flags = current.flags & StaticMask;
  workInProgress.childLanes = current.childLanes;
  workInProgress.lanes = current.lanes;
  workInProgress.child = current.child;
  workInProgress.memoizedProps = current.memoizedProps;
  workInProgress.memoizedState = current.memoizedState;
  workInProgress.updateQueue = current.updateQueue;
  workInProgress.dependencies = current.dependencies;

  return workInProgress;
}
```

객체를 재사용하는 이유는 V8 GC 압력 최소화(자세한 내용은 [16절](#16-v8-엔진-최적화))와 렌더 간 bailout 비교(`alternate`의 `memoizedProps`와 비교)를 위해서입니다.

---

## 15. Commit Phase: 3단계의 실제 작업

Commit Phase는 절대 중단되지 않습니다. GPU의 버퍼 스왑이 원자적이어야 하는 것과 같습니다.

### 3단계 구조

```javascript
// packages/react-reconciler/src/ReactFiberCommitWork.js (개념적 흐름)

function commitRoot(root: FiberRoot, finishedWork: Fiber) {

  // ─── 1단계: Before Mutation ───
  // DOM이 변경되기 전의 스냅샷을 읽는 단계
  commitBeforeMutationEffects(root, finishedWork);
  // - ClassComponent: getSnapshotBeforeUpdate() 호출
  // - useInsertionEffect cleanup 실행 (CSS-in-JS 준비)

  // ─── 버퍼 스왑 (Mutation Phase 중간) ───
  root.current = finishedWork; // ← 여기서 current 트리가 전환됨!

  // ─── 2단계: Mutation ───
  // 실제 DOM 변경
  commitMutationEffects(root, finishedWork);
  // - Placement: DOM 노드 삽입 (insertBefore/appendChild)
  // - Update: DOM 프로퍼티 갱신 (updatePayload 적용)
  // - Deletion: DOM 노드 제거, ref 해제, componentWillUnmount
  // - useInsertionEffect callback (CSS-in-JS 스타일 주입)

  // ─── 3단계: Layout ───
  // DOM이 변경된 직후, 브라우저 페인트 전
  commitLayoutEffects(root, finishedWork);
  // - ClassComponent: componentDidMount/Update 호출
  // - useLayoutEffect cleanup, callback 실행
  // - ref 갱신 (ref.current = DOM 노드)

  // ─── Passive Effects (비동기) ───
  // 브라우저 페인트 이후
  scheduleCallback(NormalPriority, () => {
    flushPassiveEffects(); // useEffect cleanup → useEffect callback
  });
}
```

### commitMutationEffects: DOM 변경의 실제 작업

```javascript
// Placement: 새 DOM 노드 삽입
function commitPlacement(finishedWork: Fiber): void {
  const parentFiber = getHostParentFiber(finishedWork);
  const parentStateNode = parentFiber.stateNode;

  // before 노드를 찾아 insertBefore vs appendChild 결정
  const before = getHostSibling(finishedWork);
  if (before !== null) {
    // 특정 위치에 삽입
    parent.insertBefore(getPublicInstance(stateNode), before);
  } else {
    // 끝에 추가
    parent.appendChild(getPublicInstance(stateNode));
  }
}

// Update: DOM 프로퍼티 갱신
function commitUpdate(
  domElement: Element,
  updatePayload: Array<mixed>,
  type: string,
  oldProps: Props,
  newProps: Props,
): void {
  // updatePayload는 [key, value, key, value, ...] 형태
  // completeWork의 prepareUpdate/diffProperties가 생성한 diff
  updateProperties(domElement, updatePayload, type, oldProps, newProps);
}

// updateDOMProperties: updatePayload 배열을 순회하며 DOM 적용
function updateDOMProperties(
  domElement: Element,
  updatePayload: Array<any>,
  wasCustomComponentTag: boolean,
  isCustomComponentTag: boolean,
): void {
  for (let i = 0; i < updatePayload.length; i += 2) {
    const propKey = updatePayload[i];    // 짝수 인덱스: key
    const propValue = updatePayload[i + 1]; // 홀수 인덱스: value

    if (propKey === STYLE) {
      setValueForStyles(domElement, propValue, ...);
    } else if (propKey === CHILDREN) {
      setTextContent(domElement, propValue);
    } else {
      setValueForProperty(domElement, propKey, propValue, isCustomComponentTag);
    }
  }
}
```

### useInsertionEffect가 Mutation Phase에 있는 이유

`useInsertionEffect`는 CSS-in-JS 라이브러리를 위해 설계되었습니다. DOM 변경이 일어나는 Mutation Phase 내부에서, 그러나 `useLayoutEffect`보다 먼저 실행됩니다.

```
Commit Phase 타이밍:

Before Mutation:
  → getSnapshotBeforeUpdate()
  → useInsertionEffect cleanup

Mutation:
  → useInsertionEffect callback   ← CSS-in-JS 스타일 주입 (DOM 읽기 전!)
  → DOM 삽입/갱신/삭제
  → ref 해제

Layout:
  → componentDidMount/Update
  → useLayoutEffect cleanup
  → useLayoutEffect callback      ← 스타일이 이미 주입된 후에 레이아웃 읽기
  → ref 갱신

브라우저 페인트

Passive:
  → useEffect cleanup
  → useEffect callback
```

`useInsertionEffect`가 없다면 `useLayoutEffect` 안에서 스타일을 주입하고 레이아웃을 읽는 작업이 섞여 **레이아웃 스래싱(Layout Thrashing)**이 발생합니다.

### FiberRoot.current 교체 시점

```
버퍼 스왑 타이밍:

Before Mutation Phase
  ↓ (여기까지 current = 이전 트리)
current.alternate = finishedWork (이미 완성)
root.current = finishedWork  ← 스왑! (Mutation Phase 시작 전)
  ↓ (이후 current = 새 트리)
Mutation Phase: DOM 변경

왜 Mutation 전에 스왑하는가?
componentWillUnmount, useEffect cleanup에서
this.state / state를 참조하면 새 상태를 보아야 하기 때문
```

---

## 16. V8 엔진 최적화와 FiberNode 설계

React의 FiberNode 설계에는 V8 엔진의 내부 동작에 대한 깊은 이해가 반영되어 있습니다.

### Hidden Classes(Shape)와 Inline Cache

V8은 JavaScript 객체의 구조를 추적하기 위해 **Hidden Class(Map/Shape)**를 사용합니다. 동일한 구조의 객체들은 동일한 Hidden Class를 공유하며, V8은 이를 통해 프로퍼티 접근을 최적화합니다.

```
Monomorphic (단형성): 가장 빠름
  모든 Fiber 객체가 동일한 Hidden Class
  → Inline Cache가 항상 히트
  → V8 TurboFan이 프로퍼티 접근 코드를 직접 인라인

Polymorphic (다형성): 느림
  2~4개의 다른 Hidden Class
  → Inline Cache가 여러 케이스를 확인

Megamorphic: 가장 느림 (5개 이상의 Hidden Class)
  → Inline Cache 비활성화
  → 매번 전체 lookup 수행
```

FiberNode 생성자에서 **모든 필드를 반드시 동일한 순서로 초기화**하는 이유가 여기에 있습니다. 필드 초기화 순서가 다르면 V8이 다른 Hidden Class를 생성하고, Fiber 객체들이 서로 다른 Hidden Class를 갖게 됩니다.

### V8 성능 절벽 실제 사례

2019년 V8 팀은 ["The story of a V8 performance cliff in React"](https://v8.dev/blog/react-cliff)라는 포스트에서 React FiberNode 관련 실제 성능 문제를 공개했습니다.

문제의 원인은 FiberNode의 타임스탬프 필드(`actualDuration`, `actualStartTime`)였습니다.

```javascript
// 문제가 된 코드:
function FiberNode(...) {
  // ...
  this.actualDuration = 0;     // V8: Smi(Small Integer)로 표현
  this.actualStartTime = -1;   // V8: Smi로 표현
  // ...
}

// 나중에 렌더링 시:
fiber.actualStartTime = performance.now(); // → 부동소수점! Double로 전환
```

**Smi**(Small Integer)에서 **Double**(부동소수점)으로 타입이 변환되면 V8은 Hidden Class를 변경해야 합니다. 이때 `Object.preventExtensions()`가 걸려 있으면 **고아 Hidden Class(orphaned shape)**가 생성됩니다.

```
수십만 개의 FiberNode가 각자 다른 Hidden Class를 갖게 됨:

fiberNode1: HiddenClass_A (actualStartTime: Smi)
  → actualStartTime = performance.now()
  → HiddenClass_B (actualStartTime: Double)  ← 고아!

fiberNode2: HiddenClass_A (actualStartTime: Smi)
  → actualStartTime = performance.now()
  → HiddenClass_C (actualStartTime: Double)  ← 또 다른 고아!

fiberNode1과 fiberNode2가 다른 Hidden Class를 가짐
→ Polymorphic → Megamorphic → Inline Cache 비활성화
```

**해결책:** 처음부터 Double 표현으로 강제 초기화.

```javascript
// 수정된 코드:
function FiberNode(...) {
  // 처음부터 NaN으로 초기화 → V8이 즉시 Double 표현으로 설정
  this.actualDuration = Number.NaN;  // Double (부동소수점)
  this.actualStartTime = Number.NaN; // Double
  // 나중에 실제 값 할당해도 Hidden Class 변경 없음
}
```

이 수정으로 React는 유의미한 성능 향상을 얻었습니다.

### Fiber 객체 재사용과 GC 압력

```javascript
// createWorkInProgress: 새 객체 생성 대신 alternate 재사용
if (workInProgress === null) {
  // 최초에만 새 객체 생성
  workInProgress = createFiber(...);
} else {
  // 이후에는 기존 객체 재사용, 필드만 초기화
  workInProgress.pendingProps = pendingProps;
  workInProgress.flags = NoFlags;
  // ...
}
```

매 렌더마다 수천 개의 Fiber 객체를 새로 만들면 V8 Young Generation에 단명 객체가 쏟아져 Minor GC가 빈번하게 발동합니다. 재사용하면 이 객체들이 Old Generation으로 승격되어 GC 압력이 크게 줄어듭니다.

---

## 17. Concurrent Features의 근원

지금까지 살펴본 Fiber의 구조적 특성들이 합쳐져서 React의 Concurrent Features를 가능하게 합니다.

### startTransition: 우선순위 분기의 실체

```javascript
// startTransition 내부에서 발생한 업데이트는 TransitionLane으로 마크됨
startTransition(() => {
  setResults(search(query)); // TransitionLane 할당
});
setQuery(input); // SyncLane 할당 (이벤트 핸들러)
```

Work Loop는 항상 가장 높은 우선순위 Lane을 먼저 처리합니다. TransitionLane 렌더 중 새로운 SyncLane 업데이트가 들어오면:

1. 현재 진행 중인 TransitionLane 작업 **중단** (`shouldYield()` 반환)
2. SyncLane 작업 **즉시 처리** (키 입력 반영)
3. TransitionLane 작업 **재개** (처음부터 새 상태 기준으로)

```
startTransition 우선순위 선점 타임라인

시간 →    0ms       5ms      10ms      15ms      20ms
          │         │        │         │         │
SyncLane  │         │        │◄─키입력─►│         │
          │         │        │[즉시처리] │         │
TransLane │[렌더시작 │[계속...]│ 중단!    │[재개...] │ 완료
          │         │        │         │         │
화면      │ fallback │fallback │ 키반영   │ 부분결과  │ 최종결과
```

### Suspense: throw와 catch의 재해석

```
try-catch                          Suspense
─────────────────────              ──────────────────────────
try { } 블록                        <Suspense> 하위 트리
throw new Error()                  throw Promise
콜 스택 위로 전파                     return 포인터 따라 위로 전파
catch 블록 탐색                       가장 가까운 SuspenseComponent Fiber 탐색
catch 내 대체 코드                   fallback prop 렌더링
```

Promise가 throw되면 React는 `return` 포인터를 따라 올라가면서 가장 가까운 `SuspenseComponent` Fiber를 찾습니다. 이 Fiber의 `fallback`을 대신 렌더하고, Promise가 resolve되면 원래 서브트리를 다시 시도합니다(`suspendedLanes → pendingLanes`).

### Render Phase의 순수성

Fiber 아키텍처에서 Render Phase는 **순수 계산**이어야 합니다. 이유는 단순합니다: Render Phase는 중단되고 재시작될 수 있기 때문입니다. 이전 렌더에서 이미 부수효과를 실행했다면 상태가 꼬입니다.

```
함수형 프로그래밍과의 대응:

Render Phase  =  순수 함수       (부수효과 없이 트리만 계산)
Commit Phase  =  IO Monad 실행   (DOM 변경, useEffect 호출, ref 갱신)
```

`React.StrictMode`가 개발 모드에서 컴포넌트를 의도적으로 두 번 렌더하는 것은, 이 순수성을 위반하는 코드를 조기에 발견하기 위함입니다.

---

## 18. 전체 흐름: 업데이트에서 화면까지

```
사용자 click → setState() 호출
    │
    ▼
[1. Lane 할당]
    requestUpdateLane(fiber)
    → click 이벤트: SyncLane
    → startTransition: TransitionLane
    │
    ▼
[2. UpdateQueue 등록]
    enqueueUpdate(fiber, update, lane)
    → shared.pending 원형 연결 리스트에 O(1) 삽입
    │
    ▼
[3. childLanes 버블링]
    markUpdateLaneFromFiberToRoot(fiber, lane)
    → fiber.lanes, 부모들의 childLanes에 lane 추가
    │
    ▼
[4. Scheduler 등록]
    ensureRootIsScheduled(root)
    → SyncLane: queueMicrotask(flushSyncCallbacks)
    → TransitionLane: scheduleCallback(Normal, performConcurrentWorkOnRoot)
    │
    ▼
[5. performConcurrentWorkOnRoot]
    getNextLanes → shouldTimeSlice 판단
    → renderRootSync / renderRootConcurrent 선택
    │
    ▼
[6. Render Phase — beginWork 하강]
    HostRoot에서 시작
    props/lanes/context 변경 없음 → bailoutOnAlreadyFinishedWork (서브트리 스킵)
    FunctionComponent → renderWithHooks → useState/useEffect hooks 실행
    → reconcileChildren → 자식 Fiber 생성/재사용 (2패스 diff)
    │
    ├── shouldYield() === true → 중단, 나중에 재개 (TransitionLane만)
    │
    ▼
[7. Render Phase — completeWork 상승]
    HostComponent: DOM 인스턴스 생성 (메모리상, 미삽입)
    appendAllChildren: 자식 DOM 노드 조립
    subtreeFlags 버블링
    processUpdateQueue: baseState에서 reduce, lane 우선순위 필터링
    │
    ▼
[8. finishedWork 저장]
    root.finishedWork = workInProgress 트리 루트
    │
    ▼
[9. Commit Phase — 동기, 절대 중단 불가]
    Before Mutation: getSnapshotBeforeUpdate, useInsertionEffect cleanup
    root.current = finishedWork  ← 버퍼 스왑 (current 트리 교체!)
    Mutation: subtreeFlags 기반 변경된 노드만 순회
              commitPlacement/Update/Deletion → DOM 변경
    Layout: componentDidMount/Update, useLayoutEffect, ref 갱신
    │
    ▼
[10. Passive Effects — 비동기]
    scheduleCallback(Normal, flushPassiveEffects)
    → useEffect cleanup
    → useEffect callback
    │
    ▼
    화면 갱신 완료
```

---

## 이것이 왜 중요한가

Fiber 아키텍처를 소스 코드 수준에서 이해하면 React의 다양한 동작이 명확해집니다.

**`React.memo`의 bailout:** `updateSimpleMemoComponent`에서 `shallowEqual` 비교 후 `checkScheduledUpdateOrContext`를 호출합니다. props가 같아도 Context나 `setState`로 인한 업데이트가 있으면 bailout되지 않습니다.

**`key`의 진짜 역할:** `reconcileChildrenArray`의 2패스 알고리즘에서 key 없이는 인덱스를 key로 사용합니다. 중간 삽입/삭제 시 모든 인덱스가 밀려 Map 탐색에서 재사용이 불가합니다.

**`useLayoutEffect` vs `useEffect` 타이밍:** Layout Effects는 Commit Phase의 Layout 단계에서 동기 실행됩니다. Passive Effects는 별도의 스케줄러 콜백으로 브라우저 페인트 이후에 실행됩니다. 레이아웃 읽기(`getBoundingClientRect`)는 `useLayoutEffect`에서만 정확합니다.

**`startTransition`이 입력 응답성을 개선하는 방법:** TransitionLane으로 마크된 렌더는 `workLoopConcurrent`를 통해 5ms마다 양보합니다. 그 사이에 들어오는 SyncLane 이벤트(키 입력)가 즉시 처리됩니다.

**`Suspense`의 작동 원리:** Promise를 throw하면 `return` 포인터를 따라 가장 가까운 SuspenseComponent Fiber를 찾는 구조는, Fiber 트리가 연결 리스트로 구성되어 있기 때문에 가능합니다.

Fiber는 React의 추상화 계층에서 "개발자가 선언한 의도"와 "브라우저가 실행하는 현실" 사이를 잇는 다리입니다. 이 다리의 구조를 이해하면, 그 위를 걷는 코드를 더 정확하게 작성할 수 있습니다.

---

## 다음 편 예고: Hooks, 연결 리스트 위의 마법

이 글에서 우리는 Fiber 노드의 `memoizedState`가 Hook 연결 리스트의 헤드를 가리킨다는 것을 확인했습니다. 그리고 `UpdateQueue`의 원형 연결 리스트가 `processUpdateQueue`에서 어떻게 처리되는지도 살펴봤습니다.

다음 편에서는 **Hooks 시스템**의 내부로 들어갑니다. `useState`를 호출하면 Dispatcher가 어떻게 교체되는지, Mount와 Update에서 서로 다른 구현체(`mountState` vs `updateState`)가 왜 필요한지, Eager State 최적화가 실제로 어떻게 작동하는지, 그리고 `useEffect`의 의존성 배열 비교가 어떤 시점에 어떻게 이루어지는지를 소스 코드 수준에서 추적합니다.

---

> **React 아키텍처 심층 분석 시리즈**
> 1. [패키지 계층 구조](react-architecture-01-package-structure.md)
> 2. **Fiber 아키텍처** ← 현재 글
> 3. Hooks 시스템
> 4. Lane 스케줄링
> 5. 렌더링 사이클
> 6. Commit Phase
> 7. Suspense & Error Boundary
> 8. Server-Side Rendering
> 9. Hydration 시스템
> 10. Core Types & Concepts
> 11. Host Configuration
> 12. React DOM Renderer
> 13. Other Renderers
> 14. DevTools Architecture

---

*작성일: 2026-02-20*
*참조: React 소스 코드 (v19), packages/react-reconciler/src/, V8 블로그 "The story of a V8 performance cliff in React"*
