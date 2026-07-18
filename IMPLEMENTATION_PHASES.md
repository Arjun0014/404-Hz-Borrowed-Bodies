# 404 Hz: Borrowed Bodies

## Phase Roadmap and Approval Gates

## 1. Purpose of This Document

This document defines the intended development order, player-facing outcomes, and approval gates for **404 Hz: Borrowed Bodies**.

It intentionally does not prescribe code, frameworks, exact architecture, algorithms, class structures, or implementation syntax. The implementation agent should analyse the full project, determine an appropriate technical strategy, and produce its own detailed implementation plan before development begins.

The project must be built **phase by phase**. At the end of every phase:

1. The agent must present what was completed.
2. The agent must explain how to test it.
3. The agent must identify known limitations or placeholders.
4. The user must verify the result.
5. Development must stop until the user explicitly approves moving to the next phase.

The agent must not silently continue into later phases.

---

## 2. Global Development Rules

These rules apply to every phase.

### 2.1 Performance-first browser development

- Treat browser performance as a foundational requirement, not a final optimisation task.
- Establish measurable performance baselines early.
- Re-check performance whenever creatures, effects, environment complexity, or new zones are added.
- Prefer scalable solutions that can degrade gracefully on weaker hardware.

### 2.2 One active zone

- Only the current gameplay zone should remain active during normal play.
- The next zone should be loaded after the player confirms descent.
- The previous zone should be cleared once the transition is complete.
- There is no backtracking.
- Persistent run state must survive zone transitions.

The agent should decide how to achieve this after analysing the project.

### 2.3 Placeholder policy

If a required asset has not been supplied:

- do not block the phase unnecessarily;
- use a clear placeholder that preserves scale, collision, animation expectations, and gameplay purpose where possible;
- label or document the placeholder;
- keep replacement straightforward;
- never silently treat a placeholder as final art.

### 2.4 Asset discipline

- Use the accompanying `ASSETS.md` as the asset source of truth.
- Do not introduce large unplanned asset dependencies without explaining why.
- Keep imported models, textures, animation clips, audio, and effects suitable for browser delivery.

### 2.5 Approval-driven scope

- Do not polish systems whose core interaction has not been approved.
- Do not build all zones before movement, combat, growth, possession, and connection are proven in the Shallow Veil.
- Do not add optional systems merely because they are easy to implement.

### 2.6 Design authority

The game design intent is defined in `GAME_DESIGN.md`. The agent may propose refinements when testing reveals a problem, but should not quietly replace the core concept with a different game.

---

# Phase 0 — Project Analysis and Full Implementation Plan

## Goal

Analyse all three design documents and the existing repository, then create a complete implementation plan for the entire project before writing gameplay code.

## Required planning outcomes

The plan should cover:

- project and runtime assessment;
- recommended overall architecture;
- zone lifecycle and transition strategy;
- browser performance strategy;
- asset loading and replacement workflow;
- creature and animation data strategy;
- saveable run-state boundaries;
- AI complexity tiers;
- environment rendering approach;
- third-person movement and adaptive camera plan;
- combat, growth, Dominance, possession, and connection systems;
- Signal Carrier and frenzy behaviour;
- scoring and leaderboard approach;
- testing strategy;
- profiling checkpoints;
- phase dependencies;
- risks, unknowns, and fallback options;
- clear deliverables and acceptance criteria for every later phase.

## Restrictions

- Do not begin full implementation during this phase.
- Small investigative prototypes are acceptable only when required to validate a critical technical uncertainty and must be clearly identified as experiments.
- Do not assume every optional idea is mandatory.

## Approval gate

The user reviews and approves the full implementation plan before Phase 1 begins.

---

# Phase 1 — Shallow Veil Foundation and Swimming Prototype

## Goal

Create the first believable, explorable version of the Shallow Veil with third-person fish movement and a stable camera.

## Required player-facing outcome

The user can launch the game, control a starter fish, and swim comfortably through a broad, open underwater shelf that already communicates the visual direction of the game.

## Include

