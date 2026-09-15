set windows-shell := ["pwsh", "-NoProfile", "-Command"]

# Run from an external Windows Terminal, not a terminal owned by this app.
[windows]
update:
    pwsh -NoProfile -File .\scripts\update-desktop.ps1

# Inspect update prerequisites without building, draining, or stopping anything.
[windows]
update-check:
    pwsh -NoProfile -File .\scripts\update-desktop.ps1 -CheckOnly
