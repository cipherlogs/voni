# click — affiliate click load test

DO Functions project. One package `click`, one function `run`. No deps.

## Deploy

```sh
cd functions/click
doctl serverless deploy . --remote-build
```

## Invoke (remote)

```sh
doctl serverless functions invoke click/run -p target:https://www.glizzitrium.com/BCMPW39K/946KZGB/?creative_id=710986 -p clicks:10
```

With utm_source:

```sh
doctl serverless functions invoke click/run -p target:URL -p clicks:10 -p utm_source:newsletter
```

## Invoke (local invoker)

```sh
node functions/invoke-from-laptop.mjs --target URL --clicks 10
```
