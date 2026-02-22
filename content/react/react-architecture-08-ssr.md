# React 18 SSR 아키텍처: Fizz, RSC, 그리고 Next.js App Router

> 시리즈: React 아키텍처 심층 분석 - 8편
> 분석 대상: React 18.3.1, Next.js 14.2.35
> 소스 경로: `node_modules/.pnpm/react-dom@18.3.1/node_modules/react-dom/cjs/`

---

## 들어가며

React 18의 SSR은 단순한 업그레이드가 아닌 아키텍처의 전면 교체입니다. 기존 `renderToString`이 동기적 단일 패스로 HTML을 생성하던 방식에서, **Fizz**라는 완전히 새로운 스트리밍 렌더러로 대체되었습니다. 여기에 Server Components가 더해지면서 서버 렌더링의 패러다임 자체가 바뀌었습니다.

이 글에서는 실제 소스 코드를 추적하며 다음 네 가지 주제를 깊이 탐구합니다:

1. 레거시 SSR vs 현대 Fizz 비교
2. 스트리밍 SSR의 설계 원리
3. Server Components 아키텍처 철학
4. React 18 SSR의 미래 방향성 (PPR, use cache)

---

## 1. 레거시 SSR vs 현대 Fizz 비교

### 1.1 renderToString의 실체

`renderToString`은 React 초기부터 존재하던 API입니다. 그런데 React 18에서 이 함수의 구현을 들여다보면 놀라운 사실이 있습니다. 이미 Fizz 위에서 동작합니다.

```javascript
// react-dom-server-legacy.node.development.js, line 6964
function renderToStringImpl(children, options, generateStaticMarkup, abortReason) {
  var result = '';
  var destination = {
    push: function (chunk) {
      if (chunk !== null) {
        result += chunk;  // 문자열에 직접 누적
      }
      return true;
    },
    destroy: function (error) {
      didFatal = true;
      fatalError = error;
    }
  };

  var readyToStream = false;
  function onShellReady() {
    readyToStream = true;
  }

  var request = createRequest(
    children,
    createResponseState$1(generateStaticMarkup, ...),
    createRootFormatContext(),
    Infinity,        // progressiveChunkSize: 제한 없음
    onError,
    undefined,       // onAllReady: 없음
    onShellReady,    // Shell 완성 시 플래그만 세움
    undefined,
    undefined
  );

  startWork(request);
  abort(request, abortReason); // 즉시 중단 요청 (Suspense 처리 불가)
  startFlowing(request, destination);

  return result;
}
```

핵심을 보면:
- `progressiveChunkSize`를 `Infinity`로 설정해 청킹 없이 전체를 한 번에 처리
- `abort()`를 즉시 호출해 Suspense를 강제로 클라이언트 렌더링으로 전환
- 결과를 문자열로 누적 (`result += chunk`)

```javascript
// line 7079
function renderToString(children, options) {
  return renderToStringImpl(children, options, false,
    'The server used "renderToString" which does not support Suspense. ' +
    'If you intended to have the server wait for the suspended component ' +
    'please switch to "renderToPipeableStream"'
  );
}
```

에러 메시지 자체가 이 API의 한계를 명확히 설명합니다. `renderToString`은 이제 레거시 호환성을 위한 폴백이지, 권장 API가 아닙니다.

### 1.2 왜 Fizz는 Fiber 트리를 사용하지 않는가

가장 중요한 설계 결정입니다. Fizz는 클라이언트의 Fiber reconciler와 **완전히 독립된** 렌더 시스템입니다.

**Fiber가 SSR에 부적합한 이유:**

| 측면 | Fiber | Fizz |
|------|-------|------|
| 자료구조 | 트리 노드 (linked list) | Task + Segment (배열 기반) |
| 메모리 | 컴포넌트당 Fiber 객체 생성 | 청크 버퍼에 직접 쓰기 |
| 상태 | work-in-progress 더블 버퍼링 | 단방향 진행 (이전 상태 불필요) |
| 목적 | 인터렉티브 업데이트, 증분 렌더링 | 스트림 생성, 일회성 출력 |
| 스케줄링 | Lane 기반 우선순위 | Task 큐 + pingTask |

