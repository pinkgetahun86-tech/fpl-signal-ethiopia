import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  BadgeCheck,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Info,
  LayoutDashboard,
  LockKeyhole,
  Menu,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Target,
  Trophy,
  UserRound,
  Users,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';
import { Link, useLocation } from 'wouter';
import {
  customFetch,
  getGetMiniAppBootstrapQueryKey,
  getHealthCheckQueryKey,
  type MiniAppBootstrap,
  type MiniAppPlayer,
  useGetMiniAppBootstrap,
  useHealthCheck,
  useRefreshMiniAppLeaderboard,
  useSaveMiniAppTeam,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { prepareTelegramApp } from '@/lib/telegram';

const navItems = [
  { href: '/', label: 'እይታ', icon: LayoutDashboard },
  { href: '/challenge', label: 'የሳምንቱ ቡድን', icon: Target },
  { href: '/team', label: 'የእኔ ቡድን', icon: Users },
  { href: '/leaderboard', label: 'ደረጃ ሰንጠረዥ', icon: Trophy },
  { href: '/points', label: 'የተጫዋች ነጥቦች', icon: BarChart3 },
  { href: '/signal', label: 'Signal', icon: Zap },
  { href: '/about', label: 'ስለ መተግበሪያው', icon: Info },
];

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function extractApiErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const data = (error as { data?: unknown }).data;
  if (data && typeof data === 'object') {
    const message = (data as { error?: unknown }).error;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return null;
}

function formatDate(date: string | null | undefined) {
  if (!date) return '—';
  return new Intl.DateTimeFormat('am-ET', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(date));
}

function submissionStatusLabel(status: string): string {
  switch (status) {
    case 'confirmed':
      return 'ተረጋግጧል';
    case 'awaiting_payment':
      return 'ክፍያ ይጠብቃል';
    case 'not_registered':
      return 'አልተመዘገበም';
    default:
      return status;
  }
}

function timeToDeadline(deadline: string | null | undefined) {
  if (!deadline) return 'ጊዜው አልተወሰነም';
  const diff = new Date(deadline).getTime() - Date.now();
  if (diff <= 0) return 'ተዘግቷል';
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  return `${hours}ሰ ${minutes}ደ`;
}

function positionLabel(position: string) {
  return ({ goalkeeper: 'GK', defender: 'DEF', midfielder: 'MID', forward: 'FWD' } as Record<string, string>)[position] ?? position;
}

function playerStatus(player: MiniAppPlayer) {
  if (player.status && player.status !== 'a') return player.status.toUpperCase();
  if (player.chanceOfPlayingThisRound !== null && player.chanceOfPlayingThisRound < 75) return `${player.chanceOfPlayingThisRound}%`;
  return 'FIT';
}

function LogoMark() {
  return (
    <div className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[13px] bg-[#9debd3] text-[#182440]" data-testid="brand-mark">
      <span className="absolute -right-1 -top-1 h-5 w-5 rounded-full border-[3px] border-[#182440]/15" />
      <Activity className="relative h-5 w-5" strokeWidth={2.7} />
    </div>
  );
}

function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' }) {
  return <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.12em]', tone === 'green' && 'bg-[#d8f7ec] text-[#147558]', tone === 'amber' && 'bg-[#fff0cc] text-[#9b6413]', tone === 'red' && 'bg-[#ffe0dd] text-[#a33b31]', tone === 'neutral' && 'bg-[#e9edf2] text-[#647187]')}>{children}</span>;
}

function SectionHeading({ eyebrow, title, note, action }: { eyebrow: string; title: string; note?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.2em] text-[#198667]">{eyebrow}</div>
        <h1 className="font-display text-2xl font-bold tracking-[-.04em] text-[#182440] sm:text-[30px]" data-testid={`heading-${title}`}>{title}</h1>
        {note && <p className="mt-1 text-sm text-[#718096]">{note}</p>}
      </div>
      {action}
    </div>
  );
}

function MetricCard({ label, value, detail, icon: Icon, accent = 'mint' }: { label: string; value: string | number; detail: string; icon: typeof Activity; accent?: 'mint' | 'amber' | 'navy' }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-[#d9e0e8] bg-[#fffcf6] p-4 shadow-[0_8px_22px_rgba(29,43,70,.045)]" data-testid={`metric-${label}`}>
      <div className={cn('absolute -right-4 -top-5 h-20 w-20 rounded-full opacity-50', accent === 'mint' ? 'bg-[#b7f2df]' : accent === 'amber' ? 'bg-[#ffe4a9]' : 'bg-[#dbe3f0]')} />
      <div className="relative flex items-start justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[.16em] text-[#718096]">{label}</span>
        <Icon className="h-4 w-4 text-[#198667]" />
      </div>
      <div className="relative mt-4 font-display text-[28px] font-bold tracking-[-.05em] text-[#182440]">{value}</div>
      <div className="relative mt-1 text-xs text-[#718096]">{detail}</div>
    </div>
  );
}

function Skeleton({ className }: { className: string }) {
  return <div className={cn('animate-pulse rounded-xl bg-[#e7ebef]', className)} />;
}

function LoadingState() {
  return (
    <div className="mx-auto w-full max-w-[1180px] p-4 sm:p-8" data-testid="loading-state">
      <div className="mb-8 flex items-center gap-3"><Skeleton className="h-10 w-10" /><div><Skeleton className="h-3 w-28" /><Skeleton className="mt-2 h-5 w-48" /></div></div>
      <Skeleton className="h-40 w-full rounded-3xl" />
      <div className="mt-5 grid gap-4 sm:grid-cols-3"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
      <Skeleton className="mt-5 h-72 w-full rounded-2xl" />
    </div>
  );
}

function EmptyState({ icon: Icon, title, text, action }: { icon: typeof Info; title: string; text: string; action?: React.ReactNode }) {
  return <div className="flex min-h-[280px] flex-col items-center justify-center rounded-2xl border border-dashed border-[#cbd5df] bg-[#fffdf8] px-6 text-center" data-testid="empty-state"><div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#e4f8f1] text-[#198667]"><Icon className="h-6 w-6" /></div><h2 className="font-display text-lg font-bold text-[#182440]">{title}</h2><p className="mt-2 max-w-md text-sm leading-6 text-[#718096]">{text}</p>{action && <div className="mt-5">{action}</div>}</div>;
}

function ErrorState({ unauthenticated = false, onRetry }: { unauthenticated?: boolean; onRetry?: () => void }) {
  return <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col items-center justify-center px-6 text-center" data-testid={unauthenticated ? 'unauthenticated-state' : 'network-error-state'}><div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#ffe8d6] text-[#b9652c]">{unauthenticated ? <ShieldCheck className="h-7 w-7" /> : <WifiOff className="h-7 w-7" />}</div><h1 className="font-display text-2xl font-bold text-[#182440]">{unauthenticated ? 'Telegram መግቢያ ያስፈልጋል' : 'ግንኙነት ተቋርጧል'}</h1><p className="mt-3 text-sm leading-7 text-[#718096]">{unauthenticated ? 'ይህን ገጽ ከTelegram ውስጥ ይክፈቱ። የቡድንዎ መረጃ በደህንነት እንዲመጣ የTelegram ማረጋገጫ ያስፈልጋል።' : 'የFPL Signal መረጃን ማግኘት አልተቻለም። ግንኙነቱን ይመልከቱና እንደገና ይሞክሩ።'}</p>{!unauthenticated && onRetry && <button type="button" onClick={onRetry} className="mt-6 inline-flex items-center gap-2 rounded-xl bg-[#182440] px-4 py-3 text-sm font-bold text-[#fffdf8]" data-testid="button-retry"><RefreshCw className="h-4 w-4" />እንደገና ሞክር</button>}</div>;
}

function Shell({ children, data }: { children: ReactNode; data: MiniAppBootstrap }) {
  const [location, setLocation] = useLocation();
  const [mobileNav, setMobileNav] = useState(false);
  useEffect(() => {
    const app = window.Telegram?.WebApp;
    if (app?.BackButton) {
      if (location === '/') app.BackButton.hide();
      else {
        const handleBack = () => setLocation('/');
        app.BackButton.show();
        app.BackButton.onClick(handleBack);
        return () => app.BackButton?.offClick?.(handleBack);
      }
    }
    return undefined;
  }, [location, setLocation]);
  const firstName = data.user.firstName || data.user.username || 'አስተዳዳሪ';
  return (
    <div className="min-h-[100dvh] bg-[#f7f5ef] text-[#182440]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col bg-[#182440] px-4 py-5 text-[#edf6f2] lg:flex">
        <div className="flex items-center gap-3 px-2"><LogoMark /><div><div className="font-display text-sm font-bold tracking-[-.02em]">FPL Signal</div><div className="mt-0.5 text-[9px] font-bold uppercase tracking-[.2em] text-[#86a49f]">Ethiopia</div></div></div>
        <div className="mt-10 px-2 text-[9px] font-bold uppercase tracking-[.2em] text-[#77908f]">Cockpit</div>
        <nav className="mt-3 space-y-1" aria-label="ዋና ምናሌ">{navItems.map((item) => { const Icon = item.icon; const active = location === item.href; return <Link key={item.href} href={item.href} onClick={() => setMobileNav(false)} className={cn('group flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold transition-colors', active ? 'bg-[#9debd3] text-[#182440]' : 'text-[#b5c3c5] hover:bg-[#243250] hover:text-white')} data-testid={`link-nav-${item.href === '/' ? 'home' : item.href.slice(1)}`}><Icon className="h-[17px] w-[17px]" /><span>{item.label}</span>{active && <ArrowUpRight className="ml-auto h-3.5 w-3.5" />}</Link>; })}</nav>
        <div className="mt-auto rounded-2xl border border-[#30405c] bg-[#202e4b] p-3"><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.15em] text-[#9debd3]"><span className="h-1.5 w-1.5 rounded-full bg-[#9debd3] animate-pulse-soft" />የFPL ቀጥታ መረጃ</div><p className="mt-2 text-xs leading-5 text-[#adbfbe]">ነጥቦች ከኦፊሴላዊ የFPL ውሂብ ብቻ።</p></div>
      </aside>
      {mobileNav && <div className="fixed inset-0 z-40 bg-[#182440]/40 lg:hidden" onClick={() => setMobileNav(false)}><aside className="h-full w-[82%] max-w-[300px] bg-[#182440] p-5 text-[#edf6f2]" onClick={(event) => event.stopPropagation()}><div className="flex items-center justify-between"><div className="flex items-center gap-3"><LogoMark /><div><div className="font-display text-sm font-bold">FPL Signal</div><div className="text-[9px] font-bold uppercase tracking-[.2em] text-[#86a49f]">Ethiopia</div></div></div><button type="button" onClick={() => setMobileNav(false)} className="rounded-lg p-2 text-[#aababc]" data-testid="button-close-menu"><X className="h-5 w-5" /></button></div><nav className="mt-10 space-y-1">{navItems.map((item) => { const Icon = item.icon; return <Link key={item.href} href={item.href} onClick={() => setMobileNav(false)} className={cn('flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold', location === item.href ? 'bg-[#9debd3] text-[#182440]' : 'text-[#b5c3c5]')} data-testid={`mobile-link-${item.href.slice(1) || 'home'}`}><Icon className="h-4 w-4" />{item.label}</Link>; })}</nav></aside></div>}
      <main className="min-h-[100dvh] lg:pl-[248px]">
        <header className="sticky top-0 z-20 border-b border-[#e2e5e5] bg-[#f7f5ef]/90 px-4 py-3 backdrop-blur-xl sm:px-8"><div className="mx-auto flex max-w-[1180px] items-center justify-between"><div className="flex items-center gap-3"><button type="button" className="rounded-xl p-2 hover:bg-[#e9edf2] lg:hidden" onClick={() => setMobileNav(true)} data-testid="button-open-menu"><Menu className="h-5 w-5" /></button><div className="lg:hidden"><LogoMark /></div><div className="hidden sm:block"><div className="text-[10px] font-bold uppercase tracking-[.2em] text-[#198667]">DATA • STRATEGY • SIGNAL</div><div className="mt-0.5 text-xs text-[#718096]">የFPL የውሳኔ ክፍል</div></div></div><div className="flex items-center gap-3"><div className="hidden text-right sm:block"><div className="text-xs font-bold text-[#182440]" data-testid="text-username">{firstName}</div><div className="font-mono-ui text-[9px] uppercase tracking-[.12em] text-[#8190a1]">GW {data.gameweek.id}</div></div><div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#d9e1ee] text-[#30405c]" data-testid="avatar-user"><UserRound className="h-4 w-4" /></div></div></div></header>
        <div className="mx-auto max-w-[1180px] p-4 pb-10 sm:p-8">{children}</div>
      </main>
    </div>
  );
}

function Hero({ data }: { data: MiniAppBootstrap }) {
  const locked = data.gameweek.locked;
  return <section className="relative overflow-hidden rounded-[26px] bg-[#182440] p-5 text-[#f8f5ed] shadow-[0_18px_44px_rgba(29,43,70,.14)] sm:p-7" data-testid="hero-overview"><div className="absolute -right-16 -top-20 h-64 w-64 rounded-full border-[30px] border-[#2e4164] opacity-60" /><div className="absolute -bottom-32 right-20 h-64 w-64 rounded-full border-[18px] border-[#243758] opacity-50" /><div className="relative flex flex-col justify-between gap-7 sm:flex-row"><div><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.2em] text-[#9debd3]"><span className="h-1.5 w-1.5 rounded-full bg-[#9debd3] animate-pulse-soft" /> Gameweek {data.gameweek.id} / {data.gameweek.status}</div><h1 className="mt-4 max-w-[520px] font-display text-3xl font-bold leading-[1.06] tracking-[-.06em] sm:text-[44px]">የዚህ ሳምንት<br /><span className="text-[#9debd3]">ውሳኔ ይጀምራል።</span></h1><p className="mt-4 max-w-[450px] text-sm leading-6 text-[#b9c7c7]">የFPL ቡድንዎን በግልጽ መረጃ ይምረጡ። የቀጥታ ነጥቦችዎን ከኦፊሴላዊ ምንጭ ይከታተሉ።</p></div><div className="relative min-w-[190px] self-start rounded-2xl border border-[#3a4c6b] bg-[#20304e] p-4 sm:self-end"><div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[.14em] text-[#8fa4a5]"><span>Deadline</span>{locked ? <LockKeyhole className="h-4 w-4 text-[#f5c15b]" /> : <Clock3 className="h-4 w-4 text-[#9debd3]" />}</div><div className="mt-3 font-mono-ui text-2xl font-bold text-[#fffdf8]" data-testid="text-deadline-countdown">{locked ? 'LOCKED' : timeToDeadline(data.gameweek.deadlineTime)}</div><div className="mt-1 text-xs text-[#9faeb6]">{formatDate(data.gameweek.deadlineTime)}</div></div></div></section>;
}

export function HomePage({ data }: { data: MiniAppBootstrap }) {
  const current = data.leaderboard.find((entry) => entry.isCurrentUser);
  const availablePlayers = data.players.filter((player) => player.status === 'a' || !player.status).length;
  return <div className="animate-rise"><Hero data={data} /><div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><MetricCard label="ቡድን" value={data.team.registered ? '15 / 15' : '0 / 15'} detail={data.team.registered ? 'ቡድን ተመዝግቧል' : 'ምርጫ ይጠብቃል'} icon={Users} /><MetricCard label="የእኔ ነጥብ" value={data.team.points} detail={data.team.pointsSource || 'ኦፊሴላዊ ምንጭ'} icon={Zap} accent="amber" /><MetricCard label="ደረጃ" value={current ? `#${current.rank}` : '—'} detail="በአሁኑ Gameweek" icon={Trophy} accent="navy" /><MetricCard label="ተጫዋቾች" value={availablePlayers} detail="ለመምረጥ ዝግጁ" icon={Activity} /></div><div className="mt-5 grid gap-5 lg:grid-cols-[1.3fr_.7fr]"><div className="rounded-2xl border border-[#dce2e5] bg-[#fffdf8] p-5 shadow-[0_8px_22px_rgba(29,43,70,.04)]"><SectionHeading eyebrow="Weekly challenge" title="የሳምንቱ ተግባር" note="ቡድንዎን ከdeadline በፊት ያረጋግጡ።" action={<Link href="/challenge" className="inline-flex items-center gap-1.5 rounded-xl bg-[#182440] px-3 py-2 text-xs font-bold text-[#fffdf8]" data-testid="link-start-challenge">ጀምር <ArrowUpRight className="h-3.5 w-3.5" /></Link>} /><div className="grid gap-3 sm:grid-cols-3"><div className="rounded-xl bg-[#f1f7f4] p-3"><div className="font-display text-xl font-bold text-[#198667]">{data.team.startingPlayerIds.length || 0}</div><div className="mt-1 text-xs text-[#718096]">Starting XI</div></div><div className="rounded-xl bg-[#fff5db] p-3"><div className="font-display text-xl font-bold text-[#ad721a]">{data.team.captainPlayerId ? '1' : '—'}</div><div className="mt-1 text-xs text-[#718096]">Captain</div></div><div className="rounded-xl bg-[#edf0f5] p-3"><div className="font-display text-xl font-bold text-[#30405c]">{submissionStatusLabel(data.team.submissionStatus || 'not_registered')}</div><div className="mt-1 text-xs text-[#718096]">ሁኔታ</div></div></div></div><div className="rounded-2xl border border-[#dce2e5] bg-[#fffdf8] p-5"><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.18em] text-[#198667]"><Sparkles className="h-4 w-4" /> Signal</div><p className="mt-4 text-sm leading-7 text-[#526176]">{data.signal.available ? data.signal.message : 'ለዚህ Gameweek የተረጋገጠ Signal ገና የለም።'}</p><Link href="/signal" className="mt-4 inline-flex items-center gap-2 text-xs font-bold text-[#198667]" data-testid="link-signal">Signal ይመልከቱ <ArrowUpRight className="h-3 w-3" /></Link></div></div></div>;
}

function PlayerChip({ player, selected, starter, captain, vice, scored, onClick, disabled }: { player: MiniAppPlayer; selected?: boolean; starter?: boolean; captain?: boolean; vice?: boolean; scored?: boolean; onClick?: () => void; disabled?: boolean }) {
  const content = <div className={cn('group flex items-center gap-3 rounded-xl border px-3 py-3 transition-colors', selected ? 'border-[#9debd3] bg-[#f0fbf7]' : 'border-[#e1e6eb] bg-[#fffdf8]', starter && 'ring-1 ring-[#198667]/25', disabled && 'cursor-not-allowed opacity-55')}><div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-mono-ui text-[10px] font-bold', starter ? 'bg-[#d6f5e9] text-[#167257]' : 'bg-[#edf0f5] text-[#66758a]')}>{positionLabel(player.position)}</div><div className="min-w-0 flex-1"><div className="truncate text-sm font-bold text-[#26354e]">{player.name}</div><div className="mt-0.5 truncate text-[11px] text-[#8190a1]">{player.club} · £{player.price.toFixed(1)}m</div></div><div className="flex flex-col items-end gap-1">{captain && <span className="rounded bg-[#f8d56a] px-1.5 py-0.5 text-[9px] font-bold text-[#71510a]">C</span>}{vice && <span className="rounded bg-[#d4ddea] px-1.5 py-0.5 text-[9px] font-bold text-[#3d4d66]">VC</span>}{scored && <BadgeCheck className="h-4 w-4 text-[#198667]" />}{!captain && !vice && !scored && <span className={cn('font-mono-ui text-[10px] font-bold', playerStatus(player) === 'FIT' ? 'text-[#198667]' : 'text-[#bd7720]')}>{playerStatus(player)}</span>}</div></div>;
  return onClick ? <button type="button" onClick={onClick} disabled={disabled} className="block w-full text-left" data-testid={`button-player-${player.id}`}>{content}</button> : <div data-testid={`row-player-${player.id}`}>{content}</div>;
}

function SelectionSummary({ selectedCount, starterCount, captain, vice }: { selectedCount: number; starterCount: number; captain: boolean; vice: boolean }) {
  return <div className="grid grid-cols-4 gap-2 rounded-2xl bg-[#182440] p-3 text-[#f7f5ef]" data-testid="selection-summary"><div><div className="font-mono-ui text-lg font-bold text-[#9debd3]">{selectedCount}<span className="text-xs text-[#8da0a3]">/15</span></div><div className="text-[9px] uppercase tracking-[.12em] text-[#9da0a3]">Squad</div></div><div><div className="font-mono-ui text-lg font-bold text-[#9debd3]">{starterCount}<span className="text-xs text-[#8da0a3]">/11</span></div><div className="text-[9px] uppercase tracking-[.12em] text-[#8da0a3]">XI</div></div><div><div className={cn('font-mono-ui text-lg font-bold', captain ? 'text-[#f6cf65]' : 'text-[#82909a]')}>{captain ? '✓' : '—'}</div><div className="text-[9px] uppercase tracking-[.12em] text-[#8da0a3]">Captain</div></div><div><div className={cn('font-mono-ui text-lg font-bold', vice ? 'text-[#f6cf65]' : 'text-[#82909a]')}>{vice ? '✓' : '—'}</div><div className="text-[9px] uppercase tracking-[.12em] text-[#8da0a3]">Vice</div></div></div>;
}

export function ChallengePage({ data, update }: { data: MiniAppBootstrap; update: (next: MiniAppBootstrap) => void }) {
  const locked = data.gameweek.locked;
  const existing = data.team.selectedPlayerIds;
  const [selected, setSelected] = useState<number[]>(existing);
  const [starters, setStarters] = useState<number[]>(data.team.startingPlayerIds);
  const [captain, setCaptain] = useState<number | null>(data.team.captainPlayerId);
  const [vice, setVice] = useState<number | null>(data.team.viceCaptainPlayerId);
  const [filter, setFilter] = useState('all');
  const saveTeam = useSaveMiniAppTeam();
  const byId = useMemo(() => new Map(data.players.map((player) => [player.id, player])), [data.players]);
  const filtered = data.players.filter((player) => filter === 'all' || player.position === filter);
  const selectedPlayers = selected.map((id) => byId.get(id)).filter(Boolean) as MiniAppPlayer[];
  const missing = selected.length !== 15 || starters.length !== 11 || !captain || !vice || captain === vice;
  const toggleSelected = (id: number) => {
    if (locked) return;
    if (selected.includes(id)) {
      setSelected((items) => items.filter((item) => item !== id));
      setStarters((items) => items.filter((item) => item !== id));
      if (captain === id) setCaptain(null);
      if (vice === id) setVice(null);
    } else if (selected.length < 15) setSelected((items) => [...items, id]);
  };
  const toggleStarter = (id: number) => {
    if (locked || !selected.includes(id)) return;
    if (starters.includes(id)) { setStarters((items) => items.filter((item) => item !== id)); if (captain === id) setCaptain(null); if (vice === id) setVice(null); }
    else if (starters.length < 11) setStarters((items) => [...items, id]);
  };
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const submit = () => {
    if (missing || locked) return;
    setPaymentError(null);
    saveTeam.mutate({ data: { selectedPlayerIds: selected, startingPlayerIds: starters, captainPlayerId: captain!, viceCaptainPlayerId: vice! } }, { onSuccess: update });
  };
  useEffect(() => {
    if (data.team.submissionStatus !== 'awaiting_payment') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const checkPayment = async () => {
      try {
        const result = await customFetch<{ status: 'not_started' | 'pending' | 'success' | 'failed' }>(
          '/api/mini-app/payment/status',
          { method: 'GET', responseType: 'json' },
        );
        if (!active) return;
        if (result.status === 'success') {
          const refreshed = await customFetch<MiniAppBootstrap>(
            '/api/mini-app/bootstrap',
            { method: 'GET', responseType: 'json' },
          );
          if (active) update(refreshed);
          return;
        }
        timer = setTimeout(checkPayment, 5000);
      } catch {
        if (active) timer = setTimeout(checkPayment, 7000);
      }
    };

    void checkPayment();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [data.team.submissionStatus, update]);

  const startPayment = async () => {
    setPaymentLoading(true);
    setPaymentError(null);
    try {
      const result = await customFetch<{ checkoutUrl: string }>(
        '/api/mini-app/payment/initialize',
        { method: 'POST', responseType: 'json' },
      );
      window.location.href = result.checkoutUrl;
    } catch {
      setPaymentError('የክፍያ ገጹን መክፈት አልተቻለም። እባክዎ እንደገና ይሞክሩ።');
    } finally {
      setPaymentLoading(false);
    }
  };
  return <div className="animate-rise"><SectionHeading eyebrow="የሳምንቱ ፈተና" title="የሳምንቱን ቡድን ይምረጡ" note="15 ተጫዋቾች · Starting XI · ካፒቴን እና ምክትል" action={<StatusPill tone={locked ? 'amber' : 'green'}>{locked ? <><LockKeyhole className="h-3 w-3" /> ተዘግቷል</> : 'ክፍት'}</StatusPill>} />{locked && <div className="mb-5 flex items-start gap-3 rounded-2xl border border-[#efd89e] bg-[#fff7dc] p-4 text-sm text-[#79581a]" data-testid="locked-banner"><LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" /><div><div className="font-bold">Gameweek ተዘግቷል</div><div className="mt-1 text-xs leading-5">Deadline ካለፈ በኋላ ምርጫ መቀየር አይቻልም።</div></div></div>}<div className="mb-5"><SelectionSummary selectedCount={selected.length} starterCount={starters.length} captain={!!captain} vice={!!vice} /></div><div className="grid gap-5 lg:grid-cols-[.85fr_1.15fr]"><div className="rounded-2xl border border-[#dce2e5] bg-[#fffdf8] p-4 sm:p-5"><div className="flex items-center justify-between"><div><div className="text-[10px] font-bold uppercase tracking-[.17em] text-[#198667]">Your XI</div><div className="mt-1 text-sm font-bold text-[#26354e]">Starting lineup</div></div><div className="font-mono-ui text-xs text-[#8190a1]">{starters.length}/11</div></div><div className="mt-4 space-y-2">{starters.length ? starters.map((id) => { const player = byId.get(id); return player ? <PlayerChip key={id} player={player} selected starter captain={captain === id} vice={vice === id} onClick={() => toggleStarter(id)} disabled={locked} /> : null; }) : <div className="rounded-xl bg-[#f1f4f5] p-5 text-center text-xs leading-5 text-[#718096]">ከቀኝ ያሉትን ተጫዋቾች ይምረጡ፣ ከዚያ Starting XI ያዘጋጁ።</div>}</div><div className="mt-4 border-t border-[#e8ecee] pt-4"><div className="mb-2 text-[10px] font-bold uppercase tracking-[.15em] text-[#718096]">ካፒቴን / ምክትል</div><div className="grid grid-cols-2 gap-2"><select value={captain ?? ''} onChange={(event) => setCaptain(event.target.value ? Number(event.target.value) : null)} disabled={locked} className="w-full rounded-xl border border-[#dce2e5] bg-[#f8faf9] px-3 py-2 text-xs font-semibold text-[#26354e]" data-testid="select-captain"><option value="">ካፒቴን ይምረጡ</option>{starters.map((id) => <option value={id} key={id}>{byId.get(id)?.name}</option>)}</select><select value={vice ?? ''} onChange={(event) => setVice(event.target.value ? Number(event.target.value) : null)} disabled={locked} className="w-full rounded-xl border border-[#dce2e5] bg-[#f8faf9] px-3 py-2 text-xs font-semibold text-[#26354e]" data-testid="select-vice-captain"><option value="">ምክትል ይምረጡ</option>{starters.map((id) => <option value={id} key={id}>{byId.get(id)?.name}</option>)}</select></div></div></div><div className="rounded-2xl border border-[#dce2e5] bg-[#fffdf8] p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-[10px] font-bold uppercase tracking-[.17em] text-[#198667]">የተጫዋቾች ዝርዝር</div><div className="mt-1 text-sm font-bold text-[#26354e]">ተጫዋቾች ይምረጡ</div></div><div className="flex gap-1 rounded-xl bg-[#eff2f3] p-1">{[['all','ሁሉም'],['goalkeeper','GK'],['defender','DEF'],['midfielder','MID'],['forward','FWD']].map(([value, label]) => <button type="button" key={value} onClick={() => setFilter(value)} className={cn('rounded-lg px-2 py-1.5 text-[10px] font-bold', filter === value ? 'bg-[#fffdf8] text-[#198667] shadow-sm' : 'text-[#8190a1]')} data-testid={`button-filter-${value}`}>{label}</button>)}</div></div><div className="mt-4 max-h-[600px] space-y-2 overflow-auto pr-1">{filtered.map((player) => <PlayerChip key={player.id} player={player} selected={selected.includes(player.id)} starter={starters.includes(player.id)} onClick={() => toggleSelected(player.id)} disabled={locked || (!selected.includes(player.id) && selected.length >= 15)} />)}</div></div></div>{data.team.submissionStatus === 'awaiting_payment' && <div className="mt-5 rounded-2xl border border-[#efd89e] bg-[#fff7dc] p-4" data-testid="payment-required"><div className="flex items-start gap-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#f7d77a] text-[#6f530f]"><Trophy className="h-4 w-4" /></div><div className="min-w-0 flex-1"><div className="text-sm font-bold text-[#5f4812]">የGW ውድድሩን ለመጨረስ ክፍያ ያስፈልጋል</div><div className="mt-1 text-xs leading-5 text-[#80682c]">ክፍያው እስኪረጋገጥ ድረስ ቡድንዎ በደረጃ ሰንጠረዥ አይገባም። ክፍያ ከጨረሱ በኋላ ማረጋገጫው በራሱ ይመጣል።</div></div><button type="button" onClick={() => void startPayment()} disabled={paymentLoading} className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-xl bg-[#182440] px-4 text-xs font-bold text-[#fffdf8] disabled:opacity-50">{paymentLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ArrowUpRight className="h-4 w-4" />}ክፍያ ጀምር</button></div>{paymentError && <div className="mt-3 text-xs font-semibold text-[#b24c40]">{paymentError}</div>}</div>}{data.team.submissionStatus === 'awaiting_payment' && <div className="mt-3 text-right text-[11px] text-[#8190a1]">ክፍያውን ከጨረሱ በኋላ ወደዚህ መተግበሪያ ይመለሱ።</div>}<div className="sticky bottom-3 z-10 mt-5 flex items-center justify-between gap-4 rounded-2xl border border-[#324566] bg-[#182440] p-3 text-[#f7f5ef] shadow-[0_12px_28px_rgba(29,43,70,.18)]"><div className="hidden text-xs text-[#a9b9bd] sm:block">{missing ? '15 ተጫዋቾች፣ 11 መጀመሪያ ተጫዋቾች፣ ካፒቴን እና ምክትል ያስፈልጋሉ።' : 'ምርጫዎ ለመረጋገጥ ዝግጁ ነው።'}</div><button type="button" disabled={missing || locked || saveTeam.isPending} onClick={submit} className="ml-auto inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#9debd3] px-5 text-sm font-bold text-[#182440] disabled:cursor-not-allowed disabled:opacity-45" data-testid="button-confirm-team">{saveTeam.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{saveTeam.isPending ? 'በመላክ ላይ…' : 'ቡድኔን አረጋግጥ'}</button></div>{saveTeam.isError && <div className="mt-3 text-right text-xs font-semibold text-[#b24c40]" data-testid="error-save-team">{extractApiErrorMessage(saveTeam.error) ?? 'ቡድኑን ማስቀመጥ አልተቻለም። እንደገና ይሞክሩ።'}</div>}</div>;
}

export function TeamPage({ data }: { data: MiniAppBootstrap }) {
  const byId = useMemo(() => new Map(data.players.map((player) => [player.id, player])), [data.players]);
  const starters = data.team.startingPlayerIds.map((id) => byId.get(id)).filter(Boolean) as MiniAppPlayer[];
  const bench = data.team.benchPlayerIds.map((id) => byId.get(id)).filter(Boolean) as MiniAppPlayer[];
  return <div className="animate-rise"><SectionHeading eyebrow="Saved team" title="የእኔ ቡድን" note={data.team.registered ? `የጨዋታ ሳምንት ${data.gameweek.id} · ${submissionStatusLabel(data.team.submissionStatus)}` : 'ገና የተመዘገበ ቡድን የለም'} action={<Link href="/challenge" className="inline-flex items-center gap-2 rounded-xl border border-[#d5dfe3] bg-[#fffdf8] px-3 py-2 text-xs font-bold text-[#26354e]" data-testid="link-edit-team"><SlidersHorizontal className="h-3.5 w-3.5" /> አርትዕ</Link>} />{!data.team.registered ? <EmptyState icon={Users} title="ቡድንዎ ገና አልተመዘገበም" text="የሳምንቱን ቡድን ይምረጡና ከዚህ በኋላ ነጥቦችዎን እዚህ ይመልከቱ።" action={<Link href="/challenge" className="rounded-xl bg-[#182440] px-4 py-3 text-xs font-bold text-[#fffdf8]" data-testid="link-build-team">ቡድን ጀምር</Link>} /> : <><div className="grid gap-4 sm:grid-cols-3"><MetricCard label="የእኔ ነጥብ" value={data.team.points} detail={data.team.pointsSource === 'fpl-live' ? 'ኦፊሴላዊ የFPL ነጥብ' : 'በመጠባበቅ ላይ'} icon={Zap} accent="amber" /><MetricCard label="Starting XI" value={starters.length} detail="በሜዳ ላይ" icon={Target} /><MetricCard label="Last update" value={formatDate(data.team.lastPointsUpdatedAt)} detail="ኦፊሴላዊ live ውሂብ" icon={RefreshCw} accent="navy" /></div><div className="mt-5 rounded-2xl border border-[#dce2e5] bg-[#fffdf8] p-4 sm:p-5"><div className="mb-4 flex items-center justify-between"><div><div className="text-[10px] font-bold uppercase tracking-[.17em] text-[#198667]">Official points</div><div className="mt-1 text-sm font-bold text-[#26354e]">Starting XI</div></div><StatusPill tone="green"><ShieldCheck className="h-3 w-3" /> {data.team.pointsSource === 'fpl-live' ? 'ኦፊሴላዊ የFPL ነጥብ' : data.team.pointsSource === 'pending' ? 'በመጠባበቅ ላይ' : data.team.pointsSource}</StatusPill></div><div className="grid gap-2 sm:grid-cols-2">{starters.map((player) => <PlayerChip key={player.id} player={player} starter captain={data.team.captainPlayerId === player.id} vice={data.team.viceCaptainPlayerId === player.id} scored={data.team.scoredPlayerIds.includes(player.id)} />)}</div><div className="mt-5 border-t border-[#e8ecee] pt-4"><div className="mb-3 text-[10px] font-bold uppercase tracking-[.17em] text-[#8190a1]">Bench / ምትክ</div><div className="grid gap-2 sm:grid-cols-2">{bench.length ? bench.map((player) => <PlayerChip key={player.id} player={player} scored={data.team.scoredPlayerIds.includes(player.id)} />) : <div className="text-xs text-[#8190a1]">የbench ዝርዝር የለም።</div>}</div></div></div></>}</div>;
}

export function LeaderboardPage({ data, update }: { data: MiniAppBootstrap; update: (next: MiniAppBootstrap) => void }) {
  const refresh = useRefreshMiniAppLeaderboard();
  const runRefresh = () => refresh.mutate(undefined, { onSuccess: update });
  return <div className="animate-rise"><SectionHeading eyebrow="Current gameweek" title="ደረጃ ሰንጠረዥ" note="የFPL Signal Ethiopia ተጫዋቾች የዚህ ሳምንት ውጤት።" action={<button type="button" onClick={runRefresh} disabled={refresh.isPending} className="inline-flex items-center gap-2 rounded-xl bg-[#182440] px-3 py-2 text-xs font-bold text-[#fffdf8] disabled:opacity-60" data-testid="button-refresh-leaderboard"><RefreshCw className={cn('h-3.5 w-3.5', refresh.isPending && 'animate-spin')} />{refresh.isPending ? 'በመታደስ ላይ' : 'አድስ'}</button>} /><div className="mb-5 grid gap-4 sm:grid-cols-3"><MetricCard label="Gameweek" value={data.gameweek.id} detail={data.gameweek.status} icon={Activity} /><MetricCard label="ተሳታፊዎች" value={data.leaderboard.length} detail="የተመዘገቡ ቡድኖች" icon={Users} accent="navy" /><MetricCard label="Updated" value={formatDate(data.leaderboard[0]?.lastUpdatedAt)} detail="የመጨረሻ ማሻሻያ" icon={Clock3} accent="amber" /></div><div className="overflow-hidden rounded-2xl border border-[#dce2e5] bg-[#fffdf8]" data-testid="leaderboard-table"><div className="grid grid-cols-[48px_1fr_90px] gap-3 border-b border-[#e8ecee] px-4 py-3 text-[10px] font-bold uppercase tracking-[.15em] text-[#8190a1] sm:grid-cols-[60px_1fr_120px_150px]"><span>#</span><span>ተጫዋች</span><span className="text-right">ነጥብ</span><span className="hidden text-right sm:block">መጨረሻ ማሻሻያ</span></div>{data.leaderboard.length ? data.leaderboard.map((entry, index) => <div key={`${entry.displayName}-${entry.rank}`} className={cn('grid grid-cols-[48px_1fr_90px] items-center gap-3 px-4 py-3.5 sm:grid-cols-[60px_1fr_120px_150px]', entry.isCurrentUser && 'bg-[#e9f8f2]')} data-testid={`row-leaderboard-${index}`}><div className={cn('font-mono-ui text-sm font-bold', entry.rank <= 3 ? 'text-[#bb791c]' : 'text-[#8190a1]')}>{entry.rank < 10 ? `0${entry.rank}` : entry.rank}</div><div className="flex items-center gap-2"><div className={cn('flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold', entry.isCurrentUser ? 'bg-[#9debd3] text-[#182440]' : 'bg-[#e9edf2] text-[#627187]')}>{entry.displayName.slice(0, 1).toUpperCase()}</div><div className="min-w-0"><div className="truncate text-sm font-bold text-[#26354e]">{entry.displayName}{entry.isCurrentUser && <span className="ml-2 text-[10px] font-bold text-[#198667]">እርስዎ</span>}</div><div className="text-[10px] text-[#8190a1]">FPL Signal player</div></div></div><div className="text-right font-mono-ui text-sm font-bold text-[#182440]">{entry.points}</div><div className="hidden text-right text-xs text-[#8190a1] sm:block">{formatDate(entry.lastUpdatedAt)}</div></div>) : <div className="p-8"><EmptyState icon={Trophy} title="ገና ደረጃ የለም" text="የመጀመሪያው የቡድን ማስቀመጫ ከተደረገ በኋላ ደረጃው ይታያል።" /></div>}</div>{refresh.isError && <div className="mt-3 text-xs font-semibold text-[#b24c40]" data-testid="error-refresh-leaderboard">ደረጃውን ማደስ አልተቻለም።</div>}</div>;
}

export function PointsPage({ data }: { data: MiniAppBootstrap }) {
  const [search, setSearch] = useState('');
  const [position, setPosition] = useState('all');
  const [sort, setSort] = useState<'points' | 'minutes' | 'price'>('points');
  const players = useMemo(() => data.players.filter((player) => (position === 'all' || player.position === position) && `${player.name} ${player.club}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => sort === 'points' ? b.totalPoints - a.totalPoints : sort === 'minutes' ? b.minutes - a.minutes : b.price - a.price), [data.players, position, search, sort]);
  return <div className="animate-rise"><SectionHeading eyebrow="Official player data" title="የተጫዋች ነጥቦች" note="የኦፊሴላዊ የFPL ነጥብ መረጃ፤ ምንም የራስ ስሌት አልተጨመረም።" /><div className="mb-5 grid gap-3 sm:grid-cols-[1fr_auto_auto]"><label className="flex items-center gap-2 rounded-xl border border-[#dce2e5] bg-[#fffdf8] px-3 py-2.5"><Search className="h-4 w-4 text-[#8190a1]" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ተጫዋች ወይም ክለብ ፈልግ" className="w-full bg-transparent text-sm outline-none placeholder:text-[#a0aab6]" data-testid="input-search-players" /></label><select value={position} onChange={(event) => setPosition(event.target.value)} className="rounded-xl border border-[#dce2e5] bg-[#fffdf8] px-3 py-2.5 text-xs font-bold text-[#526176]" data-testid="select-player-position"><option value="all">ሁሉም ቦታዎች</option><option value="goalkeeper">Goalkeeper</option><option value="defender">Defender</option><option value="midfielder">Midfielder</option><option value="forward">Forward</option></select><select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="rounded-xl border border-[#dce2e5] bg-[#fffdf8] px-3 py-2.5 text-xs font-bold text-[#526176]" data-testid="select-sort-players"><option value="points">በነጥብ ደርድር</option><option value="minutes">በደቂቃ ደርድር</option><option value="price">በዋጋ ደርድር</option></select></div><div className="overflow-hidden rounded-2xl border border-[#dce2e5] bg-[#fffdf8]" data-testid="points-table"><div className="grid grid-cols-[1fr_68px_68px] gap-2 border-b border-[#e8ecee] px-4 py-3 text-[10px] font-bold uppercase tracking-[.14em] text-[#8190a1] sm:grid-cols-[1fr_110px_90px_90px]"><span>ተጫዋች</span><span className="text-right">ነጥብ</span><span className="hidden text-right sm:block">ደቂቃ</span><span className="text-right">ዋጋ</span></div>{players.length ? players.map((player) => <div key={player.id} className="grid grid-cols-[1fr_68px_68px] items-center gap-2 px-4 py-3 sm:grid-cols-[1fr_110px_90px_90px]" data-testid={`row-points-${player.id}`}><div className="flex min-w-0 items-center gap-3"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#edf0f5] font-mono-ui text-[9px] font-bold text-[#647187]">{positionLabel(player.position)}</div><div className="min-w-0"><div className="truncate text-sm font-bold text-[#26354e]">{player.name}</div><div className="truncate text-[10px] text-[#8190a1]">{player.club} · {playerStatus(player)}</div></div></div><div className="text-right font-mono-ui text-sm font-bold text-[#198667]">{player.totalPoints}</div><div className="hidden text-right font-mono-ui text-xs text-[#526176] sm:block">{player.minutes}'</div><div className="text-right font-mono-ui text-xs font-bold text-[#526176]">£{player.price.toFixed(1)}</div></div>) : <div className="p-8"><EmptyState icon={Search} title="ምንም ውጤት የለም" text="የፍለጋ ቃሉን ወይም ማጣሪያውን ይቀይሩ።" /></div>}</div></div>;
}

const signalKindLabel: Record<string, string> = {
  value: 'ዋጋ/ነጥብ',
  form: 'የመልካም ፎርም',
  differential: 'ዲፈረንሻል',
  captain: 'የካፒቴን ምርጫ',
  injury: 'የቆይታ ሁኔታ',
  price_rise: 'በብዙዎች ዘንድ',
  price_drop: 'ዋጋ መቀነስ',
};

export function SignalPage({ data }: { data: MiniAppBootstrap }) {
  const signal = data.signal;
  return <div className="animate-rise"><SectionHeading eyebrow="የመረጃ ምልክቶች" title="Signal" note="ከኦፊሴላዊ የFPL መረጃ የተወሰዱ አሁን ያሉ እውነታዎች ብቻ።" /><div className="grid gap-4"><div className="rounded-2xl border border-[#e3d9c3] bg-[#fdf8ec] p-4 text-sm leading-6 text-[#7a6130]" data-testid="signal-disclaimer"><span className="font-bold">ማስታወሻ፦</span> {signal.disclaimer || 'ምልክቶቹ የአሁኑን መረጃ ያሳያሉ፤ የወደፊት ነጥብ ዋስትና አይሰጡም።'}</div>{signal.available && signal.signals.length > 0 ? signal.signals.map((item) => <div key={`${item.kind}-${item.playerId}`} className="rounded-2xl border border-[#dce2e5] bg-[#fffdf8] p-5" data-testid={`signal-card-${item.kind}`}><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><span className="rounded-lg bg-[#e4f8f1] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.12em] text-[#198667]">{signalKindLabel[item.kind] ?? item.kind}</span><span className="text-[11px] text-[#8190a1]">{positionLabel(item.position)} · {item.club}</span></div><span className="font-mono-ui text-xs font-bold text-[#526176]">£{item.price.toFixed(1)}m</span></div><div className="mt-3 flex items-center gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#f1f4f5] font-display text-sm font-bold text-[#26354e]">{item.playerName.slice(0, 1).toUpperCase()}</div><div><div className="text-sm font-bold text-[#26354e]">{item.playerName}</div><div className="mt-0.5 text-xs font-semibold text-[#198667]">{item.title}</div></div></div><p className="mt-3 text-sm leading-6 text-[#718096]">{item.detail}</p></div>) : <div className="rounded-[26px] border border-[#dce2e5] bg-[#fffdf8] p-6 sm:p-10"><div className="mx-auto flex max-w-lg flex-col items-center text-center"><div className="relative mb-6 flex h-20 w-20 items-center justify-center rounded-[24px] bg-[#e4f8f1] text-[#198667]"><div className="absolute inset-3 rounded-[18px] border border-[#9debd3]" /><Zap className="relative h-8 w-8" /></div><h2 className="mt-5 font-display text-2xl font-bold tracking-[-.04em] text-[#182440]">ገና ምልክት የለም</h2><p className="mt-3 text-sm leading-7 text-[#718096]" data-testid="text-signal-message">{signal.message || 'በአሁኑ ሰዓት በቂ እና የታመነ መረጃ የለም። መረጃ ሲረጋገጥ እዚህ ይታያል።'}</p></div></div>}</div></div>;
}

export function AboutPage() {
  return <div className="animate-rise"><SectionHeading eyebrow="Product notes" title="ስለ FPL Signal Ethiopia" note="ከTelegram ውስጥ የሚሰራ የFPL የውሳኔ መሳሪያ።" /><div className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]"><div className="rounded-[26px] bg-[#182440] p-6 text-[#f7f5ef] sm:p-8"><div className="flex items-center gap-3"><LogoMark /><div className="font-display text-lg font-bold">FPL Signal Ethiopia</div></div><h2 className="mt-10 max-w-[520px] font-display text-3xl font-bold leading-tight tracking-[-.05em] sm:text-4xl">ፈጣን። ግልጽ።<br /><span className="text-[#9debd3]">የታመነ።</span></h2><p className="mt-5 max-w-[510px] text-sm leading-7 text-[#b7c7c6]">በTelegram ውስጥ የሚገኝ የFPL ዳሽቦርድ። የሳምንቱን ቡድን ለመምረጥ የሚያስፈልገውን መረጃ በአንድ የግልጽ የውሳኔ ክፍል ያቀርባል።</p><div className="mt-8 flex flex-wrap gap-2"><span className="rounded-lg bg-[#273754] px-3 py-2 text-[10px] font-bold uppercase tracking-[.14em] text-[#9debd3]">Amharic-first</span><span className="rounded-lg bg-[#273754] px-3 py-2 text-[10px] font-bold uppercase tracking-[.14em] text-[#f5cf6b]">Official points</span><span className="rounded-lg bg-[#273754] px-3 py-2 text-[10px] font-bold uppercase tracking-[.14em] text-[#b9c8d8]">Telegram native</span></div></div><div className="space-y-3">{[{ icon: ShieldCheck, title: 'የታመነ ምንጭ', text: 'ነጥቦችን ከኦፊሴላዊ የFPL live ውሂብ ብቻ እናመጣለን።' }, { icon: Target, title: 'ግልጽ የውሳኔ ሂደት', text: '15 ተጫዋቾች፣ Starting XI፣ Captain እና Vice-Captain—በአንድ ቦታ።' }, { icon: Bot, title: 'Signal ሲኖር ብቻ', text: 'በቂ መረጃ ከሌለ ምክር አንሰጥም። ታማኝነት ከጫጫታ ይበልጣል።' }].map(({ icon: Icon, title, text }) => <div key={title} className="rounded-2xl border border-[#dce2e5] bg-[#fffdf8] p-5"><div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#e4f8f1] text-[#198667]"><Icon className="h-5 w-5" /></div><div className="font-display font-bold text-[#26354e]">{title}</div></div><p className="mt-3 pl-[52px] text-sm leading-6 text-[#718096]">{text}</p></div>)}</div></div></div>;
}

export function MiniApp() {
  const queryClient = useQueryClient();
  const bootstrap = useGetMiniAppBootstrap({ query: { queryKey: getGetMiniAppBootstrapQueryKey(), retry: 1 } });
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), staleTime: 60_000, retry: 0 } });
  const [location] = useLocation();
  useEffect(() => prepareTelegramApp(), []);
  if (bootstrap.isLoading) return <LoadingState />;
  if (bootstrap.isError || !bootstrap.data) {
    const maybeError = bootstrap.error as { status?: number } | null;
    return <ErrorState unauthenticated={maybeError?.status === 401 || maybeError?.status === 403} onRetry={() => void bootstrap.refetch()} />;
  }
  const data = bootstrap.data as MiniAppBootstrap;
  const update = useCallback((next: MiniAppBootstrap) => {
    queryClient.setQueryData(getGetMiniAppBootstrapQueryKey(), next);
  }, [queryClient]);
  const page = location === '/challenge' ? <ChallengePage data={data} update={update} /> : location === '/team' ? <TeamPage data={data} /> : location === '/leaderboard' ? <LeaderboardPage data={data} update={update} /> : location === '/points' ? <PointsPage data={data} /> : location === '/signal' ? <SignalPage data={data} /> : location === '/about' ? <AboutPage /> : <HomePage data={data} />;
  return <Shell data={data}><div className={cn('mb-6 flex items-center justify-between rounded-xl border px-3 py-2 text-xs', health.isError ? 'border-[#f0d4c7] bg-[#fff2eb] text-[#9b5945]' : 'border-[#d9e9e2] bg-[#f0f8f4] text-[#397c68]')} data-testid="status-system"><span className="flex items-center gap-2">{health.isError ? <WifiOff className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full bg-[#198667] animate-pulse-soft" />}{health.isError ? 'የመረጃ አገልግሎት ጊዜያዊ ችግር' : 'የመረጃ አገልግሎት ንቁ ነው'}</span><span className="font-mono-ui text-[9px] uppercase tracking-[.1em]">{health.data?.status || 'secure channel'}</span></div>{page}</Shell>;
}