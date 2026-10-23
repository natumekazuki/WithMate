export type ComposerIconName =
  | "attach" | "template" | "skill" | "agent" | "folder-add" | "path" | "folders"
  | "main" | "auxiliary" | "preview" | "source" | "prompt" | "terminal"
  | "send" | "resend" | "edit" | "stop" | "close" | "jump-bottom";

function iconBody(name: ComposerIconName) {
  switch (name) {
    case "attach":
      return <><path d="m8 12 6.6-6.6a3.5 3.5 0 0 1 5 5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8-8" /><path d="m7.7 14.9 7.1-7.1a1.5 1.5 0 0 1 2.1 2.1l-7.1 7.1" /></>;
    case "template":
      return <><path d="M8 3h8l4 4v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M15 3v5h5M10 12h6M10 16h4M3 7v11" /></>;
    case "skill":
      return <path d="M9 3h6v3a2.5 2.5 0 1 1 3 4h3v6h-3a2.5 2.5 0 1 1-4 3v2H8v-4H5a2.5 2.5 0 1 1 0-5h3V7H6a2.5 2.5 0 1 1 3-4Z" />;
    case "agent":
      return <><rect x="4" y="7" width="16" height="13" rx="4" /><path d="M12 7V3M2 11v5M22 11v5M9 16h6" /><circle cx="8.5" cy="11.5" r=".8" fill="currentColor" stroke="none" /><circle cx="15.5" cy="11.5" r=".8" fill="currentColor" stroke="none" /><circle cx="12" cy="2.5" r="1.2" fill="currentColor" stroke="none" /></>;
    case "folder-add":
      return <><path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 9h18M12 12v6M9 15h6" /></>;
    case "path":
      return <path d="M6 5H3v14h3m12-14h3v14h-3M14 7l-4 10" />;
    case "folders":
      return <path d="M3 6V4h6l2 3h8M3 11h5l2 2h11v7H3ZM3 10V8h5l2 2h11" />;
    case "main":
    case "auxiliary":
      return <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M12 4v16" /><rect x={name === "main" ? 5.5 : 14.5} y="6.5" width="4" height="11" rx=".8" fill="currentColor" stroke="none" /></>;
    case "preview":
      return <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>;
    case "source":
      return <path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16" />;
    case "prompt":
      return <><path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7" /><path d="m10 14 1-4 8-8 3 3-8 8-4 1Zm7-10 3 3" /></>;
    case "terminal":
      return <><rect x="2" y="4" width="20" height="16" rx="3" /><path d="m6 9 3 3-3 3m7 0h5" /></>;
    case "send":
      return <><path d="m22 2-7 20-4-9-9-4 20-7Z" /><path d="M22 2 11 13" /></>;
    case "resend":
      return <><path d="M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7" /></>;
    case "edit":
      return <><path d="m4 16-1 5 5-1L21 7l-4-4L4 16ZM14 6l4 4M4 16l4 4" /></>;
    case "stop":
      return <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none" />;
    case "close":
      return <path d="m6 6 12 12M6 18 18 6" />;
    case "jump-bottom":
      return <path d="M12 3v13m-6-6 6 6 6-6M4 21h16" />;
  }
}

export function ComposerIcon({ name }: { name: ComposerIconName }) {
  return (
    <svg className="composer-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {iconBody(name)}
    </svg>
  );
}
