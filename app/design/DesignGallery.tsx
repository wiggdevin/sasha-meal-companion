"use client";

import { useRef, useState } from "react";
import { Button, Chip, EmptyState, Field, ListRow, SearchField, Segmented, Surface, Toast, useButtonStatus } from "@/components/ui";
import { PlusIcon } from "@/components/ui/icons";
import { renderBlock } from "@/components/coach/blocks";
import DateField from "@/components/ui/DateField";
import { localIsoToday } from "@/components/ui/DatePickerSheet";
import KcalText from "@/components/ui/KcalText";
import Thinking from "@/components/ui/Thinking";
import Sheet from "@/components/Sheet";
import MealCardActions from "@/components/MealCardActions";
import PlanComposer from "@/components/plan/PlanComposer";
import PhotoResult from "@/components/plan/PhotoResult";
import DocumentPlan from "@/components/plan/DocumentPlan";
import WaterLiquid from "@/components/today/WaterLiquid";
import TipTile from "@/components/today/TipTile";
import { GALLERY_DOCUMENT_PLAN, GALLERY_MENU_RESULT, GALLERY_PLATE_RESULT, GALLERY_TIPS } from "@/app/design/gallery-fixtures";

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h2 className="section-title m-0 px-1 text-heading-sm font-semibold leading-heading-sm tracking-heading-sm">{title}</h2>
      {children}
    </section>
  );
}

/** A static reveal of components/MealCardActions.tsx's swipe tray (docs/design/KIT.md §12). */
function SwipeDemo({ revealed, state }: { revealed: number; state: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="px-1 text-tiny text-muted">{state}</span>
      <MealCardActions label="Lunch" revealed={revealed} onClear={() => {}} onDelete={() => {}} onToggle={() => {}}>
        <div className="surface flex min-h-16 items-center px-4" style={{ transform: `translateX(-${revealed}px)` }}>
          <span className="text-body-md font-medium text-charcoal">Lunch · Chicken and rice</span>
        </div>
      </MealCardActions>
    </div>
  );
}

const SECTIONS = ["today", "body", "foods", "coach", "settings"] as const;

