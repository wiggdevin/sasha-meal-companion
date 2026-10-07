"use client";

import type { CSSProperties, ReactNode } from "react";
import WaterDial from "@/components/WaterDial";
import { WaterSteps } from "@/components/MacroRingsControls";
import OrbitMark, { MARK_COLOR } from "@/components/HealthOrbitMarks";
import { lastSeen } from "@/components/BodyDashboard";
import KcalText from "@/components/ui/KcalText";
import {
  bodyState, fmt, NUTRIENTS, nutrientBalance, sleepAmount,
  type NutrientKey, type OrbitBody, type OrbitNode, type OrbitWater,
} from "@/lib/today/health-orbit";
import { formatWater, formatWaterOf, stepPhrase } from "@/lib/water-units";
import { balanceBound, boundLabel, eatenBound, withBound } from "@/lib/nutrition-display";
import type { Macros } from "@/lib/types";
import styles from "@/components/HealthOrbit.module.css";

/* The glass detail that fills the fixed area under a chosen entity. Every figure is the same one
   the node shows; nothing here invents a value for data that is missing or unread. */

type Props = {
  node: OrbitNode;
  targets: Macros;
  consumed: Macros;
  water?: OrbitWater;
  onAddCup?: () => void;
  onSetCups?: (cups: number) => void;
  body?: OrbitBody;
  /** The day holds a partly measured recipe serving (#21): eaten is "at least", left "at most". */
  partial?: boolean;
};

function Stat({ label, value, meta }: { label: string; value: string; meta?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-tiny text-muted">{label}</dt>
      <dd className="m-0 text-body-sm font-medium tabular-nums text-charcoal"><KcalText text={value} /></dd>
      {meta && <dd className="m-0 text-tiny text-muted">{meta}</dd>}
    </div>
  );
}

function Line({ children, tone }: { children: ReactNode; tone?: "alert" }) {
  return <p className={`m-0 text-caption ${tone === "alert" ? "text-[var(--color-alert)]" : "text-graphite"}`}>{children}</p>;
}

function RouteLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} className={`tap ${styles.route}`}>{children}</a>;
}

function Nutrient({ node, targets, consumed, partial = false }: Props) {
  const spec = NUTRIENTS[node.key as NutrientKey];
  const value = consumed[spec.macro];
  const target = targets[spec.macro];
  const { remaining, over } = nutrientBalance(value, target);
  const left = withBound(`${fmt(remaining)} ${spec.unit} left`, balanceBound(partial, false));
  const past = withBound(`${fmt(over)} ${spec.unit} over target`, balanceBound(partial, true));
  const sentence = (text: string) => text[0].toUpperCase() + text.slice(1);
  return <>
    <dl className="m-0 grid grid-cols-2 gap-3">
      <Stat label={partial ? `${boundLabel(eatenBound(true))} eaten` : "Eaten"} value={`${fmt(value)} ${spec.unit}`} />
      <Stat label="Target" value={`${fmt(target)} ${spec.unit}`} />
    </dl>
    <div className={styles.meter} aria-hidden="true">
      <span style={{ width: `${Math.round((node.progress ?? 0) * 100)}%` }} data-over={over > 0 || undefined} />
    </div>
    {over > 0
      ? <Line tone="alert">{sentence(past)}</Line>
      : <Line>{remaining === 0 ? "Target reached" : sentence(left)}</Line>}
    {node.key === "calories" && <Line>Food logged for this day. Active burn is tracked on its own.</Line>}
  </>;
}

function Water({ water, onAddCup, onSetCups }: Props) {
  if (!water) return <Line>Loading…</Line>;
  const unit = water.unit ?? "cups";
  const summary = water.goal > 0 ? formatWaterOf(water.cups, water.goal, unit) : formatWater(water.cups, unit);
  if (!onAddCup || !onSetCups) return <Line>{summary}</Line>;
  return <>
    <div className="flex items-center justify-between gap-3">
      <WaterDial cups={water.cups} goal={water.goal} unit={unit} onAddCup={onAddCup} onSetCups={onSetCups}>
        <span className={styles.vessel}>
          <OrbitMark kind="water" level={water.goal > 0 ? water.cups / water.goal : 0} size={56} />
        </span>
      </WaterDial>
      <WaterSteps cups={water.cups} unit={unit} onSetCups={onSetCups} label={summary} />
    </div>
    <Line>Tap the glass to add {stepPhrase(unit)}. Hold it and drag to adjust.</Line>
  </>;
}

function BodyStatus({ body, children, empty }: { body?: OrbitBody; children: ReactNode; empty: boolean }) {
  const state = bodyState(body);
  if (state === "loading") return <Line>Loading…</Line>;
  if (state === "off") {
    return <>
      <Line>Body data is off. Connect a source to see it here.</Line>
      <RouteLink href="/settings">Connect in Settings</RouteLink>
    </>;
  }
  return <>
    {body?.offline && <Line>{body.fetchedAt ? `Offline — last synced ${lastSeen(body.fetchedAt)}.`
      : "Offline — showing your last saved data."}</Line>}
    {children}
    {empty && <Line>Nothing recorded for this day yet.</Line>}
    <RouteLink href="/body">Open Body</RouteLink>
  </>;
}

function Activity({ body }: Props) {
  const row = body?.row ?? null;
  const kcal = row?.active_kcal ?? null;
  const steps = row?.steps ?? null;
  const empty = kcal === null && steps === null;
  return <BodyStatus body={body} empty={false}>
    {empty ? <Line>No activity recorded for this day yet.</Line> : <dl className="m-0 grid grid-cols-2 gap-3">
      {kcal !== null && <Stat label="Active energy" value={`${fmt(kcal)} kcal`}
        meta="Device estimate · not added to your food target" />}
      {steps !== null && <Stat label="Steps" value={fmt(steps)} />}
    </dl>}
  </BodyStatus>;
}

function Recovery({ body }: Props) {
  const row = body?.row ?? null;
  const sleep = row?.sleep_minutes ?? null;
  const readiness = row?.readiness_score ?? null;
  return <BodyStatus body={body} empty={sleep === null && readiness === null}>
    {(sleep !== null || readiness !== null) && <dl className="m-0 grid grid-cols-2 gap-3">
      {sleep !== null && <Stat label="Sleep" value={sleepAmount(sleep)} />}
      {readiness !== null && <Stat label="Readiness" value={fmt(readiness)} />}
    </dl>}
  </BodyStatus>;
}

export default function HealthOrbitDetail(props: Props & { id: string }) {
  const { node, id } = props;
  const body = node.key === "water" ? <Water {...props} />
    : node.key === "activity" ? <Activity {...props} />
      : node.key === "recovery" ? <Recovery {...props} />
        : <Nutrient {...props} />;
  return (
    <div id={id} role="region" aria-label={`${node.name} detail`} className={styles.detail}
      style={{ "--mark": MARK_COLOR[node.key] } as CSSProperties}>
      <h3 className="m-0 text-center text-heading-sm font-semibold text-charcoal">{node.name}</h3>
      {body}
    </div>
  );
}
