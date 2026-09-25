import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  LogOut,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { customFetch } from "@workspace/api-client-react";

const ADMIN_TOKEN_KEY = "fpl_signal_admin_token";

type DepositStatus = "pending" | "approved" | "rejected";

type Deposit = {
  id: string;
  walletAccountId?: string;
  telegramUserId?: string;
  method?: string;
  amountEtb?: string | number;
  transactionReference?: string | null;
  status?: DepositStatus | string;
  adminNote?: string | null;
  approvedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

type WithdrawalStatus = "pending" | "approved" | "paid" | "rejected";

type Withdrawal = {
  id: string;
  walletAccountId?: string;
  telegramUserId?: string;
  amountEtb?: string | number;
  method?: string;
  payoutReference?: string | null;
  status?: WithdrawalStatus | string;
  adminNote?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

function formatDate(value?: string | null) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function formatAmount(value?: string | number) {
  const amount = Number(value ?? 0);

  if (Number.isNaN(amount)) {
    return "0.00 ETB";
  }

  return `${amount.toFixed(2)} ETB`;
}

function methodLabel(method?: string) {
  if (!method) return "-";

  if (method === "telebirr_manual") {
    return "Telebirr";
  }

  return method;
}

function statusClass(status?: string) {
  switch (status) {
    case "pending":
      return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
    case "approved":
      return "bg-green-500/10 text-green-400 border-green-500/20";
    case "paid":
      return "bg-blue-500/10 text-blue-400 border-blue-500/20";
    case "rejected":
      return "bg-red-500/10 text-red-400 border-red-500/20";
    default:
      return "bg-white/5 text-white/60 border-white/10";
  }
}

export default function AdminPage() {
  const [token, setToken] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);

  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);

  const [loadingDeposits, setLoadingDeposits] = useState(false);
  const [loadingWithdrawals, setLoadingWithdrawals] = useState(false);

  const [actionId, setActionId] = useState<string | null>(null);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    const savedToken = sessionStorage.getItem(ADMIN_TOKEN_KEY);

    if (savedToken) {
      setToken(savedToken);
      setLoggedIn(true);
    }
  }, []);

  const loadDeposits = useCallback(async () => {
    if (!token) return;

    setLoadingDeposits(true);

    try {
      const response = await customFetch<{
        deposits: Deposit[];
      }>("/api/admin/wallet/deposits", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
        responseType: "json",
      });

      setDeposits(response.deposits ?? []);
    } catch (err) {
      console.error(err);
      setError("Wallet Deposits መረጃን ማምጣት አልተቻለም።");
    } finally {
      setLoadingDeposits(false);
    }
  }, [token]);

  const loadWithdrawals = useCallback(async () => {
    if (!token) return;

    setLoadingWithdrawals(true);

    try {
      const response = await customFetch<{
        withdrawals: Withdrawal[];
      }>("/api/admin/wallet/withdrawals", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
        responseType: "json",
      });

      setWithdrawals(response.withdrawals ?? []);
    } catch (err) {
      console.error(err);
      setError("Wallet Withdrawals መረጃን ማምጣት አልተቻለም።");
    } finally {
      setLoadingWithdrawals(false);
    }
  }, [token]);

  const refreshAll = useCallback(async () => {
    setError("");
    setSuccess("");

    await Promise.all([loadDeposits(), loadWithdrawals()]);
  }, [loadDeposits, loadWithdrawals]);

  useEffect(() => {
    if (!loggedIn || !token) return;

    refreshAll();
  }, [loggedIn, token, refreshAll]);

  const login = () => {
    if (!token.trim()) {
      setError("Admin Token ያስገቡ።");
      return;
    }

    sessionStorage.setItem(ADMIN_TOKEN_KEY, token.trim());

    setToken(token.trim());
    setLoggedIn(true);
    setError("");
  };

  const logout = () => {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);

    setToken("");
    setLoggedIn(false);
    setDeposits([]);
    setWithdrawals([]);
    setSuccess("");
    setError("");
  };

  const approveDeposit = async (deposit: Deposit) => {
    const confirmed = window.confirm(
      `ይህን ${formatAmount(deposit.amountEtb)} Deposit Approve ማድረግ ይፈልጋሉ?`
    );

    if (!confirmed) return;

    setActionId(`deposit-approve-${deposit.id}`);
    setError("");
    setSuccess("");

    try {
      await customFetch(
        `/api/admin/wallet/deposits/${deposit.id}/approve`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
          responseType: "json",
        }
      );

      setSuccess(
        `${formatAmount(deposit.amountEtb)} Deposit Approved ሆኗል። Wallet ላይ ተጨምሯል።`
      );

      await refreshAll();
    } catch (err) {
      console.error(err);
      setError("Deposit Approve ማድረግ አልተቻለም።");
    } finally {
      setActionId(null);
    }
  };

  const rejectDeposit = async (deposit: Deposit) => {
    const reason = window.prompt(
      "Deposit ለምን Reject እንደተደረገ ምክንያት ያስገቡ።"
    );

    if (reason === null) return;

    setActionId(`deposit-reject-${deposit.id}`);
    setError("");
    setSuccess("");

    try {
      await customFetch(
        `/api/admin/wallet/deposits/${deposit.id}/reject`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            adminNote: reason.trim() || "Rejected by admin",
          }),
          responseType: "json",
        }
      );

      setSuccess("Deposit Rejected ሆኗል።");

      await refreshAll();
    } catch (err) {
      console.error(err);
      setError("Deposit Reject ማድረግ አልተቻለም።");
    } finally {
      setActionId(null);
    }
  };

  const approveWithdrawal = async (withdrawal: Withdrawal) => {
    const confirmed = window.confirm(
      `ይህን ${formatAmount(
        withdrawal.amountEtb
      )} Withdrawal Approve ማድረግ ይፈልጋሉ?`
    );

    if (!confirmed) return;

    setActionId(`withdrawal-approve-${withdrawal.id}`);
    setError("");
    setSuccess("");

    try {
      await customFetch(
        `/api/admin/wallet/withdrawals/${withdrawal.id}/approve`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
          responseType: "json",
        }
      );

      setSuccess("Withdrawal Approved ሆኗል።");

      await refreshAll();
    } catch (err) {
      console.error(err);
      setError("Withdrawal Approve ማድረግ አልተቻለም።");
    } finally {
      setActionId(null);
    }
  };

  const rejectWithdrawal = async (withdrawal: Withdrawal) => {
    const reason = window.prompt(
      "Withdrawal ለምን Reject እንደተደረገ ምክንያት ያስገቡ።"
    );

    if (reason === null) return;

    setActionId(`withdrawal-reject-${withdrawal.id}`);
    setError("");
    setSuccess("");

    try {
      await customFetch(
        `/api/admin/wallet/withdrawals/${withdrawal.id}/reject`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            adminNote: reason.trim() || "Rejected by admin",
          }),
          responseType: "json",
        }
      );

      setSuccess("Withdrawal Rejected ሆኗል።");

      await refreshAll();
    } catch (err) {
      console.error(err);
      setError("Withdrawal Reject ማድረግ አልተቻለም።");
    } finally {
      setActionId(null);
    }
  };

  const markWithdrawalPaid = async (withdrawal: Withdrawal) => {
    const payoutReference = window.prompt(
      "Telebirr / payout transaction reference ያስገቡ።"
    );

    if (payoutReference === null) return;

    if (!payoutReference.trim()) {
      setError("Payout reference ያስገቡ።");
      return;
    }

    setActionId(`withdrawal-paid-${withdrawal.id}`);
    setError("");
    setSuccess("");

    try {
      await customFetch(
        `/api/admin/wallet/withdrawals/${withdrawal.id}/paid`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            payoutReference: payoutReference.trim(),
          }),
          responseType: "json",
        }
      );

      setSuccess("Withdrawal Paid ተብሎ ተመዝግቧል።");

      await refreshAll();
    } catch (err) {
      console.error(err);
      setError("Withdrawal Paid ማድረግ አልተቻለም።");
    } finally {
      setActionId(null);
    }
  };

  if (!loggedIn) {
    return (
      <main className="min-h-screen bg-[#07111f] text-white flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl">
          <div className="flex items-center gap-3 mb-6">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/10">
              <ShieldCheck className="h-6 w-6" />
            </div>

            <div>
              <h1 className="text-xl font-bold">FPL Signal Admin</h1>
              <p className="text-sm text-white/50">Admin access</p>
            </div>
          </div>

          <label className="mb-2 block text-sm text-white/70">
            Admin Token
          </label>

          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                login();
              }
            }}
            placeholder="Enter admin token"
            className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none focus:border-white/30"
          />

          {error && (
            <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}

          <button
            onClick={login}
            className="mt-5 w-full rounded-xl bg-white px-4 py-3 font-semibold text-black transition hover:bg-white/90"
          >
            Login
          </button>
        </div>
      </main>
    );
  }

  const pendingDeposits = deposits.filter(
    (deposit) => deposit.status === "pending"
  ).length;

  const approvedDeposits = deposits.filter(
    (deposit) => deposit.status === "approved"
  ).length;

  const rejectedDeposits = deposits.filter(
    (deposit) => deposit.status === "rejected"
  ).length;

  const pendingWithdrawals = withdrawals.filter(
    (withdrawal) => withdrawal.status === "pending"
  ).length;

  const approvedWithdrawals = withdrawals.filter(
    (withdrawal) => withdrawal.status === "approved"
  ).length;

  const paidWithdrawals = withdrawals.filter(
    (withdrawal) => withdrawal.status === "paid"
  ).length;

  const rejectedWithdrawals = withdrawals.filter(
    (withdrawal) => withdrawal.status === "rejected"
  ).length;

  return (
    <main className="min-h-screen bg-[#07111f] text-white">
      <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/10">
                <ShieldCheck className="h-6 w-6" />
              </div>

              <div>
                <h1 className="text-2xl font-bold">FPL Signal Admin</h1>
                <p className="text-sm text-white/50">
                  Wallet & Competition Administration
                </p>
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={refreshAll}
              disabled={loadingDeposits || loadingWithdrawals}
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium hover:bg-white/[0.08] disabled:opacity-50"
            >
              <RefreshCw
                className={`h-4 w-4 ${
                  loadingDeposits || loadingWithdrawals
                    ? "animate-spin"
                    : ""
                }`}
              />
              Refresh
            </button>

            <button
              onClick={logout}
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium hover:bg-white/[0.08]"
            >
              <LogOut className="h-4 w-4" />
              ውጣ
            </button>
          </div>
        </header>

        {error && (
          <div className="mb-5 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {success && (
          <div className="mb-5 rounded-xl border border-green-500/20 bg-green-500/10 px-4 py-3 text-sm text-green-300">
            {success}
          </div>
        )}

        {/* WALLET DEPOSITS */}
        <section className="mb-8">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-xl font-bold">Wallet Deposits</h2>
              <p className="text-sm text-white/50">
                Manual Telebirr deposits — Approve or Reject
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-3 py-2 text-center">
                <div className="text-xs text-yellow-300/70">Pending</div>
                <div className="text-lg font-bold text-yellow-300">
                  {pendingDeposits}
                </div>
              </div>

              <div className="rounded-xl border border-green-500/20 bg-green-500/10 px-3 py-2 text-center">
                <div className="text-xs text-green-300/70">Approved</div>
                <div className="text-lg font-bold text-green-300">
                  {approvedDeposits}
                </div>
              </div>

              <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-center">
                <div className="text-xs text-red-300/70">Rejected</div>
                <div className="text-lg font-bold text-red-300">
                  {rejectedDeposits}
                </div>
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
            {loadingDeposits ? (
              <div className="flex items-center justify-center gap-2 p-10 text-white/50">
                <RefreshCw className="h-5 w-5 animate-spin" />
                Deposits በመጫን ላይ...
              </div>
            ) : deposits.length === 0 ? (
              <div className="p-10 text-center text-white/40">
                Wallet Deposits የሉም።
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[950px] text-sm">
                  <thead className="border-b border-white/10 bg-white/[0.03]">
                    <tr className="text-left text-white/50">
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Telegram User</th>
                      <th className="px-4 py-3">Method</th>
                      <th className="px-4 py-3">Amount</th>
                      <th className="px-4 py-3">Transaction Ref</th>
                      <th className="px-4 py-3">Created</th>
                      <th className="px-4 py-3">Action</th>
                    </tr>
                  </thead>

                  <tbody>
                    {deposits.map((deposit) => (
                      <tr
                        key={deposit.id}
                        className="border-b border-white/5 last:border-0"
                      >
                        <td className="px-4 py-4">
                          <span
                            className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusClass(
                              deposit.status
                            )}`}
                          >
                            {deposit.status ?? "-"}
                          </span>
                        </td>

                        <td className="px-4 py-4">
                          <div className="font-medium">
                            {deposit.telegramUserId ?? "-"}
                          </div>
                        </td>

                        <td className="px-4 py-4">
                          {methodLabel(deposit.method)}
                        </td>

                        <td className="px-4 py-4 font-bold">
                          {formatAmount(deposit.amountEtb)}
                        </td>

                        <td className="px-4 py-4">
                          <span className="break-all text-white/70">
                            {deposit.transactionReference ?? "-"}
                          </span>
                        </td>

                        <td className="px-4 py-4 whitespace-nowrap text-white/60">
                          {formatDate(deposit.createdAt)}
                        </td>

                        <td className="px-4 py-4">
                          {deposit.status === "pending" ? (
                            <div className="flex flex-wrap gap-2">
                              <button
                                onClick={() => approveDeposit(deposit)}
                                disabled={actionId !== null}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-green-500/15 px-3 py-2 text-xs font-semibold text-green-300 hover:bg-green-500/25 disabled:opacity-50"
                              >
                                <CheckCircle2 className="h-4 w-4" />
                                Approve
                              </button>

                              <button
                                onClick={() => rejectDeposit(deposit)}
                                disabled={actionId !== null}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/15 px-3 py-2 text-xs font-semibold text-red-300 hover:bg-red-500/25 disabled:opacity-50"
                              >
                                <XCircle className="h-4 w-4" />
                                Reject
                              </button>
                            </div>
                          ) : (
                            <span className="text-xs text-white/30">
                              No action
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* WALLET WITHDRAWALS */}
        <section>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-xl font-bold">
                Wallet Withdrawal Management
              </h2>
              <p className="text-sm text-white/50">
                Review, approve, reject and mark withdrawals as paid.
              </p>
            </div>

            <div className="grid grid-cols-4 gap-2">
              <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-3 py-2 text-center">
                <div className="text-xs text-yellow-300/70">Pending</div>
                <div className="text-lg font-bold text-yellow-300">
                  {pendingWithdrawals}
                </div>
              </div>

              <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-center">
                <div className="text-xs text-blue-300/70">Approved</div>
                <div className="text-lg font-bold text-blue-300">
                  {approvedWithdrawals}
                </div>
              </div>

              <div className="rounded-xl border border-green-500/20 bg-green-500/10 px-3 py-2 text-center">
                <div className="text-xs text-green-300/70">Paid</div>
                <div className="text-lg font-bold text-green-300">
                  {paidWithdrawals}
                </div>
              </div>

              <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-center">
                <div className="text-xs text-red-300/70">Rejected</div>
                <div className="text-lg font-bold text-red-300">
                  {rejectedWithdrawals}
                </div>
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
            {loadingWithdrawals ? (
              <div className="flex items-center justify-center gap-2 p-10 text-white/50">
                <RefreshCw className="h-5 w-5 animate-spin" />
                Withdrawals በመጫን ላይ...
              </div>
            ) : withdrawals.length === 0 ? (
              <div className="p-10 text-center text-white/40">
                Withdrawals የሉም።
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[950px] text-sm">
                  <thead className="border-b border-white/10 bg-white/[0.03]">
                    <tr className="text-left text-white/50">
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Telegram User</th>
                      <th className="px-4 py-3">Method</th>
                      <th className="px-4 py-3">Amount</th>
                      <th className="px-4 py-3">Payout Ref</th>
                      <th className="px-4 py-3">Created</th>
                      <th className="px-4 py-3">Action</th>
                    </tr>
                  </thead>

                  <tbody>
                    {withdrawals.map((withdrawal) => (
                      <tr
                        key={withdrawal.id}
                        className="border-b border-white/5 last:border-0"
                      >
                        <td className="px-4 py-4">
                          <span
                            className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusClass(
                              withdrawal.status
                            )}`}
                          >
                            {withdrawal.status ?? "-"}
                          </span>
                        </td>

                        <td className="px-4 py-4">
                          {withdrawal.telegramUserId ?? "-"}
                        </td>

                        <td className="px-4 py-4">
                          {methodLabel(withdrawal.method)}
                        </td>

                        <td className="px-4 py-4 font-bold">
                          {formatAmount(withdrawal.amountEtb)}
                        </td>

                        <td className="px-4 py-4 text-white/60">
                          {withdrawal.payoutReference ?? "-"}
                        </td>

                        <td className="px-4 py-4 whitespace-nowrap text-white/60">
                          {formatDate(withdrawal.createdAt)}
                        </td>

                        <td className="px-4 py-4">
                          <div className="flex flex-wrap gap-2">
                            {withdrawal.status === "pending" && (
                              <>
                                <button
                                  onClick={() =>
                                    approveWithdrawal(withdrawal)
                                  }
                                  disabled={actionId !== null}
                                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500/15 px-3 py-2 text-xs font-semibold text-blue-300 hover:bg-blue-500/25 disabled:opacity-50"
                                >
                                  <CheckCircle2 className="h-4 w-4" />
                                  Approve
                                </button>

                                <button
                                  onClick={() =>
                                    rejectWithdrawal(withdrawal)
                                  }
                                  disabled={actionId !== null}
                                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/15 px-3 py-2 text-xs font-semibold text-red-300 hover:bg-red-500/25 disabled:opacity-50"
                                >
                                  <XCircle className="h-4 w-4" />
                                  Reject
                                </button>
                              </>
                            )}

                            {withdrawal.status === "approved" && (
                              <button
                                onClick={() =>
                                  markWithdrawalPaid(withdrawal)
                                }
                                disabled={actionId !== null}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-green-500/15 px-3 py-2 text-xs font-semibold text-green-300 hover:bg-green-500/25 disabled:opacity-50"
                              >
                                <CheckCircle2 className="h-4 w-4" />
                                Mark Paid
                              </button>
                            )}

                            {withdrawal.status === "paid" && (
                              <span className="inline-flex items-center gap-1.5 text-xs text-green-300">
                                <CheckCircle2 className="h-4 w-4" />
                                Paid
                              </span>
                            )}

                            {withdrawal.status === "rejected" && (
                              <span className="inline-flex items-center gap-1.5 text-xs text-red-300">
                                <XCircle className="h-4 w-4" />
                                Rejected
                              </span>
                            )}

                            {!withdrawal.status && (
                              <span className="inline-flex items-center gap-1.5 text-xs text-white/40">
                                <Clock3 className="h-4 w-4" />
                                Unknown
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
