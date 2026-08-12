export type MarkdownLinkContextMenuPoint = {
  x: number;
  y: number;
};

export type MarkdownLinkContextMenuRequest = {
  target: string;
  point: MarkdownLinkContextMenuPoint;
};

export type MarkdownLinkContextMenuResult =
  | { status: "copied" }
  | { status: "dismissed" }
  | { status: "failed"; message: string };
