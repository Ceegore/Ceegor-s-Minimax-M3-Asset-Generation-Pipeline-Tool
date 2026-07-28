# UI Test Configuration & Strategy

> **Central reference for ALL automated UI testing of MiniMax Assets Tool.**
> Every test session MUST adhere to these parameters for reproducibility.

## Window Configuration (MANDATORY)

| Parameter       | Value                          |
|-----------------|--------------------------------|
| Screen resolution | 1920 × 1080                 |
| Window size     | 1400 × 900 (fixed, do NOT resize) |
| Window position | Top-right corner: X=519, Y=0 |
| Maximized       | **NO** — never fullscreen/maximized |
| Monitor         | Primary display               |

### Rules
1. **Never maximize** the application window during tests.
2. **Never resize** the window — keep 1400×900 at all times.
3. **Always position** at top-right (X=519, Y=0) before starting any test.
4. These parameters are **identical for every test run** — no exceptions.
5. If the window is found maximized, restore it first, then reposition.

## Coordinate Reference System

- **Absolute coordinates**: relative to the primary monitor origin (0,0 = top-left of screen).
- **Window-relative coordinates**: relative to the app window's top-left corner (client area starts below the ~32px title bar).
- All UI-map coordinates are recorded in BOTH systems.

## App Start State

- Config: `config.txt` in project root (API key present, output_dir=C:\temp\minimax-pipeline-test, theme=dark)
- On launch: Welcome/About modal appears → dismiss with **OK** button or **Esc**
- After dismiss: Image tab active, status bar shows "Ready"
- File browser: right sidebar panel
- Log panel: bottom area

## Test Execution Protocol

1. Launch app → wait for window → verify 1400×900 → move to (519, 0)
2. Dismiss startup modal (OK or Esc)
3. Verify status bar = "Ready"
4. Begin test sequence
5. After each test: return to known state (Image tab, no modals open)

## Debug Logging Strategy

If tool feedback is insufficient to determine success/failure:
- Enable verbose logging via the app's Log panel (expand all rows)
- Record screenshots before/after each action
- Log format: `[TIMESTAMP] ACTION → EXPECTED vs OBSERVED`
- Write to: `tests/ui-debug-log.txt` (session-scoped, overwritten each run)
