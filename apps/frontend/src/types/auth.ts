/**
 * Ver LOGIN.md §3. Roles provisionales — pendiente de definir con el cliente
 * los roles reales de Comisiones DBC (¿por CEDIS? ¿por rol comercial?).
 * `admin` puede todo; `viewer` es de solo consulta.
 */
export type SessionRole = "admin" | "viewer";

/**
 * Configuración del SDK web de Firebase. Son valores PÚBLICOS por diseño: viajan
 * en el JavaScript del navegador. Lo que nunca sale del servidor son las
 * credenciales de service account.
 */
export type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
};

export type FrontendSession = {
  token: string;
  email: string;
  username: string;
  displayName: string | null;
  gatewayUserId: string;
  apps: string[];
  subject?: string;
  role: SessionRole;
  expiresAt: number | null;
};
