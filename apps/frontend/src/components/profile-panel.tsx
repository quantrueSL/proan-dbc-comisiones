"use client";

import type { SessionRole } from "@/types/auth";

// Panel de perfil: quién eres y qué puedes hacer. Nada más.

type ProfilePanelProps = {
  email: string;
  role: SessionRole;
  isOpen: boolean;
  onClose: () => void;
};

// TODO: roles provisionales (admin/viewer) — ajustar textos cuando se definan
// con el cliente los roles reales de Comisiones DBC (ver LOGIN.md §3).
const ROLE_LABEL: Record<SessionRole, string> = {
  admin: "Administrador",
  viewer: "Consulta"
};

const ROLE_DESCRIPTION: Record<SessionRole, string> = {
  admin: "Acceso completo a la plataforma.",
  viewer: "Acceso de solo consulta."
};

export function ProfilePanel({ email, role, isOpen, onClose }: ProfilePanelProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <div
      aria-hidden={!isOpen}
      className="profile-modal-backdrop"
      onClick={onClose}
    >
      <div
        aria-labelledby="profile-panel-title"
        aria-modal="true"
        className="profile-modal profile-modal-minimal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="profile-modal-header">
          <div>
            <span className="eyebrow">Mi perfil</span>
            <h2 id="profile-panel-title">Perfil de usuario</h2>
          </div>

          <button
            aria-label="Cerrar Mi perfil"
            className="profile-modal-close"
            onClick={onClose}
            type="button"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <section className="profile-section profile-section-identity">
          <p className="muted">Usuario autenticado</p>
          <p className="profile-identity-email">{email}</p>
        </section>

        <section className="profile-section profile-section-identity">
          <p className="muted">Rol</p>
          <p className="profile-identity-role">{ROLE_LABEL[role]}</p>
          <p className="muted">{ROLE_DESCRIPTION[role]}</p>
        </section>
      </div>
    </div>
  );
}