- the Shallow Veil's broad terraced shape;
- an open-water area extending toward a visible or discoverable drop-off;
- starter fish representation;
- third-person underwater movement;
- camera behaviour that can later adapt to different host sizes;
- basic collision and terrain boundaries;
- underwater lighting, water colour, fog, particles, and depth readability;
- basic environmental landmarks;
- optional simple plants or atmosphere created by the agent;
- a clear placeholder at the future descent location;
- an initial performance baseline.

## Exclude

- enemies;
- combat;
- eating;
- growth;
- Dominance;
- possession;
- minions;
- Signal Carrier;
- final vegetation dependence;
- final polished art.

## Asset behaviour

If the final starter fish or environment assets are unavailable, use suitable placeholders according to `ASSETS.md`.

## Verification focus

- movement feels controllable rather than weightless or frustrating;
- the camera remains readable during vertical movement and turning;
- the zone feels open rather than like a box;
- the darker drop below is visible enough to create curiosity;
- browser performance is measured and recorded.

## Approval gate

The user approves movement, camera direction, Shallow Veil scale, atmosphere, and general exploration feel.

---

# Phase 2 — Zone Lifecycle and One-Way Descent Proof

## Goal

Prove the complete transition lifecycle before populating the world with complex systems.

## Required player-facing outcome

The user can reach the Shallow Veil drop-off, receive a confirmation prompt, descend into a temporary lower-zone prototype, and confirm that returning is impossible.

## Include

- in-world descent confirmation;
- clear warning that descent is permanent;
- temporary lower-zone blockout;
- transition presentation;
- loading the next zone after confirmation;
- clearing the previous zone after transition;
- preserving essential player state;
- preventing backtracking;
- transition failure handling where appropriate;
- measurement of loading behaviour and memory use.

## Exclude

- final lower-zone art;
- full zone progression;
- enemies and ecosystem systems;
- elaborate transition cinematics.

## Verification focus

- the next zone is not entered accidentally;
- the player understands there is no return;
- the previous level is no longer active after transition;
- player control resumes correctly;
- state transfer is reliable;
- memory and performance behaviour match the project's browser goals.

## Approval gate

The user approves the one-way transition structure and zone lifecycle.

---

# Phase 3 — Ambient Ocean Population

## Goal

Make the Shallow Veil feel alive without introducing combat.

## Required player-facing outcome

Schools and individual creatures move through the zone naturally, enter and leave through believable environmental directions, and maintain the impression of a living ocean.

## Include

- passive fish schools;
- individual neutral creatures;
- basic movement and avoidance;
- ecological entry and exit points;
- population replenishment;
- distance-based behaviour simplification;
- entity-count budgets;
- basic debugging or monitoring tools for population behaviour.

## Exclude

- player combat;
- creature aggression;
- possession;
- advanced predator-prey simulation;
- minion intelligence.

## Verification focus

- fish do not visibly appear in front of the player;
- population remains present without growing uncontrollably;
- distant creatures cost significantly less than nearby active creatures;
- schools do not repeatedly collide with terrain or the player;
- the zone remains performant.

## Approval gate

The user approves the density, movement style, and visual life of the Shallow Veil.

---

# Phase 4 — Host Health, Damage, Feeding, and Death

## Goal

Create the first complete survival loop inside the starting body.

## Required player-facing outcome

The starter fish can take damage, attack appropriate prey, kill it, consume it, recover health, and die.

## Include

- host health;
- readable damage feedback;
- one starter attack;
- target damage and death states;
- feeding interaction;
- health recovery through eating;
- run failure for host death;
- basic combat feedback and audio placeholders;
- simple neutral self-defence where required.

## Exclude

- growth progression;
- Dominance;
- possession;
- minion connection attacks;
- advanced abilities.

## Verification focus

- combat is readable from the third-person camera;
- eating feels responsive and rewarding;
- the player can distinguish damage, death, and edible states;
- ordinary creatures do not all behave like enemies by default;
- host death and restart are reliable.

## Approval gate

The user approves the basic feel of attacking, taking damage, killing, and eating.

---

# Phase 5 — Species Growth and Size Progression

