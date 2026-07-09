type HomeStatusScreenProps = {
  homePageClassName: string;
  message: string;
};

export function HomeStatusScreen({ homePageClassName, message }: HomeStatusScreenProps) {
  return (
    <div className={homePageClassName}>
      <main className="home-layout home-layout-minimal">
        <section className="panel empty-list-card rise-1">
          <p>{message}</p>
        </section>
      </main>
    </div>
  );
}
