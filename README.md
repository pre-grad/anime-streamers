# Anime on Streamers

A static Stremio-format catalog addon for Nuvio. A GitHub Action rebuilds it daily and publishes it to GitHub Pages. No server.

## Rows

| Row | What is in it |
| --- | --- |
| Anime on Netflix | Anime streaming on Netflix in your region, plus Netflix originals |
| Netflix Original Anime | Anime whose network on TMDB is Netflix |
| Anime on Prime Video / Prime Video Original Anime | Same, for Amazon |
| Anime on Disney+ / Hulu / Disney+ / Hulu Original Anime | Same, for Disney+ and Hulu combined |

Rows open with the most recently added shows first. Each row also has a Popular / Top / New filter: Popular is TMDB popularity, Top is the MDBList score, New is first air date.

## Lists only grow

`data/state.json` records every show ever seen in each row and the date it first appeared. Each build adds new shows and never removes old ones, so a show that leaves a service stays in its row. The workflow commits that file back to the repo. Do not delete it: that resets the history. If the file is ever corrupt the build stops instead of starting over.

"Anime" means TMDB genre Animation with Japanese as the original language. Change `animeFilter` in `config.json` to adjust (for example add `"with_keywords": "210024"` to require the anime keyword).

## Setup

1. Create a public repo and push these files to `main`.
2. Settings → Secrets and variables → Actions → New repository secret:
   - `TMDB_API_KEY` (the short v3 key or the long Read Access Token, either works)
   - `MDBLIST_API_KEY`
3. Optional: on the Variables tab add `WATCH_REGION` (default `US`). Hulu only has data for `US`.
4. Settings → Pages → Source: **GitHub Actions**.
5. Actions → Build addon → Run workflow.
6. Add `https://<user>.github.io/<repo>/manifest.json` in Nuvio.

## Notes

- Items use IMDb ids (from MDBList, TMDB as fallback) so metadata and stream addons work on them.
- A build uses roughly 10 MDBList calls and a few hundred TMDB calls.
- Keepalive: every run re-enables its own schedule, and the state file gets a commit at least once a month, so GitHub's 60-day inactivity pause does not kick in.
- A failed build never touches the published addon; the last good version stays live.
- Run locally: `TMDB_API_KEY=... MDBLIST_API_KEY=... node build.mjs`, output lands in `dist/`.

Uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability by JustWatch. Ratings by MDBList.
