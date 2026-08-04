# Windows Security Test

- Release version:
- Source commit:
- GitHub workflow run:
- Release candidate artifact SHA-256:
- Test date:
- Tester:

## Test system

- Physical PC / VM:
- Windows edition and build:
- Defender platform/version:
- Defender definitions:
- Defender real-time protection active:
- SmartScreen active:
- Smart App Control status:
- Managed/AppLocker policy:

## Download and launch

| Test | Expected | Result | Evidence |
|---|---|---|---|
| Browser download | completes without threat removal | | |
| Extract all parts | complete common folder | | |
| Authenticode status | legacy: documented unsigned; SignPath: Valid | | |
| First launch | no prohibited block | | |
| Second launch | starts normally | | |
| Launch after reboot | starts normally | | |
| Upgrade | preserves user data and starts | | |
| Defender quick scan | no detection | | |

## Messages observed

Record exact Windows text, screenshot name and whether the test was stopped.

## Final result

- PASS / FAIL / BLOCKED:
- Release permitted:
- Notes:
