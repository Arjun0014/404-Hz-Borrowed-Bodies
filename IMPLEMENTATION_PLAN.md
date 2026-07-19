# 404 Hz: Borrowed Bodies — Full Implementation Plan (Phase 0 Deliverable)

Status: **Awaiting user approval before Phase 1.**
Companion docs: `GAME_DESIGN.md` (design authority), `IMPLEMENTATION_PHASES.md` (phase gates), `ASSETS.md` (asset source of truth), `game_memory.md` (cross-session progress log).

---

## 1. Repository Assessment

### What exists
- `GAME_DESIGN.md`, `IMPLEMENTATION_PHASES.md`, `ASSETS.md` — design documents only.
- **No code, no `package.json`, no build setup, no assets, no git repository, no deployment configuration.**

### Reusable systems and assets
- None. Everything will be built from scratch. This is an advantage: no technical debt, no framework conflicts, and the architecture can be designed for the one-zone-at-a-time lifecycle from day one.

### Technical debt / conflicts
- None yet. The main risk is *creating* debt by not enforcing disposal discipline and data-driven creature definitions from the start — both are addressed in the architecture below.

### Assumptions (stated explicitly)
1. **Stack**: Three.js + TypeScript + Vite. Chosen for mature `.glb` loading (GLTFLoader + Draco/meshopt), instanced rendering, skinned animation support, small runtime, and the largest ecosystem for browser 3D. Babylon.js was considered (better built-in scene disposal and inspector) but Three.js wins on bundle size, shader control for water/fog, and available learning resources for future maintenance.
2. **No physics engine.** Underwater movement is custom kinematic steering; collision is sphere-vs-terrain-heightfield plus sphere-vs-primitive colliders for rocks/ruins. A full physics engine (Rapier/Ammo) adds cost and non-determinism we don't need. Revisit only if Phase 1 collision feels bad.
3. **No UI framework.** HUD is an HTML/CSS overlay (crisp text, zero GPU cost, easy iteration). Menus are HTML. Only in-world 3D indicators (stun markers, descent prompt anchor) live in the scene.
4. **Target hardware**: 60 fps on a mid-range discrete GPU or Apple M-series at 1080p; 30 fps floor on recent integrated graphics (Intel Iris Xe class). Desktop-first; gamepad optional; mobile out of scope for v1.
5. **Hosting**: static site (itch.io, Netlify, or similar). Leaderboard therefore starts local (localStorage) behind an interface, with a remote adapter (e.g. Supabase or a Cloudflare Worker + KV) added in Phase 19 once hosting is decided.
6. **Version control**: `git init` at the start of Phase 1, with `.gitignore` for `node_modules`/`dist`. Large binary assets tracked normally at first; move to Git LFS only if the repo grows past ~500 MB.

---

## 2. Recommended Architecture

### 2.1 Top-level game-state structure

A small explicit state machine owns the whole app:

```
Boot → Title → Run(Zone) ⇄ Paused
                 │
                 ├─ DescentTransition → Run(next Zone)
                 ├─ RunFailed (host death / full connection) → Results
                 └─ Victory (final possession) → Results → Title
```

Three clearly separated state scopes:

| Scope | Lives in | Examples | Lifetime |
|---|---|---|---|
| **App state** | `GameApp` | current screen, settings, quality level | whole session |
| **Run state** | `RunState` (plain serializable object) | Dominance, connection, score, host snapshot (species, size, health, growth), discovered species, run stats, active modifiers, RNG seed | one run; survives zone transitions; autosaved at zone entry |
| **Zone state** | `Zone` instance | terrain, entities, spawners, carrier status, active fields | one zone; fully destroyed on descent |

Anything the design lists as persistent (§14 of GAME_DESIGN) lives in `RunState` and nowhere else. Zone code may read `RunState` but the zone owns nothing that must survive.

### 2.2 Zone lifecycle

```
ACTIVE
  └─ player enters descent trigger → DescentPromptShown
       └─ player confirms → DESCENDING
            1. freeze spawners, fade to transition presentation (descent tunnel/darkness)
            2. async-load next zone manifest + assets (during the transition visual)
            3. build next Zone off-screen
            4. swap: activate next zone, place player
            5. dispose previous zone: traverse scene → dispose geometries, materials,
               textures, skeletons; release pools; clear event listeners; null refs
            6. verify with renderer.info (geometries/textures counts) + optional
               performance.memory check; log to console in dev builds
  └─ ACTIVE (next zone)
```

- Next zone loads **only after confirmation** (per design). The transition visual (controlled descent through dark water) is the loading screen, so load time up to ~10 s is invisible.
- Backtracking is structurally impossible: the previous zone object no longer exists.
- Failure handling: if the next zone fails to load, retry once; on second failure show a readable error and offer to end the run with score submitted (never a silent hang).

### 2.3 Creature and host definitions (data-driven)

All species are **data, not code**. One `SpeciesDef` record per species in `src/data/species/`:

```
SpeciesDef {
  id, displayName, class (prey | neutral | predator | minion | carrier | boss)
  model: { asset, lodAssets?, placeholderBuilder }
  movement: { maxSpeed, accel, turnRate, verticalAgility, style (dart|glide|paddle|jet) }
  health: { base, perGrowthStage }
  growth: { minScale, stages[], ceilingScale, benefits, drawbacks }
  combat: { primaryAttack, specialAbility?, stunThreshold, stunWindow }
  possession: { possessable, dominanceClassRequired, connectionSignature,
                freshReduction, riskFactors }
  ai: { tierBehaviours, senses, fleeRules, frenzyProfile }
  animation: { clipMap, proceduralFallback }
  audio: { clipMap }
}
```

- A **host** is not a separate thing: possession simply makes the player controller drive a creature entity whose `SpeciesDef.possession.possessable` is true. This guarantees NPC and player versions of a species can never diverge.
- Balance values live in `src/data/balance.ts` (single tuning surface, hot-reloadable in dev).

### 2.4 Entity model and AI activation tiers

Entity system: lightweight component-ish objects with pooling (not a full ECS — overkill at this entity count, and pooled plain objects profile better in JS).

Three AI tiers, assigned each second by distance + relevance (combat participants are always Tier 2 regardless of distance):

| Tier | Who | Cost | Behaviour |
|---|---|---|---|
| **T0 Ambient** | school fish, distant silhouettes | ~zero per fish | GPU-instanced meshes, flock centres steered on CPU (one steering agent per school, individual fish offset in vertex shader), no collision, no per-fish AI |
| **T1 Simplified** | mid-distance individuals | low | steering + terrain avoidance + flee; no senses, no combat; simplified animation (procedural or single looped clip) |
| **T2 Full** | creatures near player, all combat participants | full | senses, behaviour state machine (idle/patrol/hunt/flee/attack/stunned/frenzy), full animation mixer, collision |

Budgets (see §3): T2 hard-capped; when the cap is hit, farthest non-combat T2 entities demote.

### 2.5 Animation handling

- **T2 skinned creatures**: Three.js `AnimationMixer`, clips blended (idle↔swim↔fast by speed; attack/hit/stun/feed/death as overrides). Missing clips fall back to procedural motion per species (`proceduralFallback`), so placeholders and incomplete assets never block a phase.
- **T0/T1**: no skinning. Vertex-shader sine "swim wiggle" driven by a per-instance phase attribute — hundreds of fish for near-zero CPU.
- Speed-scaled playback so growth (bigger, slower-looking bodies) reads naturally.
- One shared clip-name convention (`idle, swim, dash, attack, ability, hit, stun, feed, death, possess`) documented in `ASSET_MANIFEST.md` so user-supplied `.glb` files drop in without code changes.

### 2.6 Asset loading and replacement workflow

- **Per-zone manifest** (`src/data/zones/<zone>.manifest.ts`): lists models, textures, audio with byte budgets. The loader loads exactly one manifest at a time (+ a small "global" manifest: player-possible hosts, shared FX, UI audio).
- GLTFLoader with meshopt/Draco decode; KTX2 texture compression introduced in Phase 14/21 when real textures arrive.
- **Placeholder registry**: `PLACEHOLDERS.md` — every placeholder gets an ID, what it stands in for, the exact final asset spec, and where it's referenced. Replacing an asset = drop the `.glb` in `public/assets/…`, update one manifest path. Nothing else changes because gameplay reads `SpeciesDef`, never mesh details.
- **Licence tracking**: `assets/LICENSES.md` — source, creator, licence, attribution text, modification/commercial status, per file. Enforced at the Phase 22 audit but maintained from the first external asset.

