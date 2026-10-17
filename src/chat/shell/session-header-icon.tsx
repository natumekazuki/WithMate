export function SessionHeaderIcon({ name }: { name: "folder" | "terminal" | "external-terminal" }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {name === "folder" ? (
        <path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM3 9h18" />
      ) : (
        <>
          {name === "terminal" ? (
            <rect x="2" y="4" width="20" height="16" rx="3" />
          ) : (
            <><path d="M12 4H5a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3v-5" /><path d="M16 2h6v6m0-6-7 7" /></>
          )}
          <path d="m6 9 3 3-3 3m7 0h5" />
        </>
      )}
    </svg>
  );
}
