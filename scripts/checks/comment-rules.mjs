import { parsers } from "prettier/plugins/typescript";

const generated = new Set([
  "resources/cli/withmate-session.mjs",
  "resources/skills/withmate-glossary/bin/withmate-glossary.mjs",
]);
const functionTypes = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "TSEmptyBodyFunctionExpression"]);
const declarationTypes = new Set([
  "ClassDeclaration", "FunctionDeclaration", "TSDeclareFunction",
  "TSTypeAliasDeclaration", "TSInterfaceDeclaration", "TSEnumDeclaration",
  "MethodDefinition", "TSMethodSignature",
]);
const loopTypes = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const paragraphLimit = 12;
const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const metadata = /^(?:@|(?:TODO|FIXME|HACK|XXX)\b|(?:eslint|prettier|biome|oxlint|istanbul|c8|v8|SPDX|copyright)\b|[\w-]+\s*=)/i;

/** 追跡中の JS/TS 系ソースから、再生成する同梱 CLI だけを除く。 */
export function isCommentSource(path) {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path) && !generated.has(path);
}

/** AST の子だけを列挙し、位置情報やコメントを別の処理として数えない。 */
function* children(node) {
  // 構文ノードが配列で保持する子も走査する。
  for (const [key, value] of Object.entries(node)) {
    // コメントは所属位置を別に判定するため、構文の子としては辿らない。
    if (key === "comments" || key === "tokens") continue;
    // 単独属性と配列属性を同じ経路に通す。
    for (const item of Array.isArray(value) ? value : [value]) {
      // 文字列・位置などの補助属性を除き、source range のある子だけ返す。
      if (item?.type && item.range) yield item;
    }
  }
}

/** JSDoc タグ・抑制指示・メタデータだけの行は、説明文の代用にしない。 */
function hasProse(comment) {
  // ライセンス本文には説明文らしい段落があっても、宣言・処理には結び付けない。
  if (/^\s*\*?\s*(?:@license|@copyright|SPDX|copyright)\b/i.test(comment.value)) return false;
  return proseLines(comment).some((line) => japanese.test(line));
}

/** コメント記号と機械向けの行を除き、説明本文の候補を返す。 */
function proseLines(comment) {
  return comment.value.split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*?\s*/, "").trim())
    .filter((line) => line && !metadata.test(line));
}

/** node:test の名前付き import、別名、namespace、default import を特定する。 */
function getTestBindings(ast) {
  const direct = new Set();
  const objects = new Set();
  // 実際に node:test から導入した入口に限定する。
  for (const statement of ast.body) {
    // 別のライブラリの同名ヘルパーは test 登録と見なさない。
    if (statement.type !== "ImportDeclaration" || statement.source.value !== "node:test") continue;
    // import の形ごとに許可する呼び出しの形を分ける。
    for (const specifier of statement.specifiers) {
      // 別名 import は実際のローカル束縛名で照合する。
      if (["test", "it", "describe", "suite", "before", "after", "beforeEach", "afterEach"].includes(specifier.imported?.name)) {
        direct.add(specifier.local.name);
      }
      // namespace はメソッド呼び出しの入口になる。
      else if (specifier.type === "ImportNamespaceSpecifier") {
        objects.add(specifier.local.name);
      }
      // default import は関数としてもプロパティ経由でも呼び出せる。
      else if (specifier.type === "ImportDefaultSpecifier") {
        direct.add(specifier.local.name);
        objects.add(specifier.local.name);
      }
    }
  }
  return { direct, objects };
}

/** コメントが必要なテスト登録・setup の呼び出し名を返す。 */
function getTestName(node, bindings, context) {
  // 関数への参照だけではテストは登録されない。
  if (node?.type !== "CallExpression") return null;
  const callee = node.callee;
  // import された関数の直接呼び出しを認識する。
  if (callee.type === "Identifier" && bindings.direct.has(callee.name)) return callee.name;
  // 実行時のキー評価を必要とする呼び出しは静的に判定しない。
  if (callee.type !== "MemberExpression" || callee.computed) return null;
  const object = callee.object.name;
  const name = callee.property.name;
  // namespace、直接 import の修飾、テストコンテキストの子登録を照合する。
  if (object && (bindings.objects.has(object) && /^(?:test|it|describe|suite|before|after|beforeEach|afterEach)$/.test(name)
    || bindings.direct.has(object) && /^(?:skip|todo|only|before|after|beforeEach|afterEach)$/.test(name)
    || context.has(object) && /^(?:test|before|after|beforeEach|afterEach)$/.test(name))) return name;
  // namespace.test.skip() のような呼び出しは修飾を外して判定する。
  if (["skip", "only", "todo"].includes(name) && callee.object.type === "MemberExpression") {
    return getTestName({ type: "CallExpression", callee: callee.object }, bindings, context);
  }
  return null;
}

