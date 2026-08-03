"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type LogoutButtonProps = {
  ariaLabel?: string;
  children?: ReactNode;
  className?: string;
};

export function LogoutButton({
  ariaLabel = "Cerrar sesión",
  children = "Cerrar sesion",
  className
}: LogoutButtonProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleLogout() {
    setPending(true);

    try {
      await fetch("/api/auth/logout", {
        method: "POST"
      });
    } finally {
      router.replace("/login");
      router.refresh();
      setPending(false);
    }
  }

  return (
    <button
      aria-label={ariaLabel}
      className={className ?? "btn btn-secondary"}
      disabled={pending}
      onClick={handleLogout}
      type="button"
    >
      {pending ? "Saliendo..." : children}
    </button>
  );
}
