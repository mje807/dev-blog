---
title: "React는 DOM 라이브러리가 아니다 — 다중 렌더러 아키텍처의 설계 철학"
date: "2025-02-20"
tags: [React, Renderer, Architecture, Reconciler, ReactNative]
series: "React 아키텍처 심층 분석"
---

React를 처음 배울 때 우리는 자연스럽게 이렇게 생각합니다. "React는 웹 UI를 만드는 라이브러리다." 실제로 React 공식 문서도 오랫동안 그렇게 소개했습니다. 하지만 React 소스 코드를 깊이 들여다보면, 이 인식이 얼마나 표면적인지 깨닫게 됩니다. React의 설계 목표는 처음부터 DOM이 아니었습니다. React가 지향한 것은 훨씬 더 야심찬 무언가였습니다.

---

## DOM은 목적지가 아니라 목적지 중 하나였다

초기 React 팀이 직면한 핵심 질문은 이것이었습니다. "선언적 프로그래밍 모델의 어디까지가 플랫폼에 독립적인가?"

컴포넌트가 state를 관리하고, props를 통해 데이터를 흘리고, 이전 결과와 새 결과를 비교하여 최소한의 변경만 적용하는 — 이 재조정(Reconciliation) 알고리즘은 DOM과 아무런 관계가 없습니다. `div`를 만들든, iOS의 `UIView`를 만들든, Canvas에 선을 긋든, 터미널에 텍스트를 출력하든 — 재조정 엔진은 그것이 무엇인지 알 필요가 없습니다.

React 팀은 이 통찰을 아키텍처로 구현했습니다. **Reconciler(재조정 엔진)**와 **Renderer(렌더러)**를 완전히 분리한 것입니다.

`react` 코어 패키지와 `react-reconciler` 패키지는 렌더 타겟에 대해 아무것도 모릅니다. 이들은 Fiber 트리를 구성하고, 변경 사항을 계산하고, 업데이트 우선순위를 결정할 뿐입니다. "계산된 변경을 실제 세계에 어떻게 반영할 것인가"는 전적으로 렌더러의 책임입니다.

자동차 엔진과 구동계의 관계를 떠올리면 이해하기 쉽습니다. 엔진은 회전력을 만들어내지만, 그 힘을 바퀴로 전달하는 방식은 구동계가 결정합니다. 앞바퀴굴림이든 뒷바퀴굴림이든 사륜구동이든, 엔진은 상관하지 않습니다. React의 Reconciler가 엔진이고, 각 플랫폼별 렌더러가 구동계입니다.

---

## Host Config: Reconciler와 렌더러 사이의 계약서

Reconciler가 렌더러에게 요구하는 인터페이스를 **Host Config**라고 부릅니다. 이것은 문자 그대로 계약서입니다. Reconciler는 "새 인스턴스를 만들어라", "이 자식을 추가해라", "이 속성을 업데이트해라"라고 명령하고, 렌더러는 자신의 플랫폼에 맞게 그 명령을 수행합니다.

Host Config가 담당하는 역할은 크게 다섯 가지로 나뉩니다. **인스턴스 생성**(createInstance, createTextInstance), **트리 조작**(appendChild, insertBefore, removeChild), **업데이트 처리**(prepareUpdate, commitUpdate), **Commit 라이프사이클**(prepareForCommit, resetAfterCommit), 그리고 **Visibility 제어**(hideInstance, unhideInstance)입니다.

눈여겨볼 점은 이 인터페이스가 의도적으로 최소화되어 있다는 것입니다. `prepareForCommit`이나 `resetAfterCommit` 같은 함수는 대부분의 렌더러에서 빈 구현으로 남습니다. DOM 렌더러만이 Commit 직전에 텍스트 선택 상태를 저장하고 이벤트를 비활성화하는 특수한 작업을 수행합니다. 이런 DOM 고유의 복잡성이 Host Config 레이어에 캡슐화되는 것입니다.

### Mutation 모드와 Persistence 모드: 세계를 변경하는 두 가지 방법

Reconciler는 호스트 환경의 특성에 따라 두 가지 업데이트 방식을 지원합니다.

