# game_memory.md — Cross-Session Progress Log

Purpose: ultra-brief record of what's done, updated at the end of every work iteration,
so a fresh session can continue without re-reading the whole history.
Keep entries short. Newest entry at the top of the log. Full details live in
IMPLEMENTATION_PLAN.md and per-phase notes.

## Current status

- **Phase**: 1 built — **awaiting user verification/approval** (swim feel, camera, zone scale, atmosphere)
- **Stack**: Three.js 0.185 + TypeScript + Vite 8, no physics engine, HTML-overlay UI, custom kinematic swim + analytic-heightfield collision
- **Git**: repo initialized on `main`, remote = https://github.com/Arjun0014/404-Hz-Borrowed-Bodies
- **Hosting**: wavedash (decided by user; only matters at Phase 19/22)
- **Assets in use**: `assets/clown_fish_compressed.glb` = starter fish (Draco+KTX2, 276 tris, 94 bones, 1 anim clip); `assets/tuna_fish_compressed.glb` reserved for Phase 3+ (6k tris, 47 bones, 2 clips). Licence info still TBD from user (`assets/LICENSES.md`).
- **Run**: `npm run dev` → http://localhost:5173, click to dive. F3 stats, F4 quality.
- **Next action on approval**: Phase 2 — zone lifecycle + one-way descent proof (ZoneManager, RunState, transition, disposal verification, 5× memory test)

## Key files

- `IMPLEMENTATION_PLAN.md` — full Phase 0 plan (architecture, perf budget, all 22 phases, risks, asset plan)
- `GAME_DESIGN.md` / `IMPLEMENTATION_PHASES.md` / `ASSETS.md` — design authority (do not edit without user)
- `PLACEHOLDERS.md`, `ASSET_MANIFEST.md`, `assets/LICENSES.md` — created in Phase 1

## Standing rules (read every session)

- One phase per implementation pass; stop and wait for explicit user approval at each gate.
- Record a performance measurement (fps, frame ms, draw calls, heap, renderer.info) at the end of every phase, here.
- 5× zone-transition memory test whenever zone code changes.
- Every placeholder gets a row in PLACEHOLDERS.md; every external asset gets a row in assets/LICENSES.md.
- Update this file at the end of every iteration.

## Log

- **2026-07-18** — Phase 1 built: Vite+TS+Three scaffold; git init + GitHub remote; asset-report script (`npm run asset-report`); analytic-heightfield Shallow Veil terrain (rolling shelf, edge walls, drop-off pit at +X with soft pit floor until Phase 2); swim controller (scheme A camera-aim steering, drag, banking, dash stub; scheme B behind `STEERING_SCHEME` flag in `src/config.ts`); size-adaptive no-roll third-person camera with terrain collision pull-in; atmosphere (depth-graded FogExp2 + tone-mapped `scene.background` — NOT setClearColor, that mismatches ACES; shader caustics with depth+distance fade; wrap-around particle motes; surface plane + sun glow; instanced rocks/kelp; silhouette cones; pulsing descent marker + proximity hint); clownfish loaded via Draco+KTX2 with auto axis-align/scale + animation playback; debug overlay (F3), quality stub (F4). Headless-verified via browse: no console errors, swimming works, head leads motion, ~90 s zone crossing at cruise. Baseline (headless SwiftShader, GPU fps must come from user): 12-14 draw calls, ~145k tris, 38 MB heap, tick 0.9 ms avg. Known quirks: gstack browse daemon needed ACL repair on `.gstack` dir (icacls inheritance strip bug) — fixed; browse state dir = `<gitroot>/.gstack/`. Waiting: user approval of Phase 1 + fish licence info.
