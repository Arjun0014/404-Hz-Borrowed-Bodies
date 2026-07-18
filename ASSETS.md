# 404 Hz: Borrowed Bodies

## Asset Requirements and Phase Ownership

## 1. Purpose of This Document

This document identifies the art, animation, texture, audio, interface, and presentation assets expected during each development phase.

Assets are separated into two ownership categories:

1. **Agent-created or agent-sourced temporary assets** — items the implementation agent may generate, assemble, derive, or replace with clear placeholders during development.
2. **User-provided or user-downloaded final assets** — polished external assets that the user should supply when available, typically as `.glb`, image textures, audio files, or licensed packs.

The implementation must not stop solely because a final asset is missing. It should use a clearly documented placeholder and continue when the phase can still be validated meaningfully.

---

## 2. Global Asset Rules

### 2.1 Preferred model format

For externally supplied 3D assets, prefer:

- `.glb` as the primary delivery format;
- embedded or clearly associated textures;
- clean scale and orientation;
- sensible pivot placement;
- optimised geometry suitable for browser delivery;
- named animation clips when rigged;
- no unnecessary hidden geometry, cameras, lights, or duplicate materials.

Other formats may be converted before use, but the working game asset should ideally become a `.glb`.

### 2.2 Texture expectations

Textures may include:

- base colour or albedo;
- normal maps;
- roughness;
- metallic only when appropriate;
- opacity or masks;
- emissive maps for bioluminescence or signal effects;
- packed maps if chosen by the implementation agent.

Texture sizes should be selected by visible importance rather than using the same resolution everywhere. Browser delivery, memory use, and loading time must be considered.

### 2.3 Animation expectations

Possessable creature assets may require some combination of:

- idle or slow swim;
- fast swim;
- turning support;
- primary attack;
- special ability;
- hit reaction;
- stun;
- feeding;
- death;
- possession entry or possession state.

Not every animation must be a separate clip if the implementation agent can create the behaviour through blending, procedural motion, effects, or simple transformations. The required outcome is readable gameplay, not a mandated animation architecture.

### 2.4 Asset licensing

Every external asset must have a licence compatible with the intended public game release.

Record:

- source;
- creator;
- licence type;
- attribution requirement;
- modification permission;
- commercial-use status if relevant.

Do not include ripped game assets, unlicensed marketplace files, or assets with unclear redistribution rights.

### 2.5 Placeholder policy

When an asset is missing:

- use a primitive, simplified procedural object, basic rig, or temporary model;
- preserve approximate scale and gameplay silhouette;
- use obvious placeholder materials where useful;
- document the exact final asset still required;
- avoid building dependencies on accidental placeholder details;
- ensure the placeholder can be replaced without redesigning the whole system.

### 2.6 Performance policy

Before importing any final asset, review:

- triangle count;
- material count;
- texture memory;
- animation complexity;
- number of bones;
- transparency cost;
- particle cost;
- audio size and duration;
- expected simultaneous instance count.

A hero boss asset and a school fish asset should not use the same complexity budget.

---

# Phase 0 — Planning and Repository Analysis

## Agent-created or agent-prepared

- asset inventory template;
- licence tracking template;
- naming and folder conventions;
- placeholder replacement checklist;
- model and texture performance budgets;
- proposed LOD or simplification strategy;
- proposed audio compression and loading strategy;
- per-phase missing-asset report format.

## User-provided or user-downloaded

- any existing repository assets;
- existing logo, title treatment, references, concept images, or purchased packs;
- links or licences for already selected external assets.

## Required output

A clear asset plan that maps every major asset to a phase and identifies which items are blocking, optional, replaceable, or final-polish only.

---

# Phase 1 — Shallow Veil Foundation and Swimming Prototype

## Agent-created or temporary assets

