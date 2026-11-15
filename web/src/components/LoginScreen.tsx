import { t, useI18n } from "../lib/i18n";
import { type FormEvent, lazy, Suspense, useState } from "react";
import { ArrowRight, Download } from "lucide-react";
import { api } from "../lib/api";
import type { User } from "../lib/types";
const ClientDownloads = lazy(() => import("./ClientDownloads").then((module) => ({ default: module.ClientDownloads })));

export function LoginScreen({ onLogin }: { onLogin: (user: User) => void }) {
  useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [downloads, setDownloads] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      onLogin(await api.login(username.trim(), password));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("error.login"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-screen">
      <form className="login-form" onSubmit={submit}>
        <h1>Ochi</h1>
        <label htmlFor="username" className="form-field">
          <span>{t("login.username")}</span>
          <input
            id="username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoFocus
          />
        </label>
        <label htmlFor="password" className="form-field">
          <span>{t("login.password")}</span>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <button
          className={`primary-button login-submit${busy ? " btn-progress" : ""}`}
          type="submit"
          disabled={busy || !username.trim() || !password}
        >
          <span>{busy ? t("login.signingIn") : t("login.signIn")}</span>
          <ArrowRight size={18} />
        </button>
        <button type="button" className="btn ghost login-downloads" onClick={() => setDownloads(true)}>
          <Download className="ic" />{t("clientDownloads.title")}
        </button>
      </form>
      {downloads ? <Suspense fallback={null}><ClientDownloads onClose={() => setDownloads(false)} /></Suspense> : null}
    </main>
  );
}
