# Load-testing the public `/email` link

`voni.cc/email` answers with a 307 to one of the five `glizzitrium.com` targets,
plus a randomized `utm_source` (see `voni/src/proxy.ts`). Two different things
get called "load testing" here, and they need different tools.

## loader.io cannot see the destination

loader.io follows a redirect **only when the target host is verified in your
loader.io account** — a `loaderio-<token>` file at the host root, or a
`loaderio=<token>` TXT record ([Test Results][results], [Verifying a Target
Host][verify]). `www.glizzitrium.com` is a third-party affiliate tracker, so
there is no way to verify it. A loader.io run therefore reports the 307 as a
success and files the hop under **Redirects → Invalid**, and the tracker never
receives a request.

Decisive check: on a loader.io result, `Redirects / Invalid > 0` with
`Redirects / Valid = 0` is this, not a bug in `/email`.

The chain has a second unverified hop as well: the tracker 302s to
`homesafety.adt.com`, which loader.io would also refuse. That is why
`scripts/loadtest-email.js` stops at the tracker instead of chasing the offer.

## Use the k6 script instead

```bash
k6 run scripts/loadtest-email.js                        # 50 VUs, ~2m
VUS=200 DURATION=3m k6 run scripts/loadtest-email.js
TARGET_URL=http://localhost:3000/email k6 run scripts/loadtest-email.js
docker run --rm -i -v "$PWD:/src" -w /src grafana/k6 run scripts/loadtest-email.js
```

Each iteration is one visitor, in two hops:

1. `GET <TARGET_URL>` with `redirects: 0` — must be a 307 with a `Location` on
   `EXPECT_HOST` (`www.glizzitrium.com` by default) carrying `utm_source`.
2. `GET <Location>` with `redirects: 0` — must be 2xx/3xx **and** set a
   `uniqueClick_*` or `transaction_id` cookie. That cookie is the click id the
   tracker records, so it is the proof the click registered; a bare 200 is not.

The script clears those cookies after every iteration. Without that, each VU
keeps appending ids to its `transaction_id` cookie (the tracker chains one id
per repeat visit) and the request header grows without bound.

Read the result as: `email_click_ok` ≈ `email_edge_ok` ≈ `iterations`, all
`checks` green, and `http_req_failed` at 0. `email_click_ok` short of
`email_edge_ok` means the tracker rejected a hop, not that voni dropped it.

`FOLLOW_DEEPER=1` continues the chain to the offer. Leave it off for click
volume: the tracker has already recorded the click by then, and the extra hops
only add third-party traffic.

## Caveats

- A redirect cannot set `Referer`, the client IP, or a browser fingerprint.
  `utm_source` is the whole of the claimed source.
- Every VU in one run shares the load generator's egress IPs. That is fine for
  validating the redirect and the click registration, but it is not "traffic
  from many providers" to the affiliate network. For source-IP spread, run from
  k6 Cloud or several machines — not from the Worker, which would only add
  datacenter IPs you never sent a human to.

[results]: https://support.loader.io/article/19-test-results
[verify]: https://support.loader.io/article/20-verifying-an-app
