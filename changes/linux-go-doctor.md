### Changed

- **Linux `npm run go` and a wider doctor (moonshot unit 8).** On Linux, `npm run go` fast-forwards a clean checkout, runs setup, runs doctor, and starts the bridge supervisor. Doctor now has eight checks (Node.js, python3, agent login, X11, client folder, installed slots, the bridge process, and combat-log files) and probes all six agent CLIs. [docs/INSTALL-LINUX.md](../docs/INSTALL-LINUX.md) adds a six-step Quick start with log-in-once and combat-logging steps.
