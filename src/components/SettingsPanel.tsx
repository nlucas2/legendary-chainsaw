import { Palette, Settings2, SlidersHorizontal, Wrench, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  TYPOGRAPHY_LIMITS,
  chatFontFamily,
  sanitizeCustomFontFamily,
  terminalTypography,
  typographyPreset,
  type ChatFontFamily,
  type TerminalFontFamily,
  type TypographySettings,
} from "../lib/typography";
import type { TypographyController } from "../lib/useTypography";
import "../typography.css";

export type ThemePreference = "auto" | "light" | "dark";

interface SettingsPanelProps {
  themePreference: ThemePreference;
  onThemePreferenceChange: (scheme: ThemePreference) => void;
  onOpenRuntime: () => void;
  onClose: () => void;
  typography?: TypographyController;
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
  typography,
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

        {typography && <TypographySection typography={typography} />}

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

function TypographySection({ typography }: { typography: TypographyController }) {
  const { settings, setSettings, error, reset } = typography;
  const id = useId();
  const terminal = terminalTypography(settings);
  const updateChat = (patch: Partial<TypographySettings>) =>
    setSettings((current) => ({ ...current, ...patch, preset: "custom" }));
  const updateTerminal = (patch: Partial<TypographySettings>) =>
    setSettings((current) => ({ ...current, ...patch }));
  return (
    <section className="settings-section typography-settings" aria-labelledby={`${id}-title`}>
      <div className="settings-section-title">
        <SlidersHorizontal size={15} aria-hidden="true" />
        <div>
          <strong id={`${id}-title`}>Font &amp; spacing</strong>
          <span>Local fonts only. Changes preview immediately; no terminal restart.</span>
        </div>
      </div>
      {error && <p className="typography-error" role="alert">{error}</p>}
      <div className="typography-presets" role="group" aria-label="Typography presets">
        <button type="button" aria-pressed={settings.preset === "default"} onClick={reset}>
          Original
          <small>Keep the current appearance</small>
        </button>
        <button
          type="button"
          aria-pressed={settings.preset === "cli"}
          onClick={() => setSettings(typographyPreset("cli"))}
        >
          CLI-like
          <small>Readable monospace, compact spacing</small>
        </button>
      </div>
      <p className="typography-hint">
        CLI-like uses Cascadia Code, Cascadia Mono, or Consolas when installed, then a local
        monospace fallback. It does not identify or reproduce another app&apos;s exact font.
      </p>
      <fieldset>
        <legend>Conversation</legend>
        <label className="typography-field" htmlFor={`${id}-chat-family`}>
          <span>Chat font</span>
          <select
            id={`${id}-chat-family`}
            value={settings.fontFamily}
            onChange={(event) => updateChat({ fontFamily: event.target.value as ChatFontFamily })}
          >
            <option value="system">System sans-serif</option>
            <option value="mono">Monospace</option>
            <option value="custom">Custom local font</option>
          </select>
        </label>
        {settings.fontFamily === "custom" && (
          <CustomFontInput
            label="Custom chat font families"
            value={settings.customFontFamily}
            onApply={(customFontFamily) => updateChat({ customFontFamily })}
          />
        )}
        <TypographySlider label="Chat font size" setting="fontSize" value={settings.fontSize} unit="px"
          onChange={(fontSize) => updateChat({ fontSize })} />
        <TypographySlider label="Chat line spacing" setting="lineHeight" value={settings.lineHeight} unit="×"
          onChange={(lineHeight) => updateChat({ lineHeight })} />
        <TypographySlider label="Paragraph spacing" setting="paragraphSpacing" value={settings.paragraphSpacing} unit="px"
          onChange={(paragraphSpacing) => updateChat({ paragraphSpacing })} />
        <p className="typography-hint">
          Affects messages, reasoning summaries, and the composer—not sidebar text or icons.
          Code stays monospace. Original keeps the existing per-element spacing until customized.
        </p>
      </fieldset>
      <fieldset>
        <legend>Terminal</legend>
        <label className="typography-field" htmlFor={`${id}-terminal-family`}>
          <span>Terminal font</span>
          <select
            id={`${id}-terminal-family`}
            value={settings.terminalFontFamily}
            onChange={(event) => updateTerminal({ terminalFontFamily: event.target.value as TerminalFontFamily })}
          >
            <option value="default">Original terminal font</option>
            <option value="mono">Monospace (recommended)</option>
            <option value="shared">Use chat font</option>
            <option value="system">System sans-serif</option>
            <option value="custom">Custom local font</option>
          </select>
        </label>
        {settings.terminalFontFamily === "custom" && (
          <CustomFontInput
            label="Custom terminal font families"
            value={settings.terminalCustomFontFamily}
            onApply={(terminalCustomFontFamily) => updateTerminal({ terminalCustomFontFamily })}
          />
        )}
        <TypographySlider label="Terminal font size" setting="terminalFontSize" value={settings.terminalFontSize} unit="px"
          onChange={(terminalFontSize) => updateTerminal({ terminalFontSize })} />
        <TypographySlider label="Terminal line spacing" setting="terminalLineHeight" value={settings.terminalLineHeight} unit="×"
          onChange={(terminalLineHeight) => updateTerminal({ terminalLineHeight })} />
        <p className="typography-hint">
          Terminal size and spacing are independent. Proportional fonts may misalign terminal columns.
        </p>
      </fieldset>
      <section className="typography-preview" aria-label="Live typography preview">
        <strong>Live preview</strong>
        <div className="typography-chat-preview" style={{
          fontFamily: chatFontFamily(settings),
          fontSize: `${settings.fontSize}px`,
          lineHeight: settings.lineHeight,
        }}>
          <p style={{ margin: `0 0 ${settings.paragraphSpacing}px` }}>You: Show the next step.</p>
          <p style={{ margin: 0 }}>Copilot: Review the changes, then run the tests.</p>
        </div>
        <pre className="typography-terminal-preview" style={{
          fontFamily: terminal.fontFamily,
          fontSize: `${terminal.fontSize}px`,
          lineHeight: terminal.lineHeight,
        }}>{"PS > git status\nOn branch main"}</pre>
      </section>
      <button className="typography-reset" type="button" onClick={reset}>Reset font &amp; spacing</button>
    </section>
  );
}

function TypographySlider({
  label, setting, value, unit, onChange,
}: {
  label: string;
  setting: keyof typeof TYPOGRAPHY_LIMITS;
  value: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="typography-slider">
      <label htmlFor={id}>{label}</label>
      <output htmlFor={id}>{value} {unit}</output>
      <input id={id} type="range" {...TYPOGRAPHY_LIMITS[setting]} value={value}
        aria-valuetext={`${value} ${unit === "px" ? "pixels" : "times font size"}`}
        onChange={(event) => onChange(event.target.valueAsNumber)} />
    </div>
  );
}

function CustomFontInput({
  label, value, onApply,
}: {
  label: string;
  value: string;
  onApply: (value: string) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const sanitized = sanitizeCustomFontFamily(draft);
  const invalid = Boolean(draft.trim()) && !sanitized;
  const apply = () => {
    if (!invalid && sanitized !== value) onApply(sanitized);
  };
  return (
    <div className="typography-custom-font">
      <label htmlFor={id}>{label}</label>
      <div>
        <input id={id} type="text" value={draft} maxLength={200}
          placeholder="Cascadia Code, Consolas" spellCheck={false}
          aria-invalid={invalid} aria-describedby={`${id}-help`}
          onChange={(event) => setDraft(event.target.value)} onBlur={apply}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); apply(); }
          }} />
        <button type="button" disabled={invalid} onClick={apply}>Apply font</button>
      </div>
      <p id={`${id}-help`} className={invalid ? "typography-error" : "typography-hint"} aria-live="polite">
        {invalid
          ? "Enter up to six comma-separated font names, not CSS declarations or URLs."
          : "Installed font names only. Press Enter, Apply font, or leave the field to apply. Blank uses the fallback."}
      </p>
    </div>
  );
}
