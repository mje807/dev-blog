# React 아키텍처 심층 분석 (1/14): 패키지 계층 구조 — 왜 React는 이렇게 나뉘어 있는가

> **React 아키텍처 심층 분석** 시리즈에 오신 것을 환영합니다. 이 시리즈는 총 14편에 걸쳐 React의 내부 구조를 소스 코드 수준에서 해부합니다. 공식 문서가 알려주지 않는 "왜"에 집중하며, React 코어 팀이 내린 설계 결정의 근원적 이유를 추적합니다. 첫 번째 편인 이 글에서는 React 모노레포의 패키지 계층 구조를 다룹니다. `npm install react react-dom`이라는 평범한 명령어 뒤에 숨어 있는 아키텍처적 결정들, 그리고 그 결정들이 수십억 사용자에게 서비스되는 코드베이스를 어떻게 가능하게 만드는지 살펴봅니다.

---

## 하나의 명령어, 열세 개의 패키지

React를 처음 설치하는 개발자는 대부분 이렇게 시작합니다.

```bash
npm install react react-dom
```

두 개의 패키지. 단순해 보입니다. 그런데 React의 GitHub 저장소를 열어보면 전혀 다른 풍경이 펼쳐집니다. `packages/` 디렉토리 아래에는 13개 이상의 패키지가 존재하고, 각각이 명확한 경계와 책임을 가지고 있습니다.

```
facebook/react (monorepo)
└── packages/
    ├── react                        # Core API
    ├── react-reconciler             # Fiber 재조정 엔진
    ├── scheduler                    # 우선순위 기반 태스크 스케줄러
    ├── react-dom                    # 브라우저 DOM 렌더러
    ├── react-native-renderer        # React Native 렌더러
    ├── react-art                    # SVG/Canvas 렌더러
    ├── react-test-renderer          # 테스트용 렌더러
    ├── react-server-dom-webpack     # RSC (Webpack)
    ├── react-server-dom-turbopack   # RSC (Turbopack)
    ├── react-devtools-*             # 개발자 도구
    ├── shared                       # 공유 유틸리티
    ├── react-debug-tools            # 디버깅 도구
    └── ...
```

왜 이렇게 나뉘어 있을까요? "관심사 분리"라는 교과서적 답변은 표면에 불과합니다. 진짜 이유를 이해하려면 React가 걸어온 길, 그리고 Meta(구 Facebook) 규모에서 코드를 운영한다는 것이 무엇을 의미하는지부터 살펴봐야 합니다.

---

## 왜 모노레포인가: 원자적 변경이라는 생존 전략

### 패키지 간 비밀 계약

React의 패키지들은 겉으로 보이는 것보다 훨씬 더 긴밀하게 얽혀 있습니다. 공개 API 뒤에 숨어 있는 내부 계약(internal contract)이 존재하기 때문입니다.

가장 대표적인 예가 `ReactSharedInternals`입니다. 이 객체는 `react` 패키지 내부에 존재하지만, `react-reconciler`가 직접 접근하여 뮤테이션합니다.

```
┌─────────────┐    내부 계약     ┌───────────────────┐
│   react     │◄───────────────►│  react-reconciler  │
│             │  SharedInternals │                    │
│ ┌─────────┐ │                  │  Fiber 노드 구조   │
│ │Dispatcher│◄──── 뮤테이션 ────│  재조정 알고리즘    │
│ │Owner     │ │                  │  Lane 모델         │
│ │BatchConf │ │                  │                    │
│ └─────────┘ │                  └────────┬───────────┘
└─────────────┘                           │
                                          │ HostConfig
                                          ▼
                               ┌───────────────────┐
                               │    react-dom       │
                               │  DOM 조작, 이벤트   │
                               │  하이드레이션        │
                               └───────────────────┘
```

이 구조에서 핵심은 `ReactSharedInternals`가 **공개 API가 아니라는 점**입니다. npm의 semver 규칙에 따르면 내부 구현은 패치 버전에서도 바뀔 수 있습니다. 그런데 이 내부 구현에 여러 패키지가 의존하고 있습니다.

만약 이 패키지들이 각각 별도의 GitHub 저장소에 존재했다면 어떤 일이 벌어질까요? `react`의 `ReactCurrentDispatcher` 구조를 약간이라도 변경하면, `react-reconciler`를 업데이트하고, 그에 맞춰 `react-dom`을 업데이트하고, `react-native-renderer`를 업데이트하고, `react-test-renderer`를 업데이트해야 합니다. 각각 PR을 올리고, 리뷰를 받고, CI를 통과시키고, npm에 배포해야 합니다. 그 사이에 사용자가 새 `react`와 옛 `react-dom`을 조합하면? 런타임 에러입니다.

이것은 이론적 시나리오가 아닙니다. JavaScript 생태계에서 실제로 반복되는 문제이며, React 팀이 모노레포를 선택한 가장 근본적인 이유입니다.

### 원자적 변경(Atomic Change)의 가치

모노레포에서는 하나의 커밋이 여러 패키지를 동시에 변경할 수 있습니다. Fiber 노드에 새로운 필드를 추가하는 변경이 `react-reconciler`, `react-dom`, `react-native-renderer`에 동시에 반영됩니다. 하나의 PR, 하나의 리뷰, 하나의 CI 파이프라인. 실패하면 전체가 실패하고, 성공하면 전체가 성공합니다.

