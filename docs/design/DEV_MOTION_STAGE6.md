# DEV Blog Motion Stage D6

## 적용 범위
- `app/design/motion-tokens.ts`: 모션 프리셋 토큰 정의(quick/normal/emphasized)
- `app/design/useReducedMotion.ts`: `prefers-reduced-motion` 감지 훅
- `app/design/useMotionPreset.ts`: reduced-motion 우선 적용 + preset style 반환
- `components/PostCard.tsx`: 카드 hover/색상 전환에 모션 프리셋 적용
- `components/BlogPostBrowser.tsx`: 뷰모드 토글/카드/리스트 링크 전환 모션 적용
- `components/SiteHeader.tsx`: 헤더 브랜드/내비 링크 전환 모션 적용
- `app/globals.css`: `@media (prefers-reduced-motion: reduce)` 전역 안전장치 추가

## 정책
- 접근성 우선: reduced-motion 환경에서는 애니메이션/트랜지션 최소화
- 기본 프리셋: quick(짧은 상호작용), normal(카드/콘텐츠 전환)
- 과도한 모션 배제: transform/opacity는 필요한 위치에만 적용
