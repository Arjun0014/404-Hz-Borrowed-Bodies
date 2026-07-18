# 404 Hz: Borrowed Bodies

## Game Design Overview

## 1. High Concept

**404 Hz: Borrowed Bodies** is a third-person, browser-based underwater action roguelite built around temporary possession, biological growth, escalating signal pressure, and one-way descent through increasingly hostile ocean depths.

The player begins as a small fish near the surface of a vast ocean. Deep below, an ancient Cthulhu-like entity controls parts of the marine ecosystem through a psychic signal. The entity immediately notices the player and begins trying to establish a complete connection.

The player survives by borrowing new bodies, growing them through feeding, increasing their own Dominance, and descending through progressively more dangerous ocean zones. The final objective is not merely to defeat the entity, but to weaken it, connect to it at the correct moment, and take control of its body.

The central fantasy is:

> Begin as an insignificant creature, steal increasingly powerful bodies, and descend until you are strong enough to become the god waiting below.

The central thematic rule is:

> The player wants the connection to remain bad for most of the game, but must eventually risk a near-perfect connection to possess the final creature.

---

## 2. Design Pillars

### 2.1 Borrowed Power

Every host body is temporary. The player should frequently evaluate whether to keep growing the current host or abandon it for a more suitable creature.

### 2.2 Two-Layer Progression

Progress is divided between:

- **Body Growth**, which belongs to the current host.
- **Dominance**, which belongs to the player's consciousness and persists across host changes during a run.

### 2.3 Bad Connection as Pressure

Connection constantly increases. Remaining in one host for too long is dangerous, and minions directly accelerate the connection. The connection system must push the player toward movement, risk, combat, and possession.

### 2.4 Open-Water Descent

The game should feel like one enormous ocean divided into broad ecological shelves. Each zone is open and spacious, with a visible or discoverable drop into the next depth. Progression is primarily downward, not maze-like.

### 2.5 Readable Action in a Dark Ocean

Each deeper zone becomes darker and more ominous, but gameplay must remain visually readable. Darkness should be created through water colour, fog, particles, silhouettes, bioluminescence, and lighting rather than making the player unable to see.

### 2.6 Replayable Mastery

The game should support short, repeatable runs, score chasing, route optimisation, risky possession decisions, host mastery, and leaderboard competition.

---

## 3. Player Perspective and Camera

The game uses a **third-person camera**.

Third-person presentation is required because the player must clearly see:

- the current host species;
- body growth and changes in size;
- attack animations;
- stunned and damaged states;
- possession transitions;
- the scale difference between small fish, predators, abyssal creatures, and the final entity.

The camera should adapt to host size and movement style. The exact camera solution is intentionally left to the implementation agent, but it must remain readable, stable, and comfortable during underwater movement.

The camera should avoid excessive rolling and disorientation. Host movement may be fully three-dimensional, but the presentation should preserve a dependable sense of up, down, forward, and depth.

---

## 4. World Structure

The world is a continuous descent in fiction, but each zone is an independent runtime space for performance and scope control.

The side-profile concept is a terraced descent:

```text
Surface shelf
             |
             | descent
             |
             +---------------- deeper shelf
                                      |
                                      | descent
                                      |
                                      +---------------- lower shelf
```

Each zone should feel like a broad part of a much larger ocean. The playable space does not need to be physically enormous if fog, silhouettes, distant schools, large ruins, and environmental boundaries convincingly imply scale.

### Core zone rules

- Each zone is primarily a broad open-water shelf.
- There is one main progression direction: downward.
- The player may descend when ready rather than finding a complex route.
- Descending is a point of no return.
- The player cannot backtrack to earlier zones.
- Creatures from a deeper zone cannot be brought into an earlier zone.
- The next zone is loaded only after the player confirms descent.
- The previous zone is cleared after transition.
- Persistent run state continues between zones.

### Suggested zone traversal scale

Each standard zone should take approximately:

- **90 to 180 seconds** to cross directly with an average host;
- **4 to 7 minutes** when hunting, growing, fighting, possessing, and challenging a Signal Carrier.

These are design targets rather than rigid measurements.

---

## 5. Zone Progression

## 5.1 The Shallow Veil

The opening zone and primary teaching space.

Visual identity:

