import { Palette, Settings2, SlidersHorizontal, Wrench, X } from "lucide-react";

export type ThemePreference = "auto" | "light" | "dark";

interface SettingsPanelProps {
  themePreference: ThemePreference;
  onThemePreferenceChange: (scheme: ThemePreference) => void;
  onOpenRuntime: () => void;
  onClose: () => void;
}

const schemes: {
  id: ThemePreference;
  name: string;
  description: string;
  colors: [string, string, string];
}[] = [
  {
    id: "auto",
    name: "Auto",
    description: "Follow the operating system",
    colors: ["#1e1e2e", "#f4ecd8", "#3b6ea5"],
  },
  {
    id: "light",
    name: "Light",
    description: "Warm paper, easy on the eyes",
    colors: ["#f4ecd8", "#ece2c8", "#3b6ea5"],
  },
  {
    id: "dark",
    name: "Dark",
    description: "Deep navy, cool blue accent",
    colors: ["#0b0f14", "#192432", "#38bdf8"],
  },
];

export function SettingsPanel({
  themePreference,
  onThemePreferenceChange,
  onOpenRuntime,
  onClose,
}: SettingsPanelProps) {
  return (
    <div className="settings-backdrop">
      <section className="settings-panel" aria-label="Settings">
        <header>
          <div className="settings-heading">
            <div className="settings-mark">
              <Settings2 size={18} />
            </div>
            <div>
              <span>Copilot Sessions</span>
              <h2>Settings</h2>
            </div>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </header>

        <div className="settings-section">
          <div className="settings-section-title">
            <Palette size={15} />
            <div>
              <strong>Appearance</strong>
              <span>Shared by this browser or desktop installation</span>
            </div>
          </div>
          <div className="scheme-grid">
            {schemes.map((scheme) => (
              <button
                key={scheme.id}
                className={
                  themePreference === scheme.id ? "scheme-card active" : "scheme-card"
                }
                onClick={() => onThemePreferenceChange(scheme.id)}
              >
                <span className="scheme-preview">
                  {scheme.colors.map((color) => (
                    <i key={color} style={{ background: color }} />
                  ))}
                </span>
                <strong>{scheme.name}</strong>
                <small>{scheme.description}</small>
                <span className="scheme-check" />
              </button>
            ))}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">
            <SlidersHorizontal size={15} />
            <div>
              <strong>Runtime</strong>
              <span>Copilot, MCP, terminal, and update lifecycle</span>
            </div>
          </div>
          <button className="settings-navigation" onClick={onOpenRuntime}>
            <span className="settings-navigation-icon">
              <Wrench size={17} />
            </span>
            <span>
              <strong>Runtime maintenance</strong>
              <small>Reload MCP, drain Copilot, or prepare an update</small>
            </span>
            <i>Open</i>
          </button>
        </div>

        <footer>
          Settings are local to this client. Session and runtime state remain owned by the
          daemon.
        </footer>
      </section>
    </div>
  );
}
