import { LoadingIndicator } from "../ui/loading-indicator.js";

type HomeStatusScreenProps = {
  homePageClassName: string;
  message: string;
  loading?: boolean;
};

export function HomeStatusScreen({ homePageClassName, message, loading = false }: HomeStatusScreenProps) {
  return (
    <div className={homePageClassName}>
      <main className="home-layout home-layout-minimal">
        <section className="panel empty-list-card rise-1" aria-busy={loading}>
          {loading ? (
            <LoadingIndicator label={message} />
          ) : (
            <p>{message}</p>
          )}
        </section>
      </main>
    </div>
  );
}