- Shallow Veil terrain blockout;
- open-water shelf and drop-off geometry;
- simple rocks, seabed forms, and distant silhouettes;
- placeholder starter fish if no final fish is supplied;
- basic underwater fog and colour treatment;
- caustic approximation or temporary animated light pattern;
- suspended-particle sprite or simple particle texture;
- bubble particles if useful;
- simple plant or coral placeholders where they improve atmosphere;
- temporary sky or surface-light treatment;
- placeholder descent marker;
- temporary materials for terrain and rocks.

## User-provided or user-downloaded final assets

- **Starter fish `.glb`**, preferably rigged and animated;
- optional shallow-ocean environment pack;
- rock and coral `.glb` assets;
- kelp or sea-grass `.glb` assets;
- seabed textures;
- rock textures;
- coral textures;
- water normal or distortion textures if used;
- caustics texture sequence or animated caustic texture;
- soft underwater noise texture;
- plankton, sediment, or bubble sprite textures.

## Starter fish preferred animation set

- idle swim;
- forward swim;
- fast swim or dash;
- turn support if needed;
- attack placeholder or clip for later phases;
- hit, stun, feeding, and death may be added later.

## Placeholder fallback

A simple low-poly fish or streamlined primitive with basic procedural tail motion is acceptable for this phase.

---

# Phase 2 — Zone Lifecycle and Descent Proof

## Agent-created or temporary assets

- temporary lower-zone blockout;
- descent trigger marker;
- confirmation prompt UI;
- loading or transition overlay;
- simple downward tunnel, darkness, current, or fade transition;
- placeholder lower-zone ambience.

## User-provided or user-downloaded final assets

No mandatory final assets.

Optional:

- descent transition sound;
- deep-water ambience;
- transition particle texture;
- current or vortex texture.

## Placeholder fallback

Use abstract geometry and clear labels. This phase tests lifecycle behaviour, not final presentation.

---

# Phase 3 — Ambient Ocean Population

## Agent-created or temporary assets

- simple low-cost school fish variants;
- simplified distant-fish silhouettes;
- placeholder neutral creature models;
- procedural or basic school motion;
- spawn-region markers hidden during play;
- debug visuals for population counts and activation ranges.

## User-provided or user-downloaded final assets

- one or more low-poly small-fish `.glb` models;
- optional colour or pattern variants;
- one medium neutral fish `.glb`;
- optional crustacean or bottom-dweller `.glb`;
- simple swim animation clips;
- fish-school texture or silhouette cards if used for distant life.

## Asset guidance

Ambient creatures should be especially lightweight because many may be visible simultaneously.

## Placeholder fallback

Use a few distinct primitive fish silhouettes with different scales and movement speeds.

---

# Phase 4 — Host Health, Damage, Feeding, and Death

## Agent-created or temporary assets

- temporary attack effect;
- hit flash or impact effect;
- feeding effect;
- death dissolve, fade, or simple animation fallback;
- health UI;
- damage indicators;
- temporary combat sounds.

## User-provided or user-downloaded final assets

For the starter fish and first prey species:

- attack animation;
- hit reaction;
- feeding animation if available;
- death animation;
- bite, impact, feeding, and death audio;
- small blood-cloud texture or particle sprite;
- body-wound or damage mask only if the chosen art direction supports it.

## Placeholder fallback

Procedural body motion, scale pulses, particles, and temporary audio are sufficient for validating combat feel.

---

# Phase 5 — Species Growth and Size Progression

## Agent-created or temporary assets

- growth visual effect;
- temporary biomass UI;
- scale-change feedback;
- growth-stage debug display;
- camera test markers for different body sizes.

## User-provided or user-downloaded final assets

- starter fish model that remains visually acceptable across its intended growth range;
- optional juvenile, mature, or oversized mesh variants if simple scaling is visually inadequate;
- optional growth-stage texture variants;
- growth sound or biological pulse audio;
- growth particle texture.

## Asset decision point

The implementation agent should determine whether each species can grow through scaling, mesh morphing, staged models, material changes, or a combination. The design document does not mandate one method.

## Placeholder fallback

Uniform or proportion-aware scaling with a simple growth flash is acceptable during development.

---

# Phase 6 — Dominance Progression

## Agent-created or temporary assets