export default function DesignGallery() {
  const [unit, setUnit] = useState<"lb" | "kg">("lb");
  const [tab, setTab] = useState<"eats" | "avoids">("eats");
  const [scanDate, setScanDate] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const noTilt = useRef(0);
  const [query, setQuery] = useState("");
  const demoOk = useButtonStatus();
  const demoFail = useButtonStatus();
  const demoBlock = useButtonStatus();
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 pb-8">
      <h1 className="m-0 text-display font-light leading-none tracking-tight text-charcoal">Design</h1>
      <p className="m-0 text-caption text-muted">Every primitive in components/ui, on the real ground. Switch the section hue:</p>
      <div className="pill-in flex gap-1 p-1">
        {SECTIONS.map((s) => (
          <Chip key={s} selected={false} onClick={() => { document.documentElement.dataset.section = s; }}>{s}</Chip>
        ))}
      </div>

      <Block title="Surface">
        <Surface className="px-4 py-4"><p className="m-0 text-body-md text-charcoal">card — white, hairline, soft shadow</p></Surface>
        <Surface variant="panel" className="px-4 py-4"><p className="m-0 text-body-md">panel — a light wash of the section hue</p></Surface>
        <Surface variant="sheet" className="px-4 py-4"><p className="m-0 text-body-md text-charcoal">sheet — white over the scrim</p></Surface>
      </Block>

      <Block title="Button">
        <Surface className="flex flex-col gap-3 px-4 py-4">
          <p className="m-0 text-tiny text-muted">Variants: primary completes a flow; secondary is the card action; tertiary its quieter neighbour; ghost an inline word; danger destroys.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary">Save</Button>
            <Button variant="secondary">Plan</Button>
            <Button variant="tertiary">Cancel</Button>
            <Button variant="ghost">Undo</Button>
            <Button variant="danger">Delete</Button>
          </div>
          <p className="m-0 text-tiny text-muted">Sizes: sm 36 (44 to hit) · md 44 · lg 52 (sheet primaries only).</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm">Small</Button><Button>Medium</Button><Button size="lg" variant="primary">Large</Button>
            <Button shape="circle" variant="primary" aria-label="Send"><PlusIcon /></Button>
          </div>
          <p className="m-0 text-tiny text-muted">States, frozen: disabled, pending, success, error.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled>Disabled</Button>
            <Button status="pending">Saving</Button>
            <Button status="success" confirmLabel="Saved">Save</Button>
            <Button variant="primary" status="success" confirmLabel="Logged">Log lunch</Button>
            <Button status="error" errorLabel="Try again">Send</Button>
          </div>
          <p className="m-0 text-tiny text-muted">Live: press to run a 900 ms write that succeeds, or one that fails.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" status={demoOk.status} confirmLabel="Saved"
              onClick={() => { void demoOk.run(() => new Promise((done) => setTimeout(done, 900))); }}>Save changes</Button>
            <Button status={demoFail.status} errorLabel="Try again"
              onClick={() => { void demoFail.run(() => new Promise((_, fail) => setTimeout(() => fail(new Error("demo")), 900))); }}>Sync now</Button>
          </div>
          <Button variant="primary" size="lg" block status={demoBlock.status} confirmLabel="Logged"
            onClick={() => { void demoBlock.run(() => new Promise((done) => setTimeout(done, 900))); }}>Log this meal</Button>
        </Surface>
      </Block>

      <Block title="Search (input tier 1)">
        <Surface className="flex flex-col gap-3 px-4 py-4">
          <SearchField label="Search foods" value={query} onValueChange={setQuery} placeholder="e.g. chicken breast" />
          <SearchField label="Search conversations" size="lg" value={query} onValueChange={setQuery} />
        </Surface>
      </Block>

      <Block title="Elevation">
        <div className="flex flex-col gap-3">
          <Surface className="px-4 py-4">
            <p className="m-0 text-body-md text-charcoal">E1 — a card on the ground</p>
            <Surface nested className="mt-3 px-4 py-3"><p className="m-0 text-caption text-muted">E0 — a card inside a card: hairline, no drop</p></Surface>
          </Surface>
          <div className="sheet-surface px-4 py-4"><p className="m-0 text-body-md text-charcoal">E2 — floating: a pop-up, the chat overlay</p></div>
        </div>
      </Block>

      <Block title="Field">
        <Surface className="flex flex-col gap-3 px-4 py-4">
          <Field id="d-pounds" label="Pounds" inputMode="numeric" defaultValue="160" hint="Whole numbers" />
          <Field id="d-year" label="Birth year" inputMode="numeric" defaultValue="19" error="Four digits" />
        </Surface>
      </Block>

      <Block title="DateField">
        <Surface className="flex flex-col gap-3 px-4 py-4">
          <label className="flex flex-col gap-1 text-caption text-muted">Scan date
            <DateField label="Scan date" value={scanDate} onChange={setScanDate} allowClear
              max={localIsoToday()} className="min-h-11 w-full px-3 text-body" />
          </label>
        </Surface>
      </Block>

      <Block title="Chip and Segmented">
        <Surface className="flex flex-col gap-3 px-4 py-4">
          <div className="pill-in grid min-h-11 grid-cols-2 gap-1 p-1" aria-label="Weight unit">
            <Chip selected={unit === "lb"} onClick={() => setUnit("lb")}>lb</Chip>
            <Chip selected={unit === "kg"} onClick={() => setUnit("kg")}>kg</Chip>
          </div>
          <Segmented label="Foods" panel="d-panel" value={tab} onChange={setTab}
            options={[{ value: "eats", label: "Favorites" }, { value: "avoids", label: "Avoids" }]} />
        </Surface>
      </Block>

      <Block title="ListRow">
        <Surface className="flex flex-col px-1 py-1">
          <ListRow title="Chicken breast, grilled" meta="165 kcal · 31 g protein" trailing="120 g" onClick={() => {}} />
          <ListRow title="Greek yogurt, 2 %" meta="Chobani" trailing="150 g" onClick={() => {}} />
          <ListRow title="A plain row" meta="no onClick, no button" />
        </Surface>
      </Block>

      <Block title="EmptyState">
        <EmptyState title="No health data yet" body="Connect a source, or log a weight, and the last seven days appear here."
          action={<Button>Connect health sources</Button>} />
      </Block>

      <Block title="Generative UI (a coach `ui` block)">
        {renderBlock({
          kind: "ui", v: 1, id: "gallery",
          root: { type: "card", title: "Lunch adjustment", children: [
            { type: "text", variant: "body", text: "Swap the rice for quinoa and you land on target." },
            { type: "metric_row", items: [
              { label: "Calories", value: "450 kcal", delta: "-120" }, { label: "Protein", value: "42 g", delta: "+10" }] },
            { type: "food_item", name: "Grilled chicken salad", detail: "200 g breast, greens, 10 ml olive oil", grams: 320 },
            { type: "button_group", actions: [
              { id: "apply", label: "Update Meal 2", variant: "primary" }, { id: "keep", label: "Keep current", variant: "quiet" }] },
          ] },
        }, { isLatestAssistant: true, sendText: () => {}, logFood: () => {}, markEats: () => {},
          markAvoid: () => {}, commitLogDraft: () => {}, openFood: () => {} } as never)}
      </Block>

      <Block title="Toast">
        <div><Toast>Logged 1 egg, 50 g, at 09:00.</Toast></div>
      </Block>

      <Block title="Thinking (components/ui/Thinking.tsx)">
        <Surface className="flex flex-col gap-4 px-4 py-4">
          <Thinking label="Reading your photo…" />
          <div className="well inline-flex items-center gap-2 px-3 py-2">
            <Thinking label="Thinking" size="compact" />
          </div>
        </Surface>
      </Block>

      <Block title="KcalText — the shared .kcal colour">
        <Surface className="px-4 py-4">
          <p className="m-0 text-body-md text-charcoal"><KcalText text="537 kcal · 40P 52C 18F" /></p>
        </Surface>
      </Block>

      <Block title="Sheet — an anchored pop-up, not a bottom sheet">
        <Surface className="flex flex-col gap-3 px-4 py-4">
          <button type="button" onClick={() => setSheetOpen(true)}
            className="btn-ink tap min-h-11 self-start px-4 text-caption">
            Open a sheet
          </button>
          {sheetOpen && <Sheet title="Edit meal" subtitle="Lunch" onClose={() => setSheetOpen(false)}>
            <p className="m-0 text-body-md text-charcoal">
              A pop-up card, anchored beside the button that opened it. No bottom placement, no drag handle.
            </p>
          </Sheet>}
        </Surface>
      </Block>

      <Block title="PlanComposer — the gooey + tab">
        <Surface className="px-4 py-4">
          <PlanComposer draft={draft} onDraft={setDraft} onSubmit={() => {}} onPhoto={() => {}} busy={false} />
        </Surface>
      </Block>

      <Block title="Meal card swipe tray (MealCardActions)">
        <Surface className="flex flex-col gap-4 px-4 py-4">
          <SwipeDemo revealed={0} state="pending" />
          <SwipeDemo revealed={40} state="Clear peeking" />
          <SwipeDemo revealed={100} state="Clear caught, Delete showing" />
          <SwipeDemo revealed={200} state="Delete armed" />
        </Surface>
      </Block>

      <Block title="PhotoResult — a plate">
        <Surface className="px-4 py-4">
          <PhotoResult result={GALLERY_PLATE_RESULT} label="Lunch" targetKcal={520} busy={false} logging={null}
            onLogPlate={() => {}} onPick={() => {}} />
        </Surface>
      </Block>

      <Block title="PhotoResult — a menu">
        <Surface className="px-4 py-4">
          <PhotoResult result={GALLERY_MENU_RESULT} label="Dinner" targetKcal={650} busy={false} logging={null}
            onLogPlate={() => {}} onPick={() => {}} />
        </Surface>
      </Block>

      <Block title="DocumentPlan">
        <Surface className="px-4 py-4">
          <DocumentPlan result={GALLERY_DOCUMENT_PLAN} label="Breakfast" busy={false} placing={false} onUse={() => {}} />
        </Surface>
      </Block>

      <Block title="Water (WaterLiquid)">
        <Surface className="flex gap-3 px-4 py-4">
          {[0, 0.5, 0.9].map((level) => (
            <div key={level} className="relative h-28 w-20 overflow-hidden rounded-2xl border border-hairline bg-field">
              <WaterLiquid level={level} tilt={noTilt} animate={false} />
            </div>
          ))}
        </Surface>
      </Block>

      <Block title="Tip tile">
        <TipTile tips={GALLERY_TIPS} />
      </Block>

      <Block title="New colour tokens (orange-warm, sage, field)">
        <Surface className="flex flex-wrap gap-2 px-4 py-4">
          <span className="inline-flex items-center gap-2 rounded-full border border-orange-warm px-3 py-1 text-tiny text-charcoal">
            orange-warm rim
          </span>
          <span className="inline-flex items-center gap-2 rounded-full bg-sage-wash px-3 py-1 text-tiny text-sage-ink">
            sage-wash / sage-ink
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border border-hairline bg-field px-3 py-1 text-tiny text-charcoal">
            field
          </span>
        </Surface>
      </Block>
    </main>
  );
}
