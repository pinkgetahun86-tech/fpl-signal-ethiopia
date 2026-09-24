import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import {
  Check,
  Clock3,
  LogOut,
  RefreshCw,
  X,
} from "lucide-react";
import { customFetch } from "@workspace/api-client-react";

type WithdrawalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "paid";

type Withdrawal = {
  id: number;
  telegramUserId: number;
  method: string;
  amountEtb: number;
  destination: string;
  status: WithdrawalStatus;
  payoutReference: string | null;
  adminNote: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type WithdrawalsResponse = {
  withdrawals: Withdrawal[];
};

const TOKEN_KEY = "fpl_signal_admin_token";

const statusLabel: Record<WithdrawalStatus, string> = {
  pending: "በመጠባበቅ ላይ",
  approved: "ተፈቅዷል",
  rejected: "ተሰርዟል",
  paid: "ተከፍሏል",
};

function formatDate(value: string | null) {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("am-ET", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function statusClass(status: WithdrawalStatus) {
  switch (status) {
    case "pending":
      return "border-yellow-500/30 bg-yellow-500/10 text-yellow-300";

    case "approved":
      return "border-blue-500/30 bg-blue-500/10 text-blue-300";

    case "paid":
      return "border-green-500/30 bg-green-500/10 text-green-300";

    case "rejected":
      return "border-red-500/30 bg-red-500/10 text-red-300";

    default:
      return "border-border bg-card text-foreground";
  }
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return "አንድ ችግር ተፈጥሯል።";
}

export default function AdminPage() {
  const [token, setToken] = useState("");
  const [tokenInput, setTokenInput] = useState("");

  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>(
    [],
  );

  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState<number | null>(
    null,
  );

  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadWithdrawals = useCallback(async () => {
    if (!token.trim()) return;

    setLoading(true);
    setError("");

    try {
      const data =
        await customFetch<WithdrawalsResponse>(
          "/api/admin/wallet/withdrawals?limit=200",
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
            },
            responseType: "json",
            cache: "no-store",
          },
        );

      setWithdrawals(
        Array.isArray(data?.withdrawals)
          ? data.withdrawals
          : [],
      );
    } catch (err) {
      setError(getErrorMessage(err));
      setWithdrawals([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    const savedToken =
      window.sessionStorage.getItem(TOKEN_KEY);

    if (savedToken) {
      setToken(savedToken);
    }
  }, []);

  useEffect(() => {
    if (token) {
      void loadWithdrawals();
    }
  }, [token, loadWithdrawals]);

  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const value = tokenInput.trim();

    if (!value) {
      setError("Admin Token ያስገቡ።");
      return;
    }

    window.sessionStorage.setItem(TOKEN_KEY, value);

    setToken(value);
    setTokenInput("");
    setError("");
    setMessage("");
  }

  function logout() {
    window.sessionStorage.removeItem(TOKEN_KEY);

    setToken("");
    setWithdrawals([]);
    setError("");
    setMessage("");
  }

  async function performAction(
    withdrawalId: number,
    action: "approve" | "reject" | "paid",
  ) {
    let payoutReference: string | undefined;
    let adminNote: string | undefined;

    if (action === "paid") {
      const value = window.prompt(
        "የTelebirr ክፍያ Transaction Reference ያስገቡ:",
      );

      if (value === null) {
        return;
      }

      payoutReference = value.trim();

      if (!payoutReference) {
        setError("Payout Reference ያስፈልጋል።");
        return;
      }

      if (payoutReference.length > 120) {
        setError(
          "Payout Reference ከ120 ፊደላት መብለጥ የለበትም።",
        );
        return;
      }
    }

    if (action === "reject") {
      const value = window.prompt(
        "የመሰረዝ ምክንያት ያስገቡ (አማራጭ):",
      );

      if (value !== null) {
        adminNote = value.trim() || undefined;
      }
    }

    setActingId(withdrawalId);
    setError("");
    setMessage("");

    try {
      const body =
        action === "paid"
          ? {
              payoutReference,
              adminNote,
            }
          : action === "reject"
            ? {
                adminNote,
              }
            : undefined;

      await customFetch(
        `/api/admin/wallet/withdrawals/${withdrawalId}/${action}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          ...(body
            ? {
                body: JSON.stringify(body),
              }
            : {}),
          responseType: "json",
        },
      );

      if (action === "approve") {
        setMessage(
          "የWithdrawal ጥያቄው ተፈቅዷል።",
        );
      } else if (action === "reject") {
        setMessage(
          "የWithdrawal ጥያቄው ተሰርዟል። ገንዘቡም ወደ Wallet ተመልሷል።",
        );
      } else {
        setMessage(
          "ክፍያው እንደተፈጸመ ተመዝግቧል።",
        );
      }

      await loadWithdrawals();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setActingId(null);
    }
  }

  if (!token) {
    return (
      <main className="min-h-screen bg-background px-4 py-8 text-foreground">
        <div className="mx-auto max-w-md">
          <div className="rounded-2xl border border-border bg-card p-6 shadow-lg">
            <h1 className="mb-2 text-2xl font-bold">
              FPL Signal Admin
            </h1>

            <p className="mb-6 text-sm text-muted-foreground">
              Admin Token በማስገባት የWallet Withdrawal
              አስተዳደርን ይክፈቱ።
            </p>

            <form
              onSubmit={login}
              className="space-y-4"
            >
              <input
                type="password"
                value={tokenInput}
                onChange={(event) =>
                  setTokenInput(event.target.value)
                }
                placeholder="Admin Token"
                autoComplete="current-password"
                className="w-full rounded-xl border border-border bg-background px-4 py-3 outline-none focus:ring-2 focus:ring-primary"
              />

              {error ? (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  {error}
                </div>
              ) : null}

              <button
                type="submit"
                className="w-full rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground"
              >
                Admin ግባ
              </button>
            </form>
          </div>
        </div>
      </main>
    );
  }

  const pendingCount = withdrawals.filter(
    (item) => item.status === "pending",
  ).length;

  const approvedCount = withdrawals.filter(
    (item) => item.status === "approved",
  ).length;

  const paidCount = withdrawals.filter(
    (item) => item.status === "paid",
  ).length;

  const rejectedCount = withdrawals.filter(
    (item) => item.status === "rejected",
  ).length;

  return (
    <main className="min-h-screen bg-background px-3 py-5 text-foreground sm:px-6">
      <div className="mx-auto max-w-5xl">
        <header className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">
              FPL Signal Admin
            </h1>

            <p className="text-sm text-muted-foreground">
              Wallet Withdrawal Management
            </p>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void loadWithdrawals()}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm disabled:opacity-50"
            >
              <RefreshCw
                className={`h-4 w-4 ${
                  loading ? "animate-spin" : ""
                }`}
              />
              Refresh
            </button>

            <button
              type="button"
              onClick={logout}
              className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm"
            >
              <LogOut className="h-4 w-4" />
              ውጣ
            </button>
          </div>
        </header>

        {message ? (
          <div className="mb-4 rounded-xl border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300">
            {message}
          </div>
        ) : null}

        {error ? (
          <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        ) : null}

        <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="text-sm text-muted-foreground">
              Pending
            </div>

            <div className="mt-1 text-2xl font-bold">
              {pendingCount}
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="text-sm text-muted-foreground">
              Approved
            </div>

            <div className="mt-1 text-2xl font-bold">
              {approvedCount}
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="text-sm text-muted-foreground">
              Paid
            </div>

            <div className="mt-1 text-2xl font-bold">
              {paidCount}
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="text-sm text-muted-foreground">
              Rejected
            </div>

            <div className="mt-1 text-2xl font-bold">
              {rejectedCount}
            </div>
          </div>
        </section>

        {loading && withdrawals.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card p-8 text-center text-muted-foreground">
            <RefreshCw className="mx-auto mb-3 h-6 w-6 animate-spin" />
            Withdrawal መረጃ እየተጫነ ነው...
          </div>
        ) : withdrawals.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card p-8 text-center text-muted-foreground">
            ምንም Withdrawal ጥያቄ የለም።
          </div>
        ) : (
          <div className="space-y-3">
            {withdrawals.map((withdrawal) => {
              const busy =
                actingId === withdrawal.id;

              return (
                <article
                  key={withdrawal.id}
                  className="rounded-2xl border border-border bg-card p-4 shadow-sm"
                >
                  <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-lg font-bold">
                        {withdrawal.amountEtb.toLocaleString()} ETB
                      </div>

                      <div className="mt-1 text-xs text-muted-foreground">
                        Withdrawal #{withdrawal.id}
                      </div>
                    </div>

                    <span
                      className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusClass(
                        withdrawal.status,
                      )}`}
                    >
                      {statusLabel[withdrawal.status]}
                    </span>
                  </div>

                  <div className="grid gap-3 text-sm md:grid-cols-2">
                    <div>
                      <div className="text-xs text-muted-foreground">
                        Telegram User ID
                      </div>

                      <div className="font-medium">
                        {withdrawal.telegramUserId}
                      </div>
                    </div>

                    <div>
                      <div className="text-xs text-muted-foreground">
                        Method
                      </div>

                      <div className="font-medium">
                        {withdrawal.method}
                      </div>
                    </div>

                    <div>
                      <div className="text-xs text-muted-foreground">
                        Telebirr
                      </div>

                      <div className="break-all font-medium">
                        {withdrawal.destination || "—"}
                      </div>
                    </div>

                    <div>
                      <div className="text-xs text-muted-foreground">
                        Created
                      </div>

                      <div className="font-medium">
                        {formatDate(withdrawal.createdAt)}
                      </div>
                    </div>

                    <div>
                      <div className="text-xs text-muted-foreground">
                        Updated
                      </div>

                      <div className="font-medium">
                        {formatDate(withdrawal.updatedAt)}
                      </div>
                    </div>

                    {withdrawal.approvedAt ? (
                      <div>
                        <div className="text-xs text-muted-foreground">
                          Approved
                        </div>

                        <div className="font-medium">
                          {formatDate(withdrawal.approvedAt)}
                        </div>
                      </div>
                    ) : null}

                    {withdrawal.rejectedAt ? (
                      <div>
                        <div className="text-xs text-muted-foreground">
                          Rejected
                        </div>

                        <div className="font-medium">
                          {formatDate(withdrawal.rejectedAt)}
                        </div>
                      </div>
                    ) : null}

                    {withdrawal.paidAt ? (
                      <div>
                        <div className="text-xs text-muted-foreground">
                          Paid
                        </div>

                        <div className="font-medium">
                          {formatDate(withdrawal.paidAt)}
                        </div>
                      </div>
                    ) : null}

                    {withdrawal.payoutReference ? (
                      <div>
                        <div className="text-xs text-muted-foreground">
                          Payout Reference
                        </div>

                        <div className="break-all font-medium">
                          {withdrawal.payoutReference}
                        </div>
                      </div>
                    ) : null}

                    {withdrawal.adminNote ? (
                      <div className="md:col-span-2">
                        <div className="text-xs text-muted-foreground">
                          Admin Note
                        </div>

                        <div className="font-medium">
                          {withdrawal.adminNote}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {withdrawal.status === "pending" ? (
                    <div className="mt-5 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void performAction(
                            withdrawal.id,
                            "approve",
                          )
                        }
                        className="inline-flex items-center gap-2 rounded-xl bg-green-600 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy ? (
                          <RefreshCw className="h-4 w-4 animate-spin" />
                        ) : (
                          <Check className="h-4 w-4" />
                        )}

                        Approve
                      </button>

                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void performAction(
                            withdrawal.id,
                            "reject",
                          )
                        }
                        className="inline-flex items-center gap-2 rounded-xl border border-red-500/40 px-4 py-3 text-sm font-semibold text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy ? (
                          <RefreshCw className="h-4 w-4 animate-spin" />
                        ) : (
                          <X className="h-4 w-4" />
                        )}

                        Reject
                      </button>
                    </div>
                  ) : null}

                  {withdrawal.status === "approved" ? (
                    <div className="mt-5">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void performAction(
                            withdrawal.id,
                            "paid",
                          )
                        }
                        className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy ? (
                          <RefreshCw className="h-4 w-4 animate-spin" />
                        ) : (
                          <Check className="h-4 w-4" />
                        )}

                        ክፍያ ተፈጽሟል
                      </button>
                    </div>
                  ) : null}

                  {withdrawal.status === "paid" ? (
                    <div className="mt-4 inline-flex items-center gap-2 text-sm text-green-300">
                      <Check className="h-4 w-4" />
                      ክፍያው ተመዝግቧል
                    </div>
                  ) : null}

                  {withdrawal.status === "rejected" ? (
                    <div className="mt-4 inline-flex items-center gap-2 text-sm text-red-300">
                      <X className="h-4 w-4" />
                      ጥያቄው ተሰርዟል
                    </div>
                  ) : null}

                  {withdrawal.status === "pending" ? (
                    <div className="mt-4 inline-flex items-center gap-2 text-xs text-muted-foreground">
                      <Clock3 className="h-4 w-4" />
                      Admin ማጽደቅ ይጠብቃል
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