Robert C. Martin이 제시한 **공통 폐쇄 원칙(Common Closure Principle)**이 정확히 이 상황을 설명합니다: "함께 변경되는 것들은 같은 곳에 있어야 한다." React의 패키지들은 독립적으로 보이지만, 내부 계약으로 묶여 있기 때문에 함께 변경될 수밖에 없습니다. 모노레포는 이 현실을 코드 구조에 정직하게 반영한 것입니다.

모노레포와 폴리레포의 선택은 취향이 아닙니다. React처럼 패키지 간 내부 의존성이 강하고, 동시 배포가 필수적인 프로젝트에서 모노레포는 **생존 전략**입니다.

```
┌─────────────────────────────────────────────────┐
│                  모노레포 (Monorepo)              │
│                                                   │
│  commit abc123:                                   │
│  ├── packages/react-reconciler/                   │
│  │   └── ReactFiberWorkLoop.js  (Fiber 구조 변경)  │
│  ├── packages/react-dom/                          │
│  │   └── ReactDOMHostConfig.js  (DOM 어댑터 수정)  │
│  └── packages/react-native-renderer/              │
│      └── ReactNativeHostConfig.js (Native 수정)   │
│                                                   │
│  → 하나의 커밋, 하나의 리뷰, 하나의 배포           │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│                  폴리레포 (Polyrepo)              │
│                                                   │
│  react-reconciler 저장소: PR #487 → 머지 → 배포    │
│       ↓ (기다림)                                   │
│  react-dom 저장소: PR #312 → 머지 → 배포           │
│       ↓ (기다림)                                   │
│  react-native-renderer 저장소: PR #891 → ...       │
│                                                   │
│  → 중간에 불일치 버전 조합 가능, 런타임 에러 위험   │
└─────────────────────────────────────────────────┘
```

---

## peerDependency의 진짜 의미: 싱글톤이 깨지면 모든 것이 깨진다

`react-dom`의 `package.json`을 살펴보면 흥미로운 패턴이 보입니다.

```json
{
  "peerDependencies": {
    "react": "^19.0.0"
  },
  "dependencies": {
    "scheduler": "^0.25.0"
  }
}
```

`react`는 `peerDependencies`로, `scheduler`는 `dependencies`로 선언되어 있습니다. 이 차이는 단순한 컨벤션이 아닙니다. **물리적 필요**입니다.

### Hook 시스템과 싱글톤

React의 Hook 시스템은 전역 상태에 의존합니다. `useState`를 호출하면 실제로 일어나는 일은 이렇습니다.

```javascript
// react 패키지 내부 (단순화)
function useState(initialState) {
  const dispatcher = ReactSharedInternals.ReactCurrentDispatcher.current;
  return dispatcher.useState(initialState);
}
```

`ReactCurrentDispatcher`는 `react` 패키지의 모듈 스코프에 존재하는 싱글톤 객체입니다. `react-reconciler`는 렌더링 단계에서 이 dispatcher를 적절한 구현체로 교체합니다. 마운트 시에는 `HooksDispatcherOnMount`로, 업데이트 시에는 `HooksDispatcherOnUpdate`로, 렌더링 외부에서는 에러를 던지는 `ContextOnlyDispatcher`로 교체합니다.

여기서 핵심 문제가 드러납니다. **`react` 패키지의 인스턴스가 두 개 존재하면 dispatcher도 두 개가 됩니다.** 컴포넌트 A가 참조하는 `react`의 dispatcher와 reconciler가 설정하는 `react`의 dispatcher가 서로 다른 객체를 가리킬 수 있습니다.

결과는 개발자라면 누구나 한 번쯤 만나봤을 그 에러 메시지입니다:

> **"Error: Invalid hook call. Hooks can only be called inside of the body of a function component."**

이 에러의 원인 목록에서 React 공식 문서가 첫 번째로 언급하는 것이 바로 "You might have more than one copy of React in the same app"입니다. `peerDependencies`는 이 문제를 npm의 의존성 해석 단계에서 방지하는 메커니즘입니다. `react`를 peer dependency로 선언하면, 호스트 애플리케이션의 `react` 인스턴스를 공유하게 되어 싱글톤이 보장됩니다.

반면 `scheduler`는 `dependencies`로 선언해도 괜찮습니다. scheduler는 독립적인 태스크 큐를 관리하며, 여러 인스턴스가 존재해도 (비효율적일 수는 있지만) 논리적 오류가 발생하지 않습니다. **싱글톤이 필수인 것과 선호되는 것의 차이**가 peer vs regular dependency의 선택 기준입니다.

### 현실에서 만나는 문제

이 싱글톤 요구사항은 다음 상황에서 자주 깨집니다:

1. **npm link 또는 yarn link**: 로컬 패키지 개발 시 심볼릭 링크가 별도의 `react` 인스턴스를 참조
2. **Monorepo의 잘못된 hoisting**: `react`가 여러 `node_modules`에 중복 설치
3. **번들러 설정 문제**: Webpack alias가 올바르게 설정되지 않은 경우
4. **마이크로 프론트엔드**: 독립적으로 빌드된 앱들이 각자의 `react`를 가져올 때

