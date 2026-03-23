# SERIES_TEMPLATE

시리즈 글은 `series` 값을 동일하게 맞추는 것이 핵심입니다.

예시 시리즈명:
- `React Architecture Deep Dive`
- `Module Federation Operations`
- `AI Skill Design Patterns`

## 시리즈 1편 템플릿

```md
---
title: React Architecture Deep Dive 01 - React 패키지 구조 이해
date: 2026-03-23
tags:
  - react
  - architecture
  - deep-dive
excerpt: React 아키텍처를 이해하기 전에 먼저 패키지 구조와 각 패키지의 역할을 정리합니다.
draft: true
featured: true
series: React Architecture Deep Dive
---

# React Architecture Deep Dive 01 - React 패키지 구조 이해

이 시리즈가 무엇을 다루는지, 이번 편이 전체 흐름에서 어디에 위치하는지 먼저 설명합니다.

## 이 시리즈에서 다룰 것

- 패키지 구조
- Fiber
- Hooks 시스템
- 렌더링 사이클
- SSR / Hydration

## 이번 편 핵심

이번 글만의 핵심 내용을 설명합니다.
```

## 시리즈 n편 템플릿

```md
---
title: React Architecture Deep Dive 02 - Fiber 아키텍처 이해
date: 2026-03-24
tags:
  - react
  - fiber
  - architecture
excerpt: React Fiber가 어떤 문제를 해결하는지와 렌더링 스케줄링의 토대를 정리합니다.
draft: true
featured: false
series: React Architecture Deep Dive
---

# React Architecture Deep Dive 02 - Fiber 아키텍처 이해

이전 편과의 연결, 이번 편의 목표, 다음 편으로 이어질 흐름을 적습니다.
```

## 운영 팁
- 시리즈명은 띄어쓰기/대소문자까지 가능하면 고정합니다.
- 제목에는 `01`, `02` 같은 순서를 명시하는 편이 좋습니다.
- 1편만 `featured: true`로 두고, 나머지는 일반 공개 글로 운용해도 좋습니다.
- 시리즈 첫 문단에 "이전 글 / 다음 글" 감각이 드러나게 쓰면 상세 페이지 연결 UX와 잘 맞습니다.
