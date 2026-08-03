"use client";

import { useState } from "react";
import type { FirebaseWebConfig } from "@/types/auth";
import { getDefaultAuthenticatedRoute } from "../../client.config";

// ─────────────────────────────────────────────────────────────────────────
// Botón "Entrar con Google" (LOGIN.md Capa 2).
//
// El SDK de Firebase se carga con import dinámico DENTRO del handler: así no
// pesa en la carga de la pantalla de login, y quien entre por usuario y
// contraseña no lo descarga nunca.
//
// Tras obtener el token se cierra la sesión de Firebase en el navegador: la
// sesión de la aplicación es nuestra cookie firmada, y dejar dos sesiones vivas
// solo crea estados que no se pueden razonar.
// ─────────────────────────────────────────────────────────────────────────

type Props = {
  config: FirebaseWebConfig;
};

/** Códigos de Firebase que significan "el usuario se ha echado atrás". */
const CANCELACIONES = new Set([
  "auth/popup-closed-by-user",
  "auth/cancelled-popup-request",
  "auth/user-cancelled"
]);

const MENSAJE_POR_CODIGO: Record<string, string> = {
  "auth/popup-blocked": "El navegador ha bloqueado la ventana de Google. Permite las ventanas emergentes e inténtalo otra vez.",
  "auth/unauthorized-domain": "Este dominio no está autorizado en Firebase Authentication.",
  "auth/network-request-failed": "No se pudo contactar con Google. Comprueba tu conexión."
};

function readErrorCode(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : "";
  }
  return "";
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18">
      <path
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.61z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18z"
        fill="#34A853"
      />
      <path
        d="M3.97 10.71A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.17.29-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l3.01-2.33z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.17 6.66 3.58 9 3.58z"
        fill="#EA4335"
      />
    </svg>
  );
}

export function GoogleLoginButton({ config }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    setError(null);

    try {
      const [{ getApp, getApps, initializeApp }, { getAuth, GoogleAuthProvider, signInWithPopup, signOut }] =
        await Promise.all([import("firebase/app"), import("firebase/auth")]);

      const app = getApps().length > 0 ? getApp() : initializeApp(config);
      const auth = getAuth(app);

      const provider = new GoogleAuthProvider();
      // Siempre el selector de cuenta: sin esto Google reutiliza la última sesión
      // y no hay forma cómoda de cambiar de cuenta.
      provider.setCustomParameters({ prompt: "select_account" });

      const credential = await signInWithPopup(auth, provider);
      const idToken = await credential.user.getIdToken();
      await signOut(auth).catch(() => undefined);

      const response = await fetch("/api/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken })
      });

      const payload = (await response.json()) as { detail?: string; redirectTo?: string };

      if (!response.ok) {
        setError(payload.detail ?? "No se pudo iniciar sesión con Google.");
        setPending(false);
        return;
      }

      window.location.assign(payload.redirectTo ?? getDefaultAuthenticatedRoute());
    } catch (cause) {
      const code = readErrorCode(cause);

      // Cerrar la ventana de Google no es un error que merezca un aviso rojo.
      if (CANCELACIONES.has(code)) {
        setPending(false);
        return;
      }

      console.error("Fallo en el login con Google", cause);
      setError(MENSAJE_POR_CODIGO[code] ?? "No se pudo iniciar sesión con Google.");
      setPending(false);
    }
  }

  return (
    <div className="login-primary">
      {error ? <div className="banner banner-error">{error}</div> : null}

      <button className="btn btn-google" disabled={pending} onClick={onClick} type="button">
        <GoogleMark />
        {pending ? "Conectando con Google…" : "Entrar con Google"}
      </button>

      {/* El acceso está restringido a la organización proan.com: decirlo aquí
          evita que alguien lo intente con una cuenta personal y se coma el error
          de Google, que no explica nada. */}
      <p className="login-primary-hint">Usa tu cuenta de correo de Proan.</p>
    </div>
  );
}