**Mutation 모드**는 기존 인스턴스를 직접 수정하는 방식입니다. 브라우저 DOM이 대표적입니다. `element.style.color = 'blue'`처럼 이미 존재하는 노드의 속성을 바꿉니다. 쿠키 반죽을 다시 주무르는 것과 같습니다 — 같은 덩어리를 변형합니다.

**Persistence 모드**는 변경이 필요할 때마다 새로운 인스턴스를 만들어 교체합니다. 함수형 프로그래밍의 불변성 원칙과 닮아 있습니다. React Native의 최신 아키텍처인 Fabric이 C++ Shadow Tree에서 이 방식을 사용합니다. 레고 블록을 수정하는 대신 새 블록을 만들어 끼워 넣는 것과 같습니다.

대부분의 커뮤니티 렌더러는 Mutation 모드를 선택합니다. 구현이 더 직관적이고, React의 모든 기능이 이 모드에서 완전히 지원되기 때문입니다.

---

## react-dom: DOM 렌더러가 하는 일

react-dom의 Host Config 함수들이 구현된 소스 코드(`react-dom.development.js` 10862~11600행 구간)를 보면, 각 함수가 놀랍도록 얇은 레이어임을 알 수 있습니다. 대부분은 브라우저 DOM API에 대한 단순한 래퍼입니다.

그러나 단순한 래퍼가 아닌 부분들이 있습니다. 그리고 그 부분들이 DOM 렌더러의 복잡성을 만들어냅니다.

### createInstance: DOM 노드 그 이상

DOM 렌더러의 `createInstance`는 `document.createElement()`를 호출하는 것으로 끝나지 않습니다. 이 함수는 세 가지 추가 작업을 수행합니다.

첫째, 잘못된 HTML 구조를 경고합니다. `<p>` 안에 `<div>`를 넣는 것처럼 HTML 명세에 어긋나는 중첩을 개발 모드에서 감지합니다. 둘째, SVG 네임스페이스를 처리합니다. `<svg>` 내부의 요소들은 HTML 네임스페이스가 아닌 SVG 네임스페이스로 생성되어야 합니다. 셋째, 이벤트 시스템과 연결합니다. 생성된 DOM 노드에 `__reactFiber$` 프로퍼티로 Fiber 참조를, `__reactProps$` 프로퍼티로 현재 props를 저장합니다.

이 마지막 단계가 핵심입니다. 브라우저에서 클릭 이벤트가 발생했을 때, React의 이벤트 시스템은 DOM 노드에서 곧바로 해당 Fiber와 이벤트 핸들러를 찾아낼 수 있습니다. DOM 노드와 Fiber 노드 사이의 이 양방향 참조가 `createInstance` 안에서 만들어집니다. DOM 렌더러만의 고유한 요구사항이며, 다른 렌더러에는 없는 것입니다.

### 업데이트의 2단계 분리

모든 렌더러에서 반복되는 패턴이 있습니다. 업데이트를 **계산**하는 단계와 **적용**하는 단계가 엄격히 분리된다는 것입니다.

DOM 렌더러에서 `prepareUpdate`는 Render Phase(비동기, 중단 가능)에서 호출됩니다. 이 함수는 DOM을 건드리지 않습니다. 이전 props와 새 props를 비교하여 "무엇이 바뀌었는지"만 계산하여 반환합니다. `commitUpdate`는 Commit Phase(동기, 중단 불가)에서 호출되며, `prepareUpdate`가 계산한 결과를 받아 실제로 DOM을 수정합니다.

왜 이렇게 분리할까요? Concurrent Mode 때문입니다. Render Phase는 React가 더 중요한 업데이트를 처리하기 위해 언제든 중단하고 재시작할 수 있습니다. 이 과정에서 `prepareUpdate`가 여러 번 호출될 수 있습니다. 만약 `prepareUpdate`가 DOM을 직접 수정했다면, 재시작할 때마다 화면이 깜빡이거나 일관성이 깨질 것입니다. 계산과 적용을 분리함으로써, Reconciler는 Render Phase를 자유롭게 중단하고 재시작할 수 있고, 실제 DOM 변경은 항상 한 번만, 원자적으로 발생합니다.

