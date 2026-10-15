/** Opaque rendering surfaces used by Monaco and xterm, matching design-tokens.css. */
export const workspacePalette = {
  light: { background: "#f8faff", foreground: "#25324d", muted: "#9ba8bf", active: "#52627e", line: "#eef2fa", border: "#e0e6f1", selection: "#dce6ff", widget: "#ffffff", accent: "#5268e8" },
  dark: { background: "#171e2e", foreground: "#dce4f5", muted: "#64728e", active: "#bbc6dc", line: "#202a40", border: "#303b54", selection: "#324874", widget: "#252d42", accent: "#8299ff" },
} as const;
