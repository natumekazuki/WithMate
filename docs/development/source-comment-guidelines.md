# ソースコメント規約

## 目的

コメントは、コードから安全に導けない理由、制約、失敗条件を将来の変更者へ伝えるために使う。処理内容の読み替え、変更履歴、設計書の複製には使わない。

この規約は新実装のTypeScript、JavaScript、MJSを主対象とする。Python、SQL、shellなどでも、言語固有の慣習と矛盾しない範囲で同じ原則を適用する。`old/`、生成物、third-party codeには遡及適用しない。

## 基本原則

1. コードで表現できることは、コメントではなく命名、型、関数分割、定数、testで表現する。
2. コメントは「何をしているか」より「なぜ必要か」「何を壊してはいけないか」を説明する。
3. コメントと実装が食い違う場合、コメントもbugとして扱う。実装変更と同じcommitで更新または削除する。
4. 離れた設計書が正本である場合、コメントには要点とrepo相対pathだけを残し、設計全文を複製しない。
5. コメントが長くなる場合、局所的な説明不足ではなく責務過多や設計文書不足を先に疑う。

## 言語

- 説明文は日本語で書く。
- identifier、API名、protocol field、SQL keyword、error codeなどはコード上の表記を維持する。
- third-party toolが要求するdirective、license、generated header、upstream由来の説明は原文を維持してよい。
- 日本語と英語の同内容を併記しない。

## コメントを残す場面

次の情報がコードとtestだけでは伝わりにくい場合に残す。

- 一見不要に見える処理が必要な理由
- transaction、ownership、ordering、concurrency、crash recoveryの不変条件
- security、privacy、data lossを防ぐための制約
- timeout、size、count、timeなどの単位、上限、選定理由
- 外部API、OS、SQLite、Electronなどの既知の挙動に対する回避策
- 意図的に採用しなかった自然な代替案と、その理由
- 例外を握り潰す、再試行しない、処理を継続するなど、通常と異なるerror handlingの理由

```ts
// Worker終了後のlate responseで完了済みrequestを復活させない。
inFlight.delete(requestId);
```

```ts
// payloadとmetadataは別commitにするとstored itemだけが観測されるため、同じtransactionで確定する。
commitStoredOutput(command);
```

## コメントを残さない場面

次のコメントは追加しない。変更対象または直接触れた箇所で見つけた場合は、意図を失わないことを確認して削除する。依頼範囲外の既存コメントは同じ変更へ混ぜず、必要なら別taskとして扱う。

- 次の行を日本語へ言い換えただけの説明
- 関数名、型、変数名から明らかな処理説明
- brace、loop、branch、getter / setterの区切り
- commented-out code
- author名、変更日、変更履歴、commit内容
- 実在しない将来要件や根拠のない推測
- issueや設計書の長文転記
- secret、token、local absolute path、個人情報、raw provider response

```ts
// request IDを削除する。
inFlight.delete(requestId);
```

上の例はコードの読み替えにすぎないため不要である。

## 記法

### 通常コメント

- 局所的な理由や制約には`//`を使い、対象コードの直前に置く。
- 原則として独立した文で書く。複数段落が必要なら設計文書または関数分割を検討する。
- 行末コメントは、単位や短い対応関係など、同じ行にある方が誤読しにくい場合だけ使う。
- section bannerや装飾目的の罫線コメントは使わない。

```ts
const busyTimeoutMs = 5_000; // milliseconds
```

単位が型や変数名で十分明確なら、上の行末コメントも不要である。

### JSDoc

`/** ... */`はexportされたAPIまたは型のうち、型定義だけでは利用契約を表現できないものに使う。次の情報を優先する。

- side effectとownership
- 呼出順序とlifecycle
- concurrencyとtransaction境界
- 値の単位、上限、cursor semantics
- 失敗条件、retryability、投げるerror
- security / privacy上の注意

関数名、parameter名、return typeを文章で繰り返さない。`@param`、`@returns`、`@throws`は追加情報がある場合だけ使う。内部関数へ一律にJSDocを付けない。

```ts
/**
 * 新規requestの受付を停止し、受付済みwriteの完了後にconnectionを閉じる。
 * timeout後は未完了requestを失敗へ収束させる。
 */
export function closePersistenceWorker(): Promise<void>;
```