- Dominance rank icons;
- temporary rank-up effect;
- UI labels and notifications;
- debug display for contribution categories.

## User-provided or user-downloaded final assets

Optional:

- polished Dominance icons;
- rank-up sound;
- subtle psychic or signal texture for progression feedback.

## Placeholder fallback

Text labels and simple geometric icons are sufficient.

---

# Phase 7 — Stun and Guaranteed Possession

## Agent-created or temporary assets

- stun effect;
- possession targeting indicator;
- possession transition effect;
- residual contamination marker;
- camera-transfer presentation;
- target vulnerability indicator;
- placeholder possession audio.

## User-provided or user-downloaded final assets

- second possessable creature `.glb`;
- swim and movement animation;
- attack animation;
- hit reaction;
- stun animation;
- death animation;
- optional possession-specific animation;
- psychic tendril, signal line, or energy texture;
- stun particle sprite;
- possession sound effects.

## Placeholder fallback

A second clearly different primitive creature with basic procedural animation is acceptable.

---

# Phase 8 — Risk Possession and Compatibility

## Agent-created or temporary assets

- compatibility display;
- failure effect;
- connection-spike effect;
- target alert feedback;
- temporary warning audio.

## User-provided or user-downloaded final assets

Optional:

- polished risk indicator artwork;
- failure sound;
- distorted signal texture;
- brief screen-space interference texture.

## Placeholder fallback

Simple text, colour-independent symbols, and temporary sound are sufficient.

---

# Phase 9 — Connection System

## Agent-created or temporary assets

- connection bar and states;
- signal distortion effect;
- high-connection warning treatment;
- possession-based connection-reduction effect;
- full-connection failure presentation;
- contaminated-host marker;
- placeholder Cthulhu voice or signal cue.

## User-provided or user-downloaded final assets

- signal waveform or neural-pattern textures;
- subtle distortion noise texture;
- connection pulse audio;
- warning tones;
- low-frequency ambience;
- voice performance or processed vocal source for the ancient entity;
- full-connection failure sound.

## Visual caution

Avoid effects that make gameplay unreadable. Signal interference should escalate while preserving control and target visibility.

## Placeholder fallback

Use UI pulses, vignette-like feedback, audio filters, and simple procedural noise.

---

# Phase 10 — First Complete Host Roster

## Agent-created or temporary assets

- placeholder versions of missing hosts;
- temporary ability effects;
- host-selection or discovery UI;
- host-specific camera tuning data;
- simplified growth-stage visuals.

## User-provided or user-downloaded final assets

Recommended initial host set:

### Agile starter host

- rigged `.glb`;
- swim, dash, attack, hit, stun, feed, death animations.

### Defensive turtle-like host

- rigged `.glb`;
- swim or paddle animation;
- defensive posture or shell-block animation;
- attack, hit, stun, feed, death animations.

### Squid- or cuttlefish-like host

- rigged `.glb`;
- swim and fast-propulsion animations;
- ink ability animation;
- attack, hit, stun, feed, death animations;
- ink cloud texture or volumetric sprite sequence.

### Predator host

- rigged shark-like `.glb`;
- slow swim and fast charge;
- bite attack;
- hit, stun, feed, death animations.

### Optional early ray-like host foundation

- rigged `.glb`;
- glide animation;
- pulse or electrical ability animation.

Additional textures and effects:

- species materials and texture sets;
- ability particle textures;
- ink texture;
- charge trail texture;
- defensive impact texture;
- host-specific attack audio;
- movement and ability audio.

## Asset guidance

Every playable host must be evaluated for:

- animation completeness;
- growth suitability;
- camera readability;
- collision shape;
- browser performance;
- ability silhouette.

## Placeholder fallback

Use simple low-poly proxies with distinct shapes and colours. Do not delay mechanical approval while waiting for all final creatures.

---

# Phase 11 — Cthulhu Minions

## Agent-created or temporary assets

- basic minion placeholder model;
- connected-material effect;
- connection projectile or contact effect;
- group-alert effect;
- temporary minion audio.

