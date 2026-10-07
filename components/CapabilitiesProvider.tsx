"use client";

import { createContext, useContext } from "react";
import type { AppCapabilities } from "@/lib/capabilities";

const CLOSED_CAPABILITIES: AppCapabilities = {
  coach: false,
  scan: false,
  captureMethods: [],
};

const CapabilitiesContext = createContext<AppCapabilities>(CLOSED_CAPABILITIES);

export function CapabilitiesProvider({
  value,
  children,
}: {
  value: AppCapabilities;
  children: React.ReactNode;
}) {
  return <CapabilitiesContext value={value}>{children}</CapabilitiesContext>;
}

export function useCapabilities(): AppCapabilities {
  return useContext(CapabilitiesContext);
}
