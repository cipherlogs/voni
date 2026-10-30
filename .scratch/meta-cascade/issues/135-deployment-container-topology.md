# 135: Container host and two-instance topology

**What to build:** The service runs in a container on a host that can hold long-lived WebSockets and rolling deploys, with at least two instances that share only the durable breaker and counter stores.

**Blocked by:** 75 (Call lifecycle and the end message), 04 (Open-value decisions with a stated source)

**Status:** resolved

- [ ] The service runs in a container on a host that holds long-lived WebSockets and rolling deploys.
- [ ] At least two instances run, stateless except the durable breaker and counter stores.
- [ ] One call per socket; there is no sticky-session requirement.
- [ ] A live call stays on its instance until it ends.
- [ ] The host choice is recorded, and a Workers-style runtime is excluded with the reason.

## Answer

# 135 — Container host and two-instance topology

**Status: done.** Branch `cluster/deploy-135` @ `2e306da7`, based on integration tip
`bd9180dc` (`git merge feat/meta-cascade` → "Already up to date").

- **Built:** `voice-pipeline/Dockerfile` (one container from the repo root, one
  uvicorn worker, non-root, pins from new `voice-pipeline/requirements.txt`),
  `deploy/fly.voice-pipeline.toml` (Fly.io, `min_machines_running = 2`, rolling,
  `GET /healthz`, connections concurrency, auto-stop off, SIGTERM +
  `kill_timeout = 30` = `deploy.drain_max_wait_ms`), `deploy/fly.voni.toml` (the
  app: own Fly app, image, port and secret set — separate deploy),
  `deploy/voice-pipeline.env.example` (secret names only), `.dockerignore`,
  `deploy/docker-compose.yml` (two-replica rehearsal), `docs/deploy/README.md`
  (host record; Cloudflare Workers excluded with the reason).
- **Proof:** `deploy/topology.py` names every violation; `voice-pipeline/test_deploy_topology.py`
  (42 tests) fails when `min_machines_running` drops to 1 or `[[http_service.checks]]`
  is removed — both proved red by mutating the real toml, then restored green.
  `python deploy/topology.py` exits 0 on the committed topology.
- **Runtime evidence:** `docker build` succeeded; two containers both returned
  `{"status":"ok","service":"voice-pipeline","protocolVersion":1}` from `/healthz`;
  `docker compose --scale voice-pipeline=2` showed both replicas healthy.
  The build caught one real seam: `cascade.thresholds` cannot import without
  `voni/src/lib/demo/scoreboard-budgets.json`, so the image copies that one file
  and sets `VONI_SCOREBOARD_BUDGETS_JSON` (no app tree in the image).
- **Seams left for 136–141:** token verification, `/readyz` drain state
  (ticket 139), drain supervisor on SIGTERM (ticket 140), version report (141).
  This ticket only sizes `kill_timeout`, records `DATABASE_URL` as the shared
  store choice (Fly Postgres) and keeps the platform probe on liveness. Full
  Python suite: 1732 tests OK (`cd voice-pipeline && .../python -m unittest discover -s . -p 'test_*.py'`).

_Implemented on `feat/meta-cascade`._
