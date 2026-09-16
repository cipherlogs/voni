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

Pinned at: `command-menu-03` f9b89ceb4979d35209705f8029877b60d6c70bc5,
`onboarding-01` 5377a1ce792a169336c87f99a438a273867b6815, `chat-01`
8f6f90c5b077628d2f4d3e41faa31cb8b608fe0b, `ai-05`
54f6cbfa2c91a4377c980d9b0ac787d6ce5750a0, `sidebar-03` (manually vendored
2026-09-15 from the registry JSON, which records no upstream commit — CLI
install rejected to protect shared primitives).

## Voice portraits (retired 2026-09-15)

The dev-placeholder headshots previously served from
`public/voices/avatars/<voice-id>.webp` (randomuser.me-sourced) and the
voice→portrait mapping table below them are retired: the agent-creation
voice picker now renders deterministic CSS-only motif avatars (`VoiceMotif`
in `src/components/wizard/voice-field.tsx` — hash(voiceId) → oklch
semantic-token gradient + blurred blob pair, no image assets), identical
for every voice. The files are deleted; the section is kept as a record.