이런 경우 해결책은 항상 동일합니다: **애플리케이션 전체에서 단 하나의 `react` 인스턴스만 존재하도록 보장하는 것.** 이것은 React의 Hook 아키텍처가 요구하는 구조적 제약이며, `peerDependencies` 선언은 이 제약을 패키지 매니저에게 전달하는 공식적인 방법입니다.

---

## react와 react-dom의 분리: 역사가 만든 아키텍처

### 2013년: 하나의 패키지

React가 2013년 JSConf US에서 처음 오픈소스로 공개되었을 때, 모든 것이 하나의 `react` 패키지 안에 있었습니다. 컴포넌트 모델, 재조정 알고리즘, DOM 렌더링이 모두 한 곳에 뒤섞여 있었습니다. 당시에는 이것이 합리적이었습니다. React는 브라우저 DOM을 위한 라이브러리였으니까요.

### 2015년: React Native가 모든 것을 바꾸다

v0.14에서 `react`와 `react-dom`이 분리됩니다. 직접적인 계기는 React Native의 등장이었습니다. React의 컴포넌트 모델과 선언적 프로그래밍 패러다임이 모바일 네이티브 UI에도 적용될 수 있다는 것이 증명되면서, "React의 핵심은 DOM이 아니다"라는 깨달음이 구체화되었습니다.

이 분리는 단순히 코드를 두 npm 패키지로 나눈 것이 아닙니다. React의 정체성에 대한 근본적인 재정의였습니다.

```
2013 (v0.1):                     2015 (v0.14):
┌──────────────────┐             ┌──────────────┐
│      react       │             │    react     │  ← 플랫폼 독립
│                  │             │  Component   │
│  Component Model │    분리     │  createElement│
│  Reconciliation  │  ──────►   │  Hooks       │
│  DOM Rendering   │             │  Context     │
│  Event System    │             └──────────────┘
│                  │                    │
└──────────────────┘             ┌──────────────┐
                                 │  react-dom   │  ← 브라우저 전용
                                 │  DOM 조작     │
                                 │  이벤트 위임   │
                                 │  하이드레이션  │
                                 └──────────────┘
```

### 분리가 담고 있는 철학

`react` 패키지에 남은 것들을 나열해보면 패턴이 보입니다:

- `React.Component`, `React.PureComponent` — 컴포넌트 정의
- `React.createElement`, JSX 런타임 — UI 트리 **선언**
- Hooks API (`useState`, `useEffect`, `useMemo` 등) — 상태와 부수효과 **선언**
- `React.createContext` — 컨텍스트 **선언**
- `React.Suspense`, `React.lazy` — 비동기 경계 **선언**

모든 것이 **선언(declaration)**입니다. "이런 UI가 되어야 한다"는 의도의 표현이지, 실제로 화면에 무언가를 그리는 코드는 한 줄도 없습니다. `react` 패키지만으로는 화면에 아무것도 나타나지 않습니다.

반면 `react-dom`에 있는 것들은:

- 실제 DOM 요소의 생성, 수정, 삭제
- 브라우저 이벤트의 캡처와 위임
- SSR을 위한 HTML 문자열 생성
- 하이드레이션 — 서버에서 생성된 HTML과 클라이언트 상태의 연결

모든 것이 **실행(execution)**입니다. 브라우저라는 특정 플랫폼에서 실제로 일을 하는 코드입니다.

이 분리 덕분에 `react` 패키지의 API로 작성된 컴포넌트는 어떤 렌더러와도 결합할 수 있습니다. 동일한 `useState`, 동일한 `useEffect`가 브라우저에서도, iOS에서도, 터미널에서도 작동합니다. 렌더러만 교체하면 됩니다.

---

## What, How, When, Where: 네 가지 질문의 분리

React의 패키지 구조를 가장 명확하게 이해하는 방법은 각 패키지가 답하는 **질문**이 다르다는 것을 인식하는 것입니다.

```
┌─────────────────────────────────────────────────────────┐
│                      react (Core)                        │
│              "무엇을 그릴 것인가?" (WHAT)                  │
│                                                          │
│  const element = <Button color="blue">Click</Button>;    │
│  → { type: Button, props: { color: "blue", ... } }       │
│                                                          │
│  개발자가 선언한 UI의 의도를 자료구조로 변환               │
└──────────────────────────┬──────────────────────────────┘
                           │ React Element Tree
                           ▼
┌─────────────────────────────────────────────────────────┐
│                  react-reconciler                         │
│           "어떻게 변화를 계산할 것인가?" (HOW)              │
│                                                          │
│  이전 트리와 새 트리를 비교 (Diffing)                      │
│  최소한의 변경 사항을 Fiber 트리에 기록                     │
│  Effect List 구성                                        │
└──────────────────────────┬──────────────────────────────┘
                           │ Effects (변경 명령)
                           ▼
┌─────────────────────────────────────────────────────────┐
│                      scheduler                           │
│            "언제 업데이트할 것인가?" (WHEN)                 │
│                                                          │
│  우선순위에 따라 작업 스케줄링                              │
│  프레임 양보 (yield to browser)                           │
│  타임 슬라이싱 (Time Slicing)                              │
└──────────────────────────┬──────────────────────────────┘
                           │ 스케줄된 콜백
                           ▼
┌─────────────────────────────────────────────────────────┐
│               react-dom / react-native / ...             │
│            "어디에 그릴 것인가?" (WHERE)                    │
│                                                          │
│  플랫폼별 실제 렌더링 수행                                 │
│  DOM 조작, Native View 생성, 터미널 출력 등                │
└─────────────────────────────────────────────────────────┘
```

