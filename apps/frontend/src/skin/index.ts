import dynamic from "next/dynamic";
import { ProanLoginPanel } from "@/skin/proan/components/proan-login-panel";
import { ProanAuthenticatedShell } from "@/skin/proan/components/proan-authenticated-shell";
import { proanBranding } from "@/skin/proan/branding";
import proanIconImg from "@/skin/proan/assets/logos/iconoproan.png";

const ProanStyles = dynamic(() =>
  import("@/skin/proan/components/proan-styles").then((m) => m.ProanStyles)
);

export const SkinLoginPanel = ProanLoginPanel;
export const SkinAuthenticatedShell = ProanAuthenticatedShell;
export const SkinStyles = ProanStyles;
export const skinBranding = proanBranding;
export const skinIcon = proanIconImg;
