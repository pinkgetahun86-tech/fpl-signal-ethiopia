‎import {
‎  useCallback,
‎  useEffect,
‎  useMemo,
‎  useState,
‎  type FormEvent,
‎  type ReactNode,
‎} from 'react';
‎import {
‎  Activity,
‎  ArrowLeft,
‎  ArrowRight,
‎  BarChart3,
‎  Check,
‎  ChevronRight,
‎  CircleAlert,
‎  Clock3,
‎  Crown,
‎  Home,
‎  Info,
‎  LockKeyhole,
‎  Menu,
‎  MoreHorizontal,
‎  RefreshCw,
‎  Search,
‎  ShieldCheck,
‎  Sparkles,
‎  Target,
‎  Trophy,
‎  UserRound,
‎  Users,
‎  WalletCards,
‎  WifiOff,
‎  X,
‎  Zap,
‎} from 'lucide-react';
‎import { Link, useLocation } from 'wouter';
‎import {
‎  customFetch,
‎  getGetMiniAppBootstrapQueryKey,
‎  getHealthCheckQueryKey,
‎  type MiniAppBootstrap,
‎  type MiniAppPlayer,
‎  useGetMiniAppBootstrap,
‎  useHealthCheck,
‎  useRefreshMiniAppLeaderboard,
‎  useSaveMiniAppTeam,
‎} from '@workspace/api-client-react';
‎import { useQueryClient } from '@tanstack/react-query';
‎import { prepareTelegramApp } from '@/lib/telegram';
‎
‎type BuilderPhase = 'squad' | 'xi' | 'captains' | 'confirm';
‎type Position = MiniAppPlayer['position'];
‎type WalletTransaction = {
‎  id: number;
‎  type: string;
‎  amountEtb: number;
‎  balanceAfterEtb: number;
‎  reference: string;
‎  description: string;
‎  createdAt: string;
‎};
‎
‎type WalletDeposit = {
‎  id: number;
‎  method: string;
‎  amountEtb: number;
‎  transactionReference: string;
‎  status: string;
‎  adminNote: string | null;
‎  approvedAt: string | null;
‎  createdAt: string;
‎};
‎const positionOrder: Position[] = ['goalkeeper', 'defender', 'midfielder', 'forward'];
‎
‎const positionLabels: Record<string, string> = {
‎  goalkeeper: 'ግብ ጠባቂ',
‎  defender: 'ተከላካይ',
‎  midfielder: 'አማካይ',
‎  forward: 'አጥቂ',
‎};
‎
‎const positionShortLabels: Record<string, string> = {
‎  goalkeeper: 'ግጠ',
‎  defender: 'ተከ',
‎  midfielder: 'አማ',
‎  forward: 'አጥ',
‎};
‎
‎function cn(...classes: Array<string | false | null | undefined>) {
‎  return classes.filter(Boolean).join(' ');
‎}
‎
‎function formatDate(value: string | null | undefined) {
‎  if (!value) return 'ጊዜው አልተወሰነም';
‎  return new Intl.DateTimeFormat('am-ET', {
‎    day: 'numeric',
‎    month: 'short',
‎    hour: '2-digit',
‎    minute: '2-digit',
‎  }).format(new Date(value));
‎}
‎
‎function timeToDeadline(value: string | null | undefined) {
‎  if (!value) return 'ጊዜው አልተወሰነም';
‎  const difference = new Date(value).getTime() - Date.now();
‎  if (difference <= 0) return 'ተዘግቷል';
‎  const hours = Math.floor(difference / 3_600_000);
‎  const minutes = Math.floor((difference % 3_600_000) / 60_000);
‎  return `${hours}ሰ ${minutes}ደ`;
‎}
‎
‎function price(value: number) {
‎  return `£${value.toFixed(1)}m`;
‎}
‎
‎function playerStatus(player: MiniAppPlayer) {
‎  if (player.status && player.status !== 'a') return 'ሁኔታ ይመልከቱ';
‎  if (player.chanceOfPlayingThisRound !== null && player.chanceOfPlayingThisRound < 75) {
‎    return `${player.chanceOfPlayingThisRound}% ዕድል`;
‎  }
‎  return 'ዝግጁ';
‎}
‎
‎function statusLabel(value: string) {
‎  if (value === 'confirmed') return 'ተረጋግጧል';
‎  if (value === 'awaiting_payment') return 'ክፍያ ይጠብቃል';
‎  if (value === 'not_registered') return 'አልተመዘገበም';
‎  if (value === 'fpl-live') return 'የFPL ቀጥታ ነጥብ';
‎  if (value === 'pending') return 'በመጠባበቅ ላይ';
‎  return value;
‎}
‎
‎function pointsSourceLabel(value: string) {
‎  if (value === 'fpl-live') return 'የFPL ቀጥታ ነጥብ';
‎  if (value === 'pending') return 'በመጠባበቅ ላይ';
‎  return value || 'ገና አልተጀመረም';
‎}
‎
‎function extractApiErrorMessage(error: unknown): string | null {
‎  if (!error || typeof error !== 'object') return null;
‎  const data = (error as { data?: unknown }).data;
‎  if (!data || typeof data !== 'object') return null;
‎  const message = (data as { error?: unknown }).error;
‎  return typeof message === 'string' && message.trim() ? message.trim() : null;
‎}
‎
‎type MiniAppDraft = {
‎  userId: number;
‎  gameweekId: number;
‎  selectedPlayerIds: number[];
‎  startingPlayerIds: number[];
‎  captainPlayerId: number | null;
‎  viceCaptainPlayerId: number | null;
‎  savedAt: number;
‎};
‎
‎const draftKeyPrefix = 'fpl-signal-draft:';
‎
‎function getDraftKey(userId: number, gameweekId: number) {
‎  return `${draftKeyPrefix}${userId}:${gameweekId}`;
‎}
‎
‎function clearUserDrafts(userId: number, keepKey?: string) {
‎  if (typeof window === 'undefined') return;
‎  const prefix = getDraftKey(userId, 0).slice(0, -1);
‎  try {
‎    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
‎      const key = window.localStorage.key(index);
‎      if (key?.startsWith(prefix) && key !== keepKey) window.localStorage.removeItem(key);
‎    }
‎  } catch {
‎    // Local storage may be unavailable in private browsing; the server remains authoritative.
‎  }
‎}
‎
‎function readDraft(key: string, userId: number, gameweekId: number, validIds: Set<number>): MiniAppDraft | null {
‎  if (typeof window === 'undefined') return null;
‎  try {
‎    const raw = window.localStorage.getItem(key);
‎    if (!raw) return null;
‎    const parsed: unknown = JSON.parse(raw);
‎    if (!parsed || typeof parsed !== 'object') return null;
‎    const draft = parsed as Partial<MiniAppDraft>;
‎    if (draft.userId !== userId || draft.gameweekId !== gameweekId || !Array.isArray(draft.selectedPlayerIds)) return null;
‎    const ids = (value: unknown[]) => [
‎      ...new Set(value.filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && validIds.has(id))),
‎    ];
‎    const selectedPlayerIds = ids(draft.selectedPlayerIds).slice(0, 15);
‎    const startingPlayerIds = ids(Array.isArray(draft.startingPlayerIds) ? draft.startingPlayerIds : []).filter((id) => selectedPlayerIds.includes(id)).slice(0, 11);
‎    const captainPlayerId =
‎      typeof draft.captainPlayerId === 'number' && Number.isInteger(draft.captainPlayerId) && startingPlayerIds.includes(draft.captainPlayerId)
‎        ? draft.captainPlayerId
‎        : null;
‎    const viceCaptainPlayerId =
‎      typeof draft.viceCaptainPlayerId === 'number' &&
‎      Number.isInteger(draft.viceCaptainPlayerId) &&
‎      startingPlayerIds.includes(draft.viceCaptainPlayerId)
‎        ? draft.viceCaptainPlayerId
‎        : null;
‎    return { userId, gameweekId, selectedPlayerIds, startingPlayerIds, captainPlayerId, viceCaptainPlayerId, savedAt: typeof draft.savedAt === 'number' ? draft.savedAt : Date.now() };
‎  } catch {
‎    return null;
‎  }
‎}
‎
‎function LogoMark({ small = false }: { small?: boolean }) {
‎  return (
‎    <div className={cn('brand-mark', small && 'brand-mark-small')} data-testid="brand-mark">
‎      <Activity className={small ? 'h-4 w-4' : 'h-5 w-5'} strokeWidth={2.7} />
‎    </div>
‎  );
‎}
‎
‎function Pill({
‎  children,
‎  tone = 'neutral',
‎}: {
‎  children: ReactNode;
‎  tone?: 'neutral' | 'mint' | 'gold' | 'danger';
‎}) {
‎  return <span className={cn('pill', `pill-${tone}`)}>{children}</span>;
‎}
‎
‎function LoadingState() {
‎  return (
‎    <div className="loading-screen">
‎      <div className="loading-logo"><LogoMark /></div>
‎      <div className="loading-line loading-line-wide" />
‎      <div className="loading-line" />
‎      <div className="loading-card" />
‎      <p>መረጃዎን በመጫን ላይ…</p>
‎    </div>
‎  );
‎}
‎
‎function ErrorState({ unauthenticated, onRetry }: { unauthenticated?: boolean; onRetry: () => void }) {
‎  return (
‎    <div className="error-screen">
‎      <div className="error-icon"><ShieldCheck className="h-7 w-7" /></div>
‎      <p className="eyebrow">FPL SIGNAL ETHIOPIA</p>
‎      <h1>{unauthenticated ? 'Telegram መግቢያ ያስፈልጋል' : 'ግንኙነት ተቋርጧል'}</h1>
‎      <p className="error-copy">
‎        {unauthenticated
‎          ? 'ይህን ገጽ ከTelegram ውስጥ ይክፈቱ። የቡድንዎ መረጃ በደህንነት እንዲመጣ የTelegram ማረጋገጫ ያስፈልጋል።'
‎          : 'የFPL Signal መረጃን ማግኘት አልተቻለም። እንደገና ይሞክሩ።'}
‎      </p>
‎      {!unauthenticated && (
‎        <button type="button" className="button button-primary" onClick={onRetry} data-testid="button-retry">
‎          <RefreshCw className="h-4 w-4" /> እንደገና ሞክር
‎        </button>
‎      )}
‎    </div>
‎  );
‎}
‎
‎function SectionTitle({
‎  eyebrow,
‎  title,
‎  note,
‎  action,
‎}: {
‎  eyebrow: string;
‎  title: string;
‎  note?: string;
‎  action?: ReactNode;
‎}) {
‎  return (
‎    <div className="section-title">
‎      <div>
‎        <p className="eyebrow">{eyebrow}</p>
‎        <h1>{title}</h1>
‎        {note && <p className="section-note">{note}</p>}
‎      </div>
‎      {action}
‎    </div>
‎  );
‎}
‎
‎function AppShell({ children, data }: { children: ReactNode; data: MiniAppBootstrap }) {
‎  const [location, setLocation] = useLocation();
‎  const [menuOpen, setMenuOpen] = useState(false);
‎  const firstName = data.user.firstName || data.user.username || 'ጓደኛ';
‎
‎  useEffect(() => {
‎    const app = window.Telegram?.WebApp;
‎    if (!app?.BackButton) return undefined;
‎    if (location === '/') {
‎      app.BackButton.hide();
‎      return undefined;
‎    }
‎    const handleBack = () => setLocation('/');
‎    app.BackButton.show();
‎    app.BackButton.onClick(handleBack);
‎    return () => app.BackButton?.offClick?.(handleBack);
‎  }, [location, setLocation]);
‎
‎  const navItems = [
‎  { href: '/', label: 'መነሻ', icon: Home, active: location === '/' },
‎  { href: '/challenge', label: 'Weekly Challenge', icon: Trophy, active: location === '/challenge' },
‎  { href: '/team', label: 'ቡድኔ', icon: Users, active: location === '/team' },
‎  { href: '/leaderboard', label: 'ደረጃ', icon: Trophy, active: location === '/leaderboard' },
‎  { href: '/wallet', label: 'Wallet', icon: WalletCards, active: location === '/wallet' },
‎  { href: '/about', label: 'ተጨማሪ', icon: MoreHorizontal, active: ['/about', '/points', '/signal'].includes(location) },
‎];
‎
‎  return (
‎    <div className="app-shell">
‎      <div className="brand-watermark" aria-hidden="true">FPL</div>
‎      <header className="app-header">
‎        <div className="header-left">
‎          <button type="button" className="icon-button mobile-only" onClick={() => setMenuOpen(true)} aria-label="ምናሌ ክፈት">
‎            <Menu className="h-5 w-5" />
‎          </button>
‎          <LogoMark small />
‎          <div>
‎            <p className="brand-name">FPL Signal</p>
‎            <p className="brand-subtitle">Ethiopia</p>
‎          </div>
‎        </div>
‎        <div className="header-user">
‎          <div className="header-user-copy">
‎            <strong>{firstName}</strong>
‎            <span>ሳምንት {data.gameweek.id}</span>
‎          </div>
‎          <div className="avatar"><UserRound className="h-4 w-4" /></div>
‎        </div>
‎      </header>
‎
‎      {menuOpen && (
‎        <div className="mobile-drawer-backdrop" onClick={() => setMenuOpen(false)}>
‎          <aside className="mobile-drawer" onClick={(event) => event.stopPropagation()}>
‎            <div className="drawer-header">
‎              <div className="header-left"><LogoMark small /><div><p className="brand-name">FPL Signal</p><p className="brand-subtitle">Ethiopia</p></div></div>
‎              <button type="button" className="icon-button" onClick={() => setMenuOpen(false)} aria-label="ዝጋ"><X className="h-5 w-5" /></button>
‎            </div>
‎            <nav className="drawer-links">
‎              {navItems.map((item) => {
‎                const Icon = item.icon;
‎                return <Link key={item.href} href={item.href} onClick={() => setMenuOpen(false)} className={cn('drawer-link', item.active && 'drawer-link-active')}><Icon className="h-5 w-5" />{item.label}</Link>;
‎              })}
‎            </nav>
‎          </aside>
‎        </div>
‎      )}
‎
‎      <main className="app-main">{children}</main>
‎
‎      <nav className="bottom-nav" aria-label="ዋና ምናሌ">
‎        {navItems.map((item) => {
‎          const Icon = item.icon;
‎          return <Link key={item.href} href={item.href} className={cn('bottom-nav-item', item.active && 'bottom-nav-item-active')} data-testid={`nav-${item.href === '/' ? 'home' : item.href.slice(1)}`}><Icon className="h-[19px] w-[19px]" /><span>{item.label}</span></Link>;
‎        })}
‎      </nav>
‎    </div>
‎  );
‎}
‎
‎function StatTile({ label, value, icon: Icon, tone = 'mint' }: { label: string; value: string | number; icon: typeof Activity; tone?: 'mint' | 'gold' | 'blue' }) {
‎  return (
‎    <div className={cn('stat-tile', `stat-tile-${tone}`)}>
‎      <Icon className="stat-icon h-4 w-4" />
‎      <strong>{value}</strong>
‎      <span>{label}</span>
‎    </div>
‎  );
‎}
‎
‎function HomePage({ data }: { data: MiniAppBootstrap }) {
‎  const currentUser = data.leaderboard.find((entry) => entry.isCurrentUser);
‎  const teamCount = data.team.selectedPlayerIds.length;
‎  const isReady = teamCount === 15 && data.team.startingPlayerIds.length === 11 && !!data.team.captainPlayerId && !!data.team.viceCaptainPlayerId;
‎
‎  return (
‎    <div className="page-stack">
‎      <section className="welcome-row">
‎        <div>
‎          <p className="eyebrow">FPL SIGNAL ETHIOPIA</p>
‎          <h1>ሰላም፣ {data.user.firstName || 'ጓደኛ'} 👋</h1>
‎          <p className="muted-copy">የዚህን ሳምንት ቡድንዎን እንገንባ።</p>
‎        </div>
‎        <div className="live-dot"><span /> ቀጥታ</div>
‎      </section>
‎
‎      <section className="challenge-hero">
‎        <div className="hero-orb hero-orb-one" />
‎        <div className="hero-orb hero-orb-two" />
‎        <div className="hero-content">
‎          <div className="hero-topline">
‎            <span className="hero-kicker"><Sparkles className="h-3.5 w-3.5" /> የሳምንቱ ውድድር</span>
‎            <Pill tone={data.gameweek.locked ? 'gold' : 'mint'}>{data.gameweek.locked ? 'ተዘግቷል' : 'ክፍት ነው'}</Pill>
‎          </div>
‎          <h2>ሳምንት {data.gameweek.id}</h2>
‎          <p className="hero-description">ቡድንዎን ይምረጡ፣ ቋሚ 11ዎን ያዘጋጁ፣ ይወዳደሩ።</p>
‎          <div className="hero-stats">
‎            <div><span>የመጨረሻ ጊዜ</span><strong>{data.gameweek.locked ? 'ተዘግቷል' : timeToDeadline(data.gameweek.deadlineTime)}</strong><small>{formatDate(data.gameweek.deadlineTime)}</small></div>
‎            <div><span>ተሳታፊዎች</span><strong>{data.leaderboard.length}</strong><small>የተመዘገቡ ቡድኖች</small></div>
‎          </div>
‎          <Link href="/challenge" className="button button-hero" data-testid="button-start-team">{data.gameweek.locked ? 'የእኔን ቡድን እይ' : 'ቡድኔን እመርጣለሁ'}<ArrowRight className="h-4 w-4" /></Link>
‎        </div>
‎      </section>
‎
‎      <section className="stat-grid">
‎        <StatTile label="ቡድኔ" value={`${teamCount}/15`} icon={Users} />
‎        <StatTile label="ነጥብ" value={data.team.points} icon={Zap} tone="gold" />
‎        <StatTile label="ደረጃ" value={currentUser ? `#${currentUser.rank}` : '—'} icon={Trophy} tone="blue" />
‎      </section>
‎
‎      <section className="simple-card">
‎        <div className="card-heading"><div><p className="eyebrow">የሚቀጥለው እርምጃ</p><h2>ቡድንዎን ያጠናቅቁ</h2></div><Target className="heading-icon" /></div>
‎        <div className="step-list">
‎          {(
‎            [
‎              ['01', '15 ተጫዋቾች ይምረጡ', teamCount === 15],
‎              ['02', 'ቋሚ 11 ያዘጋጁ', data.team.startingPlayerIds.length === 11],
‎              ['03', 'ካፒቴን እና ምክትል ይምረጡ', !!data.team.captainPlayerId && !!data.team.viceCaptainPlayerId],
‎              ['04', 'ቡድንዎን ያረጋግጡ', isReady && data.team.registered],
‎            ] as Array<[string, string, boolean]>
‎          ).map(([number, label, complete]) => (
‎            <div key={number} className={cn('step-row', complete && 'step-row-complete')}>
‎              <span className="step-number">{complete ? <Check className="h-4 w-4" /> : number}</span>
‎              <span>{label}</span>
‎              {complete ? <span className="step-status">ተጠናቋል</span> : <ChevronRight className="ml-auto h-4 w-4" />}
‎            </div>
‎          ))}
‎        </div>
‎      </section>
‎
‎      <section className="tip-card">
‎        <div className="tip-icon"><ShieldCheck className="h-5 w-5" /></div>
‎        <div><strong>ኦፊሴላዊ የFPL መረጃ</strong><p>ነጥቦችና የተጫዋቾች መረጃ ከFPL ቀጥታ ምንጭ ብቻ ይመጣሉ።</p></div>
‎      </section>
‎    </div>
‎  );
‎}
‎
‎function PlayerCard({
‎  player,
‎  selected,
‎  starter,
‎  captain,
‎  vice,
‎  onClick,
‎  disabled,
‎}: {
‎  player: MiniAppPlayer;
‎  selected?: boolean;
‎  starter?: boolean;
‎  captain?: boolean;
‎  vice?: boolean;
‎  onClick?: () => void;
‎  disabled?: boolean;
‎}) {
‎  const card = (
‎    <div className={cn('player-card', selected && 'player-card-selected', starter && 'player-card-starter', disabled && 'player-card-disabled')}>
‎      <div className="player-position">{positionShortLabels[player.position]}</div>
‎      <div className="player-main">
‎        <strong>{player.name}</strong>
‎        <span>{player.club} · {price(player.price)}</span>
‎      </div>
‎      <div className="player-action">
‎        {captain && <span className="role-badge role-badge-captain">C</span>}
‎        {vice && <span className="role-badge role-badge-vice">VC</span>}
‎        {!captain && !vice && (selected ? <Check className="h-5 w-5 text-mint" /> : <span className="select-label">ምረጥ</span>)}
‎      </div>
‎    </div>
‎  );
‎  return onClick ? <button type="button" className="player-card-button" onClick={onClick} disabled={disabled}>{card}</button> : <div>{card}</div>;
‎}
‎
‎function BuilderSummary({
‎  selected,
‎  budgetUsed,
‎  starters,
‎  captain,
‎  vice,
‎}: {
‎  selected: number;
‎  budgetUsed: number;
‎  starters: number;
‎  captain: boolean;
‎  vice: boolean;
‎}) {
‎  return (
‎    <div className="builder-summary">
‎      <div><strong>{selected}<small>/15</small></strong><span>ተጫዋቾች</span></div>
‎      <div><strong>{price(Math.max(0, 100 - budgetUsed))}</strong><span>የቀረው በጀት</span></div>
‎      <div><strong>{starters}<small>/11</small></strong><span>ቋሚ 11</span></div>
‎      <div><strong className={cn(captain && 'summary-ready')}>{captain ? '✓' : '—'}</strong><span>ካፒቴን</span></div>
‎      <div><strong className={cn(vice && 'summary-ready')}>{vice ? '✓' : '—'}</strong><span>ምክትል</span></div>
‎    </div>
‎  );
‎}
‎
‎function StepRail({ phase, setPhase, locked }: { phase: BuilderPhase; setPhase: (phase: BuilderPhase) => void; locked: boolean }) {
‎  const steps: Array<{ key: BuilderPhase; label: string }> = [
‎    { key: 'squad', label: 'ቡድን' },
‎    { key: 'xi', label: 'ቋሚ 11' },
‎    { key: 'captains', label: 'ካፒቴን' },
‎    { key: 'confirm', label: 'ማረጋገጫ' },
‎  ];
‎  const activeIndex = steps.findIndex((step) => step.key === phase);
‎  return (
‎    <div className="step-rail">
‎      {steps.map((step, index) => (
‎        <button type="button" key={step.key} className={cn('step-rail-item', index <= activeIndex && 'step-rail-item-active')} onClick={() => !locked && index <= activeIndex && setPhase(step.key)} disabled={locked || index > activeIndex}>
‎          <span>{index < activeIndex ? <Check className="h-3 w-3" /> : index + 1}</span>
‎          {step.label}
‎        </button>
‎      ))}
‎    </div>
‎  );
‎}
‎
‎function PositionTabs({ active, setActive }: { active: Position; setActive: (position: Position) => void }) {
‎  return (
‎    <div className="position-tabs" role="tablist" aria-label="የተጫዋች ቦታ">
‎      {positionOrder.map((position) => <button type="button" role="tab" aria-selected={active === position} key={position} className={cn('position-tab', active === position && 'position-tab-active')} onClick={() => setActive(position)}>{positionLabels[position]}</button>)}
‎    </div>
‎  );
‎}
‎
‎function TeamPitch({
‎  players,
‎  starters,
‎  captain,
‎  vice,
‎  onToggle,
‎  selectable,
‎}: {
‎  players: MiniAppPlayer[];
‎  starters: number[];
‎  captain?: number | null;
‎  vice?: number | null;
‎  onToggle?: (id: number) => void;
‎  selectable?: boolean;
‎}) {
‎  const byPosition = positionOrder.map((position) => ({
‎    position,
‎    players: players.filter((player) => player.position === position && starters.includes(player.id)),
‎  }));
‎  return (
‎    <div className="football-pitch">
‎      <div className="pitch-circle" />
‎      <div className="pitch-lines" />
‎      <div className="pitch-rows">
‎        {[...byPosition].reverse().map(({ position, players: row }) => (
‎          <div className="pitch-row" key={position}>
‎            {row.map((player) => {
‎              const chip = <div className="pitch-player"><div className={cn('pitch-avatar', captain === player.id && 'pitch-avatar-captain', vice === player.id && 'pitch-avatar-vice')}>{captain === player.id ? 'C' : vice === player.id ? 'VC' : positionShortLabels[player.position]}</div><span>{player.name}</span></div>;
‎              return selectable && onToggle ? <button type="button" key={player.id} onClick={() => onToggle(player.id)} className="pitch-player-button">{chip}</button> : <div key={player.id}>{chip}</div>;
‎            })}
‎            {!row.length && <span className="pitch-empty">{positionLabels[position]}</span>}
‎          </div>
‎        ))}
‎      </div>
‎    </div>
‎  );
‎}
‎function ChallengePage({ data, update }: { data: MiniAppBootstrap; update: (next: MiniAppBootstrap) => void }) {
‎  const locked = data.gameweek.locked;
‎  const [phase, setPhase] = useState<BuilderPhase>('squad');
‎  const [position, setPosition] = useState<Position>('goalkeeper');
‎  const [selected, setSelected] = useState<number[]>(data.team.selectedPlayerIds);
‎  const [starters, setStarters] = useState<number[]>(data.team.startingPlayerIds);
‎  const [captain, setCaptain] = useState<number | null>(data.team.captainPlayerId);
‎  const [vice, setVice] = useState<number | null>(data.team.viceCaptainPlayerId);
‎  const [captainMode, setCaptainMode] = useState<'captain' | 'vice'>('captain');
‎  const [paymentError, setPaymentError] = useState<string | null>(null);
‎  const [walletBalance, setWalletBalance] = useState<number | null>(null);
‎  const [walletLoading, setWalletLoading] = useState(false);
‎  const [walletPaymentLoading, setWalletPaymentLoading] = useState(false);
‎  const [entryFeeEtb, setEntryFeeEtb] = useState<number | null>(null);
‎  const [competitionLoading, setCompetitionLoading] = useState(false);
‎
‎  useEffect(() => {
‎    if (data.team.submissionStatus !== 'awaiting_payment') {
‎      setWalletBalance(null);
‎      return;
‎    }
‎
‎    let active = true;
‎
‎    const loadWalletBalance = async () => {
‎      setWalletLoading(true);
‎
‎      try {
‎        const result = await customFetch<{ balanceEtb: number }>(
‎          '/api/mini-app/wallet',
‎          {
‎            method: 'GET',
‎            responseType: 'json',
‎          },
‎        );
‎
‎        if (active) {
‎          setWalletBalance(result.balanceEtb);
‎        }
‎      } catch {
‎        if (active) {
‎          setWalletBalance(null);
‎        }
‎      } finally {
‎        if (active) {
‎          setWalletLoading(false);
‎        }
‎      }
‎    };
‎
‎    void loadWalletBalance();
‎
‎    return () => {
‎      active = false;
‎    };
‎  }, [data.team.submissionStatus]);
‎
‎  useEffect(() => {
‎    if (data.team.submissionStatus !== 'awaiting_payment') {
‎      setEntryFeeEtb(null);
‎      return;
‎    }
‎
‎    let active = true;
‎
‎    const loadCompetition = async () => {
‎      setCompetitionLoading(true);
‎
‎      try {
‎        const result = await customFetch<{
‎          competitionId: number;
‎          gameweek: number;
‎          entryFeeEtb: number;
‎          currency: string;
‎          status: string;
‎          locked: boolean;
‎          deadlineTime: string | null;
‎        }>('/api/mini-app/competition/current', {
‎          method: 'GET',
‎          responseType: 'json',
‎        });
‎
‎        if (active) {
‎          setEntryFeeEtb(result.entryFeeEtb);
‎        }
‎      } catch {
‎        if (active) {
‎          setEntryFeeEtb(null);
‎        }
‎      } finally {
‎        if (active) {
‎          setCompetitionLoading(false);
‎        }
‎      }
‎    };
‎
‎    void loadCompetition();
‎
‎    return () => {
‎      active = false;
‎    };
‎  }, [data.team.submissionStatus]);
‎
‎  const saveTeam = useSaveMiniAppTeam();
‎  const byId = useMemo(() => new Map(data.players.map((player) => [player.id, player])), [data.players]);
‎  const validPlayerIds = useMemo(() => new Set(data.players.map((player) => player.id)), [data.players]);
‎  const draftKey = useMemo(() => getDraftKey(data.user.telegramId, data.gameweek.id), [data.user.telegramId, data.gameweek.id]);
‎  const [draftScope, setDraftScope] = useState<string | null>(null);
‎  const selectedPlayers = selected.map((id) => byId.get(id)).filter(Boolean) as MiniAppPlayer[];
‎  const starterPlayers = starters.map((id) => byId.get(id)).filter(Boolean) as MiniAppPlayer[];
‎  const budgetUsed = selectedPlayers.reduce((sum, player) => sum + player.price, 0);
‎  const filteredPlayers = data.players.filter((player) => player.position === position);
‎  const canMoveToXi = selected.length === 15;
‎  const canMoveToCaptains = starters.length === 11;
‎  const canConfirm = starters.length === 11 && !!captain && !!vice && captain !== vice;
‎
‎  useEffect(() => {
‎    setDraftScope(null);
‎    setSelected(data.team.selectedPlayerIds);
‎    setStarters(data.team.startingPlayerIds);
‎    setCaptain(data.team.captainPlayerId);
‎    setVice(data.team.viceCaptainPlayerId);
‎
‎    if (typeof window === 'undefined') {
‎      setDraftScope(draftKey);
‎      return;
‎    }
‎
‎    const shouldRestoreDraft = !locked && !data.team.registered;
‎    clearUserDrafts(data.user.telegramId, shouldRestoreDraft ? draftKey : undefined);
‎    if (shouldRestoreDraft) {
‎      const draft = readDraft(draftKey, data.user.telegramId, data.gameweek.id, validPlayerIds);
‎      if (draft) {
‎        setSelected(draft.selectedPlayerIds);
‎        setStarters(draft.startingPlayerIds);
‎        setCaptain(draft.captainPlayerId);
‎        setVice(draft.viceCaptainPlayerId);
‎      }
‎    }
‎    setDraftScope(draftKey);
‎  }, [
‎    data.gameweek.id,
‎    data.team.captainPlayerId,
‎    data.team.registered,
‎    data.team.selectedPlayerIds,
‎    data.team.startingPlayerIds,
‎    data.team.viceCaptainPlayerId,
‎    data.user.telegramId,
‎    draftKey,
‎    locked,
‎    validPlayerIds,
‎  ]);
‎
‎  useEffect(() => {
‎    if (draftScope !== draftKey || typeof window === 'undefined') return;
‎    if (locked || data.team.registered) {
‎      clearUserDrafts(data.user.telegramId);
‎      return;
‎    }
‎    const draft: MiniAppDraft = {
‎      userId: data.user.telegramId,
‎      gameweekId: data.gameweek.id,
‎      selectedPlayerIds: selected,
‎      startingPlayerIds: starters,
‎      captainPlayerId: captain,
‎      viceCaptainPlayerId: vice,
‎      savedAt: Date.now(),
‎    };
‎    try {
‎      window.localStorage.setItem(draftKey, JSON.stringify(draft));
‎    } catch {
‎      // Local storage may be unavailable; the current in-memory selection still works.
‎    }
‎  }, [captain, data.gameweek.id, data.team.registered, data.user.telegramId, draftKey, draftScope, locked, selected, starters, vice]);
‎
‎  const toggleSelected = (id: number) => {
‎    if (locked) return;
‎    if (selected.includes(id)) {
‎      setSelected((items) => items.filter((item) => item !== id));
‎      setStarters((items) => items.filter((item) => item !== id));
‎      if (captain === id) setCaptain(null);
‎      if (vice === id) setVice(null);
‎      return;
‎    }
‎    if (selected.length < 15) setSelected((items) => [...items, id]);
‎  };
‎
‎  const toggleStarter = (id: number) => {
‎    if (locked || !selected.includes(id)) return;
‎    if (starters.includes(id)) {
‎      setStarters((items) => items.filter((item) => item !== id));
‎      if (captain === id) setCaptain(null);
‎      if (vice === id) setVice(null);
‎    } else if (starters.length < 11) {
‎      setStarters((items) => [...items, id]);
‎    }
‎  };
‎
‎  const chooseCaptain = (id: number) => {
‎    if (captainMode === 'captain') {
‎      setCaptain(id);
‎      if (vice === id) setVice(null);
‎    } else {
‎      setVice(id);
‎      if (captain === id) setCaptain(null);
‎    }
‎  };
‎
‎  const submit = () => {
‎    if (!canConfirm || locked) return;
‎    setPaymentError(null);
‎    saveTeam.mutate(
‎      { data: { selectedPlayerIds: selected, startingPlayerIds: starters, captainPlayerId: captain!, viceCaptainPlayerId: vice! } },
‎      {
‎        onSuccess: (next) => {
‎          clearUserDrafts(data.user.telegramId);
‎          update(next);
‎        },
‎      },
‎    );
‎  };
‎
‎  useEffect(() => {
‎    if (data.team.submissionStatus !== 'awaiting_payment') return undefined;
‎    let active = true;
‎    let timer: ReturnType<typeof setTimeout> | undefined;
‎    const checkPayment = async () => {
‎      try {
‎        const result = await customFetch<{ status: 'not_started' | 'pending' | 'success' | 'failed' }>('/api/mini-app/payment/status', { method: 'GET', responseType: 'json' });
‎        if (!active) return;
‎        if (result.status === 'success') {
‎          const refreshed = await customFetch<MiniAppBootstrap>('/api/mini-app/bootstrap', { method: 'GET', responseType: 'json' });
‎          if (active) update(refreshed);
‎          return;
‎        }
‎        timer = setTimeout(checkPayment, 5000);
‎      } catch {
‎        if (active) timer = setTimeout(checkPayment, 7000);
‎      }
‎    };
‎    void checkPayment();
‎    return () => {
‎      active = false;
‎      if (timer) clearTimeout(timer);
‎    };
‎  }, [data.team.submissionStatus, update]);
‎
‎  const payWithWallet = async () => {
‎  if (walletBalance === null || walletBalance < 100) {
‎    setPaymentError('በWallet ውስጥ ቢያንስ 100 ETB ያስፈልጋል።');
‎  
‎