### 2.7 UI and game-flow organisation

- HTML overlay layers: HUD (health, connection, growth, Dominance rank, target info), prompts (descent confirm, possession window), notifications (score events, rank up), screens (title, pause, results, leaderboard).
- Connection bar is the visual anchor of the HUD (design §19) — biggest element, escalating visual states (calm → interference → critical vignette + audio filter).
- UI reads game state through a small event bus + per-frame snapshot; game code never touches DOM directly.

### 2.8 Scoring and leaderboard boundaries

- `ScoreSystem` accrues events during the run (kills, possessions, carrier kills, depth, risk bonuses) with the same anti-farming diminishing rules as Dominance where relevant. Pure, testable functions.
- `Leaderboard` is an interface: `submit(runResult)`, `top(category)`. Implementation #1: `LocalLeaderboard` (localStorage). Implementation #2 (Phase 19, after hosting decision): remote adapter. Failure to submit remotely must never block the results screen.

### 2.9 Error and recovery

- WebGL context-loss handler: pause, attempt restore, reload zone from `RunState` autosave if restore fails.
- `RunState` autosaved to localStorage at each zone entry → "Resume run from start of <zone>?" after a crash/refresh. (Cheap insurance; also the saveable-run-state test hook.)
- Asset load failures: retry once, then substitute the registered placeholder and log — a missing decoration never kills a run.
- Dev-only on-screen diagnostics: fps, frame ms, draw calls, entity counts per tier, renderer.info memory (toggled with a debug key).

---

## 3. Browser Performance Strategy

### 3.1 Initial performance budget (v1 — revised at each profiling checkpoint)

| Budget | Typical play | Worst case (frenzy / boss) |
|---|---|---|
| Frame time | ≤ 16.6 ms (60 fps) | ≤ 33 ms floor (30 fps) on iGPU |
| Draw calls | ≤ 250 | ≤ 450 |
| Triangles on screen | ≤ 600 k | ≤ 1.1 M |
| Skinned meshes animating | ≤ 12 | ≤ 18 |
| T2 full-AI creatures | ≤ 15 | ≤ 30 (frenzy, with combat simplification) |
| T1 creatures | ≤ 40 | ≤ 40 |
| T0 instanced fish | ≤ 400 | ≤ 400 |
| Particles (quads) | ≤ 4 000 | ≤ 8 000 |
| Texture memory (GPU) | ≤ 350 MB | ≤ 500 MB |
| JS heap | ≤ 600 MB steady | no growth across transitions |
| Per-zone asset download | ≤ 30 MB | ≤ 50 MB (Trench/boss) |
| Initial load to title | ≤ 8 s on 20 Mbps | — |
| Concurrent audio voices | ≤ 16 | ≤ 24 |

Per-asset ceilings: school fish ≤ 800 tris, 1 material, no skeleton; standard creature ≤ 8 k tris, ≤ 40 bones, ≤ 2 materials, 1024² textures; hero (carrier/predator) ≤ 20 k tris, ≤ 60 bones, 2048² textures; final boss ≤ 60 k tris, ≤ 120 bones (modular parts allowed).

### 3.2 Main cost concerns and countermeasures

- **CPU**: AI and animation mixers dominate. Countermeasures: tier system, staggered AI updates (each T2 brain thinks every 3–5 frames on a round-robin), one steering agent per school, spatial hash grid for neighbour/sense queries (no O(n²)).
- **GPU**: transparent overdraw (water particles, ink, fields, bioluminescence) is the biggest underwater risk. Countermeasures: particle counts budgeted, soft-particle-free cheap shaders, fog-as-draw-distance (fog hides the far plane, so far plane stays close: ~120–200 m per zone), no real-time shadows (fake with darkening gradients + caustics), single directional light + emissives.
- **Memory**: zone disposal verified by `renderer.info` counters after every transition; pooled entities/particles/audio so gameplay allocates ~nothing per frame (GC hitches are the classic JS game killer).
- **Network**: per-zone manifests, compressed textures (KTX2) and meshopt from Phase 14 on; audio as OGG.
- **Model/animation**: budgets above, checked at import time by a small asset-report script (Phase 1 deliverable) printing tris/materials/bones/texture sizes for any `.glb`.

### 3.3 Reuse and pooling

Pools for: creature entities (per species), particles, audio sources, damage numbers/FX, projectiles. Population replenishment = respawn from pool at ecological entry points (design §12), never `new`.

### 3.4 Visibility and draw distance

- Exponential fog per zone doubles as atmosphere and draw-distance clamp.
- Frustum culling (built-in) + simple distance culling for decorations.
- Distant "life" beyond the fog = cheap silhouette cards / instanced imposters, not real entities.
- Zones are broad but bounded (~400–600 m across playable); scale illusion from fog, silhouettes, parallax ruin layers — not geometry.

### 3.5 Quality settings and graceful fallback

Three presets (High/Medium/Low) scaling: render resolution (renderer pixel ratio), particle density, T0 fish count, post-processing on/off, texture anisotropy. Auto-drop: if average frame time exceeds budget for 10 s, suggest (or in auto mode apply) the next preset down. Built in Phase 1 as a stub (resolution + particle scale), completed Phase 21.

### 3.6 Profiling checkpoints

Formal measurement recorded in `game_memory.md` at the end of **every** phase: fps (avg/1% low), frame ms, draw calls, heap, renderer.info. Special deep checkpoints:
- Phase 1: empty-world baseline (this is the budget floor).
- Phase 3: population stress (2× intended fish counts).
- Phase 2 & every zone phase: 5× repeated transition memory test (heap and renderer.info must return to baseline ±5%).
- Phase 13: frenzy worst case (30 T2 actors fighting).
- Phase 18: boss arena worst case.
- Phase 21: full matrix across browsers/quality levels.

### 3.7 Frenzy and boss risks (called out early)

Frenzy = most actors + most transparency + most audio at once; the budget's worst-case column is defined by it. Mitigations designed in from Phase 3: frenzy participants use a *simplified combat brain* (pick nearest target, attack, no complex senses), staggered updates, capped participant count with priority to on-screen actors, and blood/FX pooling. Boss = few entities but hero-asset cost + many tendrils/FX; mitigated by modular boss parts animated procedurally (bones only where needed) and an arena with aggressive fog.

---

## 4. Detailed Phase Plan

Phase 0 (this document) omitted. For every phase: objective, dependencies, systems, work breakdown, assets (temp vs user), placeholder strategy, performance notes, testing, acceptance criteria, risks, fallback, files touched.

---

### Phase 1 — Shallow Veil Foundation and Swimming Prototype

- **Objective**: playable third-person fish swimming in a believable open Shallow Veil with stable camera and recorded performance baseline.
- **Dependencies**: none (greenfield). Includes project scaffolding: Vite + TS + Three.js, git init, folder structure, debug overlay, quality stub, asset-report script.
- **Systems**: app shell, game loop, input, player swim controller, adaptive camera, terrain/collision, water rendering (fog, colour, caustic approximation, particles), zone scaffold (single zone), debug diagnostics.
- **Work breakdown**:
  1. Project scaffold + core loop + input (keyboard/mouse; gamepad stub).
  2. Terrain: authored heightfield shelf with drop-off edge; sphere-vs-heightfield + primitive colliders for rocks; world bounds that gently steer the player back.
  3. Swim controller: velocity-based movement with water drag, pitch/yaw steering toward camera direction, dash stub; tuned for "controllable, not weightless".
  4. Camera: third-person follow with distance/FOV/lag parameterised by host size (data-driven from day one), collision-aware (pull-in on terrain), up-vector stabilised (no roll), soft pitch limits.
  5. Environment: water colour + exponential fog, animated caustic light pattern on terrain, suspended particle field around camera, god-ray-ish surface gradient, distant silhouette cards, placeholder rocks/plants, glowing descent marker at the drop-off.
  6. Placeholder starter fish (low-poly procedural fish, shader tail-wiggle) unless user supplies a `.glb` first.
  7. Debug overlay + performance baseline capture; quality stub (pixel-ratio + particle scale).
