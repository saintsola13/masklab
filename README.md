# MASKLAB

Standalone web face-mask studio. Separate from the gallery.

Camera + MediaPipe Face Landmarker + Three.js overlay + record.

## Cloudflare Pages (new project)

Do not attach this to `itiagalleria`.

1. Cloudflare Dashboard → Workers & Pages → Create → Pages
2. Connect Git → `saintsola13/masklab`
3. Framework preset: None
4. Build command: leave empty
5. Output directory: `/`
6. Save and deploy

Live URL will be `https://masklab.pages.dev` (or the unique `*.pages.dev` name Cloudflare assigns). Add a custom domain later if you want.

## Local

```bash
python3 -m http.server 8080
```

Camera needs HTTPS or localhost.
