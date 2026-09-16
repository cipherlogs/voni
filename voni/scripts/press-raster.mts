/**
 * Press-kit raster pass 1/2 — geometry-only assets (no text involved).
 *
 * Renders chip + mark-solo SVG masters to exact-size PNGs with sharp.
 * Wordmark PNGs carry the "oni" wordmark in Geist and are produced by
 * scripts/press-wordmark-shots.mts (browser screenshots, real font).
 *
 *   npx tsx scripts/press-raster.mts
 *
 * Re-run any time a master in public/press/*.svg changes.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const PRESS = join(here, "..", "public", "press");
const OUT = join(PRESS, "png");

type Job = { src: string; out: string; width: number; height?: number };

const JOBS: Job[] = [
  // App-icon chips (square masters).
  { src: "voni-chip-light.svg", out: "voni-chip-light-1024.png", width: 1024 },
  { src: "voni-chip-light.svg", out: "voni-chip-light-512.png", width: 512 },
  { src: "voni-chip-dark.svg", out: "voni-chip-dark-1024.png", width: 1024 },
  { src: "voni-chip-dark.svg", out: "voni-chip-dark-512.png", width: 512 },
  // Solo marks (20:11 masters — height follows the aspect).
  { src: "voni-mark-light.svg", out: "voni-mark-light-1024.png", width: 1024 },
  { src: "voni-mark-dark.svg", out: "voni-mark-dark-1024.png", width: 1024 },
  // Square profile avatars — light chip reads on light AND dark feeds.
  { src: "voni-chip-light.svg", out: "avatar-1024.png", width: 1024, height: 1024 },
  { src: "voni-chip-light.svg", out: "avatar-500.png", width: 500, height: 500 },
  { src: "voni-chip-light.svg", out: "avatar-400.png", width: 400, height: 400 },
];

mkdirSync(OUT, { recursive: true });

for (const job of JOBS) {
  const input = join(PRESS, job.src);
  const output = join(OUT, job.out);
  const pipeline = sharp(input).resize(job.width, job.height, {
    fit: job.height ? "fill" : "inside",
  });
  await pipeline.png().toFile(output);
  const meta = await sharp(output).metadata();
  const ok = job.height
    ? meta.width === job.width && meta.height === job.height
    : meta.width === job.width;
  if (!ok) {
    throw new Error(
      `press-raster: ${job.out} is ${meta.width}x${meta.height}, expected ${job.width}${job.height ? `x${job.height}` : "w"}`,
    );
  }
  console.log(`wrote ${job.out} (${meta.width}x${meta.height})`);
}
