# Flowcode website

Static site deployed as-is to GitHub Pages by `.github/workflows/pages.yml`. No build step, except for the changelog.

## Changelog pages

`site/changelog.html` (the list) and `site/releases/<tag>.html` (one page per release) are **generated** from the GitHub releases of MaxMoffa/flowcode by `scripts/site-releases.mjs`. They are gitignored: CI builds them before every deploy, and a published or edited release triggers a redeploy. The page shell is `scripts/site-templates/page.html`; keep its nav and footer in sync with the other pages.

The release notes on GitHub are the source of truth. The script renders their Markdown itself (headings, paragraphs, bold, italic, code, links, lists, GitHub-hosted images). Everything else is escaped. If a release note has an Italian copy after a `---` line (older releases), only the English part is shown.

## Preview locally

```sh
node scripts/site-releases.mjs      # Node 20+, no dependencies; set GITHUB_TOKEN to avoid the API rate limit
cd site && python -m http.server 8791
```

Then open http://localhost:8791. Without the script, the Changelog link 404s locally.

## Release artwork

Every cover is 8-bit pixel art drawn in code: `scripts/release-art/render.mjs` paints a 160x90 pixel scene (the night pond, the Flowcode frog from `src/terminal/frogArt.ts`, a 5x7 pixel font) and writes `site/assets/releases/<name>.png` at 1600x900 with hard edges. No dependencies.

- New release: add an entry named after the tag (e.g. `"v0.39.0"`) to `COVERS` in `render.mjs`, drawing something that tells that update's story on the shared `nightPond()`; run `node scripts/release-art/render.mjs v0.39.0` and commit the PNG.
- Lookup order: `site/assets/releases/<tag>.{png,webp,jpg,svg}`, else `generic.png` (older releases).
- The same file is shown in the app's Changelog page.

Commit the file, then rerun the Pages workflow (or push it with the release); the next build picks it up.
