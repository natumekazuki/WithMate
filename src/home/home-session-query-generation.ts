export type HomeSessionQueryRequestToken = {
  generation: number;
  queryKey: string;
};

export class HomeSessionQueryGeneration {
  private generation = 0;
  private queryKey: string;

  constructor(queryKey: string) {
    this.queryKey = queryKey;
  }

  syncQueryKey(queryKey: string): void {
    if (queryKey === this.queryKey) {
      return;
    }
    this.queryKey = queryKey;
    this.generation += 1;
  }

  beginRequest(): HomeSessionQueryRequestToken {
    this.generation += 1;
    return this.capture();
  }

  capture(): HomeSessionQueryRequestToken {
    return { generation: this.generation, queryKey: this.queryKey };
  }

  isCurrent(token: HomeSessionQueryRequestToken): boolean {
    return token.generation === this.generation && token.queryKey === this.queryKey;
  }
}

export function buildHomeSessionQueryKey(searchText: string, openSessionIds: readonly string[]): string {
  return JSON.stringify([searchText, openSessionIds]);
}