- blue-green water;
- visible sunlight and caustics;
- moderate clarity;
- rock shelves and shallow ruins;
- small plants and coral where available;
- open water extending toward the first major drop.

Gameplay role:

- introduce swimming and camera control;
- introduce feeding and health recovery;
- teach body growth;
- teach combat, stunning, and possession;
- introduce connection pressure;
- introduce basic minions and the first Signal Carrier after the core loop is proven.

The surface may occasionally be visible above, reinforcing how far the player will eventually descend.

## 5.2 The Drowned Garden

A denser and more dangerous middle zone.

Visual identity:

- darker green-blue water;
- taller kelp and coral formations;
- heavier drifting particles;
- more prominent submerged ruins;
- larger silhouettes at the edge of visibility.

Gameplay role:

- increase pressure from minions;
- introduce medium hosts and stronger special abilities;
- use local caves, cracks, and terrain features as tactical opportunities;
- create stronger tradeoffs between small, agile hosts and larger, powerful hosts.

## 5.3 The Fallen Kingdom

A vast drowned civilisation built around scale and open water.

Visual identity:

- enormous broken columns;
- fallen statues;
- collapsed arches;
- temple fragments;
- structures extending beyond the visible range;
- creatures appearing small against the architecture.

Gameplay role:

- introduce high-health predators;
- allow powerful hosts such as sharks or equivalent apex predators;
- increase the cost of maintaining large bodies;
- create large open fights around ruins and Signal Carriers;
- make the player feel close to the entity's domain.

## 5.4 The Dreaming Trench

The final descent and domain of the ancient entity.

Visual identity:

- very low natural light;
- bioluminescent landmarks;
- organic structures mixed with impossible ruins;
- dense signal effects;
- glimpses of the final creature far below;
- a sense that the ocean itself is becoming part of one nervous system.

Gameplay role:

- require advanced host use;
- greatly increase minion pressure;
- provide limited safe opportunities to reduce connection;
- prepare the player for the final possession attempt;
- contain the final encounter.

---

## 6. Core Run Structure

A run follows this broad pattern:

1. Enter the Shallow Veil as a small starter fish.
2. Hear the ancient entity acknowledge the intrusion.
3. Feed on small prey to restore health and grow the current body.
4. Defeat, stun, or risk-possesing stronger creatures.
5. Build Dominance through appropriate threats rather than farming only weak prey.
6. Manage the constantly rising connection.
7. Hunt a Signal Carrier when a Dead Signal Field is needed.
8. Use the field to lower connection while surviving the resulting frenzy.
9. Decide whether the current body and Dominance rank are sufficient for the next depth.
10. Confirm descent and permanently leave the current zone.
11. Repeat the loop under greater pressure with stronger creatures.
12. Reach the final entity, weaken it, and attempt possession.

A complete successful run should ideally fit within a replayable session length. The exact duration should be determined through playtesting rather than fixed prematurely.

---

## 7. Player State

The player has four primary progression and survival concepts.

## 7.1 Host Health

Health belongs to the current body.

- Ordinary attacks reduce host health.
- Eating restores host health.
- If the host dies while the player is still connected to it, the run may end unless a specifically designed emergency possession opportunity exists.
- Different hosts have different health limits, armour, resistance, and recovery value.

## 7.2 Connection

Connection represents the ancient entity establishing control over the player.

- Connection rises continuously.
- Connected minion attacks increase it sharply.
- Remaining in powerful or highly detectable hosts may increase it faster.
- Entering a fresh host reduces it.
- Re-entering a recently used host provides little or no meaningful reduction.
- Dead Signal Fields reduce it over time.
- Reaching full connection means the entity takes control and the run ends, except during the specifically designed final possession sequence.

Connection should be one of the most visually important pieces of the interface.

## 7.3 Body Growth

Growth belongs to the current host.

Each species has:

- a minimum natural size;
- one or more growth thresholds;
- a maximum growth ceiling;
- species-specific benefits and drawbacks as it grows.

Eating adds biomass to the current body. Growth should be visibly rewarding and may improve:

- maximum health;
- damage;
- ability strength;
- ability range;
- resistance to stagger or stun;
- prey size that can be consumed.

Growth may also create costs:

- faster connection gain;
- larger hitbox;
- slower turning;
- reduced access to tight spaces;
- greater attention from predators and minions.

