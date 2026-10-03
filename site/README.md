# Emberstage for OBS operator guide

Static post-install usage guide covering Scripture, Songs, Text, Media, Cameras, and streaming, with annotated screenshots, plans, and provider availability.

## Files

- `index.html`
- `styles.css`
- `script.js`
- `brand/` — self-contained site branding
- `screenshots/` — annotated local-tool and streaming captures

## Local serve

From the `site/` directory:

```bash
python3 -m http.server 4173
```

Then open:

```text
http://localhost:4173
```

## Notes

- Plain HTML, CSS, and JS only
- No external fonts, frameworks, or dependencies
- Screenshots use synthetic example state; camera thumbnails are illustrative, not live hardware
- The guide is not connected to OBS, providers, billing, or accounts
- Upload only this directory to the `emberstage` Cloudflare Pages project; do not upload the repository or runtime configuration
