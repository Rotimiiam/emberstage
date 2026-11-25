# Emberstage portal and relay

## Stitch-first UI
Any new or restyled page, dialog, dropdown, form, or visual change must be designed in Google Stitch first (project 8643902531629831640), shown to the owner, and approved before implementation. Use the emberstage-stitch skill. Record the approved screen id in the commit.

- Commit and push each completed step in this repo, with the narrowest check for the change run first. Commit per logical unit, not one dump at the end. Verify the personal GitHub identity before pushing.
- Live deployment is a separate explicit step from the commit. Never deploy or restart the hosted service as part of a commit.
- `origin` is `Rotimiiam/emberstage`. `obs-bible-plugin` is the upstream OBS plugin and is not the deployment target.
- `server/deploy/personal-aws/` is the reviewed deployment path for the permanent personal-AWS host. Read its `README.md` before any deploy. `server/.env` stays gitignored.
- Do not enable Nango, Paystack, camera rooms or public ingest as a side effect of an unrelated change. Prefer a guest-built bundle and preserve database, secret and service configuration.
