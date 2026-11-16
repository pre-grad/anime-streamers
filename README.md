# Anime on Streamers

A static Stremio-format catalog addon for Nuvio. A GitHub Action rebuilds it daily and publishes it to GitHub Pages. No server.

## Rows

Everything is US availability: `region` is fixed to `US` in `config.json`, since Hulu exists nowhere else and anime streaming rights differ by country.

| Row | What is in it |
| --- | --- |
| Anime on Netflix | Anime streaming on Netflix in the US, plus Netflix originals |
| Netflix Originals & Exclusives | Netflix originals, plus anime that streams nowhere else in the US |
| Anime on Prime Video / Prime Video Originals & Exclusives | Same, for Amazon |
| Anime on Disney+ / Hulu / Disney+ / Hulu Originals & Exclusives | Same, for Disney+ and Hulu combined |

A title counts as exclusive when TMDB lists no other streaming service for it in the US: subscription, ad-supported and free tiers all count against exclusivity, while rent and buy listings do not. Those verdicts are cached in `data/state.json` and rechecked every `providerTtlDays`; at most `maxProviderLookups` titles are checked per build, with the rest rolling into the next day's run. `exclusiveProviders` per service lists the provider ids that still count as "the same service" (Netflix Kids, Prime with Ads, and so on) — the current ids at `https://api.themoviedb.org/3/watch/providers/tv?watch_region=US&api_key=YOURKEY`.

Rows open with the most recently added shows first. Each row also has a Popular / Top / New filter: Popular is TMDB popularity, Top is the MDBList score, New is first air date.

## Lists only grow

`data/state.json` records every show ever seen in each row and the date it first appeared. Each build adds new shows and never removes old ones, so a show that leaves a service stays in its row. The workflow commits that file back to the repo. Do not delete it: that resets the history. If the file is ever corrupt the build stops instead of starting over.

"Anime" means TMDB genre Animation with Japanese as the original language. Change `animeFilter` in `config.json` to adjust (for example add `"with_keywords": "210024"` to require the anime keyword).

## Setup

1. Create a public repo and push these files to `main`.
2. Settings → Secrets and variables → Actions → New repository secret:
   - `TMDB_API_KEY` (the short v3 key or the long Read Access Token, either works)
   - `MDBLIST_API_KEY`
3. Settings → Pages → Source: **GitHub Actions**.
4. Actions → Build addon → Run workflow.
5. Add `https://<user>.github.io/<repo>/manifest.json` in Nuvio.

## Notes

- Items use IMDb ids (from MDBList, TMDB as fallback) so metadata and stream addons work on them.
- A build uses roughly 10 MDBList calls and a few hundred TMDB calls.
- Keepalive: every run re-enables its own schedule, and the state file gets a commit at least once a month, so GitHub's 60-day inactivity pause does not kick in.
- A failed build never touches the published addon; the last good version stays live.
- Run locally: `TMDB_API_KEY=... MDBLIST_API_KEY=... node build.mjs`, output lands in `dist/`.

Uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability by JustWatch. Ratings by MDBList.