이 분리는 Edsger Dijkstra가 1974년 논문 "On the role of scientific thought"에서 제시한 관심사 분리(Separation of Concerns) 원칙의 정수입니다. 각 관심사를 격리하면 한 부분의 변경이 다른 부분에 미치는 영향을 최소화할 수 있습니다.

그런데 React가 처음부터 이렇게 깔끔하게 분리되어 있었던 것은 아닙니다.

### Stack에서 Fiber로: 분리의 촉매

2013년부터 2017년까지 React의 재조정 엔진은 "Stack Reconciler"였습니다. 이름 그대로 콜 스택 기반으로 동작했으며, 한번 렌더링이 시작되면 **중간에 멈출 수 없었습니다**. 컴포넌트 트리가 깊으면 메인 스레드가 오랫동안 블로킹되어 사용자 입력이 지연되는 문제가 있었습니다.

이 문제를 해결하려면 "재조정 알고리즘"과 "실행 타이밍"을 분리해야 했습니다. 재조정은 "어떤 변경이 필요한지 계산"하고, 스케줄러는 "그 계산을 언제 실행할지 결정"합니다. Stack Reconciler에서는 이 두 관심사가 뒤섞여 있었기 때문에 분리가 불가능했습니다.

2017년 Fiber 아키텍처의 등장은 이 분리를 가능하게 한 구조적 혁신이었습니다. Fiber는 재조정 작업을 **중단 가능한 단위(unit of work)**로 쪼갭니다. 각 Fiber 노드가 하나의 작업 단위이며, 스케줄러는 이 작업 단위들을 우선순위에 따라 실행하거나 중단할 수 있습니다.

이것이 `scheduler` 패키지가 별도로 존재하는 이유입니다. 재조정(HOW)과 스케줄링(WHEN)은 서로 다른 문제이며, Fiber 아키텍처가 이 두 문제를 물리적으로 분리할 수 있는 구조적 기반을 제공한 것입니다.

### Scheduler의 우선순위 체계

`scheduler` 패키지는 5단계 우선순위 시스템을 구현합니다:

```
우선순위 레벨          타임아웃     사용 사례
─────────────────────────────────────────────────────────
ImmediatePriority (1)   -1ms       동기적 즉시 실행 (flushSync)
UserBlockingPriority(2) 250ms      사용자 입력, 클릭, 타이핑
NormalPriority (3)      5000ms     일반 상태 업데이트
LowPriority (4)         10000ms    지연 가능한 업데이트
IdlePriority (5)        maxSafe    유휴 시간에만 실행
```

이 우선순위는 React 18에서 도입된 Lane 모델과 연동됩니다. `startTransition`으로 감싼 업데이트는 낮은 우선순위로 스케줄링되어, 사용자 입력 같은 높은 우선순위 작업에 양보합니다. 이것이 가능한 이유는 스케줄링이 재조정과 분리되어 있기 때문입니다. 재조정 엔진은 "무엇이 바뀌었는지"만 계산하고, "그 계산을 지금 할지 나중에 할지"는 스케줄러가 결정합니다.

---

## react-reconciler: 세상에서 가장 유연한 렌더링 프레임워크

### HostConfig 인터페이스: 의존성 역전의 실체

`react-reconciler`는 React 아키텍처에서 가장 흥미로운 패키지입니다. 이 패키지는 Fiber 기반 재조정 알고리즘의 전체 구현을 담고 있지만, **특정 플랫폼에 대해서는 아무것도 모릅니다.** DOM이 무엇인지, View가 무엇인지, Canvas가 무엇인지 모릅니다.

대신 **HostConfig**라는 인터페이스를 정의합니다. 이 인터페이스는 약 60개 이상의 메서드로 구성되며, 각 렌더러가 이를 구현해야 합니다.

```
┌─────────────────────────────────────────┐
│          react-reconciler               │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │   재조정 알고리즘 (Fiber)        │    │
│  │   - beginWork                   │    │
│  │   - completeWork                │    │
│  │   - commitWork                  │    │
│  │   - Hook 시스템                  │    │
│  └──────────┬──────────────────────┘    │
│             │                           │
│  ┌──────────▼──────────────────────┐    │
│  │   HostConfig 인터페이스          │    │
│  │   (추상 계층)                    │    │
│  │                                 │    │
│  │   createInstance()              │    │
│  │   createTextInstance()          │    │
│  │   appendChild()                 │    │
│  │   removeChild()                 │    │
│  │   commitUpdate()                │    │
│  │   commitMount()                 │    │
│  │   ...약 60개 메서드              │    │
│  └─────────────────────────────────┘    │
└──────────┬──────────┬──────────┬────────┘
           │          │          │
    구현    │   구현    │   구현    │
           ▼          ▼          ▼
    ┌──────────┐ ┌─────────┐ ┌─────────┐
    │react-dom │ │ react-  │ │  ink    │
    │          │ │ native  │ │(터미널) │
    │DOM 조작  │ │UIKit/   │ │ANSI    │
    │이벤트    │ │Android  │ │escape  │
    └──────────┘ └─────────┘ └─────────┘
```

