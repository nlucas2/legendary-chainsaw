import { useEffect, useRef, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "../lib/daemon";
import { linkDestination } from "../lib/links";
import "./external-link.css";

export function ExternalLink({ href, children, onClick, onAuxClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const destination = linkDestination(href);
  const [error, setError] = useState<{ href: string; message: string }>();
  const currentHref = useRef(href);
  const pending = useRef<string | null>(null);
  currentHref.current = href;
  useEffect(() => {
    currentHref.current = href;
    return () => { currentHref.current = undefined; };
  }, [href]);

  function activate(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || ![0, 1].includes(event.button) || !isTauri()) return;
    if (destination.kind === "fragment") {
      if (event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
        event.preventDefault();
        window.location.hash = destination.href;
      }
      return;
    }
    if (destination.kind !== "external") return;
    // Prevent webview navigation before awaiting IPC; never fall back to location.href on failure.
    // The opener plugin's default click listener also honors defaultPrevented.
    event.preventDefault();
    if (pending.current === destination.href) return;
    const requestedHref = href;
    const url = destination.href;
    pending.current = url;
    setError(undefined);
    void openUrl(url).catch((cause) => {
      if (currentHref.current === requestedHref) setError({
        href: requestedHref ?? "",
        message: `Could not open the link outside the app: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }).finally(() => { if (pending.current === url) pending.current = null; });
  }

  if (destination.kind === "unsupported") {
    return <span className="unsupported-link" role="link" aria-disabled="true" tabIndex={0} title={destination.reason}>{children}</span>;
  }
  return <>
    <a {...props} href={destination.href}
      target={destination.kind === "external" ? "_blank" : undefined}
      rel={destination.kind === "external" ? "noopener noreferrer" : undefined}
      onClick={(event) => { onClick?.(event); activate(event); }}
      onAuxClick={(event) => { onAuxClick?.(event); activate(event); }}>{children}</a>
    {error && error.href === href && <span className="external-link-error" role="alert">
      {error.message} <button type="button" onClick={() => setError(undefined)}>Dismiss</button>
    </span>}
  </>;
}
