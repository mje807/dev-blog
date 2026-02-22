# React 아키텍처 심층 분석 (6/14): Commit Phase — DOM을 확정하는 원자적 단계

> **React 아키텍처 심층 분석** 시리즈의 여섯 번째 글입니다. [5편](./react-architecture-05-rendering-cycle.md)에서 Render Phase가 Fiber 트리를 순회하며 변경 사항을 계산하는 과정을 추적했습니다. 이번 편에서는 그 계산 결과를 **실제 세계(DOM)에 되돌릴 수 없이 반영**하는 Commit Phase를 완전히 해부합니다. 더블 버퍼링 포인터 교체의 정밀한 타이밍, useLayoutEffect와 useEffect가 브라우저 paint와 맺는 관계, 삭제된 Fiber의 메모리 해제, 그리고 Commit 중 에러를 처리하는 방어 로직까지 — `ReactFiberCommitWork.js`와 `ReactFiberWorkLoop.js`의 실제 코드를 라인 단위로 추적합니다.

> **참조 소스**: `react-dom@18.3.1 (react-dom.development.js)`, `packages/react-reconciler/src/ReactFiberCommitWork.js`, `packages/react-reconciler/src/ReactFiberWorkLoop.js`

---

## 목차

1. [commitRoot의 전체 구조 — 5단계 파이프라인](#1-commitroot의-전체-구조--5단계-파이프라인)
2. [더블 버퍼링과 FiberRoot.current 교체 타이밍](#2-더블-버퍼링과-fiberrootcurrent-교체-타이밍)
3. [Before Mutation Phase — 변경 직전 스냅샷](#3-before-mutation-phase--변경-직전-스냅샷)
4. [Mutation Phase — DOM의 실제 변경](#4-mutation-phase--dom의-실제-변경)
5. [Layout Phase — 동기 Effect 실행](#5-layout-phase--동기-effect-실행)
6. [브라우저 Paint와 useLayoutEffect/useEffect의 관계](#6-브라우저-paint와-uselayouteffectuseeffect의-관계)
7. [Passive Effects — 비동기 배치 처리](#7-passive-effects--비동기-배치-처리)
8. [commitLayoutEffects에서 setState 동기 처리](#8-commitlayouteffects에서-setstate-동기-처리)
9. [detachFiberAfterEffects — 메모리 관리](#9-detachfiberaftereffects--메모리-관리)
10. [Error Handling in Commit Phase](#10-error-handling-in-commit-phase)
11. [Commit Phase 원자성의 보장 메커니즘](#11-commit-phase-원자성의-보장-메커니즘)
12. [전체 Commit Phase 흐름 종합](#12-전체-commit-phase-흐름-종합)

---

## 1. commitRoot의 전체 구조 — 5단계 파이프라인

### 1.1 commitRoot 진입점

Render Phase가 `RootCompleted` 상태로 종료되면 `performConcurrentWorkOnRoot`(또는 `performSyncWorkOnRoot`)가 `commitRoot`를 호출합니다.

```javascript
// packages/react-reconciler/src/ReactFiberWorkLoop.js

function commitRoot(
  root: FiberRoot,
  recoverableErrors: null | Array<CapturedValue<mixed>>,
  transitions: Array<Transition> | null,
) {
  // 현재 렌더 우선순위를 ImmediatePriority로 올려서 실행
  // Commit Phase는 중단 없이 반드시 완료되어야 하므로
  const previousUpdateLanePriority = getCurrentUpdatePriority();
  const prevTransition = ReactCurrentBatchConfig.transition;

  try {
    ReactCurrentBatchConfig.transition = null;
    setCurrentUpdatePriority(DiscreteEventPriority); // 최고 우선순위
    commitRootImpl(root, recoverableErrors, transitions, previousUpdateLanePriority);
  } finally {
    ReactCurrentBatchConfig.transition = prevTransition;
    setCurrentUpdatePriority(previousUpdateLanePriority);
  }
}
```

`DiscreteEventPriority`로 설정하는 이유: Commit 도중 발생하는 setState(componentDidMount 등)가 현재 Commit과 동기적으로 처리되어야 하기 때문입니다. Commit 중에 예약된 업데이트는 이 우선순위를 상속받아 Commit 직후 즉시 실행됩니다.

### 1.2 commitRootImpl의 정확한 단계 순서

```javascript
function commitRootImpl(root, recoverableErrors, transitions, renderPriorityLevel) {
  // ═══════════════════════════════════════════════════════
  // 0단계: 이전 Passive Effects 플러시 (있는 경우)
  // ═══════════════════════════════════════════════════════
  do {
    flushPassiveEffects();
  } while (rootWithPendingPassiveEffects !== null);
  // 이전 렌더 사이클의 useEffect가 아직 실행 안 됐으면 먼저 실행

  const finishedWork = root.finishedWork;
  const lanes = root.finishedLanes;

  if (finishedWork === null) return null; // 커밋할 작업 없음

  root.finishedWork = null;
  root.finishedLanes = NoLanes;
  root.callbackNode = null;
  root.callbackPriority = NoLane;

  // ═══════════════════════════════════════════════════════
  // subtreeFlags로 작업 존재 여부 사전 확인
  // ═══════════════════════════════════════════════════════
  const subtreeHasEffects =
    (finishedWork.subtreeFlags &
      (BeforeMutationMask | MutationMask | LayoutMask | PassiveMask)) !==
    NoFlags;
  const rootHasEffect =
    (finishedWork.flags &
      (BeforeMutationMask | MutationMask | LayoutMask | PassiveMask)) !==
    NoFlags;

  if (subtreeHasEffects || rootHasEffect) {
    // ─────────────────────────────────────────────────────
    // 1단계: Before Mutation
    // ─────────────────────────────────────────────────────
    const prevTransition = ReactCurrentBatchConfig.transition;
    const previousPriority = getCurrentUpdatePriority();
    try {
      ReactCurrentBatchConfig.transition = null;
      setCurrentUpdatePriority(DiscreteEventPriority);
      commitBeforeMutationEffects(root, finishedWork);
    } finally {
      ReactCurrentBatchConfig.transition = prevTransition;
      setCurrentUpdatePriority(previousPriority);
    }

    // ─────────────────────────────────────────────────────
    // 2단계: Mutation Phase
    // ─────────────────────────────────────────────────────
    commitMutationEffects(root, finishedWork, lanes);

    // ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★
    // FiberRoot.current 교체 — 가장 중요한 순간
    // Mutation 완료 + Layout 시작 사이의 단 하나의 라인
    // ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★
    root.current = finishedWork;

    // ─────────────────────────────────────────────────────
    // 3단계: Layout Phase
    // ─────────────────────────────────────────────────────
    commitLayoutEffects(finishedWork, root, lanes);

    // Layout 완료 후 스케줄러에 양보 신호
    requestPaint();

  } else {
    // 변경 사항 없음 — current만 교체
    root.current = finishedWork;
  }

  // ─────────────────────────────────────────────────────
  // 4단계: 후처리
  // ─────────────────────────────────────────────────────
  if (rootDoesHavePassiveEffects) {
    rootDoesHavePassiveEffects = false;
    rootWithPendingPassiveEffects = root;
    pendingPassiveEffectsLanes = lanes;
  }

  // ─────────────────────────────────────────────────────
  // 5단계: 남은 작업 스케줄링
  // ─────────────────────────────────────────────────────
  ensureRootIsScheduled(root, now());

  // Layout Effects에서 예약된 동기 업데이트 즉시 플러시
  if (includesSomeLane(pendingPassiveEffectsLanes, SyncLane)) {
    flushSyncCallbacks();
  }

  // ═══════════════════════════════════════════════════════
  // Passive Effects 비동기 스케줄링
  // ═══════════════════════════════════════════════════════
  scheduleCallback(NormalSchedulerPriority, () => {
    flushPassiveEffects();
    return null;
  });

  return null;
}
```

### 1.3 5단계 파이프라인 요약

```
commitRootImpl 실행 순서
─────────────────────────────────────────────────────────
0. 이전 Passive Effects 플러시 (flushPassiveEffects loop)
   ↓
1. Before Mutation Phase
   - getSnapshotBeforeUpdate 호출 (ClassComponent)
   - useEffect destroy 예약 확인
   ↓
2. Mutation Phase (DOM 실제 변경)
   - commitDeletion: 제거
   - commitPlacement: 삽입
   - commitUpdate: 속성 업데이트
   - useLayoutEffect destroy 실행 (업데이트 시)
   ↓
   ★ root.current = finishedWork (포인터 교체)
   ↓
3. Layout Phase
   - useLayoutEffect setup 실행
   - componentDidMount / componentDidUpdate 호출
   - ref 업데이트
   ↓
4. requestPaint() → 브라우저 paint 허용 신호
   ↓
5. scheduleCallback(NormalPriority, flushPassiveEffects)
   → useEffect 비동기 예약
─────────────────────────────────────────────────────────
```

---

## 2. 더블 버퍼링과 FiberRoot.current 교체 타이밍

### 2.1 finishedWork vs root.current

두 포인터가 가리키는 대상의 차이를 명확히 이해해야 합니다.

```
Render Phase 완료 시점:

FiberRoot
├── current ──────────────→ [이전 트리] (현재 화면에 표시 중)
│                           HostRoot
│                           ├── App (memoizedState: {count: 0})
│                           └── ...
│
└── finishedWork ─────────→ [새 트리] (WIP였던 트리)
                            HostRoot (WIP)
                            ├── App (memoizedState: {count: 1})
                            └── ...

각 WIP Fiber의 alternate → 이전 트리의 해당 Fiber
각 current Fiber의 alternate → 새 트리의 해당 Fiber
```

Render Phase 전체에서 `finishedWork`는 workInProgress 트리의 루트입니다. `root.current`는 여전히 이전 트리의 루트를 가리킵니다.

### 2.2 교체가 일어나는 정확한 위치

```javascript
// commitRootImpl 내부의 단 하나의 라인

commitMutationEffects(root, finishedWork, lanes);
//  ↑ Mutation 완료. DOM은 이미 새 상태를 반영함

root.current = finishedWork;
//  ↑ 바로 여기. 단 하나의 할당문.
//  이 라인 이전: root.current = 이전 트리
//  이 라인 이후: root.current = 새 트리

commitLayoutEffects(finishedWork, root, lanes);
//  ↑ Layout Effects 실행. 이 시점의 root.current는 새 트리
```

### 2.3 이 타이밍이 중요한 이유: componentDidMount에서 setState

교체 타이밍은 `componentDidMount`와 `componentDidUpdate`의 동작 방식과 직결됩니다.

```javascript
class MyComponent extends React.Component {
  componentDidMount() {
    // 이 호출은 Layout Phase (commitLayoutEffects 내부)
    this.setState({ loaded: true });
    // → scheduleUpdateOnFiber 호출
    // → root.current는 이미 finishedWork (새 트리)
    // → 새 트리의 MyComponent Fiber에 업데이트 등록
    // → commitRootImpl 완료 후 즉시 동기 재렌더
  }
}
```

만약 포인터 교체가 Layout Phase 이후에 일어났다면:

```
(잘못된 시나리오 — 실제와 다름)

Layout Phase에서 componentDidMount 실행
  → setState 호출
  → root.current가 여전히 이전 트리를 가리킴
  → 업데이트가 이전 트리의 Fiber에 등록됨
  → 재렌더 시 이미 화면에서 사라진 트리 기준으로 계산
  → 충돌 또는 잘못된 렌더
```

반대로 교체가 Mutation Phase 이전에 일어났다면:

```
(잘못된 시나리오 — 실제와 다름)

root.current = finishedWork (포인터 교체)
Mutation Phase 시작

commitDeletion(fiber)
  → fiber.alternate (이전 트리)를 기준으로 삭제 처리
  → 그런데 root.current가 이미 새 트리
  → componentWillUnmount가 "이전" 트리 기준으로 실행되어야 하는데
  → root.current를 따라가면 "새" 트리 도달 → 잘못된 컴포넌트 실행
```

**정리**: Mutation Phase 이후, Layout Phase 이전의 이 단 하나의 라인은 두 가지를 동시에 보장합니다:

1. Mutation Phase에서 이전 트리(`current`)와 새 트리(`finishedWork`)를 명확히 구분
2. Layout Phase에서 `setState` 등의 업데이트가 올바른 (새) 트리를 기준으로 등록

### 2.4 Mutation Phase 내에서 두 트리 구분

Mutation Phase는 포인터 교체 전에 실행되므로, 이 시점에서 `root.current`는 이전 트리입니다.

```javascript
// commitMutationEffects 내부 — 포인터 교체 전

function commitDeletionEffectsOnFiber(finishedRoot, nearestMountedAncestor, deletedFiber) {
  switch (deletedFiber.tag) {
    case ClassComponent: {
      // componentWillUnmount는 삭제 대상 컴포넌트에서 실행
      // deletedFiber.alternate = 이전 current 트리의 해당 Fiber
      // → "이전 화면"에서 마운트됐던 인스턴스를 올바르게 unmount
      safelyCallComponentWillUnmount(deletedFiber, nearestMountedAncestor, instance);
      break;
    }
    case FunctionComponent: {
      // useLayoutEffect의 destroy 실행
      // 이 시점에서 root.current = 이전 트리
      // → 이전 트리의 인스턴스를 기준으로 cleanup 실행 (올바른 동작)
      commitHookEffectListUnmount(HookLayout | HookHasEffect, deletedFiber, nearestMountedAncestor);
      break;
    }
  }
}
```

### 2.5 Layout Phase 내에서 새 트리 접근

포인터 교체 이후의 Layout Phase에서는 `root.current`가 새 트리를 가리킵니다.

```javascript
// commitLayoutEffects 내부 — 포인터 교체 후

function commitLifeCycles(finishedRoot, current, finishedWork, ...) {
  switch (finishedWork.tag) {
    case ClassComponent: {
      const instance = finishedWork.stateNode;

      if (current === null) {
        // 마운트: componentDidMount
        instance.componentDidMount();
        // 여기서 setState 호출 시:
        // → root.current = finishedWork (이미 교체됨)
        // → finishedWork의 Fiber에 업데이트 등록
        // → 새 트리 기준으로 재렌더 (올바른 동작)
      } else {
        // 업데이트: componentDidUpdate
        instance.componentDidUpdate(prevProps, prevState, instance.__reactInternalSnapshotBeforeUpdate);
      }
      break;
    }
  }
}
```

---

## 3. Before Mutation Phase — 변경 직전 스냅샷

### 3.1 commitBeforeMutationEffects

```javascript
// packages/react-reconciler/src/ReactFiberCommitWork.js

export function commitBeforeMutationEffects(root: FiberRoot, firstChild: Fiber) {
  // focusedInstanceHandle: 포커스 상태 보존을 위해 현재 포커스 기록
  focusedInstanceHandle = prepareForCommit(root.containerInfo);
  nextEffect = firstChild;

  commitBeforeMutationEffects_begin();

  const shouldFire = shouldFireAfterActiveInstanceBlur;
  shouldFireAfterActiveInstanceBlur = false;
  focusedInstanceHandle = null;

  return shouldFire;
}

function commitBeforeMutationEffects_begin() {
  while (nextEffect !== null) {
    const fiber = nextEffect;
    const deletions = fiber.deletions;

    if (deletions !== null) {
      for (let i = 0; i < deletions.length; i++) {
        const deletion = deletions[i];
        commitBeforeMutationEffectsDeletion(deletion);
        // → blur 이벤트 발생 처리 (포커스된 요소가 삭제되는 경우)
      }
    }

    const child = fiber.child;
    if (
      (fiber.subtreeFlags & BeforeMutationMask) !== NoFlags &&
      child !== null
    ) {
      child.return = fiber;
      nextEffect = child;
    } else {
      commitBeforeMutationEffects_complete();
    }
  }
}
```

### 3.2 commitBeforeMutationEffectsOnFiber

```javascript
function commitBeforeMutationEffectsOnFiber(finishedWork: Fiber) {
  const current = finishedWork.alternate;
  const flags = finishedWork.flags;

  if ((flags & Snapshot) !== NoFlags) {
    switch (finishedWork.tag) {
      case ClassComponent: {
        if (current !== null) {
          // 업데이트 경우만 getSnapshotBeforeUpdate 호출
          // 마운트에서는 호출 안 함
          const prevProps = current.memoizedProps;
          const prevState = current.memoizedState;
          const instance = finishedWork.stateNode;

          // ★ DOM 변경 직전에 스냅샷 캡처
          // 이 시점에서 DOM은 여전히 이전 상태
          const snapshot = instance.getSnapshotBeforeUpdate(
            finishedWork.elementType === finishedWork.type
              ? prevProps
              : resolveDefaultProps(finishedWork.type, prevProps),
            prevState,
          );

          // 스냅샷을 인스턴스에 저장
          // → componentDidUpdate의 세 번째 인자로 전달됨
          instance.__reactInternalSnapshotBeforeUpdate = snapshot;
        }
        break;
      }

      case HostRoot: {
        // HostRoot에서 Snapshot: 포커스 상태 초기화
        if (supportsMutation) {
          const root = finishedWork.stateNode;
          clearContainer(root.containerInfo);
        }
        break;
      }
    }
  }

  // Passive Effects 마킹
  if ((flags & Passive) !== NoFlags) {
    if (!rootDoesHavePassiveEffects) {
      rootDoesHavePassiveEffects = true;
      scheduleCallback(NormalSchedulerPriority, () => {
        flushPassiveEffects();
        return null;
      });
    }
  }
}
```

`getSnapshotBeforeUpdate`가 Before Mutation에서 실행되는 이유: 이 시점이 DOM이 마지막으로 이전 상태를 유지하는 순간이기 때문입니다. 스크롤 위치, 레이아웃 측정값 등을 "변경 직전"에 캡처하여 `componentDidUpdate`에서 활용할 수 있습니다.

---

## 4. Mutation Phase — DOM의 실제 변경

### 4.1 commitMutationEffects 전체 흐름

```javascript
export function commitMutationEffects(root: FiberRoot, finishedWork: Fiber, committedLanes: Lanes) {
  inProgressLanes = committedLanes;
  inProgressRoot = root;
  nextEffect = finishedWork;

  commitMutationEffects_begin(root);

  inProgressLanes = null;
  inProgressRoot = null;
}

function commitMutationEffects_begin(root: FiberRoot) {
  while (nextEffect !== null) {
    const fiber = nextEffect;

    // ─── 1. 삭제 먼저 처리 ───
    const deletions = fiber.deletions;
    if (deletions !== null) {
      for (let i = 0; i < deletions.length; i++) {
        const childToDelete = deletions[i];
        try {
          commitDeletionEffects(root, fiber, childToDelete);
        } catch (error) {
          captureCommitPhaseError(childToDelete, fiber, error);
        }
      }
    }

    const child = fiber.child;
    // subtreeFlags로 자식 방문 필요 여부 확인
    if ((fiber.subtreeFlags & MutationMask) !== NoFlags && child !== null) {
      child.return = fiber;
      nextEffect = child;
    } else {
      commitMutationEffects_complete(root);
    }
  }
}
```

### 4.2 commitMutationEffectsOnFiber — 플래그별 처리

```javascript
function commitMutationEffectsOnFiber(finishedWork: Fiber, root: FiberRoot, lanes: Lanes) {
  const current = finishedWork.alternate;
  const flags = finishedWork.flags;

  switch (finishedWork.tag) {
    case FunctionComponent:
    case ForwardRef:
    case MemoComponent:
    case SimpleMemoComponent: {
      // ─── useLayoutEffect destroy 실행 (업데이트 시) ───
      commitHookEffectListUnmount(
        HookLayout | HookHasEffect,
        finishedWork,
        finishedWork.return,
      );

      // ContentReset: textContent 초기화
      if (flags & ContentReset) {
        commitResetTextContent(finishedWork);
      }

      // Placement: 새 위치에 DOM 삽입
      if (flags & Placement) {
        commitPlacement(finishedWork);
        finishedWork.flags &= ~Placement; // 처리됨 표시
      }

      // Update: DOM 속성 업데이트
      if (flags & Update) {
        const updatePayload = finishedWork.updateQueue;
        finishedWork.updateQueue = null;
        if (updatePayload !== null) {
          commitUpdate(instance, updatePayload, type, oldProps, newProps, finishedWork);
        }
      }
      return;
    }

    case HostComponent: {
      // Ref 해제 (업데이트 시 이전 ref 정리)
      if (flags & Ref) {
        if (current !== null) {
          safelyDetachRef(current, current.return);
        }
      }

      // Placement
      if (flags & Placement) {
        commitPlacement(finishedWork);
        finishedWork.flags &= ~Placement;
      }

      // Update: Render Phase에서 계산된 updatePayload 적용
      if (flags & Update) {
        const instance = finishedWork.stateNode;
        if (instance !== null) {
          const updatePayload = finishedWork.updateQueue;
          finishedWork.updateQueue = null;
          if (updatePayload !== null) {
            // [key, value, key, value, ...] 배열로 DOM 속성 일괄 적용
            commitUpdate(instance, updatePayload, type, oldProps, newProps, finishedWork);
          }
        }
      }
      return;
    }

    case HostText: {
      if (flags & Update) {
        const textInstance = finishedWork.stateNode;
        const newText = finishedWork.memoizedProps;
        const oldText = current !== null ? current.memoizedProps : newText;
        commitTextUpdate(textInstance, oldText, newText);
      }
      return;
    }
  }
}
```

### 4.3 commitPlacement — DOM 삽입의 정확한 알고리즘

```javascript
function commitPlacement(finishedWork: Fiber): void {
  if (!supportsMutation) return;

  // ─── 1. 가장 가까운 Host 부모 찾기 ───
  const parentFiber = getHostParentFiber(finishedWork);
  let parent;
  let isContainer;
  const parentStateNode = parentFiber.stateNode;

  switch (parentFiber.tag) {
    case HostComponent:
      parent = parentStateNode;
      isContainer = false;
      break;
    case HostRoot:
      parent = parentStateNode.containerInfo;
      isContainer = true;
      break;
    case HostPortal:
      parent = parentStateNode.containerInfo;
      isContainer = true;
      break;
  }

  // ─── 2. 삽입 위치(before) 찾기 ───
  // 이 Fiber 다음에 오는 첫 번째 Host 형제 DOM 노드
  const before = getHostSibling(finishedWork);

  if (before) {
    // insertBefore: 특정 노드 앞에 삽입
    insertOrAppendPlacementNodeIntoContainer(finishedWork, before, parent);
  } else {
    // appendChild: 끝에 추가
    appendPlacementNode(finishedWork, parent);
  }
}

function getHostSibling(fiber: Fiber): ?Instance {
  let node: Fiber = fiber;
  siblings: while (true) {
    // 형제가 없으면 부모로 올라감
    while (node.sibling === null) {
      if (node.return === null || isHostParent(node.return)) {
        return null; // 형제 없음 → appendChild
      }
      node = node.return;
    }
    node.sibling.return = node.return;
    node = node.sibling;

    // Host 타입이 아닌 Fiber (FunctionComponent 등) 건너뜀
    while (
      node.tag !== HostComponent &&
      node.tag !== HostText &&
      node.tag !== DehydratedFragment
    ) {
      if (node.flags & Placement) {
        // 이 형제도 Placement → 아직 위치 미확정 → 건너뜀
        continue siblings;
      }
      if (node.child === null || node.tag === HostPortal) {
        continue siblings;
      } else {
        node.child.return = node;
        node = node.child;
      }
    }

    // Placement 플래그 없는 실제 DOM 노드 발견
    if (!(node.flags & Placement)) {
      return node.stateNode; // 이 앞에 삽입
    }
  }
}
```

### 4.4 commitDeletionEffects — 삭제의 연쇄 처리

```javascript
function commitDeletionEffects(root: FiberRoot, returnFiber: Fiber, deletedFiber: Fiber) {
  if (supportsMutation) {
    // ─── DOM 트리에서 제거할 가장 가까운 Host 부모 찾기 ───
    let parent: Fiber | null = returnFiber;
    findParent: while (parent !== null) {
      switch (parent.tag) {
        case HostComponent: {
          hostParent = parent.stateNode;
          hostParentIsContainer = false;
          break findParent;
        }
        case HostRoot: {
          hostParent = parent.stateNode.containerInfo;
          hostParentIsContainer = true;
          break findParent;
        }
        case HostPortal: {
          hostParent = parent.stateNode.containerInfo;
          hostParentIsContainer = true;
          break findParent;
        }
      }
      parent = parent.return;
    }

    // DFS로 삭제 대상 서브트리 순회하며 cleanup 실행
    commitDeletionEffectsOnFiber(root, returnFiber, deletedFiber);

    hostParent = null;
    hostParentIsContainer = false;
  }

  // 삭제된 Fiber를 부모의 자식 연결에서 해제
  detachFiberMutation(deletedFiber);
}

function commitDeletionEffectsOnFiber(root, nearestMountedAncestor, deletedFiber) {
  switch (deletedFiber.tag) {
    case HostComponent: {
      safelyDetachRef(deletedFiber, nearestMountedAncestor);
    }
    // falls through

    case HostText: {
      const prevHostParent = hostParent;
      const prevHostParentIsContainer = hostParentIsContainer;

      // 이 노드 아래의 자식들은 별도로 removeChild 하지 않음
      // 부모 DOM 노드를 제거하면 자식 DOM도 함께 제거됨
      hostParent = null;

      // 재귀적으로 자식들의 cleanup effect 실행
      recursivelyTraverseDeletionEffects(root, nearestMountedAncestor, deletedFiber);

      hostParent = prevHostParent;
      hostParentIsContainer = prevHostParentIsContainer;

      if (hostParent !== null) {
        // DOM에서 실제로 제거 (최상위 Host 노드 하나만)
        if (hostParentIsContainer) {
          removeChildFromContainer(hostParent, deletedFiber.stateNode);
        } else {
          removeChild(hostParent, deletedFiber.stateNode);
        }
      }
      return;
    }

    case FunctionComponent:
    case ForwardRef:
    case MemoComponent:
    case SimpleMemoComponent: {
      // useLayoutEffect destroy 실행 (삭제 시)
      const updateQueue = deletedFiber.updateQueue;
      if (updateQueue !== null) {
        const lastEffect = updateQueue.lastEffect;
        if (lastEffect !== null) {
          const firstEffect = lastEffect.next;
          let effect = firstEffect;
          do {
            const {destroy, tag} = effect;
            if (destroy !== undefined) {
              if ((tag & HookLayout) !== NoHookEffect) {
                safelyCallDestroy(deletedFiber, nearestMountedAncestor, destroy);
              }
            }
            effect = effect.next;
          } while (effect !== firstEffect);
        }
      }
      recursivelyTraverseDeletionEffects(root, nearestMountedAncestor, deletedFiber);
      return;
    }

    case ClassComponent: {
      safelyDetachRef(deletedFiber, nearestMountedAncestor);
      const instance = deletedFiber.stateNode;
      if (typeof instance.componentWillUnmount === 'function') {
        safelyCallComponentWillUnmount(deletedFiber, nearestMountedAncestor, instance);
      }
      recursivelyTraverseDeletionEffects(root, nearestMountedAncestor, deletedFiber);
      return;
    }
  }
}
```

**중요 최적화**: 컨테이너 DOM 노드를 제거하면 그 하위 DOM 노드들도 자동으로 제거됩니다. React는 최상위 Host 노드 하나만 `removeChild`하고, 하위 Fiber들에 대해서는 DOM 조작 없이 cleanup effect(lifecycle, ref 해제)만 실행합니다.

---

## 5. Layout Phase — 동기 Effect 실행

### 5.1 commitLayoutEffects

```javascript
export function commitLayoutEffects(
  finishedWork: Fiber,
  root: FiberRoot,
  committedLanes: Lanes,
): void {
  inProgressLanes = committedLanes;
  inProgressRoot = root;
  nextEffect = finishedWork;

  commitLayoutEffects_begin(finishedWork, root, committedLanes);

  inProgressLanes = null;
  inProgressRoot = null;
}

function commitLayoutEffects_begin(subtreeRoot, root, committedLanes) {
  while (nextEffect !== null) {
    const fiber = nextEffect;
    const firstChild = fiber.child;

    if (
      (fiber.subtreeFlags & LayoutMask) !== NoFlags &&
      firstChild !== null
    ) {
      firstChild.return = fiber;
      nextEffect = firstChild;
    } else {
      commitLayoutMountEffects_complete(subtreeRoot, root, committedLanes);
    }
  }
}

function commitLayoutMountEffects_complete(subtreeRoot, root, committedLanes) {
  while (nextEffect !== null) {
    const fiber = nextEffect;

    if ((fiber.flags & LayoutMask) !== NoFlags) {
      const current = fiber.alternate;
      try {
        commitLayoutEffectOnFiber(root, current, fiber, committedLanes);
      } catch (error) {
        captureCommitPhaseError(fiber, fiber.return, error);
      }
    }

    if (fiber === subtreeRoot) {
      nextEffect = null;
      return;
    }

    const sibling = fiber.sibling;
    if (sibling !== null) {
      sibling.return = fiber.return;
      nextEffect = sibling;
      return;
    }
    nextEffect = fiber.return;
  }
}
```

### 5.2 commitLayoutEffectOnFiber — 컴포넌트 유형별 처리

```javascript
function commitLayoutEffectOnFiber(
  finishedRoot: FiberRoot,
  current: Fiber | null,
  finishedWork: Fiber,
  committedLanes: Lanes,
): void {
  if ((finishedWork.flags & LayoutMask) !== NoFlags) {
    switch (finishedWork.tag) {
      case FunctionComponent:
      case ForwardRef:
      case SimpleMemoComponent: {
        // ─── useLayoutEffect setup 실행 ───
        // HookLayout | HookHasEffect: 의존성이 변경된 effect만
        if (!offscreenSubtreeWasHidden) {
          commitHookEffectListMount(
            HookLayout | HookHasEffect,
            finishedWork,
          );
        }
        break;
      }

      case ClassComponent: {
        const instance = finishedWork.stateNode;

        if (current === null) {
          // 마운트: componentDidMount
          if (!offscreenSubtreeWasHidden) {
            instance.componentDidMount();
            // ★ 여기서 setState 호출 가능 → 동기 재렌더
          }
        } else {
          // 업데이트: componentDidUpdate
          const prevProps =
            finishedWork.elementType === finishedWork.type
              ? current.memoizedProps
              : resolveDefaultProps(finishedWork.type, current.memoizedProps);
          const prevState = current.memoizedState;

          if (!offscreenSubtreeWasHidden) {
            instance.componentDidUpdate(
              prevProps,
              prevState,
              instance.__reactInternalSnapshotBeforeUpdate,
              // getSnapshotBeforeUpdate의 반환값
            );
          }
        }
        break;
      }

      case HostRoot: {
        // ReactDOM.render의 콜백
        const updateQueue = finishedWork.updateQueue;
        if (updateQueue !== null) {
          const instance = finishedWork.child?.stateNode ?? null;
          commitCallbacks(finishedWork, updateQueue, instance);
        }
        break;
      }

      case HostComponent: {
        // autoFocus 처리
        if (current === null && finishedWork.flags & Update) {
          const type = finishedWork.type;
          const props = finishedWork.memoizedProps;
          commitMount(finishedWork.stateNode, type, props, finishedWork);
          // → input, select 등의 autoFocus 속성 처리
        }
        break;
      }
    }
  }

  // ─── Ref 업데이트 ───
  if (!offscreenSubtreeWasHidden) {
    if (finishedWork.flags & Ref) {
      commitAttachRef(finishedWork);
    }
  }
}
```

### 5.3 commitHookEffectListMount — useLayoutEffect 실행

```javascript
function commitHookEffectListMount(flags: HookFlags, finishedWork: Fiber) {
  const updateQueue: FunctionComponentUpdateQueue | null =
    (finishedWork.updateQueue: any);
  const lastEffect = updateQueue !== null ? updateQueue.lastEffect : null;

  if (lastEffect !== null) {
    const firstEffect = lastEffect.next;
    let effect = firstEffect;
    do {
      if ((effect.tag & flags) === flags) {
        // ─── effect 실행 ───
        const create = effect.create;
        effect.destroy = create();
        // useLayoutEffect(() => {
        //   return () => cleanup(); // 이 함수가 effect.destroy에 저장
        // }, [deps]);
      }
      effect = effect.next;
    } while (effect !== firstEffect);
  }
}
```

### 5.4 commitAttachRef — ref 연결

```javascript
function commitAttachRef(finishedWork: Fiber) {
  const ref = finishedWork.ref;
  if (ref !== null) {
    const instance = finishedWork.stateNode;
    let instanceToUse;

    switch (finishedWork.tag) {
      case HostComponent:
        instanceToUse = getPublicInstance(instance); // DOM 노드 자체
        break;
      default:
        instanceToUse = instance; // 클래스 인스턴스
    }

    if (typeof ref === 'function') {
      // 콜백 ref
      ref(instanceToUse);
    } else {
      // ref 객체 (useRef)
      ref.current = instanceToUse;
    }
  }
}
```

ref가 Layout Phase에서 업데이트되는 이유: Layout Phase는 DOM 변경(Mutation) 이후이고 브라우저 paint 이전입니다. ref가 업데이트된 시점에서 실행되는 `useLayoutEffect`는 ref를 통해 실제 DOM에 접근하고 측정할 수 있습니다(레이아웃 측정, 스크롤 위치 등).

---

## 6. 브라우저 Paint와 useLayoutEffect/useEffect의 관계

### 6.1 브라우저 렌더링 파이프라인과 React의 상호작용

```
JavaScript (React Commit Phase)
─────────────────────────────────────────────────────────
│ Before Mutation Phase
│ Mutation Phase (DOM 변경)
│ root.current = finishedWork
│ Layout Phase (useLayoutEffect setup)
│ requestPaint()  ← "브라우저야, paint해도 좋아" 신호
─────────────────────────────────────────────────────────
                    ↓ (JS 콜스택 비워짐)
브라우저 내부
─────────────────────────────────────────────────────────
│ Style 계산
│ Layout (리플로우)
│ Paint (픽셀 그리기)
│ Compositing
─────────────────────────────────────────────────────────
                    ↓ (다음 태스크)
Passive Effects (useEffect 실행)
─────────────────────────────────────────────────────────
│ MessageChannel → flushPassiveEffects()
│ useEffect cleanup (이전 것)
│ useEffect setup (새 것)
─────────────────────────────────────────────────────────
```

### 6.2 useLayoutEffect가 paint를 block하는 이유

`useLayoutEffect`는 Layout Phase에서 **동기적으로** 실행됩니다. JavaScript의 단일 스레드 특성상, Layout Phase가 완료될 때까지 브라우저는 아무것도 할 수 없습니다.

```javascript
// commitRootImpl의 끝부분
commitLayoutEffects(finishedWork, root, lanes);
// ↑ useLayoutEffect는 여기서 동기 실행 (블로킹)

requestPaint();
// ↑ Scheduler에게 "다음 틱에서 paint 허용" 신호

// JS 콜스택이 비워진 후에야 브라우저가 paint
```

`requestPaint`의 구현:

```javascript
// packages/scheduler/src/forks/Scheduler.js

function requestPaint() {
  if (
    enableIsInputPending &&
    navigator !== undefined &&
    (navigator: any).scheduling !== undefined &&
    (navigator: any).scheduling.isInputPending !== undefined
  ) {
    needsPaint = true;
    // isInputPending API를 통해 브라우저에 "가능하면 paint 먼저" 힌트
  }
}
```

`useLayoutEffect` 내부에서 DOM 측정이나 강제 동기 스타일 계산(`getBoundingClientRect`, `offsetWidth` 등)을 수행하면 브라우저가 먼저 레이아웃을 계산해야 합니다. 이것이 "강제 동기 레이아웃(Forced Synchronous Layout)" 또는 "레이아웃 쓰래싱(Layout Thrashing)"의 원인입니다.

```javascript
// 위험: useLayoutEffect 내부에서 측정 + 수정 반복
useLayoutEffect(() => {
  const height = element.offsetHeight; // 강제 레이아웃 계산
  setHeight(height); // setState → 재렌더 → 다시 useLayoutEffect
}, []);

// 안전: 측정만 하고 ref에 저장
useLayoutEffect(() => {
  const height = element.offsetHeight;
  heightRef.current = height; // 재렌더 유발하지 않음
}, []);
```

### 6.3 useEffect가 paint 이후에 실행되는 이유

`useEffect`는 `scheduleCallback(NormalSchedulerPriority, flushPassiveEffects)`로 등록됩니다. Scheduler는 내부적으로 **MessageChannel**을 사용하여 비동기 실행을 예약합니다.

```javascript
// packages/scheduler/src/forks/Scheduler.js

const channel = new MessageChannel();
const port = channel.port2;
channel.port1.onmessage = performWorkUntilDeadline;

function schedulePerformWorkUntilDeadline() {
  port.postMessage(null);
  // ↑ 새 매크로태스크(macrotask) 등록
  // 현재 태스크 완료 후, 브라우저 paint 후 실행
}
```

MessageChannel의 `postMessage`는 새 매크로태스크를 큐에 등록합니다. 브라우저는 매크로태스크 사이에 렌더링(style + layout + paint)을 수행할 수 있습니다.

```
태스크 큐 실행 순서:
─────────────────────────────────────────────────────────
태스크 1: React Commit Phase (동기)
  - Mutation Phase
  - Layout Phase (useLayoutEffect 포함)
  - scheduleCallback → MessageChannel.postMessage
─────────────────────────────────────────────────────────
브라우저 렌더링 기회 (Style + Layout + Paint)
─────────────────────────────────────────────────────────
태스크 2: MessageChannel.onmessage → flushPassiveEffects
  - useEffect cleanup (이전)
  - useEffect setup (새)
─────────────────────────────────────────────────────────
```

### 6.4 requestAnimationFrame과의 차이

초기 React 버전(16.x 일부)은 `requestAnimationFrame`을 사용했으나, 현재는 MessageChannel을 사용합니다.

| 특성 | requestAnimationFrame | MessageChannel |
|------|----------------------|----------------|
| 실행 시점 | 다음 paint 직전 | 현재 태스크 완료 후 (paint 이후) |
| 탭 비활성 시 | 실행 안 됨 | 정상 실행 |
| 프레임 내 여러 번 | 불가 (프레임당 1회) | 가능 (여러 메시지) |
| 사용 목적 | 애니메이션 (렌더 직전) | 비동기 태스크 (렌더 후) |

`requestAnimationFrame`은 브라우저 paint 직전에 실행되어 애니메이션에 적합합니다. React의 Passive Effects는 "paint 이후 가능한 빨리"가 목표이므로 MessageChannel이 더 적합합니다. 또한 `requestAnimationFrame`은 탭이 백그라운드에 있을 때 호출이 중단되므로, React의 useEffect가 탭 전환 후 작동하지 않는 버그를 피하기 위해 MessageChannel로 전환했습니다.

---

## 7. Passive Effects — 비동기 배치 처리

### 7.1 flushPassiveEffects

```javascript
export function flushPassiveEffects(): boolean {
  // ★ 핵심 가드: 대기 중인 게 없으면 즉시 반환
  if (rootWithPendingPassiveEffects !== null) {
    const renderPriority = lanesToEventPriority(pendingPassiveEffectsLanes);
    const priority = lowerEventPriority(DefaultEventPriority, renderPriority);

    const prevTransition = ReactCurrentBatchConfig.transition;
    const previousPriority = getCurrentUpdatePriority();

    try {
      ReactCurrentBatchConfig.transition = null;
      setCurrentUpdatePriority(priority);
      return flushPassiveEffectsImpl();
    } finally {
      setCurrentUpdatePriority(previousPriority);
      ReactCurrentBatchConfig.transition = prevTransition;
    }
  }
  return false;
}

function flushPassiveEffectsImpl() {
  if (rootWithPendingPassiveEffects === null) {
    return false;
  }

  const root = rootWithPendingPassiveEffects;
  const lanes = pendingPassiveEffectsLanes;

  // ★ 대기 중인 root 클리어 — 이후 새 Commit에서 다시 설정 가능
  rootWithPendingPassiveEffects = null;
  pendingPassiveEffectsLanes = NoLanes;

  const prevExecutionContext = executionContext;
  executionContext |= CommitContext;

  // ─── 1단계: 이전 Passive Effects destroy 실행 ───
  commitPassiveUnmountEffects(root.current);

  // ─── 2단계: 새 Passive Effects create 실행 ───
  commitPassiveMountEffects(root, root.current, lanes, transitions);

  // ─── Pending 작업 실행 ───
  // useEffect 내부에서 setState가 호출됐을 수 있음
  flushSyncCallbacks();

  executionContext = prevExecutionContext;

  return true;
}
```

### 7.2 rootWithPendingPassiveEffects 가드의 의미

```javascript
// 여러 장소에서 flushPassiveEffects가 호출될 수 있음
// 하지만 실제 실행은 한 번만 이루어짐

// 호출 지점 1: commitRootImpl 시작 시 이전 효과 처리
do {
  flushPassiveEffects();
} while (rootWithPendingPassiveEffects !== null);

// 호출 지점 2: 비동기 스케줄된 콜백
scheduleCallback(NormalSchedulerPriority, () => {
  flushPassiveEffects();
  return null;
});

// 호출 지점 3: flushSync 내부에서
// 호출 지점 4: 테스트 유틸리티 act()에서

// → 가드가 없으면 useEffect가 여러 번 실행될 수 있음
// → rootWithPendingPassiveEffects 체크로 멱등성 보장
```

`flushPassiveEffectsImpl` 진입 시 `rootWithPendingPassiveEffects = null`로 초기화하는 것이 핵심입니다. 이 시점에서 다른 경로가 다시 `flushPassiveEffects`를 호출해도 즉시 반환합니다.

### 7.3 commitPassiveUnmountEffects — 이전 effect cleanup

```javascript
function commitPassiveUnmount(finishedWork: Fiber) {
  switch (finishedWork.tag) {
    case FunctionComponent:
    case ForwardRef:
    case SimpleMemoComponent: {
      // HookPassive: useEffect (HookLayout은 useLayoutEffect)
      // HookHasEffect: 이번 렌더에서 의존성이 변경된 것만
      commitHookEffectListUnmount(
        HookPassive | HookHasEffect,
        finishedWork,
        finishedWork.return,
      );
    }
  }
}
```

### 7.4 useEffect 내부 setState의 사이클

```javascript
useEffect(() => {
  // 이 실행은 paint 이후, 별도 태스크
  setCount(c => c + 1);
  // → scheduleUpdateOnFiber
  // → ensureRootIsScheduled
  // → 새 렌더/커밋 사이클 예약 (현재 flushPassiveEffectsImpl 완료 후)
}, []);

// flushPassiveEffectsImpl 끝에서:
flushSyncCallbacks();
// SyncLane 업데이트가 있으면 즉시 동기 처리
// 그렇지 않으면 다음 Scheduler 틱에서 처리
```

useEffect → setState의 사이클은 무한루프를 만들 수 있습니다:

```javascript
// 무한 루프 위험
useEffect(() => {
  setCount(c => c + 1); // 매 렌더마다 새 렌더 예약
}); // 의존성 없음 = 매 렌더 후 실행

// 의존성 배열로 제어
useEffect(() => {
  setCount(c => c + 1);
}, []); // 최초 마운트 한 번만
```

---

## 8. commitLayoutEffects에서 setState 동기 처리

### 8.1 동기 재렌더가 발생하는 메커니즘

`componentDidMount`나 `componentDidUpdate`에서 `setState`를 호출하면 `flushSync` 없이도 동기 재렌더가 발생합니다. 이 동작의 근거를 코드 레벨에서 추적합니다.

```javascript
function scheduleUpdateOnFiber(root, fiber, lane, eventTime) {
  markRootUpdated(root, lane, eventTime);

  if (
    (executionContext & RenderContext) !== NoContext ||
    (executionContext & CommitContext) !== NoContext
  ) {
    // ★ Render/Commit 중에 setState 호출 → 배치 처리
    // 현재 executionContext에 CommitContext가 포함되어 있음
    // → 즉시 실행 안 함, 현재 Commit 완료 후 처리
    workInProgressRootInterleavedUpdatedLanes = mergeLanes(
      workInProgressRootInterleavedUpdatedLanes,
      lane,
    );
    return;
  }

  ensureRootIsScheduled(root, eventTime);
}
```

Layout Phase 동안 `executionContext`에는 `CommitContext`가 포함되어 있습니다. 따라서 `componentDidMount`에서 `setState`를 호출하면 즉각적인 재렌더가 일어나지 않고, 현재 Commit의 남은 작업 처리 후 `ensureRootIsScheduled`에서 처리됩니다.

### 8.2 이중 렌더 문제

```javascript
class MyComponent extends React.Component {
  state = { width: 0 };

  componentDidMount() {
    // DOM에서 실제 너비 측정 후 상태 업데이트
    const width = this.divRef.current.offsetWidth;
    this.setState({ width }); // ← 두 번째 렌더 유발
  }

  render() {
    // 1번 렌더: width = 0 (초기값)
    // 2번 렌더: width = 실제 측정값
    return <div ref={this.divRef}>{this.state.width}</div>;
  }
}
```

이 패턴의 문제: 사용자는 두 번 렌더를 경험합니다. 첫 번째는 width=0, 두 번째는 실제 값입니다. 그러나 두 번 모두 paint가 실행됩니다.

**권장 해결 패턴**:

```javascript
// 패턴 1: useLayoutEffect로 이전 (paint 전에 처리)
function MyComponent() {
  const [width, setWidth] = useState(0);
  const divRef = useRef(null);

  useLayoutEffect(() => {
    // paint 전에 측정 + 업데이트
    // → 두 번 렌더되지만 사용자는 두 번째 결과만 봄 (paint 한 번)
    setWidth(divRef.current.offsetWidth);
  }, []);

  return <div ref={divRef}>{width}</div>;
}

// 패턴 2: useRef로 값 추적 (재렌더 방지)
function MyComponent() {
  const divRef = useRef(null);
  const widthRef = useRef(0);

  useLayoutEffect(() => {
    widthRef.current = divRef.current.offsetWidth;
    // → 재렌더 없음, ref만 업데이트
  }, []);

  return <div ref={divRef}>{widthRef.current}</div>;
}
```

### 8.3 flushSync 없이도 동기인 이유

```javascript
// Layout Phase의 executionContext
executionContext = CommitContext | BatchedContext;

// setState 호출 시 (commitLayoutEffects 내부):
function dispatchSetState(fiber, queue, action) {
  const lane = requestUpdateLane(fiber);
  // → DiscreteEventPriority 컨텍스트이므로 SyncLane 할당

  const update = createUpdate(lane);
  scheduleUpdateOnFiber(root, fiber, lane, eventTime);
  // → CommitContext 안이므로 즉시 실행 안 함
  // → workInProgressRootInterleavedUpdatedLanes에 추가
}

// commitRootImpl 완료 후:
ensureRootIsScheduled(root, now());
// SyncLane 발견 → scheduleMicrotask(flushSyncCallbacks)

// 마이크로태스크로 즉시 처리 (다음 매크로태스크 전)
// → 브라우저 paint 전에 동기 재렌더 완료
// → 사용자는 두 번째 렌더 결과만 봄
```

이것이 "flushSync 없이도 동기"인 이유입니다. SyncLane 업데이트는 마이크로태스크로 즉시 처리되기 때문입니다. 브라우저 paint는 현재 마이크로태스크 큐가 비워질 때까지 기다립니다.

---

## 9. detachFiberAfterEffects — 메모리 관리

### 9.1 순환 참조 문제

Fiber 객체들은 서로를 참조하는 복잡한 그래프를 형성합니다:

```
Fiber.return   → 부모 Fiber
Fiber.child    → 첫 번째 자식 Fiber
Fiber.sibling  → 형제 Fiber
Fiber.alternate → 다른 버전의 Fiber (더블 버퍼링)
Fiber.stateNode → DOM 노드 또는 클래스 인스턴스
Fiber.memoizedState → Hook 연결 리스트
Fiber.updateQueue   → 업데이트 큐
```

컴포넌트가 삭제될 때, 이 참조들이 해제되지 않으면 GC(Garbage Collector)가 해당 객체들을 수집할 수 없습니다. 특히 Fiber의 `alternate`는 두 트리 간 순환 참조를 만들 수 있습니다.

### 9.2 detachFiberAfterEffects 구현

```javascript
function detachFiberAfterEffects(fiber: Fiber) {
  const alternate = fiber.alternate;

  if (alternate !== null) {
    fiber.alternate = null;        // 순환 참조 끊기
    detachFiberAfterEffects(alternate); // alternate도 정리
  }

  // ─── 트리 탐색 포인터 해제 ───
  fiber.child = null;      // 자식 Fiber 참조 해제
  fiber.deletions = null;  // 삭제 목록 해제
  fiber.sibling = null;    // 형제 Fiber 참조 해제
  fiber.return = null;     // 부모 Fiber 참조 해제

  // ─── 데이터 해제 ───
  fiber.dependencies = null;   // Context 의존성 해제
  fiber.memoizedProps = null;  // 마지막 props 해제
  fiber.memoizedState = null;  // 마지막 상태/Hook 체인 해제
  fiber.pendingProps = null;   // 미반영 props 해제
  fiber.stateNode = null;      // DOM 노드/인스턴스 참조 해제
  fiber.updateQueue = null;    // 업데이트 큐 해제

  if (__DEV__) {
    fiber._debugOwner = null;
  }
}
```

### 9.3 왜 null로 명시적 설정이 필요한가

JavaScript GC는 도달 가능성(reachability) 기반으로 동작합니다. 삭제된 Fiber가 아직 어딘가에서 참조되고 있다면 GC되지 않습니다.

```
문제 시나리오:

루트 → 현재 트리 → ... → 삭제된 Fiber A
                              ↑ (alternate 포인터)
                           Fiber A의 alternate (이전 버전)
                              ↑ (어딘가에서 클로저로 참조)
                           개발자 코드의 변수

→ Fiber A는 GC될 수 없음
→ Fiber A가 참조하는 DOM 노드, 클래스 인스턴스, Hook 체인 모두 GC 불가
→ 메모리 누수
```

`detachFiberAfterEffects`가 참조를 null로 설정하면 삭제된 Fiber가 참조하던 DOM, 인스턴스, Hook 체인도 GC 대상이 됩니다.

### 9.4 실제 메모리 영향

대규모 React 앱에서 컴포넌트가 빈번히 마운트/언마운트되는 경우(무한 스크롤, 탭 전환 등), `detachFiberAfterEffects` 없이는 상당한 메모리 누수가 발생합니다.

```javascript
// 메모리 누수 위험 패턴
function InfiniteList() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    // 아이템이 계속 추가되고, 이전 아이템들의 Fiber가
    // 정리되지 않으면 메모리 계속 증가
    fetchMoreItems().then(newItems => setItems(prev => [...prev, ...newItems]));
  }, []);
}

// 올바른 패턴: 가상화(virtualization)
// react-window, react-virtual 등
// → 화면에 보이는 것만 렌더, 나머지 Fiber는 정리됨
```

---

## 10. Error Handling in Commit Phase

### 10.1 captureCommitPhaseError

```javascript
export function captureCommitPhaseError(
  sourceFiber: Fiber,
  nearestMountedAncestor: Fiber | null,
  error: mixed,
) {
  if (sourceFiber.tag === HostRoot) {
    // 루트에서 에러 → 복구 불가능
    markRootSuspended(sourceFiber.stateNode, workInProgressRootRenderLanes);
    ensureRootIsScheduled(sourceFiber.stateNode, now());
    return;
  }

  // ─── Error Boundary 탐색 ───
  let node = nearestMountedAncestor;

  while (node !== null) {
    if (node.tag === HostRoot) {
      // Error Boundary 없이 루트까지 도달
      createRootErrorUpdate(node, error, SyncLane);
      return;
    } else if (node.tag === ClassComponent) {
      const nodeType = node.type;
      if (
        typeof nodeType.getDerivedStateFromError === 'function' ||
        typeof node.stateNode.componentDidCatch === 'function'
      ) {
        // ★ Error Boundary 발견
        const update = createClassErrorUpdate(node, error, SyncLane);

        // Error Boundary의 Fiber에 에러 업데이트 등록
        enqueueUpdate(node, update, SyncLane);

        // 즉시 재렌더 예약
        const root = enqueueConcurrentClassUpdate(node, null, update, SyncLane);
        if (root !== null) {
          markRootUpdated(root, SyncLane, now());
          ensureRootIsScheduled(root, now());
        }
        return;
      }
    }
    node = node.return; // 부모로 올라가며 탐색
  }
}
```

### 10.2 Commit Phase 에러 처리 흐름

```javascript
// commitMutationEffects_complete 내부
try {
  commitMutationEffectsOnFiber(fiber, root);
} catch (error) {
  captureCommitPhaseError(fiber, fiber.return, error);
  // ↑ 에러 발생 Fiber에서 부모 방향으로 Error Boundary 탐색
  // → 발견 시: Error Boundary에 에러 업데이트 등록 (다음 렌더에서 fallback 표시)
  // → 미발견 시: 루트 수준 에러 (앱 전체 크래시)
}

// commitLayoutEffects_complete 내부
try {
  commitLayoutEffectOnFiber(root, current, fiber, committedLanes);
} catch (error) {
  captureCommitPhaseError(fiber, fiber.return, error);
}
```

### 10.3 Render Phase 에러 vs Commit Phase 에러

| 특성 | Render Phase 에러 | Commit Phase 에러 |
|------|------------------|------------------|
| 발생 위치 | beginWork, completeWork | commitMutation, commitLayout, useEffect |
| 복구 가능성 | 높음 (WIP 트리 버림) | 낮음 (DOM 이미 변경됨) |
| Error Boundary 동작 | 에러 발생 Fiber 포함 서브트리 교체 | Error Boundary를 에러 상태로 리렌더 |
| Concurrent Mode | 재시도 가능 | 재시도 불가 |
| 부분 실패 | 가능 | 불가 (원자성) |

```javascript
// Render Phase 에러 처리 — 재시도 가능
function recoverFromConcurrentError(root, originallyAttemptedLanes, errorRetryLanes) {
  // 에러가 발생한 렌더를 동기 모드로 재시도
  const exitStatus = renderRootSync(root, errorRetryLanes);
  // 재시도에서도 에러 → Error Boundary 활성화
  // 성공하면 그 결과를 사용
}

// Commit Phase 에러 처리 — 재시도 불가, Error Boundary에 위임
function captureCommitPhaseError(sourceFiber, nearestMountedAncestor, error) {
  // 이미 DOM은 부분적으로 변경됨
  // → WIP 트리를 버리고 새 시작은 불가
  // → Error Boundary가 다음 렌더에서 fallback UI 표시
}
```

Concurrent Mode에서 Render Phase 에러는 "재시도"가 가능합니다. React는 에러가 발생한 렌더를 동기 모드로 다시 시도합니다. Commit Phase 에러는 이러한 재시도 메커니즘이 없습니다. DOM이 이미 부분적으로 변경되었기 때문입니다.

---

## 11. Commit Phase 원자성의 보장 메커니즘

### 11.1 왜 Commit Phase는 중단될 수 없는가

```javascript
// Render Phase: 중단 가능
function workLoopConcurrent() {
  while (workInProgress !== null && !shouldYield()) { // shouldYield 체크
    performUnitOfWork(workInProgress);
  }
}

// Commit Phase: 중단 불가
// 내부에 shouldYield() 체크가 전혀 없음
function commitMutationEffects_begin(root: FiberRoot) {
  while (nextEffect !== null) {
    // ... shouldYield() 없음
    commitMutationEffects_complete(root); // 끝까지 실행
  }
}
```

Commit Phase가 중단 불가능한 이유는 **원자성(Atomicity)** 보장 때문입니다:

1. **사용자가 일관성 없는 UI를 보면 안 됨**: Mutation이 절반만 적용된 상태에서 브라우저 paint가 일어나면 안 됩니다.

2. **ref가 항상 최신 DOM을 가리켜야 함**: Layout Phase가 완료되기 전 ref 접근이 허용되면, ref가 이전 DOM을 가리킬 수 있습니다.

3. **lifecycle 실행 순서 보장**: `componentDidMount`가 모든 자식의 `componentDidMount` 이후에 실행되어야 한다는 규약이 있습니다(아래에서 위로).

```
올바른 lifecycle 순서 (아래에서 위로):

Child.componentDidMount()
  Parent.componentDidMount()
    Root.componentDidMount()

Commit Phase가 중단되면 이 순서가 깨질 수 있음
```

### 11.2 executionContext로 중첩 진입 방지

```javascript
let executionContext: ExecutionContext = NoContext;

// ExecutionContext 비트 플래그
const NoContext     = 0b000;
const BatchedContext = 0b001;
const RenderContext  = 0b010;
const CommitContext  = 0b100;

// commitRootImpl 내에서 설정
executionContext |= CommitContext;

// 이 상태에서 scheduleUpdateOnFiber 호출 시:
function scheduleUpdateOnFiber(root, fiber, lane, eventTime) {
  if (
    (executionContext & RenderContext) !== NoContext ||
    (executionContext & CommitContext) !== NoContext
  ) {
    // Render/Commit 중 업데이트 → 배치 처리 (즉시 실행 안 함)
    return;
  }
  ensureRootIsScheduled(root, eventTime);
}
```

`CommitContext` 플래그는 Commit Phase 전체 동안 유지됩니다. 이 기간 동안 들어오는 모든 `scheduleUpdateOnFiber` 호출은 즉시 처리되지 않고 배치됩니다. Commit 완료 후 `ensureRootIsScheduled`에서 한꺼번에 처리됩니다.

### 11.3 Scheduler 양보와 Commit의 우선순위

```javascript
// Scheduler는 5ms마다 React에게 "양보해라"고 요청
function shouldYieldToHost(): boolean {
  const timeElapsed = getCurrentTime() - startTime;
  if (timeElapsed < frameInterval) { // frameInterval = 5ms
    return false;
  }
  return true;
}

// Commit Phase가 5ms를 초과해도 계속 실행되는 이유:
// commitMutationEffects, commitLayoutEffects 내부에
// shouldYield() 체크가 없음 → 의도된 설계
```

Commit Phase가 5ms를 초과하면 다음 프레임에서 UI가 버벅거릴 수 있습니다. 그러나 이는 일관성 없는 UI보다 낫습니다. 복잡한 앱에서 단일 Commit이 긴 시간이 걸린다면, 그것은 설계 문제(너무 많은 컴포넌트를 한 번에 업데이트)이며, 해결책은 `useTransition`으로 업데이트를 분산하는 것입니다.

---

## 12. 전체 Commit Phase 흐름 종합

```
renderRootSync/Concurrent 완료 → commitRoot 호출
─────────────────────────────────────────────────────────────
0. 이전 Passive Effects 플러시
   flushPassiveEffects() (rootWithPendingPassiveEffects 가드)
   → commitPassiveUnmountEffects (이전 useEffect cleanup)
   → commitPassiveMountEffects (이전 useEffect setup)
─────────────────────────────────────────────────────────────
1. Before Mutation Phase (commitBeforeMutationEffects)
   │
   ├── ClassComponent (Snapshot flag):
   │   getSnapshotBeforeUpdate()
   │   → DOM 변경 직전 스냅샷 캡처
   │   → __reactInternalSnapshotBeforeUpdate에 저장
   │
   ├── HostRoot: clearContainer (SSR dehydration 케이스)
   │
   └── Passive flag 있으면: rootDoesHavePassiveEffects = true
       scheduleCallback(NormalPriority, flushPassiveEffects)
─────────────────────────────────────────────────────────────
2. Mutation Phase (commitMutationEffects)
   │
   ├── [1] 삭제 처리 (fiber.deletions 순회)
   │   commitDeletionEffects
   │   → componentWillUnmount (ClassComponent)
   │   → useLayoutEffect destroy (FunctionComponent)
   │   → ref 해제
   │   → DOM에서 removeChild (최상위 Host만)
   │   → detachFiberMutation (즉시 참조 해제)
   │
   ├── [2] FunctionComponent (Layout | HookHasEffect flag)
   │   → useLayoutEffect destroy (업데이트 시)
   │
   ├── [3] Placement flag
   │   commitPlacement
   │   → getHostSibling으로 삽입 위치 결정
   │   → insertBefore 또는 appendChild
   │
   ├── [4] Update flag (HostComponent)
   │   commitUpdate
   │   → updatePayload([key, val, ...]) 적용
   │   → setAttribute, style 등
   │
   └── [5] HostText (Update)
       commitTextUpdate → textContent 업데이트
─────────────────────────────────────────────────────────────
★ root.current = finishedWork (포인터 교체)
  이 전: root.current = 이전 트리
  이 후: root.current = 새 트리
─────────────────────────────────────────────────────────────
3. Layout Phase (commitLayoutEffects)
   │
   ├── FunctionComponent (Layout | HookHasEffect flag)
   │   commitHookEffectListMount(HookLayout | HookHasEffect)
   │   → useLayoutEffect setup 실행
   │   → 반환값을 effect.destroy에 저장
   │
   ├── ClassComponent
   │   current === null → componentDidMount()
   │   current !== null → componentDidUpdate(prevProps, prevState, snapshot)
   │   ★ 여기서 setState 호출 가능 → 동기 재렌더 (마이크로태스크)
   │
   ├── HostRoot
   │   → ReactDOM.render 콜백 실행
   │
   ├── HostComponent (autoFocus)
   │   → input.focus() 등
   │
   └── Ref flag: commitAttachRef
       → ref.current = DOM 노드 / 인스턴스
─────────────────────────────────────────────────────────────
4. requestPaint() → 브라우저 paint 허용 신호
─────────────────────────────────────────────────────────────
5. 후처리
   ensureRootIsScheduled (남은 업데이트 스케줄링)
   flushSyncCallbacks (Layout에서 발생한 동기 업데이트)
─────────────────────────────────────────────────────────────
   (JS 콜스택 비워짐)
─────────────────────────────────────────────────────────────
   브라우저: Style → Layout → Paint → Compositing
─────────────────────────────────────────────────────────────
6. Passive Effects (별도 매크로태스크 — MessageChannel)
   flushPassiveEffects
   │
   ├── commitPassiveUnmountEffects
   │   → useEffect destroy (이전 렌더의 것)
   │   → 삭제된 컴포넌트의 useEffect destroy
   │
   ├── commitPassiveMountEffects
   │   → useEffect setup (새 렌더의 것)
   │   ★ 여기서 setState 호출 → 새 렌더/커밋 사이클
   │
   └── flushSyncCallbacks (Passive 내부 동기 업데이트)
─────────────────────────────────────────────────────────────
7. detachFiberAfterEffects
   → 삭제된 Fiber의 포인터들 null 설정
   → 순환 참조 해제 → GC 허용
─────────────────────────────────────────────────────────────
```

---

## 마치며

React Commit Phase의 설계는 "UI 일관성 보장"과 "성능 최적화"라는 두 목표의 균형입니다.

**세 가지 핵심 보장**:

1. **원자성**: DOM 변경은 중단 없이 완료된다. 사용자는 절반만 적용된 UI를 보지 않는다.

2. **순서 보장**: Mutation → (포인터 교체) → Layout → paint → Passive. 이 순서는 각 단계에서의 DOM 상태와 `root.current`의 상태를 정확히 예측 가능하게 만든다.

3. **메모리 안전성**: 삭제된 Fiber의 모든 참조는 정리된다. 순환 참조로 인한 메모리 누수를 방지한다.

**개발자가 이해해야 할 실용적 결론**:

- `useLayoutEffect`는 paint를 블록한다. DOM 측정이나 강제 동기 스타일 계산이 필요한 경우에만 사용한다.
- `componentDidMount`/`componentDidUpdate`에서 `setState`는 이중 렌더를 만든다. 불가피하다면 `useLayoutEffect` + `useState`로 대체하면 paint는 한 번이다.
- `useEffect`는 paint 이후 실행된다. 순수한 사이드 이펙트(서버 요청, 구독 등)는 `useEffect`가 적절하다.
- `FiberRoot.current`가 Mutation과 Layout 사이에 교체되는 타이밍은 Error Boundary, `componentDidMount` 내 `setState`, `getSnapshotBeforeUpdate` 등 미묘한 동작의 근거다.

다음 편에서는 Concurrent Mode의 핵심 기능인 **Suspense와 데이터 페칭의 내부 메커니즘**을 다룹니다. Promise throw, Suspense 경계의 fallback 전환, 그리고 Streaming SSR에서의 동작까지 분석합니다.

---

*소스 참조: `packages/react-reconciler/src/ReactFiberCommitWork.js`, `packages/react-reconciler/src/ReactFiberWorkLoop.js`, `packages/scheduler/src/forks/Scheduler.js`*