이것은 **의존성 역전 원칙(Dependency Inversion Principle)**의 교과서적 구현입니다. 전통적인 설계에서는 상위 모듈이 하위 모듈에 직접 의존합니다:

```
전통적 구조:
react-reconciler ──────► react-dom (직접 의존)
                ──────► react-native (직접 의존)
```

이 구조에서는 새로운 렌더링 타겟을 추가할 때마다 reconciler를 수정해야 합니다. React의 실제 구조는 이를 뒤집습니다:

```
React의 구조:
react-reconciler ──────► HostConfig 인터페이스 (추상화에 의존)
                              ▲
react-dom ────────────────────┘ (구현이 추상화에 의존)
react-native ─────────────────┘
ink ──────────────────────────┘
```

상위 모듈(reconciler)과 하위 모듈(각 렌더러) 모두 추상화(HostConfig)에 의존합니다. reconciler는 HostConfig가 어떻게 구현되는지 모르고, 렌더러는 reconciler의 내부 알고리즘을 모릅니다. 둘 사이의 계약만 안정적으로 유지되면 독립적으로 진화할 수 있습니다.

### HostConfig의 주요 범주

HostConfig의 60여 개 메서드는 다음 범주로 분류됩니다:

**인스턴스 생성:**
```javascript
createInstance(type, props, rootContainer, hostContext, internalHandle)
// react-dom: document.createElement(type)
// react-native: UIManager.createView(...)
// ink: new DOMElement(type)

createTextInstance(text, rootContainer, hostContext, internalHandle)
// react-dom: document.createTextNode(text)
// react-native: { text: text }
// ink: new TextNode(text)
```

**트리 조작:**
```javascript
appendChild(parentInstance, child)
insertBefore(parentInstance, child, beforeChild)
removeChild(parentInstance, child)
clearContainer(container)
```

**커밋 단계 (부수효과 실행):**
```javascript
commitMount(instance, type, props, internalHandle)
commitUpdate(instance, updatePayload, type, prevProps, nextProps)
commitTextUpdate(textInstance, prevText, nextText)
```

**컨텍스트:**
```javascript
getRootHostContext(rootContainer)
getChildHostContext(parentHostContext, type, rootContainer)
```

**스케줄링 지원:**
```javascript
scheduleTimeout(fn, delay)
cancelTimeout(id)
noTimeout  // 상수
```

### 커뮤니티가 증명한 확장성

이 아키텍처의 진가는 커뮤니티가 만들어낸 커스텀 렌더러들이 증명합니다:

- **react-three-fiber**: React로 Three.js 3D 씬을 선언적으로 구성. `<mesh>`, `<boxGeometry>` 같은 JSX로 3D 오브젝트를 다룸
- **ink**: 터미널에서 React 컴포넌트를 렌더링. CLI 도구의 UI를 `useState`와 `useEffect`로 구축
- **react-pdf**: PDF 문서를 React 컴포넌트로 생성
- **react-konva**: HTML5 Canvas 2D 그래픽을 React 방식으로 구성
- **react-figma**: Figma 플러그인을 React로 개발

이 모든 프로젝트가 가능한 이유는 `react-reconciler`가 HostConfig 인터페이스 뒤에 플랫폼 세부사항을 숨기기 때문입니다. Fiber 기반 재조정, Hook 시스템, Suspense, Concurrent Features 같은 React의 핵심 기능을 각 렌더러가 공짜로 얻습니다. 렌더러 개발자는 "DOM 요소를 어떻게 만들 것인가"만 답하면 되고, "컴포넌트 트리의 변경을 어떻게 효율적으로 계산할 것인가"는 reconciler가 처리합니다.

이것이 `react-reconciler`를 별도 패키지로 분리한 핵심 가치입니다. React는 단순한 UI 라이브러리가 아니라, **선언적 UI 프로그래밍을 위한 플러그인 프레임워크**로 진화했습니다.

---

## Feature Flags: Meta 규모에서 코드를 운영하는 법

### 왜 Feature Flag인가

React를 사용하는 곳은 개인 사이드 프로젝트부터 Meta의 Facebook, Instagram, WhatsApp까지 다양합니다. 새로운 기능을 추가하거나 레거시 코드를 제거할 때, 모든 사용자에게 동시에 적용하는 것은 불가능에 가깝습니다. 특히 Meta 내부에서는 수만 개의 컴포넌트가 React에 의존하고 있어, 하나의 breaking change가 예측할 수 없는 범위로 전파될 수 있습니다.

React는 이 문제를 **Feature Flag 시스템**으로 해결합니다. `ReactFeatureFlags.js`라는 파일이 존재하며, 이 파일의 포크(fork)가 배포 환경별로 존재합니다.

```
packages/shared/
├── ReactFeatureFlags.js              # 기본 정의 (OSS stable)
├── forks/
│   ├── ReactFeatureFlags.www.js      # Meta 내부 (facebook.com)
│   ├── ReactFeatureFlags.native-fb.js # Meta React Native
│   ├── ReactFeatureFlags.native-oss.js# React Native OSS
│   ├── ReactFeatureFlags.test-renderer.js
│   └── ...
```

각 환경별 파일에서 동일한 플래그가 다른 값을 가질 수 있습니다:

