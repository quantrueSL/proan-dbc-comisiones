"use client";

import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { LogoutButton } from "@/components/logout-button";
import { ProfilePanel } from "@/components/profile-panel";
import type { FrontendSession } from "@/types/auth";
import { proanBranding } from "@/skin/proan/branding";
import proanIcon from "@/skin/proan/assets/logos/iconoproan.png";

type ShellFeatures = {
  flujoProducto: { enabled: boolean };
  comisiones: { enabled: boolean };
  conciliacion: { enabled: boolean };
};

type ProanAuthenticatedShellProps = {
  children: ReactNode;
  features: ShellFeatures;
  session: FrontendSession;
};

// Los 3 módulos del objetivo detallado (ver Comisiones_DBC_Borrador_Tecnico.md):
// flujo de producto (catálogo división/CEDIS, hoy con datos reales), comisiones
// y conciliación documental (estas dos con el motor todavía bloqueado — ver
// comisiones_engine.py / conciliacion_engine.py — así que la pantalla muestra
// una vista previa de ejemplo mientras tanto).
type NavKey = "flujoProducto" | "comisiones" | "conciliacion";
type NavItem = {
  href: string;
  key: NavKey;
  label: string;
};

const NAV_ITEMS: Record<NavKey, NavItem> = {
  flujoProducto: { href: "/flujo-producto", key: "flujoProducto", label: "Flujo de producto" },
  comisiones: { href: "/comisiones", key: "comisiones", label: "Comisiones" },
  conciliacion: { href: "/conciliacion", key: "conciliacion", label: "Conciliación" }
};

function UserIcon() {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 19a7 7 0 0 1 14 0" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path d="M10 4H5v16h5" />
      <path d="M13 8l5 4-5 4" />
      <path d="M8 12h10" />
    </svg>
  );
}

function getHomeHref(features: ShellFeatures): string {
  if (features.flujoProducto.enabled) return "/flujo-producto";
  if (features.comisiones.enabled) return "/comisiones";
  if (features.conciliacion.enabled) return "/conciliacion";
  return "/";
}

export function ProanAuthenticatedShell({
  children,
  features,
  session
}: ProanAuthenticatedShellProps) {
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isNavOpen, setIsNavOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setIsNavOpen(false);
  }, [pathname]);

  const homeHref = getHomeHref(features);
  const navItems: NavItem[] = (Object.keys(NAV_ITEMS) as NavKey[])
    .filter((key) => features[key].enabled)
    .map((key) => NAV_ITEMS[key]);

  function isActive(item: NavItem) {
    return pathname === item.href || pathname?.startsWith(`${item.href}/`);
  }

  return (
    <>
      <div className="proan-shell">
        <header className="app-topbar proan-topbar">
          <button
            aria-expanded={isNavOpen}
            aria-label={isNavOpen ? "Cerrar navegación" : "Abrir navegación"}
            className={`topbar-menu-toggle${isNavOpen ? " is-open" : ""}`}
            onClick={() => setIsNavOpen((current) => !current)}
            type="button"
          >
            <span />
            <span />
            <span />
          </button>

          <Link aria-label={proanBranding.productName} className="topbar-brand" href={homeHref}>
            <Image
              alt={proanBranding.productName}
              className="topbar-brand-icon"
              priority
              src={proanIcon}
            />
            <span className="proan-topbar-brand-copy">
              <span className="topbar-brand-name">{proanBranding.productName}</span>
            </span>
          </Link>

          <nav className={`topbar-nav proan-topbar-actions${isNavOpen ? " is-open" : ""}`}>
            {navItems.map((item) => (
              <Link
                aria-current={isActive(item) ? "page" : undefined}
                className={`topbar-nav-action topbar-nav-link${isActive(item) ? " is-active" : ""}`}
                href={item.href}
                key={item.key}
                onClick={() => setIsNavOpen(false)}
                prefetch={false}
              >
                {item.label}
              </Link>
            ))}

            <button
              aria-label="Mi perfil"
              className="topbar-nav-action topbar-nav-action-icon"
              onClick={() => {
                setIsProfileOpen(true);
              }}
              type="button"
            >
              <span aria-hidden="true" className="topbar-nav-icon">
                <UserIcon />
              </span>
            </button>

            <LogoutButton className="topbar-nav-action topbar-nav-action-icon">
              <span aria-hidden="true" className="topbar-nav-icon">
                <LogoutIcon />
              </span>
            </LogoutButton>
          </nav>
        </header>

        <div className="proan-shell-content">
          <div className="proan-content-scroll">
            <div className="main-panel proan-main-panel">{children}</div>
          </div>
        </div>
      </div>

      <ProfilePanel
        email={session.email}
        isOpen={isProfileOpen}
        onClose={() => setIsProfileOpen(false)}
        role={session.role}
      />
    </>
  );
}
