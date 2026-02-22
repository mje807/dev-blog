# React 아키텍처 심층 분석 (10/14): 핵심 타입 시스템 — React가 세상을 표현하는 방식

> 시리즈: React 아키텍처 심층 분석 - 10편
> 분석 대상: `react@18.3.1` — `react.development.js` (2,740 lines) + `react-dom.development.js` (29,923 lines)
> 소스 경로: `node_modules/.pnpm/react@18.3.1/node_modules/react/cjs/react.development.js`
> 소스 경로: `node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/cjs/react-dom.development.js`
> 분석 날짜: 2026-02-21

---

## 목차

1. [왜 타입 시스템인가](#1-왜-타입-시스템인가)
2. [Symbol 태깅 — React의 신분증 체계](#2-symbol-태깅--react의-신분증-체계)
3. [ReactElement — $$typeof와 XSS 방어](#3-reactelement--typeof와-xss-방어)
4. [createElement vs jsxDEV — 엘리먼트 생성의 두 경로](#4-createelement-vs-jsxdev--엘리먼트-생성의-두-경로)
5. [ReactPortal — 다른 DOM 트리로의 워프](#5-reactportal--다른-dom-트리로의-워프)
6. [Context 내부 구조 — _currentValue의 비밀](#6-context-내부-구조--_currentvalue의-비밀)
7. [pushProvider/popProvider — Context 값 스택](#7-pushproviderpopprovider--context-값-스택)
8. [readContext — 의존성 체인 구축](#8-readcontext--의존성-체인-구축)
9. [React.lazy — 4단계 상태 머신](#9-reactlazy--4단계-상태-머신)
10. [React.memo와 forwardRef — 합성 타입들](#10-reactmemo와-forwardref--합성-타입들)
11. [reconcileChildFibers — ReactNode 분기의 심장부](#11-reconcilechildfibers--reactnode-분기의-심장부)
12. [createFiberFromTypeAndProps — Symbol에서 Fiber로](#12-createfiberfromtypeandprops--symbol에서-fiber로)
13. [beginWork의 거대한 switch — 모든 타입의 처리 경로](#13-beginwork의-거대한-switch--모든-타입의-처리-경로)
14. [타입 시스템 전체 흐름 다이어그램](#14-타입-시스템-전체-흐름-다이어그램)

---

## 1. 왜 타입 시스템인가

React는 UI를 트리 구조로 표현한다. 그런데 한 트리 안에 `<div>` 같은 호스트 엘리먼트, `<App />` 같은 함수 컴포넌트, `{condition && <Show />}` 같은 불리언, `"텍스트"` 같은 문자열, `[<A />, <B />]` 같은 배열이 섞여 있다. React는 이 모든 것을 어떻게 구분하고 처리할까?

답은 **타입 시스템**에 있다. React의 타입 시스템은 크게 세 층으로 구성된다:

```
Layer 1: Symbol 태깅     — 객체가 "무엇인지" 식별 ($$typeof)
Layer 2: ReactElement    — JSX → 불변 객체 변환
Layer 3: Fiber tag       — 재조정기가 사용하는 숫자 태그

  JSX             Symbol 태깅           Fiber 생성
  <App />  ──→  { $$typeof: Symbol(react.element) }  ──→  FiberNode { tag: 0 }
  <div>    ──→  { $$typeof: Symbol(react.element) }  ──→  FiberNode { tag: 5 }
  Portal   ──→  { $$typeof: Symbol(react.portal)  }  ──→  FiberNode { tag: 4 }
```

이 글에서는 각 층이 실제 소스 코드에서 어떻게 구현되어 있고, 왜 그런 설계를 선택했는지를 파고든다.

---

## 2. Symbol 태깅 — React의 신분증 체계

### 2.1 전체 Symbol 목록

**react.development.js L32-44**:

```javascript
var REACT_ELEMENT_TYPE = Symbol.for('react.element');         // L32
var REACT_PORTAL_TYPE = Symbol.for('react.portal');           // L33
var REACT_FRAGMENT_TYPE = Symbol.for('react.fragment');        // L34
var REACT_STRICT_MODE_TYPE = Symbol.for('react.strict_mode'); // L35
var REACT_PROFILER_TYPE = Symbol.for('react.profiler');       // L36
var REACT_PROVIDER_TYPE = Symbol.for('react.provider');       // L37
var REACT_CONTEXT_TYPE = Symbol.for('react.context');         // L38
var REACT_FORWARD_REF_TYPE = Symbol.for('react.forward_ref');// L39
var REACT_SUSPENSE_TYPE = Symbol.for('react.suspense');       // L40
var REACT_SUSPENSE_LIST_TYPE = Symbol.for('react.suspense_list'); // L41
var REACT_MEMO_TYPE = Symbol.for('react.memo');               // L42
var REACT_LAZY_TYPE = Symbol.for('react.lazy');               // L43
var REACT_OFFSCREEN_TYPE = Symbol.for('react.offscreen');     // L44
```

13개의 Symbol이 있다. 이것이 React 18.3.1의 전체 타입 태그다.

### 2.2 왜 Symbol.for인가?

`Symbol.for('react.element')`는 전역 Symbol 레지스트리를 사용한다. 일반 `Symbol('react.element')`와의 차이점:

```javascript
// Symbol() — 매번 고유한 Symbol 생성
Symbol('react.element') === Symbol('react.element') // false

// Symbol.for() — 전역 레지스트리에서 동일 Symbol 반환
Symbol.for('react.element') === Symbol.for('react.element') // true
```

`Symbol.for`를 쓰는 이유: 여러 React 복사본이 같은 페이지에 존재할 때 (마이크로 프론트엔드 등), 서로 다른 React 인스턴스가 생성한 엘리먼트도 동일한 `$$typeof`를 가져야 한다. `Symbol.for`는 전역 레지스트리를 공유하므로 이것이 가능하다.

### 2.3 Symbol 태그의 두 가지 용법

Symbol 태그는 두 가지 다른 위치에서 사용된다:

**용법 1 — `$$typeof` 필드**: ReactElement와 ReactPortal의 신원 확인

```javascript
// ReactElement의 $$typeof
{ $$typeof: REACT_ELEMENT_TYPE, type: 'div', ... }

// ReactPortal의 $$typeof
{ $$typeof: REACT_PORTAL_TYPE, children: ..., containerInfo: ... }
```

**용법 2 — `type` 필드 또는 `type.$$typeof`**: 엘리먼트의 "종류" 표시

```javascript
// Fragment는 type 자체가 Symbol
{ $$typeof: REACT_ELEMENT_TYPE, type: REACT_FRAGMENT_TYPE, ... }

// Provider는 type 객체의 $$typeof가 Symbol
{ $$typeof: REACT_ELEMENT_TYPE, type: { $$typeof: REACT_PROVIDER_TYPE, _context: ctx }, ... }

// forwardRef는 type 객체의 $$typeof가 Symbol
{ $$typeof: REACT_ELEMENT_TYPE, type: { $$typeof: REACT_FORWARD_REF_TYPE, render: fn }, ... }
```

이 구분이 중요하다. `$$typeof`는 "이 객체가 React 객체인가?"를 확인하고, `type`/`type.$$typeof`는 "어떤 종류의 React 객체인가?"를 확인한다.

```
                    $$typeof 확인
                         │
              ┌──────────┴──────────┐
              │                     │
     REACT_ELEMENT_TYPE      REACT_PORTAL_TYPE
              │
         type 확인
              │
    ┌─────────┼──────────┬─────────────┐
    │         │          │             │
 string    function   Symbol      type.$$typeof
 (호스트)  (컴포넌트)  (Fragment    (Provider,
                      Suspense     ForwardRef,
                       등)         Memo, Lazy 등)
```

---

## 3. ReactElement — $$typeof와 XSS 방어

### 3.1 ReactElement 팩토리 함수

**react.development.js L725-778**:

```javascript
var ReactElement = function (type, key, ref, self, source, owner, props) {
  var element = {
    // This tag allows us to uniquely identify this as a React Element
    $$typeof: REACT_ELEMENT_TYPE,                  // L728
    // Built-in properties that belong on the element
    type: type,                                     // L730
    key: key,                                       // L731
    ref: ref,                                       // L732
    props: props,                                   // L733
    // Record the component responsible for creating this element.
    _owner: owner                                   // L735
  };

  {
    element._store = {};                            // L739
    Object.defineProperty(element._store, 'validated', {
      configurable: false,
      enumerable: false,
      writable: true,
      value: false
    });
    Object.defineProperty(element, '_self', {       // L752
      configurable: false,
      enumerable: false,
      writable: false,
      value: self
    });
    Object.defineProperty(element, '_source', {     // L759
      configurable: false,
      enumerable: false,
      writable: false,
      value: source
    });
    if (Object.freeze) {
      Object.freeze(element.props);                 // L767
      Object.freeze(element);                       // L768
    }
  }

  return element;
};
```

주목해야 할 점들:

1. **`$$typeof: REACT_ELEMENT_TYPE`** — 이것이 핵심 보안 장치다 (아래 상세 설명)
2. **`Object.freeze(element.props)`** — DEV 모드에서 props를 동결한다. 엘리먼트는 불변이어야 하기 때문이다
3. **`Object.freeze(element)`** — DEV 모드에서 엘리먼트 자체도 동결한다
4. **`_store`, `_self`, `_source`** — DEV 전용 필드들. `_store.validated`는 key 경고 중복 방지, `_source`는 파일/라인 정보

### 3.2 $$typeof의 XSS 방어 메커니즘

`$$typeof`가 Symbol인 이유는 순전히 보안이다. 이 설계를 이해하려면 공격 시나리오를 먼저 봐야 한다.

**공격 시나리오**: 서버에서 사용자 입력을 JSON으로 반환하는 API가 있다고 가정하자:

```javascript
// 서버 응답 (공격자가 조작)
{
  "user": {
    "$$typeof": "Symbol(react.element)",  // 문자열!
    "type": "script",
    "props": { "dangerouslySetInnerHTML": { "__html": "alert('XSS')" } }
  }
}
```

만약 `$$typeof`가 문자열이었다면, JSON.parse로 역직렬화된 이 객체가 React 엘리먼트로 인식되어 XSS 공격이 성립한다. 하지만 `$$typeof`가 Symbol이기 때문에:

```javascript
// JSON.parse는 Symbol을 복원할 수 없다
JSON.stringify(Symbol.for('react.element'))  // undefined
JSON.parse('{"$$typeof": ...}')  // Symbol 복원 불가

// React의 검증 (react.development.js L958)
function isValidElement(object) {
  return typeof object === 'object'
    && object !== null
    && object.$$typeof === REACT_ELEMENT_TYPE;  // Symbol 비교!
}
```

Symbol은 JSON으로 직렬화/역직렬화가 불가능하다. 따라서 서버 응답에서 가짜 React 엘리먼트를 주입하는 것이 구조적으로 차단된다.

### 3.3 isValidElement의 단순함

**react.development.js L958**:

```javascript
function isValidElement(object) {
  return typeof object === 'object'
    && object !== null
    && object.$$typeof === REACT_ELEMENT_TYPE;
}
```

단 3가지 조건만 확인한다:
1. 객체인가?
2. null이 아닌가?
3. `$$typeof`가 `REACT_ELEMENT_TYPE` Symbol인가?

`type`, `props`, `key` 같은 다른 필드는 확인하지 않는다. `$$typeof` Symbol 하나로 모든 검증을 끝내는 것이다.

---

## 4. createElement vs jsxDEV — 엘리먼트 생성의 두 경로

React 18에서 엘리먼트를 생성하는 경로는 두 가지다. 레거시 `createElement`와 새로운 JSX Transform의 `jsxDEV`(또는 `jsx`/`jsxs`).

### 4.1 createElement

**react.development.js L783-866**:

```javascript
function createElement(type, config, children) {
  var propName;
  var props = {};
  var key = null;
  var ref = null;
  var self = null;
  var source = null;

  if (config != null) {
    if (hasValidRef(config)) {                     // L793
      ref = config.ref;
    }
    if (hasValidKey(config)) {                     // L801
      key = '' + config.key;                       // key를 문자열로 강제 변환
    }
    self = config.__self === undefined ? null : config.__self;
    source = config.__source === undefined ? null : config.__source;

    // RESERVED_PROPS를 제외한 나머지를 props에 복사
    for (propName in config) {
      if (hasOwnProperty.call(config, propName)
          && !RESERVED_PROPS.hasOwnProperty(propName)) {
        props[propName] = config[propName];        // L813
      }
    }
  }

  // children 처리 — 2개 이상이면 배열로
  var childrenLength = arguments.length - 2;       // L822
  if (childrenLength === 1) {
    props.children = children;
  } else if (childrenLength > 1) {
    var childArray = Array(childrenLength);
    for (var i = 0; i < childrenLength; i++) {
      childArray[i] = arguments[i + 2];
    }
    if (Object.freeze) {
      Object.freeze(childArray);
    }
    props.children = childArray;
  }

  // defaultProps 해결
  if (type && type.defaultProps) {                 // L842
    var defaultProps = type.defaultProps;
    for (propName in defaultProps) {
      if (props[propName] === undefined) {
        props[propName] = defaultProps[propName];
      }
    }
  }

  return ReactElement(type, key, ref, self, source,
                       ReactCurrentOwner.current, props);  // L866
}
```

**RESERVED_PROPS** (L614-619):

```javascript
var RESERVED_PROPS = {
  key: true,
  ref: true,
  __self: true,
  __source: true
};
```

`key`, `ref`, `__self`, `__source` 네 가지가 예약 props다. 이것들은 `props` 객체에 포함되지 않고 별도로 추출된다.

### 4.2 jsxDEV — 새로운 JSX Transform

**react-jsx-runtime.development.js L887-960**:

```javascript
function jsxDEV(type, config, maybeKey, source, self) {
  var propName;
  var props = {};
  var key = null;
  var ref = null;

  if (maybeKey !== undefined) {                    // L903
    key = '' + maybeKey;                           // key는 별도 인자로 받음
  }
  if (hasValidKey(config)) {
    key = '' + config.key;
  }
  if (hasValidRef(config)) {
    ref = config.ref;
  }

  for (propName in config) {
    if (hasOwnProperty.call(config, propName)
        && !RESERVED_PROPS.hasOwnProperty(propName)) {
      props[propName] = config[propName];
    }
  }

  if (type && type.defaultProps) {
    var defaultProps = type.defaultProps;
    for (propName in defaultProps) {
      if (props[propName] === undefined) {
        props[propName] = defaultProps[propName];
      }
    }
  }

  return ReactElement(type, key, ref, self, source,
                       ReactCurrentOwner.current, props);
}
```

### 4.3 createElement vs jsxDEV 비교

```
createElement(type, config, ...children)
     │
     ├─ config에서 key/ref 추출
     ├─ children을 arguments에서 가변 수집
     ├─ children이 2개 이상이면 배열 생성
     └─ ReactElement() 호출

jsxDEV(type, config, maybeKey, source, self)
     │
     ├─ key를 별도 인자(maybeKey)로 받음
     ├─ children은 이미 config.children에 포함
     ├─ source/self를 별도 인자로 받음 (트랜스파일러 제공)
     └─ ReactElement() 호출
```

핵심 차이는 **key 처리**다. `createElement`에서는 key가 config 객체 안에 섞여 있지만, `jsxDEV`에서는 별도 인자로 분리된다. 이것은 `<div {...props} key="hi" />` 같은 패턴에서 key spread를 감지하고 경고하기 위해서다.

두 함수 모두 최종적으로 같은 `ReactElement` 팩토리를 호출한다. 출력은 동일한 구조의 객체다.

---

## 5. ReactPortal — 다른 DOM 트리로의 워프

### 5.1 createPortal 구현

**react-dom.development.js L28726-28743**:

```javascript
function createPortal(children, containerInfo, implementation) {
  var key = arguments.length > 3 && arguments[3] !== undefined
    ? arguments[3] : null;

  {
    checkKeyStringCoercion(key);
  }

  return {
    $$typeof: REACT_PORTAL_TYPE,                   // L28737
    key: key == null ? null : '' + key,
    children: children,
    containerInfo: containerInfo,                   // 타겟 DOM 컨테이너
    implementation: implementation
  };
}
```

Portal은 ReactElement가 아니다. `$$typeof`가 `REACT_ELEMENT_TYPE`이 아니라 `REACT_PORTAL_TYPE`이다. 이것이 reconciler에서 분기를 일으키는 핵심이다.

### 5.2 Portal의 특수성

```
일반 ReactElement:
  $$typeof: REACT_ELEMENT_TYPE
  type: 'div' | MyComponent | Symbol(react.fragment) | ...
  props: { children: ... }

ReactPortal:
  $$typeof: REACT_PORTAL_TYPE
  children: ReactNode
  containerInfo: DOMElement     ← 렌더링 타겟이 다름!
  implementation: any
```

Portal은 `type`이 없고, `props`도 없다. 대신 `containerInfo`가 있어서 자식을 현재 DOM 트리가 아닌 다른 DOM 노드에 마운트한다. reconciler는 `$$typeof`를 보고 이 차이를 인식한다.

---

## 6. Context 내부 구조 — _currentValue의 비밀

### 6.1 createContext 구현

**react.development.js L1236-1270**:

```javascript
function createContext(defaultValue) {
  var context = {
    $$typeof: REACT_CONTEXT_TYPE,                  // L1239

    // 두 개의 _currentValue! 왜?
    _currentValue: defaultValue,                   // L1244
    _currentValue2: defaultValue,                  // L1245

    _threadCount: 0,                               // L1248
    Provider: null,
    Consumer: null,
    _defaultValue: null,                           // L1252
    _globalName: null                              // L1253
  };

  context.Provider = {                             // L1256
    $$typeof: REACT_PROVIDER_TYPE,
    _context: context                              // Provider → Context 순환 참조
  };

  // Consumer는 Context 자체를 프록시
  var Consumer = {                                 // L1265
    $$typeof: REACT_CONTEXT_TYPE,                  // L1270
    _context: context
  };
  // ... Object.defineProperties로 프록시 설정
```

### 6.2 _currentValue vs _currentValue2

주석이 모든 것을 말해준다:

```javascript
// As a workaround to support multiple concurrent renderers, we categorize
// some renderers as primary and others as secondary. We only expect
// there to be two concurrent renderers at most: React Native (primary) and
// Fabric (secondary); React DOM (primary) and React ART (secondary).
// Secondary renderers store their context values on separate fields.
```

`_currentValue`는 **1차 렌더러**(React DOM 또는 React Native)가 사용하고, `_currentValue2`는 **2차 렌더러**(React ART 또는 Fabric)가 사용한다.

왜 이런 설계가 필요한가? React는 같은 컴포넌트 트리를 동시에 두 렌더러가 처리할 수 있다(예: React DOM + React ART). 두 렌더러가 같은 Context 객체를 공유하는데, 각각 다른 Provider 스택을 유지해야 한다. 따라서 값 저장소를 두 개로 분리한 것이다.

```
Context 객체 (공유)
 ├─ _currentValue    ← React DOM이 읽고 쓴다
 ├─ _currentValue2   ← React ART가 읽고 쓴다
 └─ _threadCount     ← 동시 렌더러 수 추적
```

### 6.3 Provider와 Consumer의 $$typeof 차이

```javascript
// Provider
context.Provider = {
  $$typeof: REACT_PROVIDER_TYPE,    // PROVIDER 태그
  _context: context
};

// Consumer
var Consumer = {
  $$typeof: REACT_CONTEXT_TYPE,     // CONTEXT 태그 (Provider와 다름!)
  _context: context
};
```

Provider의 `$$typeof`는 `REACT_PROVIDER_TYPE`이고, Consumer의 `$$typeof`는 `REACT_CONTEXT_TYPE`이다. 이 차이가 `createFiberFromTypeAndProps`에서 서로 다른 Fiber tag(`ContextProvider` vs `ContextConsumer`)를 생성하는 근거가 된다.

### 6.4 _context 순환 참조

```
Context ──→ Provider.$$typeof = REACT_PROVIDER_TYPE
   ↑              │
   └── _context ──┘

Context ──→ Consumer.$$typeof = REACT_CONTEXT_TYPE
   ↑              │
   └── _context ──┘
```

Provider와 Consumer 모두 `_context`로 원본 Context 객체를 참조한다. 이 순환 참조 덕분에 `<Context.Provider value={...}>`의 type에서 항상 원본 Context를 추적할 수 있다.

---

## 7. pushProvider/popProvider — Context 값 스택

### 7.1 pushProvider

**react-dom.development.js L14151-14164**:

```javascript
function pushProvider(providerFiber, context, nextValue) {
  {
    push(valueCursor, context._currentValue, providerFiber);  // L14153
    context._currentValue = nextValue;                         // L14154

    {
      if (context._currentRenderer !== undefined
          && context._currentRenderer !== null
          && context._currentRenderer !== rendererSigil) {
        error('Detected multiple renderers concurrently rendering the '
          + 'same context provider. This is currently unsupported.');
      }
      context._currentRenderer = rendererSigil;
    }
  }
}
```

`pushProvider`가 하는 일:

1. **현재 값을 스택에 저장**: `push(valueCursor, context._currentValue, providerFiber)` — 이전 값을 cursor 스택에 백업
2. **새 값으로 교체**: `context._currentValue = nextValue` — Context 객체의 현재 값을 직접 변경
3. **렌더러 충돌 감지**: 같은 Provider를 두 렌더러가 동시에 쓰면 경고

핵심은 `context._currentValue`를 **직접 변이**한다는 점이다. 불변성을 철저히 지키는 React에서 왜 이런 방식일까? 이유는 성능이다. Context 값은 트리 순회 중 끊임없이 읽히는데, 매번 스택을 탐색하는 것보다 전역 변수에 현재 값을 유지하는 것이 훨씬 빠르다.

### 7.2 popProvider

**react-dom.development.js L14165-14175**:

```javascript
function popProvider(context, providerFiber) {
  var currentValue = valueCursor.current;           // L14166
  pop(valueCursor, providerFiber);                  // L14167

  {
    {
      context._currentValue = currentValue;         // L14171
    }
  }
}
```

`popProvider`는 cursor 스택에서 이전 값을 꺼내 `context._currentValue`를 복원한다.

### 7.3 스택 동작 시각화

```
트리 구조:
  <ThemeContext.Provider value="dark">     ← pushProvider("dark")
    <ThemeContext.Provider value="light">  ← pushProvider("light")
      <Consumer />                         ← readContext → "light"
    </ThemeContext.Provider>               ← popProvider → "dark" 복원
    <Consumer />                           ← readContext → "dark"
  </ThemeContext.Provider>                 ← popProvider → defaultValue 복원

스택 변화:
  Step 1: push "dark"
    valueCursor stack: [defaultValue]
    _currentValue: "dark"

  Step 2: push "light"
    valueCursor stack: [defaultValue, "dark"]
    _currentValue: "light"

  Step 3: Consumer reads → "light"

  Step 4: pop
    valueCursor stack: [defaultValue]
    _currentValue: "dark"

  Step 5: Consumer reads → "dark"

  Step 6: pop
    valueCursor stack: []
    _currentValue: defaultValue
```

이 스택 기반 설계는 React의 DFS 트리 순회와 완벽하게 맞물린다. `beginWork`에서 Provider를 만나면 push하고, `completeWork`에서 pop한다.

---

## 8. readContext — 의존성 체인 구축

### 8.1 readContext 구현

**react-dom.development.js L14362-14403**:

```javascript
function readContext(context) {
  {
    if (isDisallowedContextReadInDEV) {
      error('Context can only be read while React is rendering. ...');
    }
  }

  var value = context._currentValue;                // L14371 — 직접 읽기!

  if (lastFullyObservedContext === context) ;
  else {
    var contextItem = {                             // L14375
      context: context,
      memoizedValue: value,
      next: null
    };

    if (lastContextDependency === null) {
      if (currentlyRenderingFiber === null) {
        throw new Error('Context can only be read while React is rendering.');
      }
      // 첫 번째 의존성 — 새 리스트 생성
      lastContextDependency = contextItem;
      currentlyRenderingFiber.dependencies = {      // L14389
        lanes: NoLanes,
        firstContext: contextItem
      };
    } else {
      // 기존 리스트에 추가
      lastContextDependency = lastContextDependency.next = contextItem;  // L14395
    }
  }

  return value;                                     // L14399
}
```

`readContext`는 두 가지 일을 한다:

1. **값 반환**: `context._currentValue`를 직접 읽어서 반환
2. **의존성 등록**: 현재 렌더링 중인 Fiber의 `dependencies` 연결 리스트에 이 Context를 추가

### 8.2 의존성 체인의 목적

```
Fiber.dependencies = {
  lanes: NoLanes,
  firstContext: {
    context: ThemeContext,
    memoizedValue: "dark",
    next: {
      context: LocaleContext,
      memoizedValue: "ko",
      next: null
    }
  }
}
```

이 연결 리스트는 `propagateContextChange_eager`에서 사용된다. Provider의 값이 변경되면, React는 트리를 순회하며 각 Fiber의 `dependencies.firstContext` 체인을 확인한다. 해당 Context에 의존하는 Fiber를 찾으면 재렌더링을 스케줄링한다.

### 8.3 propagateContextChange_eager

**react-dom.development.js L14211-14310**:

```javascript
function propagateContextChange_eager(workInProgress, context, renderLanes) {
  var fiber = workInProgress.child;

  if (fiber !== null) {
    fiber.return = workInProgress;
  }

  while (fiber !== null) {
    var nextFiber = void 0;
    var list = fiber.dependencies;

    if (list !== null) {
      nextFiber = fiber.child;
      var dependency = list.firstContext;

      while (dependency !== null) {
        if (dependency.context === context) {       // 같은 Context인가?
          // Match! Schedule an update on this fiber.
          if (fiber.tag === ClassComponent) {
            var update = createUpdate(NoTimestamp, lane);
            update.tag = ForceUpdate;
            // ... enqueue update
          }

          fiber.lanes = mergeLanes(fiber.lanes, renderLanes);
          // 조상 경로도 lanes 전파
          scheduleContextWorkOnParentPath(
            fiber.return, renderLanes, workInProgress
          );
          list.lanes = mergeLanes(list.lanes, renderLanes);
          break;
        }
        dependency = dependency.next;
      }
    } else if (fiber.tag === ContextProvider) {
      // 같은 종류의 Provider면 탐색 중단 (해당 Provider가 값을 덮어쓰므로)
      nextFiber = fiber.type === workInProgress.type ? null : fiber.child;
    } else {
      nextFiber = fiber.child;
    }
    // ... 다음 fiber로 이동
  }
}
```

핵심 로직: 모든 자손 Fiber를 DFS 순회하면서, 각 Fiber의 의존성 체인에 변경된 Context가 있으면 해당 Fiber에 업데이트를 스케줄링한다. `ContextProvider` Fiber를 만나면 같은 타입인지 확인하고, 같은 타입이면 그 아래는 탐색하지 않는다 (해당 Provider가 값을 override하므로).

---

## 9. React.lazy — 4단계 상태 머신

### 9.1 상태 상수

**react.development.js L1349-1352**:

```javascript
var Uninitialized = -1;    // L1349 — 초기 상태
var Pending = 0;           // L1350 — Promise 대기 중
var Resolved = 1;          // L1351 — 성공
var Rejected = 2;          // L1352 — 실패
```

### 9.2 lazy 함수

**react.development.js L1412-1424**:

```javascript
function lazy(ctor) {
  var payload = {
    _status: Uninitialized,                        // L1414
    _result: ctor                                   // L1415 — 초기에는 import 함수 자체
  };

  var lazyType = {
    $$typeof: REACT_LAZY_TYPE,                     // L1418
    _payload: payload,
    _init: lazyInitializer                         // L1420
  };

  return lazyType;
}
```

### 9.3 lazyInitializer — 상태 전이 로직

**react.development.js L1354-1406**:

```javascript
function lazyInitializer(payload) {
  if (payload._status === Uninitialized) {         // L1355
    var ctor = payload._result;
    var thenable = ctor();                          // dynamic import() 호출!

    thenable.then(
      function (moduleObject) {
        if (payload._status === Pending || payload._status === Uninitialized) {
          var resolved = payload;
          resolved._status = Resolved;              // L1367
          resolved._result = moduleObject;          // 모듈 저장
        }
      },
      function (error) {
        if (payload._status === Pending || payload._status === Uninitialized) {
          var rejected = payload;
          rejected._status = Rejected;              // L1374
          rejected._result = error;                 // 에러 저장
        }
      }
    );

    if (payload._status === Uninitialized) {       // L1379
      var pending = payload;
      pending._status = Pending;                    // L1383
      pending._result = thenable;                   // Promise 저장
    }
  }

  if (payload._status === Resolved) {              // L1388
    var moduleObject = payload._result;
    return moduleObject.default;                    // default export 반환!
  } else {
    throw payload._result;                          // Pending이면 Promise throw
  }                                                 // Rejected면 Error throw
}
```

### 9.4 상태 전이 다이어그램

```
┌──────────────────┐
│  Uninitialized   │  _status: -1
│  _result: ctor   │  _result = () => import('./Comp')
└────────┬─────────┘
         │ lazyInitializer() 호출
         │ ctor() 실행 → Promise 생성
         ▼
┌──────────────────┐
│    Pending       │  _status: 0
│  _result: Promise│  _result = import() 반환 Promise
└────────┬─────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌────────┐ ┌────────┐
│Resolved│ │Rejected│
│ _s: 1  │ │ _s: 2  │
│ _r:    │ │ _r:    │
│ module │ │ error  │
└────────┘ └────────┘
```

`_result` 필드는 상태에 따라 다른 것을 저장한다:
- `Uninitialized`: import 함수 (`() => import('./Comp')`)
- `Pending`: Promise 객체
- `Resolved`: 모듈 객체 (`{ default: Component }`)
- `Rejected`: Error 객체

이것이 `_result` 필드를 재활용하는 이유다. 상태별로 필요한 값이 다르고, 동시에 여러 상태에 있을 수 없으므로 하나의 필드로 충분하다. 메모리 효율적이다.

### 9.5 lazy와 Suspense의 연결

`lazyInitializer`가 `throw payload._result`를 하면:
- Pending 상태: Promise가 throw됨 → Suspense 바운더리가 catch → fallback 표시
- Rejected 상태: Error가 throw됨 → Error Boundary가 catch → 에러 UI 표시

이것은 7편에서 다룬 Suspense/Error Boundary의 `throwException` 메커니즘과 정확히 같은 패턴이다.

---

## 10. React.memo와 forwardRef — 합성 타입들

### 10.1 React.memo

**react.development.js L1547-1563**:

```javascript
function memo(type, compare) {
  {
    if (!isValidElementType(type)) {
      error('memo: The first argument must be a component. ...');
    }
  }

  var elementType = {
    $$typeof: REACT_MEMO_TYPE,                     // L1555
    type: type,                                     // 원본 컴포넌트
    compare: compare === undefined ? null : compare // 비교 함수
  };

  return elementType;
}
```

`memo`는 컴포넌트를 감싸는 래퍼 객체를 생성한다. `$$typeof`는 `REACT_MEMO_TYPE`, `type`은 원본 컴포넌트, `compare`는 커스텀 비교 함수다.

### 10.2 React.forwardRef

**react.development.js L1469-1487**:

```javascript
function forwardRef(render) {
  {
    if (render != null && render.$$typeof === REACT_MEMO_TYPE) {
      error('forwardRef requires a render function but received a `memo` '
        + 'component. Instead of forwardRef(memo(...)), use '
        + 'memo(forwardRef(...)).');                // 순서 경고!
    }
    // render 함수의 인자 수 검증
    if (render.length !== 0 && render.length !== 2) {
      error('forwardRef render functions accept exactly two parameters: '
        + 'props and ref.');
    }
  }

  var elementType = {
    $$typeof: REACT_FORWARD_REF_TYPE,              // L1487
    render: render                                  // 렌더 함수
  };

  return elementType;
}
```

### 10.3 합성 타입의 중첩

```
memo(forwardRef(render))   ← 올바른 순서

{
  $$typeof: REACT_MEMO_TYPE,
  type: {
    $$typeof: REACT_FORWARD_REF_TYPE,
    render: function(props, ref) { ... }
  },
  compare: null
}

forwardRef(memo(render))   ← 잘못된 순서 (경고 발생)
```

React는 `forwardRef(memo(...))`를 감지하고 경고한다. 왜냐하면 `memo`는 바깥에 있어야 불필요한 리렌더링을 방지할 수 있기 때문이다. `forwardRef`가 바깥에 있으면 memo의 비교가 먼저 실행되지 않는다.

### 10.4 getComponentNameFromType에서의 처리

**react.development.js L540-600**:

```javascript
if (typeof type === 'object') {
  switch (type.$$typeof) {
    case REACT_CONTEXT_TYPE:
      return getContextName(context) + '.Consumer';  // L574

    case REACT_PROVIDER_TYPE:
      return getContextName(provider._context) + '.Provider'; // L578

    case REACT_FORWARD_REF_TYPE:
      return getWrappedName(type, type.render, 'ForwardRef');  // L581

    case REACT_MEMO_TYPE:
      var outerName = type.displayName || null;
      if (outerName !== null) return outerName;
      return getComponentNameFromType(type.type) || 'Memo';    // L589

    case REACT_LAZY_TYPE:
      var payload = lazyComponent._payload;
      var init = lazyComponent._init;
      try {
        return getComponentNameFromType(init(payload));        // L596
      } catch (x) { return null; }
  }
}
```

각 합성 타입마다 이름을 추출하는 방법이 다르다. Memo는 내부 컴포넌트 이름을 재귀적으로 추출하고, ForwardRef는 `render` 함수의 이름을 사용한다. Lazy는 `_init`을 호출하여 해결된 컴포넌트의 이름을 가져온다.

---

## 11. reconcileChildFibers — ReactNode 분기의 심장부

모든 타입 정보가 실제로 사용되는 핵심 지점은 `reconcileChildFibers`다. 이 함수는 부모 Fiber의 자식을 재조정할 때 호출되며, `newChild`의 타입에 따라 완전히 다른 경로로 분기한다.

### 11.1 전체 분기 구조

**react-dom.development.js L14026-14081**:

```javascript
function reconcileChildFibers(returnFiber, currentFirstChild, newChild, lanes) {
  // 1. Fragment 언래핑 — 키 없는 최상위 Fragment는 배열처럼 처리
  var isUnkeyedTopLevelFragment =
    typeof newChild === 'object'
    && newChild !== null
    && newChild.type === REACT_FRAGMENT_TYPE
    && newChild.key === null;

  if (isUnkeyedTopLevelFragment) {
    newChild = newChild.props.children;             // L14037 — Fragment 벗기기
  }

  // 2. 객체 타입 분기
  if (typeof newChild === 'object' && newChild !== null) {
    switch (newChild.$$typeof) {
      case REACT_ELEMENT_TYPE:                      // L14043
        return placeSingleChild(
          reconcileSingleElement(returnFiber, currentFirstChild, newChild, lanes)
        );

      case REACT_PORTAL_TYPE:                       // L14046
        return placeSingleChild(
          reconcileSinglePortal(returnFiber, currentFirstChild, newChild, lanes)
        );

      case REACT_LAZY_TYPE:                         // L14049
        var payload = newChild._payload;
        var init = newChild._init;
        return reconcileChildFibers(              // 재귀 호출!
          returnFiber, currentFirstChild, init(payload), lanes
        );
    }

    if (isArray(newChild)) {                        // L14057
      return reconcileChildrenArray(
        returnFiber, currentFirstChild, newChild, lanes
      );
    }

    if (getIteratorFn(newChild)) {                  // L14061
      return reconcileChildrenIterator(
        returnFiber, currentFirstChild, newChild, lanes
      );
    }

    throwOnInvalidObjectType(returnFiber, newChild);
  }

  // 3. 텍스트 노드
  if (typeof newChild === 'string' && newChild !== ''
      || typeof newChild === 'number') {            // L14070
    return placeSingleChild(
      reconcileSingleTextNode(
        returnFiber, currentFirstChild, '' + newChild, lanes
      )
    );
  }

  // 4. 경고 (함수를 자식으로 전달한 경우)
  {
    if (typeof newChild === 'function') {
      warnOnFunctionType(returnFiber);
    }
  }

  // 5. 나머지 (null, undefined, boolean) — 기존 자식 삭제
  return deleteRemainingChildren(returnFiber, currentFirstChild);
}
```

### 11.2 분기 흐름도

```
reconcileChildFibers(newChild)
  │
  ├─ Fragment 언래핑 (key === null인 Fragment)
  │    └─ newChild = newChild.props.children
  │
  ├─ typeof === 'object' && !== null
  │    ├─ $$typeof === REACT_ELEMENT_TYPE
  │    │    └─ reconcileSingleElement()
  │    │         └─ createFiberFromElement()
  │    │
  │    ├─ $$typeof === REACT_PORTAL_TYPE
  │    │    └─ reconcileSinglePortal()
  │    │         └─ createFiberFromPortal()
  │    │
  │    ├─ $$typeof === REACT_LAZY_TYPE
  │    │    └─ init(payload)  ← lazy 해결
  │    │         └─ reconcileChildFibers() 재귀
  │    │
  │    ├─ isArray(newChild)
  │    │    └─ reconcileChildrenArray()
  │    │
  │    └─ getIteratorFn(newChild)
  │         └─ reconcileChildrenIterator()
  │
  ├─ typeof === 'string' || typeof === 'number'
  │    └─ reconcileSingleTextNode()
  │         └─ createFiberFromText()
  │
  └─ null / undefined / boolean
       └─ deleteRemainingChildren()  ← 기존 자식 모두 삭제
```

### 11.3 왜 Lazy만 재귀 호출인가?

`REACT_LAZY_TYPE`의 처리가 특이하다. 다른 타입은 각각의 전용 함수를 호출하는데, Lazy만 `init(payload)`로 해결한 후 `reconcileChildFibers`를 재귀 호출한다. 이유:

```javascript
case REACT_LAZY_TYPE:
  var payload = newChild._payload;
  var init = newChild._init;
  return reconcileChildFibers(
    returnFiber, currentFirstChild, init(payload), lanes
  );
```

`init(payload)` (= `lazyInitializer(payload)`)는 두 가지 결과를 낼 수 있다:
1. **Resolved**: 컴포넌트를 반환 → 이것이 다시 `reconcileChildFibers`로 들어가 `REACT_ELEMENT_TYPE` 경로를 탄다
2. **Pending/Rejected**: throw → Suspense/Error Boundary로 올라간다

Lazy는 "아직 무엇인지 모르는 타입"이므로, 해결한 후에 다시 분기해야 한다. 재귀 호출이 자연스러운 설계다.

### 11.4 createChild에서의 타입 분기

`reconcileChildrenArray` 내부에서 호출되는 `createChild`도 같은 패턴을 따른다.

**react-dom.development.js L13336-13380**:

```javascript
function createChild(returnFiber, newChild, lanes) {
  // 텍스트 노드
  if (typeof newChild === 'string' && newChild !== ''
      || typeof newChild === 'number') {
    var created = createFiberFromText('' + newChild, returnFiber.mode, lanes);
    created.return = returnFiber;
    return created;
  }

  if (typeof newChild === 'object' && newChild !== null) {
    switch (newChild.$$typeof) {
      case REACT_ELEMENT_TYPE:                       // L13345
        var _created = createFiberFromElement(newChild, returnFiber.mode, lanes);
        _created.ref = coerceRef(returnFiber, null, newChild);
        _created.return = returnFiber;
        return _created;

      case REACT_PORTAL_TYPE:                        // L13354
        var _created2 = createFiberFromPortal(newChild, returnFiber.mode, lanes);
        _created2.return = returnFiber;
        return _created2;

      case REACT_LAZY_TYPE:                          // L13362
        var payload = newChild._payload;
        var init = newChild._init;
        return createChild(returnFiber, init(payload), lanes);  // 재귀!
    }

    if (isArray(newChild) || getIteratorFn(newChild)) {
      var _created3 = createFiberFromFragment(newChild, returnFiber.mode, lanes, null);
      _created3.return = returnFiber;
      return _created3;
    }
  }

  return null;  // null/undefined/boolean → 무시
}
```

배열이나 이터러블 자식은 자동으로 Fragment Fiber로 래핑된다는 점에 주목하라.

---

## 12. createFiberFromTypeAndProps — Symbol에서 Fiber로

이 함수는 ReactElement의 `type`을 분석하여 적절한 Fiber tag를 결정한다. React의 모든 타입 분류가 여기서 최종적으로 Fiber로 변환된다.

### 12.1 전체 구현

**react-dom.development.js L28363-28490**:

```javascript
function createFiberFromTypeAndProps(type, key, pendingProps, owner, mode, lanes) {
  var fiberTag = IndeterminateComponent;  // 기본값: 2 (아직 모르는 상태)
  var resolvedType = type;

  // 1단계: 함수인가?
  if (typeof type === 'function') {                 // L28369
    if (shouldConstruct$1(type)) {
      fiberTag = ClassComponent;                    // 1 — 클래스 컴포넌트
    }
    // else: fiberTag = IndeterminateComponent (2) — 첫 렌더까지 판단 보류
  }

  // 2단계: 문자열인가?
  else if (typeof type === 'string') {              // L28382
    fiberTag = HostComponent;                       // 5 — DOM 엘리먼트
  }

  // 3단계: 그 외 (Symbol 또는 객체)
  else {
    getTag: switch (type) {
      case REACT_FRAGMENT_TYPE:                     // L28387
        return createFiberFromFragment(pendingProps.children, mode, lanes, key);

      case REACT_STRICT_MODE_TYPE:
        fiberTag = Mode;                            // 8

      case REACT_PROFILER_TYPE:                     // L28399
        return createFiberFromProfiler(pendingProps, mode, lanes, key);

      case REACT_SUSPENSE_TYPE:                     // L28402
        return createFiberFromSuspense(pendingProps, mode, lanes, key);

      case REACT_SUSPENSE_LIST_TYPE:                // L28405
        return createFiberFromSuspenseList(pendingProps, mode, lanes, key);

      case REACT_OFFSCREEN_TYPE:                    // L28408
        return createFiberFromOffscreen(pendingProps, mode, lanes, key);

      default:
        if (typeof type === 'object' && type !== null) {
          switch (type.$$typeof) {
            case REACT_PROVIDER_TYPE:               // L28433
              fiberTag = ContextProvider;            // 10
              break getTag;

            case REACT_CONTEXT_TYPE:                // L28437
              fiberTag = ContextConsumer;            // 9
              break getTag;

            case REACT_FORWARD_REF_TYPE:            // L28441
              fiberTag = ForwardRef;                 // 11
              break getTag;

            case REACT_MEMO_TYPE:                   // L28448
              fiberTag = MemoComponent;              // 14
              break getTag;

            case REACT_LAZY_TYPE:                   // L28452
              fiberTag = LazyComponent;              // 16
              resolvedType = null;
              break getTag;
          }
        }
        // 알 수 없는 타입 → Error throw
        throw new Error('Element type is invalid: expected a string ...');
    }
  }

  var fiber = createFiber(fiberTag, pendingProps, key, mode);
  fiber.elementType = type;
  fiber.type = resolvedType;
  fiber.lanes = lanes;
  return fiber;
}
```

### 12.2 타입 → Fiber tag 매핑표

```
┌─────────────────────────────────┬──────────────────────┬─────────┐
│ type 값                         │ Fiber tag            │ 숫자    │
├─────────────────────────────────┼──────────────────────┼─────────┤
│ function (prototype.isReactComp)│ ClassComponent       │   1     │
│ function (그 외)                │ IndeterminateComponent│  2     │
│ string ('div', 'span' 등)      │ HostComponent        │   5     │
│ REACT_FRAGMENT_TYPE             │ Fragment             │   7     │
│ REACT_STRICT_MODE_TYPE          │ Mode                 │   8     │
│ REACT_PROFILER_TYPE             │ Profiler             │  12     │
│ REACT_SUSPENSE_TYPE             │ SuspenseComponent    │  13     │
│ REACT_SUSPENSE_LIST_TYPE        │ SuspenseListComponent│  19     │
│ REACT_OFFSCREEN_TYPE            │ OffscreenComponent   │  22     │
│ { $$typeof: PROVIDER_TYPE }     │ ContextProvider      │  10     │
│ { $$typeof: CONTEXT_TYPE }      │ ContextConsumer      │   9     │
│ { $$typeof: FORWARD_REF_TYPE }  │ ForwardRef           │  11     │
│ { $$typeof: MEMO_TYPE }         │ MemoComponent        │  14     │
│ { $$typeof: LAZY_TYPE }         │ LazyComponent        │  16     │
└─────────────────────────────────┴──────────────────────┴─────────┘
```

### 12.3 IndeterminateComponent의 존재 이유

함수 컴포넌트는 처음에 `IndeterminateComponent`(2)로 분류된다. 왜 `FunctionComponent`(0)가 아닌가?

React 18에서는 함수가 클래스처럼 동작할 수 있는 레거시 케이스가 있다. `shouldConstruct`로 `prototype.isReactComponent`를 확인하면 클래스를 감지할 수 있지만, 일부 함수가 JSX 대신 클래스 인스턴스를 반환할 수도 있다. 그래서 첫 렌더링에서 실제로 호출해보고, 반환값을 확인한 후에야 `FunctionComponent`인지 `ClassComponent`인지 최종 결정한다.

**react-dom.development.js L21624**:

```javascript
case IndeterminateComponent:
  return mountIndeterminateComponent(
    current, workInProgress, workInProgress.type, renderLanes
  );
```

`mountIndeterminateComponent`는 함수를 호출하고, 결과에 따라 Fiber tag를 `FunctionComponent`(0) 또는 `ClassComponent`(1)로 교체한다.

---

## 13. beginWork의 거대한 switch — 모든 타입의 처리 경로

### 13.1 Fiber tag 상수

**react-dom.development.js L90-114**:

```javascript
var FunctionComponent = 0;           // L90
var ClassComponent = 1;              // L91
var IndeterminateComponent = 2;      // L92
var HostRoot = 3;                    // L94
var HostPortal = 4;                  // L96
var HostComponent = 5;               // L98
var HostText = 6;                    // L99
var Fragment = 7;                    // L100
var Mode = 8;                        // L101
var ContextConsumer = 9;             // L102
var ContextProvider = 10;            // L103
var ForwardRef = 11;                 // L104
var Profiler = 12;                   // L105
var SuspenseComponent = 13;          // L106
var MemoComponent = 14;              // L107
var SimpleMemoComponent = 15;        // L108
var LazyComponent = 16;              // L109
var IncompleteClassComponent = 17;   // L110
var SuspenseListComponent = 19;      // L112
var OffscreenComponent = 22;         // L114
```

### 13.2 beginWork switch 문

**react-dom.development.js L21624-21774**:

```javascript
switch (workInProgress.tag) {
  case IndeterminateComponent:       // 2
    return mountIndeterminateComponent(current, workInProgress,
      workInProgress.type, renderLanes);

  case LazyComponent:                // 16
    var elementType = workInProgress.elementType;
    return mountLazyComponent(current, workInProgress, elementType, renderLanes);

  case FunctionComponent:            // 0
    var Component = workInProgress.type;
    var unresolvedProps = workInProgress.pendingProps;
    var resolvedProps = workInProgress.elementType === Component
      ? unresolvedProps
      : resolveDefaultProps(Component, unresolvedProps);
    return updateFunctionComponent(current, workInProgress,
      Component, resolvedProps, renderLanes);

  case ClassComponent:               // 1
    return updateClassComponent(current, workInProgress,
      _Component, _resolvedProps, renderLanes);

  case HostRoot:                     // 3
    return updateHostRoot(current, workInProgress, renderLanes);

  case HostComponent:                // 5
    return updateHostComponent(current, workInProgress, renderLanes);

  case HostText:                     // 6
    return updateHostText(current, workInProgress);

  case SuspenseComponent:            // 13
    return updateSuspenseComponent(current, workInProgress, renderLanes);

  case HostPortal:                   // 4
    return updatePortalComponent(current, workInProgress, renderLanes);

  case ForwardRef:                   // 11
    return updateForwardRef(current, workInProgress,
      type, _resolvedProps2, renderLanes);

  case Fragment:                     // 7
    return updateFragment(current, workInProgress, renderLanes);

  case Mode:                         // 8
    return updateMode(current, workInProgress, renderLanes);

  case Profiler:                     // 12
    return updateProfiler(current, workInProgress, renderLanes);

  case ContextProvider:              // 10
    return updateContextProvider(current, workInProgress, renderLanes);

  case ContextConsumer:              // 9
    return updateContextConsumer(current, workInProgress, renderLanes);

  case MemoComponent:                // 14
    return updateMemoComponent(current, workInProgress,
      _type2, _resolvedProps3, renderLanes);

  case SimpleMemoComponent:          // 15
    return updateSimpleMemoComponent(current, workInProgress,
      workInProgress.type, workInProgress.pendingProps, renderLanes);

  case IncompleteClassComponent:     // 17
    return mountIncompleteClassComponent(current, workInProgress,
      _Component2, _resolvedProps4, renderLanes);

  case SuspenseListComponent:        // 19
    return updateSuspenseListComponent(current, workInProgress, renderLanes);

  case OffscreenComponent:           // 22
    return updateOffscreenComponent(current, workInProgress, renderLanes);
}

throw new Error("Unknown unit of work tag (" + workInProgress.tag + ").");
```

### 13.3 beginWork 전체 흐름

beginWork는 단순한 switch 문이 아니다. switch 문 이전에 bailout 로직이 있다.

**react-dom.development.js L21555-21622**:

```javascript
function beginWork(current, workInProgress, renderLanes) {
  // Phase 1: 업데이트 여부 판단
  if (current !== null) {
    var oldProps = current.memoizedProps;
    var newProps = workInProgress.pendingProps;

    if (oldProps !== newProps || hasContextChanged() ||
        workInProgress.type !== current.type) {
      didReceiveUpdate = true;                      // 업데이트 필요
    } else {
      var hasScheduledUpdateOrContext =
        checkScheduledUpdateOrContext(current, renderLanes);

      if (!hasScheduledUpdateOrContext &&
          (workInProgress.flags & DidCapture) === NoFlags) {
        didReceiveUpdate = false;
        return attemptEarlyBailoutIfNoScheduledUpdate(  // BAILOUT!
          current, workInProgress, renderLanes
        );
      }
      didReceiveUpdate = false;
    }
  } else {
    didReceiveUpdate = false;
  }

  // Phase 2: lanes 초기화
  workInProgress.lanes = NoLanes;

  // Phase 3: tag별 분기 (위의 switch 문)
  switch (workInProgress.tag) { ... }
}
```

핵심 흐름:

```
beginWork(current, workInProgress, renderLanes)
    │
    ├─ current !== null (업데이트)
    │    ├─ props/context/type 변경?
    │    │    ├─ YES → didReceiveUpdate = true → switch 진입
    │    │    └─ NO → 스케줄된 업데이트 확인
    │    │         ├─ 업데이트 없음 → BAILOUT (자식 스킵!)
    │    │         └─ 업데이트 있음 → switch 진입
    │    │
    │    └─ ForceUpdate flag?
    │         ├─ YES → didReceiveUpdate = true → switch 진입
    │         └─ NO → didReceiveUpdate = false → switch 진입
    │
    ├─ current === null (마운트)
    │    └─ didReceiveUpdate = false → switch 진입
    │
    └─ switch (workInProgress.tag)
         ├─ IndeterminateComponent → mountIndeterminateComponent
         ├─ FunctionComponent     → updateFunctionComponent
         ├─ ClassComponent        → updateClassComponent
         ├─ HostComponent         → updateHostComponent
         ├─ ContextProvider       → updateContextProvider
         │                            └─ pushProvider() + propagateContextChange()
         ├─ ContextConsumer       → updateContextConsumer
         │                            └─ readContext() + render(value)
         ├─ SuspenseComponent     → updateSuspenseComponent
         ├─ MemoComponent         → updateMemoComponent
         │                            └─ props 비교 → 동일하면 bailout
         └─ ... (기타 16개 tag)
```

### 13.4 updateContextProvider 상세

**react-dom.development.js L21150-21197**:

```javascript
function updateContextProvider(current, workInProgress, renderLanes) {
  var providerType = workInProgress.type;
  var context = providerType._context;              // Provider → Context 참조
  var newProps = workInProgress.pendingProps;
  var oldProps = workInProgress.memoizedProps;
  var newValue = newProps.value;

  pushProvider(workInProgress, context, newValue);  // L21173 — 값 push

  {
    if (oldProps !== null) {
      var oldValue = oldProps.value;

      if (objectIs(oldValue, newValue)) {           // Object.is 비교
        if (oldProps.children === newProps.children && !hasContextChanged()) {
          return bailoutOnAlreadyFinishedWork(      // 값 동일 → bailout!
            current, workInProgress, renderLanes
          );
        }
      } else {
        // 값 변경 → 모든 소비자에게 전파
        propagateContextChange(workInProgress, context, renderLanes);
      }
    }
  }

  var newChildren = newProps.children;
  reconcileChildren(current, workInProgress, newChildren, renderLanes);
  return workInProgress.child;
}
```

Context 값 비교에 `objectIs` (= `Object.is`)를 사용한다는 점이 중요하다. 이것은 `===`와 거의 같지만, `NaN === NaN`이 `true`이고 `+0 === -0`이 `false`라는 차이가 있다.

```javascript
// Object.is vs ===
Object.is(NaN, NaN)    // true  (=== 는 false)
Object.is(+0, -0)      // false (=== 는 true)
```

### 13.5 updateContextConsumer 상세

**react-dom.development.js L21199-21260**:

```javascript
function updateContextConsumer(current, workInProgress, renderLanes) {
  var context = workInProgress.type;

  {
    if (context._context === undefined) {
      // Context 직접 렌더링 경고
    } else {
      context = context._context;                   // Consumer._context → 원본 Context
    }
  }

  var newProps = workInProgress.pendingProps;
  var render = newProps.children;                    // render prop 패턴

  prepareToReadContext(workInProgress, renderLanes);
  var newValue = readContext(context);               // 현재 값 읽기

  var newChildren;
  {
    ReactCurrentOwner$1.current = workInProgress;
    setIsRendering(true);
    newChildren = render(newValue);                  // render(value) 호출!
    setIsRendering(false);
  }

  workInProgress.flags |= PerformedWork;
  reconcileChildren(current, workInProgress, newChildren, renderLanes);
  return workInProgress.child;
}
```

Consumer는 render prop 패턴을 사용한다: `<Context.Consumer>{value => <div>{value}</div>}</Context.Consumer>`. `readContext`로 현재 값을 읽고, children 함수에 전달한다.

---

## 14. 타입 시스템 전체 흐름 다이어그램

### 14.1 JSX → Fiber 변환 전체 파이프라인

```
 JSX 코드                    컴파일러 변환              ReactElement 생성
 ─────────                   ──────────               ─────────────────
 <App />             →    jsxDEV(App, {})       →    { $$typeof: ELEMENT,
                                                       type: App,
                                                       props: {} }

 <div className="a"> →    jsxDEV('div',         →    { $$typeof: ELEMENT,
                           {className: 'a'})          type: 'div',
                                                       props: {className:'a'} }

 <>...</>            →    jsxDEV(Fragment,       →    { $$typeof: ELEMENT,
                           {children: ...})           type: Symbol(fragment),
                                                       props: {children:...} }

 <Ctx.Provider>      →    jsxDEV(Ctx.Provider,   →    { $$typeof: ELEMENT,
                           {value: v})                type: {$$typeof: PROVIDER,
                                                             _context: ctx},
                                                       props: {value: v} }


 ReactElement                reconcileChildFibers      createFiberFromTypeAndProps
 ───────────                 ────────────────────      ─────────────────────────
 { $$typeof:           →    $$typeof 분기        →    type 분기
   ELEMENT,                                           ├─ function → ClassComponent(1)
   type: ... }               ELEMENT_TYPE:            │              or Indeterminate(2)
                             reconcileSingle-    →    ├─ string   → HostComponent(5)
                             Element()                ├─ Symbol
                                                      │  ├─ Fragment    → Fragment(7)
                                                      │  ├─ Suspense   → Suspense(13)
                                                      │  └─ Profiler   → Profiler(12)
                                                      └─ object.$$typeof
                                                         ├─ Provider  → ContextProvider(10)
                                                         ├─ Context   → ContextConsumer(9)
                                                         ├─ ForwardRef→ ForwardRef(11)
                                                         ├─ Memo      → MemoComponent(14)
                                                         └─ Lazy      → LazyComponent(16)


 Fiber 생성                  beginWork switch          실제 처리
 ──────────                  ───────────────           ──────────
 FiberNode {          →     tag별 분기          →     ├─ updateFunctionComponent
   tag: N,                                            │    → renderWithHooks
   type: ...,                                         ├─ updateClassComponent
   pendingProps: ...                                  │    → instance.render()
 }                                                    ├─ updateHostComponent
                                                      │    → reconcileChildren
                                                      ├─ updateContextProvider
                                                      │    → pushProvider + propagate
                                                      ├─ updateSuspenseComponent
                                                      │    → showFallback 분기
                                                      └─ ...
```

### 14.2 타입별 전체 여정

```
┌─────────────────────────────────────────────────────────────────────┐
│                    React 타입 시스템 전체 맵                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─── 생성 단계 ───┐  ┌── 분류 단계 ──┐  ┌──── 처리 단계 ────┐     │
│  │                  │  │               │  │                    │     │
│  │  createElement   │  │  reconcile-   │  │   beginWork        │     │
│  │  jsxDEV          │──│  ChildFibers  │──│   switch(tag)      │     │
│  │  createPortal    │  │  createFiber- │  │                    │     │
│  │  createContext   │  │  FromType-    │  │   tag=0: Function  │     │
│  │  lazy()          │  │  AndProps     │  │   tag=1: Class     │     │
│  │  memo()          │  │               │  │   tag=5: Host      │     │
│  │  forwardRef()    │  │  $$typeof →   │  │   tag=7: Fragment  │     │
│  │                  │  │  type →       │  │   tag=10: Provider │     │
│  │  Symbol.for()    │  │  type.$$ →    │  │   tag=11: ForwRef  │     │
│  │  로 태깅         │  │  Fiber tag    │  │   tag=13: Suspense │     │
│  │                  │  │               │  │   tag=14: Memo     │     │
│  └──────────────────┘  └───────────────┘  │   tag=16: Lazy     │     │
│                                            └────────────────────┘     │
│                                                                     │
│  보안: $$typeof = Symbol → JSON 직렬화 불가 → XSS 차단              │
│  성능: Context._currentValue 직접 변이 → O(1) 읽기                  │
│  확장: $$typeof 체계로 새 타입 추가 용이 (Offscreen, SuspenseList)  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 마무리

React의 타입 시스템은 세 개의 층으로 구성된다:

**1층 — Symbol 태깅**: `Symbol.for('react.element')` 같은 전역 Symbol로 객체의 정체성을 확인한다. JSON 직렬화가 불가능한 Symbol의 특성을 이용해 XSS 공격을 구조적으로 차단한다. 13개의 Symbol이 React 18.3.1의 전체 타입 태그다.

**2층 — ReactElement**: `$$typeof`, `type`, `key`, `ref`, `props`로 구성된 불변 객체다. DEV 모드에서는 `Object.freeze`로 동결되고, `_owner`, `_source`, `_store` 같은 디버그 필드가 추가된다. `createElement`과 `jsxDEV` 두 경로 모두 동일한 `ReactElement` 팩토리를 호출한다.

**3층 — Fiber tag**: reconciler가 실제로 사용하는 숫자 태그다. `createFiberFromTypeAndProps`에서 `type`을 분석하여 0(FunctionComponent)부터 22(OffscreenComponent)까지의 태그를 부여한다. `beginWork`의 switch 문이 이 태그에 따라 각 타입별 처리 로직을 실행한다.

이 세 층 사이의 변환이 React 렌더링의 첫 번째 관문이다. JSX가 브라우저에 그려지기까지 `createElement → reconcileChildFibers → createFiberFromTypeAndProps → beginWork`라는 파이프라인을 통과하며, 각 단계에서 타입 정보가 점점 더 구체적인 형태로 변환된다.

Context의 `_currentValue` 직접 변이, lazy의 `_result` 필드 재활용, `IndeterminateComponent`의 지연 분류 — 이런 설계들은 이론적 순수함보다 실용적 성능을 택한 React 팀의 결정이다. 타입 시스템이라는 기반 위에서 Fiber 아키텍처, 재조정, Suspense가 모두 동작한다.

---

> 이전 글: [React 아키텍처 심층 분석 (8/14): SSR](./react-architecture-08-ssr.md)
> 다음 글: React 아키텍처 심층 분석 (11/14): Host Configuration (예정)
