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
‎  
‎‎  const payWithWallet = async () => {
    if (entryFeeEtb === null) {
      setPaymentError(
        'የውድድሩን መግቢያ ክፍያ ማግኘት አልተቻለም።',
      );
      return;
    }

    if (walletBalance === null || walletBalance < entryFeeEtb) {
      setPaymentError(
        `በWallet ውስጥ ቢያንስ ${entryFeeEtb} ETB ያስፈልጋል።`,
      );
      return;
    }

    setWalletPaymentLoading(true);
    setPaymentError(null);

    try {
      const result = await customFetch<
        MiniAppBootstrap & {
          wallet: {
            balanceEtb: number;
            currency: string;
          };
          payment: {
            method: 'wallet';
            status: 'success';
            amountEtb: number;
            alreadyConfirmed: boolean;
          };
        }
      >('/api/mini-app/wallet/entry', {
        method: 'POST',
        responseType: 'json',
      });

      setWalletBalance(result.wallet.balanceEtb);
      update(result);
    } catch (error) {
      setPaymentError(
        extractApiErrorMessage(error) ??
          'በWallet መክፈል አልተሳካም።',
      );
    } finally {
      setWalletPaymentLoading(false);
    }
  };
‎  return (
‎    <div className="page-stack">
‎      <SectionTitle
‎        eyebrow="የሳምንቱ ውድድር"
‎        title={`ሳምንት ${data.gameweek.id} ቡድን`}
‎        note={
‎          data.gameweek.locked
‎            ? 'ይህ ሳምንት ተዘግቷል።'
‎            : 'በቀላሉ ይምረጡና ይወዳደሩ።'
‎        }
‎        action={
‎          <Pill tone={locked ? 'gold' : 'mint'}>
‎            {locked ? (
‎              <>
‎                <LockKeyhole className="h-3 w-3" /> ተዘግቷል
‎              </>
‎            ) : (
‎              'ክፍት ነው'
‎            )}
‎          </Pill>
‎        }
‎      />
‎
‎      {locked && (
‎        <div className="notice notice-gold">
‎          <LockKeyhole className="h-4 w-4 shrink-0" />
‎          <span>
‎            Deadline ካለፈ በኋላ ቡድን መቀየር አይቻልም።
‎          </span>
‎        </div>
‎      )}
‎
‎      <BuilderSummary
‎        selected={selected.length}
‎        budgetUsed={budgetUsed}
‎        starters={starters.length}
‎        captain={!!captain}
‎        vice={!!vice}
‎      />
‎
‎      <StepRail
‎        phase={phase}
‎        setPhase={setPhase}
‎        locked={locked}
‎      />
‎
‎      {phase === 'squad' && (
‎        <section className="builder-card">
‎          <div className="builder-card-heading">
‎            <div>
‎              <p className="eyebrow">ደረጃ 1</p>
‎              <h2>15 ተጫዋቾች ይምረጡ</h2>
‎              <p className="section-note">
‎                ቦታ ይምረጡ፣ ከዚያ ተጫዋች ይጨምሩ።
‎              </p>
‎            </div>
‎            <Users className="heading-icon" />
‎          </div>
‎
‎          <PositionTabs
‎            active={position}
‎            setActive={setPosition}
‎          />
‎
‎          <div className="player-list">
‎            {filteredPlayers.map((player) => (
‎              <PlayerCard
‎                key={player.id}
‎                player={player}
‎                selected={selected.includes(player.id)}
‎                onClick={() => toggleSelected(player.id)}
‎                disabled={
‎                  locked ||
‎                  (!selected.includes(player.id) &&
‎                    selected.length >= 15)
‎                }
‎              />
‎            ))}
‎          </div>
‎
‎          {!filteredPlayers.length && (
‎            <div className="empty-inline">
‎              ለዚህ ቦታ ተጫዋች አልተገኘም።
‎            </div>
‎          )}
‎
‎          <div className="builder-footer">
‎            <span>
‎              {selected.length === 15
‎                ? 'ቡድንዎ ተሟልቷል።'
‎                : `${15 - selected.length} ተጫዋች ቀርቷል።`}
‎            </span>
‎
‎            <button
‎              type="button"
‎              className="button button-primary"
‎              disabled={!canMoveToXi || locked}
‎              onClick={() => setPhase('xi')}
‎            >
‎              ቋሚ 11 ምረጥ
‎              <ArrowRight className="h-4 w-4" />
‎            </button>
‎          </div>
‎        </section>
‎      )}
‎
‎      {phase === 'xi' && (
‎        <section className="builder-card">
‎          <div className="builder-card-heading">
‎            <div>
‎              <p className="eyebrow">ደረጃ 2</p>
‎              <h2>ቋሚ 11 ምረጥ</h2>
‎              <p className="section-note">
‎                በሜዳው ላይ የሚጀምሩትን 11 ተጫዋቾች ይምረጡ።
‎              </p>
‎            </div>
‎            <Target className="heading-icon" />
‎          </div>
‎
‎          <TeamPitch
‎            players={selectedPlayers}
‎            starters={starters}
‎            onToggle={toggleStarter}
‎            selectable={!locked}
‎          />
‎
‎          <div className="player-list compact-list">
‎            {selectedPlayers.map((player) => (
‎              <PlayerCard
‎                key={player.id}
‎                player={player}
‎                selected={starters.includes(player.id)}
‎                starter={starters.includes(player.id)}
‎                onClick={() => toggleStarter(player.id)}
‎                disabled={locked}
‎              />
‎            ))}
‎          </div>
‎
‎          <div className="builder-footer">
‎            <button
‎              type="button"
‎              className="button button-ghost"
‎              onClick={() => setPhase('squad')}
‎            >
‎              <ArrowLeft className="h-4 w-4" />
‎              ተመለስ
‎            </button>
‎
‎            <button
‎              type="button"
‎              className="button button-primary"
‎              disabled={!canMoveToCaptains || locked}
‎              onClick={() => setPhase('captains')}
‎            >
‎              ካፒቴን ምረጥ
‎              <ArrowRight className="h-4 w-4" />
‎            </button>
‎          </div>
‎        </section>
‎      )}
‎
‎      {phase === 'captains' && (
‎        <section className="builder-card">
‎          <div className="builder-card-heading">
‎            <div>
‎              <p className="eyebrow">ደረጃ 3</p>
‎              <h2>ካፒቴን ይምረጡ</h2>
‎              <p className="section-note">
‎                ካፒቴን 2x ነጥብ ያገኛል።
‎              </p>
‎            </div>
‎            <Crown className="heading-icon gold-icon" />
‎          </div>
‎
‎          <div className="role-switch">
‎            <button
‎              type="button"
‎              className={cn(
‎                captainMode === 'captain' &&
‎                  'role-switch-active',
‎              )}
‎              onClick={() => setCaptainMode('captain')}
‎            >
‎              <Crown className="h-4 w-4" />
‎              ካፒቴን {captain && '✓'}
‎            </button>
‎
‎            <button
‎              type="button"
‎              className={cn(
‎                captainMode === 'vice' &&
‎                  'role-switch-active',
‎              )}
‎              onClick={() => setCaptainMode('vice')}
‎            >
‎              <ShieldCheck className="h-4 w-4" />
‎              ምክትል {vice && '✓'}
‎            </button>
‎          </div>
‎
‎          <div className="player-list">
‎            {starterPlayers.map((player) => (
‎              <PlayerCard
‎                key={player.id}
‎                player={player}
‎                selected={
‎                  captain === player.id ||
‎                  vice === player.id
‎                }
‎                captain={captain === player.id}
‎                vice={vice === player.id}
‎                onClick={() => chooseCaptain(player.id)}
‎                disabled={locked}
‎              />
‎            ))}
‎          </div>
‎
‎          <div className="builder-footer">
‎            <button
‎              type="button"
‎              className="button button-ghost"
‎              onClick={() => setPhase('xi')}
‎            >
‎              <ArrowLeft className="h-4 w-4" />
‎              ተመለስ
‎            </button>
‎
‎            <button
‎              type="button"
‎              className="button button-primary"
‎              disabled={!canConfirm || locked}
‎              onClick={() => setPhase('confirm')}
‎            >
‎              ቡድኔን አረጋግጥ
‎              <ArrowRight className="h-4 w-4" />
‎            </button>
‎          </div>
‎        </section>
‎      )}
‎
‎      {phase === 'confirm' && (
‎        <section className="builder-card">
‎          <div className="builder-card-heading">
‎            <div>
‎              <p className="eyebrow">ደረጃ 4</p>
‎              <h2>የእርስዎ ቡድን</h2>
‎              <p className="section-note">
‎                ሁሉም ነገር ትክክል ከሆነ ያረጋግጡ።
‎              </p>
‎            </div>
‎            <Check className="heading-icon" />
‎          </div>
‎
‎          <div className="confirm-card">
‎            <div>
‎              <span>15 ተጫዋቾች</span>
‎              <strong>{selected.length}/15</strong>
‎            </div>
‎
‎            <div>
‎              <span>ቋሚ 11</span>
‎              <strong>{starters.length}/11</strong>
‎            </div>
‎
‎            <div>
‎              <span>ካፒቴን</span>
‎              <strong>
‎                {byId.get(captain ?? 0)?.name ?? '—'}
‎              </strong>
‎            </div>
‎
‎            <div>
‎              <span>ምክትል ካፒቴን</span>
‎              <strong>
‎                {byId.get(vice ?? 0)?.name ?? '—'}
‎              </strong>
‎            </div>
‎
‎            <div>
‎              <span>የቀረው በጀት</span>
‎              <strong>
‎                {price(Math.max(0, 100 - budgetUsed))}
‎              </strong>
‎            </div>
‎          </div>
‎
‎          <TeamPitch
‎            players={selectedPlayers}
‎            starters={starters}
‎            captain={captain}
‎            vice={vice}
‎          />
‎
‎          {data.team.submissionStatus ===
‎            'awaiting_payment' && (
‎            <div className="payment-card">
‎              <div className="payment-icon">
‎                <WalletCards className="h-5 w-5" />
‎              </div>
‎
‎              <div className="payment-copy">
‎                <strong>
‎                  የውድድሩን ክፍያ ያጠናቁ
‎                </strong>
‎
‎                <p>
‎                  {entryFeeEtb === null
‎                    ? 'የውድድሩን መግቢያ ክፍያ በመጫን ላይ…'
‎                    : `የWeekly Challenge መግቢያ ${entryFeeEtb} ETB ነው።`}
‎                </p>
‎
‎                <div className="step-list">
‎                  <div className="step-row">
‎                    <WalletCards className="h-4 w-4" />
‎
‎                    <span>
‎                      Wallet ቀሪ ሂሳብ:{' '}
‎                      {walletLoading
‎                        ? 'በመጫን ላይ…'
‎                        : `${walletBalance ?? 0} ETB`}
‎                    </span>
‎                  </div>
‎                </div>
‎              </div>
‎
‎              <div className="payment-actions">
‎                <button
‎                  type="button"
‎                  className="button button-primary"
‎                  onClick={() => void payWithWallet()}
‎                  disabled={
‎                    competitionLoading ||
‎                    walletLoading ||
‎                    walletPaymentLoading ||
‎                    entryFeeEtb === null ||
‎                    walletBalance === null ||
‎                    walletBalance < entryFeeEtb
‎                  }
‎                >
‎                  {walletPaymentLoading ? (
‎                    <RefreshCw className="h-4 w-4 animate-spin" />
‎                  ) : (
‎                    <WalletCards className="h-4 w-4" />
‎                  )}
‎
‎                  {walletPaymentLoading
‎                    ? 'በመክፈል ላይ…'
‎                    : entryFeeEtb === null
‎                      ? 'ክፍያውን በመጫን ላይ…'
‎                      : `በWallet ${entryFeeEtb} ETB ክፈል`}
‎                </button>
‎              </div>
‎
‎              {walletBalance !== null &&
‎                entryFeeEtb !== null &&
‎                walletBalance < entryFeeEtb && (
‎                  <p className="form-error">
‎                    በWallet ውስጥ በቂ ገንዘብ የለም።
‎                    Wallet ይሙሉ።
‎                  </p>
‎                )}
‎            </div>
‎          )}
‎
‎          {paymentError && (
‎            <p className="form-error">
‎              {paymentError}
‎            </p>
‎          )}
‎
‎          <div className="builder-footer">
‎            <button
‎              type="button"
‎              className="button button-ghost"
‎              onClick={() => setPhase('captains')}
‎            >
‎              <ArrowLeft className="h-4 w-4" />
‎              ተመለስ
‎            </button>
‎
‎            <button
‎              type="button"
‎              className="button button-primary button-large"
‎              disabled={
‎                !canConfirm ||
‎                locked ||
‎                saveTeam.isPending
‎              }
‎              onClick={submit}
‎              data-testid="button-confirm-team"
‎            >
‎              {saveTeam.isPending ? (
‎                <RefreshCw className="h-4 w-4 animate-spin" />
‎              ) : (
‎                <Check className="h-4 w-4" />
‎              )}
‎
‎              {saveTeam.isPending
‎                ? 'በመላክ ላይ…'
‎                : data.team.registered
‎                  ? 'ለውጡን አስቀምጥ'
‎                  : 'ቡድኔን አረጋግጥ'}
‎            </button>
‎          </div>
‎
‎          {saveTeam.isError && (
‎            <p className="form-error">
‎              {extractApiErrorMessage(saveTeam.error) ??
‎                'ቡድኑን ማስቀመጥ አልተቻለም። እንደገና ይሞክሩ።'}
‎            </p>
‎          )}
‎        </section>
‎      )}
‎    </div>
‎  );
‎}
‎
‎function TeamPage({ data }: { data: MiniAppBootstrap }) {
‎  const byId = useMemo(
‎    () =>
‎      new Map(
‎        data.players.map((player) => [
‎          player.id,
‎          player,
‎        ]),
‎      ),
‎    [data.players],
‎  );
‎
‎  const starters = data.team.startingPlayerIds
‎    .map((id) => byId.get(id))
‎    .filter(Boolean) as MiniAppPlayer[];
‎
‎  const bench = data.team.benchPlayerIds
‎    .map((id) => byId.get(id))
‎    .filter(Boolean) as MiniAppPlayer[];
‎
‎  const currentUser = data.leaderboard.find(
‎    (entry) => entry.isCurrentUser,
‎  );
‎
‎  if (!data.team.registered) {
‎    return (
‎      <div className="page-stack">
‎        <SectionTitle
‎          eyebrow="ቡድኔ"
‎          title="የእኔ ቡድን"
‎          note="ገና ቡድንዎን አላስቀመጡም።"
‎        />
‎
‎        <div className="empty-state">
‎          <div className="empty-icon">
‎            <Users className="h-7 w-7" />
‎          </div>
‎
‎          <h2>ቡድንዎን ይጀምሩ</h2>
‎
‎          <p>
‎            15 ተጫዋቾች ይምረጡ፣ ቋሚ 11ዎን
‎            ያዘጋጁና ይወዳደሩ።
‎          </p>
‎
‎          <Link
‎            href="/challenge"
‎            className="button button-primary"
‎          >
‎            ቡድኔን እመርጣለሁ
‎            <ArrowRight className="h-4 w-4" />
‎          </Link>
‎        </div>
‎      </div>
‎    );
‎  }
‎
‎  return (
‎    <div className="page-stack">
‎      <SectionTitle
‎        eyebrow="ቡድኔ"
‎        title="የእኔ ቡድን"
‎        note={`ሳምንት ${data.gameweek.id} · ${statusLabel(
‎          data.team.submissionStatus,
‎        )}`}
‎        action={
‎          <Link
‎            href="/challenge"
‎            className="button button-small button-ghost"
‎          >
‎            አስተካክል
‎          </Link>
‎        }
‎      />
‎
‎      <div className="stat-grid">
‎        <StatTile
‎          label="የእኔ ነጥብ"
‎          value={data.team.points}
‎          icon={Zap}
‎          tone="gold"
‎        />
‎
‎        <StatTile
‎          label="ደረጃ"
‎          value={
‎            currentUser
‎              ? `#${currentUser.rank}`
‎              : '—'
‎          }
‎          icon={Trophy}
‎          tone="blue"
‎        />
‎
‎        <StatTile
‎          label="ቋሚ 11"
‎          value={starters.length}
‎          icon={Target}
‎        />
‎      </div>
‎
‎      <section className="simple-card">
‎        <div className="card-heading">
‎          <div>
‎            <p className="eyebrow">በሜዳ ላይ</p>
‎            <h2>ቋሚ 11</h2>
‎          </div>
‎
‎          <Pill tone="mint">
‎            {pointsSourceLabel(
‎              data.team.pointsSource,
‎            )}
‎          </Pill>
‎        </div>
‎
‎        <TeamPitch
‎          players={starters}
‎          starters={data.team.startingPlayerIds}
‎          captain={data.team.captainPlayerId}
‎          vice={data.team.viceCaptainPlayerId}
‎        />
‎
‎        <div className="role-summary">
‎          <div>
‎            <Crown className="h-4 w-4 gold-icon" />
‎            <span>ካፒቴን</span>
‎            <strong>
‎              {byId.get(
‎                data.team.captainPlayerId ?? 0,
‎              )?.name ?? '—'}
‎            </strong>
‎          </div>
‎
‎          <div>
‎            <ShieldCheck className="h-4 w-4 text-mint" />
‎            <span>ምክትል ካፒቴን</span>
‎            <strong>
‎              {byId.get(
‎                data.team.viceCaptainPlayerId ?? 0,
‎              )?.name ?? '—'}
‎            </strong>
‎          </div>
‎        </div>
‎      </section>
‎
‎      <section className="simple-card">
‎        <div className="card-heading">
‎          <div>
‎            <p className="eyebrow">ተቀያሪዎች</p>
‎            <h2>{bench.length} ተጫዋቾች</h2>
‎          </div>
‎
‎          <Users className="heading-icon" />
‎        </div>
‎
‎        <div className="player-list compact-list">
‎          {bench.map((player) => (
‎            <PlayerCard
‎              key={player.id}
‎              player={player}
‎            />
‎          ))}
‎        </div>
‎      </section>
‎    </div>
‎  );
‎}
‎
‎function LeaderboardPage({
‎  data,
‎  update,
‎}: {
‎  data: MiniAppBootstrap;
‎  update: (next: MiniAppBootstrap) => void;
‎}) {
‎  const refresh = useRefreshMiniAppLeaderboard();
‎  const currentUser = data.leaderboard.find(
‎    (entry) => entry.isCurrentUser,
‎  );
‎
‎  return (
‎    <div className="page-stack">
‎      <SectionTitle
‎        eyebrow="ውድድር"
‎        title="ደረጃ ሰንጠረዥ"
‎        note={`ሳምንት ${data.gameweek.id} ውጤቶች`}
‎        action={
‎          <button
‎            type="button"
‎            className="icon-button icon-button-filled"
‎            onClick={() =>
‎              refresh.mutate(undefined, {
‎                onSuccess: update,
‎              })
‎            }
‎            disabled={refresh.isPending}
‎            aria-label="ደረጃ አድስ"
‎          >
‎            <RefreshCw
‎              className={cn(
‎                'h-4 w-4',
‎                refresh.isPending && 'animate-spin',
‎              )}
‎            />
‎          </button>
‎        }
‎      />
‎
‎      {currentUser && (
‎        <section className="rank-card">
‎          <div>
‎            <span>የእርስዎ ደረጃ</span>
‎            <strong>#{currentUser.rank}</strong>
‎          </div>
‎
‎          <div>
‎            <span>ነጥብ</span>
‎            <strong>{currentUser.points}</strong>
‎          </div>
‎
‎          <Trophy className="rank-card-icon" />
‎        </section>
‎      )}
‎
‎      <section className="leaderboard-card">
‎        <div className="leaderboard-head">
‎          <span>ደረጃ</span>
‎          <span>ተጫዋች</span>
‎          <span>ነጥብ</span>
‎        </div>
‎
‎        {data.leaderboard.length ? (
‎          data.leaderboard.map((entry) => (
‎            <div
‎              className={cn(
‎                'leaderboard-row',
‎                entry.isCurrentUser &&
‎                  'leaderboard-row-current',
‎              )}
‎              key={`${entry.displayName}-${entry.rank}`}
‎            >
‎              <strong
‎                className={cn(
‎                  entry.rank <= 3 && 'top-rank',
‎                )}
‎              >
‎                {entry.rank}
‎              </strong>
‎
‎              <div className="leaderboard-name">
‎                <span className="leaderboard-avatar">
‎                  {entry.displayName
‎                    .slice(0, 1)
‎                    .toUpperCase()}
‎                </span>
‎
‎                <span>
‎                  {entry.displayName}
‎
‎                  {entry.isCurrentUser && (
‎                    <small>እርስዎ</small>
‎                  )}
‎                </span>
‎              </div>
‎
‎              <strong>{entry.points}</strong>
‎            </div>
‎          ))
‎        ) : (
‎          <div className="empty-inline">
‎            ገና ደረጃ ሰንጠረዥ የለም።
‎          </div>
‎        )}
‎      </section>
‎
‎      {refresh.isError && (
‎        <p className="form-error">
‎          ደረጃውን ማደስ አልተቻለም።
‎        </p>
‎      )}
‎    </div>
‎  );
‎}
‎
‎function PointsPage({
‎  data,
‎}: {
‎  data: MiniAppBootstrap;
‎}) {
‎  const [search, setSearch] = useState('');
‎  const [position, setPosition] =
‎    useState<'all' | Position>('all');
‎
‎  const players = useMemo(
‎    () =>
‎      data.players
‎        .filter(
‎          (player) =>
‎            (position === 'all' ||
‎              player.position === position) &&
‎            `${player.name} ${player.club}`
‎              .toLowerCase()
‎              .includes(search.toLowerCase()),
‎        )
‎        .sort(
‎          (a, b) =>
‎            b.totalPoints - a.totalPoints,
‎        ),
‎    [data.players, position, search],
‎  );
‎
‎  return (
‎    <div className="page-stack">
‎      <SectionTitle
‎        eyebrow="የFPL መረጃ"
‎        title="የተጫዋች ነጥቦች"
‎        note="ኦፊሴላዊ የFPL ነጥቦች።"
‎      />
‎
‎      <div className="search-row">
‎        <label className="search-box">
‎          <Search className="h-4 w-4" />
‎
‎          <input
‎            type="search"
‎            value={search}
‎            onChange={(event) =>
‎              setSearch(event.target.value)
‎            }
‎            placeholder="ተጫዋች ወይም ክለብ ፈልግ"
‎            aria-label="ተጫዋች ፈልግ"
‎          />
‎        </label>
‎
‎        <select
‎          value={position}
‎          onChange={(event) =>
‎            setPosition(
‎              event.target.value as
‎                | 'all'
‎                | Position,
‎            )
‎          }
‎          aria-label="ቦታ ምረጥ"
‎        >
‎          <option value="all">ሁሉም</option>
‎
‎          {positionOrder.map((item) => (
‎            <option value={item} key={item}>
‎              {positionLabels[item]}
‎            </option>
‎          ))}
‎        </select>
‎      </div>
‎
‎      <section className="leaderboard-card player-table">
‎        {players.map((player) => (
‎          <div
‎            className="points-row"
‎            key={player.id}
‎          >
‎            <div className="player-position">
‎              {positionShortLabels[
‎                player.position
‎              ]}
‎            </div>
‎
‎            <div className="leaderboard-name">
‎              <strong>{player.name}</strong>
‎              <small>
‎                {player.club} ·{' '}
‎                {playerStatus(player)}
‎              </small>
‎            </div>
‎
‎            <div>
‎              <strong>{player.totalPoints}</strong>
‎              <small>ነጥብ</small>
‎            </div>
‎
‎            <div>
‎              <strong>
‎                {price(player.price)}
‎              </strong>
‎              <small>ዋጋ</small>
‎            </div>
‎          </div>
‎        ))}
‎      </section>
‎    </div>
‎  );
‎}
‎
‎function SignalPage({
‎  data,
‎}: {
‎  data: MiniAppBootstrap;
‎}) {
‎  return (
‎    <div className="page-stack">
‎      <SectionTitle
‎        eyebrow="FPL Signal"
‎        title="የውሳኔ ምልክቶች"
‎        note="ከኦፊሴላዊ መረጃ የተወሰዱ ምልክቶች።"
‎      />
‎
‎      <div className="notice notice-gold">
‎        <CircleAlert className="h-4 w-4 shrink-0" />
‎
‎        <span>
‎          {data.signal.disclaimer ||
‎            'ምልክቶቹ የአሁኑን መረጃ ያሳያሉ፤ የወደፊት ነጥብ ዋስትና አይሰጡም።'}
‎        </span>
‎      </div>
‎
‎      {data.signal.available &&
‎      data.signal.signals.length ? (
‎        data.signal.signals.map((item) => (
‎          <section
‎            className="signal-card"
‎            key={`${item.kind}-${item.playerId}`}
‎          >
‎            <div className="signal-top">
‎              <Pill tone="mint">
‎                {item.title}
‎              </Pill>
‎
‎              <span>{price(item.price)}</span>
‎            </div>
‎
‎            <h2>{item.playerName}</h2>
‎
‎            <p className="muted-copy">
‎              {item.club} ·{' '}
‎              {positionLabels[item.position]}
‎            </p>
‎
‎            <p>{item.detail}</p>
‎          </section>
‎        ))
‎      ) : (
‎        <div className="empty-state">
‎          <div className="empty-icon">
‎            <Zap className="h-7 w-7" />
‎          </div>
‎
‎          <h2>ገና ምልክት የለም</h2>
‎
‎          <p>
‎            {data.signal.message ||
‎              'በቂ መረጃ ሲኖር እዚህ ይታያል።'}
‎          </p>
‎        </div>
‎      )}
‎    </div>
‎  );
‎}
‎
‎function AboutPage() {
‎  return (
‎    <div className="page-stack">
‎      <SectionTitle
‎        eyebrow="ተጨማሪ"
‎        title="FPL Signal Ethiopia"
‎        note="በTelegram ውስጥ የሚሰራ ቀላል የFPL መሳሪያ።"
‎      />
‎
‎      <div className="more-grid">
‎        <Link
‎          href="/points"
‎          className="more-link"
‎        >
‎          <BarChart3 className="h-5 w-5" />
‎
‎          <span>
‎            <strong>የFPL ነጥቦች</strong>
‎            <small>
‎              የተጫዋቾችን ነጥብ ይመልከቱ
‎            </small>
‎          </span>
‎
‎          <ChevronRight className="ml-auto h-4 w-4" />
‎        </Link>
‎
‎        <Link
‎          href="/signal"
‎          className="more-link"
‎        >
‎          <Zap className="h-5 w-5" />
‎
‎          <span>
‎            <strong>የውሳኔ ምልክቶች</strong>
‎            <small>
‎              ከመረጃ የተወሰዱ ምልክቶች
‎            </small>
‎          </span>
‎
‎          <ChevronRight className="ml-auto h-4 w-4" />
‎        </Link>
‎      </div>
‎
‎      <section className="about-card">
‎        <LogoMark />
‎
‎        <h2>ፈጣን። ግልጽ። የታመነ።</h2>
‎
‎        <p>
‎          ቡድንዎን በግልጽ መረጃ ይምረጡ።
‎          ነጥቦች ከኦፊሴላዊ የFPL ምንጭ ብቻ
‎          ይመጣሉ።
‎        </p>
‎
‎        <div className="about-badges">
‎          <Pill tone="mint">
‎            <ShieldCheck className="h-3 w-3" />
‎            የታመነ መረጃ
‎          </Pill>
‎
‎          <Pill tone="gold">
‎            <Sparkles className="h-3 w-3" />
‎            ቀላል አጠቃቀም
‎          </Pill>
‎        </div>
‎      </section>
‎    </div>
‎  );
‎}
‎
‎type WalletWithdrawal = {
‎  id: number;
‎  method: string;
‎  amountEtb: number;
‎  destination: string;
‎  status: string;
‎  payoutReference: string | null;
‎  adminNote: string | null;
‎  approvedAt: string | null;
‎  rejectedAt: string | null;
‎  paidAt: string | null;
‎  createdAt: string;
‎};
‎
‎function WalletPage() {
‎  const [balance, setBalance] =
‎    useState<number | null>(null);
‎
‎  const [transactions, setTransactions] =
‎    useState<WalletTransaction[]>([]);
‎
‎  const [deposits, setDeposits] =
‎    useState<WalletDeposit[]>([]);
‎
‎  const [withdrawals, setWithdrawals] =
‎    useState<WalletWithdrawal[]>([]);
‎
‎  const [amount, setAmount] = useState('');
‎  const [transactionReference, setTransactionReference] =
‎    useState('');
‎
‎  const [withdrawAmount, setWithdrawAmount] =
‎    useState('');
‎
‎  const [withdrawDestination, setWithdrawDestination] =
‎    useState('');
‎
‎  const [loading, setLoading] =
‎    useState(true);
‎
‎  const [submitting, setSubmitting] =
‎    useState(false);
‎
‎  const [withdrawing, setWithdrawing] =
‎    useState(false);
‎
‎  const [error, setError] =
‎    useState<string | null>(null);
‎
‎  const [success, setSuccess] =
‎    useState<string | null>(null);
‎
‎  const withdrawalStatusLabel = (
‎    value: string,
‎  ) => {
‎    if (value === 'pending')
‎      return 'በመጠባበቅ ላይ';
‎
‎    if (value === 'approved')
‎      return 'ተፈቅዷል';
‎
‎    if (value === 'rejected')
‎      return 'ተቀባይነት አላገኘም';
‎
‎    if (value === 'paid')
‎      return 'ተከፍሏል';
‎
‎    return value;
‎  };
‎
‎  const depositStatusLabel = (
‎    value: string,
‎  ) => {
‎    if (value === 'pending')
‎      return 'በመጠባበቅ ላይ';
‎
‎    if (value === 'approved')
‎      return 'ተፈቅዷል';
‎
‎    if (value === 'rejected')
‎      return 'ተቀባይነት አላገኘም';
‎
‎    return value;
‎  };
‎
‎  const loadWallet = useCallback(
‎    async () => {
‎      setLoading(true);
‎      setError(null);
‎
‎      try {
‎        const [
‎          wallet,
‎          transactionData,
‎          depositData,
‎          withdrawalData,
‎        ] = await Promise.all([
‎          customFetch<{
‎            balanceEtb: number;
‎            currency: string;
‎          }>('/api/mini-app/wallet', {
‎            method: 'GET',
‎            responseType: 'json',
‎          }),
‎
‎          customFetch<{
‎            transactions: WalletTransaction[];
‎          }>(
‎            '/api/mini-app/wallet/transactions',
‎            {
‎              method: 'GET',
‎              responseType: 'json',
‎            },
‎          ),
‎
‎          customFetch<{
‎            deposits: WalletDeposit[];
‎          }>(
‎            '/api/mini-app/wallet/deposits',
‎            {
‎              method: 'GET',
‎              responseType: 'json',
‎            },
‎          ),
‎
‎          customFetch<{
‎            withdrawals: WalletWithdrawal[];
‎          }>(
‎            '/api/mini-app/wallet/withdrawals',
‎            {
‎              method: 'GET',
‎              responseType: 'json',
‎            },
‎          ),
‎        ]);
‎
‎        setBalance(wallet.balanceEtb);
‎        setTransactions(
‎          transactionData.transactions,
‎        );
‎        setDeposits(depositData.deposits);
‎        setWithdrawals(
‎          withdrawalData.withdrawals,
‎        );
‎      } catch (err) {
‎        setError(
‎          extractApiErrorMessage(err) ??
‎            'የWallet መረጃን መጫን አልተቻለም።',
‎        );
‎      } finally {
‎        setLoading(false);
‎      }
‎    },
‎    [],
‎  );
‎
‎  useEffect(() => {
‎    void loadWallet();
‎  }, [loadWallet]);
‎
‎  const submitDeposit = async (
‎    event: FormEvent<HTMLFormElement>,
‎  ) => {
‎    event.preventDefault();
‎
‎    const parsedAmount = Number(amount);
‎
‎    if (
‎      !Number.isSafeInteger(parsedAmount) ||
‎      parsedAmount ‎<= 0
‎    ) {
‎      setError(
‎        'ትክክለኛ የገንዘብ መጠን ያስገቡ።',
‎      );
‎      return;
‎    }
‎
‎    if (!transactionReference.trim()) {
‎      setError(
‎        'የTelebirr SMS መልእክቱን ሙሉውን ያስገቡ።',
‎      );
‎      return;
‎    }
‎
‎    setSubmitting(true);
‎    setError(null);
‎    setSuccess(null);
‎
‎    try {
‎      await customFetch(
‎        '/api/mini-app/wallet/deposit/telebirr',
‎        {
‎          method: 'POST',
‎          responseType: 'json',
‎          body: JSON.stringify({
‎            amountEtb: parsedAmount,
‎            transactionReference:
‎              transactionReference.trim(),
‎          }),
‎          headers: {
‎            'Content-Type': 'application/json',
‎          },
‎        },
‎      );
‎
‎      setAmount('');
‎      setTransactionReference('');
‎
‎      setSuccess(
‎        'የገንዘብ ጥያቄዎ ተልኳል። ከተረጋገጠ በኋላ Wallet ዎ ይሞላል።',
‎      );
‎
‎      await loadWallet();
‎    } catch (err) {
‎      setError(
‎        extractApiErrorMessage(err) ??
‎          'Deposit ማስገባት አልተሳካም።',
‎      );
‎    } finally {
‎      setSubmitting(false);
‎    }
‎  };
‎
‎  const submitWithdrawal = async (
‎    event: FormEvent<HTMLFormElement>,
‎  ) => {
‎    event.preventDefault();
‎
‎    const parsedAmount =
‎      Number(withdrawAmount);
‎
‎    if (
‎      !Number.isSafeInteger(parsedAmount) ||
‎      parsedAmount <= 0
‎    ) {
‎      setError(
‎        'ትክክለኛ የሚወጣ የገንዘብ መጠን ያስገቡ።',
‎      );
‎      return;
‎    }
‎
‎    if (
‎      balance !== null &&
‎      parsedAmount > balance
‎    ) {
‎      setError(
‎        'በWallet ውስጥ ያለው ቀሪ ሂሳብ በቂ አይደለም።',
‎      );
‎      return;
‎    }
‎
‎    if (!withdrawDestination.trim()) {
‎      setError(
‎        'የሚቀበለውን Telebirr ቁጥር ያስገቡ።',
‎      );
‎      return;
‎    }
‎
‎    setWithdrawing(true);
‎    setError(null);
‎    setSuccess(null);
‎
‎    try {
‎      await customFetch(
‎        '/api/mini-app/wallet/withdraw',
‎        {
‎          method: 'POST',
‎          responseType: 'json',
‎          body: JSON.stringify({
‎            amountEtb: parsedAmount,
‎            destination:
‎              withdrawDestination.trim(),
‎          }),
‎          headers: {
‎            'Content-Type':
‎              'application/json',
‎          },
‎        },
‎      );
‎
‎      setWithdrawAmount('');
‎      setWithdrawDestination('');
‎
‎      setSuccess(
‎        'የWithdrawal ጥያቄዎ ተልኳል። አስተዳዳሪው ካጸደቀ በኋላ ገንዘቡ ወደ Telebirr ይላካል።',
‎      );
‎
‎      await loadWallet();
‎    } catch (err) {
‎      setError(
‎        extractApiErrorMessage(err) ??
‎          'Withdrawal ማስገባት አልተሳካም።',
‎      );
‎    } finally {
‎      setWithdrawing(false);
‎    }
‎  };
‎
‎  if (loading) {
‎    return <LoadingState />;
‎  }
‎
‎  return (
    <div className="page-stack">
      <SectionTitle
        eyebrow="Wallet"
        title="የእኔ Wallet"
        note="ገንዘብዎን ያስተዳድሩ።"
        action={
          <button
            type="button"
            className="icon-button icon-button-filled"
            onClick={() => void loadWallet()}
            disabled={loading}
            aria-label="Wallet አድስ"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        }
      />

      {error && (
        <div className="notice notice-gold">
          <CircleAlert className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="notice">
          <Check className="h-4 w-4 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      <section className="simple-card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">ቀሪ ሂሳብ</p>
            <h2>{balance ?? 0} ETB</h2>
          </div>

          <WalletCards className="heading-icon" />
        </div>

        <p className="muted-copy">
          Wallet ዎን በመጠቀም የWeekly Challenge
          መግቢያ ክፍያ ይክፈሉ።
        </p>
      </section>

      <section className="simple-card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Deposit</p>
            <h2>በTelebirr ገንዘብ ያስገቡ</h2>
          </div>

          <Activity className="heading-icon" />
        </div>

        <div className="notice">
          <Info className="h-4 w-4 shrink-0" />

          <span>
            <strong>
              📱 FPL Signal Telebirr:
              0940504900
            </strong>
            <br />
            ወደዚህ ቁጥር ገንዘብ ይላኩ።
            <br />
            ከላኩ በኋላ ከTelebirr የደረስዎትን SMS
            መልእክት ሙሉውን Copy አድርገው
            ከታች ያስገቡ።
          </span>
        </div>

        <form
          onSubmit={submitDeposit}
          className="form-stack"
        >
          <label>
            <span>መጠን (ETB)</span>

            <input
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(event) =>
                setAmount(event.target.value)
              }
              placeholder="ለምሳሌ 100"
              inputMode="numeric"
            />
          </label>

          <label>
            <span>የTelebirr SMS መልእክት</span>

            <textarea
              value={transactionReference}
              onChange={(event) =>
                setTransactionReference(
                  event.target.value,
                )
              }
              placeholder="የTelebirr SMS መልእክቱን ሙሉውን Paste ያድርጉ"
              rows={6}
            />
          </label>

          <button
            type="submit"
            className="button button-primary button-large"
            disabled={submitting}
          >
            {submitting ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <WalletCards className="h-4 w-4" />
            )}

            {submitting
              ? 'በመላክ ላይ…'
              : 'Deposit አስገባ'}
          </button>
        </form>

        <div className="notice">
          <Info className="h-4 w-4 shrink-0" />

          <span>
            ገንዘቡን ከላኩ በኋላ የTelebirr SMS
            መልእክቱን ሙሉውን ያስገቡ።
            አስተዳዳሪ ክፍያውን ካረጋገጠ በኋላ
            Wallet ዎ ይሞላል።
          </span>
        </div>
      </section>

      <section className="simple-card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Withdrawal</p>
            <h2>ከWallet ገንዘብ ያውጡ</h2>
          </div>

          <ArrowRight className="heading-icon" />
        </div>

        <form
          onSubmit={submitWithdrawal}
          className="form-stack"
        >
          <label>
            <span>የሚወጣ መጠን (ETB)</span>

            <input
              type="number"
              min="1"
              step="1"
              value={withdrawAmount}
              onChange={(event) =>
                setWithdrawAmount(
                  event.target.value,
                )
              }
              placeholder="ለምሳሌ 100"
              inputMode="numeric"
            />
          </label>

          <label>
            <span>የሚቀበለው Telebirr ቁጥር</span>

            <input
              type="tel"
              value={withdrawDestination}
              onChange={(event) =>
                setWithdrawDestination(
                  event.target.value,
                )
              }
              placeholder="09xxxxxxxx"
              inputMode="tel"
              autoComplete="tel"
            />
          </label>

          <button
            type="submit"
            className="button button-primary button-large"
            disabled={withdrawing}
          >
            {withdrawing ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowRight className="h-4 w-4" />
            )}

            {withdrawing
              ? 'በመላክ ላይ…'
              : 'Withdrawal ጠይቅ'}
          </button>
        </form>

        <div className="notice">
          <Info className="h-4 w-4 shrink-0" />

          <span>
            Withdrawal ሲጠይቁ የተጠየቀው መጠን
            ከWallet ውስጥ ወዲያውኑ ይያዛል።
            ጥያቄው ከተቀበለ በኋላ አስተዳዳሪ
            ወደ እርስዎ Telebirr ይልካል።
            ከተከለከለ ገንዘቡ ወደ Wallet ይመለሳል።
          </span>
        </div>
      </section>

      <section className="simple-card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">
              Withdrawal History
            </p>
            <h2>የገንዘብ ማውጫ ታሪክ</h2>
          </div>

          <Clock3 className="heading-icon" />
        </div>

        {withdrawals.length ? (
          <div className="player-list compact-list">
            {withdrawals.map((withdrawal) => (
              <div
                className="more-link"
                key={withdrawal.id}
              >
                <ArrowRight className="h-5 w-5" />

                <span>
                  <strong>
                    {withdrawal.amountEtb} ETB ·
                    Telebirr
                  </strong>

                  <small>
                    {withdrawal.destination} ·{' '}
                    {withdrawalStatusLabel(
                      withdrawal.status,
                    )}
                  </small>

                  {withdrawal.adminNote && (
                    <small>
                      {withdrawal.adminNote}
                    </small>
                  )}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-inline">
            እስካሁን Withdrawal ታሪክ የለም።
          </div>
        )}
      </section>

      <section className="simple-card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">
              Deposit History
            </p>
            <h2>የገንዘብ ማስገቢያ ታሪክ</h2>
          </div>

          <Clock3 className="heading-icon" />
        </div>

        {deposits.length ? (
          <div className="player-list compact-list">
            {deposits.map((deposit) => (
              <div
                className="more-link"
                key={deposit.id}
              >
                <WalletCards className="h-5 w-5" />

                <span>
                  <strong>
                    {deposit.amountEtb} ETB ·
                    Telebirr
                  </strong>

                  <small>
                    {deposit.transactionReference} ·{' '}
                    {depositStatusLabel(
                      deposit.status,
                    )}
                  </small>

                  {deposit.adminNote && (
                    <small>
                      {deposit.adminNote}
                    </small>
                  )}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-inline">
            እስካሁን Deposit ታሪክ የለም።
          </div>
        )}
      </section>

      <section className="simple-card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">
              Transactions
            </p>
            <h2>የWallet እንቅስቃሴ</h2>
          </div>

          <Activity className="heading-icon" />
        </div>

        {transactions.length ? (
          <div className="player-list compact-list">
            {transactions.map((transaction) => (
              <div
                className="more-link"
                key={transaction.id}
              >
                <Activity className="h-5 w-5" />

                <span>
                  <strong>
                    {transaction.amountEtb > 0
                      ? '+'
                      : ''}
                    {transaction.amountEtb} ETB
                  </strong>

                  <small>
                    {transaction.description} ·{' '}
                    {transaction.balanceAfterEtb} ETB
                  </small>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-inline">
            እስካሁን የWallet እንቅስቃሴ የለም።
          </div>
        )}
      </section>
    </div>
  );
‎}
‎export function MiniApp() {
‎  const queryClient = useQueryClient();
‎
‎  const bootstrap = useGetMiniAppBootstrap({
‎    query: {
‎      queryKey:
‎        getGetMiniAppBootstrapQueryKey(),
‎      retry: 1,
‎    },
‎  });
‎
‎  const health = useHealthCheck({
‎    query: {
‎      queryKey: getHealthCheckQueryKey(),
‎      staleTime: 60_000,
‎      retry: 0,
‎    },
‎  });
‎
‎  const [location] = useLocation();
‎
‎  useEffect(
‎    () => prepareTelegramApp(),
‎    [],
‎  );
‎
‎  const update = useCallback(
‎    (next: MiniAppBootstrap) => {
‎      queryClient.setQueryData(
‎        getGetMiniAppBootstrapQueryKey(),
‎        next,
‎      );
‎    },
‎    [queryClient],
‎  );
‎
‎  if (bootstrap.isLoading) {
‎    return <LoadingState />;
‎  }
‎
‎  if (
‎    bootstrap.isError ||
‎    !bootstrap.data
‎  ) {
‎    const error =
‎      bootstrap.error as {
‎        status?: number;
‎      } | null;
‎
‎    return (
‎      <ErrorState
‎        unauthenticated={
‎          error?.status === 401 ||
‎          error?.status === 403
‎        }
‎        onRetry={() =>
‎          void bootstrap.refetch()
‎        }
‎      />
‎    );
‎  }
‎
‎  const data =
‎    bootstrap.data as MiniAppBootstrap;
‎
‎  const page =
‎    location === '/challenge' ? (
‎      <ChallengePage
‎        data={data}
‎        update={update}
‎      />
‎    ) : location === '/team' ? (
‎      <TeamPage data={data} />
‎    ) : location === '/leaderboard' ? (
‎      <LeaderboardPage
‎        data={data}
‎        update={update}
‎      />
‎    ) : location === '/points' ? (
‎      <PointsPage data={data} />
‎    ) : location === '/signal' ? (
‎      <SignalPage data={data} />
‎    ) : location === '/wallet' ? (
‎      <WalletPage />
‎    ) : location === '/about' ? (
‎      <AboutPage />
‎    ) : (
‎      <HomePage data={data} />
‎    );
‎
‎  return (
‎    <AppShell data={data}>
‎      <div
‎        className={cn(
‎          'connection-strip',
‎          health.isError &&
‎            'connection-strip-error',
‎        )}
‎      >
‎        <span className="connection-dot" />
‎
‎        {health.isError
‎          ? 'የመረጃ አገልግሎት ጊዜያዊ ችግር'
‎          : 'የመረጃ አገልግሎት ንቁ ነው'}
‎      </div>
‎
‎      {page}
‎    </AppShell>
‎  );
‎}
‎
