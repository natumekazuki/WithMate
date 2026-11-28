/** 要約の応答が現在の検索条件に属するかを比較する、作業開始時点の世代とクエリキー。 */
export type HomeSessionQueryRequestToken = {
  generation: number;
  queryKey: string;
};

/** 検索条件や再取得が変わるたびに世代を制御し、古い要約の反映を防ぐ。 */
export class HomeSessionQueryGeneration {
  private generation = 0;
  private queryKey: string;

  /** 最初のクエリキーを登録する。まだ取得世代は進めない。 */
  constructor(queryKey: string) {
    this.queryKey = queryKey;
  }

  /** 検索条件のキーに変更があった場合だけ、今までの応答を無効にする。 */
  syncQueryKey(queryKey: string): void {
    if (queryKey === this.queryKey) {
      return;
    }
    this.queryKey = queryKey;
    this.generation += 1;
  }

  /** 同じ条件でも次の取得を始めると世代を進め、新しい照合用トークンを返す。 */
  beginRequest(): HomeSessionQueryRequestToken {
    this.generation += 1;
    return this.capture();
  }

  /** 世代を変更せずに現在のクエリを照合できる値を取得する。 */
  capture(): HomeSessionQueryRequestToken {
    return {
      generation: this.generation,
      queryKey: this.queryKey,
    };
  }

  /** 発行時の世代と検索条件が両方とも現在値と一致するかを確かめる。 */
  isCurrent(token: HomeSessionQueryRequestToken): boolean {
    return (
      token.generation === this.generation && token.queryKey === this.queryKey
    );
  }
}

/** 検索語と、順序も含む開いている Session ID の一覧を一つの照合キーにする。 */
export function buildHomeSessionQueryKey(
  searchText: string,
  openSessionIds: readonly string[],
): string {
  return JSON.stringify([searchText, openSessionIds]);
}
