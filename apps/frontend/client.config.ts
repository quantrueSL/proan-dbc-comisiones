// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

export interface ClientBranding {
  productName: string;
  metadataTitle: string;
  metadataDescription: string;
  loginTitle: string;
}

// ---------------------------------------------------------------------------
// Top-level client config
// ---------------------------------------------------------------------------

export interface ClientConfig {
  defaultAuthenticatedRoute: string;
  branding: ClientBranding;
  features: {
    flujoProducto: { enabled: boolean };
    comisiones: { enabled: boolean };
    conciliacion: { enabled: boolean };
  };
}

// ---------------------------------------------------------------------------
// Client config — Proan / DBC (único cliente, sin diferenciación)
// ---------------------------------------------------------------------------

export const clientConfig: ClientConfig = {
  defaultAuthenticatedRoute: "/flujo-producto",
  branding: {
    productName: "Comisiones DBC",
    metadataTitle: "Comisiones DBC",
    metadataDescription: "Plataforma de comisiones y conciliación documental de DBC (Proan).",
    loginTitle: "Comisiones DBC",
  },
  features: {
    flujoProducto: { enabled: true },
    comisiones: { enabled: true },
    conciliacion: { enabled: true },
  },
};

export function getDefaultAuthenticatedRoute(config: ClientConfig = clientConfig): string {
  return config.defaultAuthenticatedRoute;
}