- **Assets — temp (agent)**: terrain, rocks, plants, particles, caustics, placeholder fish, descent marker, all materials.
- **Assets — user**: starter fish rigged `.glb` (optional this phase — see §6 of the summary); reference images for the visual direction (optional but helpful).
- **Placeholder strategy**: everything visual is replaceable; fish is behind `SpeciesDef.model` so a final `.glb` drops in later.
- **Performance**: baseline scene must hit 60 fps with head-room (≤ 8 ms frame) because everything later is added on top.
- **Testing**: manual swim across zone (90–180 s crossing target), camera torture test (vertical loops, tight turns near terrain), fps capture, window-resize check.
- **Acceptance criteria**: user can swim comfortably; camera never rolls or clips confusingly; zone reads open with visible drop-off; ≥ 60 fps on dev machine with recorded numbers; crossing time within design target.
- **Risks**: movement feel (biggest project risk — see risk register); camera clipping in caves later.
- **Fallback**: if pitch-toward-camera steering feels bad, switch to "auto-level + explicit ascend/descend keys" scheme (both are cheap to A/B behind a flag).
- **Files**: entire initial `src/` tree, `index.html`, `package.json`, `PLACEHOLDERS.md`, `ASSET_MANIFEST.md`, `game_memory.md`.

### Phase 2 — Zone Lifecycle and One-Way Descent Proof

- **Objective**: prove confirm → load → swap → dispose with verified memory reclamation.
- **Dependencies**: Phase 1.
- **Systems**: ZoneManager, asset manifest loader, RunState (introduced now: minimal — host snapshot, score stub), transition presentation, descent prompt UI.
- **Work breakdown**: descent trigger volume + in-world prompt ("no return" warning + recommended Dominance placeholder); transition visual (fade to dark descent with particles); async manifest load; zone swap; full disposal routine + verification logging; RunState carry-over; failure path (retry → readable error); block accidental trigger (must hold/confirm).
- **Assets — temp**: lower-zone blockout (abstract, labelled), prompt UI, transition overlay/particles. **User**: none mandatory; optional descent sound.
- **Placeholder strategy**: lower zone is throwaway blockout — explicitly not the Drowned Garden.
- **Performance**: measure load time, heap before/after, renderer.info before/after; 5× transition loop test.
- **Testing**: scripted: swim → prompt → cancel → prompt → confirm → verify old zone gone (debug command lists live entities/geometries) → repeat 5×.
- **Acceptance criteria**: no accidental descent; state survives; after 5 transitions heap and GPU-resource counts return to ±5% of baseline; control resumes correctly; no way back.
- **Risks**: hidden references defeating disposal (closures, event listeners). **Fallback**: disposal checklist + dev assertion that scans the scene graph for orphans; worst case, a hard `renderer.dispose()`+scene rebuild path.
- **Files**: `src/world/ZoneManager`, `src/core/assets`, `src/state/RunState`, UI prompt components.

### Phase 3 — Ambient Ocean Population

- **Objective**: living ocean without combat; tier system and population budgets proven.
- **Dependencies**: Phases 1–2.
- **Systems**: entity pools, spatial hash, AI tier manager, school flocking (T0), individual steering + avoidance (T1), spawn/despawn at ecological entry points, population governor (target census per species, replenish through entries only), debug population monitor.
- **Work breakdown**: instanced school renderer (per-instance phase/offset attributes); school steering agents; T1 wander/avoid/flee-from-player-proximity; entry/exit points (fog edge, cracks, kelp, ruins); replenishment governor with hysteresis (never spawn in view — check frustum + distance); tier promotion/demotion; census debug HUD.
- **Assets — temp**: primitive fish variants (3–4 silhouettes/scales), spawn markers, debug visuals. **User**: 1–2 low-poly school fish `.glb`, 1 medium neutral fish `.glb` (simple swim loops) — nice-to-have, not blocking.
- **Placeholder strategy**: distinct primitive silhouettes; instancing pipeline built against placeholder meshes works identically with final ones.
- **Performance**: stress test at 2× budget (800 T0 / 80 T1) to find the cliff; confirm budget numbers; measure tier costs separately.
- **Testing**: 10-minute soak (population stays in band, no drift/leak); spawn-visibility test (camera spin while spawning); terrain-collision watch for schools.
- **Acceptance criteria**: no visible pop-in; census stable ±20% over 10 min; T0 fish ≤ 0.02 ms CPU each avg; frame budget still met with full ambient load; schools don't tunnel through terrain.
- **Risks**: flocking through terrain (schools steer as one agent → agent does avoidance, members follow); perf cliff from too many T1. **Fallback**: reduce T1 band, widen T0.
- **Files**: `src/entities/*`, `src/ai/tiers`, `src/ai/steering`, `src/world/spawner`.

### Phase 4 — Host Health, Damage, Feeding, and Death

- **Objective**: first survival loop — attack, kill, eat, heal, die.
- **Dependencies**: Phase 3 (needs prey entities).
- **Systems**: health component, primary-attack (bite: short lunge + hitbox during active frames), damage feedback (flash, knock, particles, sound stub), death state (NPC: float/dissolve → becomes edible morsel; player: run-fail screen), feeding interaction (hold/press near corpse or small live prey → bite loop → health tick), neutral self-defence behaviour, health HUD, restart flow.
- **Work breakdown**: combat maths in pure functions (testable); hit detection = swept sphere during attack active window; prey flee-on-hurt; self-defence for the medium neutral; feeding channel with interrupt rules; run-fail → results stub → restart.
- **Assets — temp**: attack/hit/feed/death effects, blood-cloud particle, temp audio (generated/CC0), health UI. **User**: prey fish death/hit clips if available; bite/impact audio (optional).
- **Placeholder strategy**: procedural lunge + scale-pulse + particles carries combat feel validation without final animation.
- **Performance**: negligible; keep FX pooled.
- **Testing**: kill-and-eat loop 20×; die on purpose; verify neutral creatures don't aggress unprovoked; readability check at speed.
- **Acceptance criteria**: player can reliably target and hit prey; edible state unmistakable; eating restores health at tuned rate; death/restart never corrupts state; combat readable from the third-person camera.
- **Risks**: underwater melee feels floaty. **Fallback**: add soft lock-on assist (slight steering magnetism toward the target during lunge) — planned as a tunable from the start.
- **Files**: `src/systems/combat`, `src/systems/feeding`, `src/systems/health`, HUD.

### Phase 5 — Species Growth and Size Progression

