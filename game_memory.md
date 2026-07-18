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

- **2026-07-18 (5)** — God rays fixed properly (0584bff). Previous "camera-relative offset" fix was insufficient: it only tracked camera POSITION, not LOOK direction — standing still + moving mouse swept the fixed-orientation vertical planes across view and drove them edge-on (worst directly below the sun) → flicker. Replaced all 10 ray planes + separate glow sprite with ONE camera-facing Sprite (radial streaks + sun disc baked into a 512² canvas texture), anchored at camera.pos + sunDir*340 (infinitely-distant-sun behavior, no parallax). A Sprite always faces camera → cannot go edge-on or change brightness on orbit; sun translates smoothly across sky as you look around (correct), appearance invariant (fixed). Verified via 3 orbit-angle screenshots. Draw calls 40→~15. LESSON: never use flat billboarded planes for view-angle-sensitive sky effects near camera — use Sprites (auto camera-facing) or screen-space post.

- **2026-07-18 (4)** — Two user-reported bugs fixed (99c9f85): (1) "sunlight moves with mouse" = god-ray planes had fixed world orientations so orbiting changed their face-on brightness → rays now keep a constant camera-relative offset + facing yaw (brightness invariant under orbit; verified with two-yaw screenshot compare). (2) fish upside-down/slanted = `setFromUnitVectors` shortest-arc orientation accumulates roll → SwimController now tracks yaw/pitch scalars and rebuilds the quaternion via Euler YXZ (roll structurally zero; banking stays on modelRoot). LESSON: never orient bodies with setFromUnitVectors when an up-vector matters; never let view-angle-dependent billboards sit at fixed orientations near the camera. Draw calls 38-40 (rays unmerged, 10 draws), tris ~269k. Awaiting user GPU verdict on Phase 1.

- **2026-07-18 (3)** — Richer-world pass (user request): 14 mesas/pinnacles + 3 ridge walls baked into the heightfield (`FORMATIONS` in Terrain.ts — player+camera collision automatic); 34 textured rock spires clustered at formation skirts + 6 monoliths, all registered as cylinder colliders (`zone.colliders`, resolved in SwimController + PlayerCamera march; degenerate d=0 case handled — collider push-out verified via JS test); user's Poly Haven coral_fort_wall_02 1k texture (diff+normal, CC0) on terrain (repeat 110, vertex colors switch to tint-modulation mode when textured) and rocks/spires (cloned texture, separate repeat); coral doubled + 4th type (fan, CircleGeometry arcs) = 365 instances in 28 reef clusters hugging formations; 52 seagrass meadows; camera much closer (4.2×/1.6 m min) + snappier (pos k16/look k20, lookahead 0.07, FOV pump 7→4). Stats: 22 draw calls, 269k tris, 7 textures, 45 MB heap, tick ~1.2 ms. Build clean, zero shader errors on real-GPU path. Awaiting user GPU verdict.

- **2026-07-18 (2)** — Visual overhaul after user rejected first build ("no ground / looks crap"). ROOT CAUSE FOUND: shader variable named `patch` — a GLSL ES 3.0 reserved word — killed the terrain fragment shader on real GPUs → terrain never rendered for the user (lenient headless compile path hid it). Renamed, zero shader errors verified via browse console on the real-GPU path. Overhaul: fog density 0.0092→0.0058 + brighter blue palette; terrain rewrite (dunes + ridged rock lines, sand grain/ripple fragment detail, algae mats, richer vertex colors, 288 segs); dense dressing — 2500 swaying seagrass blades in 42 meadows, 3 coral types (branch/tube/mound via mergeGeometries, instanceColor), smooth boulders + monoliths, thicker kelp; merged-plane god rays following camera (fade with depth); brighter sun/hemi, exposure 1.18; camera closer (5.6×), fish 0.5 m, spawn 3 m above guaranteed reef+meadow. LESSON: instanceColor MULTIPLIES material color — use white base material. Draw calls 20, tris 235 k, heap 45 MB, tick 2.2 ms. Still awaiting user GPU verdict on Phase 1.

- **2026-07-18** — Phase 1 built: Vite+TS+Three scaffold; git init + GitHub remote; asset-report script (`npm run asset-report`); analytic-heightfield Shallow Veil terrain (rolling shelf, edge walls, drop-off pit at +X with soft pit floor until Phase 2); swim controller (scheme A camera-aim steering, drag, banking, dash stub; scheme B behind `STEERING_SCHEME` flag in `src/config.ts`); size-adaptive no-roll third-person camera with terrain collision pull-in; atmosphere (depth-graded FogExp2 + tone-mapped `scene.background` — NOT setClearColor, that mismatches ACES; shader caustics with depth+distance fade; wrap-around particle motes; surface plane + sun glow; instanced rocks/kelp; silhouette cones; pulsing descent marker + proximity hint); clownfish loaded via Draco+KTX2 with auto axis-align/scale + animation playback; debug overlay (F3), quality stub (F4). Headless-verified via browse: no console errors, swimming works, head leads motion, ~90 s zone crossing at cruise. Baseline (headless SwiftShader, GPU fps must come from user): 12-14 draw calls, ~145k tris, 38 MB heap, tick 0.9 ms avg. Known quirks: gstack browse daemon needed ACL repair on `.gstack` dir (icacls inheritance strip bug) — fixed; browse state dir = `<gitroot>/.gstack/`. Waiting: user approval of Phase 1 + fish licence info.