### Commit 전후의 의식

```javascript
// react-dom.development.js, Line 10910
function prepareForCommit(containerInfo) {
  eventsEnabled = isEnabled();
  selectionInformation = getSelectionInformation();
  setEnabled(false);
  return null;
}

function resetAfterCommit(containerInfo) {
  restoreSelection(selectionInformation);
  setEnabled(eventsEnabled);
}
```

이 코드에서 핵심은 Commit 직전에 이벤트를 비활성화하고, 텍스트 선택 상태를 저장한다는 것입니다. DOM 트리가 변경되는 동안 이벤트가 발생하면, 렌더러가 아직 절반만 적용된 상태를 관찰할 수 있습니다. 이 함수들이 그 위험을 차단합니다. React Native에서는 이 두 함수가 아무 일도 하지 않습니다. 텍스트 선택이나 이벤트 비활성화 같은 개념 자체가 없기 때문입니다.

---

## React Native: Bridge에서 Fabric으로

React Native의 역사는 React 렌더러 아키텍처의 유연성을 가장 극적으로 보여주는 사례입니다.

### 레거시 아키텍처의 한계

초기 React Native는 JavaScript 스레드와 네이티브 스레드 사이에 **비동기 JSON 직렬화 Bridge**를 두었습니다. JavaScript에서 "이 뷰를 만들어라"라고 명령을 보내면, 그 명령이 JSON으로 직렬화되어 Bridge를 건너고, 네이티브 측에서 역직렬화하여 실제 뷰를 만들었습니다.

이 구조에서 Host Config의 `createInstance`는 실제 네이티브 뷰를 반환하지 않았습니다. 대신 정수 태그(tag)를 가진 경량 JavaScript 객체를 반환하고, 실제 뷰 생성을 Bridge를 통해 비동기적으로 요청했습니다. DOM 렌더러가 `document.createElement()`를 동기적으로 호출하여 즉시 DOM 노드를 얻는 것과 대조적입니다.

비동기성은 곧 문제였습니다. 스크롤이나 제스처처럼 매 프레임 반응해야 하는 인터랙션에서 Bridge의 직렬화 비용이 병목이 되었습니다. 60fps를 유지하려면 각 프레임에 16.7ms밖에 없는데, Bridge를 한 번 왕복하는 데도 적지 않은 시간이 소모되었습니다. 그리고 Bridge가 단일 큐이므로, 우선순위가 높은 업데이트도 낮은 우선순위의 업데이트 뒤에서 기다려야 했습니다.

### Fabric의 혁신

Fabric은 Bridge를 **JSI(JavaScript Interface)**로 대체하고, **C++ Shadow Tree**를 도입했습니다.

JSI는 V8이나 JavaScriptCore 같은 JavaScript 엔진에 직접 접근하여 JavaScript에서 C++ 함수를 동기적으로 호출할 수 있게 합니다. JSON 직렬화가 없습니다. 메모리를 공유합니다. Bridge의 비동기적 특성이 근본적으로 제거된 것입니다.

Fabric에서 `createInstance`는 C++ Shadow Node에 대한 JSI 참조를 동기적으로 반환합니다. JavaScript 객체가 아닌 C++ 메모리를 직접 가리키는 참조입니다. 이것이 Fabric이 성능을 크게 개선한 이유입니다 — 두 세계 사이의 데이터 변환 비용이 사라졌습니다.

Fabric의 또 다른 혁신은 Shadow Tree의 불변성입니다. 업데이트가 발생하면 기존 트리를 변경하는 대신 새로운 트리를 생성합니다. 변경되지 않은 서브트리는 이전 트리와 참조를 공유합니다. 이 구조적 공유 덕분에 여러 스레드가 동시에 트리를 안전하게 읽을 수 있고, 트랜잭션 실패 시 이전 상태로 즉시 복원할 수 있습니다. Reconciler와 네이티브 렌더러 사이의 동시성 문제가 해결됩니다.

레거시 아키텍처에서 Fabric으로의 전환에서 주목할 점은, Reconciler 코드는 거의 변경하지 않았다는 것입니다. Host Config 구현만 교체했습니다. React 팀이 아키텍처 분리에 투자한 이유가 여기서 입증됩니다.

