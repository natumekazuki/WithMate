# 008 Character Icon Notification-Compatible Formats

- 状態: Accepted
- 日付: 2026-07-30

## Context

Character icon は renderer の avatar 表示に加え、Windows の Session turn notification にも使用する。renderer が表示できる画像形式と Electron の `nativeImage` が全 platform で扱う画像形式は一致しない。Electron は全 platform 共通の対応形式を PNG と JPEG としているため、GIF、WebP、BMP、SVG を登録すると、UI では表示できても通知では Character icon が省略される。

新規登録だけを制限する、既存画像を自動変換する、通知時に変換する、すべての形式を継続して許可する選択肢がある。既存 Character と過去 Session は icon path を保持しているため、既存ファイルの変換や削除は過去の表示を壊す可能性がある。

## Decision

- Character の新規作成と icon 差し替えでは、local filesystem 上の PNG、JPG、JPEG だけを受け付ける。
- Character Editor の画像選択は Character icon 用の filter を要求する。Mate avatar と Session attachment が使用する一般画像 filter は変更しない。
- format 制約の canonical owner は Main Process の Character storage とする。renderer の picker や手入力、IPC 呼び出しから同じ保存処理へ到達しても制約を迂回できない。
- 既存の非対応 icon は変換、削除、metadata の消去を行わない。
- 既存の非対応 icon と同じ参照を維持した metadata 更新は許可する。Windows filesystem path は drive path と UNC path を対象に、directory separator と大文字小文字の表記差を除いて比較する。scheme path と POSIX path は文字列が一致する場合だけ同じ参照として扱う。別の非対応 icon への差し替えは拒否する。
- Character authoring session の icon は保存済み Character から解決する。未保存の Editor draft や IPC input に icon path を持たせない。
- icon の欠損、破損、既存の非対応形式では、`docs/adr/006-windows-session-turn-notifications.md` のとおり通知本体を優先し、Character icon を省略して Windows が選ぶアプリアイコンへフォールバックする。

## Alternatives

### 既存 icon を PNG へ一括変換する

GIF の animation や SVG の表現が変わり、既存 Session が保持する旧 path との整合も必要になる。今回の目的に対して migration と cleanup の負担が大きいため採用しない。

### 通知時だけ PNG へ変換して cache する

Character storage と別に変換、cache、cleanup、失敗処理の owner が必要になる。通知は補助的な外部副作用であり、登録時に対応形式へ限定する方が境界を小さく保てるため採用しない。

### 既存の対応形式をすべて継続する

新しく登録した icon でも通知に Character icon が出ない状態が残るため採用しない。

### 既存の非対応 icon を解除する

ユーザーが登録済みの表示を失い、過去 Session の参照も壊すため採用しない。

## Consequences

### Positive

- 新しく登録または差し替えた Character icon は Electron の通知画像として利用可能な形式になる。
- 既存 Character と過去 Session の icon file/path を破壊しない。
- Character storage の保存境界で形式を強制し、picker 以外の入口からの迂回を防げる。
- Mate avatar と Session attachment の画像選択には影響しない。

### Negative

- 既存の非対応 icon は、差し替えるまで通知では Character icon が表示されない。
- 非対応 icon を持つ既存 Character には、対応形式と非対応形式が併存する。
- 拡張子が PNG/JPG/JPEG でも、欠損または破損した画像は通知で使用できない場合がある。

形式判定の正本は `src/character/character-icon.ts`、保存境界の強制は `src-electron/character-storage.ts` に置く。picker / IPC の正本は `src-electron/window-dialog-service.ts`、`src-electron/main-ipc-registration.ts`、`src-electron/preload-api.ts`、renderer の入口は `src/CharacterEditorApp.tsx` に置く。Character authoring session の icon projection は `src-electron/character-authoring-service.ts` が保存済み Character から作る。観測可能な契約は `scripts/tests/character-storage.test.ts`、`scripts/tests/character-authoring-service.test.ts`、`scripts/tests/window-dialog-service.test.ts`、`scripts/tests/main-ipc-registration.test.ts`、`scripts/tests/preload-api.test.ts`、`scripts/tests/character-editor-state.test.ts`、`scripts/tests/character-editor-app.test.tsx` に置く。

外部制約:

- [Electron `nativeImage` Supported Formats](https://www.electronjs.org/docs/latest/api/native-image#supported-formats)
