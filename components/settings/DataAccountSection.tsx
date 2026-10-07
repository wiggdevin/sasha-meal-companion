import SettingsSection from "./Section";

/**
 * Data & account as ONE card (U17, owner 2026-10-04: "curious if the data and account can all be
 * like one card"): its rows — export, sync, sign out — sit in one ivory card split by hairlines,
 * where they used to be three cards.
 */
export default function DataAccountSection({ children }: { children: React.ReactNode }) {
  return (
    <SettingsSection title="Data & account">
      <div className="shell">
        <div className="surface flex flex-col divide-y divide-hairline">{children}</div>
      </div>
    </SettingsSection>
  );
}