---

## React Test Renderer와 Noop Renderer: 렌더링하지 않는 렌더러들

### Test Renderer: 테스트를 위한 JSON 거울

React Test Renderer는 DOM이나 네이티브 환경 없이 컴포넌트를 순수 JavaScript 객체 트리로 렌더링합니다. 브라우저 없이 Node.js 환경에서 컴포넌트의 출력을 검증할 수 있게 해줍니다.

```javascript
import TestRenderer from 'react-test-renderer';

const renderer = TestRenderer.create(<Button label="Submit" />);
console.log(renderer.toJSON());
// { type: 'button', props: { className: 'btn' }, children: ['Submit'] }
```

이 코드에서 핵심은 실제 DOM이 전혀 만들어지지 않는다는 것입니다. `createInstance`가 `document.createElement()` 대신 `{ type, props, children: [] }` 같은 단순 객체를 반환합니다.

Test Renderer의 Host Config는 모든 렌더러 중 가장 단순합니다. `prepareForCommit`과 `resetAfterCommit`은 아무 일도 하지 않습니다. `getRootHostContext`와 `getChildHostContext`는 빈 객체를 반환합니다. DOM 고유의 네임스페이스, 이벤트 시스템, 텍스트 선택 — 이 모든 것이 없습니다.

그럼에도 `useState`, `useEffect`, `useContext`, Suspense, ErrorBoundary가 모두 작동합니다. Reconciler가 제공하는 것들이기 때문입니다. Test Renderer는 Reconciler의 능력을 그대로 이용하면서, 출력 레이어만 JSON으로 교체한 것입니다.

`act()` 유틸리티가 Test Renderer 환경에서 특히 중요한 이유가 있습니다. 브라우저 환경에는 `requestAnimationFrame`이나 `MessageChannel` 같은 비동기 스케줄링 메커니즘이 있어서, React가 자연스럽게 업데이트를 다음 프레임에 처리합니다. Node.js 환경에는 그것이 없습니다. `act()`가 이 부재를 채우며, 콜백 내부에서 발생한 모든 상태 업데이트와 Effect가 완전히 처리될 때까지 기다렸다가 어서션을 실행할 수 있게 합니다.

### Noop Renderer: 엔진 자체를 테스트하기

Noop("No Operation") Renderer는 아무것도 렌더링하지 않습니다. React 코어 팀이 Reconciler 자체의 알고리즘을 테스트하고 벤치마킹하기 위해 내부적으로 사용하는 도구입니다.

Noop Renderer의 존재 이유는 **격리**입니다. DOM이나 네이티브 뷰의 복잡성 없이 Fiber 트리 구성, Lane 스케줄링, key 기반 재조정이 올바르게 동작하는지 검증할 수 있습니다. 시간을 수동으로 제어하고, 스케줄링을 정밀하게 조작하고, 내부 Fiber 트리 구조를 직접 검사하는 API를 갖추고 있습니다.

`prepareUpdate`가 항상 `true`를 반환한다는 점이 특징적입니다. "무조건 업데이트 필요하다"고 보고합니다. 실제 변경을 계산하는 것이 목적이 아니라, Reconciler가 업데이트를 받았을 때 올바르게 처리하는지 테스트하는 것이 목적이기 때문입니다.

---

## 커뮤니티 렌더러: React가 도달한 무한한 확장

`react-reconciler` 패키지를 직접 사용하면 누구나 커스텀 렌더러를 만들 수 있습니다. 이 가능성이 React 생태계를 예상치 못한 방향으로 확장시켰습니다.

### react-three-fiber: 3D 씬을 JSX로 선언하다

react-three-fiber(R3F)는 Three.js 위에 React 렌더러를 구축합니다. `createInstance`가 `document.createElement()` 대신 `new THREE.Mesh()`나 `new THREE.AmbientLight()`를 호출합니다.

```jsx
<Canvas>
  <ambientLight intensity={0.5} />
  <mesh position={[0, 0, 0]}>
    <boxGeometry args={[1, 1, 1]} />
    <meshStandardMaterial color="orange" />
  </mesh>
</Canvas>
```