A body should never grow beyond what makes sense for its species. The player must eventually change hosts to access a fundamentally higher power ceiling.

## 7.4 Dominance

Dominance belongs to the player's consciousness and persists across host changes during a run.

Dominance determines which classes of creature the player can reliably control.

Suggested conceptual ranks:

1. **Drifter** — small fish and minor scavengers.
2. **Hunter** — medium creatures and specialised hosts.
3. **Predator** — major predators and powerful minions.
4. **Abyssal** — deep-sea and late-game bodies.
5. **Usurper** — eligibility to attempt possession of the final entity.

Dominance cannot be raised indefinitely by killing tiny fish.

Rules should include:

- weak prey contributes only to early progression;
- each zone or creature class has a useful Dominance range;
- stronger creatures provide the progression required for higher ranks;
- first-time defeat or possession of a species may provide a larger reward;
- repeatedly farming the same weak species should provide diminishing or no relevant progression;
- possessing a dangerous target should be more valuable than simply killing it.

The exact numerical structure should be developed through balancing and playtesting.

---

## 8. Host Possession

Possession is the defining mechanic and should remain more important than conventional levelling.

There are two possession approaches.

## 8.1 Guaranteed Stun Possession

The reliable method.

- Damage a target without killing it.
- Weaken it enough to make stunning possible.
- Perform the required stun action, such as a directed dash or impact.
- Enter the stunned target during the possession window.
- Successful contact during the valid window guarantees possession.

The exact input and animation can vary by host, but the rule must remain readable and skill-based.

## 8.2 Risk Possession

The desperate or high-risk method.

- Attempt to enter a creature without fully preparing it.
- Success depends on compatibility, target health, target class, Dominance, and possibly other readable factors.
- Lower target health should generally improve the chance.
- Failure should create a meaningful penalty, such as a connection spike, brief vulnerability, alerting the target, or losing positional advantage.

Risk possession should never be the only viable method. The player must always have a learnable, skill-based path to a guaranteed takeover.

## 8.3 New Host State

When possession succeeds:

- the camera transitions to the new host;
- the new host retains its existing natural size and remaining health unless balancing requires a limited recovery rule;
- the player's Dominance persists;
- the previous host remains in the current zone if still alive;
- the previous host carries residual contamination for a period of time;
- entering a genuinely fresh body reduces connection more than returning to a recent host.

---

## 9. Combat, Feeding, and Stun Control

Combat must support three different intentions:

1. **Kill and eat** for healing, biomass, score, and some Dominance.
2. **Weaken and stun** for safe possession.
3. **Disengage** when the fight is not worth the health or connection cost.

The player must be careful not to kill a desirable host accidentally.

### Combat principles

- Each host should have one clear primary attack.
- Possessable hosts may have one distinct special ability.
- Attacks must be readable in third person.
- Damage feedback must be visible without relying only on UI bars.
- Stun eligibility should be communicated clearly.
- Larger hosts should feel powerful but not automatically optimal.

### Feeding

- Eating restores host health.
- Eating increases body biomass until the species growth ceiling is reached.
- Suitable enemies contribute to Dominance.
- Tiny prey should remain useful for limited healing or biomass, but not for bypassing progression tiers.
- Feeding activity may attract predators, scavengers, or minions.

---

## 10. Creature Behaviour Categories

## 10.1 Passive and Neutral Creatures

- Do not attack the player without provocation.
- May flee when threatened.
- May defend themselves after being attacked.
- Participate in the ecosystem and frenzy behaviour.

## 10.2 Predators

- May hunt suitable prey, including the player's current host if appropriate.
- Should behave as part of the ecosystem rather than existing only to target the player.
- Powerful predators may become valuable possession targets.

## 10.3 Cthulhu Minions

- Are directly connected to the ancient entity.
- Seek or pressure the player according to connection and local events.
- Their attacks increase connection in addition to, or instead of, ordinary health damage.
- Often patrol around or protect Signal Carriers.
- Become more common and dangerous at greater depths.

## 10.4 Signal Carriers

- High-health biological relays.
- Slow, large, or partly stationary.
- Protected by nearby minions.
- Visually and audibly recognisable from a distance.
- Killing one creates a Dead Signal Field.

---

## 11. Signal Carrier and Dead Signal Field

The Signal Carrier is a major tactical objective in each zone.

### Before the kill

