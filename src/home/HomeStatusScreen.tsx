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
            <div className="home-session-list-load-status" role="status" aria-live="polite">
              <span className="home-session-list-load-spinner" aria-hidden="true" />
              <span className="sr-only">{message}</span>
            </div>
          ) : (
            <p>{message}</p>
          )}
        </section>
      </main>
    </div>
  );
}