```javascript
// react-dom-server.node.development.js, line 5467
function createTask(request, node, blockedBoundary, blockedSegment,
                    abortSet, legacyContext, context, treeContext) {
  request.allPendingTasks++;

  if (blockedBoundary === null) {
    request.pendingRootTasks++;  // Shell에 속하는 Task
  } else {
    blockedBoundary.pendingTasks++;  // 특정 Suspense Boundary에 속하는 Task
  }

  var task = {
    node: node,                    // 렌더링할 React Element
    ping: function () {
      return pingTask(request, task); // Suspense resolve 시 호출
    },
    blockedBoundary: blockedBoundary, // 어떤 SuspenseBoundary를 블로킹 중인가
    blockedSegment: blockedSegment,   // 어느 Segment에 출력할 것인가
    abortSet: abortSet,
    legacyContext: legacyContext,
    context: context,
    treeContext: treeContext
  };

  abortSet.add(task);
  return task;
}
```

```javascript
// Segment 구조, line 5496
function createPendingSegment(request, index, boundary, formatContext,
                               lastPushedText, textEmbedded) {
  return {
    status: PENDING,
    id: -1,           // 나중에 할당 (placeholder ID)
    index: index,
    parentFlushed: false,
    chunks: [],       // 실제 HTML 청크 버퍼
    children: [],     // 자식 Segment 참조
    formatContext: formatContext,
    boundary: boundary,
    lastPushedText: lastPushedText,
    textEmbedded: textEmbedded
  };
}
```

**Fizz의 핵심 통찰:** 서버에서는 이전 상태로 되돌아갈 일이 없습니다. 한 번 HTML을 생성하면 그걸로 끝입니다. Fiber의 더블 버퍼링, work-in-progress 트리, Lane 스케줄링은 서버에서 모두 오버헤드입니다.

### 1.3 Fizz 렌더 루프: performWork

```javascript
// line 6629
function performWork(request) {
  if (request.status === CLOSED) {
    return;
  }

  var prevDispatcher = ReactCurrentDispatcher$1.current;
  ReactCurrentDispatcher$1.current = Dispatcher; // SSR 전용 Dispatcher

  try {
    var pingedTasks = request.pingedTasks;
    var i;

    // ping된 Task를 순서대로 처리
    for (i = 0; i < pingedTasks.length; i++) {
      var task = pingedTasks[i];
      retryTask(request, task);
    }
    pingedTasks.splice(0, i); // 처리 완료된 Task 제거

    if (request.destination !== null) {
      flushCompletedQueues(request, request.destination); // 완성된 청크 플러시
    }
  } finally {
    ReactCurrentDispatcher$1.current = prevDispatcher;
  }
}
```

이 렌더 루프는 의도적으로 단순합니다. `pingedTasks` 배열에서 Task를 꺼내 처리하고, 완성된 청크를 destination에 씁니다. Fiber의 workLoop처럼 복잡한 Lanes 계산이나 work stealing이 없습니다.

---

## 2. 스트리밍 SSR의 설계 원리

### 2.1 Request 객체: Fizz의 핵심 상태

```javascript
// line 5408
function createRequest(children, responseState, rootFormatContext,
                        progressiveChunkSize, onError, onAllReady,
                        onShellReady, onShellError, onFatalError) {
  var pingedTasks = [];
  var abortSet = new Set();

  var request = {
    destination: null,           // 현재 연결된 스트림
    status: OPEN,
    nextSegmentId: 0,            // Segment ID 카운터
    allPendingTasks: 0,          // 전체 미완료 Task 수
    pendingRootTasks: 0,         // Shell에 속한 미완료 Task 수
    completedRootSegment: null,  // 완성된 루트 Segment
    abortableTasks: abortSet,
    pingedTasks: pingedTasks,
    clientRenderedBoundaries: [], // 클라이언트로 위임된 경계들
    completedBoundaries: [],      // 완성된 Suspense 경계들
    partialBoundaries: [],
    onError: onError,
    onAllReady: onAllReady,       // 모든 Task 완료 시
    onShellReady: onShellReady,   // Shell Task 완료 시
    onShellError: onShellError,
    onFatalError: onFatalError
  };

  var rootSegment = createPendingSegment(request, 0, null, rootFormatContext, false, false);
  rootSegment.parentFlushed = true; // 루트는 항상 flush 가능

  var rootTask = createTask(request, children, null, rootSegment, ...);
  pingedTasks.push(rootTask);
  return request;
}
```

### 2.2 Shell과 Content의 분리

