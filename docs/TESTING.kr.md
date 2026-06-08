# 테스트 가이드

## 개요

이 프로젝트는 [Vitest](https://vitest.dev/) v2를 테스트 러너로 사용합니다. 모든 테스트 파일은 소스 파일 옆에 위치합니다 (`*.test.ts`).

## 테스트 실행

```bash
npm test              # 전체 테스트 1회 실행
npm run test:watch    # watch 모드 (파일 변경 시 자동 재실행)
npx tsc --noEmit      # 타입 체크만 수행 (빌드 출력 없음)
```

## 테스트 구조

| 테스트 파일 | 개수 | 대상 모듈 | 전략 |
|---|---|---|---|
| `src/claude/output-formatter.test.ts` | 29 | 메시지 분할, 코드 블록 펜스, Discord embed/버튼 생성 | 모킹 없음 — 순수 로직 + discord.js 생성자 네이티브 동작 |
| `src/security/guard.test.ts` | 16 | 유저 화이트리스트, 슬라이딩 윈도우 레이트 리밋, 경로 순회 차단, BASE_PROJECT_DIR 범위 검증 | `getConfig()` 모킹, `vi.spyOn(fs)`, `vi.useFakeTimers()` |
| `src/utils/config.test.ts` | 8 | Zod 환경변수 검증, 싱글톤 캐싱, 에러 시 `process.exit` | `vi.resetModules()` + 동적 `import()` |
| `src/db/database.test.ts` | 12 | Project/Session CRUD 연산 | `better-sqlite3` 생성자 모킹으로 인메모리 SQLite 사용 |
| `src/bot/commands/sessions.test.ts` | 12 | JSONL 세션 파싱, `findSessionDir`, 비정상 JSON 처리 | 실제 임시 파일 (`fs.mkdtempSync`) + `os.homedir()` 모킹 |
| **합계** | **77** | | |

## 각 테스트 커버리지

### output-formatter (29개)

- **formatStreamChunk**: 1900자 절삭, 빈 문자열 처리
- **splitMessage**: 줄바꿈 기준 분할, 긴 줄 강제 분할, 코드 블록 펜스 보존 (언어 지정 유/무), 여러 코드 블록 처리
- **createToolApprovalEmbed**: 도구 타입별 필드 생성 (Edit, Bash, Write, 일반), 버튼 customId 형식, 콘텐츠 절삭
- **createResultEmbed**: 비용 표시 토글, 소요시간 포맷, 설명 절삭
- **createAskUserQuestionEmbed**: 단일 선택 (버튼), 다중 선택 (StringSelectMenu), 질문 인덱스, 행 분리 (행당 버튼 5개)
- **createStopButton / createCompletedButton**: customId 형식, 비활성 상태

### guard (16개)

- **isAllowedUser**: 화이트리스트 매칭, 대소문자 구분, 빈 문자열 거부
- **checkRateLimit**: 제한 내 요청, 초과 차단, 60초 윈도우 리셋, 유저별 독립 추적
- **validateProjectPath**: 경로 순회(`..`) 차단 (fs 호출 전 검사), BASE_PROJECT_DIR 범위 강제, 미존재 경로, 비디렉토리 경로, 유효 디렉토리

### config (8개)

- `process.env`에서 유효한 Config 파싱
- `ALLOWED_USER_IDS` 콤마+공백 분리
- `RATE_LIMIT_PER_MINUTE` 정수 변환, `SHOW_COST` boolean 변환
- 필수 변수 누락 시 `process.exit(1)` 호출
- 싱글톤 캐싱 (반복 호출 시 같은 참조 반환)

### database (12개)

- Project CRUD: 등록, 조회, 전체 조회 (guild 필터), 해제 (세션 연쇄 삭제), auto-approve 토글
- Session CRUD: upsert, 조회 (채널별 최신), 상태 업데이트, 전체 조회 (projects JOIN)

### sessions (12개)

- **findSessionDir**: `~/.claude/projects` 미존재, 단순 경로 인코딩 매칭, 매칭 실패 시 null
- **getLastAssistantMessage**: 배열/문자열 content, 여러 줄 (마지막 줄 반환), assistant 메시지 없음, 잘못된 JSON 무시, 공백만 있는 텍스트 건너뛰기, 여러 텍스트 블록 결합
- **getLastAssistantMessageFull**: 전체 텍스트 반환, 빈 파일 처리

## 새 테스트 추가하기

1. 소스 파일 옆에 `<모듈명>.test.ts` 생성
2. 소스 import 시 `.js` 확장자 사용 (ESM 컨벤션)
3. 외부 의존성은 `vi.mock()`으로 모킹 — 테스트 대상 모듈 자체는 모킹하지 않기
4. `npm test`로 확인

## OAuth 토큰 자동 갱신 (macOS 전용)

봇이 만료 직전에 Claude Code OAuth access token을 자동으로 갱신하여,
정상 운영 중에는 사용자가 `claude login`을 다시 실행할 필요가 없는지
확인합니다.

**전제 조건:** macOS, 최소 한 번은 `claude login`으로 로그인된 상태,
봇은 중지된 상태.

> 도중에 문제가 생기면 `claude login`을 실행해 Keychain 항목을 새 자격 증명으로 덮어쓸 수 있습니다.

1. 현재 Keychain 항목의 `expiresAt`을 확인합니다:
   ```bash
   security find-generic-password -s "Claude Code-credentials" -w \
     | python3 -c 'import sys,json; d=json.load(sys.stdin)["claudeAiOauth"]; print("expiresAt:", d["expiresAt"], "now:", __import__("time").time()*1000)'
   ```

2. 토큰이 1분 뒤 "만료"되는 것처럼 타임스탬프만 위변조합니다 (실제
   access token은 그대로 유효):
   ```bash
   CURRENT=$(security find-generic-password -s "Claude Code-credentials" -w)
   NEW_EXPIRES=$(python3 -c 'import time; print(int(time.time()*1000) + 60000)')
   PAYLOAD=$(python3 -c "import json,sys; d=json.loads('''$CURRENT'''); d['claudeAiOauth']['expiresAt']=$NEW_EXPIRES; print(json.dumps(d))")
   security add-generic-password -s "Claude Code-credentials" -a "$USER" -w "$PAYLOAD" -U
   ```

3. `npm run dev`로 봇을 실행합니다. 몇 초 안에 로그에 다음 줄이 나와야
   합니다:
   ```
   [credentials-refresher] Refreshed access token (valid ~8h).
   ```

4. Keychain 항목을 다시 확인합니다. `expiresAt`이 약 8시간 뒤로 갱신되어
   있고, `accessToken` 값이 1단계와 달라야 합니다.

**비활성화 테스트:**

봇을 중지하고 `.env`에 `CLAUDE_AUTO_REFRESH=false`를 추가한 뒤 재시작합니다.
2단계와 같이 `expiresAt`을 위변조해도 갱신 로그가 나오지 않으며, Discord
메시지를 보내면 봇의 기존 인증 오류 감지 로직이 "claude login 다시 실행해
주세요" 안내를 띄워야 합니다.

## 자격 증명 하트비트 (macOS 전용)

봇은 백그라운드에서 Claude Code OAuth 토큰을 주기적으로 갱신하여,
유휴 시간이 길어져도 사용자가 다시 로그인하지 않아도 되게 합니다.
하트비트를 end-to-end로 확인하려면 다음 절차를 따릅니다.

아래 명령은 모두 macOS에서 테스트되었습니다. BSD `date`는 `%3N`을 지원하지 않으므로 밀리초 타임스탬프에는 `node -e 'console.log(Date.now())'`를 사용합니다. Keychain 쓰기는 수정된 JSON을 먼저 셸 변수에 담습니다. `security add-generic-password -w`는 비밀번호를 stdin이 아니라 인자로 받기 때문입니다.

### 정상 상태 갱신

1. 유효한 Keychain 항목이 있는지 확인하고 만료 시각을 봅니다:
   ```bash
   security find-generic-password -s "Claude Code-credentials" -w \
     | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d).claudeAiOauth; console.log('expires in', ((o.expiresAt - Date.now()) / 3_600_000).toFixed(2), 'h')})"
   ```
2. `.env`에 빠른 tick override를 설정합니다:
   ```
   CLAUDE_REFRESH_INTERVAL_MIN=2
   CLAUDE_REFRESH_THRESHOLD_MIN=1
   ```
3. `expiresAt`을 지금부터 90초 뒤로 위변조합니다:
   ```bash
   NEAR_FUTURE_MS=$(node -e 'console.log(Date.now() + 90_000)')
   NEW_PAYLOAD=$(
     security find-generic-password -s "Claude Code-credentials" -w \
       | jq -c --argjson e "$NEAR_FUTURE_MS" '.claudeAiOauth.expiresAt = $e'
   )
   security add-generic-password -s "Claude Code-credentials" \
     -a "$(whoami)" -w "$NEW_PAYLOAD" -U
   ```
4. `npm run dev`를 실행합니다. 약 2분 안에 봇 로그에 다음 줄이 보여야 합니다:
   ```
   [credentials-refresher] Refreshed access token (valid ~8h).
   ```
5. 1단계의 같은 `node -e` one-liner로 Keychain에 새 만료 시각(약 8시간 뒤)이
   들어갔는지 확인합니다.

### 취소 알림

1. `refreshToken`을 알려진 잘못된 값으로 위변조하고, 하트비트가 다음 tick에서
   갱신을 시도하도록 `expiresAt`도 가까운 미래로 밀어 둡니다:
   ```bash
   NEAR_FUTURE_MS=$(node -e 'console.log(Date.now() + 90_000)')
   NEW_PAYLOAD=$(
     security find-generic-password -s "Claude Code-credentials" -w \
       | jq -c --argjson e "$NEAR_FUTURE_MS" '
           .claudeAiOauth.expiresAt = $e
           | .claudeAiOauth.refreshToken = "sk-ant-ort01-INVALID"
         '
   )
   security add-generic-password -s "Claude Code-credentials" \
     -a "$(whoami)" -w "$NEW_PAYLOAD" -U
   ```
2. `npm run dev`를 실행합니다. `CLAUDE_REFRESH_INTERVAL_MIN`분 안에
   봇 소유자(`ALLOWED_USER_IDS`의 첫 번째 항목)가 bilingual EN+KR 재로그인
   안내가 포함된 Discord DM을 받아야 합니다. 봇 로그에는 다음이 보여야 합니다:
   ```
   [credentials-refresher] Refresh rejected (401); refresh token likely revoked or expired. ...
   [heartbeat] Sent revoke notification DM to first allowed user.
   ```
3. 한 tick 더 기다립니다. 두 번째 DM은 오면 안 됩니다. 봇 로그에는 refresher의
   401 로그가 계속 보일 수 있지만, 하트비트는 이제 조용해야 합니다.
4. 호스트에서 `claude login`을 실행해 유효한 자격 증명을 복구합니다. 재인증 후
   다음 하트비트 tick(또는 다음 사용자 메시지, 둘 중 먼저 오는 시점)에
   `notifiedRevoked`가 리셋되고 DM 기능이 복구됩니다.

### 정리

봇을 정상 운영으로 돌리기 전에 `.env`를 기본값으로 복구합니다
(테스트 override 제거).
