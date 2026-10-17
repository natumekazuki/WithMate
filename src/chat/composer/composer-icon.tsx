export type ComposerIconName =
  | "attach" | "template" | "skill" | "agent" | "folder-add" | "path" | "folders"
  | "main" | "auxiliary" | "preview" | "source" | "prompt" | "terminal"
  | "send" | "stop" | "jump-bottom" | "chevron-down"
  | "approval" | "reviewer" | "sandbox" | "depth" | "speed";

function iconBody(name: ComposerIconName, value?: string) {
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
    case "stop":
      return <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none" />;
    case "jump-bottom":
      return <path d="M12 3v13m-6-6 6 6 6-6M4 21h16" />;
    case "chevron-down":
      return <path d="m6 9 6 6 6-6" />;
    case "approval": {
      const shield = <path d="m12 2 8 3v6c0 5-4 8.5-8 11-4-2.5-8-6-8-11V5Z" />;
      if (value === "never") return <>{shield}<path d="m13 6-4 6h4l-2 6 5-8h-4Z" strokeWidth="1.3" /></>;
      if (value === "on-request") return <>{shield}<circle cx="12" cy="8" r="1.3" /><circle cx="8.5" cy="14" r="1.3" /><circle cx="15.5" cy="14" r="1.3" /><path d="m11.3 9.3-2 3.4m3.4-3.4 2 3.4" strokeWidth="1.3" /></>;
      if (value === "untrusted") return <>{shield}<path d="m8 11 3 3 5-6" /></>;
      break;
    }
    case "reviewer":
      if (value === "user") return <><circle cx="12" cy="7" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>;
      if (value === "auto-review") return <><rect x="3" y="6" width="18" height="14" rx="4" /><path d="M12 6V2M7 10h1m8 0h1m-9 5 3 3 5-5" /></>;
      break;
    case "sandbox":
      if (value === "read-only") return <><path d="M2 12s3-6 10-6 10 6 10 6-3 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>;
      if (value === "workspace-write") return <><path d="M3 19V5h6l2 3h10v3M3 19h8" /><path d="m12 19 1-4 6-6 3 3-6 6-4 1Zm5-8 3 3" /></>;
      if (value === "workspace-write-network") return <><path d="M10 19H3V5h6l2 3h10v2" /><circle cx="17" cy="17" r="5" /><path d="M12 17h10m-5-5c-3 3-3 7 0 10m0-10c3 3 3 7 0 10" strokeWidth="1.2" /></>;
      if (value === "danger-full-access") return <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M9 10V6a4 4 0 0 1 8 0M12 14v3" /><circle cx="12" cy="18.7" r=".6" fill="currentColor" stroke="none" /></>;
      break;
    case "depth": {
      const index = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].indexOf(value ?? "");
      if (index >= 0) return Array.from({ length: 7 }, (_, i) => <rect key={i} x={1.5 + i * 3.1} y={18 - i * 2} width="2" height={3 + i * 2} rx=".5" stroke="none" fill="currentColor" opacity={i <= index ? 1 : 0.2} />);
      break;
    }
    case "speed":
      if (value === "standard") return <><path d="M4 19a9 9 0 1 1 16 0H4ZM12 5v2M5.6 8l1.5 1.5m11.3-1.5-1.5 1.5M12 15l-4-4" /><circle cx="12" cy="15" r="1.3" fill="currentColor" /></>;
      if (value === "fast") return <path d="m14 2-9 12h7l-2 8 9-12h-7Z" />;
      break;
  }
  return <><circle cx="12" cy="12" r="9" /><path d="M9 8a3 3 0 0 1 6 0c0 2-3 2-3 5" /><circle cx="12" cy="17" r=".7" fill="currentColor" stroke="none" /></>;
}

export function ComposerIcon({ name, value }: { name: ComposerIconName; value?: string }) {
  return (
    <svg className="composer-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {iconBody(name, value)}
    </svg>
  );
}