## Goal

Make progression within the current host visible and rewarding.

## Required player-facing outcome

Eating biomass grows the starter species through its intended thresholds until the species-specific ceiling is reached.

## Include

- biomass tracking;
- visible size growth;
- species-specific growth stages or continuous growth behaviour;
- health and combat changes tied to growth where appropriate;
- camera adaptation as the host grows;
- movement and collision validation at different sizes;
- clear indication when the current species has reached its growth ceiling;
- balancing hooks for growth benefits and drawbacks.

## Exclude

- multiple full host species;
- Dominance ranks;
- possession;
- final balance values.

## Verification focus

- growth is visually obvious;
- the camera and collision remain stable;
- growth feels rewarding without making the starter fish sufficient for the whole game;
- the species ceiling is understandable;
- increased size does not create unacceptable performance or navigation problems.

## Approval gate

The user approves the growth feel, visual scaling, and ceiling concept.

---

# Phase 6 — Dominance Progression

## Goal

Add persistent run-level progression that cannot be farmed solely through weak prey.

## Required player-facing outcome

The player earns early Dominance through suitable actions and understands that stronger ranks require stronger or more varied targets.

## Include

- Dominance rank structure;
- contribution rules by creature class;
- weak-prey progression limits;
- diminishing or capped contribution from repeated low-value targets;
- stronger rewards for meaningful encounters;
- readable Dominance feedback;
- data support for future possession requirements.

## Exclude

- full possession implementation;
- all final Dominance tiers;
- final numerical balancing.

## Verification focus

- killing tiny fish cannot unlock predator-level control;
- Dominance progress is readable without overwhelming the interface;
- the system supports later zone and host requirements;
- the player understands why some kills no longer advance higher ranks.

## Approval gate

The user approves the progression logic and anti-farming behaviour.

---

# Phase 7 — Stun and Guaranteed Possession

## Goal

Prove the central body-swapping mechanic through a reliable, skill-based interaction.

## Required player-facing outcome

The player can weaken a compatible creature, stun it, enter it during the possession window, and continue playing in the new host.

## Include

- target vulnerability thresholds;
- stun state and feedback;
- possession input and targeting;
- guaranteed takeover during a valid stun window;
- camera transfer between bodies;
- preservation of player Dominance;
- connection placeholder or temporary reduction behaviour if needed for testing;
- old-host state after abandonment;
- replacement-safe host definitions.

## Exclude

- random risk possession;
- full connection pressure;
- a large host roster;
- final possession effects.

## Verification focus

- the player can intentionally avoid killing a desired target;
- stun eligibility is clear;
- successful possession feels responsive and satisfying;
- camera transition does not disorient the player;
- the new host's movement and combat activate correctly;
- the old host does not cause duplication or state corruption.

## Approval gate

The user approves the full weaken → stun → possess loop.

---

# Phase 8 — Risk Possession and Host Compatibility

## Goal

Add a fast, dangerous alternative to guaranteed possession.

## Required player-facing outcome

The player can attempt an immediate possession with a clearly communicated risk, and failure has a fair, understandable consequence.

## Include

- compatibility or success estimation;
- health and Dominance influence;
- target-class restrictions;
- failure consequences;
- readable pre-attempt information;
- anti-exploit rules;
- balancing hooks.

## Verification focus

- chance is communicated clearly enough to feel like a decision rather than hidden randomness;
- guaranteed stun possession remains the reliable method;
- failure hurts but does not feel arbitrary;
- risk possession creates exciting emergency decisions.

## Approval gate

The user approves the balance between skill-based and risky possession.

---

# Phase 9 — Connection System and Fresh-Host Pressure

## Goal

Introduce the game's central thematic threat.

## Required player-facing outcome

Connection rises over time, entering a fresh body reduces it, and reaching full connection ends the run.

## Include

- continuous connection increase;
- prominent connection interface;
- host-specific connection sensitivity;
- connection reduction from fresh possession;
- residual contamination on recently used hosts;
- reduced benefit from repeatedly swapping between the same bodies;
- full-connection failure state;
- escalating audiovisual feedback;
- balancing and debug controls.