```javascript
// ReactFeatureFlags.js (OSS stable)
export const enableUseMemoCacheHook = false;

// ReactFeatureFlags.www.js (Meta 내부)
export const enableUseMemoCacheHook = true;

// ReactFeatureFlags.native-oss.js
export const enableUseMemoCacheHook = false;
```

이것은 세 가지 중요한 용도를 가집니다.

### 1. 점진적 마이그레이션

React의 역사에서 가장 긴 마이그레이션 중 하나는 레거시 Context API에서 `createContext`로의 전환이었습니다. 이 전환은 수년에 걸쳐 진행되었으며, 그 동안 두 API가 공존해야 했습니다.

Feature flag를 통해 다음 단계를 밟습니다:

```
1단계: 새 API 도입 (플래그 뒤에 숨김)
       enableNewContextAPI = true  (실험)
       enableNewContextAPI = false (안정)

2단계: 마이그레이션 도구 제공
       codemod, ESLint 규칙

3단계: 경고 추가
       enableLegacyContextWarning = true
       "Legacy context API detected..."

4단계: 레거시 API를 플래그로 분기
       if (enableLegacyContext) { ... }

5단계: 플래그 제거, 레거시 코드 삭제
```

이것은 Michael Feathers가 설명한 **Strangler Fig 패턴**과 정확히 일치합니다. 새로운 코드가 오래된 코드를 점진적으로 감싸며 교체하고, 최종적으로 오래된 코드는 제거됩니다.

### 2. 실험적 기능의 격리

npm에서 `react@experimental`을 설치하면 `react@latest`와 다른 기능이 활성화됩니다. 이 차이는 동일한 소스 코드에서 feature flag의 값만 달리하여 만들어집니다.

```
react@latest (stable):
  enableUseHook = true        ← 이미 안정화
  enableCache = false         ← 아직 실험적
  enableTaint = false         ← 아직 실험적

react@experimental:
  enableUseHook = true
  enableCache = true          ← 활성화
  enableTaint = true          ← 활성화
```

### 3. Kill Switch: 즉각적 롤백

Meta 내부에서는 feature flag가 런타임에 동적으로 변경될 수 있는 구조를 가지고 있습니다. 새로운 기능이 프로덕션에서 문제를 일으키면, 코드를 재배포하지 않고도 플래그를 끄는 것만으로 즉각적인 롤백이 가능합니다.

이것이 React가 Meta의 수십억 사용자를 대상으로 매주 새 버전을 배포할 수 있는 이유 중 하나입니다. 실험은 공격적으로 하되, 실패의 폭발 반경은 최소화합니다.

---

## 빌드 타임 최적화: Dead Code Elimination과 플래그의 결합

Feature flag의 진정한 위력은 빌드 시스템과 결합할 때 나타납니다. React의 빌드 파이프라인은 Rollup을 기반으로 하며, 다음 단계를 거칩니다:

```
소스 코드 (.js, Flow 타입 포함)
    │
    ▼
[Fork Resolution]  ← 환경별 ReactFeatureFlags 선택
    │
    ▼
[Flow Type Strip]  ← Flow 타입 어노테이션 제거
    │
    ▼
[Babel Transform]  ← JSX 변환, ES6+ → ES5
    │
    ▼
[Feature Flag Inlining]  ← 플래그를 리터럴 값으로 치환
    │
    ▼
[Closure Compiler / Terser]  ← 최적화, 축소, DCE
    │
    ▼
[License Header]   ← 라이선스 정보 추가
    │
    ▼
최종 번들 (react.production.min.js)
```

핵심은 **Feature Flag Inlining** 단계입니다. 빌드 시 feature flag가 리터럴 `true` 또는 `false`로 치환됩니다.

```javascript
// 소스 코드
import { enableSchedulingProfiler } from 'shared/ReactFeatureFlags';

if (enableSchedulingProfiler) {
  markRenderStarted(lanes);
}

// 빌드 후 (enableSchedulingProfiler = false인 환경)
if (false) {
  markRenderStarted(lanes);
}

// Closure Compiler / Terser의 Dead Code Elimination 후
// (완전히 제거됨 — 바이트 0)
```

이 메커니즘은 `__DEV__`, `__EXPERIMENTAL__`, `__PROFILE__`, `__VARIANT__` 같은 빌드 타임 매크로에도 동일하게 적용됩니다.

```javascript
if (__DEV__) {
  console.warn('This component is deprecated...');
  // 개발 환경에서만 존재, 프로덕션에서는 완전히 제거
}
```

결과적으로 프로덕션 빌드는 해당 환경에서 필요한 코드만 포함합니다. 실험적 기능, 개발 전용 경고, 프로파일링 코드가 프로덕션 번들 크기에 영향을 주지 않습니다. 이것은 "모든 코드를 하나의 소스에서 관리하되, 배포 환경별로 다른 바이너리를 생성한다"는 전략이며, 모노레포 구조와 완벽하게 맞물립니다.

### 빌드 매크로의 종류와 의미

| 매크로 | 의미 | 프로덕션 값 |
|--------|------|------------|
| `__DEV__` | 개발 모드 여부 | `false` |
| `__EXPERIMENTAL__` | 실험적 빌드 여부 | `false` (stable) / `true` (experimental) |
| `__PROFILE__` | 프로파일링 지원 여부 | `false` (prod) / `true` (profiling) |
| `__VARIANT__` | A/B 테스트 변형 | 테스트 환경에서만 사용 |