## User-provided or user-downloaded final assets

At least one minion `.glb`, preferably with:

- idle or patrol swim;
- chase animation;
- attack animation;
- hit reaction;
- stun;
- death.

Optional second minion type:

- ranged or tethering minion `.glb`;
- separate attack effect.

Textures and effects:

- emissive eye or nerve textures;
- psychic tether texture;
- projectile sprite or mesh;
- connection-impact effect;
- minion vocal or signal audio.

## Placeholder fallback

Use an altered version of a neutral creature with a strong emissive signal marker and temporary attacks.

---

# Phase 12 — Signal Carrier Encounter

## Agent-created or temporary assets

- Carrier blockout;
- health and damage-state feedback;
- signal pulse effect;
- protection-radius effect if required;
- death sequence placeholder;
- audio beacon placeholder.

## User-provided or user-downloaded final assets

- high-health Carrier `.glb`;
- jellyfish-, whale-organ-, coral-relay-, or biomechanical-inspired design;
- idle or pulsing animation;
- damage reaction or staged damage visuals;
- death animation or collapsible parts if available;
- emissive signal textures;
- pulse or sonar-ring texture;
- Carrier beacon audio;
- damage and death audio.

## Asset guidance

The Carrier must be recognisable at a distance and should not require excessive animation or geometry to communicate importance.

## Placeholder fallback

Use a large floating geometric or organic proxy with pulsing emissive material.

---

# Phase 13 — Dead Signal Field and Frenzy Zone

## Agent-created or temporary assets

- field volume or boundary effect;
- dead-signal particles;
- collapsing-field presentation;
- frenzy-state creature markers if needed;
- temporary shockwave;
- temporary field audio.

## User-provided or user-downloaded final assets

- dead-field noise texture;
- boundary distortion texture;
- biological shockwave texture;
- blood or neural-cloud texture;
- frenzy audio layer;
- field ambience;
- Carrier corpse variant if the final Carrier asset supports it.

## Performance caution

Transparent overlapping effects and large creature crowds can be expensive. Final assets must be selected with the worst-case frenzy scene in mind.

## Placeholder fallback

Use a simple sphere or region with particles, audio, and clear UI feedback.

---

# Phase 14 — Shallow Veil Complete Pass

## Agent-created or temporary assets

- finalised placeholder audit;
- improved landmarks;
- onboarding indicators;
- score event feedback;
- zone-specific UI polish;
- temporary title card for the zone.

## User-provided or user-downloaded final assets

- final Shallow Veil rocks, coral, plants, and seabed pieces;
- final shallow-water textures;
- polished starter and early-host models;
- final first Carrier and minion assets where available;
- shallow-zone ambience;
- combat and possession sound set;
- zone music if used.

## Placeholder fallback

Non-critical decorative items may remain placeholders if the full gameplay slice is otherwise testable. Critical silhouettes should be replaced before treating the vertical slice as art-complete.

---

# Phase 15 — Drowned Garden

## Agent-created or temporary assets

- Drowned Garden blockout;
- modular kelp and ruin placeholders;
- cave and crack blockouts;
- deeper-water lighting treatment;
- zone-specific spawn markers;
- temporary medium-tier creature proxies.

## User-provided or user-downloaded final assets

Environment:

- tall kelp `.glb` set;
- dense coral or underwater garden pack;
- ruined wall, arch, and statue fragments;
- cave entrance and rock assets;
- darker seabed textures;
- kelp and plant textures;
- particle and sediment textures.

Creatures:

- one or more medium-tier possessable hosts `.glb`;
- medium predators or neutral creatures;
- zone-specific minion variant if approved;
- required animation sets.

Audio:

- denser current ambience;
- plant movement or creaking ruins;
- new host and enemy sounds;
- zone music or tonal layer.

## Placeholder fallback

Use modular blocks, scaled rock assets, simple vertical plant cards or low-poly fronds, and creature proxies.

---

# Phase 16 — Fallen Kingdom

## Agent-created or temporary assets

