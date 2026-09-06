# FPL Signal Ethiopia 🇪🇹

**DATA • STRATEGY • SIGNAL**

A production-quality Telegram Mini App for Fantasy Premier League players in Ethiopia, providing data-driven insights and strategic guidance.

## Features

- 🏆 **Weekly Challenge** - Compete in weekly FPL challenges
- 👥 **Squad Management** - Build and manage your 15-player squad
- 📊 **Live Leaderboard** - Track rankings and scores
- ⚽ **Official FPL Points** - Real-time scoring from Fantasy Premier League
- 📡 **FPL Signal** - Data-driven insights and recommendations
- 🎯 **Formation Validation** - Automatic formation checking
- 🔒 **Deadline Locking** - Secure submission deadlines
- 🤖 **Automatic Substitutions** - Smart bench replacements

## Architecture

```
Telegram Bot
    ↓
Telegram Mini App
    ↓
Existing API/Backend
    ↓
Existing Database
    ↓
FPL Scoring System
```

## Project Structure

```
fpl-signal-ethiopia/
├── packages/
│   ├── api-server/          # Backend API server
│   ├── telegram-miniapp/    # Telegram Mini App frontend
│   └── shared-types/        # Shared TypeScript types
├── lib/
│   └── db/                  # Database layer
├── docs/                    # Documentation
├── .github/
│   └── workflows/          # CI/CD workflows
└── README.md
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm or pnpm
- PostgreSQL (for existing database)
- Telegram Bot Token

### Installation

```bash
npm install
npm run build
```

### Development

```bash
npm run dev
```

### Environment Variables

Create `.env.local` in the root:

```
DATABASE_URL=postgresql://...
TELEGRAM_BOT_TOKEN=your_bot_token
API_SERVER_URL=http://localhost:3000
MINIAPP_URL=http://localhost:3001
```

## Documentation

- [API Documentation](./docs/api.md)
- [Database Schema](./docs/schema.md)
- [Mini App Guide](./docs/miniapp.md)
- [Deployment](./docs/deployment.md)

## Language

All user-facing UI text is in Amharic (አማርኛ) with English brand elements.

## Security

- Server-side Telegram initData validation
- No client-side user identification
- Secure authentication tokens
- Gameweek deadline enforcement
- Input validation and sanitization

## License

MIT

## Support

For issues or questions, open a GitHub issue.