Fizz의 가장 중요한 개념은 **Shell**과 **Content**의 분리입니다.

**Shell**: Suspense 경계 바깥의 콘텐츠. 즉시 전송 가능하며, 이것이 준비되는 시점이 `onShellReady`입니다.

**Content**: Suspense 경계 안의 콘텐츠. 비동기적으로 해결되며, 나중에 스트림에 주입됩니다.

```javascript
// finishedTask 함수 - onShellReady가 언제 호출되는지
// line ~6490
function finishedTask(request, boundary, segment) {
  if (boundary === null) {
    // boundary가 null이면 이 Task는 Shell에 속함
    if (segment.parentFlushed) {
      request.completedRootSegment = segment;
    }

    request.pendingRootTasks--;

    if (request.pendingRootTasks === 0) {
      // Shell을 구성하는 모든 Task가 완료됨
      request.onShellError = noop$1; // Shell이 완성되면 더 이상 ShellError 없음
      var onShellReady = request.onShellReady;
      onShellReady(); // 여기서 pipe()를 호출해 스트리밍 시작
    }
  } else {
    boundary.pendingTasks--;

    if (boundary.pendingTasks === 0) {
      // 특정 Suspense Boundary의 콘텐츠가 완성됨
      // completedBoundaries에 추가 -> 나중에 flushCompletedQueues에서 전송
    }
  }

  request.allPendingTasks--;
  if (request.allPendingTasks === 0) {
    var onAllReady = request.onAllReady;
    onAllReady(); // 모든 Task 완료 (정적 생성에 적합)
  }
}
```

### 2.3 onShellReady vs onAllReady: 사용 철학

```javascript
// renderToPipeableStream 공개 API, line 7042
function renderToPipeableStream(children, options) {
  var request = createRequestImpl(children, options);
  var hasStartedFlowing = false;
  startWork(request);

  return {
    pipe: function (destination) {
      if (hasStartedFlowing) {
        throw new Error('React currently only supports piping to one writable stream.');
      }
      hasStartedFlowing = true;
      startFlowing(request, destination);
      destination.on('drain', createDrainHandler(destination, request));
      destination.on('error', createAbortHandler(request, ...));
      destination.on('close', createAbortHandler(request, ...));
      return destination;
    },
    abort: function (reason) {
      abort(request, reason);
    }
  };
}
```

| 콜백 | 사용 시점 | 적합한 케이스 |
|------|----------|--------------|
| `onShellReady` | Shell이 완성되는 즉시 | SSR with 스트리밍, 빠른 TTFB 필요 |
| `onAllReady` | 모든 콘텐츠 완성 후 | 정적 생성, 크롤러 대응, 비스트리밍 환경 |

**스트리밍 사용 패턴:**
```javascript
// 권장: 스트리밍 SSR
const { pipe, abort } = renderToPipeableStream(<App />, {
  onShellReady() {
    res.statusCode = 200;
    pipe(res); // Shell 즉시 전송, Content는 이후에 스트리밍
  },
  onError(error) {
    res.statusCode = 500;
  }
});

// 정적 생성: 완전한 HTML이 필요할 때
const { pipe } = renderToPipeableStream(<App />, {
  onAllReady() {
    pipe(writable); // 전체 완성 후 한 번에 전송
  }
});
```

### 2.4 Suspense Boundary 처리: renderSuspenseBoundary

```javascript
// line 5620 - Suspense를 만났을 때 Fizz의 동작
function renderSuspenseBoundary(request, task, props) {
  var parentBoundary = task.blockedBoundary;
  var parentSegment = task.blockedSegment;

  var newBoundary = createSuspenseBoundary(request, fallbackAbortSet);

  // 핵심: 콘텐츠와 폴백을 위한 별도 Segment 생성
  var boundarySegment = createPendingSegment(request, insertionIndex, newBoundary, ...);
  parentSegment.children.push(boundarySegment);

  var contentRootSegment = createPendingSegment(request, 0, null, ...);
  contentRootSegment.parentFlushed = true;

  // 현재 Task의 블로킹 대상을 임시 전환
  task.blockedBoundary = newBoundary;
  task.blockedSegment = contentRootSegment;

  try {
    // 콘텐츠 렌더링 시도
    renderNode(request, task, content);
    contentRootSegment.status = COMPLETED;

    if (newBoundary.pendingTasks === 0) {
      // 콘텐츠가 suspend 없이 완성됨 -> 폴백 불필요
      return;
    }
  } catch (error) {
    // 에러 발생 -> 클라이언트 렌더링으로 위임
    contentRootSegment.status = ERRORED;
    newBoundary.forceClientRender = true;
  } finally {
    // 블로킹 대상 복원
    task.blockedBoundary = parentBoundary;
    task.blockedSegment = parentSegment;
  }

  // 폴백을 위한 별도 Task 생성 (낮은 우선순위)
  var suspendedFallbackTask = createTask(
    request, fallback, parentBoundary, boundarySegment, ...
  );
  request.pingedTasks.push(suspendedFallbackTask);
}
```