`__DEV__` 매크로 하나만 보더라도, React 소스 코드 전체에 수천 개의 `if (__DEV__)` 블록이 있습니다. 이 블록들 안에는 친절한 에러 메시지, prop 타입 검증, 렌더링 성능 경고 등 개발 경험을 위한 코드가 담겨 있습니다. 프로덕션에서 이 모든 것이 사라지는 덕분에, React의 프로덕션 번들은 개발 번들보다 상당히 작습니다.

---

## React 19에서의 진화: 경계의 재정의

React 19는 패키지 구조에 새로운 차원을 추가했습니다. 가장 큰 변화는 **서버와 클라이언트의 경계가 패키지 수준에서 공식화**된 것입니다.

### react-dom의 진입점 분화

```
react-dom/
├── client     ← createRoot, hydrateRoot
├── server     ← renderToPipeableStream (Node.js)
│              ← renderToReadableStream (Edge/Web Streams)
└── (root)     ← flushSync, 레거시 API
```

`react-dom/server`는 다시 두 갈래로 나뉩니다. Node.js의 스트림 API를 사용하는 `renderToPipeableStream`과 Web Streams API를 사용하는 `renderToReadableStream`. 이 분리는 서버 환경의 다양화를 반영합니다. Node.js뿐 아니라 Cloudflare Workers, Deno, Vercel Edge Runtime 같은 Edge 환경에서도 SSR이 가능해야 하기 때문입니다.

### React Server Components와 새로운 패키지들

```
┌──────────────────────────────────────────────┐
│           Server Components 패키지            │
│                                              │
│  react-server-dom-webpack    ← Webpack 번들러  │
│  react-server-dom-turbopack  ← Turbopack       │
│  react-server-dom-esm        ← ESM             │
│                                              │
│  역할: 서버 컴포넌트의 직렬화/역직렬화         │
│        클라이언트 참조(Client Reference) 해석  │
│        스트리밍 프로토콜                        │
└──────────────────────────────────────────────┘
```

React Server Components(RSC)는 번들러와의 통합이 필수적입니다. 서버에서 렌더링된 컴포넌트 트리를 클라이언트로 스트리밍할 때, "이 부분은 클라이언트 컴포넌트이다"라는 참조를 번들러의 모듈 시스템으로 해석해야 합니다. 그래서 `react-server-dom-webpack`, `react-server-dom-turbopack` 같은 번들러별 패키지가 존재합니다.

### `react-server` Export Condition

React 19에서 도입된 또 다른 중요한 변화는 `package.json`의 `exports` 필드에 `react-server` 조건이 추가된 것입니다.

```json
{
  "exports": {
    ".": {
      "react-server": "./react.react-server.js",
      "default": "./index.js"
    }
  }
}
```

`react-server` 조건으로 해석된 빌드에서는 `useState`, `useEffect`, `useReducer` 같은 클라이언트 전용 API가 **아예 존재하지 않습니다**. 서버 컴포넌트에서 이런 API를 사용하려고 하면 import 자체가 실패합니다.

이것은 런타임 에러가 아닌 **빌드 타임 에러**로 잘못된 사용을 잡아내는 전략입니다. 서버 컴포넌트에서 `useState`를 쓰면 "useState is not a function"이 아니라 "useState is not exported from 'react'"라는 더 명확한 에러를 받게 됩니다.

### 패키지 경계 위반의 에러 패턴

React 19의 확장된 패키지 구조에서 발생할 수 있는 주요 에러 패턴을 정리하면:

```
에러 상황                              원인                        해결
──────────────────────────────────────────────────────────────────────
"Invalid hook call"                  react 인스턴스 중복          peerDep 확인, 번들러 alias
"not wrapped in act(...)"            렌더러 혼용                  테스트 환경에서 올바른 렌더러 사용
"createContext only works in         Server/Client 경계 위반      'use client' 지시자 추가
 Client Components"
배치 처리 API 불일치                   react-dom 버전 불일치       react와 동일 버전 사용
```

---

## 변하는 것과 변하지 않는 것의 분리

지금까지 살펴본 React의 패키지 구조를 관통하는 하나의 원칙이 있습니다.

David Parnas가 1972년 논문 "On the Criteria To Be Used in Decomposing Systems into Modules"에서 제시한 **정보 은닉(Information Hiding)** 원칙입니다. 이 원칙의 핵심은 "변경될 가능성이 있는 설계 결정을 모듈 경계 뒤에 숨겨라"는 것입니다.

React의 패키지 경계를 이 관점에서 다시 보면:

- **react 패키지**: 변하지 않는 것 — 선언적 UI 모델, 컴포넌트 추상화, Hook의 의미론
- **react-reconciler**: 변하는 것 — 재조정 알고리즘의 세부 구현 (Stack → Fiber → 미래)
- **scheduler**: 변하는 것 — 스케줄링 전략 (requestIdleCallback → MessageChannel → 미래)
- **react-dom**: 변하는 것 — 브라우저 API, DOM 표준의 진화

