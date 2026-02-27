# CODEX_WORKFLOW.md

Git 레포 코드작업 시 Codex 병행 표준 템플릿.

## 1) 실행 원칙
- 기본: git repo 코드작업은 Codex 병행
- 오케스트레이션(요구사항 정리/검증/품질게이트/커밋 검수)은 어시스턴트가 담당
- 단순 1~2줄 수정은 직접 처리 가능

## 2) Codex 프롬프트 템플릿
아래 블록을 그대로 복붙해서 작업 시작:

```text
[Goal]
- <이번 작업 목표 1~2줄>

[Scope]
- Repo: <경로>
- In-scope files: <파일/폴더>
- Out-of-scope: <건드리면 안 되는 영역>

[Skills / Agents]
- Use skills: <필요 스킬 목록>
- Roles:
  - implementer: 코드 구현
  - reviewer: 리스크/회귀 검토
  - qa: 빌드/테스트/게이트 확인

[Constraints]
- 기술 제약: <예: exactOptionalPropertyTypes=true>
- 스타일 제약: <코딩 컨벤션>
- 금지사항: <임의 리팩터, 광범위 포맷 변경 등>

[Deliverables]
1) 코드 변경
2) 변경 요약 (왜/무엇/영향)
3) 검증 로그 (build/test/lint)
4) 후속 TODO (있으면)

[Quality Gates]
- must pass: <build/test/lint>
- must explain: breaking risk / fallback / rollback

[Git]
- Commit message format: <예: feat(scope): ...>
- Split commits by concern when needed
```

## 3) 작업 후 체크리스트
- [ ] 빌드/테스트 통과
- [ ] 에러/경고 해석 포함
- [ ] 리스크 및 롤백 포인트 정리
- [ ] 커밋 메시지 규칙 준수
- [ ] 원격 푸시/배포 상태 확인

## 4) 권장 운영 패턴
1. 요구사항 확정
2. Codex 실행(구현)
3. 어시스턴트 검증(품질게이트)
4. 보완 루프
5. 커밋/푸시/리포트