Suspense를 만나면:
1. 콘텐츠 렌더 시도
2. Suspend 발생 시 -> 폴백 Task를 큐에 추가, `<!--$?-->` placeholder 삽입
3. 나중에 콘텐츠가 resolve되면 -> `$RS()` 스크립트로 DOM 교체

```javascript
// HTML에 삽입되는 완성 스크립트 (line 3344)
var completeSegmentFunction =
  'function $RS(a,b){' +
    'a=document.getElementById(a);' +
    'b=document.getElementById(b);' +
    'for(a.parentNode.removeChild(a);a.firstChild;)' +
      'b.parentNode.insertBefore(a.firstChild,b);' +
    'b.parentNode.removeChild(b)' +
  '}';
```

이 인라인 스크립트가 스트리밍 중에 클라이언트에서 지연 콘텐츠를 교체합니다.

### 2.5 Selective Hydration과 Fizz의 상호작용

Fizz가 만들어낸 HTML에는 Suspense 경계마다 특수 주석이 삽입됩니다:

```html
<!-- 완성된 Suspense -->
<!--$-->
<div>실제 콘텐츠</div>
<!--/$-->

<!-- 대기 중인 Suspense -->
<!--$?-->
<template id="B:0"></template>
<div>폴백 UI</div>
<!--/$-->

<!-- 클라이언트 렌더링으로 위임된 Suspense -->
<!--$!-->
<template data-dgst="..." data-msg="..."></template>
<!--/$-->
```

클라이언트의 Fiber reconciler는 이 주석들을 읽어 **Selective Hydration**을 수행합니다:

```javascript
// react-dom.development.js, line 6197
// 사용자가 Suspense 경계를 클릭했을 때
function attemptExplicitHydrationTarget(queuedTarget) {
  var targetInst = getClosestInstanceFromNode(queuedTarget.target);
  if (nearestMounted.tag === SuspenseComponent) {
    var instance = getSuspenseInstanceFromFiber(nearestMounted);
    if (instance !== null) {
      // 이 경계의 hydration 우선순위를 높임
      queuedTarget.blockedOn = instance;
      attemptHydrationAtPriority(queuedTarget.priority, function () {
        attemptHydrationAtCurrentPriority(nearestMounted);
      });
    }
  }
}

// 우선순위 큐로 관리
var queuedExplicitHydrationTargets = [];

function queueExplicitHydrationTarget(target) {
  var updatePriority = getCurrentUpdatePriority$1();
  var queuedTarget = { blockedOn: null, target: target, priority: updatePriority };

  // 우선순위 내림차순 삽입
  for (; i < queuedExplicitHydrationTargets.length; i++) {
    if (!isHigherEventPriority(updatePriority, queuedExplicitHydrationTargets[i].priority)) {
      break;
    }
  }
  queuedExplicitHydrationTargets.splice(i, 0, queuedTarget);
}
```

**Selective Hydration의 동작:**
- 모든 Suspense 경계를 한꺼번에 hydrate하지 않음
- 사용자 상호작용(클릭, 포커스)이 발생한 경계를 우선 hydrate
- 나머지는 idle 시간에 점진적으로 처리

---

## 3. Server Components 아키텍처 철학

### 3.1 두 개의 렌더 파이프라인

Next.js App Router에서 페이지 요청 시 실제로는 두 개의 독립적인 렌더 파이프라인이 동시에 실행됩니다.

