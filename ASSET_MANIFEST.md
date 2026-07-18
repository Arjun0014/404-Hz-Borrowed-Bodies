# Asset Manifest & Conventions

## Animation clip naming convention

User-supplied rigged `.glb` files should name clips from this set (case-insensitive
match; any clip may be omitted — procedural fallback covers gaps):

`idle, swim, dash, attack, ability, hit, stun, feed, death, possess`

The loader currently matches `/swim|idle/i` for the locomotion loop and will map
the full set from Phase 4 onward.

## Per-asset budget ceilings (from IMPLEMENTATION_PLAN.md §3.1)

| Class | Triangles | Bones | Materials | Textures |
|---|---|---|---|---|
| School fish | ≤ 800 | 0 (no skeleton) | 1 | shared atlas |
| Standard creature | ≤ 8 000 | ≤ 40 | ≤ 2 | ≤ 1024² |
| Hero (carrier/predator) | ≤ 20 000 | ≤ 60 | ≤ 3 | ≤ 2048² |
| Final boss | ≤ 60 000 | ≤ 120 | ≤ 6 | ≤ 2048² |

Check any incoming `.glb` with: `npm run asset-report -- path/to/file.glb`

## Current assets

| File | Role | Format | Tris | Bones | Textures | Status |
|---|---|---|---|---|---|---|
| `assets/clown_fish_compressed.glb` | Starter fish (Dartfish) | glb, Draco+KTX2 | 276 | 94 (over budget — accepted, single instance) | 1×1024² KTX2 | In use (Phase 1) |
| `assets/tuna_fish_compressed.glb` | Future neutral/host | glb, Draco+KTX2 | 5 989 | 47 | 6×1024² KTX2 | Reserved (Phase 3+) |

## Pipeline notes

- Vite bundles `.glb` via `?url` imports; loaders use Draco decoder at
  `public/draco/`, Basis/KTX2 transcoder at `public/basis/`.
- KTX2 textures stay compressed on the GPU (~4-8× VRAM saving vs PNG) — keep
  using it for all textured assets. Draco shrinks download only; geometry
  decompresses in RAM at load.
- Licences: every external file needs a row in `assets/LICENSES.md` before it
  ships in a release build.
