export default function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h2 className="section-title m-0 px-1 text-heading-sm font-semibold leading-heading-sm tracking-heading-sm">
        {title}
      </h2>
      {children}
    </section>
  );
}