/** 関数値を束縛する変数と、React の memo／forwardRef で包んだ関数を特定する。 */
function isNamedFunctionValue(value) {
  // 初期化式そのものが関数なら束縛名を文書化する。
  if (functionTypes.has(value?.type)) return true;
  // 関数を包む呼び出し以外の初期化式は対象外にする。
  if (value?.type !== "CallExpression") return false;
  const name = value.callee.name ?? value.callee.property?.name;
  return ["memo", "forwardRef"].includes(name) && value.arguments.some(isNamedFunctionValue);
}

/** 配置と形式の違反を、比較に使う識別子と表示位置に分けて返す。 */
export async function inspectComments(file, source) {
  const ast = await parsers.typescript.parse(source, { filepath: file });
  const comments = ast.comments ?? [];
  const bindings = getTestBindings(ast);
  const findings = [];
  /** ノード開始の UTF-16 オフセットを返す。 */
  const start = (node) => node.range[0];
  /** ノード終了の排他的な UTF-16 オフセットを返す。 */
  const end = (node) => node.range[1];

  /** コメントが後続の構文に接している場合だけ対応付ける。 */
  const preceding = (position, lower = -1) => {
    let left = 0;
    let right = comments.length;
    // 終了位置で二分探索し、直前の候補を一つに絞る。
    while (left < right) {
      const mid = (left + right) >>> 1;
      // 対象の後まで延びるコメントは、直前の候補に含めない。
      if (end(comments[mid]) <= position) left = mid + 1;
      // コメントが対象より後ろなら、それより手前を探す。
      else right = mid;
    }
    const comment = comments[left - 1];
    // 別の構文や許容範囲の境界をまたぐコメントは使わない。
    if (!comment || start(comment) < lower || source.slice(end(comment), position).trim()) return null;
    // ブロック先頭の明示境界があれば、開き括弧と同じ行でも関連付ける。
    if (lower >= 0) return comment;
    const lineStart = source.lastIndexOf("\n", start(comment) - 1) + 1;
    return source.slice(lineStart, start(comment)).trim() ? null : comment;
  };
  /** 非空ブロックは最初の文、空ブロックは閉じ括弧を本文説明の基準にする。 */
  const blockOpening = (node) => node?.type === "BlockStatement" ? (node.body.length ? start(node.body[0]) : end(node) - 1) : start(node);
  /** 通常コメントだけを本文説明として認める。 */
  const hasBody = (position, lower) => {
    const comment = preceding(position, lower);
    return comment && !comment.value.startsWith("*") && hasProse(comment);
  };
  /** 各枝の内部に、外から借りていない説明があるか確認する。 */
  const blockHasIntro = (node, lower = -1) => node?.type === "BlockStatement"
    ? hasBody(blockOpening(node), start(node) + 1)
    : node && hasBody(start(node), lower);
  /** 違反の比較用識別子と報告位置を分ける。 */
  const report = (rule, anchor, scope, subject, message) => {
    findings.push({ rule, key: JSON.stringify([rule, scope, subject]), line: anchor.loc.start.line, message });
  };
  /** 比較識別子における折り返しの影響を抑える。 */
  const normalize = (value) => value.replace(/\s+/g, " ").trim();
  /** コメントの翻訳や位置移動で、構文側の識別子を変えない。 */
  function signature(node) {
    // for、case、任意引数などの省略要素には識別子を追加しない。
    if (!node) return "";
    // 既存違反との照合に、対象内部のコメントや差分による行番号移動を含めない。
    let offset = start(node);
    let result = "";
    for (const comment of comments) {
      // 対象の手前にあるコメントはいじらない。
      if (end(comment) <= offset) continue;
      // コメントは位置順なので、対象を過ぎたら探索を終える。
      if (start(comment) >= end(node)) break;
      result += source.slice(offset, start(comment)) + " ";
      offset = end(comment);
    }
    return normalize(result + source.slice(offset, end(node)));
  }
  /** 対応する宣言と隣接した JSDoc があり、本文が空・機械指示だけでないことを調べる。 */
  const checkDoc = (node, label, scope) => {
    const comment = preceding(start(node));
    const attached = comment?.type === "Block" && /^\*(?!\*)/.test(comment.value)
      && (source.slice(end(comment), start(node)).match(/\n/g)?.length ?? 0) <= 1;
    // 正しい位置の非日本語 JSDoc を削った場合も、新しい欠落として識別する。
    if (!attached || !hasProse(comment)) {
      const rule = attached && proseLines(comment).some((line) => /\p{L}/u.test(line)) ? "jsdoc-language" : "jsdoc";
      report(rule, node, scope, label, `${label} の直前に用途・契約を説明する日本語の JSDoc が必要です。`);
    }
  };
  /** 他の枝の説明では対象の枝を充足できないようにする。 */
  const checkClause = (rule, label, scope, anchor, body, attached, lower) => {
    // 対象の直前にも枝の内部にも説明がなければ違反とする。
    if (!attached && !blockHasIntro(body, lower)) {
      report(rule, anchor, scope, label, `${rule}「${label}」の直前または本文先頭に日本語の説明が必要です。`);
    }
  };
  /** 隣接する二つの AST 範囲の間から、コメントではない制御キーワードを探す。 */
  const keywordAt = (keyword, from, to) => {
    // AST の子要素の間にある制御キーワードだけを調べ、コメント内の語は無視する。
    let position = from;
    for (const comment of comments) {
      // 左側の構文の内部は検索しない。
      if (end(comment) <= from) continue;
      // 右側の構文以降は今回の枝に属さない。
      if (start(comment) >= to) break;
      const match = source.slice(position, start(comment)).search(new RegExp(`\\b${keyword}\\b`));
      // コメント直前までの断片にキーワードがあれば確定する。
      if (match >= 0) return position + match;
      position = end(comment);
    }
    const match = source.slice(position, to).search(new RegExp(`\\b${keyword}\\b`));
    return match < 0 ? to : position + match;
  };
  /** 宣言名・テストの入口・本文の構造を辿り、所属するスコープごとに検査する。 */
  const walk = (node, parent, scope, context, exportAnchor) => {
    const exported = ["ExportNamedDeclaration", "ExportDefaultDeclaration"].includes(node.type);
    let nextScope = scope;
    let nextContext = context;
    // 型、クラス、関数、メソッドは宣言として文書化する。
    if (declarationTypes.has(node.type) && (node.id || node.key || node.type === "MethodDefinition" || exportAnchor)) {
      const label = signature(node.id ?? node.key) || (node.kind === "constructor" ? "constructor" : "default");
      checkDoc(exportAnchor ?? node, label, scope);
      nextScope = [...scope, label];
    }
    // 変数は公開値、または名前を持つ関数値を対象にする。
    else if (node.type === "VariableDeclaration") {
      const names = node.declarations.filter((decl) => exportAnchor || isNamedFunctionValue(decl.init))
        .map((decl) => signature(decl.id));
      // 束縛を複数まとめた場合は宣言の直前で文書化する。
      if (names.length) checkDoc(exportAnchor ?? node, names.join(", "), scope);
    }
    // 変数初期化内の本文を隣の宣言と取り違えない。
    else if (node.type === "VariableDeclarator") {
      nextScope = [...scope, signature(node.id)];
    }
    // オブジェクトメソッドとクラスの関数プロパティも名前のある処理に含める。
    else if (["Property", "PropertyDefinition"].includes(node.type) && (node.method || isNamedFunctionValue(node.value))) {
      const label = signature(node.key);
      checkDoc(node, label, scope);
      nextScope = [...scope, label];
    }
    // 登録の呼び出しは、式文または return 文に付いた JSDoc を見る。
    else if (node.type === "ExpressionStatement" || node.type === "ReturnStatement") {
      const value = node.expression ?? node.argument;
      const call = value?.type === "AwaitExpression" ? value.argument : value;
      const name = getTestName(call, bindings, context);
      if (name) {
        // テスト名を使い、同じファイルの別テストとは違反を共有しない。
        const label = `${name}(${functionTypes.has(call.arguments[0]?.type) ? "setup" : signature(call.arguments[0]) || "setup"})`;
        checkDoc(node, label, scope);
        nextScope = [...scope, label];
        const param = call.arguments.findLast((arg) => functionTypes.has(arg.type))?.params[0];
        // テストコールバックのコンテキスト経由で登録する子テストも検査する。
        if (param?.type === "Identifier") nextContext = new Set([...context, param.name]);
      }
    }

    // if と else の説明は別々に確認する。else if は子の if で確認する。
    if (node.type === "IfStatement") {
      const condition = signature(node.test);
      const elseIf = parent?.type === "IfStatement" && parent.alternate === node;
      const keyword = elseIf ? keywordAt("else", end(parent.consequent), start(node)) : -1;
      const intro = elseIf ? hasBody(keyword) || hasBody(start(node), keyword + 4) : hasBody(start(node));
      checkClause("分岐", `if (${condition})`, scope, node, node.consequent, intro, end(node.test));
      // 単独の else は then 側のコメントでは充足できない。
      if (node.alternate && node.alternate.type !== "IfStatement") {
        const keyword = keywordAt("else", end(node.consequent), start(node.alternate));
        checkClause("分岐", `else (${condition})`, scope, node.alternate, node.alternate,
          hasBody(keyword) || hasBody(start(node.alternate), keyword + 4), keyword + 4);
      }
    }
    // switch は実際の処理を持つラベルごとに確認する。
    else if (node.type === "SwitchStatement") {
      // 合流先を判定するため、ラベルの順序を保って走査する。
      for (let index = 0; index < node.cases.length; index += 1) {
        const branch = node.cases[index];
        // 本文のないラベル群は、最後のラベルの説明に合流させる。
        if (branch.consequent.length === 0 && index + 1 < node.cases.length) continue;
        const label = branch.test ? `case ${signature(branch.test)}` : "default";
        const first = branch.consequent[0];
        const intro = first && (hasBody(start(first), branch.test ? end(branch.test) : start(branch) + 7)
          || first.type === "BlockStatement" && blockHasIntro(first));
        // ラベル直前または処理開始位置の説明だけを認める。
        if (!hasBody(start(branch)) && !intro) report("分岐", branch, scope, label, `${label} の処理に日本語の説明が必要です。`);
      }
    }
    // ループは反復対象か終了条件を識別し、近くの説明と結び付ける。
    else if (loopTypes.has(node.type)) {
      const label = `${node.type} ${[node.init, node.left, node.right, node.test].map(signature).filter(Boolean).join(" ")}`;
      checkClause("反復", label, scope, node, node.body, hasBody(start(node)));
    }
    // try、catch、finally はそれぞれ処理の意図が異なる。
    else if (node.type === "TryStatement") {
      checkClause("例外処理", "try", scope, node, node.block, hasBody(start(node)));
      // catch は回復・変換・記録等を行う位置に説明を置く。
      if (node.handler) checkClause("例外処理", "catch", scope, node.handler, node.handler.body, hasBody(start(node.handler)));
      // finally は回復の枝と区別し、解放等の目的を確認する。
      if (node.finalizer) {
        const keyword = keywordAt("finally", end(node.handler ?? node.block), start(node.finalizer));
        checkClause("例外処理", "finally", scope, node.finalizer, node.finalizer,
          hasBody(keyword) || hasBody(start(node.finalizer), keyword + 7));
      }
    } else if (node.type === "BlockStatement" || node.type === "SwitchCase") {
      // 同一ブロックの直接の文だけを数える。分岐などは各構文の規則で検査する。
      let count = 0;
      let segment = "";
      // 子ブロック・ラムダの内部は、このループには現れない。
      for (const statement of node.body ?? node.consequent) {
        const straight = ["VariableDeclaration", "ExpressionStatement", "ReturnStatement", "ThrowStatement"].includes(statement.type);
        if (!straight) {
          // 制御構文・名前付き宣言を段落の比較境界にする。
          count = 0;
          segment = "";
          continue;
        }
        const lower = statement === node.body?.[0] ? start(node) + 1 : -1;
        // 位置がずれても同じ連続処理なら、説明追加前後で同じ比較キーにする。
        segment ||= signature(statement);
        // このブロックで説明の付いた文は、新しい段落の先頭になる。
        if (hasBody(start(statement), lower)) count = 0;
        count += 1;
        // 上限を超える区切りの数を比較し、説明を足すだけでは違反を増やさない。
        if (count > paragraphLimit && (count - 1) % paragraphLimit === 0) {
          report("段落", statement, scope, segment, `同じブロックの直線処理は ${paragraphLimit} 文以内で区切り、目的を説明してください。`);
        }
      }
    }
    // export キーワードごと先頭にある JSDoc を、その子宣言へ結び付ける。
    for (const child of children(node)) {
      walk(child, node, nextScope, nextContext, exported && node.declaration === child ? node : null);
    }
  };
  // ファイル直下から独立した検査を開始する。
  walk(ast, null, [], new Set(), null);
  return findings;
}

/** 同じ識別子の既存違反は件数の範囲内で引き継ぎ、増えた分だけを返す。 */
export function addedFindings(previous, next) {
  const allowance = new Map();
  // 同じキーの旧違反が複数ある場合も、観測した件数までしか許容しない。
  for (const { key } of previous) allowance.set(key, (allowance.get(key) ?? 0) + 1);
  return next.filter(({ key }) => {
    const count = allowance.get(key) ?? 0;
    // 比較元に対応する違反がなければ、新しい指摘として返す。
    if (!count) return true;
    allowance.set(key, count - 1);
    return false;
  });
}
