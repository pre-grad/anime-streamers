# Anime on Streamers

A static Stremio-format catalog addon for Nuvio. A GitHub Action rebuilds it daily and publishes it to GitHub Pages. No server.

## Catalogs

The addon generates **four catalog sources per service**, so you can add the Latest and Top Rated rows directly to an AIOMetadata/Xperience/Nuvio collection rather than changing sort filters in another row.

| Service in `config.json` | Catalog sources |
| --- | --- |
| Netflix | Anime on Netflix; Netflix Originals & Exclusives; **Latest Netflix Anime**; **Top Rated Netflix Anime** |
| Prime Video | Anime on Prime Video; Prime Video Originals & Exclusives; **Latest Prime Video Anime**; **Top Rated Prime Video Anime** |
| Disney+ / Hulu | Anime on Disney+ / Hulu; Disney+ / Hulu Originals & Exclusives; **Latest Disney+ / Hulu Anime**; **Top Rated Disney+ / Hulu Anime** |

Disney+ and Hulu remain **combined**, as in the original addon. There are up to 12 catalog sources (an empty source is not published).

All rows are for **anime series**, not anime films; they use the `animeFilter` in `config.json` (TMDB Animation genre and Japanese original language). Availability is **US-only**, because Hulu is US-specific and streaming rights differ by country.

### What each row means

- **Anime on [service]:** The addon finds current US subscription streaming listings and adds the service's original productions as a fallback. As before, the list remembers every show it has ever seen. **Historical titles are not guaranteed to be streaming there today.** The default order is when the addon first found them, then first air date.
- **Originals & Exclusives:** Service originals plus anime where TMDB shows no other US streaming services. Like the main list, this is historical and only grows.
- **Latest [service] Anime:** Shows in the **current US subscription streaming provider results**, ordered by their **first-ever TV air date**, newest first. Unreleased and undated titles are excluded. **It is not an exact Netflix/Prime/Disney+/Hulu "recently added" or new-season list**: TMDB does not supply the date a series was added to the service in these queries.
- **Top Rated [service] Anime:** Shows in the **current US subscription streaming provider results**, ordered by MDBList score when available, or TMDB vote average as a fallback. A show must have at least `topRatedMinVotes` TMDB votes (default **25**) to avoid a one-vote show topping the list. This threshold is editable.

Latest and Top Rated are recomputed each day and **do not accumulate historical members**. Their top-level catalog sources come pre-sorted and have pagination. The existing main/original catalogs keep the `Popular`, `Top`, and `New` sort options (Popular = TMDB popularity, Top = MDBList score where available, New = first air date).

## Permanent history and exclusivity

`data/state.json` records every show ever seen in the **main** and **originals** rows and the date it first appeared. Each build adds new shows and never removes old ones from those two rows, even if a show leaves the service. The workflow commits the state file back to the repo. Do not delete it: doing so resets the history. If the file becomes corrupt the build stops instead of starting over.

A title counts as exclusive when TMDB lists no other streaming service for it in the US: subscription, ad-supported and free tiers all count against exclusivity, while rent and buy listings do not. Those verdicts are cached in `data/state.json` and rechecked every `providerTtlDays`; at most `maxProviderLookups` titles are checked per build, with the rest rolling into the next day's run. `exclusiveProviders` per service lists provider ids that still count as the same service (Netflix Kids, Prime with Ads, etc.). Provider ids can be checked at `https://api.themoviedb.org/3/watch/providers/tv?watch_region=US&api_key=YOURKEY`.

## Setup or updating an existing deployment

1. Create a public GitHub repo and push these files to `main`, or update `build.mjs`, `config.json`, and `README.md` in your current repo. **Keep your existing `data/state.json` if you already deployed a prior version.**
2. Settings → Secrets and variables → Actions → New repository secret:
   - `TMDB_API_KEY` (v3 key or v4 Read Access Token)
   - `MDBLIST_API_KEY` (recommended for rankings; without it, TMDB ratings are used)
3. Settings → Pages → Source: **GitHub Actions**.
4. Actions → Build addon → Run workflow, or push the update to `main`.
5. In Nuvio / AIOMetadata, refresh the installed addon's catalog list, then add any of the new **Latest** and **Top Rated** sources to your collection. The addon manifest URL does not change: `https://<user>.github.io/<repo>/manifest.json`.

## Notes

- Items use IMDb ids (from MDBList, TMDB as fallback) so metadata and stream addons can match them.
- TMDB `/discover/tv` limits how many titles are returned (`maxPagesPerQuery`); the new sorted catalogs are only as complete as the provider discovery results. Service provider tagging can lag changes on streaming platforms.
- A build enriches shows with MDBList, so API usage depends on how many shows TMDB returns and the number retained from previous runs.
- Keepalive: every run re-enables its own schedule, and the state file gets a commit at least once a month, so GitHub's 60-day inactivity pause does not kick in.
- A failed build never touches the published addon; the last good version stays live.
- Run locally: `TMDB_API_KEY=... MDBLIST_API_KEY=... node build.mjs`, output lands in `dist/`.

Uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability sourced through TMDB/JustWatch. Ratings by MDBList, with TMDB fallback.