## Exclude

- minion attacks;
- Signal Carrier;
- final boss connection reversal.

## Verification focus

- connection forces meaningful host changes;
- swapping between two nearby bodies cannot trivialise the system;
- powerful hosts can be balanced through higher signal cost;
- warnings remain readable without excessive screen obstruction;
- failure at full connection is clear.

## Approval gate

The user approves the pressure curve and host-switch incentives.

---

# Phase 10 — First Complete Host Roster

## Goal

Establish a small group of meaningfully different playable species.

## Required player-facing outcome

The player can possess several hosts with different movement, health, growth ceilings, attacks, abilities, and connection tradeoffs.

## Include

- starter agile host;
- defensive host;
- escape or disruption host;
- stronger predator host;
- data structures supporting later abyssal hosts;
- host-specific camera tuning;
- one attack and one special ability where appropriate;
- species growth limits;
- possession requirements;
- clear host identity.

## Exclude

- a large creature catalogue;
- late-game final art if unavailable;
- optional cosmetic variants.

## Verification focus

- each host changes how the player moves and fights;
- no host is universally superior;
- size, ability, Dominance, and connection create meaningful tradeoffs;
- switching bodies is strategically useful rather than cosmetic.

## Approval gate

The user approves the initial roster and individual host feel.

---

# Phase 11 — Cthulhu Minions and Connection Attacks

## Goal

Introduce creatures whose primary purpose is to strengthen the ancient entity's connection.

## Required player-facing outcome

Connected minions can be visually identified, coordinate at a basic level, and increase connection through their attacks.

## Include

- at least one basic minion type;
- one contrasting minion type if scope permits;
- connection-damaging attacks;
- patrol and pursuit behaviour;
- relationship with player connection level;
- visual signal identity;
- basic group behaviour;
- scalable AI complexity;
- spawn and despawn discipline.

## Verification focus

- minions feel distinct from ordinary predators;
- their attacks clearly affect connection;
- they do not overwhelm the player through unfair crowding;
- behaviour scales without damaging browser performance.

## Approval gate

The user approves minion pressure and readability.

---

# Phase 12 — Signal Carrier Encounter

## Goal

Create the first major zone objective and protected high-health target.

## Required player-facing outcome

The player can locate a Signal Carrier, fight through or manipulate its defenders, and destroy it.

## Include

- Carrier visual and audio signalling;
- high health and readable damage progression;
- nearby minion protection;
- Carrier influence on local danger;
- clear death event;
- preparation for the Dead Signal Field;
- encounter performance testing.

## Exclude

- final polished Carrier model if unavailable;
- full frenzy behaviour until the next phase.

## Verification focus

- the Carrier is visible or detectable from a useful distance;
- the fight rewards preparation and host choice;
- high health feels deliberate rather than tedious;
- minion protection is threatening but readable.

## Approval gate

The user approves the Carrier encounter structure and difficulty.

---

# Phase 13 — Dead Signal Field and Frenzy Zone

## Goal

Turn the Carrier's death into a high-risk connection-recovery event.

## Required player-facing outcome

The dead Carrier creates a temporary field that lowers connection while drawing creatures into a free-for-all frenzy.

## Include

- field boundary and readable effect;
- gradual connection reduction;
- temporary duration or collapse behaviour;
- attraction of local creatures;
- aggression toward all nearby targets rather than only the player;
- weakened-host possession opportunities;
- health and biomass opportunities;
- anti-farming safeguards;
- stress testing with many simultaneous actors.

## Verification focus

- remaining inside the field is useful but dangerous;
- the frenzy looks chaotic without becoming unreadable;
- creatures fight one another convincingly;
- the player can exploit the event tactically;
- entity counts remain within performance budgets.

## Approval gate

The user approves the risk-reward balance of Dead Signal Fields.

---

# Phase 14 — Shallow Veil Complete Gameplay Pass

## Goal

Combine all approved systems into one polished vertical slice.

## Required player-facing outcome

