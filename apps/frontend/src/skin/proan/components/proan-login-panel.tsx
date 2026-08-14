import Image from "next/image";
import { GoogleLoginButton } from "@/components/google-login-button";
import { LoginForm } from "@/components/login-form";
import { getFirebaseWebConfig } from "@/lib/env";
import { proanBranding } from "@/skin/proan/branding";
import { ProanLoginBackdrop } from "@/skin/proan/components/proan-login-backdrop";
import proanLogo from "@/skin/proan/assets/logos/logoproan.png";

export function ProanLoginPanel() {
  // Se lee en el servidor y se pasa como props: si Firebase no está configurado,
  // la pantalla sigue funcionando solo con usuario y contraseña.
  const firebaseConfig = getFirebaseWebConfig();

  return (
    <main className="login-page">
      <ProanLoginBackdrop />
      <section className="login-shell">
        <div className="login-brand-mark">
          <Image
            alt={proanBranding.productName}
            className="login-brand-mark-image"
            priority
            src={proanLogo}
          />
        </div>
        <h1>{proanBranding.loginTitle}</h1>

        {/* Google primero y solo: es la vía de los usuarios de Proan. El
            usuario/contraseña es acceso técnico (Quantrue y emergencias), así que
            se repliega detrás de un desplegable para no ofrecer dos puertas
            aparentemente equivalentes.

            Se usa <details> en vez de estado de React: no hace falta JavaScript,
            el navegador ya aporta el rol de botón y el aria-expanded, y este panel
            sigue siendo un componente de servidor.

            `open` cuando no hay Firebase configurado: si no, la pantalla se
            quedaría sin ninguna acción visible. */}
        {firebaseConfig ? <GoogleLoginButton config={firebaseConfig} /> : null}

        <details className="login-dev-access" open={!firebaseConfig}>
          <summary>Acceso para desarrolladores</summary>
          <LoginForm />
        </details>
      </section>
    </main>
  );
}
