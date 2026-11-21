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

Each release can have its own cover: put it at `site/assets/releases/<tag>.<ext>`, where `<tag>` is the release tag exactly (for example `v0.38.0.svg`) and `<ext>` is `svg`, `webp`, `png` or `jpg` (looked up in that order).

- Size: 1600 × 900 (16:9). It is shown cropped to 16:9 on the list card and on top of the release page, and used as the page's `og:image`.
- For social previews prefer `png` or `jpg`: most platforms don't render SVG `og:image`.
- Releases without their own file use `site/assets/releases/generic.svg`.

Commit the file, then rerun the Pages workflow (or push it with the release); the next build picks it up.
