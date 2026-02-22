# React 아키텍처 심층 분석 (4/14): Lane 스케줄링 시스템

> **React 아키텍처 심층 분석** 시리즈의 네 번째 글입니다. [3편](./react-architecture-03-hooks-system.md)에서 Hooks가 Fiber 위에서 연결 리스트로 상태를 관리하는 방식을 추적했습니다. 이번 편에서는 React의 **우선순위 기반 스케줄링 엔진**을 완전히 해부합니다. 32비트 정수 하나로 31개의 독립 작업을 추적하는 Lane 비트마스크, Entanglement로 업데이트를 묶는 메커니즘, 기아(Starvation)를 방지하는 만료 시스템, 그리고 5ms 단위로 브라우저와 협력하는 Scheduler까지 — `ReactFiberLane.js`와 `Scheduler.js`의 실제 코드를 라인 단위로 추적합니다.

> **참조 소스**: `react-dom@18.3.1 (react-dom.development.js)`, `packages/scheduler/src/forks/Scheduler.js`

---

## 목차

1. [왜 Lane인가 — Expiration에서 Lane으로](#1-왜-lane인가--expiration에서-lane으로)
2. [32비트 비트마스크 — Lane 상수 전체 지도](#2-32비트-비트마스크--lane-상수-전체-지도)
3. [getHighestPriorityLane — 2의 보수 트릭](#3-gethighestprioritylane--2의-보수-트릭)
4. [getNextLanes — 다음 렌더 대상 결정 알고리즘](#4-getnextlanes--다음-렌더-대상-결정-알고리즘)
5. [requestUpdateLane — 업데이트 Lane 할당 결정 트리](#5-requestupdatelane--업데이트-lane-할당-결정-트리)
6. [claimNextTransitionLane — 16개 라운드로빈](#6-claimnexttransitionlane--16개-라운드로빈)
7. [markUpdateLaneFromFiberToRoot — childLanes 전파](#7-markupdatelanefrombertotoroot--childlanes-전파)
8. [Lane Entanglement — 업데이트를 묶는 메커니즘](#8-lane-entanglement--업데이트를-묶는-메커니즘)
9. [기아 방지 — markStarvedLanesAsExpired](#9-기아-방지--markstarvedlanesasexpired)
10. [Concurrent Mode 인터럽트 — prepareFreshStack](#10-concurrent-mode-인터럽트--preparefreshstack)
11. [startTransition 내부 구현](#11-starttransition-내부-구현)
12. [useTransition Hook — isPending의 이중 setState 트릭](#12-usetransition-hook--ispending의-이중-setstate-트릭)
13. [ensureRootIsScheduled — Lane과 Scheduler의 연결점](#13-ensurerootisscheduled--lane과-scheduler의-연결점)
14. [Scheduler 내부 — 두 개의 Min-heap](#14-scheduler-내부--두-개의-min-heap)
15. [scheduleCallback — 작업 등록 전체 흐름](#15-schedulecallback--작업-등록-전체-흐름)
16. [MessageChannel 기반 비동기 스케줄링](#16-messagechannel-기반-비동기-스케줄링)
17. [performWorkUntilDeadline — 작업 루프의 심장](#17-performworkuntildeadline--작업-루프의-심장)
18. [shouldYieldToHost — 5ms 시간 슬라이싱](#18-shouldyieldtohost--5ms-시간-슬라이싱)
19. [continuationCallback — 중단과 재개](#19-continuationcallback--중단과-재개)
20. [SyncLane 특별 처리 — scheduleMicrotask](#20-synclane-특별-처리--schedulemicrotask)
21. [Lane 생명주기 — markRootUpdated에서 markRootFinished까지](#21-lane-생명주기--markrootupdated에서-markrootfinished까지)
22. [전체 흐름 — setState에서 화면 갱신까지](#22-전체-흐름--setstate에서-화면-갱신까지)

---

## 1. 왜 Lane인가 — Expiration에서 Lane으로

React 16의 Fiber 재작성과 함께 등장한 Concurrent Mode는 처음에 **Expiration Time** 기반 우선순위 시스템을 사용했습니다. 각 업데이트는 `currentTime + timeout`으로 계산된 만료 시간을 부여받고, 더 급한 업데이트가 더 작은 만료 시간을 가졌습니다.

그러나 이 시스템에는 치명적인 한계가 있었습니다.

**Expiration Time 방식의 문제:**

```
문제 1: 배치 처리 로직의 복잡성
  expTime1 = 1000ms, expTime2 = 1050ms
  "이 두 업데이트를 같이 처리해야 하는가?"
  → 임의의 임계값(250ms)을 두어 범위 내 업데이트를 묶음 처리
  → 이 임계값이 자의적이고 다양한 엣지 케이스를 만들어냄

문제 2: 동시 업데이트 추적의 어려움
  Concurrent Mode에서는 여러 업데이트가 동시에 진행될 수 있어야 함
  → 단일 숫자로는 "어떤 업데이트들이 현재 진행 중인가?"를 표현할 수 없음

문제 3: 독립 Transition 구별 불가
  탭 A → 탭 B 전환 도중 탭 C로 다시 전환하는 경우
  → A 렌더링 결과를 버리고 C를 렌더해야 하는데
  → Expiration Time으로는 이 두 Transition을 구별할 방법이 없음
```

React 팀은 2020년에 이 시스템을 **Lane 비트마스크**로 전환했습니다. 핵심 인사이트는 단순합니다: **우선순위를 숫자 하나가 아닌 비트 집합으로 표현하면, 여러 업데이트를 동시에 독립적으로 추적할 수 있다.**

```javascript
// Expiration Time 방식: 하나의 숫자
currentTime + timeout = 1050 // 이것 하나로 모든 것을 표현해야 함

// Lane 방식: 비트 집합
pendingLanes = 0b00000000010000000000000001000100
//             TransitionLane8   DefaultLane  InputContinuousLane
//             ↑ 3개의 독립 업데이트가 동시에 진행 중임을 한 변수로 표현
```

---

## 2. 32비트 비트마스크 — Lane 상수 전체 지도

React 18은 32비트 정수 하나로 31개의 독립 우선순위 레벨을 표현합니다. 비트 위치가 낮을수록(오른쪽) 높은 우선순위입니다.

```
비트 위치  30 29 | 28~24  | 23~7         | 6    | 5    | 4    | 3    | 2    | 1    | 0
           Off  | Retry  | Transition    | TransH| DefH | Def  | ICH  | IC   | Sync |SyncH
           Idle | Lanes  | Lanes (1~16) |      |      |      |      |      |      |
```

실제 상수 값 (`react-dom@18.3.1`):

```javascript
// ReactFiberLane.js 실제 값
var NoLanes = 0;
var NoLane  = 0;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 최고 우선순위 — Sync 계열
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
var SyncHydrationLane       =          1; // 0b000...0001  bit 0
var SyncLane                =          2; // 0b000...0010  bit 1

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 높은 우선순위 — 사용자 입력
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
var InputContinuousHydrationLane =     4; // 0b000...0100  bit 2
var InputContinuousLane          =     8; // 0b000...1000  bit 3

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 중간 우선순위 — 기본 렌더
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
var DefaultHydrationLane    =         16; // 0b000...10000  bit 4
var DefaultLane              =         32; // 0b000..100000  bit 5

// Transition Hydration (one lane)
var TransitionHydrationLane  =         64; // bit 6

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 낮은 우선순위 — Transition (16개 풀)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
var TransitionLane1  =       128; // bit 7
var TransitionLane2  =       256; // bit 8
var TransitionLane3  =       512; // bit 9
var TransitionLane4  =      1024; // bit 10
var TransitionLane5  =      2048; // bit 11
var TransitionLane6  =      4096; // bit 12
var TransitionLane7  =      8192; // bit 13
var TransitionLane8  =     16384; // bit 14
var TransitionLane9  =     32768; // bit 15
var TransitionLane10 =     65536; // bit 16
var TransitionLane11 =    131072; // bit 17
var TransitionLane12 =    262144; // bit 18
var TransitionLane13 =    524288; // bit 19
var TransitionLane14 =   1048576; // bit 20
var TransitionLane15 =   2097152; // bit 21
var TransitionLane16 =   4194304; // bit 22

var TransitionLanes = 8388480; // bit 7~22 전체 OR (16개)

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 아주 낮은 우선순위 — Suspense 재시도 (5개)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
var RetryLane1  =   8388608; // bit 23
var RetryLane2  =  16777216; // bit 24
var RetryLane3  =  33554432; // bit 25
var RetryLane4  =  67108864; // bit 26
var RetryLane5  = 134217728; // bit 27

var RetryLanes  = 260046848; // bit 23~27

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 최저 우선순위 — 백그라운드
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
var SelectiveHydrationLane = 268435456; // bit 28
var NonIdleLanes            = 536870911; // bit 0~28 전체 (Idle 제외)
var IdleHydrationLane       = 536870912; // bit 29
var IdleLane                =1073741824; // bit 30
var OffscreenLane           =2147483648; // bit 31 (부호 없는 32비트)
```

### Lane별 용도와 우선순위 해설

| Lane 그룹 | 대표 값 | 할당 시나리오 | 만료 시간 |
|-----------|---------|--------------|-----------|
| **SyncLane** | 2 | `flushSync`, 이산 이벤트(click, keydown) | 즉시 |
| **InputContinuousLane** | 8 | 드래그, 스크롤, mousemove | 250ms |
| **DefaultLane** | 32 | 일반 `setState` | 5000ms |
| **TransitionLanes** | 128~4M | `startTransition` 내부 | 5000ms |
| **RetryLanes** | 8M~134M | Suspense 재시도 | 만료 없음 |
| **IdleLane** | 1073M | 백그라운드 작업 | 만료 없음 |
| **OffscreenLane** | 2147M | Activity/숨김 렌더 | 만료 없음 |

**중요한 수정**: 많은 글에서 `SyncLane = 0b10`이라고 표현하지만, 실제 `react-dom@18.3.1`에서 `SyncLane = 2`이고 `SyncHydrationLane = 1`입니다. 비트 위치 기준으로는 `SyncHydrationLane`이 bit 0으로 가장 높은 우선순위입니다.

---

## 3. getHighestPriorityLane — 2의 보수 트릭

주어진 lanes 집합에서 가장 높은 우선순위(가장 낮은 비트)의 lane 하나를 추출하는 연산입니다.

```javascript
// ReactFiberLane.js (실제 코드)
function getHighestPriorityLane(lanes) {
  return lanes & -lanes;
}
```

단 한 줄이지만 정수 연산의 아름다운 트릭입니다. **2의 보수(Two's Complement)** 성질을 활용합니다.

```
원리:
lanes     = 0b00101100  (= 44, 여러 bit 설정된 상태)
-lanes    = 2의 보수 = ~lanes + 1
            ~0b00101100 = 0b11010011
             0b11010011 + 1 = 0b11010100

lanes & -lanes = 0b00101100
               & 0b11010100
               = 0b00000100  ← 가장 낮은 비트만 남음

실제 예: SyncLane과 DefaultLane이 모두 pending인 경우
pendingLanes = SyncLane | DefaultLane = 2 | 32 = 34
             = 0b00100010

getHighestPriorityLane(34):
  34       = 0b00100010
  -34      = 0b11011110  (2의 보수)
  34 & -34 = 0b00000010  = 2 = SyncLane  ← 더 높은 우선순위(낮은 비트) 추출
```

이 연산은 분기(branch) 없이 **단일 AND 연산**으로 최고 우선순위 lane을 추출합니다. 매 렌더 사이클마다 수백 번 호출되는 핫 패스에서 성능이 중요합니다.

### getHighestPriorityLanes (복수형)

같은 우선순위 그룹의 모든 lane을 반환하는 변형도 있습니다:

```javascript
function getHighestPriorityLanes(lanes) {
  // SyncLane 체크
  switch (getHighestPriorityLane(lanes)) {
    case SyncHydrationLane:
      return SyncHydrationLane;
    case SyncLane:
      return SyncLane;
    case InputContinuousHydrationLane:
      return InputContinuousHydrationLane;
    case InputContinuousLane:
      return InputContinuousLane;
    case DefaultHydrationLane:
      return DefaultHydrationLane;
    case DefaultLane:
      return DefaultLane;
    case TransitionHydrationLane:
      return TransitionHydrationLane;
    case TransitionLane1:
    case TransitionLane2:
    // ... TransitionLane16 까지
      return lanes & TransitionLanes;  // ← Transition은 전체 묶음 반환
    case RetryLane1:
    // ... RetryLane5 까지
      return lanes & RetryLanes;       // ← Retry도 묶음 반환
    // ...
  }
}
```

Transition과 Retry는 개별 lane이 아닌 해당 그룹 전체를 한 번에 반환합니다. 이 그룹들은 유사한 우선순위를 가지므로 함께 처리하는 것이 효율적입니다.

---

## 4. getNextLanes — 다음 렌더 대상 결정 알고리즘

React가 다음 렌더링 사이클에서 어떤 작업을 처리할지 결정하는 핵심 함수입니다.

```javascript
// ReactFiberLane.js 실제 구현 분석
function getNextLanes(root, wipLanes) {
  // ══════════════════════════════════════════════
  // Step 1: 대기 중인 작업이 없으면 조기 종료
  // ══════════════════════════════════════════════
  var pendingLanes = root.pendingLanes;
  if (pendingLanes === NoLanes) {
    return NoLanes;
  }

  var nextLanes = NoLanes;
  var suspendedLanes = root.suspendedLanes;
  var pingedLanes = root.pingedLanes;

  // ══════════════════════════════════════════════
  // Step 2: Non-Idle 작업 처리 (우선순위 높은 쪽)
  // ══════════════════════════════════════════════
  var nonIdlePendingLanes = pendingLanes & NonIdleLanes;
  if (nonIdlePendingLanes !== NoLanes) {

    // 2a. Suspended되지 않은 Non-Idle lanes 우선 처리
    var nonIdleUnblockedLanes = nonIdlePendingLanes & ~suspendedLanes;
    if (nonIdleUnblockedLanes !== NoLanes) {
      nextLanes = getHighestPriorityLanes(nonIdleUnblockedLanes);
    } else {
      // 2b. 모두 Suspended → Pinged된 것 처리 (Promise resolved)
      var nonIdlePingedLanes = nonIdlePendingLanes & pingedLanes;
      if (nonIdlePingedLanes !== NoLanes) {
        nextLanes = getHighestPriorityLanes(nonIdlePingedLanes);
      }
      // 2c. Suspended이고 아직 Ping도 안 받음 → 아무것도 처리 불가
    }
  } else {
    // ══════════════════════════════════════════════
    // Step 3: Idle 전용 작업 처리
    // ══════════════════════════════════════════════
    var unblockedLanes = pendingLanes & ~suspendedLanes;
    if (unblockedLanes !== NoLanes) {
      nextLanes = getHighestPriorityLanes(unblockedLanes);
    } else {
      if (pingedLanes !== NoLanes) {
        nextLanes = getHighestPriorityLanes(pingedLanes);
      }
    }
  }

  if (nextLanes === NoLanes) {
    return NoLanes;
  }

  // ══════════════════════════════════════════════
  // Step 4: 현재 렌더 중인 작업(wipLanes) 인터럽트 여부 결정
  // ══════════════════════════════════════════════
  if (wipLanes !== NoLanes && wipLanes !== nextLanes) {
    var nextLane = getHighestPriorityLane(nextLanes);
    var wipLane  = getHighestPriorityLane(wipLanes);

    if (
      // 새 작업의 우선순위가 현재 작업보다 낮거나 같음
      nextLane >= wipLane ||
      // 예외: DefaultLane은 TransitionLane 작업을 인터럽트하지 않음
      (nextLane === DefaultLane && (wipLane & TransitionLanes) !== NoLanes)
    ) {
      return wipLanes; // 현재 작업 계속 진행 (인터럽트 안 함)
    }
  }

  // ══════════════════════════════════════════════
  // Step 5: InputContinuousLane이 있으면 DefaultLane 배치 처리
  // ══════════════════════════════════════════════
  if ((nextLanes & InputContinuousLane) !== NoLanes) {
    // 연속 입력 처리 시 일반 업데이트도 함께 묶음 처리
    nextLanes |= pendingLanes & DefaultLane;
  }

  // ══════════════════════════════════════════════
  // Step 6: Entanglement 적용
  // ══════════════════════════════════════════════
  var entangledLanes = root.entangledLanes;
  if (entangledLanes !== NoLanes) {
    var entanglements = root.entanglements;
    var lanes = nextLanes & entangledLanes;
    while (lanes > 0) {
      var index = pickArbitraryLaneIndex(lanes);
      var lane = 1 << index;
      nextLanes |= entanglements[index]; // 얽힌 lane들 모두 포함
      lanes &= ~lane;
    }
  }

  return nextLanes;
}
```

### 핵심 결정 흐름도

```
pendingLanes 확인
    │
    ├─ NonIdle lanes 있음?
    │     │
    │     ├─ Unblocked(non-suspended) 있음? → 그 중 최고 우선순위
    │     └─ 전부 Suspended?
    │             └─ Pinged(Promise resolved) 있음? → 그 중 최고 우선순위
    │
    └─ Idle lanes만?
          ├─ Unblocked 있음? → 최고 우선순위
          └─ 전부 Suspended → Pinged 중 선택

nextLanes 결정 후:
    │
    ├─ wipLanes와 충돌?
    │     └─ nextLane >= wipLane → 인터럽트 않고 wipLanes 유지
    │        (DefaultLane은 TransitionLane 인터럽트 안 함)
    │
    ├─ InputContinuousLane → DefaultLane 함께 배치
    │
    └─ Entanglement 추가 (얽힌 lane들 포함)
```

**Step 4의 인터럽트 규칙 상세**:

```
예시: 현재 TransitionLane5 렌더 중에 DefaultLane 업데이트 도착

nextLane = DefaultLane (= 32)
wipLane  = TransitionLane5 (= 2048)

조건: nextLane === DefaultLane && (wipLane & TransitionLanes) !== 0
     32 === 32 && (2048 & TransitionLanes) !== 0  ← 참
→ 인터럽트하지 않음 → TransitionLane5 계속 렌더

이유: DefaultLane 업데이트(일반 setState)가 도착해도
     이미 시작된 Transition 렌더를 중단할 필요가 없음.
     Transition이 완료되면 DefaultLane도 같이 반영됨.
```

---

## 5. requestUpdateLane — 업데이트 Lane 할당 결정 트리

`setState`나 `dispatchSetState`가 호출될 때, 이 업데이트가 어떤 Lane을 받아야 하는지 결정하는 함수입니다.

```javascript
// ReactFiberLane.js 실제 구현
function requestUpdateLane(fiber) {
  var mode = fiber.mode;

  // ══════════════════════════════════════════════
  // Case 1: Legacy Mode (ReactDOM.render)
  // ConcurrentMode 비트가 없으면 항상 SyncLane
  // ══════════════════════════════════════════════
  if ((mode & ConcurrentMode) === NoMode) {
    return SyncLane;
  }

  // ══════════════════════════════════════════════
  // Case 2: 렌더 중 setState (render phase update)
  // ══════════════════════════════════════════════
  if (
    (executionContext & RenderContext) !== NoContext &&
    workInProgressRootRenderLanes !== NoLanes
  ) {
    // 현재 렌더 중인 lane과 동일한 lane 사용
    // → 같은 렌더 패스에서 처리됨 (RE_RENDER_LIMIT 적용)
    return pickArbitraryLane(workInProgressRootRenderLanes);
  }

  // ══════════════════════════════════════════════
  // Case 3: startTransition 컨텍스트 내부
  // ══════════════════════════════════════════════
  var isTransition = requestCurrentTransition() !== NoTransition;
  if (isTransition) {
    if (currentEventTransitionLane === NoLane) {
      // 이 이벤트에서 처음 Transition 요청 → 새 lane 할당
      currentEventTransitionLane = claimNextTransitionLane();
    }
    // 같은 이벤트 내 모든 Transition은 동일 lane 공유
    return currentEventTransitionLane;
  }

  // ══════════════════════════════════════════════
  // Case 4: 명시적 우선순위 설정 (flushSync, batchedUpdates 등)
  // ══════════════════════════════════════════════
  var updateLane = getCurrentUpdatePriority();
  if (updateLane !== NoLane) {
    return updateLane;
  }

  // ══════════════════════════════════════════════
  // Case 5: React 이벤트 핸들러 외부에서 호출
  // DOM 이벤트 타입으로 우선순위 추론
  // ══════════════════════════════════════════════
  var eventLane = getCurrentEventPriority();
  return eventLane;
}
```

### DOM 이벤트 타입 → Lane 매핑

`getCurrentEventPriority()`는 `window.event.type`을 읽어 Lane을 결정합니다:

```javascript
function getEventPriority(domEventName) {
  switch (domEventName) {
    // 이산 이벤트 (Discrete) → SyncLane
    // 사용자가 클릭/타이핑을 기다리므로 즉시 반응해야 함
    case 'click':
    case 'keydown':
    case 'keyup':
    case 'mousedown':
    case 'mouseup':
    case 'touchstart':
    case 'touchend':
    case 'blur':
    case 'focus':
    case 'select':
    case 'submit':
      return DiscreteEventPriority; // = SyncLane

    // 연속 이벤트 (Continuous) → InputContinuousLane
    // 빠르게 계속 발생하므로 배치 처리 가능
    case 'drag':
    case 'dragenter':
    case 'mousemove':
    case 'scroll':
    case 'touchmove':
    case 'wheel':
    case 'pointermove':
      return ContinuousEventPriority; // = InputContinuousLane

    // 기타 → DefaultLane
    default:
      return DefaultEventPriority; // = DefaultLane
  }
}
```

### `getCurrentUpdatePriority` vs `getCurrentEventPriority`

```javascript
// getCurrentUpdatePriority: 코드에서 명시적으로 설정한 우선순위
var currentUpdatePriority = NoLane;

// flushSync가 이것을 설정함
function flushSync(fn) {
  setCurrentUpdatePriority(DiscreteEventPriority); // SyncLane으로 강제
  try {
    return fn(); // fn 내부 setState는 SyncLane 받음
  } finally {
    setCurrentUpdatePriority(previousPriority); // 복구
    flushSyncCallbacks(); // 동기적으로 플러시
  }
}

// getCurrentEventPriority: window.event 읽어서 추론
// → React 이벤트 핸들러 밖에서 setTimeout이나 Promise.then으로
//   setState 호출 시 사용됨 (window.event가 null → DefaultLane)
```

---

## 6. claimNextTransitionLane — 16개 라운드로빈

`startTransition` 내에서 처음 setState를 호출할 때, 이 Transition이 어떤 TransitionLane을 사용할지 결정합니다.

```javascript
// ReactFiberLane.js
var nextTransitionLane = TransitionLane1; // 전역 변수, 128에서 시작

function claimNextTransitionLane() {
  // 현재 lane을 반환하고 다음으로 이동
  var lane = nextTransitionLane;
  nextTransitionLane <<= 1; // 비트를 왼쪽으로 한 칸 시프트

  // TransitionLanes 범위를 벗어나면 처음으로 돌아옴
  if ((nextTransitionLane & TransitionLanes) === 0) {
    nextTransitionLane = TransitionLane1;
  }

  return lane;
}
```

### 라운드로빈 시각화

```
순환 순서: 128 → 256 → 512 → ... → 4194304 → 128 → ...

사용 예:
  이벤트1의 startTransition → TransitionLane1 (128)
  이벤트2의 startTransition → TransitionLane2 (256)
  이벤트3의 startTransition → TransitionLane3 (512)
  ...
  이벤트17의 startTransition → TransitionLane1 (128) ← 재사용 시작

동일 이벤트 내 여러 startTransition:
  onClick: {
    startTransition(A) → currentEventTransitionLane = TransitionLane5
    startTransition(B) → currentEventTransitionLane 재사용 = TransitionLane5
  }
  // 이벤트 종료 후 currentEventTransitionLane = NoLane 리셋

다음 onClick:
    startTransition(C) → claimNextTransitionLane() = TransitionLane6 (새 lane)
```

### 왜 16개인가?

```
TransitionLane 개수 선택의 이유:

1. 32비트 중 할당 가능한 비트 수 제한
   SyncLane, InputContinuous, Default, Retry(5개), Idle, Offscreen 등
   기타 lane에 할당하고 남은 비트 중 16개를 Transition에 배정

2. 동시 독립 Transition 추적의 실용적 한계
   16개 풀이 소진되기 전에 이전 Transition들이 완료되는 것이 일반적

3. Starvation 방지
   16개 순환 시 같은 lane이 재사용되기 전
   최소 15개의 다른 Transition이 먼저 처리될 기회를 가짐
```

---

## 7. markUpdateLaneFromFiberToRoot — childLanes 전파

`setState`가 발생한 Fiber에서 루트까지 모든 조상 Fiber의 `childLanes`를 업데이트합니다. 이 전파가 React의 **선택적 렌더링**을 가능하게 하는 핵심 메커니즘입니다.

```javascript
// ReactFiberLane.js
function markUpdateLaneFromFiberToRoot(sourceFiber, lane) {
  // ① 업데이트 발생 Fiber 자신의 lanes 업데이트
  sourceFiber.lanes = mergeLanes(sourceFiber.lanes, lane);
  var alternate = sourceFiber.alternate;
  if (alternate !== null) {
    alternate.lanes = mergeLanes(alternate.lanes, lane); // WIP도 동일하게
  }

  // ② 루트까지 올라가며 모든 조상의 childLanes 업데이트
  var node = sourceFiber;
  var parent = sourceFiber.return;

  while (parent !== null) {
    parent.childLanes = mergeLanes(parent.childLanes, lane);
    var alternate = parent.alternate;
    if (alternate !== null) {
      alternate.childLanes = mergeLanes(alternate.childLanes, lane);
    }
    node = parent;
    parent = parent.return;
  }

  // ③ HostRoot 도달 시 FiberRoot 반환
  if (node.tag === HostRoot) {
    var root = node.stateNode;
    return root;
  }
  return null;
}
```

### childLanes의 역할: 서브트리 건너뛰기

```
FiberRoot
    └─ HostRoot Fiber [childLanes |= lane]
           └─ App Fiber [childLanes |= lane]
                  └─ Layout Fiber [childLanes |= lane]
                         ├─ Sidebar Fiber [childLanes = 0] ← 업데이트 없음
                         └─ Content Fiber [childLanes |= lane]
                                └─ Button Fiber [lanes |= lane] ← setState 발생
```

렌더링 중 `beginWork`가 각 Fiber를 방문할 때:

```javascript
function beginWork(current, workInProgress, renderLanes) {
  // childLanes와 renderLanes에 교집합이 없으면
  // 이 서브트리 전체를 재귀 없이 즉시 건너뜀 (bailout)
  if (
    !includesSomeLane(renderLanes, workInProgress.childLanes) &&
    !includesSomeLane(renderLanes, workInProgress.lanes)
  ) {
    return null; // 이 Fiber 아래 모든 것을 스킵
  }
  // ... 실제 렌더링
}
```

`Sidebar Fiber`의 `childLanes = 0`이므로 해당 서브트리는 완전히 건너뜁니다. 이것이 React가 전체 트리를 순회하지 않고 변경된 부분만 재렌더하는 실제 메커니즘입니다.

### 비트 연산 유틸리티

```javascript
// Lane 집합 연산
function mergeLanes(a, b)        { return a | b;   }  // 합집합: lane 추가
function removeLanes(set, subset){ return set & ~subset; } // 차집합: lane 제거
function intersectLanes(a, b)    { return a & b;   }  // 교집합
function includesSomeLane(a, b)  { return (a & b) !== NoLanes; } // 교집합 비어있지 않음?
function isSubsetOfLanes(set, subset) { return (set & subset) === subset; } // 부분집합?
```

---

## 8. Lane Entanglement — 업데이트를 묶는 메커니즘

Entanglement는 "이 lane들은 반드시 같은 렌더 배치에서 함께 처리되어야 한다"는 제약입니다. 중간 상태를 사용자에게 노출하지 않기 위한 안전장치입니다.

### FiberRoot의 Entanglement 관련 필드

```typescript
type FiberRoot = {
  // 얽혀있는 lane들의 합집합
  entangledLanes: Lanes;

  // 인덱스 = lane의 비트 위치
  // 값 = 이 lane과 함께 처리되어야 할 lane들의 집합
  entanglements: LaneMap<Lanes>; // 31개 원소 배열
};
```

### markRootEntangled 전체 구현

```javascript
// ReactFiberLane.js
function markRootEntangled(root, entangledLanes) {
  // 1. root의 entangledLanes 갱신
  var rootEntangledLanes = (root.entangledLanes |= entangledLanes);

  // 2. entanglements 배열 업데이트
  var entanglements = root.entanglements;
  var lanes = rootEntangledLanes;

  while (lanes > 0) {
    var index = pickArbitraryLaneIndex(lanes); // CTZ(Counting Trailing Zeros)
    var lane = 1 << index;

    // 조건 1: 이 lane이 새로 얽힌 lane들 중 하나이거나
    // 조건 2: 이미 이 lane과 얽혀있던 lane이 새 entangledLanes와 겹치는 경우
    //         → 전이적(Transitive) Entanglement
    if (
      (lane & entangledLanes) !== 0 ||
      (entanglements[index] & entangledLanes) !== 0
    ) {
      entanglements[index] |= entangledLanes;
    }

    lanes &= ~lane; // 처리한 lane 제거
  }
}
```

### 전이적 Entanglement 예제

```
Step 1: markRootEntangled(root, A | B)
  → entanglements[A] = A | B
  → entanglements[B] = A | B

Step 2: markRootEntangled(root, B | C)
  rootEntangledLanes = A | B | C

  lane=A 처리:
    (A & (B|C)) = 0          ← A는 새 entangledLanes에 없음
    (entanglements[A] & (B|C)) = (A|B) & (B|C) = B ≠ 0  ← 전이!
    → entanglements[A] |= (B|C)
    → entanglements[A] = A | B | C  ← A가 C와도 얽힘!

  lane=B, C: 유사하게 처리

결과: A, B, C 중 어느 하나를 렌더할 때 나머지 모두 포함
```

### 실제 Entanglement 발생 시나리오

**Transition 간 Entanglement**:

```javascript
// dispatchSetState에서 호출 (useReducer/useState)
function entangleTransitionUpdate(root, queue, lane) {
  if (isTransitionLane(lane)) {
    var queueLanes = queue.lanes;
    // 이미 처리된 lane은 제거 (GC)
    queueLanes = intersectLanes(queueLanes, root.pendingLanes);

    // 현재 update lane과 queue의 기존 Transition lane들 합집합
    var newQueueLanes = mergeLanes(queueLanes, lane);
    queue.lanes = newQueueLanes;

    // 동일 상태 큐를 업데이트하는 모든 Transition을 묶음
    markRootEntangled(root, newQueueLanes);
  }
}
```

```
탭 전환 시나리오:
  t=0:    startTransition(() => setTab('A'))  → TransitionLane1
          queue.lanes = TransitionLane1

  t=50ms: startTransition(() => setTab('B'))  → TransitionLane2
          newQueueLanes = TransitionLane1 | TransitionLane2
          markRootEntangled → 두 lane 얽힘

  결과: TransitionLane1 렌더 시 TransitionLane2도 포함
       → 탭 A 중간 상태를 스킵하고 탭 B로 직행
```

**Hydration Entanglement**:

```javascript
// Hydration 중 SyncHydrationLane과 SyncLane을 묶음
markRootEntangled(root, SyncHydrationLane | SyncLane);

// 이유: SSR hydration 도중 click 이벤트 발생 시
// hydration 완료와 이벤트 처리를 같은 배치로 묶어
// 반쪽만 hydrated된 상태에서 이벤트가 처리되는 것 방지
```

### getEntangledLanes — nextLanes에 Entanglement 반영

```javascript
// getNextLanes의 마지막 단계에서 호출
function getEntangledLanes(root, renderLanes) {
  var entangledLanes = renderLanes;

  if (
    root.entangledLanes !== NoLanes &&
    (root.entangledLanes & renderLanes) !== NoLanes
  ) {
    var entanglements = root.entanglements;
    var lanes = entangledLanes & root.entangledLanes;

    // renderLanes에 포함된 각 entangled lane의 파트너들 추가
    while (lanes > 0) {
      var index = pickArbitraryLaneIndex(lanes);
      var lane = 1 << index;
      entangledLanes |= entanglements[index]; // 얽힌 lane 모두 포함
      lanes &= ~lane;
    }
  }

  return entangledLanes;
}
```

---

## 9. 기아 방지 — markStarvedLanesAsExpired

Concurrent Mode에서 고우선순위 업데이트가 계속 들어오면, 낮은 우선순위의 Transition 업데이트가 무한정 처리되지 못하는 **기아(Starvation)** 문제가 발생할 수 있습니다.

React는 각 lane에 만료 시간을 부여하여 이를 방지합니다.

### computeExpirationTime — Lane별 만료 시간

```javascript
// ReactFiberLane.js
function computeExpirationTime(lane, currentTime) {
  switch (lane) {
    case SyncHydrationLane:
    case SyncLane:
    case InputContinuousHydrationLane:
    case InputContinuousLane:
      // 동기 계열: 0ms (현재 즉시 만료 상태)
      return currentTime + 0;

    case DefaultHydrationLane:
    case DefaultLane:
    case TransitionHydrationLane:
    case TransitionLane1:
    case TransitionLane2:
    // ... TransitionLane16까지:
      // Transition/Default: 5초 후 만료
      return currentTime + 5000;

    case RetryLane1:
    // ... RetryLane5까지:
      return NoTimestamp; // Retry: 만료 없음 (Suspense가 별도 관리)

    case SelectiveHydrationLane:
    case IdleHydrationLane:
    case IdleLane:
    case OffscreenLane:
      return NoTimestamp; // Idle: 만료 없음
  }
}
```

### markStarvedLanesAsExpired — 전체 구현

```javascript
// ReactFiberLane.js
function markStarvedLanesAsExpired(root, currentTime) {
  var pendingLanes = root.pendingLanes;
  var suspendedLanes = root.suspendedLanes;
  var pingedLanes = root.pingedLanes;
  var expirationTimes = root.expirationTimes;

  var lanes = pendingLanes;

  while (lanes > 0) {
    var index = pickArbitraryLaneIndex(lanes);
    var lane = 1 << index;
    var expirationTime = expirationTimes[index];

    if (expirationTime === NoTimestamp) {
      // 만료 시간이 아직 설정되지 않은 경우
      // 조건: Suspended 상태가 아니거나, Pinged된 경우
      if (
        (lane & suspendedLanes) === NoLanes ||
        (lane & pingedLanes) !== NoLanes
      ) {
        // 지금부터 카운트다운 시작
        expirationTimes[index] = computeExpirationTime(lane, currentTime);
      }
      // 주의: Suspended 상태에서는 타이머를 시작하지 않음
      // 데이터가 없는 상태에서 강제 처리해봤자 의미없으므로
    } else if (expirationTime <= currentTime) {
      // 만료 초과! expiredLanes에 추가
      root.expiredLanes |= lane;
    }

    lanes &= ~lane;
  }
}
```

### 만료 처리 타임라인

```
t=0ms:    startTransition(() => setList(bigData))
          TransitionLane5 할당
          pendingLanes |= TransitionLane5
          expirationTimes[5] = NoTimestamp

t=1ms:    고우선순위 click 이벤트 → SyncLane 처리
          markStarvedLanesAsExpired(root, 1):
            TransitionLane5: expirationTime = NoTimestamp
            → suspended 아님 → 타이머 시작
            expirationTimes[5] = 1 + 5000 = 5001ms

t=500ms:  또 다른 SyncLane 업데이트
          markStarvedLanesAsExpired(root, 500):
            expirationTimes[5] = 5001 > 500 → 아직 살아있음

t=5001ms: markStarvedLanesAsExpired(root, 5001):
           expirationTimes[5] = 5001 <= 5001 → 만료!
           root.expiredLanes |= TransitionLane5

t=5002ms: getNextLanes() → expiredLanes 체크
           → TransitionLane5 발견
           performConcurrentWorkOnRoot에서:
             includesExpiredLane → shouldTimeSlice = false
           → renderRootSync 강제 (time-slicing 없이 즉시 완료)
```

### Suspended 상태의 타이머 중지

```javascript
// markRootSuspended: Suspense throw 시 호출
function markRootSuspended(root, suspendedLanes) {
  root.suspendedLanes |= suspendedLanes;
  root.expiredLanes &= ~suspendedLanes;

  // 만료 타이머 초기화 (데이터 없이 강제 처리 불가)
  var expirationTimes = root.expirationTimes;
  var lanes = suspendedLanes;
  while (lanes > 0) {
    var index = pickArbitraryLaneIndex(lanes);
    var lane = 1 << index;
    expirationTimes[index] = NoTimestamp; // 타이머 중지
    lanes &= ~lane;
  }
}

// markRootPinged: Promise resolve 시 호출
function markRootPinged(root, pingedLanes) {
  // suspendedLanes 중 pinged된 것만 pingedLanes로 이동
  root.pingedLanes |= root.suspendedLanes & pingedLanes;
  // → 이후 markStarvedLanesAsExpired에서 타이머 재시작
}
```

---

## 10. Concurrent Mode 인터럽트 — prepareFreshStack

고우선순위 업데이트가 도착하면 진행 중인 낮은 우선순위 렌더를 중단하고, WIP 트리를 버리고 새로 시작합니다.

```javascript
// ReactFiberWorkLoop.js
function prepareFreshStack(root, lanes) {
  root.finishedWork = null;
  root.finishedLanes = NoLanes;

  // 현재 진행 중인 timeout 취소
  var timeoutHandle = root.timeoutHandle;
  if (timeoutHandle !== noTimeout) {
    root.timeoutHandle = noTimeout;
    cancelTimeout(timeoutHandle);
  }

  // 이전 WIP 트리의 Context, Suspense 경계 정리
  if (workInProgress !== null) {
    var interruptedWork = workInProgress.return;
    while (interruptedWork !== null) {
      var current = interruptedWork.alternate;
      // Context 스택, Suspense 카운터 등 정리
      unwindInterruptedWork(current, interruptedWork, workInProgressRootRenderLanes);
      interruptedWork = interruptedWork.return;
    }
  }

  // WIP 루트를 새 root로 설정
  workInProgressRoot = root;
  var rootWorkInProgress = createWorkInProgress(root.current, null);
  workInProgress = rootWorkInProgress;

  // ══ 핵심: 새 render lanes 설정 ══
  workInProgressRootRenderLanes = lanes;
  workInProgressRootExitStatus = RootInProgress;
  workInProgressRootInterleavedUpdatedLanes = NoLanes;
  workInProgressRootPingedLanes = NoLanes;
  workInProgressRootConcurrentErrors = null;

  return rootWorkInProgress;
}
```

### workInProgressRootInterleavedUpdatedLanes의 역할

```javascript
// 렌더 중 도착한 인터리브 업데이트 추적
var workInProgressRootInterleavedUpdatedLanes = NoLanes;

// 새 업데이트 도착 시 기록
function scheduleUpdateOnFiber(root, fiber, lane) {
  if (root === workInProgressRoot) {
    // 현재 렌더 중인 root에 새 업데이트 도착
    workInProgressRootInterleavedUpdatedLanes = mergeLanes(
      workInProgressRootInterleavedUpdatedLanes,
      lane
    );

    // 새 lane의 우선순위가 더 높으면 → prepareFreshStack으로 재시작
  }
}
```

### workLoopConcurrent — 인터럽트 가능한 렌더 루프

```javascript
function workLoopConcurrent() {
  // shouldYield()가 true를 반환하면 즉시 루프 탈출
  // → 더 높은 우선순위 작업이 실행될 기회
  while (workInProgress !== null && !shouldYield()) {
    performUnitOfWork(workInProgress);
  }
}

// performConcurrentWorkOnRoot에서의 처리
function performConcurrentWorkOnRoot(root, didTimeout) {
  // 인터럽트 감지: 렌더 중 더 높은 우선순위 업데이트 도착 확인
  if (
    workInProgressRootRenderLanes !== getNextLanes(root, workInProgressRootRenderLanes)
  ) {
    // 우선순위 변경 → prepareFreshStack으로 처음부터 재시작
    prepareFreshStack(root, getNextLanes(root, NoLanes));
  }

  var shouldTimeSlice =
    !includesBlockingLane(root, lanes) &&
    !includesExpiredLane(root, lanes) &&
    !didTimeout;

  var exitStatus = shouldTimeSlice
    ? renderRootConcurrent(root, lanes)  // 중단 가능
    : renderRootSync(root, lanes);        // 동기 완료 강제

  if (exitStatus === RootInProgress) {
    // shouldYield로 인해 중단됨 → continuation 반환
    return performConcurrentWorkOnRoot.bind(null, root);
  }

  // 완료 처리...
  return null;
}
```

---

## 11. startTransition 내부 구현

```javascript
// react/src/ReactStartTransition.js
function startTransition(scope, options) {
  var prevTransition = ReactCurrentBatchConfig.transition;

  // 핵심: 이 플래그가 null이 아닌 동안
  // requestUpdateLane이 TransitionLane을 할당함
  ReactCurrentBatchConfig.transition = {};

  var currentTransition = ReactCurrentBatchConfig.transition;

  try {
    scope(); // 사용자 코드 실행
             // 이 안에서 발생하는 모든 setState → TransitionLane
  } finally {
    // 플래그 복구
    ReactCurrentBatchConfig.transition = prevTransition;
  }
}

// requestCurrentTransition(): 현재 Transition 컨텍스트 반환
function requestCurrentTransition() {
  return ReactCurrentBatchConfig.transition;
}
```

### Transition 중첩 처리

```javascript
startTransition(() => {
  // prevTransition = null
  // ReactCurrentBatchConfig.transition = {} (객체 A)

  startTransition(() => {
    // prevTransition = 객체 A
    // ReactCurrentBatchConfig.transition = {} (객체 B)

    setState(inner); // TransitionLane 할당

  }); // finally: ReactCurrentBatchConfig.transition = 객체 A (복구)

  setState(outer); // 여전히 Transition! (객체 A가 활성)

}); // finally: ReactCurrentBatchConfig.transition = null (완전 복구)
```

중첩 `startTransition`은 올바르게 동작합니다. 내부 finally가 외부 transition 객체를 복구하므로, 외부 블록 전체가 Transition으로 처리됩니다.

---

## 12. useTransition Hook — isPending의 이중 setState 트릭

`useTransition`은 `startTransition`에 `isPending` 상태를 결합합니다. 내부 구현에 흥미로운 트릭이 있습니다.

```javascript
// ReactFiberHooks.js

// Mount 시
function mountTransition() {
  var _useState = mountState(false);    // isPending 상태 초기화
  var isPending = _useState[0];
  var setPending = _useState[1];

  // startTransition 함수 생성 (fiber 참조 없는 안정적 함수)
  var start = startTransitionWithPending.bind(null, setPending);

  var hook = mountWorkInProgressHook();
  hook.memoizedState = start;

  return [isPending, start];
}

// useTransition의 startTransition 구현
function startTransitionWithPending(setPending, scope) {
  // ① isPending = true를 SyncLane으로 즉시 처리
  //    → 사용자가 로딩 중임을 즉시 인지
  setPending(true);

  var prevTransition = ReactCurrentBatchConfig.transition;
  ReactCurrentBatchConfig.transition = {};

  try {
    // ② isPending = false를 TransitionLane으로 처리
    //    → 콘텐츠 준비 완료 후에만 스피너 사라짐
    setPending(false);

    // ③ 실제 내용 업데이트도 TransitionLane
    scope();
  } finally {
    ReactCurrentBatchConfig.transition = prevTransition;
  }
}
```

### isPending의 이중 setState 타임라인

```
t=0:   버튼 클릭 → startTransition 실행

       setPending(true)   → SyncLane
         (즉시 처리: isPending = true → 스피너 표시)

       [Transition 컨텍스트 시작]
       setPending(false)  → TransitionLane5
       scope()            → TransitionLane5

       [entangleTransitions 발생]
       → setPending(false)의 lane과 scope()의 lane이 얽힘

t=즉시: isPending = true 렌더 완료 (SyncLane)
        사용자에게 로딩 스피너 즉시 표시

t=?:   scope()의 내용 렌더 완료 (TransitionLane5)
t=?+1: setPending(false) 처리 (entangled, 같은 배치)
        → isPending = false → 스피너 사라짐, 새 콘텐츠 표시

보장: 콘텐츠 준비 전에 스피너가 절대 사라지지 않음
     (entanglement가 이 순서를 강제)
```

---

## 13. ensureRootIsScheduled — Lane과 Scheduler의 연결점

Lane 시스템과 Scheduler 패키지를 연결하는 핵심 함수입니다. 어떤 우선순위로 언제 렌더링을 시작할지 결정합니다.

```javascript
// ReactFiberWorkLoop.js
function ensureRootIsScheduled(root, currentTime) {
  // 만료 lane 체크
  markStarvedLanesAsExpired(root, currentTime);

  // 다음 처리할 lane 결정
  var nextLanes = getNextLanes(root, workInProgressRootRenderLanes);

  if (nextLanes === NoLanes) {
    // 할 일 없음
    root.callbackNode = null;
    root.callbackPriority = NoLane;
    return;
  }

  var newCallbackPriority = getHighestPriorityLane(nextLanes);
  var existingCallbackPriority = root.callbackPriority;

  // 이미 같은 우선순위로 스케줄되어 있으면 재사용
  if (existingCallbackPriority === newCallbackPriority) {
    return;
  }

  // 기존 콜백 취소 (우선순위 변경)
  if (existingCallbackPriority !== NoLane) {
    cancelCallback(root.callbackNode);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SyncLane: Scheduler 우회, 마이크로태스크 사용
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (newCallbackPriority === SyncLane) {
    scheduleSyncCallback(performSyncWorkOnRoot.bind(null, root));
    scheduleMicrotask(flushSyncCallbacks);
    root.callbackNode = null;
    root.callbackPriority = SyncLane;
    return;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 그 외: Scheduler에 등록
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  var schedulerPriorityLevel = lanesToEventPriority(nextLanes);
  var newCallbackNode = scheduleCallback(
    schedulerPriorityLevel,
    performConcurrentWorkOnRoot.bind(null, root)
  );

  root.callbackNode = newCallbackNode;
  root.callbackPriority = newCallbackPriority;
}
```

### Lane → Scheduler Priority 매핑

```javascript
function lanesToEventPriority(lanes) {
  var lane = getHighestPriorityLane(lanes);

  if (!isHigherEventPriority(DiscreteEventPriority, lane)) {
    return DiscreteEventPriority;  // → ImmediateSchedulerPriority (1)
  }
  if (!isHigherEventPriority(ContinuousEventPriority, lane)) {
    return ContinuousEventPriority; // → UserBlockingSchedulerPriority (2)
  }
  if (includesNonIdleWork(lane)) {
    return DefaultEventPriority;   // → NormalSchedulerPriority (3)
  }
  return IdleEventPriority;        // → IdleSchedulerPriority (5)
}
```

전체 매핑 테이블:

```
Lane                            EventPriority               Scheduler Priority  timeout
────────────────────────────────────────────────────────────────────────────────────────
SyncLane                     → (마이크로태스크 직접)         → N/A
SyncHydrationLane            → DiscreteEventPriority      → Immediate (1)       -1ms
InputContinuousHydrationLane → ContinuousEventPriority    → UserBlocking (2)    250ms
InputContinuousLane          → ContinuousEventPriority    → UserBlocking (2)    250ms
DefaultLane                  → DefaultEventPriority       → Normal (3)          5000ms
TransitionLane1~16           → DefaultEventPriority       → Normal (3)          5000ms
RetryLane1~5                 → DefaultEventPriority       → Normal (3)          5000ms
IdleLane                     → IdleEventPriority          → Idle (5)            무한
OffscreenLane                → IdleEventPriority          → Idle (5)            무한
```

---

## 14. Scheduler 내부 — 두 개의 Min-heap

`scheduler` 패키지는 React와 독립적인 우선순위 태스크 스케줄러입니다. 핵심은 **두 개의 Min-heap**입니다.

```javascript
// Scheduler.js 전역 상태
var taskQueue  = []; // 즉시 실행 가능한 태스크 (sortIndex = expirationTime)
var timerQueue = []; // delay 때문에 아직 시작 못한 태스크 (sortIndex = startTime)

var taskIdCounter = 1;
var currentTask = null;
var currentPriorityLevel = NormalPriority;

var isPerformingWork = false;
var isHostCallbackScheduled = false;
var isHostTimeoutScheduled = false;
var needsPaint = false;

var frameInterval = 5; // 5ms 시간 슬라이스
var startTime = -1;    // 현재 작업 배치 시작 시각
```

### Min-heap 구현

```javascript
// 배열 기반 이진 힙 (인덱스 0이 루트)
// 부모 인덱스: (i - 1) >>> 1
// 왼쪽 자식:  2 * (i + 1) - 1
// 오른쪽 자식: 2 * (i + 1)

function push(heap, node) {
  var index = heap.length;
  heap.push(node);
  // Sift-up: 부모보다 작으면 교환 (Min-heap 성질 유지)
  a: for (; index > 0; ) {
    var parentIndex = (index - 1) >>> 1; // 논리적 우측 시프트 = floor((i-1)/2)
    var parent = heap[parentIndex];
    if (0 < compare(parent, node)) {     // 부모 > 현재 → 교환
      heap[parentIndex] = node;
      heap[index] = parent;
      index = parentIndex;
    } else break a;
  }
}

function pop(heap) {
  if (heap.length === 0) return null;
  var first = heap[0];      // 최솟값 저장
  var last = heap.pop();    // 마지막 요소 추출
  if (last !== first) {
    heap[0] = last;         // 마지막을 루트로
    // Sift-down: 자식보다 크면 교환
    siftDown(heap, last, 0);
  }
  return first;
}

function compare(a, b) {
  var diff = a.sortIndex - b.sortIndex;
  return diff !== 0 ? diff : a.id - b.id; // 동점 시 ID로 결정 (FIFO)
}
```

### 두 큐의 역할 분리

```
timerQueue                    taskQueue
(sortIndex = startTime)       (sortIndex = expirationTime)
┌─────────────────────┐       ┌─────────────────────────┐
│ startTime: 2000ms   │       │ expTime: -1ms  ← Immediate 최우선
│ startTime: 5000ms   │  ─→   │ expTime: 300ms
│ startTime: 10000ms  │       │ expTime: 5200ms
└─────────────────────┘       └─────────────────────────┘
         ↑                               ↑
  requestHostTimeout             MessageChannel 루프
  (setTimeout으로 깨우기)         (5ms마다 실행)

advanceTimers(): timerQueue에서 startTime <= currentTime인 태스크를
                 taskQueue로 승격
```

---

## 15. scheduleCallback — 작업 등록 전체 흐름

```javascript
// Scheduler.js - unstable_scheduleCallback
function unstable_scheduleCallback(priorityLevel, callback, options) {
  var currentTime = unstable_now(); // performance.now()

  // ① startTime 계산 (delay 옵션 처리)
  var startTime;
  if (typeof options === 'object' && options !== null) {
    var delay = options.delay;
    startTime = (typeof delay === 'number' && delay > 0)
      ? currentTime + delay
      : currentTime;
  } else {
    startTime = currentTime;
  }

  // ② 우선순위별 timeout 계산
  var timeout;
  switch (priorityLevel) {
    case ImmediatePriority:      timeout = -1;         break; // 즉시 만료
    case UserBlockingPriority:   timeout = 250;        break;
    case IdlePriority:           timeout = 1073741823; break; // 사실상 무한
    case LowPriority:            timeout = 10000;      break;
    default:                     timeout = 5000;              // NormalPriority
  }

  // ③ 만료 시간 = 시작 시간 + timeout
  var expirationTime = startTime + timeout;

  // ④ 태스크 객체 생성
  var newTask = {
    id:             taskIdCounter++,
    callback:       callback,
    priorityLevel:  priorityLevel,
    startTime:      startTime,
    expirationTime: expirationTime,
    sortIndex:      -1
  };

  // ⑤ 큐 배치 결정
  if (startTime > currentTime) {
    // delay가 있는 태스크 → timerQueue
    newTask.sortIndex = startTime;
    push(timerQueue, newTask);

    // taskQueue가 비었고 이 태스크가 timerQueue 최소값이면
    // setTimeout으로 깨우기 예약
    if (peek(taskQueue) === null && newTask === peek(timerQueue)) {
      if (isHostTimeoutScheduled) {
        cancelHostTimeout();
      }
      isHostTimeoutScheduled = true;
      requestHostTimeout(handleTimeout, startTime - currentTime);
    }
  } else {
    // 즉시 실행 태스크 → taskQueue
    newTask.sortIndex = expirationTime;
    push(taskQueue, newTask);

    // MessageChannel 루프 시작 (아직 안 실행 중이면)
    if (!isHostCallbackScheduled && !isPerformingWork) {
      isHostCallbackScheduled = true;
      requestHostCallback();
    }
  }

  return newTask;
}
```

### ImmediatePriority의 음수 timeout 트릭

```
ImmediatePriority: timeout = -1

currentTime = 1000ms
startTime   = 1000ms (delay 없음)
expirationTime = 1000 + (-1) = 999ms

→ 태스크 생성 직후부터 999ms < 1000ms → 이미 만료!

workLoop에서:
  callback(expirationTime <= currentTime)
           ↑ true → didTimeout = true

→ ImmediatePriority 태스크는 생성 즉시 만료 상태로 실행
  shouldYield()를 무시하고 강제 처리
```

---

## 16. MessageChannel 기반 비동기 스케줄링

브라우저 환경에서 Scheduler는 `setTimeout(fn, 0)` 대신 **MessageChannel**을 사용합니다.

```javascript
// Scheduler.js
var channel = new MessageChannel();
var port = channel.port2;
channel.port1.onmessage = performWorkUntilDeadline;

function schedulePerformWorkUntilDeadline() {
  port.postMessage(null); // 이것이 전부
}

// Node.js 환경에서는 setImmediate 사용
// 폴백으로 setTimeout
```

### MessageChannel을 선택한 이유

```
setTimeout(fn, 0)의 문제:
  - W3C 스펙: 중첩 호출 5회 이상 시 최소 4ms 강제 지연
  - 실제 측정: 4~8ms 지연 발생
  - 5ms 슬라이스 계획 중 4ms를 콜백 대기로 소모
  - 결과: 실제 React 작업에 1ms만 남음

requestAnimationFrame의 문제:
  - 브라우저 페인트 사이클(~16.67ms)에 묶임
  - 페인트와 무관한 작업도 16ms마다만 실행 가능
  - 백그라운드 탭에서 실행 안 됨 또는 매우 느림

MessageChannel의 장점:
  - macrotask이지만 타이머 스로틀링 없음
  - 지연: ~0.1ms (이벤트 루프의 다음 macrotask)
  - 5ms 슬라이스를 온전히 React 작업에 활용
  - 페인트와 독립적으로 실행
```

### 이벤트 루프에서의 위치

```
이벤트 루프 한 사이클:
┌──────────────────────────────────────────────────────────┐
│  1. macrotask 하나 실행                                    │
│     (MessageChannel onmessage = performWorkUntilDeadline) │
│     → 최대 5ms 동안 React Fiber 처리                       │
│                                                          │
│  2. microtask 큐 소진                                     │
│     (Promise.then, queueMicrotask)                        │
│                                                          │
│  3. 렌더링 기회                                           │
│     (스타일 재계산, 레이아웃, 페인트)                        │
│                                                          │
│  4. 다음 macrotask                                        │
│     (다음 MessageChannel 메시지 = 다음 React 배치)          │
└──────────────────────────────────────────────────────────┘

결과:
  - React 작업과 브라우저 렌더링이 교대로 실행
  - 각 React 배치는 5ms를 초과하지 않음
  - 브라우저가 매 배치 후 렌더링 기회를 얻음
  - 60fps 달성 가능 (16.67ms 프레임 예산 내에 렌더 완료)
```

---

## 17. performWorkUntilDeadline — 작업 루프의 심장

```javascript
// Scheduler.js
function performWorkUntilDeadline() {
  needsPaint = false;

  if (isMessageLoopRunning) {
    var currentTime = unstable_now();
    startTime = currentTime; // shouldYieldToHost 기준점 갱신

    var hasMoreWork = true;
    try {
      a: {
        isHostCallbackScheduled = false;

        // 예약된 timeout 취소 (지금 직접 처리할 것이므로)
        if (isHostTimeoutScheduled) {
          isHostTimeoutScheduled = false;
          cancelHostTimeout();
        }

        isPerformingWork = true;
        var previousPriorityLevel = currentPriorityLevel;

        try {
          b: {
            // 배치 시작 시 timerQueue → taskQueue 승격 확인
            advanceTimers(currentTime);

            // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            // 핵심 workLoop
            // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            for (
              currentTask = peek(taskQueue);
              currentTask !== null &&
              !(
                currentTask.expirationTime > currentTime && // 아직 만료 안 됨
                shouldYieldToHost()                         // AND 5ms 초과
              );
            ) {
              var callback = currentTask.callback;

              if (typeof callback === 'function') {
                currentTask.callback = null;
                currentPriorityLevel = currentTask.priorityLevel;

                // didTimeout: expirationTime <= currentTime
                var continuationCallback = callback(
                  currentTask.expirationTime <= currentTime
                );

                currentTime = unstable_now();

                if (typeof continuationCallback === 'function') {
                  // 작업 미완료 → continuation으로 재시작
                  currentTask.callback = continuationCallback;
                  advanceTimers(currentTime);
                  hasMoreWork = true;
                  break b;
                }

                // 완료: taskQueue에서 제거
                if (currentTask === peek(taskQueue)) {
                  pop(taskQueue);
                }
                advanceTimers(currentTime);
              } else {
                // callback === null → 취소된 태스크
                pop(taskQueue);
              }

              currentTask = peek(taskQueue);
            }

            // 루프 종료 판단
            if (currentTask !== null) {
              hasMoreWork = true;  // shouldYield로 중단 → 더 있음
            } else {
              // taskQueue 비었음 → timerQueue 확인 후 timeout 예약
              var firstTimer = peek(timerQueue);
              if (firstTimer !== null) {
                requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
              }
              hasMoreWork = false;
            }
          }
          break a;
        } finally {
          currentTask = null;
          currentPriorityLevel = previousPriorityLevel;
          isPerformingWork = false;
        }
      }
    } finally {
      if (hasMoreWork) {
        schedulePerformWorkUntilDeadline(); // 다음 MessageChannel 예약
      } else {
        isMessageLoopRunning = false; // 루프 종료
      }
    }
  }
}
```

### 중단 조건의 논리 분석

```javascript
!(
  currentTask.expirationTime > currentTime && // 조건 A: 아직 만료 안 됨
  shouldYieldToHost()                          // 조건 B: 5ms 초과
)
```

드모르간의 법칙: `!(A && B)` = `!A || !B`

- `!A`: `expirationTime <= currentTime` → 만료됨 → **절대 양보하지 않고 즉시 실행**
- `!B`: `shouldYieldToHost() === false` → 아직 5ms 이내 → **계속 실행**

즉: **만료된 태스크는 시간 슬라이스를 무시하고 강제 실행됩니다.** ImmediatePriority 태스크가 생성 즉시 만료 상태인 이유입니다.

---

## 18. shouldYieldToHost — 5ms 시간 슬라이싱

```javascript
// Scheduler.js
function shouldYieldToHost() {
  return needsPaint
    ? true  // 페인트 긴급 → 즉시 양보
    : (unstable_now() - startTime) < frameInterval
      ? false  // 5ms 이내 → 계속 실행
      : true;  // 5ms 초과 → 양보
}
```

### 5ms 선택의 근거

```
60fps 프레임 예산: 16.67ms

너무 긴 슬라이스 (예: 16ms):
  - 브라우저 렌더링 시간 0ms → 프레임 드롭 → 버벅임

너무 짧은 슬라이스 (예: 1ms):
  - MessageChannel 전환 비용 > 실제 작업 시간
  - 스케줄링 오버헤드가 지배적

5ms 선택:
  - 브라우저에 11.67ms 이상 남김 (렌더링 여유)
  - 의미 있는 Fiber 작업량을 한 슬라이스에 처리
  - MessageChannel 전환 비용 최소화

120fps 디스플레이 지원:
  unstable_forceFrameRate(120) → frameInterval = Math.floor(1000/120) = 8ms
```

`needsPaint` 플래그는 `requestPaint()`로 설정됩니다:

```javascript
// commitRootImpl에서 DOM 변경 직후 호출
function requestPaint() {
  if (
    enableIsInputPending &&
    navigator !== undefined &&
    navigator.scheduling !== undefined &&
    navigator.scheduling.isInputPending !== undefined
  ) {
    needsPaint = true; // 브라우저에 페인트 기회 양보 신호
  }
}
```

---

## 19. continuationCallback — 중단과 재개

Scheduler의 작업 중단/재개 메커니즘은 `continuationCallback` 패턴으로 구현됩니다.

```javascript
// Scheduler workLoop 내부
var continuationCallback = callback(didTimeout);

if (typeof continuationCallback === 'function') {
  // 작업이 완료되지 않고 "나중에 계속 실행할 함수"를 반환
  currentTask.callback = continuationCallback;
  // 태스크 객체를 재사용 (새 태스크 생성 없음)
  // → Min-heap 연산 비용 없음
  hasMoreWork = true;
  break b; // 현재 배치 종료, 다음 MessageChannel에서 재개
}
```

React Reconciler가 이 패턴을 활용하는 방식:

```javascript
// performConcurrentWorkOnRoot
function performConcurrentWorkOnRoot(root, didTimeout) {
  // ... 렌더링 실행 ...

  if (exitStatus === RootInProgress) {
    // workLoopConcurrent가 shouldYield()로 중단됨
    // → 자기 자신을 continuation으로 반환
    return performConcurrentWorkOnRoot.bind(null, root);
    //     ↑ 이것이 다음 배치에서 실행될 함수
  }

  // 렌더 완료
  return null;
}
```

### 중단/재개 타임라인

```
t=0ms:    scheduleCallback(NormalPriority, performConcurrentWorkOnRoot)
          taskQueue: [task(expTime=5000ms, callback=performConcurrent...)]
          port.postMessage() → MessageChannel 예약

t=0ms:    performWorkUntilDeadline 실행 시작
          startTime = 0ms

  → performConcurrentWorkOnRoot(root, false) 실행
    → workLoopConcurrent 실행 (Fiber A, B, C, D 처리...)

  t=5ms:  shouldYieldToHost() = true → workLoopConcurrent 중단
          workInProgress !== null (아직 Fiber 남음)
          → return performConcurrentWorkOnRoot.bind(null, root) ← continuation!

          Scheduler: continuationCallback 감지
          → task.callback = continuation (태스크 유지, 콜백만 교체)
          → hasMoreWork = true
          → schedulePerformWorkUntilDeadline()

t=5ms:    브라우저 렌더링 기회 (레이아웃, 페인트)

t=5+εms:  performWorkUntilDeadline 재실행
          → continuationCallback = performConcurrentWorkOnRoot 재실행
          → workLoopConcurrent 재개 (Fiber E, F, G 처리...)

...반복...

t=완료:   performConcurrentWorkOnRoot → return null
          Scheduler: null → 태스크 완료, taskQueue에서 제거
```

---

## 20. SyncLane 특별 처리 — scheduleMicrotask

SyncLane 업데이트는 Scheduler를 **완전히 우회**합니다.

```javascript
// ensureRootIsScheduled에서
if (newCallbackPriority === SyncLane) {
  scheduleSyncCallback(performSyncWorkOnRoot.bind(null, root));
  scheduleMicrotask(flushSyncCallbacks);
  return;
}

// scheduleMicrotask: queueMicrotask 또는 Promise.resolve().then()
function scheduleMicrotask(callback) {
  if (
    typeof queueMicrotask === 'function' &&
    typeof Promise !== 'undefined'
  ) {
    Promise.resolve(null).then(callback).catch(handleError);
  } else if (typeof queueMicrotask === 'function') {
    queueMicrotask(callback);
  } else {
    // 폴백
    scheduleCallback(ImmediatePriority, callback);
  }
}
```

### 왜 마이크로태스크인가?

```
이벤트 루프 우선순위:
  1. 현재 실행 중인 synchronous JavaScript
  2. Microtask 큐 소진 (Promise.then, queueMicrotask)  ← SyncLane
  3. 렌더링 기회 (스타일 재계산, 레이아웃, 페인트)
  4. Macrotask 큐 (setTimeout, MessageChannel)         ← Concurrent Mode

SyncLane → Microtask:
  현재 이벤트 핸들러 완료 직후, 렌더링 전에 즉시 실행
  "이 업데이트는 렌더링 전에 반드시 처리되어야 한다"

Concurrent Mode → MessageChannel (Macrotask):
  렌더링 이후에도 실행될 수 있음
  "이 업데이트는 브라우저 일정에 맞춰 처리되어도 됨"
```

### performSyncWorkOnRoot vs performConcurrentWorkOnRoot

| 구분 | `performSyncWorkOnRoot` | `performConcurrentWorkOnRoot` |
|------|------------------------|-------------------------------|
| 실행 방식 | 마이크로태스크 → 즉시 | Scheduler → 비동기 |
| 레인 | SyncLane | SyncLane 외 모든 레인 |
| 렌더 함수 | `renderRootSync` | `renderRootConcurrent` 또는 `renderRootSync` |
| Time-slicing | 불가 | `shouldTimeSlice` 조건부 |
| 인터럽트 | 불가 | 가능 |

`performConcurrentWorkOnRoot`에서의 Time-slicing 결정:

```javascript
var shouldTimeSlice =
  !includesBlockingLane(root, lanes) &&  // SyncLane/InputContinuous/Default 없어야
  !includesExpiredLane(root, lanes) &&   // 만료된 lane 없어야
  !didTimeout;                           // Scheduler timeout 없어야

// includesBlockingLane: SyncLane들은 항상 동기 완료
var SyncDefaultLanes =
  InputContinuousHydrationLane | InputContinuousLane |
  DefaultHydrationLane | DefaultLane;
function includesBlockingLane(root, lanes) {
  return (lanes & SyncDefaultLanes) !== NoLanes;
}
```

---

## 21. Lane 생명주기 — markRootUpdated에서 markRootFinished까지

각 lane은 `pendingLanes`에서 시작하여 다양한 상태 변화를 거칩니다.

### markRootUpdated — Lane 등록

```javascript
// ReactFiberLane.js
function markRootUpdated(root, updateLane, eventTime) {
  root.pendingLanes |= updateLane;

  // Idle이 아닌 새 업데이트 도착 시 suspended/pinged 초기화
  if (updateLane !== IdleLane) {
    root.suspendedLanes = NoLanes;
    root.pingedLanes = NoLanes;
  }

  // 이벤트 발생 시각 기록 (기아 방지 타이머 계산에 사용)
  var eventTimes = root.eventTimes;
  var index = laneToIndex(updateLane);
  eventTimes[index] = eventTime;
}
```

### Lane 상태 전이 다이어그램

```
setState() 호출
      │ markRootUpdated
      ▼
[pendingLanes] ─────────────────────────────────────►
      │                                               │
      │ 렌더 시작                                      │ 만료 초과
      │                                               │ markStarvedLanesAsExpired
      ▼                                               ▼
  (렌더 진행)                                    [expiredLanes]
      │                                               │
      │ Suspense throw                                │ 강제 동기 처리
      │ markRootSuspended                             │ (time-slicing 없음)
      ▼                                               │
[suspendedLanes]                                      │
      │                                               │
      │ Promise resolve                               │
      │ markRootPinged                                │
      ▼                                               │
[pingedLanes]                                         │
      │                                               │
      │ 재시도 렌더                                    │
      ▼                                               ▼
  렌더 완료
      │ markRootFinished
      ▼
pendingLanes에서 제거 (lane GC)
```

### markRootFinished — 완료 처리

```javascript
// ReactFiberLane.js
function markRootFinished(root, remainingLanes) {
  var noLongerPendingLanes = root.pendingLanes & ~remainingLanes;

  // 완료된 lane들 제거
  root.pendingLanes = remainingLanes;
  root.suspendedLanes &= remainingLanes;
  root.pingedLanes &= remainingLanes;
  root.expiredLanes &= remainingLanes;
  root.entangledLanes &= remainingLanes;

  // 완료된 lane들의 메타데이터 초기화
  var expirationTimes = root.expirationTimes;
  var lanes = noLongerPendingLanes;
  while (lanes > 0) {
    var index = pickArbitraryLaneIndex(lanes);
    var lane = 1 << index;
    expirationTimes[index] = NoTimestamp; // 만료 타이머 리셋
    lanes &= ~lane;
  }

  // entanglements 배열에서 완료된 lane 제거
  var entanglements = root.entanglements;
  lanes = root.entangledLanes;
  while (lanes > 0) {
    var index = pickArbitraryLaneIndex(lanes);
    var lane = 1 << index;
    entanglements[index] &= remainingLanes; // 완료된 lane과의 얽힘 해제
    lanes &= ~lane;
  }
}
```

---

## 22. 전체 흐름 — setState에서 화면 갱신까지

모든 구성 요소를 하나의 흐름으로 통합합니다.

```
사용자가 버튼 클릭 (click 이벤트)
│
▼
dispatchSetState(fiber, queue, action)
│ ├─ getHighestPriorityLane으로 현재 fiber.lanes 확인
│ ├─ requestUpdateLane(fiber) → SyncLane (click 이벤트)
│ ├─ Eager State 최적화: fiber.lanes === NoLanes면
│ │   reducer(currentState, action)으로 미리 계산
│ │   Object.is(eagerState, currentState)?  → 렌더 스킵
│ └─ enqueueUpdate → UpdateQueue에 Update 추가
│
▼
scheduleUpdateOnFiber(fiber, SyncLane, eventTime)
│ └─ markUpdateLaneFromFiberToRoot(fiber, SyncLane)
│       fiber.lanes |= SyncLane
│       모든 조상 fiber.childLanes |= SyncLane
│
▼
markRootUpdated(root, SyncLane, eventTime)
│ root.pendingLanes |= SyncLane
│
▼
ensureRootIsScheduled(root, currentTime)
│ markStarvedLanesAsExpired(root, currentTime)  ← 기아 체크
│ getNextLanes(root, ...) → SyncLane
│ newCallbackPriority = SyncLane
│
│ ← SyncLane이므로 Scheduler 우회 →
│ scheduleSyncCallback(performSyncWorkOnRoot)
│ scheduleMicrotask(flushSyncCallbacks)
│
▼
[이벤트 핸들러 완료]
[Microtask 큐 실행]
│
▼
flushSyncCallbacks() → performSyncWorkOnRoot(root)
│ renderRootSync(root, SyncLane)
│ └─ workLoopSync()
│      while (workInProgress !== null) {
│        performUnitOfWork(workInProgress)
│          beginWork → (childLanes 체크, bailout 또는 렌더)
│          completeWork → Fiber 처리 완료
│      }
│
▼
commitRoot(root, finishedWork, lanes)
│ commitBeforeMutationEffects   ← getSnapshotBeforeUpdate
│ commitMutationEffects         ← DOM 변경
│   └─ useInsertionEffect cleanup
│   └─ useInsertionEffect mount
│   └─ useLayoutEffect cleanup
│ [root.current = finishedWork]  ← 더블 버퍼 포인터 교체
│ commitLayoutEffects
│   └─ useLayoutEffect mount
│ markRootFinished(root, remainingLanes)
│ scheduleCallback(NormalPriority, flushPassiveEffects) ← useEffect 예약
│
▼
[렌더링 기회: 브라우저 페인트]
│
▼
[MessageChannel: performWorkUntilDeadline]
└─ flushPassiveEffects()
     commitPassiveUnmountEffects  ← useEffect cleanup (전체 트리)
     commitPassiveMountEffects    ← useEffect mount (전체 트리)
```

### Concurrent Mode로 바꾸면

```javascript
// startTransition(() => setList(bigData)) 경우

requestUpdateLane → claimNextTransitionLane() → TransitionLane5
ensureRootIsScheduled → scheduleCallback(NormalPriority, performConcurrentWorkOnRoot)

[MessageChannel macrotask]
performWorkUntilDeadline:
  performConcurrentWorkOnRoot(root, false)
    shouldTimeSlice = true (blocking lane 없음, 만료 없음)
    renderRootConcurrent:
      workLoopConcurrent:
        while (workInProgress !== null && !shouldYield()) {
          performUnitOfWork(workInProgress)
        }

    t=5ms: shouldYield() = true → 루프 중단
    exitStatus = RootInProgress
    → return performConcurrentWorkOnRoot.bind(null, root) ← continuation!

[브라우저 렌더링 기회]

[다음 MessageChannel]
  → continuation 실행 → workLoopConcurrent 재개
  → 완료 시 return null → commitRoot
```

---

## 핵심 설계 원칙 정리

| 원칙 | 구현 방식 | 효과 |
|------|----------|------|
| **비트 연산으로 O(1) 우선순위 결정** | `lanes & -lanes` | 분기 없는 최고 우선순위 추출 |
| **childLanes로 서브트리 건너뛰기** | `markUpdateLaneFromFiberToRoot` | 변경 없는 하위 트리 전체 bailout |
| **Entanglement로 중간 상태 방지** | `markRootEntangled`, 전이적 closure | 관련 업데이트 항상 함께 커밋 |
| **만료 기반 기아 방지** | `computeExpirationTime` + `markStarvedLanesAsExpired` | Transition도 5초 후 강제 처리 |
| **인터럽트 가능한 렌더** | `workLoopConcurrent` + `shouldYield()` | 5ms마다 브라우저에 제어권 반환 |
| **continuation으로 O(1) 재개** | `task.callback = continuationCallback` | 새 Scheduler 태스크 생성 없이 중단/재개 |
| **O(1) 취소** | `task.callback = null` | heap 재정렬 없이 즉시 취소 |
| **두 큐 분리** | `taskQueue` + `timerQueue` | 즉시/지연 태스크 분리 관리 |

---

## 더 알아보기

- **이전 편**: [Hooks 시스템](./react-architecture-03-hooks-system.md)
- **다음 편**: [렌더링 사이클](./react-architecture-05-rendering-cycle.md)
- **관련 소스**: `packages/react-reconciler/src/ReactFiberLane.js`, `packages/scheduler/src/forks/Scheduler.js`
- **참고 자료**:
  - [React 18 Lane Model Deep Dive](https://goidle.github.io/react/in-depth-react18-lane/)
  - [What are Lanes in React source code? — jser.dev](https://jser.dev/react/2022/03/26/lanes-in-react)
  - [How React Scheduler works internally — jser.dev](https://jser.dev/react/2022/03/16/how-react-scheduler-works/)
  - [Concurrent Rendering and Lane Prioritization in React 18](https://j1032w.github.io/blog/concurrent-rendering-and-update-priority-in-react18)
  - [New feature: startTransition — reactwg Discussion](https://github.com/reactwg/react-18/discussions/41)

---

*작성일: 2026-02-20*
