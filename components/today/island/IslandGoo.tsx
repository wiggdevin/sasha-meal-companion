import styles from "@/components/today/island/Island.module.css";

/**
 * The island's goo filter (moved out of LiveWidget.tsx unchanged): the shapes merge like liquid, and
 * the merge shapes only the outline, so the necks are dark glass and the pieces stay sharp on top.
 */
export default function IslandGoo({ id }: { id: string }) {
  return <svg width="0" height="0" aria-hidden="true" className={styles.defs}>
    <filter id={id}>
      <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="blur" />
      <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9" result="goo" />
      <feFlood style={{ floodColor: "var(--color-charcoal-deep)" }} result="ink" />
      <feComposite in="ink" in2="goo" operator="in" result="neck" />
      <feMerge><feMergeNode in="neck" /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
  </svg>;
}
