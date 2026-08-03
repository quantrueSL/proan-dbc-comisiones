"use client";

import { FormEvent, useState } from "react";
import { getDefaultAuthenticatedRoute } from "../../client.config";

export function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ username, password })
      });

      const payload = (await response.json()) as {
        detail?: string;
        redirectTo?: string;
      };

      if (!response.ok) {
        setError(payload.detail ?? "No se pudo iniciar sesion.");
        return;
      }

      window.location.assign(payload.redirectTo ?? getDefaultAuthenticatedRoute());
    } catch {
      setError("Error de red al llamar al proxy de login.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="stack login-form" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="username">Usuario</label>
        <input
          autoComplete="username"
          id="username"
          name="username"
          onChange={(event) => setUsername(event.target.value)}
          required
          value={username}
        />
      </div>

      <div className="field">
        <label htmlFor="password">Contraseña</label>
        <input
          autoComplete="current-password"
          id="password"
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
      </div>

      {error ? <div className="banner banner-error">{error}</div> : null}

      <button className="btn btn-primary" disabled={pending} type="submit">
        {pending ? "Iniciando..." : "Entrar"}
      </button>
    </form>
  );
}