이 JSX는 DOM을 거치지 않고 Three.js 씬 그래프로 직접 변환됩니다. `<ambientLight>`는 `THREE.AmbientLight` 인스턴스가 되고, `<mesh>`는 `THREE.Mesh`가 됩니다.

R3F가 해결해야 했던 흥미로운 문제가 있습니다. Three.js에서 Geometry와 Material은 `add()`로 씬에 추가하는 것이 아니라, `mesh.geometry = geometry`, `mesh.material = material`처럼 속성으로 할당합니다. R3F의 `appendChild`는 자식의 타입을 확인하여 적절한 방식으로 부모에 연결합니다. 이 타입 기반 라우팅이 R3F Host Config의 핵심 로직입니다.

이벤트 시스템도 직접 구현해야 했습니다. Three.js 객체는 DOM 이벤트를 받지 않습니다. R3F는 마우스 위치에서 3D 공간으로 광선(ray)을 쏘아 어떤 객체와 교차하는지 계산하는 Raycasting 방식으로 `onClick`, `onPointerOver` 같은 props를 지원합니다.

`useFrame` 훅은 R3F가 추가한 독자적인 기능입니다. Three.js는 WebGL이므로 매 프레임 씬을 다시 렌더링해야 합니다. R3F는 자체 `requestAnimationFrame` 루프를 운영하며, `useFrame`으로 등록된 콜백을 매 프레임 실행합니다. React의 렌더 사이클과 WebGL의 프레임 루프를 통합한 것입니다.

### ink: 터미널에서 React를

ink는 ANSI 이스케이프 코드로 터미널 UI를 구축하는 렌더러입니다. `createInstance`가 반환하는 것은 DOM 노드도, Three.js 객체도 아닌 — Yoga 레이아웃 엔진의 노드입니다.

Yoga는 React Native에서도 사용하는 C++ Flexbox 레이아웃 엔진입니다. ink는 CSS 없이 Yoga를 직접 구동하여 터미널 공간에서 Flexbox 레이아웃을 계산합니다. React로 터미널 UI를 만들면서도 `flexDirection`, `padding`, `margin` 같은 개념을 그대로 사용할 수 있는 이유입니다.

출력 방식도 독특합니다. 전체 화면을 매번 지우고 다시 그리는 대신, 변경된 영역만 업데이트합니다. Commit Phase의 `resetAfterCommit`에서 이전 출력과 새 출력을 비교하여 차이가 있는 줄만 다시 씁니다. 사용자 경험을 위한 최적화입니다 — 터미널이 깜빡이지 않습니다.

### react-pdf: 선언적 문서 생성

react-pdf는 React 컴포넌트로 PDF 문서를 생성합니다. 렌더러로서의 본질은 동일합니다 — Host Config의 `createInstance`가 PDF 라이브러리의 노드를 반환하고, 트리 조작 함수들이 그 노드들을 연결합니다.

흥미로운 점은 PDF가 정적 출력이라는 것입니다. 사용자 인터랙션이 없고, 실시간 업데이트도 없습니다. 이런 경우에도 React의 Reconciler를 사용하면, 컴포넌트 분리, props 전달, 조건부 렌더링 같은 React의 구성 능력을 PDF 생성에 그대로 활용할 수 있습니다. "문서를 코드로 표현한다"는 것이 의외로 강력합니다.

---

## 커스텀 렌더러가 공짜로 얻는 것들

커스텀 렌더러를 만들 때 놀라운 것은, Host Config를 구현하는 것만으로 React의 거의 모든 기능을 즉시 사용할 수 있다는 것입니다.

`useState`, `useEffect`, `useContext`, `useRef`, `useMemo`, `useCallback` — 모두 Reconciler가 제공합니다. `Suspense`로 비동기 데이터 로딩을 선언적으로 처리하고, `ErrorBoundary`로 에러를 포착하고, `useTransition`으로 비긴급 업데이트를 표시하는 것 — 전부 Reconciler의 능력입니다.

