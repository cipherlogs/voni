# Third-party notices

## Blocks (MIT)

Vendored block compositions from
[Blocks](https://github.com/ephraimduncan/blocks) ([blocks.so](https://blocks.so/))
are included under `src/components/<block-id>/` (see `DESIGN.md` §3 for the
pinned allow-list).

```
MIT License

Copyright (c) 2025 Ephraim Duncan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

(Source: [LICENSE.md](https://github.com/ephraimduncan/blocks/blob/main/LICENSE.md),
verified against upstream on 2026-09-14.)

## Voice portraits (dev placeholders, randomuser.me)

`public/voices/avatars/<voice-id>.webp` (96px square, served locally — never
hotlinked) are illustrative UI avatars for the agent-creation voice picker,
not the real voice talent. `presents` in `src/lib/agents/voices.ts` is an
inferred UI field, not a documented voice property.

Sourced from [randomuser.me](https://randomuser.me) portraits
([CC-BY / free-use generated portrait set](https://randomuser.me)) for
development only. Replace with a licensed set before production.

Mapping (voice id → portrait):

| Voice | Presents | Portrait |
|---|---|---|
| alba, eve, jane, mary | feminine | women/1, 2, 3, 4 |
| anna, vera, lola, estelle | feminine | women/5, 6, 7, 8 |
| michael, charles, paul | masculine | men/1, 2, 3 |
| giovanni, juergen, rafael | masculine | men/4, 5, 6 |
| george | masculine | men/32 |
| jean | unspecified/Neutral | none — initials tile only, so nothing mis-cues a gender |