- Minions cluster around the Carrier.
- The Carrier may strengthen nearby minions, reveal the player, or accelerate local connection pressure.
- The player must decide whether the reward is worth the combat risk.

### After the kill

The Carrier creates a temporary **Dead Signal Field**.

Inside the field:

- connection gradually decreases;
- direct control from the ancient entity is weakened;
- possession may become easier or safer;
- connected minions may become confused or lose coordinated behaviour.

The field also creates a **frenzy zone**.

- Nearby creatures become aggressive toward everything, not only the player.
- Predators, scavengers, neutral creatures, and disconnected minions converge.
- Creatures fight one another.
- Potential hosts may become weakened naturally.
- The player can gain health, biomass, Dominance, and possession opportunities.
- Remaining too long creates severe health risk.

The field should be temporary and should not become an infinite farming exploit. It may shrink, weaken, or collapse over time.

---

## 12. Ecosystem and Population Continuity

The ocean must feel populated even after the player kills many creatures.

Creature replacement should appear ecological rather than artificial.

Possible entry sources include:

- distant open water;
- deep cracks;
- cave mouths;
- kelp forests;
- ruins;
- the lower edge of the zone;
- schools travelling through the area.

Conceptually, the population can be divided into:

### Ambient population

Maintains visual life, schools, and passive movement.

### Ecological response

Blood, feeding, and combat attract scavengers and predators.

### Connection response

High connection, Carrier fights, and Dead Signal Fields attract minions and connected threats.

Only nearby creatures need full combat behaviour. Distant life can remain simplified until it becomes relevant.

The implementation must preserve the illusion of a living ocean without allowing uncontrolled entity counts to damage browser performance.

---

## 13. Host Variety

The initial roster should remain small and mechanically distinct.

A suitable starting roster may include concepts such as:

### Dartfish

- starter host;
- low health;
- agile turning;
- fast dash;
- low connection signature;
- can use narrow spaces.

### Shellback

- turtle-like defensive host;
- strong frontal protection;
- slow acceleration;
- high survivability;
- limited pursuit ability.

### Inkfin

- squid- or cuttlefish-like host;
- ink burst or visual disruption;
- agile lateral movement;
- fragile body;
- good escape utility.

### Razorfang

- shark-like predator;
- high health and bite damage;
- powerful charge;
- difficult to weaken and possess;
- high connection signature.

### Abyssal Ray

- late-game gliding host;
- wide movement profile;
- electrical or pulse ability;
- strong against groups or minions;
- difficult in confined spaces.

These names and exact creatures are flexible. The important requirement is that each host has a distinct movement feel, combat identity, growth ceiling, and connection tradeoff.

---

## 14. Descent and Zone Transition

At the lower edge of a zone, the player receives an in-world confirmation prompt.

Example:

> **DESCEND TO THE DROWNED GARDEN?**  
> There is no return.  
> Recommended Dominance: Hunter

The player must explicitly confirm.

After confirmation:

- the player enters a controlled descent transition;
- the current zone stops producing new activity;
- the next zone is loaded;
- the previous zone is cleared from active memory;
- persistent run state is transferred;
- control resumes in the next zone;
- backtracking is impossible.

The exact technical implementation is intentionally unspecified. The required outcome is performance-conscious one-zone-at-a-time play.

Persistent run state may include:

- Dominance;
- score;
- connection;
- current host species;
- current host health;
- current host size and growth progress;
- unlocked or discovered host information;
- run statistics;
- relevant temporary modifiers.

---

## 15. Preventing Endless Farming

Because fish populations replenish, the player must not be able to safely remain in an early zone forever.

Pressure should emerge through a combination of:

- continuously rising connection;
- weak creatures no longer contributing to higher Dominance;
- species growth ceilings;
- diminishing value from repeated weak targets;
- expired Dead Signal Fields;
- increasing local minion attention;
- predators attracted by repeated feeding;
- reduced safety over extended time in one zone.

This pressure should feel like the ancient entity becoming increasingly aware of the player's presence, not like an arbitrary visible countdown.

---

## 16. Final Encounter and Cthulhu Possession

The final encounter should reverse the player's relationship with connection.

For the entire run, the player tries to keep the connection incomplete. During the final possession, a strong connection becomes necessary.

Suggested encounter structure:

1. Enter the entity's domain with sufficient Dominance.
2. Survive attacks from the entity and connected minions.
3. Damage vulnerable organs, tendrils, eyes, signal nodes, or equivalent targets.
4. Create a limited possession opportunity by weakening or stunning the entity.
5. Deliberately allow connection to approach a dangerous threshold.
6. Attempt possession within a narrow valid range.
7. Connect too early or reach full connection at the wrong time, and the entity takes control of the player.
8. Complete the takeover successfully, and the player becomes the new deep-sea god.

The exact boss pattern should be developed during implementation and playtesting. The thematic requirement is that victory uses the same connection system that threatened the player throughout the run.

---

## 17. Scoring and Replayability

The game should support score chasing and leaderboard competition.

Possible score sources include:

- depth reached;
- time efficiency;
- total biomass consumed;
- Dominance rank;
- unique species possessed;
- difficult successful possessions;
- consecutive possession streaks;
- Signal Carriers defeated;
- time survived at dangerous connection levels;
- frenzy-field risk bonuses;
- damage dealt to the final entity;
- successful final possession;
- run completion speed.

The system should reward varied and skilful play rather than repetitive farming.

Possible leaderboard categories:

- all-time highest score;
- fastest successful possession of the final entity;
- deepest failed run;
- daily or seeded ocean challenge;
- highest unique-host count;
- highest-risk completed run.

The first implementation may use a simpler leaderboard structure, but the game design should leave room for expansion.

---

## 18. Opening and Narrative Delivery

The opening should be brief and immediate.

The player enters the Shallow Veil as a small fish. The ocean pauses or the audio drops away. A deep voice or signal says something equivalent to:

> “Who dares enter my domain?”

The connection begins, and control is given to the player.

Narrative should remain atmospheric and minimal. The game should not depend on long dialogue scenes, extensive lore screens, or cutscenes. The entity can communicate through short lines, distorted sound, environmental changes, and reactions to player progress.

---

## 19. Interface Principles

The interface should remain readable and minimal.

Required information includes:

- host health;
- connection;
- body growth progress;
- Dominance rank;
- possession opportunity or compatibility;
- stun state of a target;
- zone descent prompt;
- score and important run events.

Connection should be the most prominent bar because it defines the theme and primary pressure.

Growth should feel rewarding without becoming another oversized bar. Dominance should read as a rank or tier rather than appearing identical to health and connection.

---

## 20. Browser and Performance Requirements

The game is intended for browser delivery and must be designed around stable performance from the beginning.

Performance principles:

- only one main zone should be active at a time;
- next-zone assets should not be fully loaded before descent is confirmed unless a carefully justified preloading strategy is chosen;
- previous-zone assets and entities should be cleared after transition;
- distant schools and ambience should use simplified behaviour;
- full AI should be limited to relevant nearby creatures;
- entity counts must be budgeted;
- reusable creatures and effects should avoid unnecessary creation and destruction overhead;
- fog and limited visibility should support both atmosphere and draw-distance control;
- creature models, textures, animations, particles, audio, and effects must be suitable for browser delivery;
- performance must be measured on realistic target hardware throughout development;
- visual complexity should scale gracefully when quality settings are reduced.

The implementation agent should choose the actual technical approach after analysing the project and runtime constraints. This document defines desired behaviour, not a mandatory architecture.

---

## 21. Scope Guardrails

The following are valuable only if the core game is already enjoyable:

- large numbers of host species;
- complex cave networks;
- elaborate inventory systems;
- equipment or crafting;
- branching story paths;
- seamless retention of previous zones;
- fully procedural terrain generation;
- realistic ecosystem simulation;
- multiplayer;
- large cinematic sequences.

The core loop must first prove that the following sequence is fun:

> swim → hunt → eat → grow → weaken → stun → possess → lower connection → descend

If a feature does not strengthen that sequence, it should be delayed or removed.

---

## 22. Definition of the Game's Identity

**404 Hz: Borrowed Bodies** is not primarily a survival game, a standard fish-eating game, or an underwater boss rush.

Its identity comes from the collision of four systems:

1. Every body has a limited growth ceiling.
2. Dominance enables stronger possession targets.
3. Connection makes every body temporary.
4. Descending replaces safety with power until the player can attempt to steal the final body.

The question at the centre of every run should remain:

> Which body do I need next, and how long can I survive inside it?