key 기반 재조정, 배치 업데이트, Lane 기반 우선순위 스케줄링 — 이 모든 것이 렌더러에 따라오는 것들입니다. 렌더러가 직접 구현해야 하는 것은 "새 인스턴스를 어떻게 만들 것인가", "트리를 어떻게 조작할 것인가", "속성 변경을 어떻게 적용할 것인가"뿐입니다.

이것이 React의 설계가 얼마나 야심찼는지를 보여주는 대목입니다. Reconciler는 선언적 프로그래밍의 엔진이고, Host Config는 그 엔진을 임의의 출력 타겟에 연결하는 인터페이스입니다. 렌더러를 만드는 사람은 "무엇을 출력할 것인가"에만 집중하면 됩니다. "어떻게 효율적으로 재조정할 것인가"는 이미 해결되어 있습니다.

---

## 아키텍처가 드러내는 설계 철학

React의 Reconciler-Renderer 분리가 단순한 공학적 선택이 아니라는 것을 여러 렌더러를 비교하면서 알 수 있습니다.

**점진적 복잡성**이라는 원칙이 Host Config 설계에 반영되어 있습니다. 기본 Mutation 모드만 구현해도 완전히 작동하는 렌더러를 만들 수 있습니다. Hydration(`supportsHydration`), Persistence(`supportsPersistence`) 같은 고급 기능은 필요한 렌더러만 선택적으로 구현합니다. Test Renderer나 Noop Renderer가 비어 있는 `prepareForCommit`과 `resetAfterCommit`으로도 완벽히 동작하는 이유입니다.

**부수효과의 격리**라는 원칙도 있습니다. `prepareUpdate`와 `commitUpdate`의 분리, `prepareForCommit`과 `resetAfterCommit`의 존재 — 이 모두가 "Render Phase에서는 관찰만, Commit Phase에서만 변경"이라는 규칙을 강제합니다. 이 규칙을 지키는 렌더러는 자동으로 Concurrent Mode와 호환됩니다. Reconciler가 언제 중단하고 재시작해도 안전합니다.

React Native의 진화가 이 설계 철학의 실용적 가치를 증명합니다. Bridge에서 Fabric으로의 전환은 네이티브 렌더링 아키텍처의 근본적 변화였습니다. 하지만 Reconciler는 그대로였습니다. Host Config만 교체했습니다. 수백만 명이 사용하는 프레임워크의 렌더링 레이어를 교체하면서도 애플리케이션 코드의 변경을 최소화할 수 있었던 것은, 처음부터 경계가 명확히 그어져 있었기 때문입니다.

---

## 정리: React가 확장한 선언성의 영역

React는 처음부터 DOM 라이브러리가 아니었습니다. React가 추구한 것은 **어떤 출력 타겟에든 적용할 수 있는 선언적 프로그래밍 모델**이었습니다.

DOM, iOS, Android, WebGL 씬, Canvas, 터미널, PDF 파일, Figma 도큐먼트 — 이 모든 것이 Host Config라는 동일한 계약서를 통해 React의 재조정 엔진과 연결됩니다. 출력 타겟이 무엇이든 상관없이, 컴포넌트 기반의 구성, 선언적 상태 관리, 효율적인 재조정이 작동합니다.

react-dom.development.js의 `createInstance`가 `document.createElement()`를 호출하는 대신 `new THREE.Mesh()`를 호출하면 3D 렌더러가 됩니다. `new Konva.Rect()`를 호출하면 Canvas 렌더러가 됩니다. `{ type, props, children: [] }`를 반환하면 테스트 렌더러가 됩니다. Reconciler는 그것이 무엇인지 알지 못하고, 알 필요도 없습니다.

이것이 React가 단순한 UI 라이브러리를 넘어 범용 선언적 런타임으로 자리잡은 이유입니다. 그리고 앞으로도 우리가 상상하지 못한 새로운 타겟에서 React가 등장할 것이라는 예측이 가능한 이유이기도 합니다.

---

> **시리즈 네비게이션**
> - 이전 글: React 아키텍처 심층 분석 12편 — Concurrent Mode와 Lane 스케줄링
> - 다음 글: React 아키텍처 심층 분석 14편 — Hydration의 작동 원리