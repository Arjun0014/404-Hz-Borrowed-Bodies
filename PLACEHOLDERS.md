# Placeholder Registry

Every non-final asset in the build. Replacing one = drop the final file into
`assets/`, update the referenced path (usually `src/data/species.ts` or the zone
builder), delete the row here. Never treat a listed item as final art.

| ID | Placeholder | Stands in for | Referenced in | Final asset spec | Status |
|----|-------------|---------------|---------------|------------------|--------|
| PH-TERRAIN | Procedural noise heightfield, vertex-coloured | Shallow Veil seabed with sculpted layout + textures | `src/world/Terrain.ts` | Seabed textures (albedo/normal), possibly authored heightmap | Active |
| PH-ROCKS | Displaced icosahedron instanced rocks (3 variants) | Rock/coral `.glb` set | `src/world/ShallowVeil.ts` `buildRocks` | Rock + coral `.glb`, ≤2k tris each, 1024² textures | Active |
| PH-KELP | Swaying flat blades (2 variants, instanced) | Kelp / sea-grass `.glb` or cards with textures | `src/world/ShallowVeil.ts` `buildKelp` | Kelp `.glb` or alpha-cutout card set | Active |
| PH-CAUSTICS | Procedural trig-pattern caustics in terrain shader | Caustics texture sequence | `src/world/Terrain.ts` shader inject | Animated caustic texture (or keep procedural if approved) | Active |
| PH-PARTICLES | Round soft-dot shader points | Plankton/sediment sprite textures | `src/world/ShallowVeil.ts` `buildParticles` | Sediment/plankton sprite sheet (optional) | Active |
| PH-SURFACE | Sine-band shader plane + canvas sun glow | Water surface normal/distortion textures | `src/world/ShallowVeil.ts` `buildSurface` | Water normal texture (optional) | Active |
| PH-SILHOUETTE | Dark cone meshes at fog range | Distant ruin/rock silhouette cards | `src/world/ShallowVeil.ts` `buildSilhouettes` | Silhouette cards or low-poly distant set | Active |
| PH-DESCENT | Pulsing torus ring + point light at pit rim | Final descent-point presentation (Phase 2 owns this) | `src/world/ShallowVeil.ts` `buildDescentMarker` | Designed descent gate visuals + audio | Active |
| PH-AUDIO | No audio at all in Phase 1 | Zone ambience, UI sounds | — | Shallow ambience loop (Phase 14/20) | Active |

## Not placeholders (final-art candidates)

- `assets/clown_fish_compressed.glb` — starter fish (user-supplied, KTX2+Draco). 94 bones noted: fine as the single player fish, do not instance in schools.
- `assets/tuna_fish_compressed.glb` — future ambient/possessable host (user-supplied). Unused in Phase 1.