- **Objective**: visible, rewarding within-host growth with a hard species ceiling.
- **Dependencies**: Phase 4.
- **Systems**: biomass tracking, growth stages from `SpeciesDef.growth`, visual scaling (uniform scale + speed/turn/health/damage modifiers per stage), camera adaptation (already parameterised in Phase 1 — now exercised), collision radius scaling, ceiling indication, growth FX, biomass UI.
- **Work breakdown**: growth curve data; stage-up moment (flash + brief invuln + sound); benefit/drawback application (bigger = more health/damage, slower turn, higher future connection signature — hooks now, connection later); camera lerp between size profiles; collision revalidation at all stages (can't enter spaces smaller than body); ceiling UI ("this body has reached its limit").
- **Assets — temp**: growth flash, biomass bar, debug stage display. **User**: starter fish that scales acceptably (or stage-variant meshes if scaling looks bad — decision point per ASSETS.md; recommendation: plain scaling for v1, it's underwater and reads fine).
- **Placeholder strategy**: uniform scaling; the `growth` data supports staged meshes later without code change.
- **Performance**: none significant.
- **Testing**: grow starter to ceiling; camera stability at each stage; squeeze tests in terrain gaps; regression on Phase 4 loop at max size.
- **Acceptance criteria**: three visible stages for the starter; camera comfortable at all sizes; ceiling communicated and enforced; growth changes at least speed/health/damage measurably.
- **Risks**: scaled fish looks wrong (mitigate with proportion-aware scaling: slightly less scale on Y/Z than X if needed); camera-in-terrain at large sizes (collision pull-in from Phase 1 covers it).
- **Fallback**: staged model swap if scaling fails visually.
- **Files**: `src/systems/growth`, `src/data/species`, camera params.

### Phase 6 — Dominance Progression

- **Objective**: persistent run-level rank with anti-farming built in.
- **Dependencies**: Phases 4–5.
- **Systems**: Dominance ranks (Drifter→Hunter→Predator→Abyssal→Usurper), contribution table by creature class, diminishing-returns ledger (per-species kill counter with decay of value; weak prey hard-capped per rank), first-time species bonuses (kill and, later, possession), rank-up presentation, HUD rank chip.
- **Work breakdown**: pure `DominanceSystem` with data-driven contribution matrix; RunState integration; UI notifications ("this prey no longer advances you"); debug panel showing contribution ledger.
- **Assets — temp**: rank icons (simple), rank-up flash + tone. **User**: none required.
- **Placeholder strategy**: text + geometric icons.
- **Performance**: none.
- **Testing**: unit tests on contribution maths (farming 100 tiny fish must not reach Hunter cap); play-test rank-up pacing in Shallow Veil.
- **Acceptance criteria**: tiny-fish farming provably capped; player can read why progress stopped; Hunter reachable in Shallow Veil through intended play; data supports later possession gating.
- **Risks**: opaque progression frustration. **Fallback**: explicit "what advances me now" hint line in the rank UI.
- **Files**: `src/systems/dominance`, `src/data/balance`.

### Phase 7 — Stun and Guaranteed Possession

- **Objective**: the core mechanic — weaken → stun → enter → play as the new body.
- **Dependencies**: Phases 4–6.
- **Systems**: stun eligibility (health below threshold → visual telegraph), stun action (directed dash impact), stunned state + countdown window, possession input (approach + press during window → guaranteed), **player-controller transfer** (detach from old creature entity, attach to new; camera morphs between size profiles; HUD re-binds), old-host release (NPC brain resumes if alive, tagged `recentlyPossessed` with contamination timer), Dominance persistence, second possessable species introduced (medium neutral upgraded to possessable).
- **Work breakdown**: this is where the "player = controller on a creature entity" architecture pays off — transfer is a pointer swap + camera/HUD transition, not a state copy. Stun telegraphs (wobble, stars/signal sparks, timer ring); possession transition FX (brief psychic-line + fade); anti-corruption checks (old host can't be double-possessed mid-transfer, dying mid-window cancels safely).
- **Assets — temp**: stun FX, targeting indicator, possession transition, contamination marker. **User**: **second possessable creature rigged `.glb`** (swim/attack/hit/stun/death) — first genuinely wanted user asset; psychic/stun textures optional.
- **Placeholder strategy**: distinct primitive creature with procedural motion is fully acceptable for mechanic approval.
- **Performance**: none significant.
- **Testing**: possess/abandon loop 20× incl. adversarial cases (stun expires mid-approach, target dies during window, possess while damaged); camera-transfer comfort at different size pairs; state-integrity assertions in dev build.
- **Acceptance criteria**: player can deliberately weaken without killing (damage numbers/thresholds tuned to allow it); stun window readable; possession never fails during valid window; no duplication/orphan bugs across 20 swaps; both hosts feel distinct.
- **Risks**: highest-complexity system state-wise; camera transfer disorientation. **Fallback**: slow-motion beat during transfer to mask any camera snap; strict single-owner assertion on the player controller.
- **Files**: `src/systems/possession`, `src/player/controller`, `src/render/camera`.

### Phase 8 — Risk Possession and Host Compatibility

- **Objective**: dangerous instant-possession alternative with readable odds.
- **Dependencies**: Phase 7.
- **Systems**: compatibility estimate (target class vs Dominance, target health %, contamination, situational modifiers) shown as a banded indicator (e.g. Hostile/Risky/Even/Favoured — bands, not fake-precise percentages), attempt resolution, failure consequences (connection spike placeholder until Phase 9 + brief vulnerability + target alerted/enraged), anti-exploit (cooldown after failure per target; repeated attempts on same target get worse).
- **Work breakdown**: pure resolution function + seeded RNG (run seed → replayable, testable); pre-attempt UI on target; failure presentation.
- **Assets — temp**: compatibility display, failure FX/audio. **User**: none required.
- **Placeholder strategy**: text/symbol bands.
- **Performance**: none.
- **Testing**: unit tests over resolution matrix; play-test that guaranteed path remains clearly the reliable one.
- **Acceptance criteria**: bands communicated before attempt; failure consequence understood on first experience; guaranteed possession still dominant strategy under normal play; no reroll-spam exploit.
- **Risks**: feels like hidden randomness. **Fallback**: shift bands toward more deterministic thresholds (top band = guaranteed, bottom band = impossible).
- **Files**: `src/systems/possession` (extension), UI.

### Phase 9 — Connection System and Fresh-Host Pressure

- **Objective**: the central thematic pressure — rising connection, fresh-host relief, full-connection death.
- **Dependencies**: Phases 7–8.
- **Systems**: continuous rise (base rate × host connectionSignature × zone multiplier), fresh-host reduction (large for never-possessed species instance, small for contaminated), contamination timers (recently-abandoned hosts give ~nothing until decayed), ping-pong prevention (per-pair swap ledger with decaying benefit), full-connection failure sequence, escalating AV feedback (3 stages: ambient interference → distortion + whispers → critical vignette + audio filter + entity voice), debug sliders.
- **Work breakdown**: connection maths pure + unit-tested (especially ping-pong); HUD prominence pass (connection is the biggest bar); failure sequence (entity takes the body — camera drifts away from host, run ends); balance hooks per host.
- **Assets — temp**: connection bar states, distortion post effect (cheap vignette/noise, budgeted), placeholder entity voice (processed TTS/synth). **User**: low-frequency ambience, connection pulse audio, entity voice source (optional now, wanted by Phase 20).
- **Placeholder strategy**: UI pulse + audio filter carries the feeling before final textures/voice.
- **Performance**: post effect must be a single cheap fullscreen pass; measure.
- **Testing**: unit tests (rise rates, reductions, contamination, ping-pong); soak test that intended play in Shallow Veil keeps connection survivable but pressing; deliberate ping-pong exploit attempt must fail.
- **Acceptance criteria**: connection forces ≥ 1 host change per zone under normal play; two-body swapping yields rapidly diminishing relief; failure state clear and fair; readability preserved at high connection.
- **Risks**: tuning (too oppressive vs ignorable). **Fallback**: all rates in one balance table + debug sliders → live tuning during the approval session.
- **Files**: `src/systems/connection`, post-processing, HUD.

### Phase 10 — First Complete Host Roster

- **Objective**: 4–5 mechanically distinct hosts proving the strategic body-swap layer.
- **Dependencies**: Phases 5, 7, 9.
- **Systems**: Dartfish (starter, refined), Shellback (defence stance, high HP, slow), Inkfin (ink cloud escape, fragile, lateral agility), Razorfang (charge + bite, high signature, hard to stun), Abyssal Ray data-stub (glide + pulse — full version in Phase 17); per-host camera profiles; one special ability each; growth tables; possession requirements (Dominance class gating); discovery/roster UI.
- **Work breakdown**: ability framework (cooldown + effect: ink = sensory blind volume; shell = frontal damage reduction stance; charge = burst + knockback/stun-assist); per-host movement tuning (style presets from §2.3: dart/paddle/jet/glide); balance pass on tradeoffs (Razorfang power vs connection cost per design).
- **Assets — temp**: proxies for all missing hosts, ability FX, roster UI. **User**: **the big creature request** — rigged `.glb` for Shellback, Inkfin, Razorfang (clips per ASSETS.md Phase 10 list), ink/charge textures, per-host audio. Mechanics approve on proxies; art lands when available.
- **Placeholder strategy**: distinct silhouettes/colours per host; ability FX are agent-made regardless.
- **Performance**: 4 skinned hosts + abilities in scene — still trivial vs budget; ink transparency measured.
- **Testing**: per-host feel session; matrix test (each host × possess/grow/fight/flee); "no universally best host" balance check via timed challenges.
- **Acceptance criteria**: each host changes movement + combat decisions measurably; every host reachable via intended Dominance path; camera comfortable across the full size range (Dartfish↔Razorfang ≈ 10×); ability readability.
- **Risks**: scope (4 movement models). **Fallback**: ship phase with 3 hosts (starter/defensive/predator), Inkfin follows in 14.
- **Files**: `src/data/species/*`, `src/systems/abilities`, camera profiles.

### Phase 15b — Cthulhu Minions and Connection Attacks (moved from Phase 11)

> **Reordered.** Minions are a deeper-stage pressure and now run after the Drowned
> Garden (Phase 15), not inside the Shallow Veil. Phases 12–14 shipped with the
> Carrier's aura enraging **wild predators** as the garrison; that aura hook
> (`SignalCarrier.auraAggro` → `EcoContext.carrier*`) is the seam minions plug into.

- **Objective**: enemies that attack the connection, not just health.
- **Dependencies**: Phase 15.
- **Systems**: minion type A (melee "lamprey" — latches/hits → connection spike + minor damage), optional type B (ranged "tether drone" — beam that ticks connection while line-of-sight held), signal visual identity (emissive nerve/eye material — readable at distance, colour-blind safe), patrol/pursuit behaviour keyed to player connection level (higher connection → more attention), basic group coordination (share target, loose surround), spawn discipline (from cracks/deep edge, budgeted count).
- **Work breakdown**: connection-damage channel in combat maths; minion AI profiles on the T2 framework; escalation curve (minion pressure grows with connection & time-in-zone — this is also the §15 anti-camping mechanism, wired here); telegraphs for connection attacks (must read differently from health damage).
- **Assets — temp**: minion = altered neutral with strong emissive + FX. **User**: one minion rigged `.glb` (patrol/chase/attack/hit/stun/death), tether/projectile textures, minion audio (optional for mechanic approval).
- **Placeholder strategy**: emissive-marked proxy is explicitly sanctioned by ASSETS.md.
- **Performance**: minions are T2 — count within the T2 budget; tether beam = one cheap shader line.
- **Testing**: readability test (players identify minion vs predator instantly); pressure test at each connection stage; crowd fairness (max simultaneous attackers rule — e.g. only 2 may attack at once, rest posture).
- **Acceptance criteria**: minion attacks visibly move the connection bar; minions distinct at a glance; no unfair mobbing; performance stable with max minions + ambient load.
- **Risks**: connection damage feels like "just another bar". **Fallback**: strengthen AV distinction (screen-edge signal crawl on connection hits, unique sound).
- **Files**: `src/ai/profiles/minion`, `src/systems/combat` (connection channel).

### Phase 12 — Signal Carrier Encounter

- **Objective**: the zone's protected high-health objective.
- **Dependencies**: Phase 10. (Minions moved to 15b — the garrison is **wild predators
  enraged by the Carrier's aura** instead: same tactical shape, no new entity class.)
- **Systems**: Carrier entity (large, semi-stationary, pulsing beacon audible/visible through fog), staged damage states, predator garrison (aura-enraged wild predators hold station around it), Carrier local influence (aura: nearby minions buffed / player connection ticks faster near it — makes approach a decision), death event → hands off to Phase 13 field, encounter director (controls reinforcement waves within entity budget).
- **Work breakdown**: Carrier `SpeciesDef` (class carrier, non-possessable); beacon (pulse light + sonar-ring FX + spatialised audio); damage-stage material/FX changes so progress reads without staring at a bar; garrison AI hooks; performance test with full encounter + ambient.
- **Assets — temp**: Carrier blockout (large organic proxy w/ pulsing emissive), pulse FX, beacon audio. **User**: Carrier `.glb` (jellyfish/organ/relay design, idle pulse + damage states if possible), emissive textures, beacon/damage/death audio.
- **Placeholder strategy**: big pulsing proxy — importance reads through scale/light/sound, per ASSETS.md.
- **Performance**: encounter = worst normal-play load pre-frenzy; measure and record.
- **Testing**: locate-from-distance test (new player finds Carrier by sense alone); fight with each host; tedium check (high HP but staged progress); flee-and-return behaviour.
- **Acceptance criteria**: detectable from ≥ half the zone away; kill requires engaging defenders or clever play, not just tanking; damage stages readable; frame budget held during full encounter.
- **Risks**: HP-sponge boredom. **Fallback**: weak-point nodes (destroying them chunks Carrier HP) — design-compatible and adds skill.
- **Files**: `src/entities/carrier`, `src/ai/director`.

### Phase 13 — Dead Signal Field and Frenzy Zone

- **Objective**: Carrier death → temporary connection-recovery field + ecosystem frenzy.
- **Dependencies**: Phase 12.
- **Systems**: field volume (visible boundary, shrinks/collapses over ~60–120 s), inside effects (connection drain, possession made cheaper/safer, disconnected-minion confusion), frenzy director: attracts local creatures (uses Phase 3 entry points to pull actors in), sets everyone to frenzy profile (simplified aggression brain: nearest-target attack, friend/foe ignored), natural weakening → possession opportunities, anti-farm safeguards (field yields decay; creatures killed in-field give reduced Dominance after first few; field cannot be re-triggered — one Carrier per zone per run).
- **Work breakdown**: frenzy brain (deliberately cheaper than normal T2 — this is the perf trick: more actors, simpler heads); participant cap + priority (on-screen first); blood/FX pooling hardening; collapse presentation; stress test harness (spawn max frenzy on command).
- **Assets — temp**: field boundary shader (cheap fresnel sphere), dead-signal particles, shockwave, frenzy audio layer stub. **User**: noise/distortion textures, frenzy audio layer, field ambience (optional).
- **Placeholder strategy**: sphere + particles + UI per ASSETS.md.
- **Performance**: **the** stress checkpoint: 30 T2-frenzy actors + FX + ambient must hold the 33 ms worst-case floor; record numbers; tune caps.
- **Testing**: scripted max-frenzy stress; risk-reward playtest (staying is tempting and dangerous); exploit attempts (camping the field, re-farming).
- **Acceptance criteria**: connection visibly drains inside; frenzy chaotic but readable; creatures demonstrably fight each other; ≥ 1 natural possession opportunity per frenzy on average; caps hold performance floor; field ends decisively.
- **Risks**: biggest performance risk in the game (see register). **Fallback**: reduce participant cap, swap distant frenzy actors to T1 "fake fighting" (paired tumble animations without real combat resolution).
- **Files**: `src/systems/field`, `src/ai/profiles/frenzy`, stress harness.

### Phase 14 — Shallow Veil Complete Gameplay Pass (Vertical Slice)

- **Objective**: everything approved so far, integrated, balanced, onboarded, scored — the fun test.
- **Dependencies**: Phases 1–13 all approved.
- **Systems**: encounter placement/balancing, in-play onboarding (contextual prompts, no tutorial walls), first scoring pass (events + run summary stub), first audio pass (ambience + combat + possession set), placeholder audit + replacement of critical silhouettes where assets exist, bug-fix/consistency sweep, full profiling under realistic play.
- **Work breakdown**: layout pass (prey fields, neutral zones, minion patrol ring, Carrier placement, descent framing); pacing target: 4–7 min zone time per design; onboarding beats mapped to the core-loop sequence; scoring events wired (kills, possessions, carrier, risk bonuses); KTX2/meshopt pipeline introduced as real textures arrive.
- **Assets — user (this is the art-priority phase)**: final Shallow Veil environment set (rocks/coral/plants/seabed textures), polished starter + early hosts, first Carrier/minion finals where available, shallow ambience + combat/possession audio set.
- **Placeholder strategy**: decorative placeholders may remain; critical silhouettes (hosts, minion, Carrier) should be final before calling the slice art-complete.
- **Performance**: full-zone realistic profiling incl. Carrier frenzy; this becomes the reference profile for all later zones.
- **Testing**: **the core success test**: swim→hunt→eat→grow→weaken→stun→possess→manage connection→kill Carrier→survive frenzy→descend, run by the user cold; farming/swap exploit attempts; full regression of Phases 4–13.
- **Acceptance criteria**: the loop is fun (user judgement — the gate that authorises deeper zones); new player understands systems without reading; zone not trivialisable; stable frame budget throughout; descent feels earned.
- **Risks**: "not fun yet". **Fallback**: pause deeper-zone production, iterate here (explicitly per IMPLEMENTATION_PHASES §4).
- **Files**: broad tuning + content, `src/data/zones/shallowVeil`.

### Phase 15 — Drowned Garden Production

- **Objective**: second full zone — denser, darker, medium hosts, tactical terrain.
- **Dependencies**: Phase 14 approved (hard gate).
- **Systems**: zone content pipeline proven reusable (this phase validates that a new zone = data + assets, minimal new code); kelp forests (instanced), caves/cracks as tactical spaces (small-host advantage), denser particles, new population mix, stronger minion pressure, zone Carrier variant, medium host (e.g. Inkfin full role or new medium predator), transition from Shallow Veil validated end-to-end.
- **Work breakdown**: blockout → population/encounter data → lighting/fog identity (darker green-blue) → cave collision + camera-in-cave handling (tightened camera profile) → Carrier placement → transition + disposal verification → profiling.
- **Assets — temp**: full blockout set. **User**: kelp/garden pack, ruin fragments, cave rocks, darker seabed textures, medium host `.glb` + clips, denser ambience.
- **Placeholder strategy**: modular blocks + plant cards until pack arrives.
- **Performance**: kelp transparency + density is this zone's risk — instanced, alpha-cutout (not blend) kelp; re-run transition memory test Shallow→Garden 5×.
- **Testing**: zone-distinctness check, darkness-readability check, cave camera torture test, full-run regression (Shallow→Garden).
- **Acceptance criteria**: visually distinct; combat readable in darker water; caves change tactics; no memory retention from Shallow Veil; frame budget held.
- **Risks**: camera in confined spaces. **Fallback**: cave-specific camera (closer, damped) + design caves generously sized.
- **Files**: `src/data/zones/drownedGarden`, cave camera profile.

### Phase 16 — Fallen Kingdom Production

- **Objective**: monumental-scale ruins zone + apex predator gameplay.
- **Dependencies**: Phase 15.
- **Systems**: monumental architecture (few, huge, low-detail-high-silhouette meshes + distant silhouette layers), Razorfang-class predator as centrepiece host (high power, high connection cost, low agility), high-health predator NPCs, stronger Dominance requirements (Predator rank content), deeper Carrier encounter, scale FX (god-scale fog gradients, distant groan audio).
- **Work breakdown**: scale illusion pass (architecture 3–5× creature scale, fog-layered depth planes); predator balance (power vs signature per design); open-water arena fights; profiling with large structures (they're cheap — few draw calls — verify).
- **Assets — temp**: giant column/statue blockouts, predator proxy. **User**: columns/statues/arches `.glb`, stone/algae textures, final shark-like predator `.glb` + full clip set, debris FX textures, deep ambience.
- **Placeholder strategy**: oversized primitives sell scale surprisingly well with fog; fine for mechanics approval.
- **Performance**: watch overdraw from big surfaces near camera; texture memory on 2048² stone sets.
- **Testing**: scale-feel check (creatures read small against ruins), large-host camera/control validation, full-run regression to this depth.
- **Acceptance criteria**: monumental feel without geometry blowout (≤ budget tris); predator host controllable + readable; balanced by connection/manoeuvre costs; browser performance held.
- **Risks**: scale disappoints. **Fallback**: double down on fog silhouettes + audio scale cues (cheapest scale amplifiers).
- **Files**: `src/data/zones/fallenKingdom`.

### Phase 17 — Dreaming Trench Production

- **Objective**: final zone — bioluminescent, hostile, boss-adjacent.
- **Dependencies**: Phase 16.
- **Systems**: low-light readability model (dark ≠ unreadable: bioluminescent landmarks, emissive creatures, player-adjacent glow), Abyssal Ray full host (glide + electric pulse — group/minion counter), max minion density (within strict caps — pressure via smarter placement, not raw count), limited connection recovery (few/no Carriers; scarce mini-fields), final Dominance content (Abyssal→Usurper), approach sequence (entity presence: silhouette, voice, environment reacting), handoff into boss arena.
- **Work breakdown**: emissive-driven lighting pass; ray movement model (banking glide — most novel movement, budget iteration time); pressure tuning (this zone should feel like enemy territory); approach scripting (light environmental storytelling, no cutscenes).
- **Assets — temp**: trench blockout, organic structure proxies, biolum landmarks, Cthulhu silhouette (billboard/low-poly + fog), abyssal proxies. **User**: trench/organic `.glb` sets, emissive textures, Abyssal Ray `.glb` + clips, abyssal creatures, minion variants, deep signal ambience + entity voice layers.
- **Placeholder strategy**: emissive simple shapes are genre-appropriate here — placeholders look almost intentional.
- **Performance**: emissive + bloom cost (if bloom used, single cheap pass, quality-gated); minion density vs T2 cap.
- **Testing**: readability-in-dark test (can a new player fight?); pressure fairness; approach-sequence clarity ("I understand the final attempt is next"); full-run regression.
- **Acceptance criteria**: threatening but readable; late pressure difficult-fair; Usurper reachable; performance stable at the game's most demanding normal play.
- **Risks**: darkness vs readability (register). **Fallback**: raise ambient floor + strengthen silhouette rim-lighting; readability wins over atmosphere per design pillar 2.5.
- **Files**: `src/data/zones/dreamingTrench`, ray movement.

### Phase 18 — Final Entity Encounter and Possession

- **Objective**: the boss fight where connection flips from threat to requirement.
- **Dependencies**: Phase 17.
- **Systems**: boss entity (modular: body + tendril parts + vulnerable signal nodes, staged), encounter stages (1: survive + destroy nodes under minion/environment pressure; 2: weakened states open possession-readiness; 3: deliberately ride connection up into a narrow window and possess), the connection-window mechanic (possess only within e.g. 85–95%: too early = fail/punish, hit 100% = entity takes you = run ends — same rules as always, now inverted in the player's favour), failure/victory sequences, scoring integration, arena (bounded, fog-walled, performance-tested).
- **Work breakdown**: boss = composition of existing systems (health/stun/possession/connection) + an encounter-stage director — explicitly not a minigame (per verification focus); tendril attacks as procedural animated parts (bones only where needed); node destruction reuses weak-point tech if adopted in Phase 12; window UI (the connection bar itself becomes the aiming instrument — thematic payoff); victory: possession stream → camera pulls back → player is the entity → results.
- **Assets — temp**: modular boss blockout + animated tendril proxies, node placeholders, window FX, victory/failure placeholders. **User**: hero boss `.glb` (modular parts, idle/attack/weakened/stun states where possible), node assets, neural/emissive texture set, entity voice, boss + possession + victory audio, final music.
- **Placeholder strategy**: primitive-modular silhouette + tendrils sanctioned by ASSETS.md until mechanically approved.
- **Performance**: hero budget (≤ 60 k tris, ≤ 120 bones); arena profiled as second stress checkpoint; minion waves within T2 caps.
- **Testing**: full encounter with each viable late host; fail every way (too early, 100%, death) — each must be understandable; victory clarity; performance during max boss + minions + FX.
- **Acceptance criteria**: victory needs preparation + combat + connection control; uses existing mechanics only; both failure modes teach; possession finale visually unmistakable; frame floor held.
- **Risks**: highest content complexity (register). **Fallback**: reduce to 2 stages; fewer node types; static body + animated tendrils only.
- **Files**: `src/entities/boss`, `src/ai/director` (boss stages), arena zone data.

### Phase 19 — Scoring, Run Results, and Leaderboard

- **Objective**: replay/competition layer.
- **Dependencies**: Phase 18 (scoring events exist since 14; this completes them).
- **Systems**: full score model (depth, time, biomass, Dominance, unique species possessed, difficult possessions, streaks, Carriers, high-connection survival time, frenzy risk bonuses, boss damage, completion + speed) with anti-farming (diminishing per-species, risk-weighted); run summary screen (stats + score breakdown → "one more run" energy); leaderboard: `LocalLeaderboard` complete + remote adapter per hosting decision (see Open Decisions), submit on success and failure; categories v1: all-time score, fastest completion, deepest failed run; seeded daily as stretch (run RNG is already seeded from Phase 8).
- **Work breakdown**: score maths pure + unit-tested; results screen; leaderboard UI; remote adapter + basic abuse resistance (server-side sanity bounds, rate limiting — honesty-box tier, documented as such); privacy: player-chosen handle only, no accounts.
- **Assets — temp**: HUD score events, results/leaderboard screens, badges. **User**: optional polish art + UI audio.
- **Performance**: none.
- **Testing**: unit tests on score model incl. anti-farm; submission failure paths (offline → queued/skipped gracefully); cross-run persistence.
- **Acceptance criteria**: varied skilful play out-scores farming in test runs; submission reliable; results screen readable in <10 s; leaderboard functional on the chosen platform.
- **Risks**: leaderboard integrity (register — accepted as low-stakes for v1). **Fallback**: local-only leaderboard ships; remote follows post-release.
- **Files**: `src/systems/score`, `src/net/leaderboard`, screens.

### Phase 20 — Audio, Narrative, and Presentation Pass

- **Objective**: cohesive identity — opening, soundscapes, voice, menus.
- **Dependencies**: Phase 19 (all systems final).
- **Systems**: opening sequence ("Who dares enter my domain?" → connection begins → control), per-zone ambience beds + adaptive layers (combat proximity, connection level drives filter/whispers), full SFX set wiring (attack/feed/stun/possess/carrier/frenzy/UI), entity voice moments (descents, carrier deaths, high connection, boss), title/menu/pause/results presentation, subtitle system, consistent **404 Hz: Borrowed Bodies** branding.
- **Work breakdown**: audio manager finalised (pooled voices, ducking, zone crossfades); narrative lines kept minimal per design §18; menu flow polish.
- **Assets — user (primary)**: logo/title art, menu scene, final voice recordings or approved processing chain, music/ambience masters, complete SFX set, licensed UI font.
- **Placeholder strategy**: text title, system fonts, synth voice remain acceptable until finals arrive; phase can be approved on wiring + temp audio direction.
- **Performance**: audio memory + decode budget checked; total build size review.
- **Testing**: mix session at each connection stage; audio-clarity-in-combat check; opening lands in <30 s to control.
- **Acceptance criteria**: audio clarifies play; narrative brief + atmospheric; presentation supports fast re-runs; consistent title.
- **Files**: `src/core/audio`, screens, `assets/audio`.

### Phase 21 — Optimisation, Compatibility, and Quality Settings

- **Objective**: reliable play across browsers/devices; quality system complete.
- **Dependencies**: Phase 20 (content-complete).
- **Systems**: full profiling matrix (Chrome/Firefox/Safari/Edge × High/Med/Low × discrete/integrated GPU), quality settings completed (resolution scale, particles, T0 counts, post fx, texture aniso, audio voices), measured-bottleneck asset optimisation only (per ASSETS.md decision point), long-session soak (full run ×3 back-to-back: heap flat), input/window testing (resize, tab-suspend/resume, gamepad, remapping check), failure recovery validation (context loss, load errors), loading validation on throttled network.
- **Work breakdown**: profile → rank bottlenecks → fix top items → re-profile (loop); auto-quality-drop finalised; compat shims (Safari audio unlock, etc.).
- **Assets**: reduced variants only where profiling demands (lower-poly hero LODs, texture downscales, compressed audio).
- **Testing**: the full §7 test matrix, executed and recorded.
- **Acceptance criteria**: every zone disposes cleanly across a triple full run; frenzy + boss within worst-case floor on min-spec; Low preset readable; no browser-specific blockers; documented perf report.
- **Risks**: Safari WebGL quirks. **Fallback**: Safari-specific reduced preset; worst case document Safari as degraded-support for v1.
- **Files**: broad; `docs/PERF_REPORT.md`.

### Phase 22 — Final Balance, Bug Fixing, and Release Candidate

- **Objective**: shippable build.
- **Dependencies**: Phase 21.
- **Work breakdown**: full-run balance passes (difficulty curve, connection pressure, growth/Dominance pacing, possession tuning, encounter pacing, score balance); complete-run test protocol (multiple testers/runs, cold-start onboarding check); placeholder audit vs `PLACEHOLDERS.md` (nothing critical remains unintentionally); licence audit vs `LICENSES.md` + credits screen; accessibility/readability review (colour-blind-safe signals, subtitle sizes, camera comfort options, remapping); release build (minified, compressed, asset manifest, size report); deployment checklist for chosen platform.
- **Assets — user**: final replacements for any release-blocking placeholders, store/jam page images, thumbnail, screenshots, credits info.
- **Acceptance criteria**: full game start→victory/failure with no release-blocking defects; first zone teaches; later zones deepen; victory difficult-but-attainable; build matches approved design; licence-clean.
- **Risks**: balance whack-a-mole. **Fallback**: freeze all systems, tune only data tables in final week.

---

## 5. Asset Plan

### Present today
Nothing. Zero assets in the repository.

### Missing per phase
Fully enumerated inside each phase above (temp vs user columns), cross-referenced against ASSETS.md. Summary of **user-provided** criticality:

| Priority | Asset | Needed by | Blocking? |
|---|---|---|---|
| 1 | Starter fish rigged `.glb` | Phase 1 (art) / Phase 14 (hard) | No — placeholder OK |
| 2 | 1–2 school fish + 1 medium neutral `.glb` | Phase 3 | No |
| 3 | Second possessable creature `.glb` | Phase 7 | No |
| 4 | Shellback / Inkfin / Razorfang `.glb` + clips | Phase 10 | No (proxies OK) |
| 5 | Minion `.glb`, Carrier `.glb` | Phases 11–12 | No |
| 6 | Shallow Veil environment pack + audio set | **Phase 14 (art-complete gate)** | Partially — critical silhouettes only |
| 7 | Drowned Garden pack + medium host | Phase 15 | No |
| 8 | Fallen Kingdom ruins + shark predator | Phase 16 | No |
| 9 | Trench organics + Abyssal Ray | Phase 17 | No |
| 10 | Boss `.glb` (hero), voice, final music/SFX/logo | Phases 18/20 | Boss: no (modular proxy); voice/music: Phase 20 |

Per ASSETS.md §3, **only the next approved phase's assets are ever requested** — the Phase 1 request is in the summary section of this plan. Every user `.glb` is vetted on import by the asset-report script against §3.1 per-asset ceilings (tris, materials, bones, texture sizes, transparency, expected instance count).

### Placeholder tracking
`PLACEHOLDERS.md`: ID, description, referencing manifest(s), final-asset spec (format, clips, budget), status (active/replaced). Updated every phase; audited in Phases 14 and 22.

### Licence & attribution
`assets/LICENSES.md`: per external file — source URL, creator, licence type, attribution text, modification permission, commercial status. No asset enters the repo without a row. Credits screen generated from it in Phase 22.

---

## 6. Gameplay-System Interaction Plan

The systems form one economy; the key interlocks:

- **Health ↔ Feeding ↔ Growth**: eating is the only heal and the only biomass source, so hunger for safety and hunger for power are the same action — feeding events also emit "ecological attention" (scavengers/predators/minions drawn to repeated feeding, per design §15), so healing is never free.
- **Growth ↔ Ceilings ↔ Possession**: growth improves the current body but every curve flattens at the species ceiling; the only way past a ceiling is a new body — possession is kept structurally superior to levelling.
- **Dominance ↔ Possession ↔ Anti-farming**: Dominance gates which classes are possessable at all; its contribution ledger (diminishing per-species, class-tiered) means the *only* path to Predator/Abyssal ranks is engaging dangerous targets — and possessing them pays more than killing them, pushing players into the stun pipeline rather than kill-farming.
- **Stun possession ↔ Combat intent**: combat maths must support "weaken without killing" (attack damage vs stun thresholds tuned so 1–2 hits of restraint exist near the threshold); the stun window converts combat skill into guaranteed possession — the reliable path per design §8.
- **Risk possession ↔ Connection**: risk possession is the emergency valve; its failure cost is paid primarily in *connection* (a spike), so the same resource that forces host churn punishes recklessness.
- **Connection ↔ everything**: base rise + host signature (bigger/stronger hosts cost more — the counterweight to Razorfang-class power) + minion attacks (sharp spikes; minion aggression itself scales with connection → a runaway-feedback pressure that ends camping) − fresh-host relief (large for genuinely fresh bodies) − contamination (recently used hosts give ~nothing; swap-pair ledger kills ping-pong) − Dead Signal Fields (earned, temporary, one per zone).
- **Signal Carrier ↔ Field ↔ Frenzy**: the Carrier is the only renewable connection relief, but it's garrisoned and its aura makes approach itself costly → each zone has a built-in risk crescendo. The field then flips the ecosystem (everyone fights everyone), which simultaneously provides food, weakened possession targets, and lethal danger — the design's risk-reward centrepiece. Field decay + reduced in-field Dominance yields prevent farming it.
- **Replenishment ↔ Anti-farming**: populations replenish ecologically (entries at fog/cracks/kelp) so the ocean never empties, but replenished weak prey carries no progression value past its cap — the ocean stays alive without staying profitable.
- **One-way descent ↔ Pressure**: since connection rises and zone value depletes (Dominance caps hit, Carrier spent, field expired, minion attention rising), *staying* becomes strictly worse over time; descent is the pressure release, and its one-way nature makes host/size choice before descending a real decision (recommended-Dominance warning on the prompt).
- **Final possession ↔ Connection inversion**: the finale reuses the identical connection ruleset — the player deliberately lets the most dangerous number in the game climb into a narrow window while fighting. Every skill learned managing connection now aims it. No new mechanic; a reversed incentive.

---

## 7. Testing Strategy

- **Unit tests** (Vitest) on all pure-maths systems: combat damage, Dominance ledger/anti-farm, connection economy (rise/relief/contamination/ping-pong), risk-possession resolution (seeded), score model. These are the systems where silent regressions are likeliest and cheapest to catch.
- **Playtest scenarios** (scripted checklists per phase, cumulative): core-loop run, farming exploit attempts, swap-exploit attempts, each host feel-pass, frenzy risk-reward, boss fail-all-ways.
- **Performance tests**: per-phase baseline capture; stress harnesses (population 2×, max frenzy, boss arena) runnable via debug command; budget assertions in the debug overlay (red flags when exceeded).
- **AI crowd stress**: scripted spawn of worst-case T2 counts with combat forced; measure frame time distribution (avg + 1% lows), not just averages.
- **Zone lifecycle tests**: scripted 5× transition loop per zone pair; heap + renderer.info must return to baseline ±5%; orphan-entity scan.
- **Run-state tests**: serialize → reload → compare (round-trip equality); crash-resume from autosave at each zone.
- **Camera tests**: torture script per host size class (min Dartfish → max Razorfang → boss-possession scale): vertical loops, terrain hugging, cave traversal, possession transfers between extreme size pairs.
- **Input/browser compatibility**: Chrome/Edge/Firefox/Safari; keyboard+mouse and gamepad; window resize, DPI changes, tab suspend/resume (audio + timer correctness).
- **Full-run regression**: from Phase 15 on, every phase ends with a full run to the current deepest content; Phase 21 formalises the triple-run soak.

---

## 8. Risk Register

| # | Risk | Sev. | Mitigation | Fallback |
|---|---|---|---|---|
| 1 | **Underwater movement feel** — floaty/frustrating kills the game at Phase 1 | Critical | Prototype first, tune drag/accel/turn as data, A/B two steering schemes behind a flag, approval gate is literally this | Alternate control scheme (auto-level + explicit vertical keys); add optional soft lock-on for combat |
| 2 | **Third-person camera underwater** — roll, clipping, disorientation | Critical | Up-stabilised rig, collision pull-in, pitch limits, per-host profiles, torture tests every size change | Tighter constraint set (clamped pitch, slower verticals); cave-specific camera profile |
| 3 | **Host scale range** (10×+ Dartfish→Razorfang→boss) breaks camera/collision/level design | High | Camera + collision parameterised by size from day 1; squeeze-tests each growth stage; caves sized generously | Cap playable size range per zone; scale-specific camera profiles hand-tuned |
| 4 | **Animation compatibility** of user-supplied `.glb`s (naming, rigs, scale) | High | Published clip-name convention; asset-report script validates on import; procedural fallback per clip | Procedural motion covers any missing clip; retarget/rename in Blender as a documented step |
| 5 | **Browser AI cost** | High | Tier system, staggered updates, spatial hash, budgets with auto-demote | Lower T2 cap; simplify sense model; frenzy-style cheap brains for more classes |
| 6 | **Frenzy crowd cost** (worst-case scene) | High | Cheap frenzy brains, participant caps, pooled FX, dedicated stress checkpoint at Phase 13 | Reduce cap; distant "fake fighting" (T1 paired animations) |
| 7 | **Asset loading & memory retention across zones** | High | Manifest-scoped loading, disposal routine + verification, 5× transition tests every zone phase | Hard renderer reset path between zones (slower but bulletproof) |
| 8 | **Transparent underwater FX overdraw** (particles, ink, fields, kelp) | Med-High | Budgeted particle counts, alpha-cutout where possible, cheap shaders, quality scaling | Halve particle budgets on Medium/Low; opaque-ish ink (dark solid cloud) |
| 9 | **Open-ocean scale illusion fails** (zone feels like a box) | Med | Fog + silhouette cards + parallax layers + audio scale cues; approval-gated at Phase 1 | Enlarge playable bounds modestly (cheap — it's mostly empty water); stronger distant-life impostors |
| 10 | **Possession state transfer bugs** (duplication, orphaned controllers) | High | Player-as-controller-on-entity architecture (pointer swap, not state copy); single-owner assertions; 20-swap soak test | Kill-and-respawn old host as last resort (design allows host to remain, but bug-free beats faithful) |
| 11 | **Final boss complexity** | Med-High | Boss = composition of existing systems + stage director; modular proxy until mechanically approved | Cut to 2 stages, fewer node types, tendrils-only animation |
| 12 | **Leaderboard integration** (backend, abuse, hosting unknown) | Low-Med | Interface-first, local implementation ships regardless; remote adapter after hosting decision; honesty-box tier documented | Local-only leaderboard for v1 |
| 13 | **Development scope** (22 phases, 4 zones, 5+ hosts, boss) | Critical | Phase gates enforce order; vertical-slice gate (14) before any deep-zone spend; roster/zone fallbacks defined per phase | Scope cuts pre-agreed: 3 hosts min roster; merge Garden+Kingdom themes; 2-stage boss; local leaderboard |

---

## 9. Open Decisions

### Genuinely blocking (need user input before/at Phase 1)
- **None for planning.** Phase 1 can start on the assumptions in §1. Two questions are *worth* answering early but have safe defaults — see the summary section.

### Deferred with recommendation (no user input needed yet)
| Decision | Recommendation | Decide by |
|---|---|---|
| Hosting platform (itch.io vs own site) | Assume static hosting; affects only Phase 19 remote leaderboard + Phase 22 packaging | Phase 19 |
| Remote leaderboard backend | Supabase free tier or CF Worker+KV; interface isolates the choice | Phase 19 |
| Growth rendering method | Uniform scaling (revisit only if it looks bad in Phase 5) | Phase 5 gate |
| Steering scheme A vs B | Build A (camera-relative pitch), keep B behind a flag | Phase 1 gate |
| Physics engine | None; custom collision | Only if Phase 1 fails |
| Post-processing stack | Minimal (fog is not post; one cheap connection-distortion pass; bloom quality-gated) | Phase 9/17 |
| Inkfin in Phase 10 vs 14 | Attempt in 10, pre-agreed slip to 14 | Phase 10 |
| Seeded daily challenge | Stretch goal; seed plumbing exists from Phase 8 either way | Phase 19 |
| Gamepad support depth | Basic mapping from Phase 1, polish in 21 | Phase 21 |
| Texture compression (KTX2) timing | Introduce at Phase 14 when real textures arrive | Phase 14 |

---

*End of plan. Awaiting approval to begin Phase 1.*
