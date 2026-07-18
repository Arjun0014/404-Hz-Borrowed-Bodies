# 404 Hz: Borrowed Bodies

Browser-based third-person underwater possession roguelite. Begin as a small
fish, steal increasingly powerful bodies, descend until you can become the god
waiting below.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
```

`npm run build` → production build in `dist/`. `npm run asset-report` → inspect
`.glb` files against performance budgets.

## Controls (Phase 1)

- **Click** — capture mouse / dive
- **W / S** — swim forward / brake
- **Mouse** — steer (camera-relative)
- **A / D** — lateral drift, **Space / C** — rise / sink
- **Shift** — dash
- **Wheel** — camera zoom, **F3** — perf stats, **F4** — quality preset

## Project documents

- `GAME_DESIGN.md` — design authority
- `IMPLEMENTATION_PHASES.md` — phase roadmap and approval gates
- `ASSETS.md` — asset requirements per phase
- `IMPLEMENTATION_PLAN.md` — full technical plan (Phase 0 deliverable)
- `game_memory.md` — cross-session progress log
- `PLACEHOLDERS.md`, `ASSET_MANIFEST.md`, `assets/LICENSES.md` — asset tracking