```
요청
 │
 ├── RSC 파이프라인 (React Flight)
 │    ComponentMod.renderToReadableStream(
 │      <ReactServerApp tree={loaderTree} />,
 │      clientReferenceManifest.clientModules
 │    )
 │    └─> RSC Payload (바이너리/텍스트 스트림)
 │         │
 │         ├─> [tee] ─> renderStream (SSR에 공급)
 │         └─> [tee] ─> dataStream (인라인 스크립트에 삽입)
 │
 └── SSR 파이프라인 (Fizz)
      renderToPipeableStream(
        <ReactServerEntrypoint
          reactServerStream={renderStream}
          clientReferenceManifest={...}
        />,
        { onShellReady: () => pipe(res) }
      )
      └─> HTML 스트림
```

```javascript
// app-render.js, line 585
const serverStream = ComponentMod.renderToReadableStream(
  <ReactServerApp tree={tree} ctx={ctx} asNotFound={asNotFound} />,
  clientReferenceManifest.clientModules,
  { onError: serverComponentsErrorHandler }
);

// RSC 스트림을 두 갈래로 분기
let [renderStream, dataStream] = serverStream.tee();

const children = (
  <ReactServerEntrypoint
    reactServerStream={renderStream}      // SSR에서 React.use()로 소비
    preinitScripts={preinitScripts}
    clientReferenceManifest={clientReferenceManifest}
    nonce={nonce}
  />
);
```

### 3.2 RSC Payload: 왜 HTML이 아닌가

Server Component가 HTML 대신 RSC Payload(React Flight 프로토콜)로 직렬화되는 이유는 **클라이언트 컴포넌트와의 합성(composition)**을 위해서입니다.

```javascript
// use-flight-response.js, line 11
export function useFlightStream(flightStream, clientReferenceManifest, nonce) {
  const response = flightResponses.get(flightStream);
  if (response) return response;

  // SSR 컨텍스트에서 RSC 스트림을 React 트리로 변환
  const newResponse = createFromReadableStream(flightStream, {
    ssrManifest: {
      moduleLoading: clientReferenceManifest.moduleLoading,
      moduleMap: clientReferenceManifest.ssrModuleMapping
    }
  });

  flightResponses.set(flightStream, newResponse);
  return newResponse; // Promise-like 객체
}

// ReactServerEntrypoint (SSR 컨텍스트에서 실행)
function ReactServerEntrypoint({ reactServerStream, ... }) {
  preinitScripts();
  const response = useFlightStream(reactServerStream, clientReferenceManifest, nonce);
  return React.use(response); // RSC Payload를 React 트리로 언래핑
}
```

**RSC Payload가 필요한 이유:**

1. **Client Component 경계 처리**: HTML은 컴포넌트 경계를 표현할 수 없습니다. RSC Payload는 `"use client"` 컴포넌트를 만나면 해당 컴포넌트의 참조와 props만 직렬화하고, 실제 렌더링은 클라이언트로 위임합니다.

2. **네비게이션 시 재사용**: 클라이언트 사이드 네비게이션 시 HTML 전체를 다시 받지 않아도 됩니다. RSC Payload만 받아서 React 트리를 업데이트합니다.

3. **컴포넌트 상태 보존**: Client Component의 로컬 상태를 유지하면서 Server Component만 업데이트할 수 있습니다.

### 3.3 RSC Flight 프로토콜: Wire Format

Flight 프로토콜의 각 행은 다음 형식을 따릅니다:

```
<id_hex>:<tag><json_data>\n
```

```javascript
// react-server-dom-turbopack-server.edge.production.js

function serializeRowHeader(tag, id) {
  return id.toString(16) + ':' + tag;  // 예: "0:I", "1:E", "2:H"
}

// 각 행 타입
function emitImportChunk(request, id, clientReferenceMetadata) {
  const row = serializeRowHeader('I', id) + json + '\n';
  // "0:I{"id":"./Button.js#default","chunks":["app/Button.js"],...}\n"
}

function emitErrorChunk(request, id, digest, error) {
  const row = serializeRowHeader('E', id) + stringify(errorInfo) + '\n';
  // "1:E{"digest":"abc123"}\n"
}

function emitHintChunk(request, code, model) {
  const row = serializeRowHeader('H' + code, id) + json + '\n';
  // "2:HL["/_next/static/css/main.css","style"]\n"  (preload hint)
}

function emitModelChunk(request, id, json) {
  const row = id.toString(16) + ':' + json + '\n';
  // "3:["$","div",null,{"children":"Hello"}]\n"  (React element)
}
```