React의 공개 API(`useState`, `useEffect`, JSX)는 놀라울 정도로 안정적입니다. 2019년에 도입된 Hook API는 2026년 현재까지 거의 변하지 않았습니다. 반면 내부 구현은 매년 상당한 변화를 겪고 있습니다. Lane 모델의 도입, Suspense의 진화, Server Components의 추가... 이 모든 내부 변화가 사용자의 코드를 깨뜨리지 않는 이유는, 변하는 것과 변하지 않는 것이 패키지 경계로 명확하게 분리되어 있기 때문입니다.

```
                    안정성의 벽
                        │
  사용자 코드 영역       │         React 내부 영역
                        │
  <App />               │    Fiber 노드 구조
  useState(0)           │    Lane 비트마스크
  useEffect(fn, [])     │    Reconciler 알고리즘
  <Suspense>            │    Scheduler 전략
                        │    HostConfig 구현
                        │    Feature Flags
                        │
   (거의 변하지 않음)     │    (지속적으로 진화)
```

이것은 우연이 아닙니다. 의도적인 설계의 결과이며, 패키지 구조가 이 설계를 물리적으로 강제합니다.

---

## 전체 의존성 구조: 최종 정리

지금까지 살펴본 내용을 하나의 다이어그램으로 종합합니다.

```
                          ┌──────────────┐
                          │    react     │
                          │  (Core API)  │
                          │              │
                          │ • JSX 런타임  │
                          │ • Hooks 선언  │
                          │ • Context    │
                          │ • Suspense   │
                          └──────┬───────┘
                                 │
                    SharedInternals (내부 계약)
                                 │
                          ┌──────▼───────┐
                          │   react-     │
                          │ reconciler   │
                          │              │
                          │ • Fiber 트리  │
                          │ • Diffing    │
                          │ • Hook 실행  │
                          │ • Effect 관리│
                          └──┬───┬───┬───┘
                             │   │   │
                   HostConfig│   │   │HostConfig
                             │   │   │
              ┌──────────────┘   │   └──────────────┐
              ▼                  ▼                   ▼
     ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
     │  react-dom   │   │react-native  │   │  커스텀 렌더러 │
     │              │   │  -renderer   │   │              │
     │  DOM 조작    │   │  Native View │   │  react-three │
     │  이벤트 위임  │   │  Bridge/     │   │  ink         │
     │  하이드레이션 │   │  Fabric      │   │  react-pdf   │
     └──────┬───────┘   └──────────────┘   └──────────────┘
            │
     ┌──────▼───────┐
     │  scheduler   │
     │              │
     │  우선순위 큐  │
     │  타임슬라이싱 │
     │  프레임 양보  │
     └──────────────┘

     ┌──────────────────────────────────────────────┐
     │              shared (공유 유틸리티)            │
     │                                              │
     │  ReactFeatureFlags, ReactSymbols,            │
     │  isValidElement, 타입 체크 유틸리티            │
     │                                              │
     │  ← 모든 패키지가 의존                          │
     └──────────────────────────────────────────────┘
```

이 구조에서 읽어낼 수 있는 설계 원칙들을 정리하면:

1. **What/How/When/Where 분리**: 각 패키지가 하나의 질문에만 답한다
2. **의존성 역전**: reconciler가 렌더러에 의존하지 않고, 둘 다 HostConfig 인터페이스에 의존한다
3. **공통 폐쇄 원칙**: 함께 변경되는 코드가 모노레포 안에서 원자적으로 관리된다
4. **정보 은닉**: 내부 구현의 변경이 공개 API에 전파되지 않도록 패키지 경계가 방화벽 역할을 한다
5. **점진적 배포**: Feature flag가 환경별로 다른 기능 세트를 활성화하고, 빌드 시스템이 불필요한 코드를 제거한다

이것들은 독립적인 결정이 아닙니다. 서로를 보강하는 일관된 아키텍처 전략의 표현입니다. 모노레포이기 때문에 원자적 변경이 가능하고, 원자적 변경이 가능하기 때문에 내부 계약을 자유롭게 진화시킬 수 있으며, 내부 계약이 자유롭게 진화하기 때문에 Feature flag를 통한 점진적 마이그레이션이 가능합니다.

---

## 다음 편 예고: Fiber, 중단 가능한 렌더링의 심장

이 글에서 우리는 React의 패키지 구조가 **왜** 이렇게 설계되었는지를 살펴보았습니다. 관심사 분리, 의존성 역전, 점진적 배포라는 세 축이 어떻게 하나의 일관된 아키텍처를 형성하는지 확인했습니다.

다음 편에서는 이 아키텍처의 심장부로 들어갑니다. **Fiber 아키텍처** — React가 동기적 재귀 호출(Stack Reconciler)에서 중단 가능한 작업 단위(Fiber)로 전환한 이유, Fiber 노드의 내부 구조, 그리고 이 구조가 Concurrent Features를 어떻게 가능하게 만드는지 깊이 파헤칩니다.

`beginWork`와 `completeWork`라는 두 함수가 어떻게 전체 UI 트리를 훑으면서도 언제든 멈출 수 있는지, 그 메커니즘의 구체적인 작동 방식을 코드 수준에서 추적할 것입니다.

---

> **React 아키텍처 심층 분석 시리즈**
> 1. **패키지 계층 구조** ← 현재 글
> 2. Fiber 아키텍처
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
*출처: React 소스 코드 분석, DeepWiki - facebook/react*
