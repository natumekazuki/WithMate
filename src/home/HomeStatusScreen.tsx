import { LoadingIndicator } from "../ui/loading-indicator.js";

/** Home 本体をまだ表示できない理由、処理中かどうかと、外枠へ渡すクラス。 */
type HomeStatusScreenProps = {
  homePageClassName: string;
  message: string;
  loading?: boolean;
};

/** 最小の Home レイアウトで、待機中なら進捗、そうでなければ案内文を表示する。 */
export function HomeStatusScreen({
  homePageClassName,
  message,
  loading = false,
}: HomeStatusScreenProps) {
  return (
    <div className={homePageClassName}>
      <main className="home-layout home-layout-minimal">
        <section className="panel empty-list-card rise-1" aria-busy={loading}>
          {loading ? <LoadingIndicator label={message} /> : <p>{message}</p>}
        </section>
      </main>
    </div>
  );
}