실제 RSC Payload 예시:
```
0:I{"id":"./app/Button.js","chunks":["app/Button"],"name":"default","async":false}
1:HL["/_next/static/css/main.css","style"]
2:["$","$L0",null,{"children":"Click me"}]
3:["$","div",null,{"className":"container","children":"$2"}]
```

- `I` (Import): 클라이언트 컴포넌트 참조
- `HL` (Hint Link): 리소스 프리로드 힌트
- 숫자만: React element 모델

### 3.4 Client Reference 처리: "use client" 경계

```javascript
// react-server-dom-turbopack-server.edge.production.js

function isClientReference(reference) {
  return reference.$$typeof === CLIENT_REFERENCE_TAG$1;
}

function registerClientReference(proxyImplementation, id, exportName) {
  return registerClientReferenceImpl(proxyImplementation, id + '#' + exportName, false);
}

function registerClientReferenceImpl(proxyImplementation, id, async) {
  return Object.defineProperties(proxyImplementation, {
    $$typeof: { value: CLIENT_REFERENCE_TAG },
    $$id: { value: id },
    $$async: { value: async }
  });
}

// 직렬화 시 클라이언트 참조를 만나면
function serializeClientReference(request, parent, parentPropertyName, clientReference) {
  const clientReferenceKey = getClientReferenceKey(clientReference);
  const existingId = writtenClientReferences.get(clientReferenceKey);

  if (existingId !== undefined) {
    // 이미 기록된 경우 참조만 반환
    return serializeByValueID(existingId);
  }

  // 새 Import 청크 생성
  const metadata = resolveClientReferenceMetadata(config, clientReference);
  emitImportChunk(request, importId, metadata);
  writtenClientReferences.set(clientReferenceKey, importId);
  return serializeByValueID(importId);
}
```

**"use client" 처리 흐름:**
```
Server Component 트리 순회 중
  Button 컴포넌트 발견 ("use client" 표시됨)
  └-> isClientReference(Button) === true
      └-> serializeClientReference() 호출
          └-> emitImportChunk: "0:I{"id":"Button.js#default",...}"
          └-> 이 위치에 "$L0" 참조 삽입 (lazy client component)
              └-> 클라이언트에서 해당 모듈 로드 후 렌더링
```

### 3.5 Zero-bundle-size의 실제 구현

Zero-bundle-size란 Server Component의 코드가 클라이언트 번들에 포함되지 않는다는 것입니다. 이것이 가능한 이유:

```javascript
// RSC 렌더링은 서버에서만 실행
async function ProductPage({ id }) {
  // 이 코드는 클라이언트 번들에 없음
  const product = await db.query(`SELECT * FROM products WHERE id = ?`, [id]);
  const markdown = await fs.readFile(`./content/${id}.md`, 'utf8');
  const rendered = renderMarkdown(markdown);

  return (
    <div>
      <h1>{product.name}</h1>
      <div dangerouslySetInnerHTML={{ __html: rendered }} />
      <AddToCartButton id={id} /> {/* "use client" - 이것만 번들에 포함 */}
    </div>
  );
}
```

서버는 이 컴포넌트를 실행하고 결과를 RSC Payload로 직렬화합니다. 클라이언트는 payload만 받고, 실제 `ProductPage` 함수 코드는 전혀 알지 못합니다.

### 3.6 RSC Payload의 클라이언트 인라인 삽입

```javascript
// use-flight-response.js, line 104
function writeInitialInstructions(controller, scriptStart, formState) {
  controller.enqueue(encoder.encode(
    `${scriptStart}` +
    `(self.__next_f=self.__next_f||[]).push(${JSON.stringify([0])});` +
    `self.__next_f.push(${JSON.stringify([2, formState])})` +
    `</script>`
  ));
}

function writeFlightDataInstruction(controller, scriptStart, chunkAsString) {
  controller.enqueue(encoder.encode(
    `${scriptStart}self.__next_f.push(${JSON.stringify([1, chunkAsString])})</script>`
  ));
}
```

HTML에는 다음과 같이 삽입됩니다:

```html
<script>(self.__next_f=self.__next_f||[]).push([0]);self.__next_f.push([2,null])</script>
<!-- HTML 스트림 중간에 삽입되는 RSC Payload 청크 -->
<script>self.__next_f.push([1,"0:I{\"id\":\"./Button.js\",...}\n"])</script>
<script>self.__next_f.push([1,"3:[\"$\",\"div\",null,...]\n"])</script>
```