- giant-column and statue blockouts;
- distant ruin silhouettes;
- large predator proxy;
- collapsed architecture layout;
- scale-reference markers;
- temporary dust and debris effects.

## User-provided or user-downloaded final assets

Environment:

- giant broken columns `.glb`;
- monumental statue `.glb` assets;
- arches and temple fragments;
- collapsed roofs and stone slabs;
- ancient stone texture sets;
- algae, grime, and age masks;
- distant architecture silhouettes.

Creatures:

- final shark-like predator `.glb`;
- large neutral or hostile creatures;
- stronger minion or Carrier variant if approved;
- full predator animation set.

Effects and audio:

- stone debris particles;
- large impact effect;
- charge trail;
- open-water deep current ambience;
- distant structural groans;
- predator audio.

## Placeholder fallback

Use oversized modular stone geometry and a simplified predator proxy until final assets are supplied.

---

# Phase 17 — Dreaming Trench

## Agent-created or temporary assets

- trench blockout;
- organic-architecture placeholders;
- bioluminescent landmarks;
- abyssal creature proxies;
- distant Cthulhu silhouette;
- stronger signal effects;
- temporary final-approach audio.

## User-provided or user-downloaded final assets

Environment:

- abyssal rock and trench walls;
- organic coral, nerve, tendril, or bone-like structures;
- impossible ruin fragments;
- bioluminescent plant and organism `.glb` assets;
- emissive textures;
- dark rock and organic surface textures;
- deep-particle textures.

Creatures:

- Abyssal Ray or equivalent late-game host `.glb`;
- abyssal neutral and hostile creatures;
- late-game minion variants;
- animation sets.

Effects and audio:

- bioluminescent pulse textures;
- electrical effect textures;
- deep signal ambience;
- low-frequency entity voice layers;
- trench music or tonal soundscape.

## Placeholder fallback

Use emissive simple shapes, dark modular rocks, and low-poly abyssal proxies while validating gameplay.

---

# Phase 18 — Final Entity Encounter

## Agent-created or temporary assets

- final creature blockout sized for the encounter;
- placeholder vulnerable nodes;
- temporary tendrils or attack shapes;
- boss-state UI;
- possession-window effects;
- victory and failure placeholders;
- performance test version of the arena.

## User-provided or user-downloaded final assets

Final entity:

- Cthulhu-like boss `.glb` or modular boss parts;
- suitable scale and readable silhouette;
- idle, attack, reaction, weakened, stun, and possession states where possible;
- tentacle or limb animations;
- vulnerable-organ or signal-node assets;
- emissive or neural texture set;
- damage-stage materials or meshes;
- final possession transformation assets.

Environment:

- boss-domain architecture;
- seabed or abyss floor;
- large organic structures;
- final arena landmarks.

Effects:

- psychic wave;
- large signal tendrils;
- possession stream;
- near-full connection effect;
- victory transformation;
- boss damage and death effects.

Audio:

- final entity voice;
- boss attacks;
- psychic pressure;
- possession sequence;
- victory and failure cues;
- final music.

## Asset guidance

The final creature may need a custom or heavily modified asset. It should be treated as a hero asset with a larger budget than ordinary creatures, while still remaining suitable for browser delivery.

## Placeholder fallback

A modular silhouette built from primitives and animated tendril proxies is acceptable until the encounter is mechanically approved.

---

# Phase 19 — Scoring and Leaderboard

## Agent-created or temporary assets

- score HUD;
- event notifications;
- run-result screen;
- leaderboard screen;
- rank badges;
- daily-seed indicator if used;
- temporary menu icons.

## User-provided or user-downloaded final assets

Optional:

- polished scoreboard frame;
- leaderboard icons;
- result-screen background;
- rank emblems;
- UI sound effects;
- celebratory or failure stingers.

## Placeholder fallback

Clean text and simple panels are sufficient for functional approval.

---

# Phase 20 — Audio, Narrative, and Presentation

## Agent-created or temporary assets

- temporary title screen;
- subtitle styling;
- basic menus;
- pause screen;
- placeholder logo placement;
- temporary voice processing;
- audio-mix test scenes.