The Shallow Veil supports a complete miniature run containing exploration, feeding, growth, Dominance, combat, possession, connection pressure, minions, a Signal Carrier, a Dead Signal Field, and descent readiness.

## Include

- balanced encounter placement;
- improved environmental landmarks;
- clear onboarding through play;
- first scoring pass;
- early audio and feedback pass;
- performance profiling under realistic load;
- bug fixing and consistency review;
- replacement of critical placeholders where assets are available.

## Verification focus

- the core loop is genuinely fun before more zones are built;
- players understand the major systems without excessive text;
- the zone cannot be trivialised through farming or body swapping;
- performance is stable during the Carrier frenzy;
- descent feels earned.

## Approval gate

The user approves the vertical slice and authorises production of deeper zones.

---

# Phase 15 — Drowned Garden Production

## Goal

Build the second complete zone using established systems while introducing greater density and medium-tier hosts.

## Required player-facing outcome

The player descends into a visibly darker, denser ecosystem with new threats, new hosts, and stronger tactical terrain.

## Include

- Drowned Garden environment;
- zone-specific vegetation and ruins;
- new population mix;
- medium-tier host or ability additions;
- local caves, cracks, or terrain features used as tactical spaces;
- stronger minion pressure;
- zone-specific Signal Carrier encounter;
- zone transition validation;
- browser performance profiling.

## Verification focus

- the zone is visually distinct from the Shallow Veil;
- darkness does not harm combat readability;
- new hosts and terrain change decisions;
- no backtracking or asset retention issues occur.

## Approval gate

The user approves the Drowned Garden as a complete second stage.

---

# Phase 16 — Fallen Kingdom Production

## Goal

Create the large-scale ruined zone and introduce major predators.

## Required player-facing outcome

The player explores open water around enormous drowned architecture and can pursue high-risk predator possession.

## Include

- giant columns, statues, arches, and collapsed structures;
- large open combat spaces;
- powerful predator host such as a shark equivalent;
- predator-specific growth and connection pressure;
- stronger Dominance requirements;
- deeper-zone Carrier encounter;
- distant silhouettes and scale effects;
- performance validation for large structures and creatures.

## Verification focus

- the zone feels monumental without requiring excessive geometry;
- large hosts remain controllable and readable;
- predator power is balanced by connection and manoeuvrability costs;
- the scene remains suitable for browser delivery.

## Approval gate

The user approves the Fallen Kingdom's scale, predator gameplay, and performance.

---

# Phase 17 — Dreaming Trench Production

## Goal

Build the final zone and prepare the player mechanically and visually for the ancient entity.

## Required player-facing outcome

The player enters a hostile, bioluminescent trench where the signal is stronger, safe options are limited, and the final creature is increasingly present.

## Include

- trench environment and organic architecture;
- low-light readability;
- late-game hosts or upgraded existing hosts;
- high minion density within strict performance limits;
- final Dominance progression;
- limited connection recovery opportunities;
- final approach sequence;
- Cthulhu presence through silhouette, voice, movement, or environmental reaction.

## Verification focus

- the zone feels threatening without becoming visually confusing;
- late-game pressure is difficult but fair;
- the player understands they are approaching the final possession attempt;
- performance remains stable under the most demanding normal gameplay conditions.

## Approval gate

The user approves the final zone before boss production begins.

---

# Phase 18 — Final Entity Encounter and Possession

## Goal

Create the complete final encounter in which connection changes from a threat into a required risk.

## Required player-facing outcome

The player can weaken the entity, create a possession window, deliberately approach a dangerous connection threshold, and either fail or become the new deep-sea god.

## Include

- final creature representation;
- readable encounter stages;
- vulnerable targets or signal nodes;
- minion and environmental pressure;
- possession readiness state;
- narrow final connection window;
- failure when connection completes incorrectly;
- successful takeover sequence;
- victory state;
- scoring integration.

## Verification focus

- the encounter uses existing mechanics rather than becoming an unrelated minigame;
- victory requires preparation, host choice, combat, and connection control;
- failure is understandable;
- final possession is satisfying and visually clear;
- the encounter fits browser performance constraints.