클라이언트 hydration 시 `self.__next_f`에 누적된 데이터를 읽어 RSC 트리를 복원합니다.

---

## 4. React 18 SSR의 미래 방향성

### 4.1 PPR (Partial Pre-rendering)

PPR은 정적 Shell + 동적 콘텐츠를 하나의 HTML 응답으로 결합하는 기술입니다. React의 `unstable_postpone`를 활용합니다.

```javascript
// static-renderer.js, line 64
export function createStaticRenderer({ ppr, isStaticGeneration, postponed, ... }) {
  if (ppr) {
    if (isStaticGeneration) {
      // Phase 1: Prerender - 정적 부분만 렌더링
      // dynamic() 컴포넌트는 postpone됨
      return new StaticRenderer({
        signal, onError, onPostpone, onHeaders, bootstrapScripts
      });
    } else {
      if (postponed === DYNAMIC_DATA) {
        // HTML이 완전히 정적이었음 -> 재렌더 불필요
        return new VoidRenderer();
      } else if (postponed) {
        // Phase 2: Resume - 동적 부분만 렌더링
        const reactPostponedState = postponed[1];
        return new StaticResumeRenderer(reactPostponedState, {
          signal, onError, onPostpone, nonce
        });
      }
    }
  }
  // PPR 없음 -> 일반 렌더
  return new ServerRenderer({ ... });
}
```

**PPR의 렌더 흐름:**

```
Build Time (Phase 1 - Prerender):
  전체 페이지 렌더 시도
    └-> 동적 부분에서 React.postpone() 호출
    └-> 정적 Shell 저장 (CDN 캐싱)
    └-> postponed state 저장

Request Time (Phase 2 - Resume):
  저장된 Shell을 즉시 전송 (CDN에서)
  동적 부분만 서버에서 렌더링
    └-> postponed state 로드
    └-> 동적 위치에 콘텐츠 스트리밍
```

```javascript
// app-render.js - postponed 상태 처리
const { stream, postponed, resumed } = await renderer.render(children);

if (postponed != null) {
  if (isStaticGeneration && usedDynamicData) {
    // 동적 데이터 사용 + postpone -> DYNAMIC_DATA 상태로 저장
    metadata.postponed = JSON.stringify(getDynamicDataPostponedState());
  } else {
    // HTML holes가 있는 상태 -> postponed HTML 저장
    metadata.postponed = JSON.stringify(getDynamicHTMLPostponedState(postponed));
  }
}
```

### 4.2 "use cache" 디렉티브 (React 19 방향)

`"use cache"`는 `"use client"`, `"use server"`에 이어지는 세 번째 디렉티브입니다. 함수 또는 컴포넌트 수준에서 캐싱을 선언합니다.

```javascript
// React 19 experimental / Next.js 15 canary
async function getUser(id) {
  "use cache";                          // 이 함수의 결과를 캐싱
  return await db.query(id);
}

async function ProductList({ category }) {
  "use cache";
  cacheTag(`products-${category}`);     // 캐시 태그 설정
  cacheLife("hours");                   // TTL 설정

  const products = await fetchProducts(category);
  return <ul>{products.map(p => <li key={p.id}>{p.name}</li>)}</ul>;
}
```

기존 `unstable_cache`와의 차이:

| 구분 | `unstable_cache` | `"use cache"` |
|------|-----------------|---------------|
| 적용 레벨 | 함수 단위 | 함수/컴포넌트 단위 |
| 캐시 키 | 수동 지정 | 인수 자동 직렬화 |
| 태깅 | 수동 | `cacheTag()` API |
| 유효성 만료 | `revalidate` 옵션 | `cacheLife()` API |

### 4.3 Server Actions와의 통합

Server Actions는 "use server" 디렉티브로 표시된 함수를 서버에서 실행하는 메커니즘입니다.

```javascript
// RSC Flight에서 Server Action 직렬화
function registerServerReference(reference, id, exportName) {
  return Object.defineProperties(reference, {
    $$typeof: { value: SERVER_REFERENCE_TAG },
    $$id: { value: id + '#' + exportName },
    $$bound: { value: null }
  });
}

// Client에서 Server Action 호출 시
// POST /server-action 으로 직렬화된 args 전송
// Server에서 역직렬화 후 실행
// 결과를 RSC Payload로 응답
```

**Server Actions의 렌더링 통합:**