## User-provided or user-downloaded final assets

Brand and interface:

- final **404 Hz: Borrowed Bodies** logo;
- title-card artwork;
- menu background or animated scene;
- UI font files only when licensing and distribution are clear;
- polished icons and panels.

Narrative and voice:

- final opening line recording;
- additional brief Cthulhu lines;
- voice processing source or approved effect chain;
- subtitles.

Music and sound:

- menu music;
- zone ambience;
- zone music layers;
- combat and possession sound set;
- transition and result music;
- final ending cue.

## Placeholder fallback

Text title, system fonts, generated tones, and temporary licensed audio may be used until final presentation assets arrive.

---

# Phase 21 — Optimisation and Compatibility

## Agent-created or prepared assets

- simplified material variants;
- reduced-particle presets;
- lower-detail creature variants where appropriate;
- texture downscales;
- reduced-quality environment variants;
- audio compression variants;
- quality-setting icons and labels;
- fallback effects.

## User-provided or user-downloaded final assets

Potentially required after profiling:

- lower-poly versions of hero or repeated assets;
- lower-resolution texture variants;
- simplified shader-compatible textures;
- reduced-bone creature rigs;
- alternative effect textures with less transparency;
- shorter or compressed audio masters.

## Asset decision point

Optimisation should be based on measured bottlenecks. Do not create every possible reduced asset without evidence that it is needed.

---

# Phase 22 — Release Candidate

## Agent-created or prepared assets

- final asset manifest;
- licence and attribution list;
- credits screen;
- placeholder audit;
- unused-asset removal report;
- final build-size report;
- deployment-ready asset packaging.

## User-provided or user-downloaded final assets

- any final replacements for release-blocking placeholders;
- final logo and store or jam-page images;
- thumbnail;
- screenshots;
- gameplay trailer assets if required;
- final credits and attribution information.

## Release asset gate

Before release, confirm:

- no visible critical placeholder remains unintentionally;
- every external asset has a recorded licence;
- unused large assets are removed;
- model and texture sizes match actual visual importance;
- the complete build fits the platform's delivery expectations;
- the title is consistently shown as **404 Hz: Borrowed Bodies**.

---

## 3. Suggested User Asset Priority

To avoid downloading everything at once, the user should prioritise assets in this order:

1. Starter fish `.glb` and shallow environment references.
2. One neutral prey fish and one second possessable host.
3. Defensive, squid-like, and predator host `.glb` files.
4. First minion and Signal Carrier assets.
5. Shallow Veil final environment pack.
6. Drowned Garden environment and medium-host assets.
7. Fallen Kingdom monumental ruins and predator assets.
8. Dreaming Trench organic assets and abyssal host.
9. Final Cthulhu-like boss asset or custom creation route.
10. Final music, voice, sound effects, logo, and interface art.

The agent should request only the assets needed for the upcoming approved phase, not overwhelm the user with the entire list at once.

---

## 4. Per-Phase Asset Request Format

Before beginning a phase that benefits from user-supplied assets, the implementation agent should provide a compact request containing:

- asset name;
- purpose;
- required or optional status;
- preferred file type;
- animation requirements;
- approximate scale or role;
- texture requirements;
- performance concerns;
- acceptable placeholder if not supplied.

Example structure:

```text
Asset: Starter fish
Purpose: Initial playable host
Status: Required for final art, not required for prototype
Preferred format: Rigged .glb
Animations: Idle swim, fast swim, attack; later hit, stun, feed, death
Textures: Embedded or supplied alongside the model
Fallback: Low-poly procedural fish placeholder
```

---

## 5. Final Asset Philosophy

The project should not depend on having perfect final assets before proving the game.

The correct order is:

1. validate scale and interaction with placeholders;
2. validate mechanics and performance;
3. request or source the specific final asset;
4. replace the placeholder cleanly;
5. profile again;
6. polish only after the phase is approved.

This protects the project from spending time or money on assets before the gameplay has earned them.