## Approval gate

The user approves the final encounter and ending.

---

# Phase 19 — Scoring, Run Results, and Leaderboard

## Goal

Create the replay loop and competitive structure.

## Required player-facing outcome

Every run produces a clear score and result summary, and approved leaderboard categories function reliably.

## Include

- score sources tied to skill and risk;
- anti-farming score rules;
- run summary;
- host, depth, connection, and completion statistics;
- leaderboard integration appropriate to the hosting environment;
- failure and success submissions;
- privacy and failure handling where applicable;
- daily or seeded challenge support if approved.

## Verification focus

- score rewards varied, skilful play;
- repetitive weak-prey farming is not optimal;
- submissions are reliable;
- the result screen encourages another run;
- leaderboard behaviour matches the game platform's requirements.

## Approval gate

The user approves scoring and competitive replayability.

---

# Phase 20 — Audio, Narrative, and Presentation Pass

## Goal

Give the game a cohesive identity without interrupting its pace.

## Required player-facing outcome

The game has a strong opening, recognisable zone soundscapes, readable combat audio, Cthulhu communication, and polished transitions.

## Include

- opening line and connection initiation;
- zone ambience;
- creature, attack, feeding, stun, possession, Carrier, and frenzy audio;
- music or adaptive sound design where appropriate;
- UI and transition sound;
- minimal narrative lines;
- logo, title, menu, pause, and result presentation.

## Verification focus

- audio clarifies gameplay rather than becoming noise;
- narrative remains brief and atmospheric;
- the title **404 Hz: Borrowed Bodies** is presented consistently;
- presentation supports replay rather than delaying it.

## Approval gate

The user approves the final audiovisual direction.

---

# Phase 21 — Optimisation, Compatibility, and Quality Settings

## Goal

Prepare the game for reliable browser play across realistic target devices.

## Required player-facing outcome

The game remains responsive, stable, and visually coherent across approved quality levels and supported browsers.

## Include

- full profiling of CPU, GPU, memory, loading, and network behaviour;
- entity and AI stress tests;
- texture and model review;
- animation and effect review;
- quality settings;
- reduced-detail fallback behaviour;
- loading and transition validation;
- long-session stability;
- browser compatibility testing;
- input and window-size testing;
- failure recovery where reasonable.

## Verification focus

- every zone clears correctly;
- memory does not continually grow across a full run;
- intense frenzy and boss scenes remain within acceptable performance targets;
- quality reductions do not make the game unreadable;
- no major browser-specific blockers remain.

## Approval gate

The user approves the release performance profile.

---

# Phase 22 — Final Balance, Bug Fixing, and Release Candidate

## Goal

Create a complete release candidate suitable for submission and public play.

## Required player-facing outcome

The full game can be played from opening to victory or failure with stable progression, understandable mechanics, and no known release-blocking defects.

## Include

- complete run testing;
- progression and difficulty balancing;
- score balancing;
- connection pressure tuning;
- growth and Dominance tuning;
- possession success and stun-window tuning;
- encounter pacing;
- placeholder audit;
- asset licence audit;
- accessibility and readability review;
- release build validation;
- final deployment checklist.

## Verification focus

- no system contradicts the central game loop;
- the game encourages repeated runs;
- the first zone teaches effectively;
- later zones increase depth rather than only health values;
- victory feels difficult but attainable;
- the release build matches the approved design.

## Approval gate

The user authorises release or requests final targeted revisions.

---

## 3. Phase Change Policy

The implementation agent may recommend splitting, merging, or reordering a phase only when there is a strong technical reason. Any change must:

- preserve the approval-gate workflow;
- preserve the design intent;
- identify the benefit and risk;
- update the full implementation plan;
- receive user approval before execution.

---

## 4. Core Success Test

Before deeper-zone production is considered successful, the Shallow Veil must prove that this sequence is enjoyable:

> swim → hunt → eat → grow → weaken → stun → possess → manage connection → kill Carrier → survive frenzy → descend

If this sequence is not fun, later phases must pause while the core loop is revised.