```javascript
// Form Action과 통합
async function submitForm(formData) {
  "use server";
  await db.insert(formData.get("name"));
  revalidatePath("/users");
}

function UserForm() {
  return (
    <form action={submitForm}>
      <input name="name" />
      <button type="submit">Submit</button>
    </form>
  );
}
```

JavaScript 없이도 HTML form의 action으로 동작하므로, **Progressive Enhancement**를 기본으로 지원합니다.

---

## 아키텍처 전체 그림

```
Browser                     Edge/Server                   Origin Server
  │                              │                              │
  │──── GET /page ──────────────>│                              │
  │                              │──── RSC Render ─────────────>│
  │                              │     ComponentMod             │
  │                              │     .renderToReadableStream  │
  │                              │     (<ReactServerApp />)     │
  │                              │<── RSC Payload Stream ───────│
  │                              │     (Flight Protocol)        │
  │                              │                              │
  │                              │  [tee RSC stream]            │
  │                              │  ┌──────────────────────┐    │
  │                              │  │ renderStream (SSR용)  │    │
  │                              │  │ dataStream (인라인용) │    │
  │                              │  └──────────────────────┘    │
  │                              │                              │
  │                              │  Fizz SSR Pipeline           │
  │                              │  renderToPipeableStream(     │
  │                              │    <ReactServerEntrypoint    │
  │                              │      stream={renderStream}   │
  │                              │    />                        │
  │                              │  )                           │
  │                              │                              │
  │<── HTML Shell (즉시) ────────│  onShellReady -> pipe()      │
  │                              │                              │
  │<── HTML Content (스트림) ────│  Suspense 해결 시마다        │
  │  + <script>$RS()</script>    │  writeCompletedSegment()     │
  │                              │                              │
  │<── RSC Payload (인라인) ─────│  __next_f.push([1, ...])     │
  │  <script>                    │                              │
  │   self.__next_f.push(...)    │                              │
  │  </script>                   │                              │
  │                              │                              │
  │  Selective Hydration         │                              │
  │  hydrateRoot()               │                              │
  │  └-> React.use(__next_f)     │                              │
  │  └-> 사용자 상호작용 우선 hydrate│                           │
```

---

## 핵심 설계 원칙 요약

### 왜 이런 설계인가

**1. Fizz가 Fiber와 독립적인 이유:**
서버는 단방향 출력만 필요합니다. Fiber의 더블 버퍼링과 Lane 스케줄링은 클라이언트 상호작용을 위한 것으로, 서버에서는 순수한 오버헤드입니다. Fizz의 Task/Segment 모델은 스트림 생성에 최적화되어 있습니다.

**2. RSC Payload가 HTML이 아닌 이유:**
HTML은 컴포넌트 경계, props, 상태를 표현할 수 없습니다. RSC Payload는 React의 컴포넌트 트리 구조를 보존하므로 클라이언트에서 완전한 React 트리로 복원할 수 있으며, 클라이언트 사이드 네비게이션 시 부분 업데이트가 가능합니다.

**3. 두 스트림을 tee()하는 이유:**
RSC 스트림 하나를 SSR과 데이터 인라인에 동시에 사용해야 합니다. tee()로 분기하면 같은 데이터를 두 번 생성하지 않고 두 용도로 활용할 수 있습니다.

**4. onShellReady vs onAllReady의 철학:**
TTFB(Time to First Byte)를 최소화하려면 onShellReady에서 즉시 전송해야 합니다. 반면 정적 생성처럼 완전한 HTML이 필요한 경우 onAllReady를 사용합니다. 하나의 API(renderToPipeableStream)가 두 시나리오를 모두 지원합니다.

---

## 참고 소스

- `react-dom/cjs/react-dom-server.node.development.js` - Fizz 렌더러 전체
- `react-dom/cjs/react-dom-server-legacy.node.development.js` - renderToString 구현
- `react-dom/cjs/react-dom.development.js` - Selective Hydration
- `next/dist/esm/server/app-render/app-render.js` - Next.js App Router 렌더 파이프라인
- `next/dist/esm/server/app-render/use-flight-response.js` - RSC 스트림 처리
- `next/dist/esm/server/app-render/static/static-renderer.js` - PPR 구현
- `next/dist/compiled/react-server-dom-turbopack-experimental/cjs/react-server-dom-turbopack-server.edge.production.js` - Flight 프로토콜
