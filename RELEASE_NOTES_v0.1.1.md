# Release Notes — v0.1.1

## Mobile chat layout

Phone screens now prioritize the conversation surface over chrome.

### Changes
- **Maximize message area** — tighter top bar, conversation strip, and chat header on ≤860px; edge-to-edge layout under ≤620px (no outer margins/rounded frame).
- **Reduce titles** — conversation/report titles are compact and truncated; status subtitles and “AI ready” badges hide on phones.
- **Remove bottom helper copy** — desktop-only hints such as “Enter to send…” / day-swipe tips are hidden on mobile so the composer sits closer to the messages.
- **Safer viewport** — `viewport-fit=cover` plus reduced safe-area padding under the composer.

### Files
- `apps/web/src/styles.css`
- `apps/web/src/App.tsx`
- `apps/web/index.html`

Desktop layout is unchanged aside from the shared `composer-hint` class name.
