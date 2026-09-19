# DSH Desktop

Desktop GUI application for DSH (DeepSeek Harness) multi-project AI orchestration.

## Architecture

P6-W1 CORE DESKTOP FOUNDATION - Read-only control center with runtime supervision.

This is Wave 1 of 3. GUI task submission and approvals are Wave 2.

## Technology Stack

- **Electron** 28.x - Desktop application framework
- **React** 18.x - UI framework
- **TypeScript** 5.x - Type-safe development
- **Vite** - Fast build tool

## Requirements

- Node.js 20+
- Windows (primary target)
- Visual Studio Build Tools (for native modules)

## Development

```bash
# Install dependencies
npm install

# Start development mode (hot reload)
npm run dev

# Build for production
npm run build

# Run tests
npm test
```

## Package for Distribution

```bash
# Create Windows installer
npm run dist:win

# Create portable build (no installer)
npm run pack
```

## Architecture Overview

```
DSH Desktop (Electron)
├── Main Process
│   ├── RuntimeSupervisor - Manages separate runtime process
│   ├── NamedPipeClient - Communicates with runtime
│   ├── ReadProjection - Read-only DB access (PostgreSQL + SQLite)
│   └── IPC Handlers - Closed API surface
├── Preload - Security boundary with typed API
└── Renderer (React) - UI components
```

## Security

- Context isolation enabled
- Node integration disabled
- Sandbox enabled
- Strict CSP
- Closed preload API (no generic IPC)
- Read-only database access
- Secrets never exposed to renderer

## Features (W1)

✅ Runtime supervision (start/stop/restart)
✅ Named pipe control protocol
✅ Read-only project timeline
✅ Connection center (backend status)
✅ Activity logs
✅ Single instance enforcement
✅ Background operation (tray)
✅ Windows graceful shutdown

❌ Task submission (W2)
❌ Project editing (W2)
❌ Approvals (W2)

## Documentation

See `docs/p6/implementation/` for detailed architecture documentation:

- `01_W1_DESKTOP_FOUNDATION.md` - Overview
- `02_W1_RUNTIME_SUPERVISION.md` - Process management
- `03_W1_LOCAL_PIPE_PROTOCOL.md` - IPC protocol
- `04_W1_READ_PROJECTION.md` - Database access
- `05_W1_SECURITY_BOUNDARY.md` - Security model
- `06_W1_WINDOWS_PACKAGE_AND_CANARY.md` - Build and testing

## License

Private - Part of DSH project
