# Cost Estimation: Recreating the Extension

Estimated 2026-10-17 from the files in the root of `D:\projects\ext` (subfolders ignored).
Tokens are estimated at ~3.5 characters per token.

## File inventory

| File | Size | Est. tokens |
|---|---|---|
| `content.js` | 60 KB, 1,415 lines | ~17,300 |
| `background.js` | 5.5 KB | ~1,600 |
| `offscreen.js` | 3.4 KB | ~1,000 |
| `manifest.json` | 0.9 KB | ~250 |
| `offscreen.html` | 0.2 KB | ~60 |
| **Own code, total** | | **~20,000** |
| `pdf-lib.min.js` | 525 KB | ~150,000 |

`pdf-lib.min.js` is a minified third-party library. Do not have a model regenerate it
(~150k output tokens, unreliable). Install it from npm (`pdf-lib`) instead.
That leaves ~20k tokens of code to write.

## Cost scenarios

Prices are placeholders: **$3 / 1M input tokens, $15 / 1M output tokens**.
Substitute the real current rates.

| Scenario | Tokens | Est. cost |
|---|---|---|
| One pass, no mistakes | ~20k output | ~$0.30 |
| Realistic: spec, then ~15-25 iterate/debug turns, context growing to ~50k | ~0.8-1.2M input (less with caching) + ~40-60k output | **~$3-6** |
| Same, with Opus-class pricing | | ~1.7x the above (rough guess) |

Most of the cost is iteration and re-reading context, not writing the 20k tokens.

## Ways to reduce cost

- Write a clear behavior spec up front, so there are fewer debug turns.
- Use a recorded session (see `mcp-and-recording.md`) as a reference for expected behavior.
- Have a model read `content.js` and produce a short spec (input-only, well under $1).
- Use prompt caching for repeated context.
