import { useState } from "react";
import { Route, ArrowRight } from "lucide-react";
import { api, ApiError } from "./api";
import { Input } from "./ui";
import type { User } from "./types";

export function AuthScreen({ onLogin }: { onLogin: (user: User) => void }) {
  const [register, setRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  async function submit() {
    const errors: Record<string, string> = {};
    if (!/^[A-Za-z0-9_\u4e00-\u9fff]{3,40}$/.test(username))
      errors.username = "请输入 3～40 位中文、字母、数字或下划线";
    if (password.length < 10 || password.length > 128)
      errors.password = "密码长度应为 10～128 位";
    if (register && !name.trim()) errors.name = "请输入姓名或昵称";
    if (register && password !== repeat) errors.repeat = "两次输入的密码不一致";
    setFields(errors);
    setError("");
    if (Object.keys(errors).length) {
      document.getElementById(`auth-${Object.keys(errors)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    try {
      onLogin(
        await api<User>(register ? "/auth/register" : "/auth/login", "POST", {
          username,
          password,
          ...(register ? { display_name: name.trim() } : {}),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError)
        setFields(
          Object.fromEntries(e.fields.map((f) => [f.field, f.message])),
        );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <div className="auth-brand">
        <Route size={24} />
        <strong>路序</strong>
      </div>
      <section className="auth-card" aria-labelledby="auth-title">
        <span className="eyebrow">城市配送 · 智能调度</span>
        <h1 id="auth-title">{register ? "创建你的账号" : "欢迎回来"}</h1>
        <p>让每一程配送都有序可循。</p>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void submit();
          }}
        >
          {register && (
            <Input
              id="auth-name"
              label="姓名或昵称"
              autoComplete="nickname"
              value={name}
              onChange={(e) => setName(e.target.value)}
              error={fields.name}
            />
          )}
          <Input
            id="auth-username"
            label="用户名"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            error={fields.username}
          />
          <Input
            id="auth-password"
            label="密码"
            type="password"
            autoComplete={register ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={fields.password}
            hint={register ? "至少 10 位" : ""}
          />
          {register && (
            <Input
              id="auth-repeat"
              label="确认密码"
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              error={fields.repeat}
            />
          )}
          <div aria-live="polite">
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
          </div>
          <button
            className="button primary auth-submit"
            type="submit"
            disabled={busy}
          >
            {busy ? "请稍候…" : register ? "注册并进入" : "登录"}
            <ArrowRight size={16} />
          </button>
        </form>
        <div className="auth-switch">
          {register ? "已有账号？" : "还没有账号？"}
          <button
            onClick={() => {
              setRegister(!register);
              setError("");
              setFields({});
              setPassword("");
              setRepeat("");
            }}
          >
            {register ? "前往登录" : "创建账号"}
          </button>
        </div>
      </section>
      <footer>路序 · 城市配送调度工作台</footer>
    </main>
  );
}
