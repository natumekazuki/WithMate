export function FilePinIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" width="16" height="16">
      <path
        d="m7.2 2.8 5.7 5.7 1.3-.3 1.2 1.2-3.6 1.9-1.9 3.6-1.2-1.2.3-1.3-5.7-5.7 1.3-1.3 1.3.3 1.3-1.3Zm-2.9 9.9 2.9 2.9-2.5 1.6-2-2 1.6-2.5Z"
        fill={active ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