### TypeScript / JavaScript以外

他言語では基本原則、言語、禁止事項、追跡要件を準用し、JSDoc固有の構文は持ち込まない。

| 対象 | 通常コメント | public contract | 主に残す情報 |
| --- | --- | --- | --- |
| TypeScript / JavaScript / MJS | `//` | `/** ... */` | ownership、lifecycle、error、単位、外部制約 |
| Python | `#` | docstring | side effect、例外、resource ownership、呼出契約 |
| SQL | `--` | 対象外 | schema invariant、trigger理由、migration / compatibility制約 |
| shell / PowerShell | `#` | 対象外 | quoting、platform差、破壊防止条件、終了codeの扱い |

Python docstringもsignatureや型annotationを繰り返さない。SQLやshellで複数行説明が必要な場合も、装飾的なblock commentではなく、対象statementまたはcommandの直前へ短く置く。tool directiveやshellcheck抑制はtool指定の構文を使い、抑制理由を併記する。

## TODO、FIXME、HACK

未完了事項をコメントだけで管理しない。merge対象へ残す場合は、追跡先と解消条件を必須とする。

```ts
// TODO(#321): packaged Workerの起動確認後にdevelopment用path fallbackを削除する。
// FIXME(#322): shutdown中のrequestがtimeoutまで残るため、closing遷移時に即時失敗へ収束させる。
// HACK(docs/plans/20260712-withmate-rebuild-roadmap/plan.md:CP8): Electron 42のasar解決制約を避ける暫定経路。resource staging確定後に削除する。
```

- `TODO`: 未実装だが、現在の正しさを損なわない作業
- `FIXME`: 既知の誤動作、仕様逸脱、または回帰リスク
- `HACK`: 意図的な暫定回避策
- 括弧内にはGitHub Issue番号、または`repo相対plan path:checkpoint / slice ID`を記載する。checkpoint名だけを記載しない。
- 本文には「何をするか」だけでなく、完了条件または削除条件を書く。
- `TODO later`、`temporary`、`fix someday`のような追跡不能なコメントは禁止する。
- release blockerやdata loss riskはコメントだけにせず、issue、test、planのいずれかでも追跡する。

## test内のコメント

- test名とfixture builderでscenarioが表現できる場合、コメントは不要とする。
- コメントは、意図的に壊れたfixture、時系列、race window、failure injectionの位置を説明する場合に使う。
- assertionの期待値を読み替えるコメントは書かない。

```ts
// commit直前にWorkerを停止し、未commit rowが残らないことを検証する。
faults.crashAt("before-commit");
```

## 設計文書への参照

コメントから設計文書を参照する場合、repo root相対pathと、参照が必要な理由を短く記載する。行番号は変動するため固定しない。

```ts
// repair時もambiguous dispatchを再送しない。契約はdocs/design/provider-integration.mdを参照。
```

URLは外部仕様が根拠であり、将来の変更者が同じ資料を確認する必要がある場合だけ残す。issue discussionや一時的な検索結果を恒久コメントの根拠にしない。

外部runtimeやlibraryのworkaroundには、影響するversionまたは発生条件と、再検証・削除条件を含める。一次資料が判断の再現に必要な場合は、そのURLも残す。

security / privacyコメントは「安全のため」のような抽象表現で済ませず、信頼できない入力、越えてはいけない信頼境界、禁止する保存・変換・log出力のいずれかを具体化する。実際のcredential、payload、個人情報を例として埋め込まない。

## review checklist

- コメントが処理内容ではなく、理由または制約を説明しているか。
- 命名、型、関数分割、testへ移した方が正確ではないか。
- 実装変更後も内容が正しいか。
- public JSDocが型定義を繰り返していないか。
- TODO / FIXME / HACKに追跡先と解消条件があるか。
- 設計書や外部仕様の複製ではなく、必要なpointerだけになっているか。
- 外部workaroundに影響条件と再検証・削除条件があるか。
- security / privacyコメントが信頼境界または禁止操作を具体化しているか。
- secret、個人情報、絶対path、raw responseを含んでいないか。
